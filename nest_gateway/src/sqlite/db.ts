/**
 * SQLite — 连接、初始化与维护。
 *
 * 原为灰测轨道基础设施,现升级为主用化后的核心数据层入口:
 * 打开(建 schema)/事务/备份/完整性检查,均在这里收敛。
 *
 * 数据流向:repo.ts(写路径)、reader.ts(读路径)与运维脚本
 * (sqlite-backfill.ts / sqlite-gray-compare.ts)都通过 openSqlite 取得连接;
 * 基线表结构来自 ./schema.ts(SCHEMA_SQL),本模块内维护版本化增量迁移
 * (SCHEMA_MIGRATIONS)。三根支柱配合,保证任意历史版本都能打开到当前结构:
 *   1. SCHEMA_SQL    —— 新库全量建表(旧库已存在的表保持原样)
 *   2. SCHEMA_MIGRATIONS —— 旧库语义升级(表重建 / 列补齐 / 数据回填)
 *   3. expandSchema  —— 结构兜底:补"目标结构有、库里没有"的列与索引
 *      (迁移漏写某列时的保底;只增不减,绝不 DROP/改类型)
 */

import { dirname } from 'path';
import { mkdirSync } from 'fs';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema';

/**
 * 打开(或创建)SQLite 库,初始化 WAL + schema。
 *
 * @param dbPath 数据库文件路径;文件不存在时 better-sqlite3 会自动创建
 * @returns 就绪的 Database 连接(schema 与迁移均已应用)
 *
 * 内部步骤:
 *   1. new Database 打开连接
 *   2. journal_mode = WAL:写入走独立 WAL 文件,读者不被写者阻塞,
 *      支持 gateway 进程与运维脚本并发访问
 *   3. busy_timeout = 5000:遇到锁竞争最多等 5 秒,而不是立刻抛
 *      SQLITE_BUSY,降低并发写冲突导致的偶发失败
 *   4. cache_size = -64000:64MB 页缓存(默认 -2000 仅 2MB,高频读路径反复换出)
 *   5. mmap_size = 256MB:文件库启用只读内存映射,减少 read() 系统调用
 *      (内存库无文件可映射,跳过——SQLite 对 :memory: 设 mmap_size 恒为 0)
 *   6. exec(SCHEMA_SQL):应用基线 schema(全部 CREATE TABLE IF NOT EXISTS,
 *      对新库幂等)
 *   7. migrateSchema:按 PRAGMA user_version 补齐增量迁移(旧库升级路径)
 *   8. expandSchema:结构兜底——补"目标结构有、库里没有"的列与索引(见该函数注释)
 *   9. ensureFtsAligned / ensureAnalyzed:启动自检(FTS rowid 对齐、统计信息)
 *
 * 注意:4/5 是**连接级**参数,不随库文件持久化,所以不能只写进 schema 基线;
 * 每个新连接都要设置一次(这也是"另开只读连接读 PRAGMA 会读到默认值"的原因)。
 *
 * 边界:重复调用对同一文件安全——迁移以 user_version 去重,天然幂等;
 * 返回的连接由调用方负责 close。
 *
 * @param dbPath 数据库文件路径;':memory:' 时跳过后两步(内存库天生即当前结构)
 * @param options.onSchemaExpand 结构兜底的结果回调(启动日志已打印一份;
 *        运维工具用它做"预演/报告",见 tools/migrate_workflow_db.cjs)
 */
