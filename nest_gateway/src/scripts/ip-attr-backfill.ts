/**
 * ip-attr-backfill — 存量数据的入库期 IP 归属回填。
 *
 * 背景:IP 归属注入(appendIpAttribution)在 parseImage 出口生效,只覆盖
 * 新入库的记录;存量 batches/stats_docs 的 search_text 缺少角色归属出的
 * IP 词,查询侧 expandIpChars(系列家族展开)对它们召回不全。本脚本对
 * 存量数据做一次与运行时完全同构的追加(appendIpAttribution 幂等:
 * 已在文本中的词不重复追加,重复执行结果不变)。
 *
 * 数据流向:
 *   batches / stats_docs 全表 → doc_json 反序列化 → appendIpAttribution
 *   (danbooru charIps/bareIps 查表)→ search_text 追加 IP 词
 *   → 主表 search_text + doc_json 更新 + FTS 行(rowid 对齐)先删后插
 *   → recipe_groups 全量重建(其 search_text 源自最新批次,随 batches
 *     更新自动带出,无需逐行 patch)。
 *
 * 用法:
 *   npx ts-node src/scripts/ip-attr-backfill.ts
 *     [--sqlite PATH] [--danbooru PATH] [--dry-run] [--limit N]
 *     [--recipes-only]
 *
 * --recipes-only:跳过两张主表,只做 recipe_groups 分片重建(主表回填
 * 中断后补跑用;主表追加幂等,但全表重扫耗时长)。
 *
 * 退出码:0 = 完成;1 = danbooru 库缺失或脚本错误。
 */

import { join } from 'path';
import type Database from 'better-sqlite3';
import { loadRepoEnv } from './env';
import { DB_FILENAME, resolveDataDir } from '../config/data-dir';
import { openSqlite, withTransaction } from '../sqlite/db';
import {
  appendIpAttribution,
  sharedDanbooru,
} from '../sqlite/danbooru';
import { rebuildRecipeGroupsSqlite } from '../lib/recipe_groups';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

loadRepoEnv();

