/**
 * comfy-proxy —— 生成页内嵌 ComfyUI 的同源反向代理核心(comfy-proxy.ts)。
 *
 * 职责:为 `/comfy/*` 前缀代理提供零依赖实现(node:http / net / tls):
 *   - parseUpstream:解析 COMFYUI_BASE_URL 为上游连接参数(仅取 origin)
 *   - stripComfyPrefix / isSafeProxyPath:前缀剥离与路径守卫(穿越/控制字符)
 *   - forwardHttp:HTTP 请求的双向流式转发(请求体/响应体均不整块落内存)
 *   - attachComfyWsBridge / bridgeComfyWs:WebSocket 升级请求的字节级双向 pipe
 *
 * 设计依据:
 *   - 必须剥掉 Origin/Referer/Sec-Fetch-*:上游 origin_only_middleware 对
 *     cross-site 语义请求返回 403;服务端转发不带这些头,实测 200
 *   - Host 重写为上游 authority;hop-by-hop 头由转发两端自行管理
 *   - WS 桥不解析帧:重放升级请求头后纯字节 pipe,免依赖且不受帧大小影响;
 *     上游 4xx/5xx(含拒绝升级的响应)原样流回客户端
 */
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import type { Server, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { Request, Response } from 'express';

/** 上游连接参数(仅 origin;ComfyUI 不支持子路径部署)。 */
export interface ComfyUpstream {
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
  /** 发往上游的 Host 头(authority 形式,含非默认端口)。 */
  host: string;
}

/** 解析上游地址;仅接受 http/https 绝对地址,非法时抛错(调用方决定降级方式)。 */
export function parseUpstream(baseUrl: string): ComfyUpstream {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported protocol: ${parsed.protocol}`);
  }
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port),
    host: parsed.host,
  };
}

/** 剥离 /comfy 前缀;非本代理路径返回 null。保留后续路径与查询串。 */
export function stripComfyPrefix(url: string): string | null {
  if (url === '/comfy' || url === '/comfy/') return '/';
  if (url.startsWith('/comfy/')) return url.slice('/comfy'.length);
  return null;
}

// 控制字符集合(0x00-0x1F 与 DEL):路径中一律拒绝(风格同 parse.controller)
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * 路径守卫:拒畸形百分号编码、NUL/控制字符、反斜杠、解码后为 `..` 的段。
 * 只约束路径部分(不含查询串);上游主机固定,风险是穿越上游路由而非 SSRF。
 */
export function isSafeProxyPath(pathPart: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return false;
  }
  if (decoded.includes('\0') || CONTROL_RE.test(decoded)) return false;
  if (decoded.includes('\\')) return false;
  return !decoded.split('/').some((segment) => segment === '..');
}

/**
 * 不透传给上游的请求头,三类:
 *   - hop-by-hop(由转发两端自行管理,含分帧)
 *   - 会触发上游跨站防护 / 泄漏网关语义的浏览器头(Origin/Referer/Sec-Fetch-*)
 *   - Host(单列:重写为上游 authority)
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-user',
  'sec-fetch-dest',
  'sec-fetch-storage-access',
]);

/** 不透传给客户端的响应头(hop-by-hop;Transfer-Encoding 由 node 重新分帧)。 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'te',
  'trailer',
  'upgrade',
  'transfer-encoding',
]);

/** 上游空闲超时(空闲语义而非总时长):覆盖 3MB 级 object_info 与 32MB 上传。 */
const UPSTREAM_TIMEOUT_MS = 60_000;

/**
 * HTTP 请求的双向流式转发:请求体 pipe 进上游,上游响应逐 chunk 回写。
 * 上游**已响应**的 4xx/5xx 原样透传(状态码+错误体均不吞);只有连接级失败
 * (如 ComfyUI 未启动)才由本层造 502。
 *
 * body:调用方传入时直接作为请求体(而非 pipe 客户端流)。原因:Nest 全局
 * body-parser 会把 JSON/urlencoded 请求体消费掉,此时客户端流已空,必须用
 * rawBody(main.ts 开启 rawBody: true)原样重建;multipart/二进制体解析器
 * 不碰,rawBody 缺失,继续走流式 pipe。
 */
export function forwardHttp(
  upstream: ComfyUpstream,
  req: Request,
  res: Response,
  targetPath: string,
  body?: Buffer,
): void {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  headers.host = upstream.host;

  const transport = upstream.protocol === 'https:' ? https : http;
  const upReq = transport.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: targetPath,
      headers,
    },
    (upRes) => {
      res.statusCode = upRes.statusCode ?? 502;
      for (const [key, value] of Object.entries(upRes.headers)) {
        if (value === undefined) continue;
        if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
        res.setHeader(key, value);
      }
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    },
  );
  upReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    upReq.destroy(new Error(`upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`));
  });
  upReq.on('error', (err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(502);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({ error: 'comfyui upstream unreachable', detail: String(err) }),
    );
  });
  if (body !== undefined) {
    // 请求体由本层给出(回填改写后):分帧长度必须按新体重算,
    // 保留客户端原 Content-Length 会造成上游按旧长度截断/挂起
    headers['content-length'] = String(body.length);
    upReq.end(body);
    return;
  }
  // 客户端中途断开(关页/取消)时同步断开上游,防半截连接泄漏
  req.on('error', () => upReq.destroy());
  req.on('close', () => {
    if (!upReq.writableEnded) upReq.destroy();
  });
  req.pipe(upReq);
}

/** forwardHttpBuffered 的结果:整段响应(供调用方解析后再决定如何回写)。 */
export interface BufferedUpstreamResponse {
  status: number;
  headers: Record<string, string | string[]>;
  payload: Buffer;
}

/**
 * 缓冲式转发:与 forwardHttp 同一套头过滤/重写,但响应整段收集后交还调用方
 * 而非直接回写。专用于 POST /comfy/prompt——代理需要从上游响应里取出
 * prompt_id 登记素材捕获,然后把响应原样交回前端(prompt 响应是排队回执的
 * 小 JSON,整段缓冲无内存顾虑;大响应一律走 forwardHttp 流式路径)。
 */
export function forwardHttpBuffered(
  upstream: ComfyUpstream,
  req: Request,
  targetPath: string,
  body?: Buffer,
): Promise<BufferedUpstreamResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers.host = upstream.host;
    if (body !== undefined) {
      headers['content-length'] = String(body.length);
    }

    const transport = upstream.protocol === 'https:' ? https : http;
    const upReq = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: targetPath,
        headers,
      },
      (upRes) => {
        const chunks: Buffer[] = [];
        upRes.on('data', (chunk) => chunks.push(chunk));
        upRes.on('end', () => {
          const cleanHeaders: Record<string, string | string[]> = {};
          for (const [key, value] of Object.entries(upRes.headers)) {
            if (value === undefined) continue;
            if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
            cleanHeaders[key] = value;
          }
          resolve({
            status: upRes.statusCode ?? 502,
            headers: cleanHeaders,
            payload: Buffer.concat(chunks),
          });
        });
        upRes.on('error', reject);
      },
    );
    upReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upReq.destroy(new Error(`upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`));
    });
    upReq.on('error', reject);
    if (body !== undefined) {
      upReq.end(body);
    } else {
      req.pipe(upReq);
    }
  });
}

/**
 * 按原始头序重放升级请求:保留 Sec-WebSocket-*(握手完整性依赖原文),
 * 剥 Host/Origin/Referer/Sec-Fetch-* 与分帧头,Connection/Upgrade 由本层
 * 显式重发(它们在剥离集合内,但升级语义必需)。
 */
function buildWsReplayRequest(
  req: IncomingMessage,
  upstream: ComfyUpstream,
  targetPath: string,
): string {
  const lines: string[] = [`GET ${targetPath} HTTP/1.1`, `Host: ${upstream.host}`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const lower = name.toLowerCase();
    if (lower === 'host') continue;
    if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
    lines.push(`${name}: ${req.rawHeaders[i + 1] ?? ''}`);
  }
  lines.push('Connection: Upgrade', 'Upgrade: websocket');
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * 单条 WS 升级的字节桥:建到上游的原始 TCP/TLS 连接,重放升级请求头 +
 * 早到数据,然后双向 pipe(不解析 WS 帧)。上游拒绝升级的响应也原样流回。
 */
export function bridgeComfyWs(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  upstream: ComfyUpstream,
): void {
  const target = stripComfyPrefix(req.url ?? '');
  const pathPart = target ? target.split('?')[0] : '';
  if (!target || !isSafeProxyPath(pathPart)) {
    socket.destroy();
    return;
  }
  // 先暂停客户端 socket:升级头之后的早到帧在 pipe 挂上前不能丢
  socket.pause();
  const upstreamSocket: Duplex =
    upstream.protocol === 'https:'
      ? tls.connect({
          host: upstream.hostname,
          port: upstream.port,
          servername: upstream.hostname,
        })
      : net.connect({ host: upstream.hostname, port: upstream.port });
  // 半关闭同步:任一侧出错/关闭即毁掉另一侧(WS 无半关闭语义),防连接泄漏
  const kill = () => {
    socket.destroy();
    upstreamSocket.destroy();
  };
  socket.on('error', kill);
  upstreamSocket.on('error', kill);
  socket.on('close', kill);
  upstreamSocket.on('close', kill);
  // TCP 就绪(net)或 TLS 握手完成(tls)后再发升级请求;管道随后建立
  upstreamSocket.on(
    upstream.protocol === 'https:' ? 'secureConnect' : 'connect',
    () => {
      upstreamSocket.write(buildWsReplayRequest(req, upstream, target));
      if (head.length > 0) upstreamSocket.write(head);
      socket.pipe(upstreamSocket);
      socket.resume();
    },
  );
  // 上游响应(101 或拒绝)无需解析,直接流回客户端
  upstreamSocket.pipe(socket);
}

/**
 * 在网关 HTTP server 上挂载 WS 升级分流:`/comfy` 前缀走上游桥,其余升级
 * 一律销毁(网关当前无其他 WS 用途,显式拒绝优于静默挂起)。
 */
export function attachComfyWsBridge(server: Server, upstream: ComfyUpstream): void {
  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (url !== '/comfy' && !url.startsWith('/comfy/')) {
      socket.destroy();
      return;
    }
    bridgeComfyWs(req, socket, head, upstream);
  });
}
