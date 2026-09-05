/**
 * GenerateWorkerSupervisor — NestJS side of the generate_worker JSON-RPC protocol.
 *
 * Mirrors ParseWorkerSupervisor but without binary frame support
 * (generate worker never returns raw bytes — image proxying is done
 * by NestJS calling ComfyUI /view directly).
 *
 * Spawns `python -m workflow_db.generate_worker`, performs ready handshake,
 * dispatches JSON-RPC calls with per-method timeouts, and recovers from
 * crashes with backoff (same lifecycle as parse worker).
 */

/**
 * 【职责概述】GenerateWorkerSupervisor 是网关侧对 Python generate_worker 子进程的
 * RPC 桥接层,负责:
 *   1. 进程管理:spawn `python -m workflow_db.generate_worker`,维护 stopped/starting/
 *      ready/restarting/failed 状态机,崩溃后按指数退避自动重启(与 parse worker 同构);
 *   2. 协议编解码:行分隔 JSON-RPC 2.0(stdin 写请求、stdout 读响应,协议框架同
 *      docs/contracts/parse_worker_protocol.md,仅方法清单不同);
 *   3. 超时控制:按方法配置超时(见 METHOD_TIMEOUTS),超时即 reject 并 kill+重启 worker;
 *   4. 错误映射:worker JSON-RPC error → WorkerRpcError(code,message);
 *      进程不可用(failed/stopping)→ WorkerUnavailableError(HTTP 503 语义);
 *      请求超时 → WorkerRequestTimeout(同时触发重启)。
 *
 * 【与 parse-worker 的差异】本 supervisor 不实现二进制帧通道——generate worker
 * 从不返回原始字节,图片代理由 NestJS 直接调用 ComfyUI /view 完成,
 * 因此没有 binaryMode/frames/frameWaiters 等帧相关逻辑。
 *
 * 【数据流向】
 *   网关(Controller/Service) ── call()/ping() ──▶ stdin(JSON-RPC 行)
 *                                                          │
 *   网关 ◀── onRpc() 按 id 匹配 pending 结算 ── stdout ◀──┘
 *   (ready/log 消息分别驱动握手与日志转发)
 *
 * 【RPC 方法清单】(对应 workflow_db/generate_worker/ 包,方法见其 methods.py METHODS)
 *   ping / build_replay_source / apply_replay_edits / fetch_object_info /
 *   extract_derived_summary / extract_derived_batch /
 *   push_workflow / submit / queue / history / history_by_id
 *   其中重放(重放+编辑工作流)、提交(submit)、ComfyUI 状态查询(queue/history)均在此桥接。
 *
 * 【关键不变式】
 *   - 任何时刻至多一个存活子进程(this.child);
 *   - 每个请求恰好结算一次:响应到达 / 超时 / worker 退出三条路径互斥;
 *   - restart 流程由 expectedExit 标志与 force 参数双守卫防重入。
 */

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';

/**
 * worker 生命周期状态机:
 *   stopped    — 未启动 / 已主动停止(stop() 调用后)
 *   starting   — 已 spawn,等待 ready 握手
 *   ready      — 握手完成,可接受请求
 *   restarting — 崩溃/超时后重启流程进行中(backoff 等待或已 respawn)
 *   failed     — 连续失败达 maxRestarts 的终态,后续调用全部直接 reject(503 语义)
 * 迁移路径:stopped → starting → ready ↔(restarting)↔ starting / failed → stopped
 */
export type WorkerState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'failed';

/**
 * RPC 层错误:worker 侧返回的 JSON-RPC error 对象在网关侧的对应异常。
 * code:通用段(-326xx)与协议 §3.4 一致;业务码 -32010/-32011/-32012 为
 * generate worker 自定义。调用方可按 code 区分失败原因(参数错误/文件缺失/
 * 生成失败等),而非一律视为 500。
 * 注意与另两个错误类型维度不同,不可互换:
 *   WorkerRpcError(业务/协议错误) / WorkerUnavailableError(进程不可用) /
 *   WorkerRequestTimeout(超时)。
 */
