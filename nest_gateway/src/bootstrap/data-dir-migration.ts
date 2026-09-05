/**
 * 旧仓库数据 → 用户数据目录的一次性冷迁移(通道 A)+ .env 自动生成。
 *
 * 在 Nest 应用创建之前执行(main.ts bootstrap 最早期)。此时 ConfigModule
 * 尚未加载 .env —— 生效路径识别必须直接解析旧 env 文件,不能依赖
 * process.env 里已有业务配置(OS 显式注入的环境变量仍最优先)。
 *
 * 迁移规则(docs/analysis/data-dir-externalization-feasibility.md §5.5):
 *   - 触发条件:新数据目录无主库 && 旧 <repo>/data 有主库 &&
 *     有效主库路径等于旧默认位(未配置 / 配置为空 / 显式写的正是旧默认位)
 *   - 有效路径指向其他自定义位置时跳过搬库(尊重显式意图),
 *     但 env 文件仍复制到数据目录(目标缺失时),保证配置延续
 *   - 原子性:先复制 → 字节数比对 + quick_check 校验 → 全部通过后才把
 *     旧文件改名 *.migrated;中途失败删除新位残留,本次回退用旧库启动
 *   - 并发:数据目录内 O_EXCL 锁文件防双实例同启抢搬
 *   - 逃生开关:WORKFLOW_DB_AUTO_MIGRATE=0 整体停用
 *   - 降级保护:迁移完成后在旧 data/ 留 README 说明数据去向
 *     (旧版代码回滚时会因找不到库而重建空库,README 防误判丢数据)
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { REPO_ROOT } from '../config';
import {
  DB_FILENAME,
  normalizeConfiguredPath,
  resolveDataDir,
  resolveLegacyDataDir,
} from '../config/data-dir';

/** 平台覆盖 env 文件名(win32 → .env.windows,其余 → .env.wsl)。 */
function platformEnvFileName(): string {
  return process.platform === 'win32' ? '.env.windows' : '.env.wsl';
}

export interface MigrationResult {
  status: 'migrated' | 'skipped' | 'failed';
  reason: string;
}

// ---------------------------------------------------------------------------
// .env 自动生成与键清理
// ---------------------------------------------------------------------------

/**
 * 确保 <dataDir>/.env 存在:缺失时从仓库 .env.example 模板生成。
 * 已有(含由冷迁移从旧仓库复制而来)则原样保留,绝不覆盖。
 */
export function ensureEnvFile(repoRoot: string = REPO_ROOT): void {
  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  const envPath = join(dataDir, '.env');
  if (existsSync(envPath)) {
    return;
  }
  const templatePath = join(repoRoot, '.env.example');
  const template = existsSync(templatePath)
    ? readFileSync(templatePath, 'utf8')
    : '';
  const header =
    '# 本文件由网关自动生成,存放于用户数据目录(代码树外),更新/重装不丢失。\n' +
    '# 日常修改请使用设置页(语义化字段);直接编辑本文件后重启网关亦可。\n\n';
  writeFileSync(envPath, header + template, 'utf8');
}

/**
 * 删除 env 文件中生效的 SQLITE_DB_PATH= 赋值行(替换为一行说明注释)。
 * 场景:主库迁入数据目录后,若复制的 .env 仍显式指向旧路径,下次启动会
 * 在旧路径自动重建空库造成"界面清空"假象 —— 必须随迁移一并清除。
 * 原子写入(tmp + rename);空值行(SQLITE_DB_PATH=)同样清除保持整洁。
 * @returns 是否实际修改了文件
 */
export function stripSqliteDbPathKey(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false;
  }
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const kept: string[] = [];
  let removed = false;
  for (const line of lines) {
    if (/^\s*SQLITE_DB_PATH\s*=/.test(line)) {
      removed = true;
      continue;
    }
    kept.push(line);
  }
  if (!removed) {
    return false;
  }
  kept.push('# SQLITE_DB_PATH 已随数据目录迁移移除:主库现位于数据目录默认位置');
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, kept.join('\n'), 'utf8');
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    unlinkSync(tmpPath);
    throw err;
  }
  return true;
}

