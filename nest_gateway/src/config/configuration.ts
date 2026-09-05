/**
 * 网关环境配置工厂。
 *
 * 职责:聚合 .env / 环境变量与仓库布局,输出统一的运行配置对象,
 * 供 ConfigModule(ConfigService) 点路径读取(如 'mongo.uri' / 'port')。
 *
 * 被谁使用:app.module.ts 注册(configuration)、auth.guard.ts(鉴权 token)、
 * 各业务模块(engine / instance / scanRoot / worker 等)与 main.ts(bindHost)。
 *
 * 关键约定:
 *   - 跨平台兼容:WSL 生成的 /mnt/<drive>/... 路径在 Windows 原生进程下
 *     自动转换为 <drive>:\...;python 解释器优先 Windows venv
 *   - 部署根目录解析:WORKFLOW_DB_ROOT 环境变量优先,否则按目录标志文件
 *     上溯定位(布局约定:nest_gateway/ 与 workflow_db/ 同根)
 *   - 数据引擎三态:sqlite / mongo / remote-pending(见 EngineState)
 */
import { existsSync } from 'fs';
import { hostname } from 'os';
import { isAbsolute, join } from 'path';
import {
  DB_FILENAME,
  normalizeConfiguredPath,
  resolveDataDir,
} from './data-dir';

// 部署根目录解析(优先级):
//   1. WORKFLOW_DB_ROOT 环境变量(独立仓库 / Windows / Docker 部署显式指定)
//   2. 从 __dirname 上溯查找工作区标志文件(workflow_db/__init__.py)
// 布局约定:nest_gateway/{src,dist} 与 workflow_db/ 位于同一部署根目录下。
// 输入:无(依赖环境变量与目录布局);输出:部署根目录绝对路径。
// 边界:WORKFLOW_DB_ROOT 非绝对路径时视为无效继续上溯;上溯最多 8 层,
// 找不到标志文件则回退旧约定路径(兼容 monorepo 原位运行)。
function resolveRepoRoot(): string {
  const env = normalizeConfiguredPath(process.env.ARMARIUS_ROOT ?? process.env.WORKFLOW_DB_ROOT ?? '');
  if (env && isAbsolute(env)) {
    return env;
  }
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, '..');
    if (existsSync(join(candidate, 'workflow_db', '__init__.py'))) {
      return candidate;
    }
    if (candidate === dir) {
      break;
    }
    dir = candidate;
  }
  // 回退:仍按旧约定(ts-jest/dist 两层级)推算,兼容 monorepo 原位运行。
  return join(__dirname, '..', '..', '..');
}