export class WorkerRpcError extends Error {
  /**
   * @param code    JSON-RPC 错误码(通用段 -326xx 遵循协议 §3.4;业务码如
   *                -32603 内部错误、-32012 源图不存在、-32010 ComfyUI 不可达)
   * @param message 错误描述文本,透传 worker 侧 message
   */
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerRpcError';
  }
}

/**
 * 进程不可用错误:worker 处于 failed 终态、主动停止、或重启流程中拒绝调用时抛出。
 * 网关上层(Controller)通常将其翻译为 503 语义响应。
 */
export class WorkerUnavailableError extends Error {
  constructor(message = 'generate worker unavailable') {
    super(message);
    this.name = 'WorkerUnavailableError';
  }
}

/**
 * 请求超时错误:超过 METHOD_TIMEOUTS 对应方法阈值仍无响应时抛出。
 * 抛出同时 supervisor 会 kill 并重启 worker——挂起请求意味着 worker 可能已卡死,
 * 单线程串行模型下不换进程后续请求都会超时(协议 §6.2)。
 */
export class WorkerRequestTimeout extends Error {
  constructor(method: string) {
    super(`request timeout: ${method}`);
    this.name = 'WorkerRequestTimeout';
  }
}

/**
 * 在途请求表(pending Map)的条目:id → PendingRequest。
 * 每个 RPC 调用注册一笔,响应到达/超时/崩溃时按 id 取回并结算。
 */
interface PendingRequest {
  /** 请求唯一 id(自增 seq + 时间戳生成),与线上 JSON-RPC 的 id 字段一致 */
  id: string;
  /** 成功结算回调:携带 worker 返回的 result(类型由调用方按方法约定自行断言) */
  resolve: (value: unknown) => void;
  /** 失败结算回调:reject WorkerRpcError / WorkerUnavailableError / WorkerRequestTimeout */
  reject: (err: Error) => void;
  /** 请求超时计时器:到点触发 onRequestTimeout(结算时必须 clearTimeout 防泄漏) */
  timer: NodeJS.Timeout;
}

/**
 * supervisor 构造选项,由 NestJS 服务层从配置(worker.pythonBin / worker.cwd 等)注入;
 * 测试可直接构造(见 crash.spec:pythonBin 传 process.execPath + args 指向 mock 脚本)。
 */
interface SupervisorOptions {
  /** Python 可执行文件路径(或任意可执行程序,测试传 Node 本体) */
  pythonBin: string;
  /** 子进程工作目录,worker 相对路径解析的基准 */
  cwd: string;
  /** 附加启动参数,默认 ['-m', 'workflow_db.generate_worker'];测试注入 mock 脚本路径 */
  args?: string[];
  /** ready 握手超时(毫秒),默认 10_000;超时则 SIGKILL 并按崩溃路径重启(协议 §5.2) */
  spawnTimeoutMs?: number;
  /** 连续失败最大重启次数,默认 3;达到后进入 failed 终态(协议 §5.2) */
  maxRestarts?: number;
  /** 日志回调(level: error|warn|info),NestJS 侧桥接 Logger */
  logger?: (level: string, msg: string) => void;
}

/** Per-method timeouts in ms. */
/**
 * 各 RPC 方法的超时阈值(毫秒)。
 * 原则:重操作(workflow 重放/提交/拉取节点定义)给足时间;轻操作(队列/历史查询)
 * 收紧阈值;ping 必须最短,worker 卡死时能快速暴露。
 * 超时统一走 onRequestTimeout → reject WorkerRequestTimeout + restart;
 * 未列出的方法兜底 30_000ms(见 call())。
 */
const METHOD_TIMEOUTS: Record<string, number> = {
  ping: 2_000, // 健康检查:worker 卡死时必须快速暴露
  build_replay_source: 30_000, // 重放源构建:需拉取/组织工作流历史,耗时最长
  apply_replay_edits: 5_000, // 重放编辑应用:本地 JSON 变换,应瞬时完成
  fetch_object_info: 15_000, // 拉取 ComfyUI 节点定义,跨网络请求
  push_workflow: 10_000, // 向 ComfyUI 推送工作流图
  submit: 15_000, // 提交生成任务(等待 ComfyUI 队列受理)
  queue: 5_000, // 查询 ComfyUI 队列状态
  history: 10_000, // 查询生成历史列表
  history_by_id: 5_000, // 按 id 查单条生成历史
};

