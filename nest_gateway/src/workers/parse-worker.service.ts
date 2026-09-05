/**
 * ParseWorkerService — ParseWorkerSupervisor 的 NestJS 服务层封装:
 *   - 生命周期桥接:onModuleInit 启动 worker / onModuleDestroy 停止 worker;
 *   - 配置注入:worker.pythonBin / worker.cwd / worker.spawnTimeoutMs /
 *     worker.maxRestarts → SupervisorOptions;
 *   - 日志桥接:supervisor 回调 → NestJS Logger 分级输出;
 *   - 入库期 IP 归属:parseImage 出口把 prompt 里的角色名归属成 IP 词
 *     追加进 search_text(danbooru charIps/bareIps 查表),查询侧
 *     expandIpChars 只展开系列家族 IP 词 —— 两段式设计见 danbooru.ts。
 * 业务能力(parseImage / makeThumb / ping / call)继承自 ParseWorkerSupervisor。
 * 数据流向:图片处理业务 → ParseWorkerService.parseImage/makeThumb →
 *          stdin(JSON-RPC)→ Python parse_worker → stdout(响应 + 二进制帧)
 *          → 结算返回。
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Database from 'better-sqlite3';
import { ParseWorkerSupervisor } from './parse-worker';
import { appendIpAttribution, sharedDanbooru } from '../sqlite/danbooru';

@Injectable()
export class ParseWorkerService
  extends ParseWorkerSupervisor
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ParseWorkerService.name);
  /** danbooru 归属连接(懒开;undefined = 未初始化,null = 库缺失)。 */
  private danbooruDb: Database.Database | null | undefined;
  /** onModuleInit 发起的启动流程;错误已在 catch 内结算,永不 reject。 */
  private startPromise: Promise<void> = Promise.resolve();

  /**
   * @param config NestJS 配置服务;全部参数来自 worker.* 配置节,
   *               未配置项由 supervisor 缺省值兜底
   */
  private readonly configRef: ConfigService;

  constructor(config: ConfigService) {
    super({
      // Python 可执行文件(worker.pythonBin,默认 'python')
      pythonBin: config.get<string>('worker.pythonBin') ?? 'python',
      // 子进程工作目录(worker.cwd,默认网关进程目录)
      cwd: config.get<string>('worker.cwd') ?? process.cwd(),
      // 握手超时(ms),缺省 10_000(协议 §5.2)
      spawnTimeoutMs: config.get<number>('worker.spawnTimeoutMs'),
      // 最大重启次数,缺省 3(协议 §5.2)
      maxRestarts: config.get<number>('worker.maxRestarts'),
      // 日志桥接:supervisor 分级日志 → NestJS Logger
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
    this.configRef = config;
  }

  /**
   * 模块初始化:发起 parse worker 启动,但不在模块初始化链内等待 ready 握手 ——
   * 两个 python worker(generate/parse)因此并行冷启动,由 main.ts 在 listen 前
   * 统一 await whenReady() 汇合。
   * 启动失败不阻断网关启动:supervisor 停留在 failed 态,依赖它的接口
   * 返回 503,待配置修复后可通过重启网关恢复(协议 §5.2 的降级口径)。
   */
  onModuleInit(): void {
    this.startPromise = this.start().catch((err: unknown) => {
      // Total worker startup failure must not take the gateway down;
      // the supervisor stays in `failed` state and endpoints return 503
      // (protocol §5.2).
      this.logger.error(
        `parse worker failed to start, continuing without it: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    // danbooru 归属连接尽早打开(内部 setImmediate 后台预热索引,
    // 首次 parseImage 即走内存查表);缺库/失败静默降级(归属跳过)
    this.getDanbooru();
  }

  /**
   * 启动流程汇合点(main.ts 在 app.listen 前等待):返回的 promise 已在
   * catch 内消化过启动失败,永不 reject,等待即代表"已就绪或已定论降级"。
   */
  whenReady(): Promise<void> {
    return this.startPromise;
  }

  /** 模块销毁:停止 worker(SIGTERM),避免网关退出遗留孤儿子进程 */
  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /**
   * danbooru 归属连接(共享单例,见 sharedDanbooru):与 tags/images
   * 模块的 provider 复用同一连接,IpCharIndex 索引全进程只构建一次。
   * tagSuggest.enabled=false 或库缺失 → null(归属整体跳过)。
   */
  private getDanbooru(): Database.Database | null {
    if (this.danbooruDb === undefined) {
      const tagSuggest = (this.configRef.get<{
        enabled?: boolean;
        dbPath?: string;
      }>('tagSuggest') ?? {}) as { enabled?: boolean; dbPath?: string };
      this.danbooruDb =
        tagSuggest.enabled === false
          ? null
          : sharedDanbooru(tagSuggest.dbPath ?? '');
    }
    return this.danbooruDb;
  }

  /**
   * 解析单张图片(supervisor RPC)+ 入库期 IP 归属注入:
   * record.prompts.search_text 追加角色名归属出的 IP 词。
   * best-effort —— 库缺失/归属异常时原样返回,不影响解析链路;
   * 调用方(ingest / watcher / 生成归档)拿到的 search_text 与
   * 落库形态一致,无论落 Mongo 还是 SQLite(含双写期)入库层均无需各自处理。
   */
  async parseImage(
    path: string,
    scanRoot: string,
  ): Promise<Record<string, unknown>> {
    const record = await super.parseImage(path, scanRoot);
    try {
      const prompts = record.prompts as
        | { positive?: unknown; search_text?: unknown }
        | undefined;
      const next = appendIpAttribution(this.getDanbooru(), prompts);
      if (next !== null && prompts) {
        record.prompts = { ...prompts, search_text: next };
      }
    } catch (err) {
      this.logger.debug(
        `ip attribution skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return record;
  }
}
