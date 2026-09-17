#!/usr/bin/env node
/**
 * 主库迁移/扩充 —— 运维前端工具(独立运行,供升级前预演与盘点)
 *
 * 迁移与扩充的**逻辑不在本文件**:它们已内置在 gateway 的 openSqlite 里
 * (基线建表 → 版本化迁移 → 结构兜底 expandSchema),发布包同样带着 —— 这才是"保底"。
 * 本工具只做运维侧三件事,因此永远不会与产品逻辑漂移:
 *   1. 版本识别:对比"库 user_version vs 当前版本",不一致即提示需要语义迁移
 *   2. 安全默认:改库前做一致性备份(含 WAL);--check 在**副本**上真跑一遍,原库只读
 *   3. 可见性:打印内置兜底具体补了什么(列/索引/降级/需人工/失败)与逐表行数变化
 *      —— 兜底把"漏写迁移"从崩溃变成了日志,这行日志必须有人看得见
 *
 * 用法
 *   node tools/migrate_workflow_db.cjs [DB_PATH] [--check] [--no-backup] [--json]
 *     DB_PATH     缺省 = gateway 解析出的数据目录主库(%LOCALAPPDATA%\armarius_arcanorum\gray_workflow.sqlite3)
 *     --check     在副本上预演(真跑一遍 openSqlite 后报结果);原库只读不改,可反复跑
 *     --no-backup 跳过备份(仅在已自行备份时使用)
 *     --json      以 JSON 输出结果(便于脚本消费)
 *   退出码:0 = 成功;1 = 参数/环境错误;2 = 有失败项或版本异常
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_DB = path.join(REPO_ROOT, 'nest_gateway', 'dist', 'sqlite', 'db.js');
const DIST_DATA_DIR = path.join(REPO_ROOT, 'nest_gateway', 'dist', 'config', 'data-dir.js');
const BETTER_SQLITE3 = path.join(REPO_ROOT, 'nest_gateway', 'node_modules', 'better-sqlite3');

/** 报告中逐表对比行数的表:用户数据(批注/收藏)+ 主数据 + 迁移会补出来的表 */
const WATCH_TABLES = [
  'batches',
  'batch_images',
  'recipe_groups',
  'favorites',
  'favorite_categories',
  'manual_lora_prompt_labels',
  'manual_label_categories',
  'prompt_annotations',
];

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));

function bail(code, message) {
  console.error(`[migrate] ${message}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// gateway 构建产物:当前版本与 openSqlite(内置迁移 + 结构兜底)的唯一来源
// ---------------------------------------------------------------------------
function loadGateway() {
  if (!fs.existsSync(DIST_DB) || !fs.existsSync(DIST_DATA_DIR)) {
    bail(
      1,
      `缺少 gateway 构建产物(${path.relative(REPO_ROOT, DIST_DB)}):先执行 \`cd nest_gateway && npm run build\``,
    );
  }
  const mod = require(DIST_DB);
  if (typeof mod.openSqlite !== 'function') {
    bail(1, 'dist/sqlite/db.js 未导出 openSqlite —— 构建产物与工具不匹配,请重新构建');
  }
  return { openSqlite: mod.openSqlite, dataDir: require(DIST_DATA_DIR) };
}

function defaultDbPath(dataDirMod) {
  const dir = dataDirMod.resolveDataDir();
  return path.join(dir, dataDirMod.DB_FILENAME);
}

/** 打开库并取回内置结构兜底的结果 + 打开后的版本(这是唯一会改库的调用) */
function openWithReport(gw, dbPath) {
  let report = { columns: [], indexes: [], degraded: [], manual: [], failed: [] };
  const db = gw.openSqlite(dbPath, {
    onSchemaExpand: (r) => {
      report = r;
    },
  });
  const version = db.pragma('user_version', { simple: true });
  db.close();
  return { report, version };
}

// ---------------------------------------------------------------------------
// 只读侧:行数快照 / 一致性快照
// ---------------------------------------------------------------------------
function readSnapshot(dbPath) {
  const Database = require(BETTER_SQLITE3);
  const db = new Database(dbPath, { readonly: true });
  const version = db.pragma('user_version', { simple: true });
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
  );
  const rows = {};
  for (const t of WATCH_TABLES) {
    rows[t] = tables.has(t) ? db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c : null;
  }
  db.close();
  return { version, rows };
}

/** better-sqlite3 一致性快照(含 WAL)→ 目标文件;源库只读打开 */
function copyTo(dbPath, target) {
  const Database = require(BETTER_SQLITE3);
  const src = new Database(dbPath, { readonly: true });
  return src
    .backup(target)
    .then(() => {
      src.close();
      return target;
    })
    .catch((err) => {
      src.close();
      throw err;
    });
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
}