/** 协议版本号:与 worker 侧 ready 消息的 version 字段比对,不匹配判握手失败(协议 §8.1) */
const PROTOCOL_VERSION = '1.0';

/**
 * generate_worker 子进程主管(supervisor)。
 * 对外 API:start/stop/waitReady/getState/ping/call;
 * 内部机制:状态机 + 行缓冲协议解析 + pending 请求表 + 指数退避重启。
 * 关键不变式:
 *   - 任何时刻至多一个存活子进程(this.child);
 *   - 每个请求恰有一次 resolve/reject(响应/超时/崩溃三条路径互斥);
 *   - restart 流程由 expectedExit 标志与 force 参数防重入(见 restart/onExit)。
 */
export class GenerateWorkerSupervisor {
  /** 当前存活的子进程句柄;为 null 表示未 spawn 或已退出/已被 restart 接管 */
  private child: ChildProcess | null = null;
  /** 当前生命周期状态(见 WorkerState 类型) */
  private state: WorkerState = 'stopped';
  /** stdout 累积缓冲:按换行切分消息;chunk 边界任意,跨 data 事件保留残片 */
  private buffer: Buffer = Buffer.alloc(0);
  /** 在途请求表 id → PendingRequest;响应/超时/崩溃三条路径按 id 结算 */
  private pending = new Map<string, PendingRequest>();
  /** ready 之前到达的请求:先缓存发送闭包,握手完成后统一 flush(协议 §5.1 排队规则) */
  private preReadyQueue: Array<() => void> = [];
  /** waitReady() 的等待者:worker 就绪时统一 resolve,进入 failed/stop 时统一 reject */
  private readyWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  /** 握手看门狗计时器(spawn 后立即启动,ready 或超时时清除) */
  private spawnTimer: NodeJS.Timeout | null = null;
  /** 本轮连续失败计数;ready 握手成功即清零,累计达 maxRestarts 进入 failed(协议 §5.2) */
  private restarts = 0;
  /** 请求序列号:自增 + 时间戳构成请求 id,保证唯一 */
  private seq = 0;
  /** 停止标志:stop() 置 true,在等待/重启期间检查,阻断一切恢复动作 */
  private stopping = false;
  /** True when the current child was killed by an in-flight restart() — its
   *  exit event must not trigger another restart (P1#6 reentrancy guard). */
  private expectedExit = false;
  /** 内部事件总线:发出 'ready' 与 'failed' 事件,供上层订阅(预留) */
  private readonly events = new EventEmitter();

  /** 构造时固化的握手超时(默认 10_000ms)与最大重启次数(默认 3) */
  private readonly spawnTimeoutMs: number;
  private readonly maxRestarts: number;

  /**
   * @param options 见 SupervisorOptions;spawnTimeoutMs/maxRestarts 未提供时取默认值
   *                (10_000ms / 3 次),与协议 §5.2 的默认口径一致
   */
  constructor(private readonly options: SupervisorOptions) {
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? 10_000;
    this.maxRestarts = options.maxRestarts ?? 3;
  }

  // ------------------------------------------------------------------ API

  /** 读取当前状态(测试与健康检查使用;状态突变全部发生在 supervisor 内部事件回调中) */
  getState(): WorkerState {
    return this.state;
  }

  /**
   * 等待 worker 进入 ready 状态,返回 Promise。
   * - 已 ready:立即 resolve(start() 后由 onReady 批量结算);
   * - 已 failed:立即 reject(WorkerUnavailableError,启动失败同步暴露);
   * - 其他状态:挂入 readyWaiters,由 onReady(resolve)/restart·stop(reject)统一结算,
   *   保证等待者永远不会悬挂。
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
   * 启动 worker 并阻塞等待握手完成。
   * 握手失败(超时/版本不匹配/连续崩溃)会进入 failed 态并 reject,
   * 由调用方(NestJS onModuleInit)决定是否继续启动网关(降级运行)。
   */
  async start(): Promise<void> {
    this.stopping = false; // 重置停止标志:允许本次启动及其重启流程执行
    this.spawnWorker();
    await this.waitReady(); // 挂起直到 onReady resolve 或 failed reject
  }

