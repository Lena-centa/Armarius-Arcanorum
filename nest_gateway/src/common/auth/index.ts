/**
 * 鉴权模块的统一出口(barrel 文件)。
 * 被谁使用:各敏感端点 controller(import { RequireAuth } from common/auth)。
 */
export { AuthGuard, RequireAuth, AUTH_TOKEN_HEADER, AUTH_META_KEY } from './auth.guard';