export function openSqlite(
  dbPath: string,
  options?: { onSchemaExpand?: (report: SchemaExpandReport) => void },
): Database.Database {
  // 默认库位于 <repo_root>/data/ 下,父目录不存在时需先创建
  // (better-sqlite3 不会自动建目录;纯远程内存库跳过)
  if (dbPath && dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -64000');
  if (dbPath !== ':memory:') {
    db.pragma('mmap_size = 268435456');
  }
  db.exec(SCHEMA_SQL);
  migrateSchema(db);
  if (dbPath !== ':memory:') {
    // 结构兜底用**独立的内存探针**取目标结构(而不是 openSqlite(':memory:')),
    // 既避免递归,也不需要给一次性探针付连接级调参的开销
    const probe = new Database(':memory:');
    probe.exec(SCHEMA_SQL);
    migrateSchema(probe);
    const report = expandSchema(db, desiredSchemaShape(probe));
    probe.close();
    const touched = report.columns.length + report.indexes.length;
    if (touched || report.failed.length || report.manual.length) {
      // 补结构是"库被自动改动"的事件,必须留痕:漏写迁移不再表现为崩溃,而是这行日志
      console.warn(
        `[sqlite] 结构自动补全 ${dbPath}:补列 ${report.columns.length} 个、补索引 ${report.indexes.length} 个` +
          (report.degraded.length ? `,降级 ${report.degraded.length}` : '') +
          (report.manual.length ? `,需人工 ${report.manual.length}` : '') +
          (report.failed.length ? `,失败 ${report.failed.length}` : ''),
      );
      for (const c of report.columns) console.warn(`[sqlite]   + 列 ${c}`);
      for (const i of report.indexes) console.warn(`[sqlite]   + 索引 ${i}`);
      for (const d of report.degraded) console.warn(`[sqlite]   ! 降级 ${d}`);
      for (const m of report.manual) console.warn(`[sqlite]   ! 需人工 ${m}`);
      for (const f of report.failed) console.warn(`[sqlite]   ✗ 失败 ${f}`);
    }
    options?.onSchemaExpand?.(report);
  }
  ensureFtsAligned(db);
  ensureAnalyzed(db);
  return db;
}

/**
 * 统计信息自检(Analyze-on-first-open)。
 *
 * 背景:查询优化器依赖 sqlite_stat1 选择索引,该表只由 ANALYZE 生成。
 * 全仓此前无任何 ANALYZE 调用 → 大型库(数千行 + 物化列 + FTS)上
 * 优化器只能凭启发式猜索引。
 *
 * 策略:**只在统计信息缺失且库内已有数据时**执行一次,之后启动零开销
 * (不重复 ANALYZE:写入增量由 SQLite 自己的 rowid 估算兜底,足够本场景)。
 * ANALYZE 失败(如文件只读)不阻断启动——统计信息缺失只影响优化器选择。
 */
function ensureAnalyzed(db: Database.Database): void {
  const stat = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'`)
    .get() as { name: string } | undefined;
  if (stat) {
    const rows = (db.prepare('SELECT COUNT(*) AS c FROM sqlite_stat1').get() as { c: number }).c;
    if (rows > 0) return; // 已分析过(空表说明此前只分析过空库,继续走重建)
  }
  // 空库(仅 schema、无数据)不必分析:ANALYZE 只会产出空统计
  const batches = (db.prepare('SELECT COUNT(*) AS c FROM batches').get() as { c: number }).c;
  if (batches === 0) return;
  try {
    db.exec('ANALYZE');
  } catch {
    /* 只读库 / 权限受限:统计缺失只影响查询计划,不阻断启动 */
  }
}

/**
 * FTS 表与主表 rowid 对齐自愈(启动时执行)。
 *
 * 背景:fts_* 表的 rowid 必须与主表行 rowid 一一对应,读路径的
 * `rowid IN (SELECT rowid FROM fts_* WHERE fts_* MATCH ?)` 才能正确
 * 回连主表行。历史版本的 FTS 写入未显式指定 rowid(自增),且旧
 * backfill 跳过空 search_text 行导致整体错位,fts 行数少于主表
 * 非空行数(曾缺失 3000+ 行)。
 *
 * 自愈策略:逐表比对 COUNT(fts) 与 COUNT(主表非空 search_text 行),
 * 失配即事务内整表重对齐(DELETE + INSERT SELECT rowid),幂等。
 * 正常写路径(repo.ts 显式指定 rowid)不会产生失配,此检测每次
 * 启动仅 3 次 COUNT(毫秒级);失配重建约万行 FTS <5s,一次性。
 */
function ensureFtsAligned(db: Database.Database): void {
  const pairs = [
    { main: 'batches', fts: 'fts_batches' },
    { main: 'stats_docs', fts: 'fts_stats_docs' },
    { main: 'recipe_groups', fts: 'fts_recipe_groups' },
  ] as const;
  for (const { main, fts } of pairs) {
    const mainCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM ${main}
           WHERE search_text IS NOT NULL AND search_text != ''`,
        )
        .get() as { c: number }
    ).c;
    const ftsCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM ${fts}`).get() as { c: number }
    ).c;
    if (mainCount === ftsCount) continue;
    withTransaction(db, () => {
      db.exec(`DELETE FROM ${fts}`);
      db.exec(
        `INSERT INTO ${fts}(rowid, search_text)
         SELECT rowid, search_text FROM ${main}
         WHERE search_text IS NOT NULL AND search_text != ''`,
      );
    });
  }
}