  /**
   * 主动停止:终止子进程并结算所有挂起请求。
   * 步骤:置停止标志(阻断后续 restart)→ 清握手看门狗 → reject 全部在途请求与
   * ready 等待者 → SIGTERM 子进程。
   * 注意顺序:先置标志后杀进程——exit 事件回调因 stopping 为 true 直接返回,
   * 不会误入 restart 流程。
   */
  stop(): Promise<void> {
    this.stopping = true;
    this.state = 'stopped';
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
      this.spawnTimer = null;
    }
    // 在途请求与 ready 等待者都必须有归宿,否则调用方永久挂起
    this.rejectAll(new WorkerUnavailableError('worker stopped'));
    if (this.child) {
      this.child.kill('SIGTERM'); // 优雅终止(SIGTERM)
      this.child = null;
    }
    return Promise.resolve();
  }

  /** 健康检查:调 worker 的 ping 方法(2s 超时),返回 { pong: true, ... } */
  async ping(): Promise<unknown> {
    return this.call('ping', {});
  }

  /**
   * 发起一次 JSON-RPC 调用(通用入口,ping 及各业务方法均经由此处)。
   * @param method 方法名,同时是 METHOD_TIMEOUTS 的超时查表键
   * @param params RPC 参数对象(与 worker 侧方法签名的 key/value 对应)
   * @returns Promise<unknown>:resolve worker 的 result;reject 三态错误
   *          (WorkerRpcError / WorkerUnavailableError / WorkerRequestTimeout)
   * 关键设计:返回的 Promise 一定有归宿——超时计时器、worker exit、或响应到达
   * 三路互斥结算,调用方不会死锁。
   */
  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    // failed 态直接拒绝:避免请求进入 pending 后无人结算(worker 不会再回来)
    if (this.state === 'failed') {
      return Promise.reject(new WorkerUnavailableError());
    }
    this.seq += 1;
    const id = `req_${this.seq}_${Date.now()}`; // 自增 seq + 时间戳,跨重启也唯一
    return new Promise((resolve, reject) => {
      // 未列入超时表的未知方法兜底 30s,防止极端情况下的无界等待
      const timeoutMs = METHOD_TIMEOUTS[method] ?? 30_000;
      const timer = setTimeout(
        () => this.onRequestTimeout(id, method),
        timeoutMs,
      );
      this.pending.set(id, { id, resolve, reject, timer });
      // send 闭包:ready 后立即写 stdin;未 ready 则入队等 onReady 统一 flush
      // (协议 §5.1:握手完成前请求不写入 stdin,由 NestJS 侧排队)
      const send = () =>
        this.writeLine({
          jsonrpc: '2.0',
          id,
          method,
          params,
        });
      if (this.state === 'ready' && this.child) {
        send();
      } else {
        this.preReadyQueue.push(send);
      }
    });
  }

  // ------------------------------------------------------------ dispatch

  /**
   * 向 worker 写入一行 JSON(行分隔协议:消息必须以 \n 结尾)。
   * stdin 不可写(进程已退出)时静默丢弃——该请求仍由超时/exit 路径结算,不会悬挂。
   */
  private writeLine(payload: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /**
   * 请求超时处理(由 call() 内的 timer 触发):
   * 1) 从 pending 移除并 reject WorkerRequestTimeout——调用方得到明确的"超时"而非挂死;
   * 2) 触发 restart:超时通常意味着 worker 卡死(单线程串行模型下后续请求也会超时),
   *    必须换新进程恢复服务(协议 §6.2)。
   * 若请求已由其他路径结算过(pending 中不存在),直接忽略——保证一次请求仅一次结算。
   */
  private onRequestTimeout(id: string, method: string): void {
    const req = this.pending.get(id);
    if (!req) {
      return;
    }
    this.pending.delete(id);
    req.reject(new WorkerRequestTimeout(method));
    // 注意:force 留空——若此刻已在 restarting(如刚崩溃),本次重启请求被
    // 重入守卫丢弃,不重复计数(见 restart() 守卫注释)
    void this.restart('request-timeout');
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * spawn 子进程并挂接全部 IO 事件。
   * 注意 state 语义:由 restart() 驱动的二次 spawn 保持 'restarting' 状态
   * (重入守卫与 restart 流程都依赖它);首次 spawn 置 'starting'。
   */
  private spawnWorker(): void {
    // 保持 restarting 而非回落 starting:让重入守卫识别"重启流程仍在进行"
    this.state = this.state === 'restarting' ? 'restarting' : 'starting';
    this.expectedExit = false; // 新进程不是被 kill 的,其 exit 需走正常崩溃恢复
    this.log('info', `spawning generate worker (attempt ${this.restarts + 1})`);
    this.buffer = Buffer.alloc(0); // 清空上个进程残留的 stdout 缓冲

    this.child = spawn(
      this.options.pythonBin,
      // 默认以模块方式启动 worker;测试通过 args 注入 mock 脚本路径
      this.options.args ?? ['-m', 'workflow_db.generate_worker'],
      {
        cwd: this.options.cwd,
        // 三个管道全接管:stdin 写请求、stdout 读响应、stderr 读日志(协议 §2.1)
        stdio: ['pipe', 'pipe', 'pipe'],
        // 强制 UTF-8:Windows 下 Python 默认 stdout 为 GBK,JSON-RPC
        // 含中文时会 UnicodeEncodeError(worker 侧另有 reconfigure 兜底)
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      },
    );
    const child = this.child; // 快照:后续回调用它判别"是否仍是当前进程"

    // stdout:协议消息通道(ready/rpc/log);error 事件(如 EPIPE)只记录不抛出,
    // 否则 Node 会把流错误升级为未捕获异常,杀死整个网关进程(P3#34)
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stdout?.on('error', (err) => {
      // EPIPE 等流错误:吞掉并打 log,避免未捕获异常杀死网关(P3#34)
      this.log('warn', `worker stdout stream error: ${err.message}`);
    });
    // stderr:结构化日志通道(逐行 JSON,见 onStderr)
    child.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk));
    child.stderr?.on('error', (err) => {
      this.log('warn', `worker stderr stream error: ${err.message}`);
    });
    child.stdin?.on('error', (err) => {
      this.log('warn', `worker stdin stream error: ${err.message}`);
    });
    child.on('error', (err) => {
      // 只有"当前进程"的 error 才处理;被 restart() 替换掉的旧进程回调一律忽略,
      // 防止陈旧事件与恢复流程竞态
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

    // 握手看门狗:spawn 后立即启动,ready 前超时则 SIGKILL。
    // 被 kill 的 child 触发 exit → onExit → 走崩溃恢复(force 路径)
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
    }
    this.spawnTimer = setTimeout(() => {
      this.log('error', 'worker ready handshake timed out');
      this.child?.kill('SIGKILL');
    }, this.spawnTimeoutMs);
  }

  /**
   * 崩溃/超时恢复流程:kill 旧进程 → 指数退避 → respawn。
   * @param reason 重启原因(仅用于日志)
   * @param force  重入守卫的放行开关——true 表示这是恢复流程自身的推进器
   *               (exit / spawn-error / 握手超时),必须放行,见下方守卫逻辑
   *
   * 流程:1) 结算所有在途请求(WorkerUnavailableError,协议 §6.4:不重试,防双写);
   *      2) restarts+1;达到 maxRestarts → 进入 failed 终态,拒绝一切后续调用;
   *      3) 未达上限 → 指数退避(200ms×2^n,封顶 2s)后重新 spawn。
   */
  private async restart(reason: string, force = false): Promise<void> {
    // 已停止或已 failed:不再做任何恢复动作
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
    this.log('warn', `restarting generate worker: ${reason}`);
    this.state = 'restarting'; // 立即置位:让此后的重入调用在守卫处短路
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer); // 握手看门狗作废,避免与 kill 竞态
      this.spawnTimer = null;
    }
    // 在途请求全部 reject:worker 已不可信,响应永远不会来了
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
      // 达到上限进入终态:restarts 在下一次 onReady 前不会被清零,
      // 因此第 maxRestarts 次重启失败即判定 failed(与协议 §5.2 对齐)
      this.state = 'failed';
      this.rejectAll(new WorkerUnavailableError('worker failed'));
      this.events.emit('failed');
      return;
    }
    // 指数退避:200ms 起步 ×2,封顶 2s——崩溃风暴下避免高频 respawn 打满 CPU
    const backoff = Math.min(200 * 2 ** (this.restarts - 1), 2_000);
    await new Promise((resolve) => setTimeout(resolve, backoff));
    // 退避期间若收到 stop(),放弃本次重启(退出条件检查)
    if (!this.stopping) {
      this.spawnWorker();
    }
  }

  /**
   * 子进程退出回调(exit 事件)。
   * 四条退出路径的判别:
   *   - 陈旧进程的退出(child !== this.child):忽略(已被 restart 接管);
   *   - stop() 主动停止(stopping):忽略,进程生命周期到此结束;
   *   - 本进程被 restart() kill(expectedExit):吞掉,重启由 restart 流程自身推进;
   *   - 其余(自然崩溃):清句柄后以 force=true 进入 restart——之所以 force,
   *     是因为此时若已在 restarting(新进程未 ready 又崩),不 force 会被守卫丢弃,
   *     恢复流程将永久停滞。
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
      return; // stop() 已在收尾,退出事件无需处理
    }
    this.log('warn', `worker exited code=${code} signal=${signal}`);
    if (this.expectedExit) {
      // 本 child 是 restart() 主动 kill 的,restart 流程自身继续(backoff +
      // respawn),这里不再触发第二次 restart
      this.expectedExit = false;
      this.child = null;
      return;
    }
    this.child = null; // 先清句柄:后续 restart 的 kill 判断不会误伤
    // force:见 restart() 重入守卫注释——自然退出的恢复必须放行
    void this.restart(`exit code=${code} signal=${signal}`, true);
  }

  /**
   * 处理 ready 握手消息(协议 §5.1 第 4 步):
   * 1) 清除握手看门狗(握手完成,不再需要超时杀进程);
   * 2) 版本校验(协议 §8.1):不匹配直接进入 failed 终态——协议不兼容的 worker
   *    即使跑起来也会产生语义错乱的响应,不如永久停用;
   * 3) 置 ready、清零 restarts(连续失败计数随一次成功握手归零,协议 §5.2);
   * 4) 结算 readyWaiters(await start() 的调用方)并 flush preReadyQueue:
   *    握手前排队的所有请求此刻按序写入 stdin,保持"先到先服务"顺序。
   */
  private onReady(msg: { version?: string; methods?: string[] }): void {
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer); // 握手完成,关闭看门狗
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
    this.restarts = 0; // 成功的握手重置连续失败计数
    this.log('info', 'generate worker ready');
    // 批量结算等待者:逐个 resolve,任一回调抛错不影响其他等待者
    const waiters = this.readyWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve();
    }
    // flush 握手前排队的请求(协议 §5.1 第 5 条:NestJS 侧排队,ready 后派发)
    const queued = this.preReadyQueue.splice(0);
    for (const send of queued) {
      send();
    }
    this.events.emit('ready');
  }

  // --------------------------------------------------------------- parsing

  /** stdout 数据到达:追加进累积缓冲并尝试切行解析。
   *  必须保留跨 chunk 的残片:一条消息可能被管道切成多段,行尾可能落在任意 chunk 边界 */
  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  /**
   * 行缓冲解析器:循环取出一条完整行(不含 \n)并派发。
   * 健壮性设计:
   *   - 无换行(消息未到齐)→ 直接返回等下一个 chunk(残片留在 buffer);
   *   - 空行跳过(worker 偶发空行,不视为协议消息);
   *   - JSON 解析失败只告警并丢弃该行——单条坏行绝不能杀死解析循环,
   *     否则一条脏数据会让 worker 永久失去响应能力。
   */
  private drain(): void {
    for (;;) {
      const nl = this.buffer.indexOf(0x0a); // 定位第一条换行
      if (nl < 0) {
        return; // 残片不足,等下一 chunk
      }
      const line = this.buffer.subarray(0, nl).toString('utf8');
      this.buffer = this.buffer.subarray(nl + 1); // 消费掉该行(含换行)
      if (!line.trim()) {
        continue; // 空行:跳过
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // 坏行:截断记录前 120 字符,防日志洪泛
        this.log('warn', `unparseable worker line: ${line.slice(0, 120)}`);
        continue;
      }
      this.handleMessage(msg);
    }
  }

  /**
   * 按 type 字段分派 stdout 消息(协议 §2.2 消息类型):
   *   ready — 握手;rpc — JSON-RPC 响应(成功/错误);log — 结构化日志。
   * 未知类型仅告警:协议演进期 worker 新增消息类型不应导致网关崩溃。
   */
  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'ready':
        this.onReady(msg);
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
   * 处理 JSON-RPC 响应:按 id 找回 pending 请求并结算。
   * - id 缺失/类型非法 → 转成空串,必然查不到请求,安全返回(忽略孤儿响应);
   * - 找不到对应请求(已超时/已因崩溃 reject)→ 忽略:结算只发生一次;
   * - 带 error 字段 → 映射为 WorkerRpcError(code 缺省 -32603 内部错误,协议 §3.3);
   * - 否则 → resolve result(类型由调用方按方法约定自行断言)。
   */
  private onRpc(msg: Record<string, unknown>): void {
    // worker 侧 id 可能是字符串或数字,统一转字符串与 pending key 对齐
    const rawId = msg.id;
    const id =
      typeof rawId === 'string' || typeof rawId === 'number'
        ? String(rawId)
        : '';
    const req = this.pending.get(id);
    if (!req) {
      return; // 孤儿响应(已由其他路径结算):直接丢弃
    }
    this.pending.delete(id);
    clearTimeout(req.timer); // 停止超时计时器,防泄漏
    // 协议 §3.3:error 对象结构 { code, message }
    const error = msg.error as { code?: number; message?: string } | undefined;
    if (error) {
      // code 缺省 -32603:worker 未给码时按"内部错误"兜底(协议 §3.4)
      req.reject(
        new WorkerRpcError(error.code ?? -32603, error.message ?? 'rpc error'),
      );
      return;
    }
    req.resolve(msg.result);
  }

  // ----------------------------------------------------------------- misc

  /** 批量结算所有在途请求(reject):崩溃/重启/停止时调用。
   *  先快照再清表:reject 回调可能同步发起新请求,避免遍历期间修改 Map;
   *  每个请求同时清除超时计时器,防止计时器在 worker 已死之后继续触发 restart */
  private rejectAllInflight(err: Error): void {
    const inflight = [...this.pending.values()];
    this.pending.clear();
    for (const req of inflight) {
      clearTimeout(req.timer);
      req.reject(err);
    }
  }

  /** 终态结算:reject 全部在途请求 + 全部 ready 等待者,并清空排队请求。
   *  readyWaiters 不结算的话,await start()/waitReady() 会永久挂起 */
  private rejectAll(err: Error): void {
    this.rejectAllInflight(err);
    const waiters = this.readyWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(err);
    }
    // 排队中的发送闭包作废:worker 不会回来了,继续持有无意义
    this.preReadyQueue.length = 0;
  }

  /** stderr 日志通道(协议 §7:每行必须是 JSON 日志)。
   *  chunk 切分可能导致单行跨 chunk,但日志行丢失可接受(纯观测用途);
   *  解析失败退化为原始文本记录,保证日志不丢、不崩 */
  private onStderr(chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        this.forwardLog(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // 非 JSON 行(如 Python traceback):截断后按原始文本转发
        this.log('warn', `worker stderr: ${line.slice(0, 200)}`);
      }
    }
  }

  /** 转发 worker 日志到本侧 logger:字段缺失时给安全默认值;worker 侧无 ts 字段
   *  (协议 §7 注),时间戳由本侧日志系统在收到时刻补打 */
  private forwardLog(msg: Record<string, unknown>): void {
    const level = typeof msg.level === 'string' ? msg.level : 'info';
    const text = typeof msg.msg === 'string' ? msg.msg : '';
    this.log(level, `[worker] ${text}`);
  }

  /** 统一日志出口:未注入 logger(如测试)时静默 */
  private log(level: string, msg: string): void {
    this.options.logger?.(level, msg);
  }
}
