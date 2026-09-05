import type { Response } from 'express';
import { lookup } from 'dns/promises';
import { request as httpRequest, type IncomingMessage } from 'http';
import { request as httpsRequest } from 'https';
import ipaddr from 'ipaddr.js';

/**
 * 远端图片透传(多网关共享库 + 独立远端图片库)。
 *
 * 多网关共享库场景:本网关可能不持有某图片的本地文件(图片在各网关各自的
 * 扫描根目录)。按 image entry 的 source.base_url 代理到持有网关的
 * /api/image/:sha256 或 /api/thumb/:sha256,浏览器经任一网关都可预览。
 * 独立图片库则使用 source.protocol=wfdb-image-library-v1 + asset_id,
 * 转发到 /v1/assets/:asset_id(/thumbnail)。
 *
 * 安全/防环:
 *   - 只信任记录中 http(s) 的 base_url
 *   - 默认拒绝非公网地址;私网只允许管理员精确白名单
 *   - DNS 全量校验后固定连接 IP,拒绝重定向,防 rebinding/元数据探测
 *   - 不自代理(与自身 instance.base_url 同源时拒绝)
 *   - 外发请求带 x-wfdb-passthrough 头,对端仅本地命中才返回,拒绝嵌套代理
 *
 * 数据流:images.controller / parse.controller 在本地文件缺失时,
 * 从 image entry 取 source.base_url 调 passthroughTarget 校验 → 通过后
 * proxyToPeer 流式回传对端网关的同路径响应 → 浏览器直接消费。
 * spec 层(images.controller.spec)直接 mock proxyToPeer 做控制器测试。
 */
const PASSTHROUGH_HEADER = 'x-wfdb-passthrough';
const PASSTHROUGH_TIMEOUT_MS = 20_000;
const PASSTHROUGH_MAX_BYTES = 100 * 1024 * 1024;

export interface ProxyPolicy {
  /** 精确主机/IP 白名单。命中项可解析到私网;不支持通配符。 */
  allowedHosts?: readonly string[];
  /** 单次代理响应上限;缺省 100 MiB。 */
  maxBytes?: number;
}

function bareHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function isExplicitlyAllowed(url: URL, policy: ProxyPolicy): boolean {
  const hostname = bareHostname(url.hostname);
  const host = url.port ? `${hostname}:${url.port}` : hostname;
  return (policy.allowedHosts ?? []).some((raw) => {
    const value = raw.trim().toLowerCase();
    if (!value || value.includes('*')) return false;
    if (value.includes('://')) {
      try {
        const allowed = new URL(value);
        return (
          bareHostname(allowed.hostname) === hostname &&
          (!allowed.port || allowed.port === url.port)
        );
      } catch {
        return false;
      }
    }
    return (
      value === hostname || value === host || value === url.host.toLowerCase()
    );
  });
}

/** 仅全局单播地址可默认访问;映射 IPv4 先还原后再判断。 */
export function isPublicProxyAddress(address: string): boolean {
  try {
    return ipaddr.process(address.split('%', 1)[0]).range() === 'unicast';
  } catch {
    return false;
  }
}

async function resolvePinnedAddress(
  target: URL,
  policy: ProxyPolicy,
): Promise<{ address: string; family: 4 | 6 }> {
  const hostname = bareHostname(target.hostname);
  const explicitlyAllowed = isExplicitlyAllowed(target, policy);
  if (ipaddr.isValid(hostname)) {
    if (!explicitlyAllowed && !isPublicProxyAddress(hostname)) {
      throw new Error('proxy target is not a public address');
    }
    return {
      address: hostname,
      family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6,
    };
  }

  const answers = await lookup(hostname, { all: true, verbatim: true });
  if (!answers.length) throw new Error('proxy target has no DNS address');
  // 任一解析结果落入私网就整体拒绝,防 round-robin 混入内网与 DNS rebinding。
  if (
    !explicitlyAllowed &&
    answers.some((answer) => !isPublicProxyAddress(answer.address))
  ) {
    throw new Error('proxy target resolves to a non-public address');
  }
  const selected = answers[0];
  return { address: selected.address, family: selected.family as 4 | 6 };
}

/** 当前支持的远端资产协议。缺省值为历史网关透传协议。 */
export const GATEWAY_ASSET_PROTOCOL = 'wfdb-gateway-v1' as const;
export const REMOTE_LIBRARY_ASSET_PROTOCOL = 'wfdb-image-library-v1' as const;