/**
 * 单条 schema 迁移:version 为迁移后的目标 user_version,up 为迁移动作。
 *
 * 字段语义:
 *   - version:迁移序号,单调递增;迁移成功后写入 PRAGMA user_version,
 *     表示"库结构已升级到该版本"
 *   - up:实际迁移动作(DDL/数据整理),在事务内执行
 *
 * 约定:已发布的条目只追加不修改(改旧迁移会让已升级的库对不上),
 * 新增迁移一律追加到数组末尾。
 */
interface SchemaMigration {
  version: number;
  up: (db: Database.Database) => void;
}

/**
 * 版本化迁移序列:按 version 升序顺序执行,PRAGMA user_version 记录
 * 已应用到的版本。已发布条目只追加不修改;新增迁移挂到数组末尾即可。
 *
 * version 0 → 1:旧库补 recipe_groups.has_positive 列
 * (CREATE IF NOT EXISTS 无法给既有表加列,ALTER 无 IF NOT EXISTS 语义)。
 *
 * 该迁移自检列是否存在:
 *   - 全新库:基线 schema 已含 has_positive,无需 ALTER
 *   - 旧库:缺列才 ALTER(ALTER ADD COLUMN 重复执行会报 duplicate column)
 *   - 手工加过列但 user_version 未升的库:跳过,不报错
 */
