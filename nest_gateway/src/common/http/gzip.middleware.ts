/**
 * 轻量 gzip 响应压缩中间件(零依赖:只用 node:zlib)。
 *
 * 为什么不用 `compression` 包:它在本仓库只是传递依赖(node_modules 里存在、
 * package.json 未声明),把它提为显式依赖会牵动 lockfile 与离线安装;而这里
 * 只需要压 JSON/文本一类可压缩体,自己实现可控且不新增依赖。
 *
 * 背景(2026-09-11 实测):`/api/stats-docs` 一类端点的 JSON 响应可达 25MB 级,
 * 未压缩时全部走明文传输,是分析类调用的主要耗时来源。
 *
 * 行为:
 *   - 仅处理 `Accept-Encoding` 含 gzip 的请求,且响应尚未带 `Content-Encoding`;
 *   - 仅压 Content-Type 为 JSON / JSON+后缀 / 文本 / JS / CSS / XML 的响应;
 *   - 响应体小于 `minBytes`(默认 1KB)直接透传;
 *   - handler 调用过 `res.write`(流式/SSE/二进制帧)一律放弃压缩,原样透传;
 *   - 压缩后设置 `Content-Encoding: gzip` + `Vary: Accept-Encoding` 并修正
 *     `Content-Length`;
 *   - zlib 失败时回退为未压缩原始体 —— 压缩失败不允许变成 5xx。
 *
 * 非目标:br/deflate(zlib 需引入更多分支,收益边际)、按 MIME 做复杂协商。
 */
import { gzip } from 'zlib';
import type { NextFunction, Request, Response } from 'express';

/** 可压缩的 Content-Type 白名单(前缀/正则匹配)。 */
const COMPRESSIBLE = /^(application\/(json|xml|javascript)|text\/)|[+/]json\b/i;

export interface GzipOptions {
  /** 低于该字节数的响应不压缩(小响应压缩后反而更大)。 */
  minBytes?: number;
  /** 日志回调(压缩失败时告警;缺省静默)。 */
  onError?: (message: string) => void;
}

/**
 * 构造 gzip 中间件。
 *
 * @param options 可选项(minBytes / onError)
 * @returns Express 中间件
 */
export function gzipMiddleware(options: GzipOptions = {}) {
  const minBytes = options.minBytes ?? 1024;
  return function gzipResponse(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const accept = String(req.headers['accept-encoding'] ?? '');
    if (req.method === 'HEAD' || !/\bgzip\b/i.test(accept)) {
      next();
      return;
    }

    const chunks: Buffer[] = [];
    let streaming = false;
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    /** 撤销补丁,恢复原生 write/end(流式与压缩完成都要走这一步)。 */
    const restore = (): void => {
      res.write = originalWrite;
      res.end = originalEnd;
    };

    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      // handler 主动分片写:说明是流式响应,直接放弃压缩
      streaming = true;
      restore();
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof res.write;

    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      restore();
      if (streaming) {
        return (originalEnd as (...args: unknown[]) => Response)(chunk, ...rest);
      }
      if (chunk !== undefined && chunk !== null) {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'),
        );
      }
      const body = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
      const contentType = String(res.getHeader('Content-Type') ?? '');
      const alreadyEncoded = Boolean(res.getHeader('Content-Encoding'));
      if (
        alreadyEncoded ||
        !COMPRESSIBLE.test(contentType) ||
        body.length < minBytes
      ) {
        return (originalEnd as (...args: unknown[]) => Response)(body);
      }

      gzip(body, (err, zipped) => {
        if (err) {
          options.onError?.(`gzip failed: ${err.message}`);
          (originalEnd as (...args: unknown[]) => Response)(body);
          return;
        }
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Content-Length', String(zipped.length));
        (originalEnd as (...args: unknown[]) => Response)(zipped);
      });
      return res;
    }) as typeof res.end;

    next();
  };
}