export type AssetProtocol =
  | typeof GATEWAY_ASSET_PROTOCOL
  | typeof REMOTE_LIBRARY_ASSET_PROTOCOL;

export interface RemoteImageSource {
  instance_id?: string;
  base_url?: string;
  protocol?: AssetProtocol | string;
  asset_id?: string;
}

export interface RemoteImageEntry {
  source?: RemoteImageSource | null;
}

/**
 * 从 image entry 提取透传目标 origin(非法/自引用返回 null)。
 *
 * @param entry        image entry(取 source.base_url)
 * @param selfBaseUrl  本网关的 instance.base_url(防自代理)
 * @returns 校验通过的 origin(如 https://gw2.example.com);null 表示不代理
 *
 * 校验逻辑(按序短路):
 *   1. base_url 空 → null
 *   2. URL 解析失败(非法地址)→ null
 *   3. 协议非 http/https → null(拒绝 file:/ftp: 等危险协议)
 *   4. 与 selfBaseUrl 同 origin → null(自代理无意义且造成回环)
 *      —— selfBaseUrl 自身非法时忽略该检查,按"无自引用"放行
 *
 * 边界:只返回 origin(协议+host+port),路径/查询一律不带——
 * 对端路径由调用方按同路径拼接,防止把记录里的意外路径带过去。
 */
export function passthroughTarget(
  entry: RemoteImageEntry | undefined,
  selfBaseUrl: string,
  policy: ProxyPolicy = {},
): string | null {
  const url = (entry?.source?.base_url ?? '').trim();
  if (!url) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  const hostname = bareHostname(parsed.hostname);
  if (
    (hostname === 'localhost' || hostname.endsWith('.localhost')) &&
    !isExplicitlyAllowed(parsed, policy)
  ) {
    return null;
  }
  if (
    ipaddr.isValid(hostname) &&
    !isPublicProxyAddress(hostname) &&
    !isExplicitlyAllowed(parsed, policy)
  ) {
    return null;
  }
  const self = selfBaseUrl.trim();
  if (self) {
    try {
      if (new URL(self).origin === parsed.origin) {
        return null;
      }
    } catch {
      // 自身 base_url 非法时忽略,按无自引用处理
    }
  }
  return parsed.origin;
}

/**
 * 根据 image entry 的 source 协议构建对端资源路径。
 *
 * - source.protocol 缺失 / wfdb-gateway-v1:兼容现有 WorkflowDB 网关
 * - wfdb-image-library-v1:访问独立图片库的 asset 端点
 * - 未知协议或远端图片库缺 asset_id:返回 null,不发出请求
 *
 * asset_id 始终作为单个 URL segment 编码,不能注入路径或查询串。
 */
export function passthroughPath(
  entry: RemoteImageEntry | undefined,
  sha256: string,
  variant: 'original' | 'thumbnail',
  size?: { w?: string; h?: string },
): string | null {
  const protocol = entry?.source?.protocol?.trim() || GATEWAY_ASSET_PROTOCOL;
  let path: string;
  if (protocol === REMOTE_LIBRARY_ASSET_PROTOCOL) {
    const assetId = entry?.source?.asset_id?.trim();
    if (!assetId) return null;
    path = `/v1/assets/${encodeURIComponent(assetId)}`;
    if (variant === 'thumbnail') path += '/thumbnail';
  } else if (protocol === GATEWAY_ASSET_PROTOCOL) {
    path =
      variant === 'thumbnail'
        ? `/api/thumb/${encodeURIComponent(sha256)}`
        : `/api/image/${encodeURIComponent(sha256)}`;
  } else {
    return null;
  }

  if (variant === 'thumbnail') {
    const query = [
      size?.w ? `w=${encodeURIComponent(size.w)}` : '',
      size?.h ? `h=${encodeURIComponent(size.h)}` : '',
    ]
      .filter(Boolean)
      .join('&');
    if (query) path += `?${query}`;
  }
  return path;
}

/**
 * 判断请求是否来自网关透传(用于拒绝嵌套代理)。
 *
 * @param headers 请求头(Express 的 headers 形态:值可为 string 或 string[])
 * @returns 头部 x-wfdb-passthrough === '1' 即 true
 *
 * 设计:对端网关收到带此头的请求时只做"本地文件命中"直接返回,
 * 不再向第三方转发——链路最多两跳,杜绝网关间相互代理放大。
 */
export function isPassthroughRequest(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const value = headers[PASSTHROUGH_HEADER];
  return Array.isArray(value) ? value.includes('1') : value === '1';
}

