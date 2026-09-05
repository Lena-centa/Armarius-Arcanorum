/**
 * 配置模块的统一出口(barrel 文件)。
 *
 * 被谁使用:app.module.ts(ConfigModule 注册配置工厂)、main.ts(端口 /
 * 监听地址 / CORS)及各业务模块(engine / worker / scanRoot 等配置读取)。
 */
export { default as configuration } from './configuration';
export { REPO_ROOT } from './configuration';
export type { EngineState } from './configuration';
export {
  DATA_DIR_ENV_KEY,
  DB_FILENAME,
  DATA_DIR_NAME,
  normalizeConfiguredPath,
  resolveDataDir,
} from './data-dir';
