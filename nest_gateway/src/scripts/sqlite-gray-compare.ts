/**
 * SQLite 灰测轨道 — 双端对照(gray-compare)。
 *
 * 对代表查询在 Mongo(生产)与 SQLite(镜像)上各执行一遍,
 * 输出行数 / 键集合差异 / 耗时对照。灰测观察用:有差异只报告,不设门禁。
 *
 * 用法:
 *   npx ts-node src/scripts/sqlite-gray-compare.ts [--sqlite PATH] [--uri URI] [--db NAME]
 *
 * 退出码:0 = 完成(差异仅报告);2 = 脚本错误。
 *
 * 数据流向:
 *   前置依赖 sqlite-backfill.ts 生成 gray_workflow.sqlite3(镜像);
 *   本脚本对同一组代表查询分别打 Mongo 与 SQLite,
 *   以 console.table 输出对照行(行数/键集/耗时),差异只报告不阻塞。
 */

import { join } from 'path';
import { MongoClient } from 'mongodb';
import { loadRepoEnv } from './env';
import { DB_FILENAME, resolveDataDir } from '../config/data-dir';
import { openSqlite } from '../sqlite/db';

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

/**
 * 简易取值:--key value 形式参数,无则 undefined。
 * (与 backfill 共用同款实现,保持脚本一致性)
 */
function argValue(argv: string[], key: string): string | undefined {
  const i = argv.indexOf(key);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * 一行对照结果:
 *   - name:查询名(前端场景语义)
 *   - mongo / sqlite:两端结果(数值或摘要字符串)
 *   - diff:差异标注('' 一致;'DIFF' 或自定义说明;FTS 行/跳过场景有专用文案)
 *   - mongoMs / sqliteMs:两端耗时(毫秒)
 */
type Row = {
  name: string;
  mongo: number | string;
  sqlite: number | string;
  diff: string;
  mongoMs: number;
  sqliteMs: number;
};

const rows: Row[] = [];

/**
 * 记录一行对照结果。
 *
 * @param name 查询名
 * @param mongo / sqlite 两端值(字符串化后比较)
 * @param mongoMs / sqliteMs 两端耗时
 * @param diffNote 两侧值不等时的自定义说明;缺省用 'DIFF'
 */
function record(
  name: string,
  mongo: number | string,
  sqlite: number | string,
  mongoMs: number,
  sqliteMs: number,
  diffNote = '',
): void {
  const same = String(mongo) === String(sqlite);
  rows.push({
    name,
    mongo,
    sqlite,
    diff: same ? '' : diffNote || 'DIFF',
    mongoMs,
    sqliteMs,
  });
}

/**
 * 计时执行异步查询:返回 { ms, value }。
 */
async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ ms: number; value: T }> {
  const t0 = Date.now();
  const value = await fn();
  return { ms: Date.now() - t0, value };
}

/**
 * 主流程:
 *   1. 打开 SQLite 镜像 + Mongo 连接
 *   2. 基础计数:各表行数对照(含 images[] 子表元素总数聚合)
 *   3. distinct 维度:base_model / loras.names(两侧排除 null 后比较,
 *      null 语义差异单独记一条 info 行)
 *   4. 列表查询:取一个 top base_model / top lora / 固定日期过滤,
 *      对照 total + 前 50 条主键集合
 *   5. 文本搜索:LIKE 与 $regex 'i' 对照(附 FTS5 词级结果,仅观察)
 *   6. stats_docs 遍历基础计数
 *   7. console.table 输出;差异按 diff 文案过滤后 warn 提示(不设门禁)
 */
