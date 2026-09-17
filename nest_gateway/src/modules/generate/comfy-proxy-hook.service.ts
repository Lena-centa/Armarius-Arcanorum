/**
 * ComfyProxy 提交钩子(comfy-proxy-hook.service.ts)。
 *
 * 内嵌 ComfyUI 模式的提交走 ComfyUI 自己的 Queue(经 /comfy/* 代理),
 * 不经过 GenerateController 的提交路径——提交前探活/回填与素材捕获两段
 * 覆盖会缺失(嵌入方案 §3 决策 2 的后果,即 i2i 血缘回路刚闭合的那个口子)。
 * 本服务在代理层把这两段补回:
 *
 *   1. preflightPromptBody:拦截 POST /comfy/prompt 的 JSON 体,复用
 *      ReplayInputsService.ensureInputs 做探活/回填(可能改写 prompt 引用);
 *      缺图且库内也无 → 422 前置拒绝(提交注定失败,与 generate.controller
 *      的 400 语义一致,状态码区分于上游原生 400 校验错)。
 *   2. watchMaterials:拿到上游 prompt_id 后异步盯 /history/{id},completed
 *      后 captureMaterials + registerSourceMaterials + resolvePendingForPath
 *      (把"仅存于 ComfyUI"的输入素材取回登记为库内记录)。
 *
 * 输出图归档不在此处理:OrchestrationService 的 comfy-history-poller 对
 * /history 里**所有**新完成任务都会归档,与提交来源无关,内嵌任务天然覆盖。
 *
 * 对 ComfyUI 与其前端无感:改写仅发生在流经网关的请求体上,上游按普通
 * 客户端请求对待。内嵌画布里用户改过的参数会原样流经——回填依据是请求体
 * 里的真实引用,而非归档时的 ref 快照(嵌入方案阶段 5 的前提确认项)。
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Database from 'better-sqlite3';
import { registerSourceMaterials } from '../../lib/source-materials';
import { SQLITE_DB } from '../../sqlite/sqlite.module';
import { ParseWorkerService } from '../../workers/parse-worker.service';
import { LineageService } from '../lineage/lineage.service';
import {
  ReplayInputsService,
  type ReplayInputCapture,
} from './replay-inputs.service';

/** 单个监视任务的素材取回上限(与 watchAndArchive 的 30min 对齐)。 */
const WATCH_TIMEOUT_MS = 30 * 60_000;
/** 完成轮询间隔:素材取回不敏感,5s 足够。 */
const WATCH_INTERVAL_MS = 5_000;
/** 同时监视的 prompt 上限(超过则放弃最旧的素材捕获,仅记日志)。 */
const MAX_WATCHES = 50;

/** preflight 结果:改写后的请求体与素材清单。 */
export interface PromptPreflightOutcome {
  /** 可能已被回填改写的请求体(重新序列化) */
  body: Buffer;
  /** 仅存于 ComfyUI 的输入素材(任务完成后取回归档) */
  captures: ReplayInputCapture[];
}

