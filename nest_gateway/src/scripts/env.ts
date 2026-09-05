/**
 * Dev 脚本共用 .env 加载器。
 *
 * 运行时(gateway)通过 @nestjs/config 的 envFilePath 加载 .env;
 * 独立 dev 脚本(compare.ts 等)不经过 Nest 容器,在此手动注入,
 * 保证"环境统一存储在用户数据目录 .env"的约定对所有入口生效
 * (数据目录解析规则见 config/data-dir.ts;与网关冷迁移/生成逻辑一致)。
 *
 * 被调用方:
 *   - scripts/compare.ts / sqlite-backfill.ts / sqlite-gray-compare.ts
 *     均在最顶部调用 loadRepoEnv(),注入 COMFY_SCAN_ROOT、
 *     MONGODB_URI、SQLITE_DB_PATH 等路径与连接配置。
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  normalizeConfiguredPath,
  resolveDataDir,
} from '../config/data-dir';

/** 仓库根路径(本文件位于 <root>/nest_gateway/src/scripts/,上溯三级)。 */
export const SCRIPT_REPO_ROOT = resolve(__dirname, '..', '..', '..');

/**
 * 加载平台覆盖与数据目录 .env(不覆盖已有进程环境变量)。
 *
 * 加载顺序(后者不覆盖前者已设值):
 *   1. <dataDir>/.env.windows 或 .env.wsl(平台专属覆盖,优先)
 *   2. <dataDir>/.env(通用配置;缺失时静默跳过 —— 生成由网关启动负责)
 *
 * 解析规则:
 *   - 空行 / 注释(# 开头)/ 无等号行跳过
 *   - 首个 '=' 切分 key/value,两侧 trim,值剥掉成对引号
 *   - 已存在于 process.env 的键不覆盖(命令行/系统环境优先级更高)
 *
 * win32 额外处理:7 个路径类键做 /mnt/ → 盘符归一化;
 * WORKER_PYTHON_BIN 若指向 venv 的 python,优先重定向到
 * runtime/venv 或 venv 的 Scripts/python.exe(Windows 部署形态)。
 */
export function loadRepoEnv(): void {
  const dataDir = resolveDataDir();
  const platformFile =
    process.platform === 'win32' ? '.env.windows' : '.env.wsl';
  for (const envPath of [
    join(dataDir, platformFile),
    join(dataDir, '.env'),
  ]) {
    if (!existsSync(envPath)) continue;
    // 逐行手写解析而非 dotenv 包:零依赖、行为可预期
    for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) {
        continue;
      }
      const eq = line.indexOf('=');
      const key = line.slice(0, eq).trim();
      // 值剥掉成对单/双引号("foo" → foo),保留其余原样
      const value = line
        .slice(eq + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2');
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  }

  if (process.platform === 'win32') {
    // 路径类键的跨平台归一(仅 Windows 原生运行时需要)
    for (const key of [
      'COMFY_SCAN_ROOT',
      'COMFY_OUTPUT_DIR',
      'SQLITE_DB_PATH',
      'WORKFLOW_DB_BACKUP_DIR',
      'WORKFLOW_DB_ROOT',
      'WORKER_CWD',
      'WORKER_PYTHON_BIN',
    ]) {
      const value = process.env[key];
      if (!value) continue;
      const normalized = normalizeConfiguredPath(value);
      if (
        key === 'WORKER_PYTHON_BIN' &&
        // 命中仓库 venv 形态(venv/bin/python 或 venv/bin/python.exe)
        /[\\/]venv[\\/]bin[\\/]python(?:\.exe)?$/i.test(normalized)
      ) {
        // Windows 部署时 venv 实际位于 runtime/venv/Scripts(打包形态)
        // 或 venv/Scripts(开发形态),按存在性选择,都不在则退回原值
        const packaged = join(
          SCRIPT_REPO_ROOT,
          'runtime',
          'venv',
          'Scripts',
          'python.exe',
        );
        const local = join(SCRIPT_REPO_ROOT, 'venv', 'Scripts', 'python.exe');
        process.env[key] = existsSync(packaged)
          ? packaged
          : existsSync(local)
            ? local
            : normalized;
      } else {
        process.env[key] = normalized;
      }
    }
  }
}
