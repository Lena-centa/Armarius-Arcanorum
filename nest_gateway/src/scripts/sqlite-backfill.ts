/**
 * SQLite 灰测轨道 — Mongo → SQLite 全量镜像 + 校验。
 *
 * 双端并行灰测的第一步:把生产 Mongo(只读)镜像到本地 SQLite,
 * 校验行数与抽样 byte-equal,供 sqlite-gray-compare.ts 双端对照。
 *
 * 用法:
 *   npx ts-node src/scripts/sqlite-backfill.ts [--sqlite PATH] [--uri URI] [--db NAME]
 *
 * 退出码:0 = 镜像完成且校验通过;1 = 校验失败或脚本错误。
 *
 * 数据流向:
 *   Mongo(images / stats_docs / recipe_groups / 小集合)
 *   → 归一化(normalizeDoc)→ 按表结构物化 → SQLite
 *   (batches + batch_images + batch_lora_names + fts_batches / ...),
 *   与 repo.ts 的写原语落库形态保持一致,确保 reader.ts 读路径
 *   与灰度对比脚本的对照前提成立。
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { MongoClient } from 'mongodb';
import { loadRepoEnv } from './env';
import { DB_FILENAME, resolveDataDir } from '../config/data-dir';
import { openSqlite, withTransaction } from '../sqlite/db';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

// 注入数据目录 .env(MONGODB_URI / SQLITE_DB_PATH 等)
loadRepoEnv();

// 参数优先级:--sqlite 参数 > 环境变量 > 数据目录默认主库
const args = process.argv.slice(2);
const sqlitePath =
  argValue(args, '--sqlite') ??
  process.env.SQLITE_DB_PATH ??
  join(resolveDataDir(), DB_FILENAME);
const mongoUri =
  argValue(args, '--uri') ??
  process.env.MONGODB_URI ??
  'mongodb://127.0.0.1:27017';
const dbName =
  argValue(args, '--db') ?? process.env.MONGODB_DB ?? 'comfy_workflow_archive';

// byte-equal 抽样的批次条数
const SAMPLE_SIZE = 20;

/**
 * 简易取值:--key value 形式参数,无则 undefined。
 * (与 gray-compare 共用同款实现,保持脚本一致性)
 */
function argValue(argv: string[], key: string): string | undefined {
  const i = argv.indexOf(key);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * 归一化 Mongo 文档:_id → hex 字符串(其余类型 JSON.stringify 原生可序列化)。
 *
 * 为什么必须转:_id 是 ObjectId,直接 JSON.stringify 会输出
 * {"$oid": "..."} 包裹形态,与 doc_json 中业务字段的平铺形态不一致,
 * 也会破坏抽样 byte-equal 对比;转成 hex 字符串后与
 * "Mongo 层注入 id"的历史行为保持一致。
 */
function normalizeDoc(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...doc };
  if (out._id && typeof out._id === 'object' && 'toHexString' in out._id) {
    out._id = (out._id as { toHexString(): string }).toHexString();
  }
  return out;
}

