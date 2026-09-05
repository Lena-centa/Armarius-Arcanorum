/**
 * GenerateWorkerService — NestJS 服务层对 GenerateWorkerSupervisor 的薄封装:
 *   - 生命周期挂接:onModuleInit 启动 worker / onModuleDestroy 停止 worker;
 *   - 配置注入:worker.pythonBin / worker.cwd / worker.spawnTimeoutMs /
 *     worker.maxRestarts → SupervisorOptions;
 *   - 日志桥接:supervisor 的裸回调日志分级转发到 NestJS Logger。
 * 其余能力(start/call/ping/waitReady 等)直接继承自 GenerateWorkerSupervisor。
 * 数据流向:Controller/Service → GenerateWorkerService(call)→ stdin(JSON-RPC)→
 *           Python generate_worker → stdout → 回调结算 → 调用方。
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GenerateWorkerSupervisor } from './generate-worker';

@Injectable()
export class GenerateWorkerService
  extends GenerateWorkerSupervisor
  implements OnModuleInit, OnModuleDestroy
{
  /** NestJS 日志器:按日志级别分发 supervisor 的日志回调 */
  private readonly logger = new Logger(GenerateWorkerService.name);

  /** onModuleInit 发起的启动流程;错误已在 catch 内结算,永不 reject。 */
  private startPromise: Promise<void> = Promise.resolve();

  /**
   * @param config NestJS 配置服务;supervisor 参数全部来自 worker.* 配置节,
   *               未配置项回落默认值('python' / 进程 cwd / 10s / 3 次重启)
   */
  constructor(config: ConfigService) {
    super({
      // worker.pythonBin:Python 可执行文件;未配置时假设 PATH 中有 python
      pythonBin: config.get<string>('worker.pythonBin') ?? 'python',
      // worker.cwd:子进程工作目录(默认网关进程目录,相对路径解析的基准)
      cwd: config.get<string>('worker.cwd') ?? process.cwd(),
      // 握手超时(ms);缺省由 supervisor 兜底 10s(协议 §5.2)
      spawnTimeoutMs: config.get<number>('worker.spawnTimeoutMs'),
      // 最大重启次数;缺省由 supervisor 兜底 3 次(协议 §5.2)
      maxRestarts: config.get<number>('worker.maxRestarts'),
      // 日志桥接:supervisor 的 level 字符串映射到 NestJS Logger 分级方法
      logger: (level, msg) => {
        if (level === 'error') {
          this.logger.error(msg);
        } else if (level === 'warn') {
          this.logger.warn(msg);
        } else {
          this.logger.log(msg);
        }
      },
    });
  }

  /**
   * 模块初始化钩子:发起 worker 启动,但不在模块初始化链内等待 ready 握手 ——
   * 两个 python worker(generate/parse)因此并行冷启动,由 main.ts 在 listen 前
   * 统一 await whenReady() 汇合。
   * 失败不阻断网关:worker 属于外部依赖,不可用时网关仍应存活
   * (supervisor 进入 failed 态,后续调用直接返回 WorkerUnavailableError,
   * 由 Controller 映射为 503)——"降级运行"而非"级联失败"。
   */
  onModuleInit(): void {
    this.startPromise = this.start().catch((err: unknown) => {
      this.logger.error(
        `generate worker failed to start, continuing without it: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /**
   * 启动流程汇合点(main.ts 在 app.listen 前等待):返回的 promise 已在
   * catch 内消化过启动失败,永不 reject,等待即代表"已就绪或已定论降级"。
   */
  whenReady(): Promise<void> {
    return this.startPromise;
  }

  /** 模块销毁钩子:优雅停止 worker(SIGTERM),保证网关退出时不留孤儿进程 */
  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }
}