/**
 * 流式代理到对端网关同路径。成功写出响应返回 true;
 * 对端 4xx/5xx、网络失败或超时返回 false(由调用方转 404/502)。
 *
 * @param origin 对端 origin(passthroughTarget 校验通过的)
 * @param path   同路径请求串(如 /api/image/abc123)
 * @param res    Express 响应对象(本函数直接写出)
 * @returns true=已完整写出响应;false=失败(响应未写出或已销毁)
 *
 * 内部逻辑:
 *   1. 解析全部 DNS 地址并应用公网/白名单策略,连接固定到已校验 IP
 *   2. 原生 HTTP(S) GET,20s 超时且不跟随重定向
 *   3. 非 2xx / 空 body / 非图片 / 超过体积上限 → false
 *   4. 请求头带 x-wfdb-passthrough:1,并透传安全的媒体/缓存响应头
 *   5. 逐 chunk 流式写回(res.write),读尽后 res.end()
 *   6. 异常处理:若已发出响应头(headersSent)则必须销毁 socket——
 *      此时调用方再抛 HttpException 会触发 headers-sent 错误,
 *      只能直接断开连接终止半截响应
 *
 * 边界:成功后调用方不得再写响应;失败且 headersSent=false 时
 * 调用方可正常抛 HttpException(404/502)。
 */
export async function proxyToPeer(
  origin: string,
  path: string,
  res: Response,
  policy: ProxyPolicy = {},
): Promise<boolean> {
  try {
    const base = new URL(origin);
    if (
      (base.protocol !== 'http:' && base.protocol !== 'https:') ||
      base.username ||
      base.password ||
      !path.startsWith('/') ||
      path.startsWith('//') ||
      /[\r\n]/.test(path)
    ) {
      return false;
    }
    const target = new URL(path, base);
    if (target.origin !== base.origin) return false;

    // DNS 只解析一次,并通过自定义 lookup 把 socket 固定到已校验 IP;
    // 不使用 fetch 的自动重定向/DNS 二次解析,避免重定向和 rebinding 绕过。
    const pinned = await resolvePinnedAddress(target, policy);
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = request(
        {
          protocol: target.protocol,
          hostname: bareHostname(target.hostname),
          port: target.port || undefined,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: {
            Host: target.host,
            [PASSTHROUGH_HEADER]: '1',
          },
          lookup: (_hostname, _options, callback) =>
            callback(null, pinned.address, pinned.family),
        },
        resolve,
      );
      outgoing.setTimeout(PASSTHROUGH_TIMEOUT_MS, () =>
        outgoing.destroy(new Error('proxy timeout')),
      );
      outgoing.once('error', reject);
      outgoing.end();
    });
    const status = response.statusCode ?? 0;
    // 3xx 不跟随:Location 可能跳往云元数据/内网地址。
    if (status < 200 || status >= 300) {
      response.resume();
      return false;
    }
    const contentTypeValue = response.headers['content-type'];
    const contentType = Array.isArray(contentTypeValue)
      ? contentTypeValue[0]
      : contentTypeValue;
    if (
      !contentType ||
      (!/^image\//i.test(contentType) &&
        !/^application\/octet-stream(?:;|$)/i.test(contentType))
    ) {
      response.resume();
      return false;
    }
    const maxBytes = Math.max(1, policy.maxBytes ?? PASSTHROUGH_MAX_BYTES);
    const declaredLength = Number(response.headers['content-length'] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      response.resume();
      return false;
    }
    // 透传对端的媒体类型与缓存头,浏览器端行为与直连持有网关一致
    const cacheValue = response.headers['cache-control'];
    const cacheControl = Array.isArray(cacheValue) ? cacheValue[0] : cacheValue;
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }
    if (cacheControl) {
      res.setHeader('Cache-Control', cacheControl);
    }
    // 流式转发:对端 body 逐 chunk 写回,大图不占整块内存
    let received = 0;
    for await (const value of response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      received += chunk.length;
      if (received > maxBytes) {
        response.destroy(new Error('proxy response too large'));
        throw new Error('proxy response too large');
      }
      res.write(chunk);
    }
    if (received === 0) return false;
    res.end();
    return true;
  } catch {
    // 失败时若已发出响应头(部分内容已写入),不能由调用方再抛 HttpException
    // (会触发 headers-sent 错误),直接销毁 socket 结束连接
    if (res.headersSent && !res.destroyed) {
      res.destroy();
    }
    return false;
  }
}