/**
 * 把旧仓库根的 env 三件套(.env / .env.windows / .env.wsl)复制到数据目录。
 * 仅在"来源存在 && 目标缺失"时逐件复制,绝不覆盖既有文件;
 * stripDbPath 为 true 时对每份副本执行 SQLITE_DB_PATH 键清除。
 * @returns 实际复制的文件名列表
 */
export function copyLegacyEnvFiles(
  repoRoot: string,
  dataDir: string,
  opts: { stripDbPath?: boolean } = {},
): string[] {
  const copied: string[] = [];
  for (const name of ['.env', '.env.windows', '.env.wsl']) {
    const src = join(repoRoot, name);
    const dst = join(dataDir, name);
    if (!existsSync(src) || existsSync(dst)) {
      continue;
    }
    copyFileSync(src, dst);
    copied.push(name);
    if (opts.stripDbPath) {
      stripSqliteDbPathKey(dst);
    }
  }
  return copied;
}

// ---------------------------------------------------------------------------
// 生效路径识别(冷启动态:.env 未加载,须自行解析文件)
// ---------------------------------------------------------------------------

/** 解析单个 env 文件中生效的 KEY=VALUE(忽略注释/空行;引号剥除)。 */
function readEnvFileValues(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(filePath)) {
    return values;
  }
  for (const raw of readFileSync(filePath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      '"\''.includes(value[0])
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      values[key] = value;
    }
  }
  return values;
}

/**
 * 冷启动态的显式主库路径解析(优先级与运行期一致):
 * 进程环境变量 → 数据目录平台覆盖文件 → 数据目录 .env
 * (数据目录文件由本模块先行复制自旧仓库,内容等价;若尚未复制则
 * 回退读旧仓库根同名文件)。返回归一化后的路径,未配置返回空串。
 */