function removeWithSidecars(filePath) {
  for (const sidecar of ['', '-wal', '-shm']) {
    if (fs.existsSync(filePath + sidecar)) fs.rmSync(filePath + sidecar);
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
function fmtRows(before, after) {
  // 逐表全列:老库缺的表要显式写成"表不存在" —— 它正是迁移/扩充要建出来的东西
  return WATCH_TABLES.map((t) => {
    const b = before[t] === null ? '表不存在' : String(before[t]);
    if (!after) return `  ${t.padEnd(28)} ${b}`;
    const a = after[t] === null ? '表不存在' : String(after[t]);
    const mark = after[t] !== null && before[t] !== after[t] ? '  ← 变化' : '';
    return `  ${t.padEnd(28)} ${b.padStart(8)} → ${a.padStart(8)}${mark}`;
  });
}

function printExpand(report) {
  const touched = report.columns.length + report.indexes.length;
  const noisy = report.degraded.length + report.manual.length + report.failed.length;
  if (!touched && !noisy) {
    console.log('[migrate] 结构兜底:无缺口(未补任何列/索引)');
    return;
  }
  console.log(
    `[migrate] 结构兜底:补列 ${report.columns.length} 个、补索引 ${report.indexes.length} 个` +
      (report.degraded.length ? `,降级 ${report.degraded.length}` : '') +
      (report.manual.length ? `,需人工 ${report.manual.length}` : '') +
      (report.failed.length ? `,失败 ${report.failed.length}` : ''),
  );
  for (const c of report.columns) console.log(`    + 列 ${c}`);
  for (const i of report.indexes) console.log(`    + 索引 ${i}`);
  for (const d of report.degraded) console.log(`    ! 降级 ${d}`);
  for (const m of report.manual) console.log(`    ! 需人工 ${m}`);
  for (const f of report.failed) console.log(`    ✗ 失败 ${f}`);
}

async function main() {
  const gw = loadGateway();
  const dbPath = path.resolve(positional[0] || defaultDbPath(gw.dataDir));
  if (!fs.existsSync(dbPath)) bail(1, `主库不存在:${dbPath}`);
  const check = flags.has('--check');

  // 当前版本:空库跑一遍基线 + 迁移(内存库跳过兜底,不会递归)
  const probe = gw.openSqlite(':memory:');
  const expected = probe.pragma('user_version', { simple: true });
  probe.close();

  const before = readSnapshot(dbPath);
  const versionDiffers = before.version !== expected;
  const result = {
    dbPath,
    versionBefore: before.version,
    versionExpected: expected,
    versionDiffers,
    rowsBefore: before.rows,
    checkOnly: check,
    backedUpTo: null,
    versionAfter: null,
    rowsAfter: null,
    expand: null,
    ok: true,
  };

  console.log(`[migrate] 主库: ${dbPath}`);
  console.log(
    `[migrate] 版本: 库=${before.version}  当前=${expected}` +
      (versionDiffers ? '  ← 不一致,将执行语义迁移' : '  (一致)'),
  );
  console.log('[migrate] 行数(前):');
  for (const line of fmtRows(before.rows, null)) console.log(line);

  if (check) {
    // 副本上真跑:与真实执行走同一条代码路径,报出的数字是实测而非估算
    const previewPath = `${dbPath}.preview-${stamp()}`;
    await copyTo(dbPath, previewPath);
    const preview = openWithReport(gw, previewPath);
    const after = readSnapshot(previewPath);
    removeWithSidecars(previewPath);
    console.log(
      `[migrate] 预演(副本上真跑,临时文件已删):user_version ${before.version} → ${preview.version}`,
    );
    printExpand(preview.report);
    console.log('[migrate] 行数(预演后):');
    for (const line of fmtRows(before.rows, after.rows)) console.log(line);
    console.log('[migrate] --check:原库未被改动(上面的预演全程只碰副本)。');
    Object.assign(result, {
      versionAfter: preview.version,
      rowsAfter: after.rows,
      expand: preview.report,
      ok: preview.report.failed.length === 0,
    });
    if (flags.has('--json')) console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 2);
  }

  if (!flags.has('--no-backup')) {
    const target = await copyTo(dbPath, `${dbPath}.pre-migrate-${stamp()}`);
    result.backedUpTo = target;
    console.log(`[migrate] 已备份: ${target}`);
  } else {
    console.log('[migrate] --no-backup:跳过备份');
  }

  // 内置逻辑:① 语义迁移(基线 + 版本化迁移)② 结构兜底(补列/补索引),一次打开里完成
  const migrated = openWithReport(gw, dbPath);
  const after = readSnapshot(dbPath);
  console.log(
    `[migrate] 已执行内置迁移/兜底:user_version ${before.version} → ${migrated.version}`,
  );
  printExpand(migrated.report);
  console.log('[migrate] 行数(后):');
  for (const line of fmtRows(before.rows, after.rows)) console.log(line);

  result.versionAfter = migrated.version;
  result.rowsAfter = after.rows;
  result.expand = migrated.report;
  result.ok = migrated.report.failed.length === 0 && migrated.version === expected;
  console.log(
    result.ok
      ? `[migrate] 完成:结构已达当前版本(v${expected}),用户数据见上表逐表对比。`
      : '[migrate] 完成但存在失败项或版本异常,见上方标记行。',
  );
  if (flags.has('--json')) console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(`[migrate] 异常: ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
