/**
 * ParseWorkerSupervisor — NestJS side of the parse_worker JSON-RPC protocol.
 *
 * Implements docs/contracts/parse_worker_protocol.md:
 * - spawns `python -m workflow_db.parse_worker` (§2.1)
 * - ready handshake with spawn timeout and version check (§5)
 * - line-based stdout parser incl. length-prefixed binary frames (§2.3);
 *   the worker emits the binary frame BEFORE the rpc response for
 *   make_thumb, so frames are buffered by frame_id and joined on arrival
 * - per-method request timeouts (§6.2); a timeout kills + restarts the
 *   worker and rejects the inflight request
 *   - crash recovery (§6.4): on unexpected exit, all inflight requests are
 *   rejected (no retry, avoids double-processing), the worker is restarted
 *   with backoff; after maxRestarts consecutive failures the supervisor
 *   enters `failed` state and calls are rejected with 503 semantics
 */

/**
 * 【职责概述】ParseWorkerSupervisor 是网关侧对 Python parse_worker 子进程的
 * RPC 桥接层(协议权威依据:docs/contracts/parse_worker_protocol.md):
 *   1. 进程管理:spawn `python -m workflow_db.parse_worker`,维护 stopped/starting/
 *      ready/restarting/failed 状态机,崩溃后指数退避自愈(§6.4);
 *   2. JSON-RPC 调用:parse_image(图片解析出 record)、enrich_record(展示补全)、
 *      make_thumb(缩略图字节)、ping(健康检查),逐方法超时(§6.2),超时 kill + 重启;
 *   3. 二进制帧通道:make_thumb 的字节经 length-prefixed 帧随 stdout 返回(§2.3),
 *      按 frame_id 与 rpc 响应关联,支持"帧先到/响应先到"两种乱序组装;
 *   4. 错误映射:worker JSON-RPC error → WorkerRpcError(code,message);
 *      进程不可用 → WorkerUnavailableError(503 语义);超时 → WorkerRequestTimeout。
 *
 * 【数据流向】(协议 §2.1)
 *   网关(Controller/Service)
 *      │  call()/parseImage()/makeThumb()
 *      ▼  stdin(JSON-RPC 请求,行分隔)
 *   parse_worker(Python,单线程串行处理)
 *      │  stdout:rpc 响应 / binary 帧 / ready / log
 *      ▼
 *   网关(onStdout → drain → handleMessage → onRpc / onFrame)
 *
 * 【二进制帧时序】(§2.3)——缩略图字节不能塞进 JSON(base64 膨胀 33%):
 *   worker 写:JSON 帧头行(含 frame_id/length)→ 精确 length 字节裸数据 → 换行
 *   本侧读:帧头进入 binaryMode 状态机 → 按 length 精确读字节(内容可含 0x0A,
 *   绝不能按行切!)→ 帧头通常先于 rpc 响应到达:帧先入 frames 缓存;rpc 响应
 *   到达时若帧已就位直接结算,否则转入 frameWaiters 等待尾帧(FRAME_GRACE_MS 宽限)。
 *
 * 【错误码】(协议 §3.4)
 *   -32700 解析失败 / -32601 方法不存在 / -32602 参数非法 / -32603 内部错误;
 *   -32000 图片打开失败; -32001 路径不存在; -32002 缩略图生成失败(本侧亦用于
 *   二进制帧缺失/超时); -32003 worker 过载。
 *
 * 【关键不变式】
 *   - 每个请求恰好结算一次(响应/尾帧宽限/超时/崩溃四路互斥);
 *   - binaryMode 是"一次性"模式:进入后下一次 drain 必须精确消费 length 字节,
 *     否则整个 stdout 解析流错位;
 *   - restart 由 expectedExit 标志与 force 参数双守卫防重入。
 */

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';

/**
 * worker 生命周期状态机(协议 §5/§6):
 *   stopped    — 未启动 / 已主动停止(stop() 后)
 *   starting   — 已 spawn,等待 ready 握手
 *   ready      — 握手完成,可接受请求
 *   restarting — 崩溃/超时后的重启流程进行中(backoff 等待或已 respawn)
 *   failed     — 连续失败达 maxRestarts 的终态;此后所有 call 直接 reject(503 语义)
 * 迁移路径:stopped → starting → ready ↔(restarting)↔ starting / failed → stopped
 */
export type WorkerState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'failed';

/**
 * RPC 层错误:worker 侧 JSON-RPC error 对象的网关侧映射。
 * code 透传协议 §3.4 错误码(如 -32000 图片打开失败、-32002 缩略图生成失败),
 * 调用方可据此返回精确的 HTTP 状态与用户提示,而不是一律 500。
 */
export class WorkerRpcError extends Error {
  /**
   * @param code    JSON-RPC 错误码(协议 §3.4)
   * @param message worker 侧提供的错误描述,透传
   */
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerRpcError';
  }
}

/** 进程不可用错误:worker 处于 failed/stopped/restarting 时拒绝调用抛出,网关层映射为 503 */
export class WorkerUnavailableError extends Error {
  constructor(message = 'parse worker unavailable') {
    super(message);
    this.name = 'WorkerUnavailableError';
  }
}