export function resolveExplicitSqlitePath(
  repoRoot: string,
  dataDir: string,
): string {
  const fromOs = normalizeConfiguredPath(process.env.SQLITE_DB_PATH ?? '');
  if (fromOs) {
    return fromOs;
  }
  const platformName = platformEnvFileName();
  for (const filePath of [
    join(dataDir, platformName),
    join(dataDir, '.env'),
    join(repoRoot, platformName),
    join(repoRoot, '.env'),
  ]) {
    const value = normalizeConfiguredPath(
      readEnvFileValues(filePath).SQLITE_DB_PATH ?? '',
    );
    if (value) {
      return value;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// 通道 A:冷迁移主流程
// ---------------------------------------------------------------------------

/** 大库阈值:超过则校验降级为 quick_check(1)(仅采样顶层页面,秒级)。 */
const QUICK_CHECK_SIZE_LIMIT = 1e9;

/** 对复制产物做完整性校验:打开 → quick_check → WAL 折叠进主文件。 */
function verifyCopiedDatabase(targetDb: string): void {
  const db = new Database(targetDb);
  try {
    const big =
      Number(db.pragma('page_count', { simple: true })) *
        Number(db.pragma('page_size', { simple: true })) >
      QUICK_CHECK_SIZE_LIMIT;
    const result = db.pragma(big ? 'quick_check(1)' : 'quick_check', {
      simple: true,
    });
    if (result !== 'ok') {
      throw new Error(`quick_check failed: ${result}`);
    }
    // WAL 折叠:让主库文件自包含,后续拷贝/备份不再依赖 -wal 伴生
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

/**
 * 执行旧仓库 → 用户数据目录的一次性迁移(env 三件套 + 主库三件套)。
 * 幂等:任何前置条件不满足即 skipped,重复调用无副作用。
 * 失败兜底:把本进程 SQLITE_DB_PATH 指回旧库继续启动(数据零风险),
 * 下次重启自动重试;绝不带着失败的新位空库上线。
 */
/**
 * 用户数据目录平滑更名迁移:从旧 workflow_db 迁移到 armarius_arcanorum。
 * 仅在未显式指定 ARMARIUS_DATA_DIR / WORKFLOW_DATA_DIR 环境变量且新目录无库时触发。
 */
export function migrateUserDataDir(): MigrationResult {
  const autoMigrate = (process.env.ARMARIUS_AUTO_MIGRATE ?? process.env.WORKFLOW_DB_AUTO_MIGRATE ?? '').trim();
  if (autoMigrate === '0') {
    return { status: 'skipped', reason: 'AUTO_MIGRATE=0' };
  }
  if ((process.env.ARMARIUS_DATA_DIR ?? process.env.WORKFLOW_DATA_DIR ?? '').trim()) {
    return { status: 'skipped', reason: 'custom data dir configured' };
  }
  const targetDataDir = resolveDataDir();
  const legacyDataDir = resolveLegacyDataDir();
  if (targetDataDir === legacyDataDir || !existsSync(legacyDataDir)) {
    return { status: 'skipped', reason: 'no legacy user data dir' };
  }
  const targetDb = join(targetDataDir, DB_FILENAME);
  const legacyDb = join(legacyDataDir, DB_FILENAME);
  if (existsSync(targetDb) || !existsSync(legacyDb)) {
    return { status: 'skipped', reason: existsSync(targetDb) ? 'target db present' : 'no legacy user db' };
  }

  try {
    mkdirSync(targetDataDir, { recursive: true });
    // 复制 .env
    const legacyEnv = join(legacyDataDir, '.env');
    const targetEnv = join(targetDataDir, '.env');
    if (existsSync(legacyEnv) && !existsSync(targetEnv)) {
      copyFileSync(legacyEnv, targetEnv);
    }
    // 复制主库及伴生文件
    const sidecars = ['-wal', '-shm'];
    copyFileSync(legacyDb, targetDb);
    for (const s of sidecars) {
      if (existsSync(legacyDb + s)) {
        copyFileSync(legacyDb + s, targetDb + s);
      }
    }
    verifyCopiedDatabase(targetDb);
    // 成功后旧文件重命名为 *.migrated
    renameSync(legacyDb, legacyDb + '.migrated');
    for (const s of sidecars) {
      if (existsSync(legacyDb + s)) {
        renameSync(legacyDb + s, legacyDb + s + '.migrated');
      }
    }
    writeFileSync(
      join(legacyDataDir, 'README-migrated.txt'),
      `用户数据目录已更名并迁移至:\n  ${targetDataDir}\n原数据文件已备份为 *.migrated。\n`,
      'utf8',
    );
    return { status: 'migrated', reason: `migrated from ${legacyDataDir} to ${targetDataDir}` };
  } catch (err) {
    return { status: 'failed', reason: String(err) };
  }
}

export function runLegacyDataMigration(repoRoot: string = REPO_ROOT): MigrationResult {
  const autoMigrate = (process.env.ARMARIUS_AUTO_MIGRATE ?? process.env.WORKFLOW_DB_AUTO_MIGRATE ?? '').trim();
  if (autoMigrate === '0') {
    return { status: 'skipped', reason: 'AUTO_MIGRATE=0' };
  }
  const remoteMode = (process.env.ARMARIUS_REMOTE ?? process.env.WORKFLOW_DB_REMOTE ?? '0') === '1';
  if (remoteMode) {
    return { status: 'skipped', reason: 'remote mode keeps no local db' };
  }
  const dataDir = resolveDataDir();
  const legacyDataDir = join(repoRoot, 'data');
  const legacyDb = join(legacyDataDir, DB_FILENAME);
  const targetDb = join(dataDir, DB_FILENAME);

  if (dataDir === legacyDataDir) {
    return { status: 'skipped', reason: 'data dir equals legacy location' };
  }

  mkdirSync(dataDir, { recursive: true });

  // 有效路径识别(在复制前先算好是否需要清键;复制本身无条件执行——
  // 即使是自定义库路径的用户,配置延续到新目录也总是正确行为)
  const explicit = resolveExplicitSqlitePath(repoRoot, dataDir);
  const samePath = (a: string, b: string) =>
    a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');
  const pointsAtDefault =
    !explicit ||
    samePath(explicit, legacyDb) ||
    samePath(explicit, targetDb);
  const copiedEnv = copyLegacyEnvFiles(repoRoot, dataDir, {
    stripDbPath: pointsAtDefault,
  });

  // 主库缺前提:旧位无库或新位已有库(含已迁移过),均无事可做
  if (!existsSync(legacyDb)) {
    return {
      status: 'skipped',
      reason: copiedEnv.length
        ? `no legacy db; env copied: ${copiedEnv.join(',')}`
        : 'no legacy db',
    };
  }
  if (existsSync(targetDb)) {
    return { status: 'skipped', reason: 'target db already present' };
  }
  if (!pointsAtDefault) {
    return {
      status: 'skipped',
      reason: `explicit SQLITE_DB_PATH points elsewhere (${explicit}); respecting custom location`,
    };
  }

  // 并发锁:双实例同启时只允许一个执行搬迁
  const lockPath = join(dataDir, '.migration.lock');
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, 'wx');
  } catch {
    return { status: 'skipped', reason: 'another migration in progress' };
  }

  const sidecars = ['-wal', '-shm'];
  const copiedTargets: string[] = [];
  try {
    copyFileSync(legacyDb, targetDb);
    copiedTargets.push(targetDb);
    for (const suffix of sidecars) {
      const src = legacyDb + suffix;
      if (existsSync(src)) {
        const dst = targetDb + suffix;
        copyFileSync(src, dst);
        copiedTargets.push(dst);
      }
    }
    // 字节数比对(逐文件):字节级确认复制完整,再进语义校验
    for (const target of copiedTargets) {
      const src = target === targetDb ? legacyDb : legacyDb + target.slice(targetDb.length);
      if (statSync(src).size !== statSync(target).size) {
        throw new Error(`size mismatch after copy: ${target}`);
      }
    }
    verifyCopiedDatabase(targetDb);

    // 全部通过才动旧位:改名 *.migrated 保留回滚能力(不做自动删除)
    renameSync(legacyDb, legacyDb + '.migrated');
    for (const suffix of sidecars) {
      const src = legacyDb + suffix;
      if (existsSync(src)) {
        renameSync(src, src + '.migrated');
      }
    }
    // 降级保护 README:旧版代码回滚后会在此重建空库,防止误判丢数据
    writeFileSync(
      join(legacyDataDir, 'README-migrated.txt'),
      [
        `主库已迁移至用户数据目录(${new Date().toISOString().slice(0, 10)}):`,
        `  ${targetDb}`,
        '',
        '原 gray_workflow.sqlite3(-wal/-shm)已改名为 *.migrated 保留在此,',
        '确认新版运行正常后可整目录删除;回滚旧版代码前请先阅读',
        'docs/analysis/data-dir-externalization-feasibility.md §5.5。',
      ].join('\n'),
      'utf8',
    );
    return {
      status: 'migrated',
      reason:
        `db moved to ${targetDb}` +
        (copiedEnv.length ? `; env copied: ${copiedEnv.join(',')}` : ''),
    };
  } catch (err) {
    // 失败清理新位残留,并把本进程指回旧库(本次启动继续用旧数据)
    for (const target of copiedTargets) {
      try {
        unlinkSync(target);
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    process.env.SQLITE_DB_PATH = legacyDb;
    return { status: 'failed', reason: `${message}; fell back to legacy db` };
  } finally {
    try {
      closeSync(lockFd);
      unlinkSync(lockPath);
    } catch {
      /* 锁清理失败不影响结果(残留锁会被下一次 wx 失败暴露) */
    }
  }
}
