/**
 * generate 模块 —— 生成页 API 控制器(generate.controller.ts)
 *
 * 职责:镜像旧版 FastAPI /api/generate/* 的 5 类端点,是"历史图重放(Replay)"
 * 功能的入口。数据流如下:
 *
 *   NestJS(Mongo/SQLite 读档) → generate_worker(JSON-RPC 子进程)
 *     → 内部 comfy_replay + ComfyClient → 结果回传 HTTP
 *
 * 端点清单:
 *   GET  /api/generate/source/:sha256  重放源(workflow + 可选项,含 fallback)
 *   GET  /api/generate/derived/:sha256 详情页派生层摘要
 *   POST /api/generate/derived/batch   列表页批量派生摘要(轻量、失败静默)
 *   POST /api/generate/submit          提交重放任务(@RequireAuth)
 *   GET  /api/generate/queue           查询 ComfyUI 队列
 *   GET  /api/generate/history[?limit] 查询 ComfyUI 历史列表 / 单条
 *
 * 存储双轨:readMode 下读走 SQLite(readBatchBySha256),否则读 Mongo
 * (原生 collection 查询绕过 mongoose schema 过滤,以拿到 schema 外字段)。
 *
 * 异步归档:submit 成功后启动 watchAndArchive 后台轮询 ComfyUI history,
 * 任务 completed 后调用 archiveGeneratedOutputs 归档(见 watchAndArchiveLoop)。
 */
import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type Database from 'better-sqlite3';
import { SQLITE_DB } from '../../sqlite/sqlite.module';
import {
  Images,
  ImagesDocument,
  RecipeGroups,
  RecipeGroupsDocument,
  StatsDocs,
  StatsDocsDocument,
} from '../../schemas';
import { GenerateWorkerService } from '../../workers/generate-worker.service';
import { ParseWorkerService } from '../../workers/parse-worker.service';
import {
  WorkerRequestTimeout,
  WorkerRpcError,
  WorkerUnavailableError,
} from '../../workers/generate-worker';
import { batchBySha256, distinctStatsBaseModels, distinctStatsLoras } from '../../sqlite/reader';
import { archiveGeneratedOutputs } from '../../lib/archive';
import { isEnginePending } from '../../lib/engine';
import { RequireAuth } from '../../common/auth';

/**
 * 通用延时工具:返回一个在 ms 毫秒后 resolve 的 Promise。
 * 用于 watchAndArchiveLoop 的 2 秒固定轮询间隔(不随 CPU 抖动)。
 * @param ms 延时毫秒数(必须非负,否则 setTimeout 按 0 处理)
 * @returns 无值 Promise,await 后继续执行下一轮轮询
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// P1#15:轮询自放大防护 —— 模块级活动轮询计数,上限 8,超限返回 429。
// watchAndArchive 每个任务最长 30min×2s 轮询,无并发上限时会被刷爆。
const MAX_ACTIVE_WATCHES = 8;
// 当前正在后台运行的 watchAndArchive 循环数(module 级共享,含全部实例)
let activeWatchCount = 0;

// P3#40:history 默认 12,clamp 1~50
const HISTORY_DEFAULT_LIMIT = 12;
const HISTORY_MAX_LIMIT = 50;
const COMFY_VIEW_TYPES = new Set(['output', 'temp', 'input']);

/**
 * Generate controller — 7 endpoints(5 类)mirroring legacy FastAPI /api/generate/*.
 *
 * Flow: NestJS owns Mongo → passes full doc to generate_worker (JSON-RPC)
 * → worker calls comfy_replay + ComfyClient → returns result.
 *
 * 异步归档: submit 后启动 watchAndArchive 轮询 ComfyUI history,
 * completed 后调 archiveGeneratedOutputs(Phase 3 任务4)。
 *
 * 实例字段职责:
 *   - archivedPromptIds:已归档成功过的 prompt_id 集合(防重复归档)
 *   - inFlightPromptIds:正在轮询归档中的 prompt_id 集合(防并发竞态)
 *   - dualWrite / readMode:SQLite 双写 / 切读开关,决定读档与归档落库引擎
 *   - scanRoot:图片扫描根目录,归档时解析图片文件的相对路径
 */