// 输入:部署根目录;输出:可执行的 python 解释器绝对路径。
// 逻辑:WORKER_PYTHON_BIN 配置优先;win32 下若指向 WSL venv 的
// bin/python(Windows 不可直接执行),优先切到发布包 runtime/venv,
// 再回退本地 venv;未配置时按平台枚举候选,返回第一个存在的候选,
// 全部缺失则返回首选候选(由调用方在 spawn 失败时兜底报错)。
function resolvePythonBin(repoRoot: string): string {
  if (process.env.WORKER_PYTHON_BIN?.trim()) {
    const configured = normalizeConfiguredPath(process.env.WORKER_PYTHON_BIN);
    // WSL venv 的 bin/python 不能被 Windows 直接执行。优先切到发布包
    // 的 Windows venv,再回退到本地 Windows venv。
    if (
      process.platform === 'win32' &&
      /[\\/]venv[\\/]bin[\\/]python(?:\.exe)?$/i.test(configured)
    ) {
      const packaged = join(
        repoRoot,
        'runtime',
        'venv',
        'Scripts',
        'python.exe',
      );
      const local = join(repoRoot, 'venv', 'Scripts', 'python.exe');
      if (existsSync(packaged)) return packaged;
      if (existsSync(local)) return local;
    }
    return configured;
  }
  const candidates =
    process.platform === 'win32'
      ? [
          join(repoRoot, 'runtime', 'venv', 'Scripts', 'python.exe'),
          join(repoRoot, 'venv', 'Scripts', 'python.exe'),
        ]
      : [
          join(repoRoot, 'runtime', 'venv', 'bin', 'python'),
          join(repoRoot, 'venv', 'bin', 'python'),
        ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

// 部署根目录:模块加载时解析一次,全进程共享(供 env 文件定位 / sqlite 路径等)
export const REPO_ROOT = resolveRepoRoot();

// 数据引擎状态机:
//   sqlite          SQLite 单引擎(未配置 MONGODB_URI 且未开远程开关)
//   mongo           已配置 MONGODB_URI(写路径落 Mongo,可双写 SQLite)
//   remote-pending  纯远程开关开启但尚未配置 MONGODB_URI(首次启动无库)
export type EngineState = 'sqlite' | 'mongo' | 'remote-pending';

// 统一配置工厂:由 ConfigModule.load([configuration]) 注册调用,
// 输出整个网关的运行配置对象;ConfigService 以点路径读取
// (如 'mongo.uri' / 'worker.pythonBin'),未命中时返回 undefined。
export default () => {
  const mongoUri = (process.env.MONGODB_URI ?? '').trim();
  // 纯远程开关:不建本地 SQLite、不扫描本地目录,仅连接远端 MongoDB。
  // 初次启动时可处于"无库"状态(MONGODB_URI 未配置 → remote-pending)。
  const remoteMode = (process.env.ARMARIUS_REMOTE ?? process.env.WORKFLOW_DB_REMOTE ?? '0') === '1';
  const engine: EngineState = mongoUri
    ? 'mongo'
    : remoteMode
      ? 'remote-pending'
      : 'sqlite';
  return {
    // 显式暴露部署根目录,让状态 API/测试不依赖模块级常量的宿主工作区状态。
    repoRoot: REPO_ROOT,
    port: parseInt(process.env.ARMARIUS_PORT ?? process.env.NEST_GATEWAY_PORT ?? '8009', 10),
    // 监听地址:默认仅回环;多网关/局域网访问需显式 WORKFLOW_DB_BIND_HOST=0.0.0.0
    // 并配合 WORKFLOW_DB_AUTH_TOKEN 鉴权。
    bindHost: (process.env.ARMARIUS_BIND_HOST ?? process.env.WORKFLOW_DB_BIND_HOST ?? '').trim() || '127.0.0.1',
    // 鉴权 token:未设置时仅回环来源可访问敏感端点(见 common/auth/auth.guard.ts)
    authToken: (process.env.ARMARIUS_AUTH_TOKEN ?? process.env.WORKFLOW_DB_AUTH_TOKEN ?? '').trim(),
    // CORS 来源白名单(逗号分隔);未设置时仅放行同源与 file://(origin=null)
    corsOrigin: (process.env.CORS_ORIGIN ?? '').trim(),
    mongo: {
      // 留空 = 未配置 MongoDB(默认 SQLite 单引擎);由设置页"检测连接并切换"写入
      uri: mongoUri,
      db: process.env.MONGODB_DB ?? 'comfy_workflow_archive',
      collection: process.env.MONGODB_COLLECTION ?? 'images',
      recipeGroupsCollection:
        process.env.MONGODB_RECIPE_GROUPS_COLLECTION ?? 'recipe_groups',
      statsDocCacheCollection:
        process.env.MONGODB_STATS_DOC_CACHE_COLLECTION ?? 'stats_docs',
      statsSummaryCacheCollection:
        process.env.MONGODB_STATS_SUMMARY_CACHE_COLLECTION ?? 'stats_summaries',
    },
    // 数据引擎状态:sqlite(SQLite 单引擎) | mongo(已配 MONGODB_URI) |
    // remote-pending(纯远程开关开启但尚未配置 MONGODB_URI,首次启动无库)
    engine,
    // 用户数据目录(env/主库/备份的外置存放点;解析规则见 config/data-dir.ts)
    dataDir: resolveDataDir(),
    // 多网关共享库:本实例身份标识。入库时逐图片打标 source{instance_id,base_url},
    // 供"远端网关目录透传"定位图片持有者。
    instance: {
      id:
        (process.env.ARMARIUS_INSTANCE_ID ?? process.env.WORKFLOW_DB_INSTANCE_ID ?? '').trim() ||
        hostname() ||
        'default',
      // 对外可达地址(纯远程透传目标);留空 = 该实例不参与透传
      baseUrl: (process.env.ARMARIUS_BASE_URL ?? process.env.WORKFLOW_DB_BASE_URL ?? '').trim(),
    },
    remoteProxy: {
      // 默认仅允许 DNS 解析为公网地址。局域网网关必须精确列入白名单;
      // 不支持通配符,避免数据库记录把网关变成任意内网 SSRF 跳板。
      allowedHosts: (process.env.ARMARIUS_PROXY_ALLOW_HOSTS ?? process.env.WORKFLOW_DB_PROXY_ALLOW_HOSTS ?? '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    },
    // 图片扫描根目录由用户提供(Windows: D:\erxx;WSL/Docker: 挂载路径)。
    // 为空表示未配置,启动时校验并告警,同步/解析端点降级。
    scanRoot: normalizeConfiguredPath(process.env.COMFY_SCAN_ROOT ?? ''),
    // ComfyUI 服务地址(网关主动查询 /history 的近实时通道使用)
    comfyuiBaseUrl: process.env.COMFYUI_BASE_URL ?? 'http://127.0.0.1:8188',
    // 传统同步周期(秒):扫描扫描根目录 / 增量入库的节流间隔
    syncIntervalSeconds: parseInt(
      process.env.ARMARIUS_SYNC_INTERVAL_SECONDS ?? process.env.WORKFLOW_DB_SYNC_INTERVAL_SECONDS ?? '300',
      10,
    ),
    // 近实时通道(内存缓冲 + 批量 diff 写入):
    // - comfyPollSeconds:轮询 ComfyUI /history 的间隔(0 关闭)
    // - flushSeconds:缓冲批量入库的间隔
    // - comfyOutputDir:ComfyUI 输出目录(可选,优先于 scanRoot 候选)
    // - fsWatchEnabled:Windows 原生下启用递归 fs.watch(非 win32 自动降级)
    comfyPollSeconds: parseInt(
      process.env.ARMARIUS_COMFY_POLL_SECONDS ?? process.env.WORKFLOW_DB_COMFY_POLL_SECONDS ?? '3',
      10,
    ),
    flushSeconds: parseInt(process.env.ARMARIUS_FLUSH_SECONDS ?? process.env.WORKFLOW_DB_FLUSH_SECONDS ?? '15', 10),
    comfyOutputDir: normalizeConfiguredPath(process.env.COMFY_OUTPUT_DIR ?? ''),
    fsWatchEnabled: (process.env.ARMARIUS_FS_WATCH ?? process.env.WORKFLOW_DB_FS_WATCH ?? '1') !== '0',
    // 备份目录由用户提供;为空时备份循环整体停用。
    backupDir: normalizeConfiguredPath(
      process.env.ARMARIUS_BACKUP_DIR ?? process.env.WORKFLOW_DB_BACKUP_DIR ?? '',
    ),
    // 首次启动是否执行全量同步(默认开启;多次重启可关闭以缩短启动时间)
    initialSync: (process.env.ARMARIUS_INITIAL_SYNC ?? process.env.WORKFLOW_DB_INITIAL_SYNC ?? '1') !== '0',
    // ---------- SQLite(主用化过渡) ----------
    // 双写过渡期与 Mongo 并存;阶段 5 后为唯一数据源。
    sqlite: {
      // 主库路径;留空默认 <用户数据目录>/gray_workflow.sqlite3
      // (win32 %LOCALAPPDATA%\workflow_db,其余 ~/.local/share/workflow_db;
      // 数据外置代码树,更新/重装不丢。冷迁移见 bootstrap/data-dir-migration.ts)
      // 纯远程模式不落任何本地文件(内存库占位,consumer 零改动)
      dbPath: remoteMode
        ? ':memory:'
        : normalizeConfiguredPath(process.env.SQLITE_DB_PATH ?? '') ||
          join(resolveDataDir(), DB_FILENAME),
      // 双写开关:写路径同时落 Mongo 与 SQLite(阶段 1 起);纯远程模式关闭
      dualWrite: !remoteMode && (process.env.SQLITE_DUAL_WRITE ?? '0') === '1',
      // 读切换开关:读路径走 SQLite(阶段 4 切读)。
      // 未配置 MONGODB_URI 时自动启用(单引擎默认);纯远程模式不回退 SQLite
      readMode:
        (process.env.SQLITE_READ ?? '0') === '1' || (!mongoUri && !remoteMode),
    },
    worker: {
      // parse_worker is spawned as `python -m workflow_db.parse_worker`
      // with cwd = repo root (so the inner workflow_db package resolves).
      pythonBin: resolvePythonBin(REPO_ROOT),
      // 空串必须回退(?? 对空字符串不生效,曾导致 fresh 部署 worker cwd 错误)
      cwd: normalizeConfiguredPath(process.env.WORKER_CWD ?? '') || REPO_ROOT,
      spawnTimeoutMs: parseInt(
        process.env.WORKER_SPAWN_TIMEOUT_MS ?? '10000',
        10,
      ),
      maxRestarts: parseInt(process.env.WORKER_MAX_RESTARTS ?? '3', 10),
    },
    // ---------- Danbooru tag 补全参考(可选,默认按资产存在与否自动降级) ----------
    // 两条能力线:联想 / 单 tag 索引(wiki 特征 + 分类推荐)走 SQLite 查表
    // (DANBOORU_DB_PATH),入库预计算组推荐走 worker GNN 资产(DANBOORU_ASSETS);
    // NL 整句语义搜索已移除(性价比不足,语义查询由 tag_alias 多语言别名层兜底)。
    tagSuggest: {
      enabled: (process.env.TAG_SUGGEST_ENABLED ?? '1') !== '0',
      assetsDir: normalizeConfiguredPath(process.env.DANBOORU_ASSETS ?? ''),
      // 空串时自动探测 <repo_root>/danbooru/danbooru.sqlite3(存在才启用)
      dbPath: normalizeConfiguredPath(process.env.DANBOORU_DB_PATH ?? ''),
    },
  };
};
