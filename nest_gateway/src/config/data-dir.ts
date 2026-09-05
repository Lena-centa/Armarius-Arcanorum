/**
 * 用户数据目录解析 —— 数据外置存储的单一事实来源。
 *
 * 背景:主库 gray_workflow.sqlite3 与 .env 一类用户数据原先默认落在
 * <repo>/data 与仓库根,"删旧目录换新目录"式更新会连同数据一起丢失。
 * 外置到代码树外的用户目录后,安装目录可随时整体替换,数据天然延续;
 * .env 也藏入其中,对用户默认不可见(缺失时由网关自动生成)。
 *
 * 解析优先级(TS / Python / bash / PowerShell 四处实现必须逐字段对齐,
 * 参见 docs/analysis/data-dir-externalization-feasibility.md §5.1):
 *   1. WORKFLOW_DATA_DIR 环境变量(绝对路径;win32 接受 /mnt/x/... 形式)
 *      注意:该变量只能来自进程环境,**不能写进 .env** —— .env 本身就
 *      存放在数据目录里,定位数据目录先于读取 .env(引导鸡生蛋约束)
 *   2. win32:%LOCALAPPDATA%\workflow_db
 *   3. 其余平台:$XDG_DATA_HOME/workflow_db(须绝对路径),
 *      回退 ~/.local/share/workflow_db
 */
import { homedir } from 'os';
import { isAbsolute, join } from 'path';

/** 数据目录覆盖变量的主键名与旧兼容键名(仅进程环境生效,禁止写入 .env)。 */
export const DATA_DIR_ENV_KEY = 'ARMARIUS_DATA_DIR';
export const LEGACY_DATA_DIR_ENV_KEY = 'WORKFLOW_DATA_DIR';

/** 数据目录名与旧兼容目录名(拼在平台基准目录之后)。 */
export const DATA_DIR_NAME = 'armarius_arcanorum';
export const LEGACY_DATA_DIR_NAME = 'workflow_db';

/** 主库文件名(数据目录内;configuration 默认值与迁移逻辑共用)。 */
export const DB_FILENAME = 'gray_workflow.sqlite3';

/**
 * 把配置值里的 WSL 路径归一化为 Windows 路径(仅 win32 生效)。
 * 场景:.env 按仓库约定书写 /mnt/c/... 形式,Windows 原生进程需转成
 * C:\... 才能被 fs 模块正确消费。非 /mnt/ 前缀的值原样返回。
 */
export function normalizeConfiguredPath(value: string): string {
  const trimmed = value.trim();
  if (process.platform !== 'win32') {
    return trimmed;
  }
  // 显式锚定 WSL 挂载前缀:^/mnt/<单字母盘符>/<其余>,不匹配即跳过
  const match = trimmed.match(/^\/mnt\/([A-Za-z])\/(.*)$/);
  if (!match) {
    return trimmed;
  }
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`;
}

/**
 * 解析用户数据目录绝对路径(不做存在性检查、不创建目录)。
 * 返回值在进程生命周期内稳定(环境变量启动后不变);调用方按需 mkdir。
 */
export function resolveDataDir(): string {
  const configured = normalizeConfiguredPath(
    process.env[DATA_DIR_ENV_KEY] ?? process.env[LEGACY_DATA_DIR_ENV_KEY] ?? '',
  );
  if (configured && isAbsolute(configured)) {
    return configured;
  }
  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
    return join(localAppData, DATA_DIR_NAME);
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg && isAbsolute(xdg)) {
    return join(xdg, DATA_DIR_NAME);
  }
  return join(homedir(), '.local', 'share', DATA_DIR_NAME);
}

/** 解析旧版用户数据目录绝对路径(供平滑迁移通道使用)。 */
export function resolveLegacyDataDir(): string {
  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
    return join(localAppData, LEGACY_DATA_DIR_NAME);
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg && isAbsolute(xdg)) {
    return join(xdg, LEGACY_DATA_DIR_NAME);
  }
  return join(homedir(), '.local', 'share', LEGACY_DATA_DIR_NAME);
}