async function main(): Promise<void> {
  console.log('SQLite gray compare');
  console.log(`  mongo:  ${mongoUri}/${dbName}`);
  console.log(`  sqlite: ${sqlitePath}`);

  const db = openSqlite(sqlitePath);
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const mongo = client.db(dbName);

  // -------------------------------------------------------------------------
  // 1. 基础计数
  // -------------------------------------------------------------------------
  console.log('\n-- base counts --');
  // [显示名, Mongo 集合, SQLite 表] 三元素元组列表,统一循环
  for (const [name, coll, table] of [
    ['images', 'images', 'batches'],
    ['stats_docs', 'stats_docs', 'stats_docs'],
    ['recipe_groups', 'recipe_groups', 'recipe_groups'],
    ['stats_summaries', 'stats_summaries', 'stats_summaries'],
    ['comfy_history', 'comfy_history', 'comfy_history'],
    ['labels', 'manual_lora_prompt_labels', 'manual_lora_prompt_labels'],
  ] as Array<[string, string, string]>) {
    const m = await timed(() => mongo.collection(coll).countDocuments({}));
    const s = timedSync(
      () =>
        (
          db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
            c: number;
          }
        ).c,
    );
    record(name, m.value, s.value, m.ms, s.ms);
  }
  // batch_images 是 images[] 子表:对比元素总数
  {
    // Mongo 侧聚合展开 images 数组求元素总数($size 处理缺失字段)
    const m = await timed(async () => {
      const agg = await mongo
        .collection('images')
        .aggregate([
          { $project: { n: { $size: { $ifNull: ['$images', []] } } } },
          { $group: { _id: null, n: { $sum: '$n' } } },
        ])
        .toArray();
      return (agg[0]?.n as number) ?? 0;
    });
    const s = timedSync(
      () =>
        (
          db.prepare('SELECT COUNT(*) AS c FROM batch_images').get() as {
            c: number;
          }
        ).c,
    );
    record('images[] (child rows)', m.value, s.value, m.ms, s.ms);
  }

  // -------------------------------------------------------------------------
  // 2. distinct 维度(前端 options 接口)
  //    Mongo distinct 计入 null/undefined 值;SQLite COUNT(DISTINCT) 忽略 NULL。
  //    两侧都排除 null 后比较,差异明细单独报告。
  // -------------------------------------------------------------------------
  console.log('\n-- distinct --');
  {
    // base_model:distinct 路径 'model.base_model'
    const m = await timed(() =>
      mongo.collection('images').distinct('model.base_model'),
    );
    const s = timedSync(() =>
      (
        db
          .prepare(
            "SELECT DISTINCT base_model FROM batches WHERE base_model IS NOT NULL AND base_model != ''",
          )
          .all() as Array<{ base_model: string }>
      ).map((r) => r.base_model),
    );
    // Mongo distinct 会带出 null/undefined/''——过滤后与 SQLite 对齐比较
    const mClean = m.value.filter(
      (v) => v !== null && v !== undefined && v !== '',
    );
    const d = diffKeys(mClean, s.value);
    record(
      'distinct base_model (excl null)',
      mClean.length,
      s.value.length,
      m.ms,
      s.ms,
      // 集合差异时附两侧前 3 个独有值(可观测、可复现)
      d.differs
        ? `onlyMongo=${d.onlyMongo.slice(0, 3).join(',')} onlySqlite=${d.onlySqlite.slice(0, 3).join(',')}`
        : '',
    );
    // null 语义差异单独记录(info 行,不计入门禁):
    // SQLite 侧无 null 概念,NULL 列被 distinct 排除
    if (m.value.length !== mClean.length) {
      record(
        '  base_model null/empty (info)',
        m.value.length - mClean.length,
        '(NULL 被忽略)',
        0,
        0,
        'null 语义差异,前端 options 同样需要过滤',
      );
    }

    // loras.names:distinct 路径 'loras.names',SQLite 走子表 DISTINCT
    const mLora = await timed(() =>
      mongo.collection('images').distinct('loras.names'),
    );
    const sLora = timedSync(() =>
      (
        db
          .prepare('SELECT DISTINCT name FROM batch_lora_names')
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    const mLoraClean = mLora.value.filter(
      (v) => v !== null && v !== undefined && v !== '',
    );
    const dLora = diffKeys(mLoraClean, sLora.value);
    record(
      'distinct loras.names (excl null)',
      mLoraClean.length,
      sLora.value.length,
      mLora.ms,
      sLora.ms,
      dLora.differs
        ? `onlyMongo=${dLora.onlyMongo.slice(0, 3).join(',')} onlySqlite=${dLora.onlySqlite.slice(0, 3).join(',')}`
        : '',
    );
    if (mLora.value.length !== mLoraClean.length) {
      record(
        '  loras.names null/empty (info)',
        mLora.value.length - mLoraClean.length,
        '(NULL 被忽略)',
        0,
        0,
        'null 语义差异',
      );
    }
  }

  // -------------------------------------------------------------------------
  // 3. 列表查询(前端 /api/images/summary batch 模式)
  // -------------------------------------------------------------------------
  console.log('\n-- list queries --');
  // 选一个"存在非空 string base_model"的模型作为探针:
  // 取字典序最小的一个,保证选择稳定可复现
  const topModel = (
    await mongo
      .collection('images')
      .aggregate([
        { $match: { 'model.base_model': { $type: 'string', $ne: '' } } },
        { $group: { _id: '$model.base_model' } },
        { $sort: { _id: 1 } },
        { $limit: 1 },
      ])
      .toArray()
  )[0]?._id as string | undefined;

  if (topModel && typeof topModel === 'string') {
    // Mongo:find + count 并行(Promise.all),排序 captured_at 降序取 50
    const m = await timed(async () => {
      const [items, total] = await Promise.all([
        mongo
          .collection('images')
          .find({ 'model.base_model': topModel })
          .sort({ captured_at: -1 })
          .limit(50)
          .toArray(),
        mongo
          .collection('images')
          .countDocuments({ 'model.base_model': topModel }),
      ]);
      return { keys: items.map((d) => d.batch_key as string), total };
    });
    // SQLite:物化列等值 + 同样排序/分页;只取主键列(对照键集即可)
    const s = timedSync(() => {
      const items = db
        .prepare(
          'SELECT batch_key FROM batches WHERE base_model = ? ORDER BY captured_at DESC LIMIT 50',
        )
        .all(topModel) as Array<{ batch_key: string }>;
      const total = (
        db
          .prepare('SELECT COUNT(*) AS c FROM batches WHERE base_model = ?')
          .get(topModel) as { c: number }
      ).c;
      return { keys: items.map((r) => r.batch_key), total };
    });
    record(
      `list base_model=${topModel.slice(0, 20)}...`,
      m.value.total,
      s.value.total,
      m.ms,
      s.ms,
    );
    // 前 50 条主键集合差异(排序可能不同,集合比较更语义化)
    const keyDiff = diffKeys(m.value.keys, s.value.keys);
    if (keyDiff.differs) {
      rows.push({
        name: '  list keys(set diff)',
        mongo: keyDiff.onlyMongo.length,
        sqlite: keyDiff.onlySqlite.length,
        diff: `onlyMongo=${keyDiff.onlyMongo.slice(0, 3).join(',')} onlySqlite=${keyDiff.onlySqlite.slice(0, 3).join(',')}`,
        mongoMs: 0,
        sqliteMs: 0,
      });
    }
  } else {
    // 数据里没有 string 类型 base_model(空库/全脏数据),跳过
    record('list base_model', '(no string model found)', '-', 0, 0, 'skip');
  }

  // created_date 过滤 + count
  {
    // 固定探针日期 '2026-08-02'(ISO 文本比较,Mongo 与 SQLite 语义一致)
    const m = await timed(async () => {
      const [items, total] = await Promise.all([
        mongo
          .collection('images')
          .find({ created_date: { $lte: '2026-08-02' } })
          .sort({ captured_at: -1 })
          .limit(50)
          .toArray(),
        mongo
          .collection('images')
          .countDocuments({ created_date: { $lte: '2026-08-02' } }),
      ]);
      return { keys: items.map((d) => d.batch_key as string), total };
    });
    const s = timedSync(() => {
      const items = db
        .prepare(
          'SELECT batch_key FROM batches WHERE created_date <= ? ORDER BY captured_at DESC LIMIT 50',
        )
        .all('2026-08-02') as Array<{ batch_key: string }>;
      const total = (
        db
          .prepare('SELECT COUNT(*) AS c FROM batches WHERE created_date <= ?')
          .get('2026-08-02') as { c: number }
      ).c;
      return { keys: items.map((r) => r.batch_key), total };
    });
    record(
      'list created_date<=2026-08-02',
      m.value.total,
      s.value.total,
      m.ms,
      s.ms,
    );
    const keyDiff = diffKeys(m.value.keys, s.value.keys);
    if (keyDiff.differs) {
      rows.push({
        name: '  list keys(set diff)',
        mongo: keyDiff.onlyMongo.length,
        sqlite: keyDiff.onlySqlite.length,
        diff: `onlyMongo=${keyDiff.onlyMongo.slice(0, 3).join(',')} onlySqlite=${keyDiff.onlySqlite.slice(0, 3).join(',')}`,
        mongoMs: 0,
        sqliteMs: 0,
      });
    }
  }

  // recipe 模式:lora 过滤 + count
  {
    // 探针 lora:unwind 展开 loras.names 后取第一个(可能含 null,后面校验)
    const topLora = (
      await mongo
        .collection('recipe_groups')
        .aggregate([
          { $unwind: '$loras.names' },
          { $group: { _id: '$loras.names' } },
          { $limit: 1 },
        ])
        .toArray()
    )[0]?._id as string | undefined;
    if (topLora && typeof topLora === 'string') {
      const m = await timed(async () => {
        const [items, total] = await Promise.all([
          mongo
            .collection('recipe_groups')
            .find({ 'loras.names': topLora })
            .sort({ captured_at: -1 })
            .limit(50)
            .toArray(),
          mongo
            .collection('recipe_groups')
            .countDocuments({ 'loras.names': topLora }),
        ]);
        return { keys: items.map((d) => d.recipe_key as string), total };
      });
      // SQLite:JOIN 子表等值过滤(数组语义 → 子表 EXISTS 等价写法)
      const s = timedSync(() => {
        const items = db
          .prepare(
            `SELECT r.recipe_key FROM recipe_groups r
             JOIN recipe_lora_names l ON l.recipe_key = r.recipe_key
             WHERE l.name = ? ORDER BY r.captured_at DESC LIMIT 50`,
          )
          .all(topLora) as Array<{ recipe_key: string }>;
        // 注意:total 走子表直接计数,与 list 的 DISTINCT recipe_key 语义
        // 有细微差异(Mongo countDocuments 是文档去重计数),仅作参考对照
        const total = (
          db
            .prepare(
              'SELECT COUNT(*) AS c FROM recipe_lora_names WHERE name = ?',
            )
            .get(topLora) as { c: number }
        ).c;
        return { keys: items.map((r) => r.recipe_key), total };
      });
      record(
        `recipe lora=${topLora.slice(0, 20)}...`,
        m.value.total,
        s.value.total,
        m.ms,
        s.ms,
      );
      const keyDiff = diffKeys(m.value.keys, s.value.keys);
      if (keyDiff.differs) {
        rows.push({
          name: '  recipe keys(set diff)',
          mongo: keyDiff.onlyMongo.length,
          sqlite: keyDiff.onlySqlite.length,
          diff: `onlyMongo=${keyDiff.onlyMongo.slice(0, 3).join(',')} onlySqlite=${keyDiff.onlySqlite.slice(0, 3).join(',')}`,
          mongoMs: 0,
          sqliteMs: 0,
        });
      }
    } else {
      record('recipe lora', '(none)', '-', 0, 0, 'skip');
    }
  }

  // -------------------------------------------------------------------------
  // 4. 文本搜索(语义对照:regex 'i' vs LIKE %q%,另附 FTS5 词级结果)
  // -------------------------------------------------------------------------
  console.log('\n-- text search --');
  // 探针词固定三条:普通词 / 特殊词 / 分数语法词(覆盖大小写与下划线场景)
  for (const q of ['girl', 'blowjob', 'score_8_up']) {
    // Mongo:$regex q + $options 'i'(大小写不敏感子串)
    const m = await timed(async () => {
      const [items, total] = await Promise.all([
        mongo
          .collection('images')
          .find({ 'prompts.search_text': { $regex: q, $options: 'i' } })
          .sort({ captured_at: -1 })
          .limit(50)
          .toArray(),
        mongo.collection('images').countDocuments({
          'prompts.search_text': { $regex: q, $options: 'i' },
        }),
      ]);
      return { keys: items.map((d) => d.batch_key as string), total };
    });
    // SQLite:LIKE %q%(SQLite LIKE 对 ASCII 大小写不敏感,语义接近)
    const s = timedSync(() => {
      const items = db
        .prepare(
          'SELECT batch_key FROM batches WHERE search_text LIKE ? ORDER BY captured_at DESC LIMIT 50',
        )
        .all(`%${q}%`) as Array<{ batch_key: string }>;
      const total = (
        db
          .prepare('SELECT COUNT(*) AS c FROM batches WHERE search_text LIKE ?')
          .get(`%${q}%`) as { c: number }
      ).c;
      return { keys: items.map((r) => r.batch_key), total };
    });
    record(`search q=${q}`, m.value.total, s.value.total, m.ms, s.ms);
    const keyDiff = diffKeys(m.value.keys, s.value.keys);
    if (keyDiff.differs) {
      rows.push({
        name: `  search q=${q} keys(set diff)`,
        mongo: keyDiff.onlyMongo.length,
        sqlite: keyDiff.onlySqlite.length,
        diff: `onlyMongo=${keyDiff.onlyMongo.slice(0, 3).join(',')} onlySqlite=${keyDiff.onlySqlite.slice(0, 3).join(',')}`,
        mongoMs: 0,
        sqliteMs: 0,
      });
    }
    // FTS5 词级匹配(引号包裹探针词):词级语义与子串语义天然不同,
    // 仅作信息观察,不算差异
    const fts = timedSync(
      () =>
        (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM fts_batches WHERE fts_batches MATCH ?`,
            )
            .get(`"${q}"`) as { c: number }
        ).c,
    );
    record(
      `  FTS5 q=${q}(info)`,
      '-',
      fts.value,
      0,
      fts.ms,
      'FTS 词级语义,仅观察',
    );
  }

  // -------------------------------------------------------------------------
  // 5. stats_docs 分析基础遍历(统计页数据源)
  // -------------------------------------------------------------------------
  console.log('\n-- stats_docs --');
  {
    const m = await timed(() =>
      mongo
        .collection('stats_docs')
        .countDocuments({ has_parsed_workflow: true }),
    );
    const s = timedSync(
      () =>
        (
          db
            .prepare(
              'SELECT COUNT(*) AS c FROM stats_docs WHERE has_parsed_workflow = 1',
            )
            .get() as { c: number }
        ).c,
    );
    record('has_parsed_workflow=true', m.value, s.value, m.ms, s.ms);
  }

  // -------------------------------------------------------------------------
  // 输出
  // -------------------------------------------------------------------------
  console.log('\n-- results --');
  console.table(rows.map((r) => ({ ...r, diff: r.diff || '' })));

  // 差异过滤:排除"仅观察"(FTS 词级)与"跳过"两类非差异行,
  // 其余才是需要人工关注的差异
  const diffs = rows.filter(
    (r) => r.diff && r.diff !== 'FTS 词级语义,仅观察' && r.diff !== 'skip',
  );
  if (diffs.length > 0) {
    console.warn(
      `\n${diffs.length} item(s) with difference (gray observation only, no gate).`,
    );
  } else {
    console.log(
      '\nNo differences observed. SQLite mirror is consistent with Mongo.',
    );
  }

  await client.close();
  db.close();
}

/**
 * 计时执行同步查询(与 timed 对称):返回 { ms, value }。
 */
function timedSync<T>(fn: () => T): { ms: number; value: T } {
  const t0 = Date.now();
  const value = fn();
  return { ms: Date.now() - t0, value };
}

/**
 * 两主键集合差集:
 *
 * @param a Mongo 侧键列表
 * @param b SQLite 侧键列表
 * @returns {
 *   differs: 是否存在任一方向独有,
 *   onlyMongo: 仅 Mongo 有,
 *   onlySqlite: 仅 SQLite 有
 * }
 *
 * 集合比较而非顺序比较:排序差异不影响语义一致性。
 */
function diffKeys(
  a: string[],
  b: string[],
): {
  differs: boolean;
  onlyMongo: string[];
  onlySqlite: string[];
} {
  const setA = new Set(a);
  const setB = new Set(b);
  const onlyMongo = a.filter((k) => !setB.has(k));
  const onlySqlite = b.filter((k) => !setA.has(k));
  return {
    differs: onlyMongo.length > 0 || onlySqlite.length > 0,
    onlyMongo,
    onlySqlite,
  };
}

// 入口:未捕获异常统一退出码 2(与 backfill/compare 约定一致)
main().catch((err) => {
  console.error(err);
  process.exit(2);
});
