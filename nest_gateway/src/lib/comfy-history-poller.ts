/**
 * ComfyUI history 轮询器。
 *
 * 近实时通道之一:周期性 GET {comfyuiBaseUrl}/history?max_items=20,
 * 发现新完成的 prompt_id 后,把输出图片 resolve 为文件系统路径并加入
 * PendingBuffer(不立即写库,由 flush 循环批量 diff 写入)。
 *
 * - 幂等:已处理 prompt_id 持久化到 Mongo comfy_history 集合
 *   {prompt_id: unique, processed_at},重启后不重复处理历史
 * - 单飞:上一轮未完成时跳过本轮,避免并发轮询
 * - 容错:ComfyUI 不可达时静默跳过(日志降频)
 *
 * 数据流:orchestration.service 构造本 poller → start() 启动定时轮询 →
 * poll() 产出新图片路径 → 写入共享 PendingBuffer → flush 循环统一入库;
 * 状态经 getStatus() 暴露给 /api/sync-status 类读端点。
 */

import { Logger } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';
import type Database from 'better-sqlite3';
import {
  PendingBuffer,
  detectComfyOutputDir,
  parseHistoryImages,
  resolveComfyImagePath,
} from './comfy-pending';

/** 每轮拉取的最大历史条目数(ComfyUI API 分页参数)。 */
const HISTORY_MAX_ITEMS = 20;
/** Mongo 持久化已处理 prompt_id 的集合名。 */
const COLLECTION = 'comfy_history';

export interface ComfyHistoryPollerOptions {
  /** ComfyUI API 地址(末尾斜杠可容忍,内部会归一)。 */
  baseUrl: string;
  /** 轮询间隔(秒)。 */
  pollSeconds: number;
  /** 扫描根目录(路径候选第一优先,与 sync 扫描口径一致)。 */
  scanRoot: string;
  /** 显式配置的 ComfyUI 输出目录;为空时启动自动探测。 */
  comfyOutputDir: string;
  /** 共享的待处理缓冲(与 fs.watch 通道共用)。 */
  buffer: PendingBuffer;
  /** Mongo Db 句柄(comfy_history 集合所在库)。 */
  db: Db;
  /** SQLite 镜像库(双写过渡):提供时 processed 记录同步落 SQLite。 */
  sqliteDb?: Database.Database;
  /** SQLite 单引擎(SQLITE_READ=1):跳过 Mongo 读写。 */
  skipMongo?: boolean;
  /** 日志器(缺省用 Nest 默认)。 */
  logger?: Logger;
}

export class ComfyHistoryPoller {
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  /** 单飞标志:上一轮 poll 未结束时置 true,防重叠轮询。 */
  private running = false;
  /** 最近一次错误信息(供状态端点展示,失败不抛)。 */
  private lastError = '';
  private lastPollAt: Date | null = null;
  /** 内存中的已处理 prompt_id 集合(启动时从持久化恢复)。 */
  private processed = new Set<string>();
  private collection: Collection | null = null;
  /** 实际使用的输出目录(显式配置优先,否则自动探测)。 */
  private resolvedOutputDir = '';

  constructor(private readonly options: ComfyHistoryPollerOptions) {
    this.logger = options.logger ?? new Logger(ComfyHistoryPoller.name);
    // 显式配置优先;空串则等 start() 阶段自动探测
    this.resolvedOutputDir = options.comfyOutputDir;
  }

  /**
   * 轮询器运行状态(供 /api/sync-status 类端点展示)。
   * @returns 运行中/最近轮询时间/最近错误/已处理数/缓冲待处理数/实际输出目录
   */
  getStatus(): {
    running: boolean;
    last_poll_at: string | null;
    last_error: string;
    processed_count: number;
    pending_count: number;
    output_dir: string;
  } {
    return {
      running: this.running,
      last_poll_at: this.lastPollAt ? this.lastPollAt.toISOString() : null,
      last_error: this.lastError,
      processed_count: this.processed.size,
      pending_count: this.options.buffer.size(),
      output_dir: this.resolvedOutputDir,
    };
  }