@Injectable()
export class ComfyProxyHookService {
  private readonly logger = new Logger(ComfyProxyHookService.name);
  private readonly scanRoot: string;
  /** 在盯的 prompt_id(防重复登记;插入序即提交序,超限淘汰最旧) */
  private readonly watchedPromptIds = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly parseWorker: ParseWorkerService,
    @Inject(SQLITE_DB) private readonly sqliteDb: Database.Database,
    @Optional() private readonly lineage?: LineageService,
    // @Optional:纯远程部署等未装配探活服务时,钩子整体降级为直通
    @Optional() private readonly replayInputs?: ReplayInputsService,
  ) {
    this.scanRoot = this.config.get<string>('scanRoot') ?? '';
  }

  /** 探活服务未装配时,代理对 /prompt 完全直通(与提交路径关闭时一致)。 */
  get enabled(): boolean {
    return Boolean(this.replayInputs);
  }

  /**
   * 流经的 /prompt 提交体探活/回填。
   *
   * @param parsed body-parser 已解析的 JSON 对象(含 prompt 字段)
   * @returns 改写后的请求体 + 素材清单;`null` = 不干预,按原始体转发
   *          (探测不可用/结构不符,与提交路径的"跳过"语义一致)
   * @throws {{ status: number; message: string }} 缺图且库内无,前置拒绝
   */
  async preflightPromptBody(
    parsed: unknown,
  ): Promise<PromptPreflightOutcome | null> {
    if (!this.replayInputs || typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const prompt = (parsed as { prompt?: unknown }).prompt;
    if (!prompt || typeof prompt !== 'object') {
      return null;
    }
    try {
      const preflight = await this.replayInputs.ensureInputs(
        prompt as Record<string, unknown>,
      );
      if (preflight.missing.length) {
        const refs = preflight.missing
          .map((item) => item.raw_ref)
          .slice(0, 5)
          .join(', ');
        throw {
          status: 422,
          message: `源图不可用(ComfyUI 与图库均无):${refs}`,
        };
      }
      return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), captures: preflight.capture };
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'status' in err &&
        'message' in err
      ) {
        throw err;
      }
      // 探测不可用(worker 掉线/网络抖动):放行,交 ComfyUI 自己报错
      this.logger.warn(
        `comfy-proxy prompt preflight skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * 提交成功后登记素材监视(立即返回,不阻塞代理响应)。
   * 输出归档由 comfy-history-poller 覆盖,这里只取回输入素材。
   */
  watchMaterials(promptId: string, captures: ReplayInputCapture[]): void {
    if (!promptId || !captures.length || !this.replayInputs) {
      return;
    }
    if (this.watchedPromptIds.has(promptId)) {
      return;
    }
    // 上限保护:长期运行防 Set 无限增长(插入序即完成序,删最旧)
    this.watchedPromptIds.add(promptId);
    if (this.watchedPromptIds.size > MAX_WATCHES) {
      const oldest = this.watchedPromptIds.values().next().value;
      if (oldest) this.watchedPromptIds.delete(oldest);
    }
    void this.watchMaterialsLoop(promptId, captures).finally(() => {
      this.watchedPromptIds.delete(promptId);
    });
  }

  /** 轮询 /history/{id} 直到 completed(或超时),然后取回登记素材。 */
  private async watchMaterialsLoop(
    promptId: string,
    captures: ReplayInputCapture[],
  ): Promise<void> {
    const baseUrl = String(
      this.config.get<string>('comfyuiBaseUrl') ?? 'http://127.0.0.1:8188',
    ).replace(/\/+$/, '');
    const deadline = Date.now() + WATCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) {
          const history = (await resp.json()) as Record<string, unknown>;
          const entry = history[promptId] as
            | { status?: { completed?: boolean } }
            | undefined;
          if (entry?.status?.completed) {
            await this.captureAndRegister(promptId, captures);
            return;
          }
        }
      } catch (err) {
        // 单轮失败不终止监视(ComfyUI 重启/网络抖动),继续到超时为止
        this.logger.debug?.(
          `watch ${promptId} poll failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
    }
    this.logger.warn(
      `watch ${promptId}: not completed within ${WATCH_TIMEOUT_MS}ms, material capture abandoned`,
    );
  }

  /** 素材取回 → 登记入库 → 回补血缘挂起边(与提交路径的完成态序列一致)。 */
  private async captureAndRegister(
    promptId: string,
    captures: ReplayInputCapture[],
  ): Promise<void> {
    if (!this.replayInputs) return;
    try {
      const materialPaths = await this.replayInputs.captureMaterials(captures);
      if (!materialPaths.length) return;
      const registered = await registerSourceMaterials(
        this.sqliteDb,
        materialPaths,
        (path: string, scanRoot: string) =>
          this.parseWorker.parseImage(path, scanRoot),
        this.scanRoot,
      );
      this.logger.log(
        `source materials for ${promptId}: captured=${materialPaths.length} registered=${registered.registered} skipped=${registered.skipped}`,
      );
      // 素材登记走独立路径,不经 refreshRecord,需显式回补挂起的血缘边
      for (const path of materialPaths) {
        await this.lineage?.resolvePendingForPath?.(path);
      }
    } catch (err) {
      this.logger.warn(
        `source material capture skipped for ${promptId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