const args = process.argv.slice(2);
const argValue = (key: string): string | undefined => {
  const i = args.indexOf(key);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const sqlitePath =
  argValue('--sqlite') ??
  process.env.SQLITE_DB_PATH ??
  join(resolveDataDir(), DB_FILENAME);
const danbooruPath =
  argValue('--danbooru') ?? process.env.DANBOORU_DB_PATH ?? '';
const dryRun = args.includes('--dry-run');
const limit = Number(argValue('--limit') ?? 0) || 0;
const recipesOnly = args.includes('--recipes-only');

interface Counters {
  scanned: number;
  updated: number;
  skipped: number;
}

/**
 * 单表回填:全表扫描 → appendIpAttribution → 主表 + FTS 更新。
 * @param table 主表名(batches / stats_docs);FTS 表(rowid 对齐键)由 table 派生
 */
function backfillTable(
  db: Database.Database,
  dan: Database.Database | null,
  table: 'batches' | 'stats_docs',
  counters: Counters,
): void {
  const fts = table === 'batches' ? 'fts_batches' : 'fts_stats_docs';
  const rows = db
    .prepare(
      `SELECT rowid AS rid, doc_json FROM ${table}${
        limit ? ` LIMIT ${Math.floor(limit)}` : ''
      }`,
    )
    .all() as Array<{ rid: number; doc_json: string }>;

  const updateMain =
    table === 'batches'
      ? db.prepare(
          'UPDATE batches SET search_text = ?, doc_json = ? WHERE rowid = ?',
        )
      : db.prepare(
          'UPDATE stats_docs SET search_text = ?, doc_json = ? WHERE rowid = ?',
        );
  const ftsDelete = db.prepare(`DELETE FROM ${fts} WHERE rowid = ?`);
  const ftsInsert = db.prepare(
    `INSERT INTO ${fts}(rowid, search_text) VALUES (?, ?)`,
  );

  withTransaction(db, () => {
    for (const row of rows) {
      counters.scanned += 1;
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(row.doc_json) as Record<string, unknown>;
      } catch {
        counters.skipped += 1; // 坏 JSON → 不动,保持原样
        continue;
      }
      let next: string | null;
      try {
        next = appendIpAttribution(
          dan,
          doc.prompts as { positive?: unknown; search_text?: unknown },
        );
      } catch {
        counters.skipped += 1; // 归属异常(索引未就绪等)→ 不动
        continue;
      }
      if (next === null) {
        continue; // 无正向/无新词/已注入 → 幂等跳过
      }
      (doc.prompts as { search_text?: unknown }).search_text = next;
      const docJson = JSON.stringify(doc);
      if (!dryRun) {
        updateMain.run(next, docJson, row.rid);
        // FTS 行对齐:与 repo.ts 写路径同款先删后插(rowid 不变)
        ftsDelete.run(row.rid);
        if (next) ftsInsert.run(row.rid, next);
      }
      counters.updated += 1;
    }
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = Date.now();
  const dan = sharedDanbooru(danbooruPath);
  if (!dan) {
    console.error(`danbooru db not available: ${danbooruPath || '(default)'}`);
    process.exit(1);
  }
  console.log(`danbooru: open + index warmup ${Date.now() - t0}ms`);

  const db = openSqlite(sqlitePath);
  console.log(
    `${dryRun ? '[dry-run] ' : ''}sqlite: ${sqlitePath} (batches=${
      (db.prepare('SELECT COUNT(*) c FROM batches').get() as { c: number }).c
    }, stats_docs=${
      (db.prepare('SELECT COUNT(*) c FROM stats_docs').get() as { c: number }).c
    })`,
  );

  if (!recipesOnly) {
    // batches:检索主路径(/api/images、/api/image-refs 走 fts_batches)
    const t1 = Date.now();
    const batchCounters: Counters = { scanned: 0, updated: 0, skipped: 0 };
    backfillTable(db, dan, 'batches', batchCounters);
    console.log(
      `batches: scanned=${batchCounters.scanned} updated=${batchCounters.updated} skipped=${batchCounters.skipped} (${Date.now() - t1}ms)`,
    );

    // stats_docs:统计页 q 搜索路径(search_text LIKE)
    const t2 = Date.now();
    const statsCounters: Counters = { scanned: 0, updated: 0, skipped: 0 };
    backfillTable(db, dan, 'stats_docs', statsCounters);
    console.log(
      `stats_docs: scanned=${statsCounters.scanned} updated=${statsCounters.updated} skipped=${statsCounters.skipped} (${Date.now() - t2}ms)`,
    );
  }

  // recipe_groups:search_text 源自各组最新批次 → 重建带出。分片进行:
  // 全量一次性重建需把所有批次 doc_json 载入内存(实测 >4GB 堆 OOM),
  // 按 recipe_key 分片逐组重建语义等价(局部重建 = DELETE 目标 key +
  // INSERT 分组产物,FTS 每片尾部整表重对齐)。
  // 跳过 limit 采样模式:重建会覆盖非采样范围外的组。
  if (!limit) {
    const t3 = Date.now();
    const keys = (
      db
        .prepare(
          `SELECT DISTINCT recipe_key FROM batches
           WHERE recipe_key IS NOT NULL AND recipe_key != ''`,
        )
        .all() as Array<{ recipe_key: string }>
    ).map((r) => r.recipe_key);
    const CHUNK = 300;
    let groups = 0;
    for (let i = 0; i < keys.length; i += CHUNK) {
      if (!dryRun) {
        const res = rebuildRecipeGroupsSqlite(db, keys.slice(i, i + CHUNK));
        groups += res.updated;
      }
    }
    console.log(
      `recipe_groups: ${dryRun ? '[dry-run] rebuild skipped' : `rebuilt keys=${keys.length} groups=${groups}`} (${Date.now() - t3}ms)`,
    );
  }

  db.close();
  console.log(`total: ${Date.now() - t0}ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