/** 请求超时错误:超过 METHOD_TIMEOUTS 阈值仍无响应时抛出,并触发 worker 重启(§6.2) */
export class WorkerRequestTimeout extends Error {
  constructor(method: string) {
    super(`request timeout: ${method}`);
    this.name = 'WorkerRequestTimeout';
  }
}

/**
 * 缩略图二进制结果:makeThumb 的最终返回值。
 * 由二进制帧通道组装(帧头声明 mime,裸数据为 data),供网关侧直接作为
 * HTTP 响应体返回(Content-Type 取 mime)。
 */
export interface ThumbResult {
  /** 图片 MIME 类型(默认 image/webp,见 binary 帧解析) */
  mime: string;
  /** 缩略图原始字节(worker 生成的 WEBP,quality=82 / method=4 等参数见协议 §4.2) */
  data: Buffer;
}

/** Display-only enrichment wrapper. Diagnostics/provenance are never persisted. */
export interface EnrichmentResult {
  effective_record: Record<string, unknown>;
  provenance: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
}

/**
 * 在途请求条目(pending Map 值)。
 * 注意 make_thumb 的请求有两条成功结算路径:rpc 响应直接 settle,或转入
 * frameWaiters 等尾帧后 settle——无论哪条路径,条目最终都被移除,无泄漏。
 */
interface PendingRequest {
  /** 请求唯一 id,与线上 JSON-RPC id 一致 */
  id: string;
  /** 是否期待二进制帧(make_thumb=true):决定 onRpc 是否走帧关联逻辑 */
  expectBinary: boolean;
  /** 成功结算回调 */
  resolve: (value: unknown) => void;
  /** 失败结算回调 */
  reject: (err: Error) => void;
  /** 方法级超时计时器(到达后 onRequestTimeout → reject + restart) */
  timer: NodeJS.Timeout;
}

/**
 * 尾帧等待者:rpc 响应先到、二进制帧后到时的中间态(协议 §2.3 健壮性要求)。
 * rpc 响应已收到但帧未到,把请求连同响应结果暂存,等 onFrame 补齐后结算;
 * timer 为宽限计时器(FRAME_GRACE_MS),超时判 -32002 'binary frame timeout'。
 */
interface PendingFrameWaiter {
  /** 原在途请求:onFrame 到达时用它完成最终 settle/reject */
  request: PendingRequest;
  /** 已收到的 rpc 响应结果(含 frame_id),尾帧到达后原样 resolve */
  result: unknown;
  /** 尾帧宽限计时器 */
  timer: NodeJS.Timeout;
}

/**
 * supervisor 构造选项:生产环境由 ParseWorkerService 从 worker.* 配置注入,
 * 测试直接构造(注入 mock 脚本验证崩溃自愈路径)。
 */
interface SupervisorOptions {
  /** Python 可执行文件路径(测试传 process.execPath 复用 Node 本体) */
  pythonBin: string;
  /** 子进程工作目录 */
  cwd: string;
  /**
   * 传给子进程的命令行参数,缺省为 `['-m', 'workflow_db.parse_worker']`;
   * 测试注入 mock 脚本路径以演练崩溃/重启路径(不依赖真实 Python worker)。
   */
  args?: string[];
  /** ready 握手超时(毫秒),默认 10_000(协议 §5.2) */
  spawnTimeoutMs?: number;
  /** 连续失败最大重启次数,默认 3(协议 §5.2) */
  maxRestarts?: number;
  /** 日志回调桥接 NestJS Logger */
  logger?: (level: string, msg: string) => void;
}

/**
 * 方法级超时(协议 §6.2):parse_image 30s、enrich_record/make_thumb 10s、
 * ping 2s。超时路径 = reject WorkerRequestTimeout + restart(§6.2:超时后杀进程重启)。
 * 未列出方法兜底 30s(见 callInternal)。
 */
const METHOD_TIMEOUTS: Record<string, number> = {
  parse_image: 30_000, // 单图解析:读图 + PIL 元数据提取,给足 30s
  enrich_record: 10_000, // 纯内存展示补全,不访问文件或数据库
  suggest_tags: 30_000, // GNN 组推荐:资产冷加载 ~0.5s,热查询 ~20ms
  make_thumb: 10_000, // 缩略图生成:小图重采样,10s 足够
  ping: 2_000, // 健康检查:worker 卡死时必须快速暴露
};

/** 协议版本号(§8.1):与 ready 消息 version 比对,不匹配判握手失败 */
const PROTOCOL_VERSION = '1.0';
/**
 * 尾帧宽限:rpc 响应到达后,再给二进制帧 2s 的到达窗口(§2.3)。
 * 为什么需要:stdout 上帧头/裸数据/rpc 响应的实际到达顺序因缓冲而不确定,
 * 响应先到、帧后到时请求不能立即结算(字节未到手无法返回给调用方),
 * 必须等帧。2s 远小于请求超时(10s),不会拖垮整体超时体验;
 * 宽限超时后判 -32002 'binary frame timeout' 并 reject。
 */
const FRAME_GRACE_MS = 2_000;