const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    up: (db) => {
      // PRAGMA table_info 返回该表全部列(列名在 name 字段),用于探测列是否已存在
      const recipeCols = db.prepare('PRAGMA table_info(recipe_groups)').all() as Array<{
        name: string;
      }>;
      if (!recipeCols.some((c) => c.name === 'has_positive')) {
        db.exec('ALTER TABLE recipe_groups ADD COLUMN has_positive INTEGER');
      }
    },
  },
  {
    // version 1 → 2:favorites 一图多分类改造。
    // 旧表 sha256 单列 PK(一图一条)重建为 (sha256, category) 复合 PK(一图一分类一条);
    // 存量数据按旧表 sha256 取首条迁移,category 从 doc_json 物化(缺省空串 = 未分类)。
    // 全新库:基线 schema 已建复合 PK 表(含 category 列),探测后跳过重建。
    version: 2,
    up: (db) => {
      const favCols = db.prepare('PRAGMA table_info(favorites)').all() as Array<{
        name: string;
      }>;
      if (favCols.some((c) => c.name === 'category')) return;
      db.exec(`
        CREATE TABLE favorites_v2 (
          sha256   TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT '',
          doc_json TEXT NOT NULL,
          PRIMARY KEY (sha256, category)
        );
        INSERT INTO favorites_v2(sha256, category, doc_json)
          SELECT sha256,
                 COALESCE(json_extract(doc_json, '$.category'), ''),
                 doc_json
          FROM favorites;
        DROP TABLE favorites;
        ALTER TABLE favorites_v2 RENAME TO favorites;
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS image_lineage_edges (
          edge_id TEXT PRIMARY KEY, child_sha256 TEXT NOT NULL,
          child_batch_key TEXT, parent_sha256 TEXT, parent_batch_key TEXT,
          relation_type TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL,
          raw_ref TEXT, source_node_id TEXT, source_node_type TEXT,
          source_content_sha256 TEXT, match_method TEXT,
          active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_lineage_child ON image_lineage_edges(child_sha256);
        CREATE INDEX IF NOT EXISTS idx_lineage_parent ON image_lineage_edges(parent_sha256);
        CREATE INDEX IF NOT EXISTS idx_lineage_status ON image_lineage_edges(status);
        CREATE INDEX IF NOT EXISTS idx_lineage_content_hash ON image_lineage_edges(source_content_sha256);
      `);
    },
  },
  {
    // version 3 → 4:image_lineage_edges 补 downstream 列(JSON 文本)。
    // 多 CN 各引不同参考图时,记录该参考图喂到的 ControlNet 应用
    // (apply 节点/loader/模型名/强度),供详情页标注"喂给哪个 CN"。
    // 全新库:基线 schema 已含该列,探测后跳过。
    version: 4,
    up: (db) => {
      const lineageCols = db
        .prepare('PRAGMA table_info(image_lineage_edges)')
        .all() as Array<{ name: string }>;
      if (!lineageCols.some((c) => c.name === 'downstream')) {
        db.exec('ALTER TABLE image_lineage_edges ADD COLUMN downstream TEXT');
      }
    },
  },
  {
    // version 4 → 5:batch_images 补 content_sha256 列 + 索引。
    // 该列存**文件内容哈希**(区别于 sha256 的路径字符串哈希),供血缘
    // 按内容匹配父图;由 LineageService 惰性回填(入库路径不为每张图算哈希)。
    // 全新库:基线 schema 已含该列与索引,探测后跳过。
    version: 5,
    up: (db) => {
      const imageCols = db
        .prepare('PRAGMA table_info(batch_images)')
        .all() as Array<{ name: string }>;
      if (!imageCols.some((c) => c.name === 'content_sha256')) {
        db.exec('ALTER TABLE batch_images ADD COLUMN content_sha256 TEXT');
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_batch_images_content_sha256 ON batch_images(content_sha256)',
      );
    },
  },
  {
    // version 5 → 6:batches 物化 sampler_steps / sampler_cfg。
    // 统计页的 AVG(json_extract(doc_json,'$.samplers[0].steps')) 是全表
    // JSON1 扫描(better-sqlite3 同步调用,实测 0.4~0.9s 直接挂住事件循环);
    // 物化后退化为数值列聚合。存量行在同一迁移内一次性回填。
    // 全新库:基线 schema 已含两列,探测后跳过(回填也无行可更)。
    version: 6,
    up: (db) => {
      const batchCols = db
        .prepare('PRAGMA table_info(batches)')
        .all() as Array<{ name: string }>;
      if (!batchCols.some((c) => c.name === 'sampler_steps')) {
        db.exec('ALTER TABLE batches ADD COLUMN sampler_steps INTEGER');
        db.exec('ALTER TABLE batches ADD COLUMN sampler_cfg REAL');
      }
      // 只回填数值型来源:未解析的引用壳(对象/数组)留给 NULL,
      // 否则 json_extract 会把壳序列化成 JSON 文本污染数值列。
      db.exec(
        `UPDATE batches
            SET sampler_steps = CASE
                  WHEN json_type(doc_json, '$.samplers[0].steps') IN ('integer','real')
                  THEN json_extract(doc_json, '$.samplers[0].steps') END,
                sampler_cfg = CASE
                  WHEN json_type(doc_json, '$.samplers[0].cfg') IN ('integer','real')
                  THEN json_extract(doc_json, '$.samplers[0].cfg') END
          WHERE sampler_steps IS NULL AND sampler_cfg IS NULL`,
      );
    },
  },
];

/**
 * 轻量 schema 迁移:读取 user_version,顺序执行所有未应用的迁移。
 * 每个迁移与其 user_version 提升同事务(:memory: 与文件库走同一路径,
 * 行为一致);迁移失败时回滚,下次打开重试。
 *
 * 为什么 user_version 提升要放进迁移事务:
 * 若先执行 up 后事务外单独提升版本,up 成功后崩溃会留下
 * "结构已变但版本号未升",下次打开重跑 ALTER 直接报错;
 * 事务内"up + 升版本"要么都成功要么都回滚,保持结构↔版本强一致。
 */