  /**
   * 启动轮询(幂等:已有定时器直接返回)。
   *
   * 内部逻辑(分步):
   *   1. 输出目录自动探测:显式配置为空时,用 /history 最近一张图
   *      反推输出目录(detectComfyOutputDir);失败仅告警,回退 scanRoot 候选
   *   2. 非 skipMongo:建立 comfy_history 集合并创建 prompt_id 唯一索引
   *      (重复处理防护的 DB 层兜底;索引已存在等异常忽略)
   *   3. 恢复已处理集合:从 Mongo 最近 500 条 + SQLite 最近 500 条合并
   *      —— 重启后不再重复处理历史 prompt
   *   4. 启动 setInterval 定时 poll,并立即先跑一轮(不等第一个周期)
   *
   * 边界:初始化失败仅告警不抛(轮询仍可继续,幂等性由 DB 唯一索引兜底)。
   */
  async start(): Promise<void> {
    if (this.timer) {
      return;
    }
    // 自动探测输出目录:用 /history 最近一张图在候选根中反推
    if (!this.resolvedOutputDir) {
      const detected = await detectComfyOutputDir(
        this.options.baseUrl,
        this.options.scanRoot,
      );
      if (detected) {
        this.resolvedOutputDir = detected;
        this.logger.log(`comfy output dir auto-detected: ${detected}`);
      } else {
        this.logger.warn(
          'comfy output dir 自动探测失败,仅回退 scanRoot 候选;可配置 COMFY_OUTPUT_DIR',
        );
      }
    }
    if (!this.options.skipMongo) {
      const collection = this.options.db.collection(COLLECTION);
      this.collection = collection;
      try {
        await collection.createIndex({ prompt_id: 1 }, { unique: true });
      } catch {
        // 索引已存在等情况:忽略
      }
    }
    // 加载最近已处理的 prompt_id,避免重启后重复处理
    try {
      if (!this.options.skipMongo) {
        const recent = await this.collection
          ?.find({}, { projection: { _id: 0, prompt_id: 1 }, sort: { processed_at: -1 }, limit: 500 })
          .toArray();
        for (const doc of recent ?? []) {
          this.processed.add(String(doc.prompt_id));
        }
      }
      if (this.options.sqliteDb) {
        const sqliteRecent = this.options.sqliteDb
          .prepare(
            'SELECT prompt_id FROM comfy_history ORDER BY processed_at DESC LIMIT 500',
          )
          .all() as Array<{ prompt_id: string }>;
        for (const row of sqliteRecent) {
          this.processed.add(String(row.prompt_id));
        }
      }
      this.logger.log(
        `comfy history poller started (interval=${this.options.pollSeconds}s, restored=${this.processed.size})`,
      );
    } catch (err) {
      this.logger.warn(`comfy history poller init failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 定时轮询 + 立即执行首轮(重启后尽快追平,不空等一个周期)
    this.timer = setInterval(() => this.poll().catch(() => undefined), this.options.pollSeconds * 1000);
    await this.poll();
  }

  /** 停止轮询(清定时器;已恢复的状态集合保留)。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 执行一轮轮询(单飞:running 期间调用直接返回)。
   *
   * 内部逻辑(分步):
   *   1. running 置位 + 记录 lastPollAt
   *   2. GET /history?max_items=20,AbortController + 10s 超时
   *   3. 非 2xx:记录 lastError 后返回(不抛,静默等待下轮)
   *   4. parseHistoryImages 解析;跳过未完成(completed !== true)与
   *      已处理(prompt_id 命中 processed)条目
   *   5. 对每个新完成 prompt:逐 output 图片 resolve 路径并加入缓冲
   *      (仅 type=output;resolve 失败的路径静默跳过,由 sync 扫描兜底);
   *      prompt_id 立即加入 processed(防同轮重复),再持久化
   *   6. finally 复位 running(即使抛错也释放单飞锁)
   *
   * 边界:单条 persistProcessed 失败只告警不中断(唯一索引兜底幂等);
   * 网络/解析异常整体吞进 lastError,轮询循环永不自杀。
   */
  async poll(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastPollAt = new Date();
    try {
      const url = `${this.options.baseUrl.replace(/\/+$/, '')}/history?max_items=${HISTORY_MAX_ITEMS}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let resp: Response;
      try {
        resp = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!resp.ok) {
        this.lastError = `history http ${resp.status}`;
        return;
      }
      const raw = (await resp.json()) as unknown;
      const items = parseHistoryImages(raw);
      let newIds = 0;
      for (const item of items) {
        // 只处理"已完成"且"未处理过"的 prompt
        if (!item.completed || this.processed.has(item.prompt_id)) {
          continue;
        }
        newIds += 1;
        for (const image of item.images) {
          if (image.type !== 'output') {
            continue;
          }
          const path = resolveComfyImagePath(
            image,
            this.options.scanRoot,
            this.resolvedOutputDir,
          );
          if (path) {
            this.options.buffer.add(path);
          }
        }
        // 先入内存集合再持久化:即使持久化失败,本进程内也不会重复入队
        this.processed.add(item.prompt_id);
        await this.persistProcessed(item.prompt_id);
      }
      if (newIds > 0) {
        this.logger.log(
          `comfy history: ${newIds} new completed prompt(s), buffer=${this.options.buffer.size()}`,
        );
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.running = false;
    }
  }

  /**
   * 持久化已处理 prompt_id(Mongo + SQLite 双写)。
   * @param promptId 已处理完成的 prompt_id
   *
   * Mongo:$setOnInsert + upsert——唯一索引冲突(并发/重启重放)时
   * 不覆盖原记录;SQLite:INSERT OR IGNORE 同语义。
   * 双端失败均只告警,不向上抛(轮询主流程不受影响)。
   */
  private async persistProcessed(promptId: string): Promise<void> {
    if (!this.options.skipMongo) {
      try {
        await this.collection?.updateOne(
          { prompt_id: promptId },
          { $setOnInsert: { prompt_id: promptId, processed_at: new Date() } },
          { upsert: true },
        );
      } catch (err) {
        this.logger.warn(
          `persist processed ${promptId} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (this.options.sqliteDb) {
      try {
        this.options.sqliteDb
          .prepare(
            'INSERT OR IGNORE INTO comfy_history(prompt_id, processed_at, doc_json) VALUES (?, ?, ?)',
          )
          .run(
            promptId,
            new Date().toISOString(),
            JSON.stringify({ prompt_id: promptId, processed_at: new Date() }),
          );
      } catch (err) {
        this.logger.warn(
          `persist processed ${promptId} to sqlite failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