/**
 * parse_worker 子进程主管(supervisor)。
 * 对外 API:start/stop/waitReady/getState/ping/call/makeThumb/parseImage/enrichRecord;
 * 内部机制:状态机 + 行缓冲协议解析 + 二进制帧状态机 + pending/frameWaiters
 * 双表请求治理 + 指数退避重启。
 * 关键不变式:
 *   - 每个请求恰好结算一次(响应/尾帧宽限/超时/崩溃四路互斥);
 *   - binaryMode 是"一次性"模式:进入后下一次 drain 必须精确消费 length 字节,
 *     否则整个 stdout 解析流错位;
 *   - restart 由 expectedExit 与 force 双守卫防重入。
 */
export class ParseWorkerSupervisor {
  /** 当前存活的子进程;为 null 表示未 spawn 或已被 restart 接管 */
  private child: ChildProcess | null = null;
  /** 生命周期状态(见 WorkerState) */
  private state: WorkerState = 'stopped';
  /** stdout 累积缓冲:切行解析的残片保留区(跨 chunk 保真) */
  private buffer: Buffer = Buffer.alloc(0);
  /** 二进制帧解析状态:非 null 表示 stdout 下一段是 length 字节裸数据 + 1 字节换行 */
  private binaryMode: { frameId: string; length: number; mime: string } | null =
    null;
  /** 已到达的帧缓存 frame_id → ThumbResult:帧先于 rpc 响应到达时暂存于此 */
  private frames = new Map<string, ThumbResult>();
  /** 在途请求表 id → PendingRequest */
  private pending = new Map<string, PendingRequest>();
  /** 尾帧等待表 frame_id → PendingFrameWaiter(rpc 已到、帧未到) */
  private frameWaiters = new Map<string, PendingFrameWaiter>();
  /** 握手前排队请求(ready 后统一 flush,协议 §5.1) */
  private preReadyQueue: Array<() => void> = [];
  /** waitReady() 等待者,ready 时统一 resolve */
  private readyWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  /** 握手看门狗计时器 */
  private spawnTimer: NodeJS.Timeout | null = null;
  /** 连续失败计数,ready 清零,达 maxRestarts 进 failed(§5.2) */
  private restarts = 0;
  /** 请求序号:seq + 时间戳构成唯一 id */
  private seq = 0;
  /** 停止标志,stop() 置位后阻断一切重启动作 */
  private stopping = false;
  /** 当前子进程被在途 restart() 杀死时为 true:其 exit 事件不得再触发重启(P1#6 重入守卫) */
  private expectedExit = false;
  /** 内部事件总线(发出 ready/failed 事件) */
  private readonly events = new EventEmitter();

  /** 握手超时与最大重启数(构造时固化,默认 10s / 3 次,协议 §5.2) */
  private readonly spawnTimeoutMs: number;
  private readonly maxRestarts: number;

  /**
   * @param options 见 SupervisorOptions;超时/重启数缺省时取协议 §5.2 默认值
   */
  constructor(private readonly options: SupervisorOptions) {
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? 10_000;
    this.maxRestarts = options.maxRestarts ?? 3;
  }

  // ------------------------------------------------------------------ API

  /** 读取当前状态(测试与健康检查用) */
  getState(): WorkerState {
    return this.state;
  }

