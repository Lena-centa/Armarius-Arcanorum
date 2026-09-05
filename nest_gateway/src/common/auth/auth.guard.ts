/**
 * 网关敏感端点鉴权(守卫 + 装饰器)。
 *
 * 职责:对标记了 @RequireAuth() 的端点做访问控制,策略二选一:
 *   1. 配置了 WORKFLOW_DB_AUTH_TOKEN 时,校验 x-auth-token 请求头
 *      (恒定时间比较,防时序侧信道);
 *   2. 未配置 token 时,仅放行本机回环来源(127.0.0.1 / ::1)——远端访问
 *      (局域网 / 多网关)必须显式配置 token,否则拒绝。
 *
 * 被谁使用:settings / 数据管理等敏感端点(controller 层 @RequireAuth())。
 * 鉴权失败统一抛 UnauthorizedException(HTTP 401)。
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  applyDecorators,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

// x-auth-token 请求头名称(客户端须以此头携带 token)
export const AUTH_TOKEN_HEADER = 'x-auth-token';

/**
 * 网关敏感端点鉴权:
 * 1. 配置了 WORKFLOW_DB_AUTH_TOKEN 时,校验 x-auth-token 请求头(恒定时间比较);
 * 2. 未配置 token 时,仅允许本机回环来源(127.0.0.1 / ::1)访问 ——
 *    远端访问(局域网 / 多网关)必须显式配置 token。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  // 输入:HTTP 请求上下文;输出:是否放行(放行返回 true,拒绝抛 401)。
  // 逻辑:先看是否配置了 token——有 token 走恒定时间比较校验请求头;
  // 无 token 走回环来源白名单。
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = this.config.get<string>('authToken');
    if (token) {
      const provided = String(request.headers?.[AUTH_TOKEN_HEADER] ?? '');
      const buf = Buffer.from(provided);
      // 长度不同直接拒绝(恒定时间比较的前提是长度一致,避免泄露长度信息
      // 与不必要的比较开销);长度相同才做逐字节恒定时间比较
      if (buf.length === Buffer.byteLength(token) && timingSafeEqual(buf, Buffer.from(token))) {
        return true;
      }
      throw new UnauthorizedException('invalid or missing x-auth-token');
    }
    // 无 token 模式:取 socket 级对端地址,剥掉 IPv6 映射 IPv4 前缀
    // (::ffff:127.0.0.1 → 127.0.0.1),再与回环地址白名单比对
    const remote = String(
      request.socket?.remoteAddress ?? request.connection?.remoteAddress ?? '',
    ).replace(/^::ffff:/, '');
    if (remote === '127.0.0.1' || remote === '::1') {
      return true;
    }
    // 非回环来源且未配置 token:拒绝并提示配置方式
    throw new UnauthorizedException(
      'remote access denied: set ARMARIUS_AUTH_TOKEN (or WORKFLOW_DB_AUTH_TOKEN) to allow non-loopback clients',
    );
  }
}

/** 标记端点需要鉴权(与 AuthGuard 配套使用)。 */
export const AUTH_META_KEY = 'auth:required';

// 组合装饰器:在元数据中写入"需要鉴权"标记,并挂上 AuthGuard。
// 供 controller 以 @RequireAuth() 一键保护端点(可作用于类或方法)。
export function RequireAuth(): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(AUTH_META_KEY, true), UseGuards(AuthGuard));
}