function migrateSchema(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const migration of SCHEMA_MIGRATIONS) {
    if (migration.version <= current) continue;
    withTransaction(db, () => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
  }
}

/** 结构兜底结果:补了什么、降级了什么、哪些只能人工处理(供日志与运维工具消费) */
export interface SchemaExpandReport {
  columns: string[];
  indexes: string[];
  degraded: string[];
  manual: string[];
  failed: string[];
}

interface SchemaColumn {
  name: string;
  type: string;
  notnull: number;
  dflt: string | null;
  pk: number;
}

interface SchemaShape {
  columns: Record<string, SchemaColumn[]>;
  indexes: Array<{ name: string; tblName: string; sql: string }>;
}

/**
 * 目标结构模型(基线 + 全部迁移之后应有的形状)。
 *
 * 取自"空库跑一遍基线 + 迁移"的结果,而不是复制 schema 定义 —— 基线/迁移改到哪,
 * 目标结构就跟到哪,不存在"两处定义漂移"的可能(旧版本正是因基线里多写了一条引用
 * 迁移才补的列的索引,导致 user_version<=4 的库打不开)。
 *
 * 跳过 fts5 虚拟表及其阴影表(_data/_idx/_content/_docsize/_config):由 SQLite 自行
 * 维护,ALTER 无意义;阴影表列名也不属于主表语义。
 */
function desiredSchemaShape(db: Database.Database): SchemaShape {
  const rows = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string; sql: string | null }>;
  const virtualTables = rows
    .filter((r) => /^CREATE VIRTUAL TABLE/i.test(r.sql ?? ''))
    .map((r) => r.name);
  const isShadow = (name: string) => virtualTables.some((v) => name.startsWith(`${v}_`));
  const columns: Record<string, SchemaColumn[]> = {};
  for (const r of rows) {
    if (/^CREATE VIRTUAL TABLE/i.test(r.sql ?? '')) continue;
    if (isShadow(r.name)) continue;
    columns[r.name] = db
      .prepare(`PRAGMA table_info("${r.name}")`)
      .all() as SchemaColumn[];
  }
  const indexes = (
    db
      .prepare(
        `SELECT name, tbl_name AS tblName, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL`,
      )
      .all() as Array<{ name: string; tblName: string; sql: string }>
  ).filter((i) => columns[i.tblName]);
  return { columns, indexes };
}

/**
 * 结构兜底:把"目标结构里有、库里没有"的列与索引补齐。**只增不减**,绝不 DROP/改类型。
 *
 * 为什么需要(而不是全靠手写迁移):
 *   迁移是人工清单,漏写一条的后果过去是"旧库直接打不开"(基线索引引用未补的列)。
 *   有它兜底后,漏写的列/索引会被补上并打日志;语义型变更(表重建 / 数据回填 /
 *   类型与约束)仍必须手写迁移 —— ALTER ADD COLUMN 表达不了。
 *
 * 顺序:必须在 migrateSchema **之后**执行。探测型迁移(如 favorites 靠"没有 category 列"
 * 判定要重建为复合 PK)依赖看到旧库原样;先补列会让重建被静默跳过,复合键语义就丢了。
 * 索引一律在列补齐之后创建 —— 这天然消除了"CREATE INDEX 引用尚未补齐的列"那一类失败。
 *
 * 降级与边界:
 *   - 主键列无法 ALTER 补 → 记入 manual,不当成功
 *   - NOT NULL 且无默认值 → 降级为可空(NOT NULL 无默认值不允许加列),记入 degraded
 *   - 非常量默认值等 SQLite 拒绝的写法 → 记入 failed,不阻断启动
 */