/** 值可能是 LinkValue(object)或基本类型:物化列统一转可比较的标量。 */
function scalar(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** 时间戳物化:Date → ISO 字符串;字符串/数字原样转字符串;其余 JSON 化。 */
function iso(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

/**
 * 字符串主键/标签的物化值:对象类型回退为 JSON 文本,避免 "[object Object]" 污染。
 *
 * 用于 stats_summaries.kind、labels.id 等字符串列——
 * Mongo 侧这些字段是纯字符串,防御性兜底对象值,防止脏数据写入 "undefined" 等。
 */
function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return JSON.stringify(v);
}

/**
 * prompts.positive 存在且非空(与 Mongo filter {$exists,$nin:[null,'',[]]} 等价)。
 * 返回 0/1 供 has_positive 物化列使用。
 */
function hasPositive(doc: Record<string, unknown>): number {
  const p = (doc.prompts as { positive?: unknown } | undefined)?.positive;
  return Array.isArray(p) && p.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 主流程:
 *   1. 打开/创建 SQLite(目录不存在则建),关闭同步提交加速批量写入
 *   2. 清空全部镜像表(可重复运行,全量重灌语义)
 *   3. 镜像 images(stats_docs/recipe_groups)三大集合:每 1000 条
 *      一个事务批量提交;物化列 + 子表 + FTS 与 repo.ts 形态一致
 *   4. 小集合(stats_summaries 等)逐条插入
 *   5. 校验:各表行数 vs Mongo count;batch_images 对比 images[] 元素总数;
 *      随机抽样 SAMPLE_SIZE 批做 doc_json byte-equal
 *   6. 失败 > 0 退出码 1
 */
async function main(): Promise<void> {
  console.log('SQLite gray backfill');
  console.log(`  mongo:  ${mongoUri}/${dbName}`);
  console.log(`  sqlite: ${sqlitePath}`);

  // 目标目录可能不存在(首次运行),先创建
  if (!existsSync(dirname(sqlitePath))) {
    mkdirSync(dirname(sqlitePath), { recursive: true });
  }
  const db = openSqlite(sqlitePath);
  // 一次性镜像:关闭同步提交(镜像可随时重灌,无需持久化保证)
  // 只对本次会话有效;把 fsync 交给 OS,写入吞吐可提升一个量级
  db.pragma('synchronous = OFF');
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const mongo = client.db(dbName);

  console.log('  connected. truncating mirror tables...');
  // 全量重灌语义:清空所有镜像表(顺序无关,无跨表 FK 依赖;
  // FTS 表一并清,避免残留旧文本行导致 MATCH 命中脏数据)
  db.exec(`
    DELETE FROM batch_lora_names;
    DELETE FROM batch_images;
    DELETE FROM batches;
    DELETE FROM stats_doc_lora_names;
    DELETE FROM stats_docs;
    DELETE FROM recipe_lora_names;
    DELETE FROM recipe_groups;
    DELETE FROM stats_summaries;
    DELETE FROM comfy_history;
    DELETE FROM manual_lora_prompt_labels;
    DELETE FROM prompt_annotations;
    DELETE FROM fts_batches;
    DELETE FROM fts_stats_docs;
    DELETE FROM fts_recipe_groups;
  `);

  // images(batch 级 + 子表)
  console.log('mirroring images...');
  {
    // 预编译语句(循环内复用,避免反复 prepare 的开销)
    const insertBatch = db.prepare(`
      INSERT INTO batches(batch_key, captured_at, created_date, created_hour,
        created_weekday, recipe_key, batch_count, base_model, has_positive,
        search_text, doc_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    // INSERT OR IGNORE:按联合主键去重,防御 Mongo 侧重复数据
    const insertImage = db.prepare(`
      INSERT OR IGNORE INTO batch_images(batch_key, resolved_path, source_path, filename,
        image_name, sha256, mtime_ns, size_bytes, captured_at, image_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    const insertLora = db.prepare(
      'INSERT OR IGNORE INTO batch_lora_names(batch_key, name) VALUES (?,?)',
    );
    // 批量写缓冲:攒够 1000 条闭包统一在一个事务里执行,
    // 单事务写 1000 行比逐条 autocommit 快一个量级
    let ops: Array<() => void> = [];
    let n = 0;
    for await (const raw of mongo.collection('images').find({})) {
      // 物化列投影:从嵌套结构取 base_model / search_text / loraNames
      const doc = normalizeDoc(raw);
      const images = (doc.images as Array<Record<string, unknown>>) ?? [];
      const loraNames =
        (doc.loras as { names?: string[] } | undefined)?.names ?? [];
      const batchKey = doc.batch_key ?? '';
      const searchText =
        (doc.prompts as { search_text?: string } | undefined)?.search_text ??
        null;
      // 闭包捕获本批数据,事务内按顺序执行(物化列/子表/FTS 同批原子)
      ops.push(() => {
        insertBatch.run(
          batchKey,
          iso(doc.captured_at),
          doc.created_date ?? null,
          doc.created_hour ?? null,
          doc.created_weekday ?? null,
          doc.recipe_key ?? null,
          doc.batch_count ?? null,
          scalar(
            (doc.model as { base_model?: unknown } | undefined)?.base_model,
          ),
          hasPositive(doc),
          searchText,
          JSON.stringify(doc),
        );
        // 每张图一行子表:resolved_path 空串兜底(NOT NULL 约束),
        // 整图 json 存 image_json
        for (const img of images) {
          const file = (img.file as Record<string, unknown> | undefined) ?? {};
          insertImage.run(
            batchKey,
            file.resolved_path ?? '',
            file.source_path ?? null,
            file.filename ?? null,
            file.image_name ?? null,
            file.sha256 ?? null,
            file.mtime_ns ?? null,
            file.size_bytes ?? null,
            iso(img.captured_at),
            JSON.stringify(img),
          );
        }
        for (const name of loraNames) {
          insertLora.run(batchKey, name);
        }
      });
      if (ops.length >= 1000) {
        withTransaction(db, () => ops.forEach((op) => op()));
        ops = [];
        n += 1000;
        // 进度输出(每 5000 条一次,长任务可观察性)
        if (n % 5000 === 0) process.stdout.write(`  ${n}...\n`);
      }
    }
    // 尾部不足 1000 条的剩余数据
    withTransaction(db, () => ops.forEach((op) => op()));
    n += ops.length;
    // FTS 按 rowid 对齐回填(不逐行插:空 search_text 行跳插会让后续
    // 自增 rowid 整体错位,这正是历史版本 fts 与主表失配的根因)
    db.exec(
      `INSERT INTO fts_batches(rowid, search_text)
       SELECT rowid, search_text FROM batches
       WHERE search_text IS NOT NULL AND search_text != ''`,
    );
    console.log(`  OK: ${n} batches mirrored`);
  }

  // stats_docs
  console.log('mirroring stats_docs...');
  {
    const insertDoc = db.prepare(`
      INSERT INTO stats_docs(resolved_path, filename, image_name, created_date,
        has_parsed_workflow, base_model, search_text, captured_at, doc_json)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    const insertLora = db.prepare(
      'INSERT OR IGNORE INTO stats_doc_lora_names(resolved_path, name) VALUES (?,?)',
    );
    let ops: Array<() => void> = [];
    let n = 0;
    for await (const raw of mongo.collection('stats_docs').find({})) {
      const doc = normalizeDoc(raw);
      const file = (doc.file as Record<string, unknown> | undefined) ?? {};
      const resolved = (file.resolved_path as string) ?? '';
      const loraNames =
        (doc.loras as { names?: string[] } | undefined)?.names ?? [];
      const searchText =
        (doc.prompts as { search_text?: string } | undefined)?.search_text ??
        null;
      ops.push(() => {
        insertDoc.run(
          resolved,
          file.filename ?? null,
          file.image_name ?? null,
          doc.created_date ?? null,
          doc.has_parsed_workflow ? 1 : 0,
          scalar(
            (doc.model as { base_model?: unknown } | undefined)?.base_model,
          ),
          searchText,
          iso(doc.captured_at),
          JSON.stringify(doc),
        );
        for (const name of loraNames) insertLora.run(resolved, name);
      });
      if (ops.length >= 1000) {
        withTransaction(db, () => ops.forEach((op) => op()));
        ops = [];
        n += 1000;
        if (n % 20000 === 0) process.stdout.write(`  ${n}...\n`);
      }
    }
    withTransaction(db, () => ops.forEach((op) => op()));
    n += ops.length;
    // FTS 按 rowid 对齐回填(同 batches section 的错位根因说明)
    db.exec(
      `INSERT INTO fts_stats_docs(rowid, search_text)
       SELECT rowid, search_text FROM stats_docs
       WHERE search_text IS NOT NULL AND search_text != ''`,
    );
    console.log(`  OK: ${n} docs mirrored`);
  }

  // recipe_groups
  console.log('mirroring recipe_groups...');
  {
    const insertDoc = db.prepare(`
      INSERT INTO recipe_groups(recipe_key, captured_at, created_date, base_model,
        search_text, count, batch_keys, has_positive, doc_json)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    const insertLora = db.prepare(
      'INSERT OR IGNORE INTO recipe_lora_names(recipe_key, name) VALUES (?,?)',
    );
    let ops: Array<() => void> = [];
    let n = 0;
    for await (const raw of mongo.collection('recipe_groups').find({})) {
      const doc = normalizeDoc(raw);
      const key = doc.recipe_key ?? '';
      const loraNames =
        (doc.loras as { names?: string[] } | undefined)?.names ?? [];
      const searchText =
        (doc.prompts as { search_text?: string } | undefined)?.search_text ??
        null;
      const positive = (doc.prompts as { positive?: unknown } | undefined)
        ?.positive;
      const hasPositive =
        Array.isArray(positive) && positive.length > 0 ? 1 : 0;
      ops.push(() => {
        insertDoc.run(
          key,
          iso(doc.captured_at),
          doc.created_date ?? null,
          scalar(
            (doc.model as { base_model?: unknown } | undefined)?.base_model,
          ),
          searchText,
          doc.count ?? null,
          // batch_keys 数组序列化为 JSON 文本(原样保存,读侧 JSON.parse)
          doc.batch_keys ? JSON.stringify(doc.batch_keys) : null,
          hasPositive,
          JSON.stringify(doc),
        );
        for (const name of loraNames) insertLora.run(key, name);
      });
      if (ops.length >= 1000) {
        withTransaction(db, () => ops.forEach((op) => op()));
        ops = [];
        n += 1000;
      }
    }
    withTransaction(db, () => ops.forEach((op) => op()));
    n += ops.length;
    // FTS 按 rowid 对齐回填(同 batches section 的错位根因说明)
    db.exec(
      `INSERT INTO fts_recipe_groups(rowid, search_text)
       SELECT rowid, search_text FROM recipe_groups
       WHERE search_text IS NOT NULL AND search_text != ''`,
    );
    console.log(`  OK: ${n} docs mirrored`);
  }

  // 小集合:整文档镜像
  // 描述性表结构(列 + 物化绑定函数),四张小表统一走同一循环
  const smallTables: Array<{
    coll: string; // Mongo 集合名
    table: string; // SQLite 表名
    columns: string[]; // 插入列
    bind: (doc: Record<string, unknown>) => unknown[]; // 物化投影
  }> = [
    {
      coll: 'stats_summaries',
      table: 'stats_summaries',
      columns: ['kind', 'focus_lora', 'doc_json'],
      bind: (d) => [str(d.kind), str(d.focus_lora), JSON.stringify(d)],
    },
    {
      coll: 'comfy_history',
      table: 'comfy_history',
      columns: ['prompt_id', 'processed_at', 'doc_json'],
      bind: (d) => [str(d.prompt_id), iso(d.processed_at), JSON.stringify(d)],
    },
    {
      coll: 'manual_lora_prompt_labels',
      table: 'manual_lora_prompt_labels',
      columns: ['id', 'category', 'loras', 'name', 'doc_json'],
      bind: (d) => [
        str(d._id),
        d.category ?? null,
        Array.isArray(d.loras) ? JSON.stringify(d.loras) : (d.loras ?? null),
        d.name ?? null,
        JSON.stringify(d),
      ],
    },
    {
      coll: 'prompt_annotations',
      table: 'prompt_annotations',
      columns: ['id', 'doc_json'],
      bind: (d) => [str(d._id), JSON.stringify(d)],
    },
  ];
  for (const t of smallTables) {
    console.log(`mirroring ${t.coll}...`);
    // 列名与占位符都来自白名单表定义(非用户输入,无注入面)
    const insert = db.prepare(
      `INSERT INTO ${t.table}(${t.columns.join(', ')}) VALUES (${t.columns.map(() => '?').join(', ')})`,
    );
    let n = 0;
    for await (const raw of mongo.collection(t.coll).find({})) {
      insert.run(...t.bind(normalizeDoc(raw)));
      n++;
    }
    console.log(`  OK: ${n} docs mirrored`);
  }

  // -------------------------------------------------------------------------
  // 校验
  // -------------------------------------------------------------------------
  console.log('\nvalidating...');
  let failures = 0;
  // 行数对照:collection → table(一一映射)
  const checks: Array<[string, string]> = [
    ['images', 'batches'],
    ['stats_docs', 'stats_docs'],
    ['recipe_groups', 'recipe_groups'],
    ['stats_summaries', 'stats_summaries'],
    ['comfy_history', 'comfy_history'],
    ['manual_lora_prompt_labels', 'manual_lora_prompt_labels'],
    ['prompt_annotations', 'prompt_annotations'],
  ];
  for (const [coll, table] of checks) {
    const m = await mongo.collection(coll).countDocuments();
    const s = (
      db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
    ).c;
    const status = m === s ? 'OK' : `MISMATCH`;
    if (m !== s) failures++;
    console.log(`  ${coll} -> ${table}: mongo=${m} sqlite=${s} ${status}`);
  }

  // batch_images 是 images[] 子表:对比元素总数而非批次文档数
  // Mongo 侧聚合:展开 images 数组统计元素总数($size 处理缺失字段)
  {
    const m = (
      await mongo
        .collection('images')
        .aggregate([
          { $project: { n: { $size: { $ifNull: ['$images', []] } } } },
          { $group: { _id: null, n: { $sum: '$n' } } },
        ])
        .toArray()
    )[0]?.n as number | undefined;
    const s = (
      db.prepare('SELECT COUNT(*) AS c FROM batch_images').get() as {
        c: number;
      }
    ).c;
    const status = m === s ? 'OK' : 'MISMATCH';
    if (m !== s) failures++;
    console.log(`  images[] -> batch_images: mongo=${m} sqlite=${s} ${status}`);
  }

  // 抽样 byte-equal:随机 N 条 batch,重取 Mongo 原始文档与 SQLite doc_json 归一化对比
  // RANDOM() 抽样 + LIMIT N:全库随机抽取,避免只检查头部数据
  const keys = (
    db
      .prepare('SELECT batch_key FROM batches ORDER BY RANDOM() LIMIT ?')
      .all(SAMPLE_SIZE) as Array<{ batch_key: string }>
  ).map((r) => r.batch_key);
  for (const key of keys) {
    const mongoDoc = normalizeDoc(
      (await mongo.collection('images').findOne({ batch_key: key })) as Record<
        string,
        unknown
      >,
    );
    const row = db
      .prepare('SELECT doc_json FROM batches WHERE batch_key = ?')
      .get(key) as { doc_json: string } | undefined;
    // 两侧都做 JSON 规范化(键序无关),再比较字符串等价。
    // 仅 JSON.stringify(JSON.parse()) 不排序键,不同键序会假阳性 FAIL,
    // 故这里显式递归排序对象键后再序列化。
    const normalizeOrder = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(normalizeOrder);
      if (v !== null && typeof v === 'object') {
        const obj = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(obj).sort()) out[k] = normalizeOrder(obj[k]);
        return out;
      }
      return v;
    };
    const norm = (j: string) => JSON.stringify(normalizeOrder(JSON.parse(j)));
    if (!row || norm(row.doc_json) !== norm(JSON.stringify(mongoDoc))) {
      failures++;
      console.log(`  FAIL byte-equal: batch ${key}`);
    }
  }
  if (failures === 0) {
    console.log(`  OK: ${keys.length} batch docs byte-equal (canonical JSON)`);
  }

  // FTS 行数观察(不设门禁:search_text 缺失的批次本就无 fts 行)
  const ftsCount = (
    db.prepare('SELECT COUNT(*) AS c FROM fts_batches').get() as { c: number }
  ).c;
  console.log(`  fts_batches rows: ${ftsCount}`);

  await client.close();
  db.close();

  if (failures > 0) {
    console.error(`\nVALIDATION FAILED with ${failures} mismatch(es)`);
    process.exit(1);
  }
  console.log('\nbackfill complete, validation passed.');
}

// 入口:未捕获异常统一退出码 2(与 compare.ts 约定一致)
main().catch((err) => {
  console.error(err);
  process.exit(2);
});