  /**
   * 等待握手完成:
   * - ready → 立即 resolve;failed → 立即 reject(启动失败的同步暴露);
   * - 其他状态 → 挂入 readyWaiters,由 onReady(resolve)/restart·stop(reject)统一
   *   结算,保证等待者永远不会悬挂。
   */
  waitReady(): Promise<void> {
    if (this.state === 'ready') {
      return Promise.resolve();
    }
    if (this.state === 'failed') {
      return Promise.reject(new WorkerUnavailableError());
    }
    return new Promise((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  /**
   * 启动:重置停止标志 → spawn → 等待握手。
   * 握手失败时 reject(WorkerUnavailableError),由上层决定是否降级运行(见 service)。
   */
  async start(): Promise<void> {
    this.stopping = false;
    this.spawnWorker();
    await this.waitReady();
  }

  /**
   * 主动停止:置停止标志(阻断 restart)→ 清看门狗 → 结算全部挂起
   * (在途请求 + ready 等待者)→ SIGTERM。
   * 注意顺序:先置标志后杀进程,exit 回调因 stopping 为 true 而短路,不误入重启流程。
   */
  stop(): Promise<void> {
    this.stopping = true;
    this.state = 'stopped';
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
      this.spawnTimer = null;
    }
    // 所有 Promise 必须有归宿:等待者与在途请求一并结算
    this.rejectAll(new WorkerUnavailableError('worker stopped'));
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
    return Promise.resolve();
  }

  /** 健康检查(2s 超时),返回 { pong: true, ... } */
  async ping(): Promise<unknown> {
    return this.call('ping', {});
  }

  /** 普通 RPC 调用(expectBinary=false):响应即结果,无二进制帧参与 */
  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.callInternal(method, params, false);
  }

  /**
   * 生成缩略图(协议 §4.2):返回字节而非 JSON。
   * @param resolvedPath 图片绝对路径
   * @param w h 目标尺寸(64..1024,worker 侧校验,越界返回 -32602)
   * @returns ThumbResult{mime, data}:字节数据可直接作为 HTTP 响应体
   * @throws WorkerRpcError -32002 帧缺失/生成失败、-32001 文件不存在
   *
   * 时序:callInternal 发出请求(expectBinary=true 附带 _request_id 供帧关联)。
   * 帧头可能在 rpc 响应之前或之后到达:
   *   - 帧先到 → frames 缓存;rpc 到达时 onRpc 发现帧就位直接结算;
   *   - 响应先到 → 转入 frameWaiters,onFrame 到齐后结算。
   * 两路都保证 callInternal 的 Promise resolve 时,帧一定已在 frames 中。
   */
  async makeThumb(
    resolvedPath: string,
    w: number,
    h: number,
  ): Promise<ThumbResult> {
    // 请求参数与协议 §4.2 对齐:resolved_path + w + h
    const result = (await this.callInternal(
      'make_thumb',
      { resolved_path: resolvedPath, w, h },
      true,
    )) as { frame_id: string };
    // rpc 已结算 → 帧必须在 frames 中;否则说明帧通道出错(帧与请求失联)
    const frame = this.frames.get(result.frame_id);
    if (!frame) {
      // -32002 与协议"Thumbnail generation failed"同码:帧缺失视为生成失败
      throw new WorkerRpcError(-32002, 'binary frame missing');
    }
    // 一次性消费:帧取走后立即删除,防 frames Map 无限增长
    this.frames.delete(result.frame_id);
    return frame;
  }

  /**
   * 解析单张图片(协议 §4.1),返回符合 record.schema.json 的 record 对象。
   * @param path     图片路径(绝对或相对)
   * @param scanRoot 扫描根目录(可空字符串;决定相对路径归属,语义见 parser)
   * @returns record 对象;record 缺失视为协议违约,抛 -32603
   * 注意:parse_image 是纯解析,不写 Mongo(协议 §10),写库由 NestJS 侧完成。
   */
  async parseImage(
    path: string,
    scanRoot: string,
  ): Promise<Record<string, unknown>> {
    const resp = (await this.call('parse_image', {
      path,
      scan_root: scanRoot,
    })) as { record?: Record<string, unknown>; warnings?: unknown[] } | null;
    // 防御性校验:worker 正常情况必返回 record(协议 §4.1),缺失即协议违约
    if (!resp || typeof resp.record !== 'object' || resp.record === null) {
      throw new WorkerRpcError(-32603, 'parse_image response missing record');
    }
    // warnings 为可选诊断信息:转发为日志(截断防洪泛),不改变主流程
    if (Array.isArray(resp.warnings) && resp.warnings.length > 0) {
      this.log(
        'warn',
        `parse_image warnings for ${path}: ${JSON.stringify(resp.warnings).slice(0, 200)}`,
      );
    }
    return resp.record;
  }

  /**
   * 对已有 Record 构建展示补全视图(协议 §4.4)。输入 Record 与默认解析/
   * 入库链路保持不变;调用方必须显式选择使用 effective_record。
   */
  async enrichRecord(
    record: Record<string, unknown>,
  ): Promise<EnrichmentResult> {
    const resp = (await this.call('enrich_record', {
      record,
    })) as Partial<EnrichmentResult> | null;
    if (
      !resp ||
      typeof resp.effective_record !== 'object' ||
      resp.effective_record === null ||
      typeof resp.provenance !== 'object' ||
      resp.provenance === null ||
      typeof resp.diagnostics !== 'object' ||
      resp.diagnostics === null
    ) {
      throw new WorkerRpcError(-32603, 'enrich_record response is invalid');
    }
    return resp as EnrichmentResult;
  }

  /**
   * Danbooru tag 组推荐(协议 §4.5,可选功能)。把一个批次的 prompt 文本数组
   * 作为多输入提交;worker 侧 GNN 资产缺失时返回 { enabled:false }(调用方
   * 据此跳过预计算,不抛错、不阻断 ingest)。
   */
  async suggestTags(
    prompts: string[],
    batchKey?: string,
    topK = 10,
  ): Promise<Record<string, unknown>> {
    const resp = (await this.call('suggest_tags', {
      prompts,
      batch_key: batchKey ?? '',
      top_k: topK,
    })) as Record<string, unknown> | null;
    return resp ?? { enabled: false };
  }

  // ------------------------------------------------------------ dispatch

  /**
   * call 的内部实现(call / makeThumb 共用):
   * @param method       RPC 方法名(超时查表键)
   * @param params       业务参数
   * @param expectBinary 是否期待二进制帧(make_thumb=true):true 时额外附加
   *                     _request_id 参数(worker 用它生成 frame_id 关联帧与请求)
   * @returns Promise:result / 三态错误(WorkerRpcError / WorkerUnavailableError /
   *          WorkerRequestTimeout)
   * 生命周期:注册 pending → ready 即发/未 ready 入队 → 四路结算
   * (响应 onRpc / 尾帧 onFrame / 超时 onRequestTimeout / 崩溃 rejectAllInflight)。
   */
  private callInternal(
    method: string,
    params: Record<string, unknown>,
    expectBinary: boolean,
  ): Promise<unknown> {
    if (this.state === 'failed') {
      // failed 终态:worker 不会再处理任何请求,立即拒绝
      return Promise.reject(new WorkerUnavailableError());
    }
    this.seq += 1;
    const id = `req_${this.seq}_${Date.now()}`;
    // 二进制请求附加 _request_id:worker 侧据此生成 frame_id,保证帧与请求可关联
    const wireParams = expectBinary ? { ...params, _request_id: id } : params;
    return new Promise((resolve, reject) => {
      // 未列入超时表的方法兜底 30s
      const timeoutMs = METHOD_TIMEOUTS[method] ?? 30_000;
      const timer = setTimeout(
        () => this.onRequestTimeout(id, method),
        timeoutMs,
      );
      this.pending.set(id, { id, expectBinary, resolve, reject, timer });
      const send = () =>
        this.writeLine({
          jsonrpc: '2.0',
          id,
          method,
          params: wireParams,
        });
      // ready 才写 stdin;否则入队等 onReady flush(§5.1 排队规则)
      if (this.state === 'ready' && this.child) {
        send();
      } else {
        this.preReadyQueue.push(send);
      }
    });
  }

  /** 向 worker stdin 写一行 JSON(协议 §2.2 行分隔)。
   *  stdin 不可写(进程已退出)时静默丢弃——该请求由 exit/超时路径结算 */
  private writeLine(payload: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /**
   * 请求超时(§6.2):reject WorkerRequestTimeout + 重启。
   * 为什么必须重启:worker 单线程串行处理(§6.1),一个请求挂起意味着后续请求
   * 全部排队,不换进程整个服务不可用;且挂起的线程可能卡在 C 扩展里无法自愈。
   * pending 中已无该请求(其他路径已结算)则忽略:保证一次请求仅一次结算。
   */
  private onRequestTimeout(id: string, method: string): void {
    const req = this.pending.get(id);
    if (!req) {
      return;
    }
    this.pending.delete(id);
    req.reject(new WorkerRequestTimeout(method));
    // A hung request means the worker may be wedged; restart it (§6.2).
    void this.restart('request-timeout');
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * spawn 子进程并挂接 IO 事件(协议 §5.1 第 1-2 步)。
   * 二进制通道的关键清理:buffer 与 binaryMode 必须重置——上个进程的 stdout
   * 残片/半截帧绝不能被新进程复用,否则解析流错位。
   */
  private spawnWorker(): void {
    // 重启驱动的 respawn 保持 restarting,让重入守卫识别恢复流程进行中
    this.state = this.state === 'restarting' ? 'restarting' : 'starting';
    this.expectedExit = false;
    this.log('info', `spawning parse worker (attempt ${this.restarts + 1})`);
    this.buffer = Buffer.alloc(0);
    this.binaryMode = null; // 退出帧解析模式:新进程从干净的 JSON 流开始

    this.child = spawn(
      this.options.pythonBin,
      // 默认模块方式启动;测试注入 mock 脚本路径(args 可测性设计)
      this.options.args ?? ['-m', 'workflow_db.parse_worker'],
      {
        cwd: this.options.cwd,
        // 三管道全接管:stdin 请求 / stdout 响应+帧 / stderr 日志(§2.1)
        stdio: ['pipe', 'pipe', 'pipe'],
        // 强制 UTF-8:Windows 下 Python 默认 stdout 为 GBK,JSON-RPC
        // 含中文时会 UnicodeEncodeError(worker 侧另有 reconfigure 兜底)
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      },
    );
    const child = this.child; // 快照:后续回调据此判别是否"当前进程"

    // stdout:协议消息通道;流 error(EPIPE 等)只记日志,防止未捕获异常升级杀网关
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stdout?.on('error', (err) => {
      // EPIPE 等流错误:吞掉并打 log,避免未捕获异常杀死网关(P3#34)
      this.log('warn', `worker stdout stream error: ${err.message}`);
    });
    // stderr:结构化日志通道
    child.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk));
    child.stderr?.on('error', (err) => {
      this.log('warn', `worker stderr stream error: ${err.message}`);
    });
    child.stdin?.on('error', (err) => {
      this.log('warn', `worker stdin stream error: ${err.message}`);
    });
    child.on('error', (err) => {
      // 陈旧进程的 error 忽略:restart() 已接管其生命周期,避免双路径恢复
      if (this.child !== child) {
        return; // stale error from a superseded process
      }
      this.log('error', `worker spawn error: ${err.message}`);
      // spawn 失败(如 pythonBin 不存在)不会触发 exit,必须显式走
      // restart/failed 流程,否则 waitReady 永不 resolve、网关无法 listen。
      // force:重启期间的 spawn 失败也必须继续计数,否则状态卡在 restarting。
      void this.restart(`spawn error: ${err.message}`, true);
    });
    child.on('exit', (code, signal) => this.onExit(child, code, signal));

    // 握手看门狗:ready 前超时即 SIGKILL(其 exit 会走 force 恢复路径)
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
    }
    this.spawnTimer = setTimeout(() => {
      this.log('error', 'worker ready handshake timed out');
      this.child?.kill('SIGKILL');
    }, this.spawnTimeoutMs);
  }

