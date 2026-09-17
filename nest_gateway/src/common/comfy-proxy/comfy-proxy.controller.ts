/**
 * comfy-proxy 控制器(comfy-proxy.controller.ts)
 *
 * 路由:ALL /comfy 与 /comfy/*splat —— 生成页内嵌 ComfyUI 的同源反向代理
 * (HTTP 部分;WS 升级由 main.ts 挂载的 attachComfyWsBridge 分流)。
 *
 * 写法沿用 pages.controller.ts 的 Express 5 验证模式:通配参数
 * @Param('splat') 在 path-to-regexp v8 下取不到值,改从 originalUrl 提取。
 *
 * 特例:POST /comfy/prompt(提交生成任务)在转发前过 ComfyProxyHookService
 * ——内嵌模式走 ComfyUI 自己的 Queue,绕过了 generate.controller 的提交
 * 路径,由代理层补回提交前探活/回填与完成态素材捕获(嵌入方案阶段 5)。
 *
 * 安全边界:该路由**有意
 * 不设鉴权**——iframe 的子请求无法携带 x-auth-token;等价于把 ComfyUI
 * (自身鉴权弱)经网关端口暴露,建议回环绑定使用(非回环 + 无 token 时
 * main.ts 启动告警会额外点名此路由)。
 */
import { All, Controller, Logger, Optional, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import {
  forwardHttp,
  forwardHttpBuffered,
  isSafeProxyPath,
  parseUpstream,
  stripComfyPrefix,
  type ComfyUpstream,
} from './comfy-proxy';
// 必须值导入(不能 import type):Nest 靠 emit 的 design:paramtypes 解析
// 构造器依赖,类型导入被完全擦除后 @Optional() 参数会注入 undefined
import { ComfyProxyHookService } from '../../modules/generate/comfy-proxy-hook.service';

@Controller()
export class ComfyProxyController {
  private readonly logger = new Logger(ComfyProxyController.name);
  /** 解析失败时保持 null(handler 回 503),不阻断网关启动。 */
  private readonly upstream: ComfyUpstream | null;

  constructor(
    configService: ConfigService,
    // 钩子未装配(模块裁剪/单测)时代理保持纯直通
    @Optional() private readonly hook?: ComfyProxyHookService,
  ) {
    const baseUrl =
      configService.get<string>('comfyuiBaseUrl') ?? 'http://127.0.0.1:8188';
    try {
      this.upstream = parseUpstream(baseUrl);
    } catch {
      this.upstream = null;
    }
  }

  /** ALL /comfy[/*] —— 剥前缀后流式转发;路径非法回 400,配置非法回 503。 */
  @All(['/comfy', '/comfy/*splat'])
  proxy(@Req() req: Request, @Res() res: Response): void {
    if (!this.upstream) {
      res.status(503).json({
        error: 'comfy proxy unavailable: invalid COMFYUI_BASE_URL',
      });
      return;
    }
    const target = stripComfyPrefix(req.originalUrl);
    const pathPart = target ? target.split('?')[0] : '';
    if (!target || !isSafeProxyPath(pathPart)) {
      res.status(400).json({ error: 'invalid /comfy path' });
      return;
    }
    // 提交生成任务:探活/回填 + prompt_id 登记(小 JSON 响应走缓冲路径)
    if (req.method === 'POST' && pathPart === '/prompt') {
      void this.proxyPromptPost(req, res, target);
      return;
    }
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const body = Buffer.isBuffer(rawBody) && rawBody.length > 0 ? rawBody : undefined;
    forwardHttp(this.upstream, req, res, target, body);
  }

  /**
   * POST /comfy/prompt 专路:体先经钩子探活/回填(可能改写引用),再缓冲
   * 上游响应取出 prompt_id 交给素材监视,最后把上游回执原样交回前端。
   * 任何一步失败都不吞上游错误:4xx/5xx 照常透传(嵌入方案阶段 1 语义)。
   */
  private async proxyPromptPost(
    req: Request,
    res: Response,
    target: string,
  ): Promise<void> {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    let forwardBody: Buffer | undefined =
      Buffer.isBuffer(rawBody) && rawBody.length > 0 ? rawBody : undefined;
    let captures: import('../../modules/generate/replay-inputs.service').ReplayInputCapture[] = [];
    if (this.hook?.enabled && forwardBody) {
      try {
        const parsed: unknown = JSON.parse(forwardBody.toString('utf8'));
        const outcome = await this.hook.preflightPromptBody(parsed);
        if (outcome) {
          forwardBody = outcome.body;
          captures = outcome.captures;
        }
      } catch (err) {
        const status =
          err && typeof err === 'object' && 'status' in err
            ? Number((err as { status: number }).status) || 422
            : 422;
        const message =
          err && typeof err === 'object' && 'message' in err
            ? String((err as { message: string }).message)
            : 'prompt preflight failed';
        this.logger.warn(`comfy-proxy prompt rejected: ${message}`);
        res.status(status).json({ error: message });
        return;
      }
    }
    try {
      const upstreamResp = await forwardHttpBuffered(
        this.upstream as ComfyUpstream,
        req,
        target,
        forwardBody,
      );
      // 从回执里取 prompt_id:有素材待取回时启动完成态监视
      if (this.hook && captures.length && upstreamResp.status === 200) {
        try {
          const receipt = JSON.parse(upstreamResp.payload.toString('utf8')) as {
            prompt_id?: unknown;
          };
          const promptId =
            typeof receipt.prompt_id === 'string' ? receipt.prompt_id : '';
          if (promptId) {
            this.hook.watchMaterials(promptId, captures);
          }
        } catch {
          // 回执形状变化不阻断响应透传(素材捕获是尽力而为)
        }
      }
      res.status(upstreamResp.status);
      for (const [key, value] of Object.entries(upstreamResp.headers)) {
        res.setHeader(key, value);
      }
      res.end(upstreamResp.payload);
    } catch (err) {
      // 连接级失败(上游不可达)无法透传,造 502;与 forwardHttp 语义一致
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(502);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: 'comfyui upstream unreachable',
          detail: String(err),
        }),
      );
    }
  }
}