@Controller('api/generate')
export class GenerateController {
  /** 模块日志器(前缀 GenerateController,便于按类过滤日志)。 */
  private readonly logger = new Logger(GenerateController.name);
  /** 图片扫描根目录(COMFY_SCAN_ROOT),传给归档解析函数作为相对路径基准。 */
  private readonly scanRoot: string;
  /** 已归档的 prompt_id 集合:归档成功后加入,watchAndArchive 入口据此跳过重复归档。 */
  private readonly archivedPromptIds = new Set<string>();
  /** 归档进行中的 prompt_id 集合:同一 id 同时只允许一个轮询循环。 */
  private readonly inFlightPromptIds = new Set<string>();
  /** SQLite 双写开关(SQLITE_DUAL_WRITE=1):归档时同时写 Mongo 与 SQLite。 */
  private readonly dualWrite: boolean;
  /** SQLite 切读开关(SQLITE_READ=1):读档与归档主数据源都走 SQLite。 */
  private readonly readMode: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly worker: GenerateWorkerService,
    private readonly parseWorker: ParseWorkerService,
    @Inject(SQLITE_DB) private readonly sqliteDb: Database.Database,
    @InjectModel(Images.name)
    private readonly imagesModel: Model<ImagesDocument>,
    @InjectModel(StatsDocs.name)
    private readonly statsDocsModel: Model<StatsDocsDocument>,
    @InjectModel(RecipeGroups.name)
    private readonly recipeGroupModel: Model<RecipeGroupsDocument>,
  ) {
    // 从全局配置(.env)读取三个开关;缺省分别为:扫描根空串、不双写、不切读
    this.scanRoot = this.config.get<string>('scanRoot') ?? '';
    this.dualWrite = this.config.get<boolean>('sqlite.dualWrite') ?? false;
    this.readMode = this.config.get<boolean>('sqlite.readMode') ?? false;
  }

  /**
   * Find full batch doc by sha256 (raw MongoDB query to bypass mongoose
   * schema filtering — metadata.raw_prompt is not in the mongoose schema
   * but is the truth source for build_replay_source).
   *
   * 中文补充:按图片 sha256 查找整条 batch 文档。batch 文档的 images[].file.sha256
   * 为索引键,`_id: 0` 投影去除 ObjectId 便于 worker JSON-RPC 序列化。
   * readMode 下直接读 SQLite(reader.batchBySha256),不触碰 Mongo。
   * @param sha256 图片内容哈希(hex 字符串,来自前端路由参数)
   * @returns 完整 batch 文档(含 schema 外字段 raw_prompt/raw_workflow),
   *          未命中返回 null
   */
  private async findDocBySha256(
    sha256: string,
  ): Promise<Record<string, unknown> | null> {
    if (this.readMode) {
      return batchBySha256(this.sqliteDb, sha256);
    }
    const doc = await this.imagesModel.collection.findOne(
      { 'images.file.sha256': sha256 },
      { projection: { _id: 0 } },
    );
    return doc;
  }

  /**
   * 提炼 ComfyUI 校验错误为可读摘要。
   * 典型:value_not_in_list 的 ckpt_name/lora_name 缺失。
   *
   * 中文补充:错误文本通常形如 `ComfyUI HTTP error: 'foo.ckpt' not in [...]`,
   * 此处剥掉 HTTP 前缀、正则抽取引号内资源名,拼成面向用户的中文提示;
   * 其余文本截断至 300 字符防刷屏。
   * @param raw worker 抛出的原始错误信息字符串
   * @returns 可读的错误摘要(不会返回空串,兜底为 'ComfyUI HTTP error')
   */
  private summarizeComfyError(raw: string): string {
    const msg = String(raw ?? '')
      .replace(/^ComfyUI HTTP error:\s*/i, '')
      .trim();
    const m = /'([^']+)' not in \[/.exec(msg);
    if (m) {
      return `工作流引用的资源不存在于当前 ComfyUI: ${m[1]}`;
    }
    return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg || 'ComfyUI HTTP error';
  }

  /**
   * 将 worker 层异常统一映射为 HTTP 异常(按 worker 错误类型分派):
   *   - WorkerUnavailableError → 503 服务不可用(worker 子进程未就绪/挂掉)
   *   - WorkerRequestTimeout  → 504 网关超时(worker 调用超时)
   *   - WorkerRpcError        → 按 code 细分:
   *       -32012 源图不存在 → 404; -32010 ComfyUI 不可达 → 503;
   *       -32011 ComfyUI 业务错误 → 502(透传校验失败详情);
   *       -32602 参数错误 → 400; 其他 → 500
   * @param err worker 抛出的任意异常
   * @returns 转换后的 HttpException,可直接 throw
   */
  private mapWorkerError(err: unknown): HttpException {
    if (err instanceof WorkerUnavailableError) {
      return new ServiceUnavailableException(err.message);
    }
    if (err instanceof WorkerRequestTimeout) {
      return new HttpException(err.message, HttpStatus.GATEWAY_TIMEOUT);
    }
    if (err instanceof WorkerRpcError) {
      if (err.code === -32012) {
        return new NotFoundException('Source image not found');
      }
      if (err.code === -32013) {
        return new UnprocessableEntityException(err.message);
      }
      if (err.code === -32010) {
        return new ServiceUnavailableException('ComfyUI unreachable');
      }
      if (err.code === -32011) {
        // 透传 ComfyUI 错误详情(如 HTTP 400 校验失败原因),
        // 常见场景:历史图引用的模型/LoRA 已不在当前 ComfyUI 环境
        return new HttpException(
          this.summarizeComfyError(err.message),
          HttpStatus.BAD_GATEWAY,
        );
      }
      if (err.code === -32602) {
        return new BadRequestException(err.message);
      }
      return new HttpException(err.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return new HttpException(
      'Generate worker error',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  // GET /api/generate/source/:sha256 — 重放源(前端加载工作流定义与可选项)
  @Get('source/:sha256')
  async getSource(
    @Param('sha256') sha256: string,
  ): Promise<Record<string, unknown>> {
    // 纯远程模式(未配置数据库):直接 503,提示到设置页配置后重启
    if (isEnginePending(this.config)) {
      throw new ServiceUnavailableException(
        '未配置数据库(纯远程模式:请在设置页配置 MongoDB 连接串后重启)',
      );
    }
    // 按 sha256 取 batch 文档,未命中 404
    const doc = await this.findDocBySha256(sha256);
    if (!doc) {
      throw new NotFoundException('Source image not found');
    }
    try {
      // 调 worker 构建重放源:根据 batch 文档还原工作流 raw_prompt/raw_workflow
      const source = (await this.worker.call('build_replay_source', {
        doc,
        sha256,
      })) as {
        options?: {
          checkpoints?: unknown[];
          loras?: unknown[];
        };
      };

      // 与旧 FastAPI /api/generate/source 一致:当 build_replay_source 的
      // options.checkpoints / options.loras 为空时,用已解析工作流的
      // base_model / loras 全量列表作 fallback。源 collection 优先
      // stats_docs(每文件一行,粒度更细),与旧版 options_payload()
      // 同款 filter(prompts.positive 非空)。
      const fallbackFilter = {
        'prompts.positive': { $exists: true, $nin: [null, '', []] },
      };
      // 直接改 source.options 对象(引用),worker 返回结构缺 options 时补空对象
      const sourceOptions = source.options ?? (source.options = {});
      // checkpoints 为空 → 从 stats_docs 取全部 base_model 去重排序作为可选项;
      // readMode 下改从 SQLite 读(distinctStatsBaseModels)
      if (
        !sourceOptions.checkpoints ||
        sourceOptions.checkpoints.length === 0
      ) {
        sourceOptions.checkpoints = (
          this.readMode
            ? distinctStatsBaseModels(this.sqliteDb)
            : await this.statsDocsModel.collection.distinct(
                'model.base_model',
                fallbackFilter,
              )
        )
          .filter(Boolean)
          .sort() as unknown[];
      }
      // loras 为空 → 同样从 stats_docs 的 loras.names(数组字段 distinct 展开)取全量
      if (!sourceOptions.loras || sourceOptions.loras.length === 0) {
        sourceOptions.loras = (
          this.readMode
            ? distinctStatsLoras(this.sqliteDb)
            : await this.statsDocsModel.collection.distinct(
                'loras.names',
                fallbackFilter,
              )
        )
          .filter(Boolean)
          .sort() as unknown[];
      }
      return source;
    } catch (err) {
      // worker 侧异常统一映射为 HTTP 状态码
      throw this.mapWorkerError(err);
    }
  }

  // GET /api/generate/derived/:sha256 — 详情页派生层摘要(controlnets/regions/node_graph)
  @Get('derived/:sha256')
  async getDerived(
    @Param('sha256') sha256: string,
  ): Promise<Record<string, unknown>> {
    // 纯远程模式未配库:503;文档不存在:404(与 getSource 相同的两道前置检查)
    if (isEnginePending(this.config)) {
      throw new ServiceUnavailableException(
        '未配置数据库(纯远程模式:请在设置页配置 MongoDB 连接串后重启)',
      );
    }
    const doc = await this.findDocBySha256(sha256);
    if (!doc) {
      throw new NotFoundException('Source image not found');
    }
    try {
      // 交给 worker 从完整 batch 文档中提炼派生层摘要(单图详情页用)
      return (await this.worker.call('extract_derived_summary', {
        doc,
        sha256,
      })) as Record<string, unknown>;
    } catch (err) {
      throw this.mapWorkerError(err);
    }
  }

  // POST /api/generate/derived/batch — 列表页批量派生摘要(轻量,失败静默)
  @Post('derived/batch')
  async getDerivedBatch(
    @Body() body: { shas?: string[] },
  ): Promise<Record<string, unknown>> {
    // 校验入参:仅接受数组且最多 50 个(防批量放大);空数组直接返回空 items
    const shas = Array.isArray(body.shas) ? body.shas.slice(0, 50) : [];
    if (shas.length === 0) {
      return { items: [] };
    }
    // 纯远程未配库:不报错,逐条标记 engine pending(轻量端点静默降级)
    if (isEnginePending(this.config)) {
      return { items: shas.map((sha256) => ({ sha256, ok: false, error: 'engine pending' })) };
    }
    // 逐个查档,只保留命中的文档;全部未命中则逐条标记 not found
    const docs: Array<{ sha256: string; doc: Record<string, unknown> }> = [];
    for (const sha256 of shas) {
      const doc = await this.findDocBySha256(sha256);
      if (doc) {
        docs.push({ sha256, doc });
      }
    }
    if (docs.length === 0) {
      return { items: shas.map((sha256) => ({ sha256, ok: false, error: 'not found' })) };
    }
    try {
      // 批量摘要一次 RPC 完成(worker 端循环每个 doc),失败则整体抛错
      return (await this.worker.call('extract_derived_batch', {
        docs,
      })) as Record<string, unknown>;
    } catch (err) {
      throw this.mapWorkerError(err);
    }
  }

  // POST /api/generate/submit — 提交重放任务(需要登录态)
  @Post('submit')
  @RequireAuth()
  async submit(
    @Body() body: { sha256?: string; edits?: Record<string, unknown> },
  ): Promise<Record<string, unknown>> {
    // 提取参数:edits 为空对象兜底;sha256 缺失直接 400
    const sha256 = body.sha256;
    const edits = body.edits ?? {};
    if (!sha256) {
      throw new BadRequestException('sha256 is required');
    }
    // 纯远程未配库:503
    if (isEnginePending(this.config)) {
      throw new ServiceUnavailableException(
        '未配置数据库(纯远程模式:请在设置页配置 MongoDB 连接串后重启)',
      );
    }
    // 取源 batch 文档,未命中 404
    const doc = await this.findDocBySha256(sha256);
    if (!doc) {
      throw new NotFoundException('Source image not found');
    }
    // payload:提交给 ComfyUI 的完整 API 负载;queued:submit 的排队结果
    let payload: { client_id?: string } = {};
    let queued: {
      prompt_id?: string;
      number?: number;
      node_errors?: unknown;
    } = {};
    try {
      // 第 1 步:构建重放源,取出 raw_prompt(API 格式负载)与 raw_workflow(UI 格式)
      const source = (await this.worker.call('build_replay_source', {
        doc,
        sha256,
      })) as {
        workflow?: {
          raw_prompt?: Record<string, unknown>;
        };
      };

      const prompt = source?.workflow?.raw_prompt ?? {};
      // 第 2 步:只汇总实际提交的 API prompt 节点类型。UI workflow 还会
      // 包含 bypass/muted/前端控制节点,它们不参与执行,不应制造插件依赖。
      const nodeTypes = new Set<string>();
      for (const node of Object.values(prompt) as Array<{
        class_type?: string;
      }>) {
        if (node?.class_type) {
          nodeTypes.add(String(node.class_type));
        }
      }

      // 第 3 步:拉取这些节点类型的 object_info(输入定义),供 edit 校验与重连
      const objectInfo = (await this.worker.call('fetch_object_info', {
        node_types: [...nodeTypes],
      })) as Record<string, unknown>;

      // 第 4 步:把前端 edits 应用到重放源,产出最终提交负载 payload
      payload = (await this.worker.call('apply_replay_edits', {
        source,
        edits,
        object_info: objectInfo,
      })) as { client_id?: string };

    } catch (err) {
      throw this.mapWorkerError(err);
    }

    // 必须在 POST /prompt 之前预留 watcher 槽位。旧顺序是 ComfyUI 已接受
    // 任务后才返回 429,客户端重试会制造重复生成且首个任务无人归档。
    if (activeWatchCount >= MAX_ACTIVE_WATCHES) {
      throw new HttpException(
        `too many concurrent generate jobs (max ${MAX_ACTIVE_WATCHES}), retry later`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    activeWatchCount += 1;
    try {
      // 第 5 步:提交到 ComfyUI 队列,拿到 prompt_id(后续轮询归档的凭据)
      queued = (await this.worker.call('submit', {
        payload,
      })) as { prompt_id?: string; number?: number; node_errors?: unknown };
    } catch (err) {
      activeWatchCount -= 1;
      throw this.mapWorkerError(err);
    }

    // 异步归档:提交后轮询 ComfyUI history,completed 后归档。
    const promptId = queued.prompt_id;
    if (promptId) {
      void this.watchAndArchive(promptId).finally(() => {
        activeWatchCount -= 1;
      });
    } else {
      // 防御异常上游响应:没有 prompt_id 就没有可轮询任务,立即释放预留。
      activeWatchCount -= 1;
    }

    // 回给前端:ok + 源 sha + 排队信息(prompt_id/number/node_errors)+ client_id
    return {
      ok: true,
      source_sha256: sha256,
      prompt_id: queued.prompt_id,
      number: queued.number,
      client_id: payload.client_id,
      node_errors: queued.node_errors ?? {},
    };
  }

  // GET /api/generate/queue — 透传 ComfyUI 当前队列状态
  @Get('queue')
  async getQueue(): Promise<Record<string, unknown>> {
    try {
      // 直接转发 worker 的 queue 查询结果(running/pending 两段列表)
      return (await this.worker.call('queue', {})) as Record<string, unknown>;
    } catch (err) {
      throw this.mapWorkerError(err);
    }
  }

  // GET /api/generate/view — 受控代理 ComfyUI 结果图片。
  // 浏览器不再硬编码 127.0.0.1:8188,远程/非默认端口同样可预览。
  @Get('view')
  async getComfyView(
    @Query('filename') filenameRaw: string | undefined,
    @Query('subfolder') subfolderRaw: string | undefined,
    @Query('type') typeRaw: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const filename = String(filenameRaw ?? '').trim();
    const subfolder = String(subfolderRaw ?? '').trim();
    const imageType = String(typeRaw ?? 'output').trim() || 'output';
    if (
      !filename ||
      filename.includes('/') ||
      filename.includes('\\') ||
      filename.includes('\0') ||
      filename === '.' ||
      filename === '..'
    ) {
      throw new BadRequestException('invalid ComfyUI filename');
    }
    if (!COMFY_VIEW_TYPES.has(imageType)) {
      throw new BadRequestException('type must be one of: output, temp, input');
    }
    if (
      subfolder.includes('\\') ||
      subfolder.includes('\0') ||
      subfolder
        .split('/')
        .some((segment) => segment === '.' || segment === '..')
    ) {
      throw new BadRequestException('invalid ComfyUI subfolder');
    }

    const baseUrl = String(
      this.config.get<string>('comfyuiBaseUrl') ?? 'http://127.0.0.1:8188',
    ).replace(/\/+$/, '');
    const params = new URLSearchParams({
      filename,
      subfolder,
      type: imageType,
    });
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${baseUrl}/view?${params}`, {
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new ServiceUnavailableException(
        `ComfyUI image unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!upstream.ok) {
      throw new BadGatewayException(
        `ComfyUI /view returned HTTP ${upstream.status}`,
      );
    }
    const contentType = upstream.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw new BadGatewayException(
        `ComfyUI /view returned unexpected content-type: ${contentType || 'missing'}`,
      );
    }
    response.setHeader('Content-Type', contentType);
    response.setHeader('Cache-Control', 'no-store');
    response.send(Buffer.from(await upstream.arrayBuffer()));
  }

  // GET /api/generate/history?limit=5 — 最近完成的历史列表
  @Get('history')
  async getHistory(
    @Query('limit') limitRaw?: string,
  ): Promise<Record<string, unknown>> {
    // P3#40:默认 12,clamp 1~50(原实现 `|| 0` 会把 0/NaN 直传给 worker)
    // 解析失败(非数字/空)时按默认 12 处理,合法值则钳制到 [1, 50] 区间
    const parsed = limitRaw ? parseInt(limitRaw, 10) : Number.NaN;
    const limit = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 1), HISTORY_MAX_LIMIT)
      : HISTORY_DEFAULT_LIMIT;
    try {
      // 透传列表;逐条附 archived 标记,供历史面板显示"已归档"chip
      const result = (await this.worker.call('history', { limit })) as {
        items?: Array<{ prompt_id?: string }>;
        count?: number;
      };
      const items = (result.items ?? []).map((item) => ({
        ...item,
        archived: this.archivedPromptIds.has(String(item.prompt_id ?? "")),
      }));
      return { ...result, items };
    } catch (err) {
      throw this.mapWorkerError(err);
    }
  }

  // GET /api/generate/history/:prompt_id — 按 prompt_id 查单条历史
  @Get('history/:prompt_id')
  async getHistoryById(
    @Param('prompt_id') promptId: string,
  ): Promise<Record<string, unknown>> {
    try {
      // 透传单条查询;附加归档状态(archived/archiving)供前端状态机展示。
      // 注意:watchAndArchiveLoop 直接走 worker RPC,不经过此端点,不受影响。
      const result = (await this.worker.call('history_by_id', {
        prompt_id: promptId,
      })) as Record<string, unknown>;
      return {
        ...result,
        archived: this.archivedPromptIds.has(promptId),
        archiving: this.inFlightPromptIds.has(promptId),
      };
    } catch (err) {
      throw this.mapWorkerError(err);
    }
  }

  // ----------------------------------------------------------- 异步归档

  /**
   * 轮询 ComfyUI history,completed 后调 archiveGeneratedOutputs。
   * 复刻旧 app.py watch_generate_completion(2210-2235)。
   *
   * 队列积压场景:任务可能排队数分钟才执行,固定 5 分钟轮询上限会导致
   * 归档丢失。因此:
   *   - 轮询上限放宽到 30 分钟
   *   - 每轮检查任务是否仍在 ComfyUI 队列;不在 history 也不在队列
   *     (被丢弃/失败)时提前结束,不空等满 30 分钟
   *
   * 中文补充:本方法是归档循环的入口(外层),职责是"去重 + 并发保护",
   * 实际轮询逻辑在 watchAndArchiveLoop(内层)。
   * @param promptId 提交任务时 ComfyUI 返回的 prompt_id
   * @returns 无值;异常不会外抛,统一记 warn 日志
   */
  private async watchAndArchive(promptId: string): Promise<void> {
    // P1#15 双归档竞态:同一 promptId 已在归档中(或已完成)则直接跳过,
    // 避免重复提交导致的两个轮询循环对同一任务重复归档
    if (
      this.archivedPromptIds.has(promptId) ||
      this.inFlightPromptIds.has(promptId)
    ) {
      return;
    }
    // 先登记"进行中",再进循环;循环结束(无论成败)必清理登记
    this.inFlightPromptIds.add(promptId);
    try {
      await this.watchAndArchiveLoop(promptId);
    } catch (err) {
      // 内层循环自身已捕获大部分异常,这里兜底记录致命错误
      this.logger.warn(
        `watch fatal error for ${promptId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.inFlightPromptIds.delete(promptId);
    }
  }

  private async watchAndArchiveLoop(promptId: string): Promise<void> {
    const maxAttempts = 900; // 最多轮询 30 分钟(每2秒)
    this.logger.log(`watchAndArchive started for ${promptId}`);

    // 主循环:每 2 秒查一次 history,直到任务完成、被丢弃或超时
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(2000);
      try {
        // 查单条历史:found=false 表示不在 history(item 已被清理或从未入 history)
        const result = (await this.worker.call('history_by_id', {
          prompt_id: promptId,
        })) as {
          found?: boolean;
          item?: {
            completed?: boolean;
            images?: Array<{
              type?: string;
              filename?: string;
              subfolder?: string;
            }>;
          };
        };

        if (!result.found || !result.item?.completed) {
          // 不在 history 且已不在队列 → 任务被丢弃/失败,停止等待
          // 兜底判断:拉一次队列,看 promptId 是否还在 running/pending 中
          const queue = (await this.worker.call('queue', {})) as {
            running?: Array<{ prompt_id?: string }>;
            pending?: Array<{ prompt_id?: string }>;
          };
          // generate worker 已把 ComfyUI 原始数组归一化为 running/pending
          // 摘要对象;这里必须消费 worker 契约,不能再按原始数组读取。
          const stillQueued = [
            ...(queue.running ?? []),
            ...(queue.pending ?? []),
          ].some((item) => item?.prompt_id === promptId);
          if (!stillQueued) {
            // 已不在队列:任务被丢弃或失败,继续空等无意义,提前退出
            this.logger.warn(
              `watch gave up for ${promptId}: not in history nor queue`,
            );
            return;
          }
          // 仍在排队:继续轮询,等待执行完成
          continue;
        }
        // 归档前复查:轮询期间同 promptId 可能已被另一个循环归档
        if (this.archivedPromptIds.has(promptId)) return;

        this.logger.log(
          `generate completed for ${promptId}, archiving... (images: ${result.item.images?.length ?? 0})`,
        );

        // 任务 completed:归档输出图(写 Mongo images/stats_docs/recipe_groups,
        // dualWrite/readMode 下同时写 SQLite;图片解析回调用 parseWorker)
        const archiveResult = await archiveGeneratedOutputs(
          result.item,
          this.imagesModel,
          this.statsDocsModel,
          this.recipeGroupModel,
          (path: string, scanRoot: string) => this.parseFn(path, scanRoot),
          this.scanRoot,
          this.dualWrite || this.readMode ? this.sqliteDb : undefined,
          this.readMode,
          this.config.get<{ instance_id: string; base_url: string }>(
            'instance',
          ),
        );

        this.logger.log(
          `archive result for ${promptId}: archived=${archiveResult.archived} batches=${archiveResult.batches} paths=${JSON.stringify(archiveResult.paths)}`,
        );

        // 归档成功(至少 1 条):登记进 archivedPromptIds 防止重复归档
        if (archiveResult.archived > 0) {
          this.archivedPromptIds.add(promptId);
          // 上限保护:长期运行防 Set 无限增长(插入序即完成序,删最旧)
          if (this.archivedPromptIds.size > 5000) {
            const oldest = this.archivedPromptIds.values().next().value;
            if (oldest) this.archivedPromptIds.delete(oldest);
          }
        }
        return;
      } catch (err) {
        // 单轮失败(网络抖动/worker 重启):记录后继续下一轮,不中断循环
        this.logger.warn(
          `watch error for ${promptId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // 30 分钟仍未 completed(极慢任务/ComfyUI 长时间不可达):放弃并告警
    this.logger.warn(`watch timeout for ${promptId} (30min)`);
  }

  /**
   * 归档解析回调:把 worker 的 parseImage 包成 archiveGeneratedOutputs
   * 期望的 (path, scanRoot) 签名,避免归档库直接依赖 parse-worker 服务。
   * @param path 图片绝对路径
   * @param scanRoot 扫描根目录(解析相对路径基准)
   * @returns 解析出的 batch 级 record(与 ingest 同构)
   */
  private async parseFn(
    path: string,
    scanRoot: string,
  ): Promise<Record<string, unknown>> {
    return this.parseWorker.parseImage(path, scanRoot);
  }
}