  /**
   * 崩溃/超时恢复(协议 §6.4):结算在途请求(不重试,防双写)→ 指数退避 →
   * respawn;连续失败达 maxRestarts 进入 failed 终态(§5.2)。
   * @param reason 日志用重启原因
   * @param force  true = 恢复流程自身的推进器(exit/spawn-error),放行重入守卫
   */
  private async restart(reason: string, force = false): Promise<void> {
    // 已停止/已 failed:恢复动作到此为止
    if (this.stopping || this.state === 'failed') {
      return;
    }
    // 重入守卫:restart 流程进行中(state === 'restarting')时,来自请求
    // 超时等的重复 restart 调用直接丢弃,避免双 spawn/双计 restarts。
    // 但 exit/spawn-error 驱动的恢复是 restart 流程自身的推进器(新进程
    // 尚未 ready 就崩时 state 一直停留在 'restarting'),必须放行(force)。
    if (this.state === 'restarting' && !force) {
      return;
    }
    this.log('warn', `restarting parse worker: ${reason}`);
    this.state = 'restarting'; // 立即置位,重入守卫随即生效
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer); // 作废看门狗,避免与 kill 竞态
      this.spawnTimer = null;
    }
    // 在途请求全部 reject(§6.4:不重试——worker 可能已执行一半,重试导致双写)
    this.rejectAllInflight(new WorkerUnavailableError('worker restarting'));
    if (this.child) {
      // 先置 expectedExit 再 kill:该 child 的 exit 事件由 onExit 吞掉,
      // 不会再次进入 restart(避免 kill + exit 双路径双计 restarts)
      this.expectedExit = true;
      this.child.kill('SIGKILL'); // 重启场景不做优雅退出,直接换血
      this.child = null;
    }
    this.restarts += 1;
    if (this.restarts >= this.maxRestarts) {
      // 终态:restarts 在 onReady 前不会被清零,第 maxRestarts 次重启失败即判死
      this.state = 'failed';
      this.rejectAll(new WorkerUnavailableError('worker failed'));
      this.events.emit('failed');
      return;
    }
    // 指数退避(200ms×2^n,封顶 2s):防崩溃风暴下高频 respawn 打满 CPU
    const backoff = Math.min(200 * 2 ** (this.restarts - 1), 2_000);
    await new Promise((resolve) => setTimeout(resolve, backoff));
    // 退避期间 stop() 到达 → 放弃重启
    if (!this.stopping) {
      this.spawnWorker();
    }
  }

  /**
   * 子进程退出回调:四条路径判别。
   *   - 陈旧进程(child !== this.child):忽略;
   *   - stop() 主动停止:忽略;
   *   - restart() 主动 kill(expectedExit):吞掉,推进由 restart 自身完成;
   *   - 自然崩溃:清句柄 → force 重启(force 保证即使已在 restarting 也放行,
   *     否则"新进程未 ready 又崩"会让恢复流程永久停滞)。
   */
  private onExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) {
      return; // stale exit from a superseded process — ignore
    }
    if (this.stopping) {
      return;
    }
    this.log('warn', `worker exited code=${code} signal=${signal}`);
    if (this.expectedExit) {
      // 本 child 是 restart() 主动 kill 的,restart 流程自身继续(backoff +
      // respawn),这里不再触发第二次 restart
      this.expectedExit = false;
      this.child = null;
      return;
    }
    this.child = null; // 先清句柄,防 restart 内 kill 误判
    // force:见 restart() 重入守卫注释——自然退出的恢复必须放行
    void this.restart(`exit code=${code} signal=${signal}`, true);
  }

  /**
   * 处理 ready 握手(§5.1 第 4 步):关看门狗 → 版本校验(§8.1,不匹配则 failed
   * 终态——协议不兼容的 worker 宁可不用)→ 置 ready、重置 restarts → 结算
   * readyWaiters → flush 排队请求 → 广播 'ready' 事件。
   */
  private onReady(msg: { version?: string; methods?: string[] }): void {
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer); // 握手完成,看门狗使命结束
      this.spawnTimer = null;
    }
    if (msg.version !== PROTOCOL_VERSION) {
      this.log('error', `protocol version mismatch: ${msg.version}`);
      this.state = 'failed';
      this.rejectAll(new WorkerUnavailableError('protocol version mismatch'));
      this.child?.kill('SIGKILL');
      return;
    }
    this.state = 'ready';
    this.restarts = 0; // 连续失败计数随一次成功握手清零(§5.2)
    this.log('info', 'parse worker ready');
    // 逐个结算等待者,单个回调异常不影响其余
    const waiters = this.readyWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve();
    }
    // flush 握手前排队的请求(§5.1:ready 前 NestJS 侧排队不写 stdin)
    const queued = this.preReadyQueue.splice(0);
    for (const send of queued) {
      send();
    }
    this.events.emit('ready');
  }

  // --------------------------------------------------------------- parsing

  /** stdout 数据到达:累积入缓冲后尝试解析(残片跨 chunk 保留) */
  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  /**
   * 协议解析循环:两种消费模式。
   * 1) 二进制模式(binaryMode 非 null):必须按 length 精确读取裸字节——
   *    内容可能含 0x0A(§2.3),绝不能按行切!读完 payload 后还需消费
   *    尾部 1 字节换行分隔符。
   * 2) 行模式:按 \n 切出一条 JSON 消息;空行跳过;坏行告警丢弃,
   *    单条脏数据不得杀死解析循环。
   * 关键:帧头一旦进入 binaryMode,后续 drain 必须先把帧消费完,
   * 否则帧内容会被当成 JSON 行解析,整个流永久错位。
   */
  private drain(): void {
    for (;;) {
      if (this.binaryMode) {
        const need = this.binaryMode.length + 1; // payload + trailing newline
        if (this.buffer.length < need) {
          return; // 帧字节未到齐:保持 binaryMode 等下一 chunk
        }
        // 精确截取 length 字节(内容可能含 0x0A,按长度而非换行读取)
        const data = Buffer.from(
          this.buffer.subarray(0, this.binaryMode.length),
        );
        this.buffer = this.buffer.subarray(need); // 消费 payload + 尾部换行
        const { frameId, mime } = this.binaryMode;
        this.binaryMode = null; // 帧消费完,回到行模式
        this.onFrame(frameId, { mime, data });
        continue;
      }
      const nl = this.buffer.indexOf(0x0a); // 行模式:找第一条换行
      if (nl < 0) {
        return; // 行未完整,等下一 chunk
      }
      const line = this.buffer.subarray(0, nl).toString('utf8');
      this.buffer = this.buffer.subarray(nl + 1); // 消费该行(含 \n)
      if (!line.trim()) {
        continue; // 空行:跳过(worker 偶发)
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // 坏行只告警丢弃(截断 120 字符防日志洪泛),不让解析循环中断
        this.log('warn', `unparseable worker line: ${line.slice(0, 120)}`);
        continue;
      }
      this.handleMessage(msg);
    }
  }

  /**
   * 按 type 分派 stdout 消息(协议 §2.2):
   *   ready — 握手;binary — 二进制帧头(进入帧读取模式);rpc — 响应;log — 日志。
   * binary 处理要点:只记录帧头(length/mime),不读数据——真正的字节由下一轮
   * drain 的二进制模式消费,这里只是"切换解析模式"。
   */
  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'ready':
        this.onReady(msg);
        return;
      case 'binary':
        // 进入二进制模式:字段做类型防御(frame_id/length/mime 可能缺省或类型错误)
        const length = Number(msg.length);
        if (!Number.isFinite(length) || length < 0) {
          // length 非有限数/负值:无法按长度精确消费裸字节,若进入 binaryMode
          // 会退化为错位解析(NaN 比较恒假 → 空帧被 settle、缓冲原地不动)。
          // 无有效兜底,该帧头按协议违约丢弃,保持行模式不污染后续字节流。
          this.log('warn', `invalid binary frame length: ${String(msg.length)}`);
          return;
        }
        this.binaryMode = {
          frameId:
            typeof msg.frame_id === 'string'
              ? msg.frame_id
              : String(msg.frame_id),
          length,
          mime: typeof msg.mime === 'string' ? msg.mime : 'image/webp',
        };
        return;
      case 'rpc':
        this.onRpc(msg);
        return;
      case 'log':
        this.forwardLog(msg);
        return;
      default:
        this.log('warn', `unknown worker message type: ${String(msg.type)}`);
    }
  }

  /**
   * 二进制帧数据到达(§2.3 装配逻辑)。
   * 两条路径:
   *   - 已有等待者(帧尾到):清等待计时器 → 补删 pending 残留条目(防泄漏,
   *     见下方注释)→ 缓存帧 → settle 请求(rpc 结果原样 resolve);
   *   - 无等待者(帧头先到):暂存 frames,等 rpc 响应到达时在 onRpc 配对。
   */
  private onFrame(frameId: string, frame: ThumbResult): void {
    const waiter = this.frameWaiters.get(frameId);
    if (waiter) {
      clearTimeout(waiter.timer); // 宽限计时器使命结束
      this.frameWaiters.delete(frameId);
      // 尾帧到达后请求已由 onRpc 转入 frameWaiters 治理,这里必须把
      // pending 中残留的条目一并清掉,否则 makeThumb 每次成功调用都
      // 在 pending 里留下一笔永不清理的泄漏
      this.pending.delete(waiter.request.id);
      this.frames.set(frameId, frame);
      this.settle(waiter.request, waiter.result);
      return;
    }
    // 帧先到:入缓存等 rpc(见 onRpc 配对逻辑)
    this.frames.set(frameId, frame);
  }

  /**
   * JSON-RPC 响应处理:按 id 找请求结算;make_thumb 走帧配对逻辑。
   * 错误响应 → WorkerRpcError(清 pending + 停超时计时器);
   * 二进制请求的三种结局:
   *   a) 帧已就位(frames 命中)→ 立即 settle;
   *   b) 帧未到但声明了 frame_id → 转入 frameWaiters,等尾帧(2s 宽限);
   *   c) 无 frame_id → 协议违约,按普通请求 settle(由 makeThumb 侧兜底校验)。
   */
  private onRpc(msg: Record<string, unknown>): void {
    // id 可能是字符串或数字,统一转字符串对齐 pending key
    const rawId = msg.id;
    const id =
      typeof rawId === 'string' || typeof rawId === 'number'
        ? String(rawId)
        : '';
    const req = this.pending.get(id);
    if (!req) {
      return; // 孤儿响应(已由其他路径结算):丢弃
    }
    // 协议 §3.3 错误对象
    const error = msg.error as { code?: number; message?: string } | undefined;
    if (error) {
      this.pending.delete(id);
      clearTimeout(req.timer);
      req.reject(
        new WorkerRpcError(error.code ?? -32603, error.message ?? 'rpc error'),
      );
      return;
    }
    if (req.expectBinary) {
      const result = msg.result as { frame_id?: string } | undefined;
      const frameId = result?.frame_id;
      if (frameId && this.frames.has(frameId)) {
        // 情形 a:帧先到,响应后到 → 立即结算
        this.pending.delete(id);
        this.settle(req, msg.result);
        return;
      }
      if (frameId) {
        // 情形 b:响应先到,帧未到 → 等尾帧(§2.3 健壮性)。
        // Frame trails the response; wait briefly for it (§2.3 robustness).
        // 请求的最终裁决移交给尾帧宽限计时器,原请求超时计时器作废,
        // 避免 10s 请求超时与 2s 宽限竞态造成双路径 reject。
        clearTimeout(req.timer); // 请求超时计时器作废:改由宽限计时器裁决
        const timer = setTimeout(() => {
          this.frameWaiters.delete(frameId);
          this.pending.delete(id);
          req.reject(new WorkerRpcError(-32002, 'binary frame timeout'));
        }, FRAME_GRACE_MS);
        this.frameWaiters.set(frameId, {
          request: req,
          result: msg.result,
          timer,
        });
        return;
      }
      // 情形 c:expectBinary 但无 frame_id:协议违约,按普通请求 settle,
      // makeThumb 侧会因 frames 取不到而抛 -32002
    }
    // 普通请求:直接结算
    this.pending.delete(id);
    this.settle(req, msg.result);
  }

  /** 请求成功结算的收口函数:统一清超时计时器再 resolve。
   *  所有成功路径(onRpc/onFrame)都必须经此,保证计时器不泄漏 */
  private settle(req: PendingRequest, result: unknown): void {
    clearTimeout(req.timer);
    req.resolve(result);
  }

  // ----------------------------------------------------------------- misc

  /**
   * 崩溃/停止时的全量结算:reject 所有在途请求与尾帧等待者,清空帧缓存。
   * 为什么必须处理 frameWaiters:make_thumb 请求转入 frameWaiters 后可能与
   * pending 同时持有同一请求(onRpc 情形 b 不立即删 pending),此处按 id 去重防双重
   * reject;若不处理,worker 崩溃时该 Promise 将永久挂起——
   * 违背"任何请求必有归宿"的不变式。
   * frames 一并清空:帧已随旧进程作废,防陈旧帧污染新进程的 makeThumb。
   */
  private rejectAllInflight(err: Error): void {
    const rejected = new Set<string>();
    const inflight = [...this.pending.values()];
    this.pending.clear();
    for (const req of inflight) {
      clearTimeout(req.timer);
      req.reject(err);
      rejected.add(req.id);
    }
    // frameWaiters 里的请求同样必须 settle:若其已不在 pending
    // (任何路径提前移除),这里显式 reject,保证 makeThumb 挂起请求
    // 在 worker 退出/失败时绝不会永久 pending
    for (const waiter of this.frameWaiters.values()) {
      clearTimeout(waiter.timer);
      // 去重:同一请求若仍留在 pending 中(如帧先到、响应后到前崩溃),
      // 上一循环已 reject,这里跳过防双重 reject
      if (!rejected.has(waiter.request.id)) {
        clearTimeout(waiter.request.timer);
        waiter.request.reject(err);
      }
    }
    this.frameWaiters.clear();
    this.frames.clear();
  }

  /** 终态结算:在途请求 + ready 等待者全部 reject,清空排队发送闭包 */
  private rejectAll(err: Error): void {
    this.rejectAllInflight(err);
    const waiters = this.readyWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(err);
    }
    // 排队闭包作废:worker 已终结,发送无意义
    this.preReadyQueue.length = 0;
  }

  /**
   * stderr 日志通道(协议 §7:每行 JSON 日志)。
   * 与 stdout 不同,stderr 不做跨 chunk 残片拼接:日志行丢失可接受(纯观测);
   * 非 JSON 行(如 Python traceback)按原始文本截断转发,日志不丢不崩。
   */
  private onStderr(chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        this.forwardLog(JSON.parse(line) as Record<string, unknown>);
      } catch {
        this.log('warn', `worker stderr: ${line.slice(0, 200)}`);
      }
    }
  }

  /** 转发结构化日志到本侧 logger;level/msg 缺省给安全默认值 */
  private forwardLog(msg: Record<string, unknown>): void {
    const level = typeof msg.level === 'string' ? msg.level : 'info';
    const text = typeof msg.msg === 'string' ? msg.msg : '';
    this.log(level, `[worker] ${text}`);
  }

  /** 统一日志出口(未注入 logger 时静默,测试友好) */
  private log(level: string, msg: string): void {
    this.options.logger?.(level, msg);
  }
}
