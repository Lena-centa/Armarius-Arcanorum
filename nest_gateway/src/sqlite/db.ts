/**
 * SQLite — 连接、初始化与维护。
 *
 * 原为灰测轨道基础设施,现升级为主用化后的核心数据层入口:
 * 打开(建 schema)/事务/备份/完整性检查,均在这里收敛。
 *
 * 数据流向:repo.ts(写路径)、reader.ts(读路径)与运维脚本
 * (sqlite-backfill.ts / sqlite-gray-compare.ts)都通过 openSqlite 取得连接;
 * 基线表结构来自 ./schema.ts(SCHEMA_SQL),本模块内维护版本化增量迁移
 * (SCHEMA_MIGRATIONS)。schema.ts 是"新库全量建表",迁移是"旧库补列",
 * 两者配合保证任意历史版本都能打开到当前结构。
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
 *   4. exec(SCHEMA_SQL):应用基线 schema(全部 CREATE TABLE IF NOT EXISTS,
 *      对新库幂等)
 *   5. migrateSchema:按 PRAGMA user_version 补齐增量迁移(旧库升级路径)
 *
 * 边界:重复调用对同一文件安全——迁移以 user_version 去重,天然幂等;
 * 返回的连接由调用方负责 close。
 */
export function openSqlite(dbPath: string): Database.Database {
  // 默认库位于 <repo_root>/data/ 下,父目录不存在时需先创建
  // (better-sqlite3 不会自动建目录;纯远程内存库跳过)
  if (dbPath && dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  migrateSchema(db);
  ensureFtsAligned(db);
  return db;
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