function expandSchema(db: Database.Database, shape: SchemaShape): SchemaExpandReport {
  const report: SchemaExpandReport = {
    columns: [],
    indexes: [],
    degraded: [],
    manual: [],
    failed: [],
  };
  const tables = new Set(
    (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name),
  );
  for (const [table, cols] of Object.entries(shape.columns)) {
    if (!tables.has(table)) continue; // 缺表由基线 CREATE TABLE IF NOT EXISTS 负责
    const actual = new Set(
      (
        db.prepare(`PRAGMA table_info("${table}")`).all() as SchemaColumn[]
      ).map((c) => c.name),
    );
    for (const col of cols) {
      if (actual.has(col.name)) continue;
      if (col.pk) {
        report.manual.push(`${table}.${col.name}(主键列,需重建表)`);
        continue;
      }
      const hasDefault = col.dflt !== null && col.dflt !== undefined;
      const parts = [`ALTER TABLE "${table}" ADD COLUMN "${col.name}"`];
      if (col.type) parts.push(col.type);
      if (col.notnull && hasDefault) parts.push('NOT NULL');
      if (hasDefault) parts.push(`DEFAULT ${col.dflt}`);
      try {
        db.exec(parts.join(' '));
        report.columns.push(`${table}.${col.name}`);
        if (col.notnull && !hasDefault) {
          report.degraded.push(`${table}.${col.name}(NOT NULL 无默认值 → 降级为可空)`);
        }
      } catch (err) {
        report.failed.push(`${table}.${col.name}: ${(err as Error).message}`);
      }
    }
  }
  const actualIdx = new Set(
    (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name),
  );
  for (const idx of shape.indexes) {
    if (actualIdx.has(idx.name)) continue;
    try {
      db.exec(idx.sql);
      report.indexes.push(idx.name);
    } catch (err) {
      report.failed.push(`index ${idx.name}: ${(err as Error).message}`);
    }
  }
  return report;
}

/**
 * 原子执行一组写操作,性能与一致性都优于逐条 autocommit。
 *
 * @param db 目标连接
 * @param fn 需要原子执行的函数;fn 抛异常时整个事务回滚
 * @returns fn 的返回值
 *
 * 实现:better-sqlite3 的 db.transaction(fn) 生成同步事务包装,
 * fn 内所有写语句要么全部提交,要么全部回滚。
 * 本模块写原语(主表 + 子表 + FTS 多表联动)必须经它包裹,
 * 保证任何一步失败都不会留下半截数据。
 * 注意:它是同步 API,fn 内不能有 await(async 会逃逸事务边界)。
 */
export function withTransaction<T>(db: Database.Database, fn: () => T): T {
  const run = db.transaction(fn);
  return run();
}

/**
 * 备份到目标文件(better-sqlite3 backup API,替代 mongodump)。
 *
 * @param db 源连接(WAL 模式下备份为一致性快照,运行期可安全调用)
 * @param targetPath 备份文件路径
 * @returns 进度对象 { totalPages, remainingPages },轮询到
 *          remainingPages = 0 才算备份完成
 *
 * 边界:
 *   - 目标目录需已存在(backup API 不自动建目录)
 *   - 备份期间源库读写不阻塞;目标文件已存在会被覆盖
 *   - 返回值是 Promise 风格进度流,调用方需 await 到完成
 */
export function backupTo(
  db: Database.Database,
  targetPath: string,
): Promise<{ totalPages: number; remainingPages: number }> {
  return db.backup(targetPath);
}

/**
 * 完整性检查(PRAGMA quick_check),check 脚本与 health 用。
 *
 * @param db 目标连接
 * @returns { ok, message }:ok=true 表示结构/索引检查通过;
 *          message 为 quick_check 的结论文本或捕获到的异常消息
 *
 * 说明:
 *   - quick_check 只做关键结构检查(比 full_check 快得多),
 *     适合作为健康检查的高频探针,发现疑似损坏再上 full_check 或重建
 *   - 数据库损坏/IO 错误会让 prepare/get 抛异常,这里捕获后转为
 *     ok=false,避免 health 探针直接崩溃
 */
export function quickCheck(db: Database.Database): {
  ok: boolean;
  message: string;
} {
  try {
    const row = db.prepare('PRAGMA quick_check').get() as {
      quick_check: string;
    };
    return { ok: row.quick_check === 'ok', message: row.quick_check };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
