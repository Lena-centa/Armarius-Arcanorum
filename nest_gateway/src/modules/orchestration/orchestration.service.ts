/**
 * orchestration 模块 —— 核心编排服务(orchestration.service.ts)
 *
 * 职责:后台数据管道的总控,维护"文件系统 → 数据库"的近实时同步链路:
 *   1. 全量同步循环(syncLoop):定时 ingest(scan + parse + diff 入库),
 *      是全量 diff 兜底,默认 300 秒一轮
 *   2. 近实时通道:ComfyUI history 轮询 + Windows 递归 fs.watch,
 *      事件只进内存缓冲(PendingBuffer),flush 循环按 mtime/size diff 后批量入库
 *   3. watcher webhook:Windows FileSystemWatcher 推送到 controller 的事件入口
 *   4. 备份:代理给 BackupService(定时器 + mongodump / SQLite 备份)
 *   5. recipe_groups 自愈:启动时与每次同步后检查覆盖率,不足 95% 重建
 *
 * 存储双轨:SQLITE_READ=1 切读(读与写主落 SQLite)、SQLITE_DUAL_WRITE=1 双写
 * (Mongo + SQLite 同时落)、WORKFLOW_DB_REMOTE=1 纯远程(不建本地库、不扫描)。
 *
 * 内存视图:缓冲路径解析缓存(memoryRecords,path → record),查询端点
 * 把"已解析未入库"的数据合并返回,flush 入库后清空。
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import type Database from 'better-sqlite3';
import { SQLITE_DB } from '../../sqlite/sqlite.module';
import {
  existsSync,
  statSync,
  watch,
  FSWatcher,
} from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import {
  Images,
  ImagesDocument,
  StatsDocs,
  StatsDocsDocument,
  StatsSummaries,
  StatsSummariesDocument,
  RecipeGroups,
  RecipeGroupsDocument,
} from '../../schemas';
import { ParseWorkerService } from '../../workers/parse-worker.service';
import { ingest, SyncProgress } from '../../lib/ingest';
import { rebuildRecipeGroups } from '../../lib/recipe_groups';
import {
  upsertSingleRecord,
  removeSingleRecordByPath,
} from '../../lib/archive';
import {
  ComfyHistoryPoller,
} from '../../lib/comfy-history-poller';
import { PendingBuffer, isImageFile } from '../../lib/comfy-pending';
import { imageEntryFromRecord } from '../../lib/archive';
import { normalizePathForPlatform } from '../../lib/paths';
import { recipeCoverage } from '../../sqlite/reader';
import { readBatchByPath } from '../../sqlite/repo';
import { rebuildRecipeGroupsSqlite } from '../../lib/recipe_groups';
import { InstanceStamp, instanceStamp } from '../../lib/instance';
import { BackupService } from './backup.service';

/** 读 SQLite 批次内单条图片的 size/mtime(flush diff 用)。 */
/**
 * 从 SQLite 的 batch_images 表读取单条图片记录的 mtime_ns / size_bytes,
 * 供 flushPending 与存量记录做"是否有变化"的比对(避免全量重新解析)。
 * @param db SQLite 数据库实例
 * @param batchKey 批次键(batch_key)
 * @param path 图片绝对路径(resolved_path)
 * @returns { mtimeNs, sizeBytes } 均可能为 null(记录缺失/字段为空);
 *          整行不存在时返回 null
 */
function dbImageByPath(
  db: import('better-sqlite3').Database,
  batchKey: string,
  path: string,
): { mtimeNs: number | null; sizeBytes: number | null } | null {
  const row = db
    .prepare(
      'SELECT mtime_ns AS mtimeNs, size_bytes AS sizeBytes FROM batch_images WHERE batch_key = ? AND resolved_path = ?',
    )
    .get(batchKey, path) as { mtimeNs: number | null; sizeBytes: number | null } | undefined;
  return row ? { mtimeNs: row.mtimeNs, sizeBytes: row.sizeBytes } : null;
}

/**
 * 同步状态(供 /api/sync-status 展示):
 *   running        当前是否有同步在执行(防重入)
 *   hasUpdates     是否存在尚未被客户端 ack 的更新
 *   changeVersion  数据变更版本号(每次 sync 有 new/changed/removed 时 +1)
 *   lastSummary    最近一次同步的摘要(discovered/parsed/new/changed...)
 *   lastRunAt      最近一次同步完成时间
 *   error          最近一次失败原因(成功后清空)
 *   progress       运行中的实时进度(空闲时为 undefined)
 */
interface SyncState {
  running: boolean;
  hasUpdates: boolean;
  changeVersion: number;
  lastSummary?: Record<string, unknown>;
  lastRunAt?: Date;
  error?: string;
  /** 运行中的实时进度(空闲时为 undefined,供 /api/sync-status 展示)。 */
  progress?: SyncProgress;
}

/**
 * watcher 状态(供 /api/watcher/status 展示):
 *   running         当前是否在处理事件(同步防重入)
 *   lastEventAt     最近一次收到事件的时间
 *   lastEventType   最近一次事件类型(created/changed/deleted)
 *   processedCount  累计成功处理的事件数
 *   error           最近一次处理失败的原因
 */
interface WatcherState {
  running: boolean;
  lastEventAt?: Date;
  lastEventType?: string;
  processedCount: number;
  error?: string;
}

/**
 * watcher webhook 路径白名单校验:
 * resolved_path resolve 后必须落在任一允许根(scanRoot / comfyOutputDir)内,
 * 否则拒绝(不解析、不删记录)。
 *
 * 实现要点:resolve 归一化路径后,若 target 位于 root 之下,则 relative 结果
 * 要么是空串(路径即根本身)、要么不以 '..' 开头且不是绝对路径 —— 以此
 * 同时挡住 ../ 越界与绝对路径逃逸两种写法。
 * @param resolvedPath watcher 上报的绝对路径
 * @param allowedRoots 允许的根目录列表(scanRoot、comfyOutputDir)
 * @returns 通过返回 { ok: true };否则返回 { ok: false, error: 原因 }
 */
export function isAllowedWatcherPath(
  resolvedPath: string,
  allowedRoots: readonly string[],
): { ok: true } | { ok: false; error: string } {
  const path = (resolvedPath ?? '').trim();
  if (!path) {
    return { ok: false, error: 'missing resolved_path' };
  }
  // 根目录统一 resolve 并过滤空值(scanRoot 可能未配置)
  const roots = allowedRoots.map((root) => resolve(root)).filter(Boolean);
  if (roots.length === 0) {
    return {
      ok: false,
      error: 'no allowed roots configured (COMFY_SCAN_ROOT / COMFY_OUTPUT_DIR)',
    };
  }
  const target = resolve(path);
  for (const root of roots) {
    // relative(root, target):越界时结果为 ../ 前缀或绝对路径,均可判定拒绝
    const rel = relative(root, target);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      return { ok: true };
    }
  }
  return { ok: false, error: `path outside allowed roots: ${path}` };
}

/**
 * OrchestrationService — 后台循环 + 近实时通道 + watcher webhook + backup。
 *
 * 定时任务(@nestjs/schedule):
 *   - syncLoop: 默认 300s,调 ingest(scan + parse + bulkWrite)全量 diff 兜底
 *   - backupLoop: 每小时,调 mongodump via child_process
 *   - recipeGroupsSelfHeal: 启动时 + 每次同步后检查覆盖率
 *
 * 近实时通道(实时事件只进内存缓冲,flush 循环批量 diff 入库):
 *   - comfyPoller: 轮询 ComfyUI /history,新完成生成 → 图片路径入缓冲
 *   - fsWatcher: Windows 原生下递归 fs.watch(非 win32 自动降级)
 *   - flushLoop: 周期处理缓冲,与 Mongo 按 mtime/size diff,变化才解析写入
 *
 * Watcher webhook 由 controller 调用此 service 的方法。
 *
 * 实例字段说明:
 *   scanRoot / comfyOutputDir  扫描根目录与 ComfyUI 输出目录(路径白名单根)
 *   syncIntervalMs / flushMs   同步周期与缓冲 flush 周期(毫秒)
 *   syncTimer / flushTimer     两个 setInterval 句柄
 *   fsWatcher / comfyPoller    近实时通道的句柄
 *   pendingBuffer              待处理路径内存缓冲(带 attempts 重试计数)
 *   memoryRecords              内存视图缓存(path → 解析 record)
 *   dualWrite / readMode / remoteMode  存储三开关
 *   instanceStamp              多网关实例打标
 *   memoryViewResolving        内存视图解析互斥锁(防并发重复解析)
 */
@Injectable()
export class OrchestrationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrchestrationService.name);
  private readonly scanRoot: string;
  private readonly syncIntervalMs: number;
  private readonly comfyOutputDir: string;
  private readonly flushMs: number;
  private syncTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private fsWatcher: FSWatcher | null = null;
  private comfyPoller: ComfyHistoryPoller | null = null;
  private readonly pendingBuffer = new PendingBuffer();
  private flushRunning = false;
  private lastFlushAt: Date | null = null;
  private lastFlushSummary: Record<string, unknown> | null = null;
  /** 内存视图:缓冲路径的解析缓存(path → record),供查询合并;flush 后清空。 */
  private readonly memoryRecords = new Map<string, Record<string, unknown>>();
  /** SQLite 双写开关(SQLITE_DUAL_WRITE=1)。 */
  private readonly dualWrite: boolean;
  /** SQLite 切读开关(SQLITE_READ=1)。 */
  private readonly readMode: boolean;
  /** 纯远程开关(WORKFLOW_DB_REMOTE=1):不建本地库、不扫描,仅连远端 Mongo。 */
  private readonly remoteMode: boolean;
  /** 多网关实例打标(入库逐图片 source)。 */
  private readonly instanceStamp: InstanceStamp;
  /** Danbooru tag 补全参考(可选):总开关与 GNN 资产目录(空=禁用预计算)。 */
  private readonly tagSuggestEnabled: boolean;
  private readonly danbooruAssets: string;
  private memoryViewResolving = false;

  /** 同步状态(对外只读字段,由 runSync 更新)。 */
  readonly syncState: SyncState = {
    running: false,
    hasUpdates: false,
    changeVersion: 0,
  };
  /** watcher 状态(对外只读字段,由 handleWatcherEvent / fs 回调更新)。 */
  readonly watcherState: WatcherState = { running: false, processedCount: 0 };

  constructor(
    private readonly config: ConfigService,
    private readonly parseWorker: ParseWorkerService,
    private readonly backup: BackupService,
    @InjectModel(Images.name)
    private readonly imagesModel: Model<ImagesDocument>,
    @InjectModel(StatsDocs.name)
    private readonly statsDocsModel: Model<StatsDocsDocument>,
    @InjectModel(StatsSummaries.name)
    private readonly statsSummaryModel: Model<StatsSummariesDocument>,
    @InjectModel(RecipeGroups.name)
    private readonly recipeGroupModel: Model<RecipeGroupsDocument>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(SQLITE_DB) private readonly sqliteDb: Database.Database,
  ) {
    // 从配置加载全部运行参数;缺省:扫描根空串、同步 300s、ComfyUI 输出目录空、
    // flush 15s、不双写、不切读、非纯远程;实例打标按配置生成
    this.scanRoot = this.config.get<string>('scanRoot') ?? '';
    this.syncIntervalMs =
      (this.config.get<number>('syncIntervalSeconds') ?? 300) * 1000;
    this.comfyOutputDir = this.config.get<string>('comfyOutputDir') ?? '';
    this.flushMs = (this.config.get<number>('flushSeconds') ?? 15) * 1000;
    this.dualWrite = this.config.get<boolean>('sqlite.dualWrite') ?? false;
    this.readMode = this.config.get<boolean>('sqlite.readMode') ?? false;
    this.remoteMode = (process.env.WORKFLOW_DB_REMOTE ?? '0') === '1';
    this.instanceStamp = instanceStamp(this.config);
    const tagSuggest =
      this.config.get<{ enabled?: boolean; assetsDir?: string }>('tagSuggest') ??
      {};
    this.tagSuggestEnabled = tagSuggest.enabled !== false;
    this.danbooruAssets = (tagSuggest.assetsDir ?? '').trim();
  }

  async onModuleInit(): Promise<void> {
    // 纯远程模式:无本地扫描/近实时通道,仅读远端 Mongo;首启无库时不启动任何后台循环
    if (this.remoteMode) {
      this.logger.log(
        '纯远程模式(WORKFLOW_DB_REMOTE=1):不启动 sync/watcher/comfy 轮询,仅连接远端 MongoDB',
      );
      return;
    }
    // 配置健康检查:扫描根缺失 / 不存在、备份目录缺失时仅告警不中断启动
    if (!this.scanRoot) {
      this.logger.warn(
        'COMFY_SCAN_ROOT 未配置:同步/解析功能停用,请设置图片扫描根目录',
      );
    } else if (!existsSync(this.scanRoot)) {
      this.logger.warn(`COMFY_SCAN_ROOT 不存在,同步将空转: ${this.scanRoot}`);
    }
    if (!this.backup.enabled) {
      this.logger.warn('WORKFLOW_DB_BACKUP_DIR 未配置:备份循环停用');
    }
    // 启动时自恢复 recipe_groups
    await this.recipeGroupsSelfHeal();
    // 启动定时任务
    this.startSyncLoop();
    this.backup.startLoop();
    // 近实时通道
    this.startComfyPoller();
    this.startFlushLoop();
    this.startFsWatcher();
    // 空库友好:启动即触发一次同步(可用 WORKFLOW_DB_INITIAL_SYNC=0 关闭)
    // fire-and-forget,失败只记日志(下一轮定时同步会兜底)
    if (this.config.get<boolean>('initialSync')) {
      this.runSync().catch((err) => {
        this.logger.error(`initial sync error: ${err.message}`);
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    // 模块销毁:停止全部后台循环(此时 SQLite 尚未关闭,由 shutdown 阶段处理)
    this.stopBackgroundLoops();
  }

  /** /api/health 用:SQLite 主库是否可用(未打开/已关闭视为降级)。 */
  getDatabaseStatus(): { engine: string; sqlite: 'ok' | 'error' } {
    // 引擎判定优先级:纯远程 > 切读或无 Mongo 配置 → sqlite,否则 mongo
    const engine = this.remoteMode
      ? 'remote'
      : this.readMode || !this.config.get<string>('mongo.uri')
        ? 'sqlite'
        : 'mongo';
    // sqlite 可用性探测:better-sqlite3 打开状态(open 属性)
    let sqliteOk = true;
    try {
      if (!this.sqliteDb.open) sqliteOk = false;
    } catch {
      sqliteOk = false;
    }
    return { engine, sqlite: sqliteOk ? 'ok' : 'error' };
  }

  /**
   * SIGTERM/SIGINT(main.ts enableShutdownHooks):回收后台循环后,
   * 停止 worker、对 SQLite 做 WAL checkpoint 并关闭(避免 WAL 持续增长)。
   * 注意:onModuleDestroy 后此方法才被调用,故 stopBackgroundLoops 幂等。
   */
  async onApplicationShutdown(): Promise<void> {
    this.stopBackgroundLoops();
    // 停止解析 worker 子进程(优雅退出)
    await this.parseWorker.stop();
    try {
      // WAL checkpoint(TRUNCATE)+ 关闭,防 WAL 文件无限增长;
      // 若库已被提前关闭则跳过(open 判断)
      if (this.sqliteDb.open) {
        this.sqliteDb.pragma('wal_checkpoint(TRUNCATE)');
        this.sqliteDb.close();
        this.logger.log('sqlite checkpointed and closed on shutdown');
      }
    } catch (err) {
      this.logger.warn(
        `sqlite shutdown error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 停止全部定时器与近实时通道(幂等,onModuleDestroy / onApplicationShutdown 共用)。 */
  private stopBackgroundLoops(): void {
    // 逐个清理:先停同步定时器,再停备份、flush 定时器,最后关轮询器与文件监听
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.backup.stopLoop();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.comfyPoller?.stop();
    this.fsWatcher?.close();
    this.fsWatcher = null;
  }

  // ----------------------------------------------------------- sync loop

  private startSyncLoop(): void {
    // 幂等:已有定时器则跳过
    if (this.syncTimer) return;
    this.syncTimer = setInterval(
      // 每轮 runSync;异步失败(异常)不中断定时器,记录后等下一轮
      () =>
        this.runSync().catch((err) => {
          this.logger.error(`sync loop error: ${err.message}`);
        }),
      this.syncIntervalMs,
    );
    this.logger.log(`sync loop started (interval=${this.syncIntervalMs}ms)`);
  }

  /**
   * 执行一轮全量同步:scan(发现文件)→ 逐文件 parse(worker 解析)→
   * diff 后批量写库(ingest 内部完成)。含状态维护与 recipe_groups 自愈。
   *
   * 重入保护:running 时直接返回 skipped;扫描根缺失/不存在时返回 error。
   * 进度通过 onProgress 回调实时写入 syncState.progress 供前端展示。
   *
   * 变更版本:复刻旧版 run_sync_pass —— new/changed/removed/deduped 任一 >0
   * 时 changeVersion +1 且 hasUpdates=true(供前端 ack 机制消费)。
   * @returns ingest 的 summary(含各计数),或 { skipped/error } 结果
   */
  async runSync(): Promise<Record<string, unknown>> {
    if (this.syncState.running) {
      this.logger.warn('sync already running, skipping');
      return { skipped: true };
    }
    // 扫描根未配置或不存在:本轮不执行,返回原因(定时器会继续空转)
    if (!this.scanRoot || !existsSync(this.scanRoot)) {
      const msg = this.scanRoot
        ? `scan root missing: ${this.scanRoot}`
        : 'scan root not configured (COMFY_SCAN_ROOT)';
      this.logger.warn(`sync skipped: ${msg}`);
      return { error: msg };
    }
    // 置 running + 初始化进度(stage=scan,计数清零)
    this.syncState.running = true;
    this.syncState.progress = {
      stage: 'scan',
      discovered: 0,
      skipped: 0,
      new: 0,
      changed: 0,
      removed: 0,
      failed: 0,
      parsed: 0,
    };
    this.logger.log('sync started');

    try {
      // 解析回调:统一走 parseWorker(子进程 JSON-RPC 解析)
      const parseFn = async (path: string, scanRoot: string) =>
        this.parseWorker.parseImage(path, scanRoot);

      // 核心:ingest 全量 scan + diff + 入库;进度回调实时更新 syncState
      const summary = await ingest(
        this.scanRoot,
        this.imagesModel,
        this.statsDocsModel,
        this.statsSummaryModel,
        this.recipeGroupModel,
        parseFn,
        {
          onProgress: (progress) => {
            this.syncState.progress = progress;
          },
          // 双写/切读时 SQLite 一并落;切读时跳过 Mongo(skipMongo)
          sqliteDb: this.dualWrite || this.readMode ? this.sqliteDb : undefined,
          skipMongo: this.readMode,
          // 多网关实例打标
          instance: this.instanceStamp,
        },
      );

      // 更新状态:摘要、时间、清错误
      this.syncState.lastSummary = summary as unknown as Record<
        string,
        unknown
      >;
      this.syncState.lastRunAt = new Date();
      this.syncState.error = undefined;
      // 复刻旧版 run_sync_pass:new/changed/removed/deduped 任一 >0 时自增 change_version
      const changeCount =
        Number(summary.new ?? 0) +
        Number(summary.changed ?? 0) +
        Number(summary.removed ?? 0) +
        Number(summary.deduped ?? 0);
      if (changeCount > 0) {
        this.syncState.changeVersion += 1;
        this.syncState.hasUpdates = true;
      }
      this.logger.log(
        `sync done: discovered=${summary.discovered} parsed=${summary.parsed} ` +
          `new=${summary.new} changed=${summary.changed} removed=${summary.removed} ` +
          `deduped=${summary.deduped} failed=${summary.failed}`,
      );

      // 同步后自恢复 recipe_groups
      await this.recipeGroupsSelfHeal();

      // Danbooru tag 组推荐增量预计算(可选;GNN 资产未配置/worker 不可用则跳过)
      await this.backfillTagSuggestions();

      return summary as unknown as Record<string, unknown>;
    } catch (err) {
      // 同步整体失败:记录错误,不抛(定时器下一轮继续)
      const msg = err instanceof Error ? err.message : String(err);
      this.syncState.error = msg;
      this.logger.error(`sync failed: ${msg}`);
      return { error: msg };
    } finally {
      // 无论成败:复位 running、清空进度
      this.syncState.running = false;
      this.syncState.progress = undefined;
    }
  }

  /**
   * Danbooru tag 组推荐增量预计算(需求 2,可选功能)。
   *
   * 每轮 sync 后对"尚无补全结果"的批次(最多 limit 个)提取 positive prompt
   * 文本,调 worker suggest_tags(GNN 组推荐),结果写 batch_tag_suggestions 表。
   * 增量语义:已算过的批次(表内已有 batch_key)跳过;新批次在后续 sync 轮次补齐。
   *
   * 静默降级:总开关关闭 / DANBOORU_ASSETS 未配置 / 非 SQLite 轨道 / worker
   * 报 enabled:false(资产或 numpy 缺失)→ 跳过本轮,不阻断 sync。
   */
  private async backfillTagSuggestions(limit = 50): Promise<void> {
    if (!this.tagSuggestEnabled || !this.danbooruAssets) return;
    if (!this.readMode && !this.dualWrite) return;
    try {
      const rows = this.sqliteDb
        .prepare(
          `SELECT b.batch_key, b.doc_json FROM batches b
           LEFT JOIN batch_tag_suggestions s ON s.batch_key = b.batch_key
           WHERE s.batch_key IS NULL
           LIMIT ?`,
        )
        .all(limit) as Array<{ batch_key: string; doc_json: string }>;
      if (!rows.length) return;
      const insert = this.sqliteDb.prepare(
        `INSERT OR REPLACE INTO batch_tag_suggestions
         (batch_key, payload, updated_at) VALUES (?, ?, ?)`,
      );
      let done = 0;
      for (const row of rows) {
        try {
          const doc = JSON.parse(row.doc_json) as {
            prompts?: { positive?: Array<{ text?: string }> };
          };
          const texts = (doc?.prompts?.positive ?? [])
            .map((p) => (typeof p?.text === 'string' ? p.text : ''))
            .filter(Boolean);
          if (!texts.length) continue;
          const result = await this.parseWorker.suggestTags(texts, row.batch_key);
          if (!result || result.enabled === false) {
            this.logger.warn(
              'tag suggest unavailable (worker enabled:false), skipping this round',
            );
            return;
          }
          insert.run(row.batch_key, JSON.stringify(result), new Date().toISOString());
          done += 1;
        } catch (err) {
          this.logger.warn(
            `tag suggest failed for ${row.batch_key}: ${(err as Error).message}`,
          );
        }
      }
      if (done > 0) {
        this.logger.log(`tag suggestions computed: ${done}/${rows.length}`);
      }
    } catch (err) {
      this.logger.warn(`tag suggest backfill error: ${(err as Error).message}`);
    }
  }

  // ----------------------------------------------------------- watcher

  /**
   * 处理 watcher webhook 事件(由 controller 调用,已在 controller 层做过
   * 一次路径白名单校验;此处再校验一次,防配置中途变化):
   *   - deleted/removed:按路径幂等删除记录(返回旧 recipe_key)
   *   - created/changed:解析图片 → upsert 单条记录(可能跨批次移动)
   *
   * 任何失败都吞入 watcherState.error 并返回 { error },不让异常上抛给 HTTP。
   * @param event { event_type, resolved_path } watcher 上报的事件
   * @returns { action: removed|upserted, resolved_path, ... } 或 { error }
   */
  async handleWatcherEvent(event: {
    event_type?: string;
    resolved_path?: string;
  }): Promise<Record<string, unknown>> {
    // 维护 watcher 状态:running + 最近事件时间/类型
    this.watcherState.running = true;
    this.watcherState.lastEventAt = new Date();
    const eventType = (event.event_type ?? '').toLowerCase().trim();
    this.watcherState.lastEventType = eventType;
    const resolvedPath = (event.resolved_path ?? '').trim();

    try {
      if (!resolvedPath) {
        return { error: 'missing resolved_path' };
      }
      // P1#7 路径白名单:created/changed/deleted 一律校验,越界直接拒绝(不解析、不删记录)
      const check = isAllowedWatcherPath(
        resolvedPath,
        this.getWatcherAllowedRoots(),
      );
      if (!check.ok) {
        this.watcherState.error = check.error;
        this.logger.warn(`watcher event rejected: ${check.error}`);
        return { error: check.error };
      }

      // 删除分支:幂等删除该路径在 Mongo/SQLite 中的记录
      if (eventType === 'deleted' || eventType === 'removed') {
        const oldKey = await removeSingleRecordByPath(
          resolvedPath,
          this.imagesModel,
          this.statsDocsModel,
          this.recipeGroupModel,
          this.dualWrite || this.readMode ? this.sqliteDb : undefined,
          this.readMode,
        );
        this.watcherState.processedCount += 1;
        return {
          action: 'removed',
          resolved_path: resolvedPath,
          old_recipe_key: oldKey,
        };
      }

      // created / changed → upsert
      // 先解析图片成 batch 级 record(worker 子进程),再入库
      const record = await this.parseWorker.parseImage(
        resolvedPath,
        this.scanRoot,
      );
      // upsert:已有记录更新,否则插入;返回结果含 recipe_key 与移动信息
      const result = await upsertSingleRecord(
        record,
        this.imagesModel,
        this.statsDocsModel,
        this.recipeGroupModel,
        this.connection,
        this.dualWrite || this.readMode ? this.sqliteDb : undefined,
        this.readMode,
        this.instanceStamp,
      );
      this.watcherState.processedCount += 1;
      return {
        action: 'upserted',
        resolved_path: resolvedPath,
        recipe_key: result.recipeKey,
        existing_recipe_key: result.existingRecipeKey,
        moved_from: result.movedFrom,
      };
    } catch (err) {
      // 事件级失败:记录原因,返回 { error } 而非抛异常
      const msg = err instanceof Error ? err.message : String(err);
      this.watcherState.error = msg;
      this.logger.error(`watcher event failed: ${msg}`);
      return { error: msg };
    } finally {
      // 复位 running,允许下一个事件
      this.watcherState.running = false;
    }
  }

  // ----------------------------------------------------------- 近实时通道

  /** watcher 允许的路径根(controller 与 handleWatcherEvent 共用)。 */
  getWatcherAllowedRoots(): string[] {
    // 过滤空值:scanRoot / comfyOutputDir 可能未配置
    return [this.scanRoot, this.comfyOutputDir].filter(Boolean);
  }

  /**
   * ComfyUI history 轮询:新完成生成 → 输出图片路径进内存缓冲。
   * 0 或 ComfyUI 不可达时不启动。
   * 启动条件:COMFYUI_BASE_URL 已配置且 WORKFLOW_DB_COMFY_POLL_SECONDS > 0;
   * 任一不满足仅告警,依赖全量 sync 兜底。
   */
  private startComfyPoller(): void {
    const pollSeconds = this.config.get<number>('comfyPollSeconds') ?? 3;
    const baseUrl = this.config.get<string>('comfyuiBaseUrl') ?? '';
    if (!baseUrl || pollSeconds <= 0) {
      this.logger.warn(
        pollSeconds <= 0
          ? 'comfy history poller disabled (WORKFLOW_DB_COMFY_POLL_SECONDS=0)'
          : 'comfy history poller disabled (COMFYUI_BASE_URL 未配置)',
      );
      return;
    }
    // 构造轮询器:完成的任务图片路径直接进 pendingBuffer(后续 flush 入库)
    this.comfyPoller = new ComfyHistoryPoller({
      baseUrl,
      pollSeconds,
      scanRoot: this.scanRoot,
      comfyOutputDir: this.comfyOutputDir,
      buffer: this.pendingBuffer,
      // 单引擎模式:惰性连接未连接,getClient() 不可用,db 传空(仅 sqlite 生效)
      db: this.readMode
        ? ({} as never)
        : this.connection.db ?? this.connection.getClient().db(),
      sqliteDb: this.dualWrite || this.readMode ? this.sqliteDb : undefined,
      skipMongo: this.readMode,
      logger: this.logger,
    });
    // 异步启动;失败(ComfyUI 不可达等)记录日志,不阻塞模块初始化
    void this.comfyPoller.start().catch((err) => {
      this.logger.error(
        `comfy history poller start failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** 缓冲批量 flush:diff 后解析入库,周期 flushSeconds。 */
  private startFlushLoop(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(
      // 周期触发 flushPending;异常兜底记日志
      () =>
        this.flushPending().catch((err) => {
          this.logger.error(`flush loop error: ${err.message}`);
        }),
      this.flushMs,
    );
    this.logger.log(`flush loop started (interval=${this.flushMs}ms)`);
  }

  /**
   * Windows 原生下递归 fs.watch:文件事件 → 路径进缓冲。
   * 非 win32 平台 fs.watch 不支持 recursive,自动降级(依赖 sync 兜底)。
   * 关闭条件:未配置扫描根 / WORKFLOW_DB_FS_WATCH=0 / 非 Windows;
   * watch 抛错时置空句柄并告警(降级到 sync 循环)。
   */
  private startFsWatcher(): void {
    // 前置条件:扫描根必须存在
    if (!this.scanRoot || !existsSync(this.scanRoot)) {
      return;
    }
    // 开关关闭:跳过
    if (!this.config.get<boolean>('fsWatchEnabled')) {
      this.logger.log('fs watcher disabled (WORKFLOW_DB_FS_WATCH=0)');
      return;
    }
    // 非 Windows:recursive watch 不支持,跳过(依赖 sync 兜底)
    if (process.platform !== 'win32') {
      this.logger.log(
        'fs watcher skipped: 非 Windows 平台(fs.watch 不支持 recursive),依赖 sync 循环兜底',
      );
      return;
    }
    try {
      this.fsWatcher = watch(
        this.scanRoot,
        { recursive: true },
        (event, filename) => {
          if (!filename) return;
          const full = join(this.scanRoot, filename);
          // 只关心图片文件(按扩展名过滤)
          if (!isImageFile(full)) return;
          this.watcherState.lastEventAt = new Date();
          this.watcherState.lastEventType = String(event);
          // 文件已不在磁盘(删除 / 移出扫描根 / 目录内移动的旧路径):
          // 立即幂等删除记录,绕过缓冲,避免洪泛时被 PendingBuffer 上限丢弃、
          // 也避免旧路径记录残留到下一轮全量 sync。
          if (!existsSync(full)) {
            this.removeGonePath(full);
            return;
          }
          // 正常变更:路径进缓冲,等待 flush 循环 diff 后入库
          const added = this.pendingBuffer.add(full);
          if (added) {
            this.logger.debug(
              `fs watch ${event}: ${full} (buffer=${this.pendingBuffer.size()})`,
            );
          }
        },
      );
      this.logger.log(`fs watcher started on ${this.scanRoot} (recursive)`);
    } catch (err) {
      // watch 初始化失败:置空句柄,降级到 sync 循环
      this.fsWatcher = null;
      this.logger.warn(
        `fs watcher failed, fallback to sync loop: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 已消失路径即时幂等删除(删除 / 移出 / 目录内移动的旧路径)。 */
  private removeGonePath(full: string): void {
    // fire-and-forget:删除失败只告警,不阻塞 fs 回调
    void removeSingleRecordByPath(
      full,
      this.imagesModel,
      this.statsDocsModel,
      this.recipeGroupModel,
      this.dualWrite || this.readMode ? this.sqliteDb : undefined,
      this.readMode,
    )
      .then(() => {
        // 删除成功:计入处理数
        this.watcherState.processedCount += 1;
        this.logger.debug(`fs watch remove: ${full}`);
      })
      .catch((err) => {
        this.watcherState.error = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `fs watch remove failed ${full}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * 处理内存缓冲:对每个路径与 Mongo 按 mtime_ns/size_bytes diff,
   * 有变化/不存在才解析入库;失败 requeue(上限 3 次后丢弃)。
   *
   * 处理分支:
   *   - 非图片文件 → skipped(不计数失败)
   *   - 文件已消失 → 幂等删除记录
   *   - 与存量 diff 无变化(mtime/size 相同)→ skipped
   *   - 有变化/无记录 → 解析(优先复用内存视图缓存)→ upsert
   * 每轮结束清空 memoryRecords(数据已入库,查询自然走 Mongo)。
   * @returns { processed, skipped, failed } 本轮各分支计数
   */
  async flushPending(): Promise<Record<string, unknown>> {
    // 防重入:上一轮 flush 未结束则跳过
    if (this.flushRunning) {
      return { skipped: true };
    }
    // takeAll 保留每条路径的 attempts,失败 requeue 后才能真正累加到上限
    const items = this.pendingBuffer.takeAll();
    if (items.length === 0) {
      return { processed: 0, skipped: 0, failed: 0 };
    }
    this.flushRunning = true;
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    try {
      for (const { path, attempts } of items) {
        if (!isImageFile(path)) {
          skipped += 1;
          continue;
        }
        if (!existsSync(path)) {
          // 文件已消失:幂等删除记录
          try {
            await removeSingleRecordByPath(
              path,
              this.imagesModel,
              this.statsDocsModel,
              this.recipeGroupModel,
              this.dualWrite || this.readMode ? this.sqliteDb : undefined,
              this.readMode,
            );
            processed += 1;
          } catch (err) {
            failed += 1;
            this.logger.warn(`flush remove failed ${path}: ${err instanceof Error ? err.message : String(err)}`);
          }
          continue;
        }
        try {
          // 取当前文件 stat(bigint 保精度)
          const stat = statSync(path, { bigint: true });
          // 查存量记录(readMode 走 SQLite 单条,否则 Mongo 按路径查)
          let existing: { images?: Array<{ file?: { resolved_path?: string; mtime_ns?: number; size_bytes?: number } }> } | null = null;
          if (this.readMode) {
            // SQLite:先按路径找批次,再取该批次内单条图片记录
            const hit = readBatchByPath(this.sqliteDb, [
              path,
              normalizePathForPlatform(path),
            ].filter(Boolean));
            if (hit) {
              const imgRow = dbImageByPath(this.sqliteDb, hit.batchKey, path);
              existing = imgRow
                ? {
                    images: [
                      {
                        file: {
                          resolved_path: path,
                          mtime_ns: imgRow.mtimeNs ?? undefined,
                          size_bytes: imgRow.sizeBytes ?? undefined,
                        },
                      },
                    ],
                  }
                : { images: [] };
            }
          } else {
            // Mongo:路径两种写法(原生/WSL 归一化)任一命中即可
            existing = (await this.imagesModel.collection.findOne(
              {
                'images.file.resolved_path': {
                  $in: [
                    path,
                    normalizePathForPlatform(path),
                  ].filter(Boolean),
                },
              },
              { projection: { 'images.file.resolved_path': 1, 'images.file.mtime_ns': 1, 'images.file.size_bytes': 1 } },
            )) as { images?: Array<{ file?: { resolved_path?: string; mtime_ns?: number; size_bytes?: number } }> } | null;
          }
          // 精确匹配本次路径的那张图片条目(同一批次可能有多个文件)
          const entry = (
            (existing?.images as
              | Array<{
                  file?: {
                    resolved_path?: string;
                    mtime_ns?: number;
                    size_bytes?: number;
                  };
                }>
              | undefined) ?? []
          ).find((img) => img.file?.resolved_path === path);
          // diff 判定:size 相同且 mtime 差值 <1ms(纳秒精度容差)→ 无变化
          if (
            entry?.file &&
            entry.file.size_bytes === Number(stat.size) &&
            Math.abs((entry.file.mtime_ns ?? 0) - Number(stat.mtimeNs)) < 1_000_000
          ) {
            skipped += 1;
            continue;
          }
          // 优先复用内存视图已解析的 record,避免二次解析
          let record = this.memoryRecords.get(path);
          if (!record || Object.keys(record).length === 0) {
            record = await this.parseWorker.parseImage(path, this.scanRoot);
            this.memoryRecords.set(path, record);
          }
          // 入库:新增或更新(Mongo + 可选 SQLite)
          await upsertSingleRecord(
            record,
            this.imagesModel,
            this.statsDocsModel,
            this.recipeGroupModel,
            this.connection,
            this.dualWrite || this.readMode ? this.sqliteDb : undefined,
            this.readMode,
            this.instanceStamp,
          );
          processed += 1;
        } catch (err) {
          failed += 1;
          // 用处理前的 attempts 递增判断:第 3 次失败后丢弃,不再无限 requeue
          const nextAttempts = attempts + 1;
          if (nextAttempts < 3) {
            // 失败重试:带 attempts 计数重新入缓冲
            this.pendingBuffer.requeue(path, nextAttempts);
          } else {
            // 已达重试上限:丢弃并告警
            this.logger.warn(
              `flush drop (${path}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } finally {
      // 无论成败:复位标记、记录本轮统计,并清空内存视图
      this.flushRunning = false;
      this.lastFlushAt = new Date();
      this.lastFlushSummary = { processed, skipped, failed };
      // 入库完成:清空内存视图(数据已进 Mongo,查询自然只查 Mongo)
      this.memoryRecords.clear();
    }
    // 有实际处理量才打 info 日志(避免空转刷日志)
    if (processed > 0) {
      this.logger.log(`flush done: processed=${processed} skipped=${skipped} failed=${failed}`);
    }
    return this.lastFlushSummary;
  }

  /**
   * 内存视图:缓冲中的待入库图片按需解析成 batch 级文档(与 Mongo 同构),
   * 供查询端点合并返回。不 drain 缓冲,解析结果缓存供 flush 复用。
   *
   * 聚合规则:按 batch_key 分组(缺省取 file.sha256 → filename → 'memory'),
   * 同组图片并入 images 数组并累加 batch_count;输出按 captured_at 倒序。
   * @returns 合并后的 batch 文档数组(按 captured_at 降序)
   */
  async getMemoryView(): Promise<Array<Record<string, unknown>>> {
    // 惰性解析缓冲中的全部路径(带缓存,幂等)
    await this.ensureMemoryRecords();
    // 按 batch_key 聚合为 batch 级文档
    const byBatch = new Map<string, Record<string, unknown>>();
    for (const [path, record] of this.memoryRecords) {
      void path;
      // batch_key 缺省链:record.batch_key → file.sha256 → file.filename → 'memory'
      const batchKey = String(
        record.batch_key ??
          (record.file as Record<string, unknown> | undefined)?.sha256 ??
          (record.file as Record<string, unknown> | undefined)?.filename ??
          'memory',
      );
      // 抽取与 Mongo 文档同构的单图条目
      const entry = imageEntryFromRecord(record);
      const existing = byBatch.get(batchKey);
      if (existing) {
        // 同批次已有:追加图片条目、batch_count +1
        (existing.images as unknown[]).push(entry);
        existing.batch_count = ((existing.batch_count as number) ?? 1) + 1;
        continue;
      }
      // 新批次:按 Mongo batch 文档结构组包(字段与 ingest 产物对齐)
      byBatch.set(batchKey, {
        batch_key: batchKey,
        batch_count: 1,
        captured_at: record.captured_at,
        created_date: record.created_date,
        created_hour: record.created_hour,
        created_weekday: record.created_weekday,
        model: record.model ?? {},
        loras: record.loras ?? {},
        prompts: record.prompts ?? {},
        samplers: record.samplers ?? [],
        latent: record.latent ?? {},
        images: [entry],
      });
    }
    // 倒序输出(captured_at 缺失按空串排最后)
    return [...byBatch.values()].sort((a, b) =>
      String(b.captured_at ?? '').localeCompare(String(a.captured_at ?? '')),
    );
  }

  /**
   * 内存视图中按 sha256 查找图片文件信息(前端详情页需要,而该图
   * 尚未 flush 入库时只能从这里拿)。找不到返回 null。
   * @param sha256 图片内容哈希
   * @returns { resolved_path, windows_path } 或 null
   */
  async findMemoryFileBySha256(
    sha256: string,
  ): Promise<{ resolved_path?: string; windows_path?: string } | null> {
    // 确保缓冲路径已解析(带缓存)
    await this.ensureMemoryRecords();
    for (const record of this.memoryRecords.values()) {
      const entry = imageEntryFromRecord(record);
      const file = entry.file as
        | { sha256?: string; resolved_path?: string; windows_path?: string }
        | undefined;
      if (file?.sha256 === sha256) {
        return {
          resolved_path: file.resolved_path,
          windows_path: file.windows_path,
        };
      }
    }
    return null;
  }

  /**
   * 惰性解析缓冲路径(带缓存)。flush 与查询共享,避免重复解析。
   * 互斥保护:memoryViewResolving 防止并发重复解析(第二个调用方直接跳过,
   * 由第一个调用方的最终结果兜底)。
   */
  private async ensureMemoryRecords(): Promise<void> {
    if (this.memoryViewResolving) {
      return;
    }
    this.memoryViewResolving = true;
    try {
      // 读取缓冲中的全部路径(不 drain),补解析缺失项
      const pending = [...this.pendingBuffer.paths()];
      for (const path of pending) {
        // 已解析过(含失败占位 {})则跳过
        if (this.memoryRecords.has(path)) {
          continue;
        }
        // 文件已消失/非图片:占位空对象,避免反复解析失败
        if (!existsSync(path) || !isImageFile(path)) {
          this.memoryRecords.set(path, {});
          continue;
        }
        try {
          // 正常解析并缓存
          const record = await this.parseWorker.parseImage(path, this.scanRoot);
          this.memoryRecords.set(path, record);
        } catch (err) {
          // 单条解析失败:占位空对象,不中断整体
          this.memoryRecords.set(path, {});
          this.logger.debug(
            `memory view parse failed ${path}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      // 释放互斥锁
      this.memoryViewResolving = false;
    }
  }

  // ----------------------------------------------------------- recipe_groups self-heal

  /**
   * recipe_groups 自愈:比较"存在 recipe_key 的图片数"与 recipe_groups 集合数,
   * 覆盖率 <95% 时全量重建(兜底修复增量写入漏聚合 / 历史脏数据)。
   * 启动时(onModuleInit)与每次同步后(runSync)各调用一次。
   * @returns { rebuilt: boolean, ... } 或 { error } — rebuilt=true 时附带
   *          rebuild 结果(updated/requested_keys)
   */
  async recipeGroupsSelfHeal(): Promise<Record<string, unknown>> {
    try {
      // 比较批次的 distinct recipe_key 数与 recipe_groups 数
      // (此前按批次数比,多个批次共享 recipe_key 导致覆盖率恒 <95%,
      // 每次启动都触发全量重建;distinct 口径下正常数据 ≈100%)
      let imagesWithKey: number;
      let recipeGroupsCount: number;
      if (this.dualWrite || this.readMode) {
        // SQLite 口径:读聚合覆盖率的专用查询
        const coverage = recipeCoverage(this.sqliteDb);
        imagesWithKey = coverage.imagesWithKey;
        recipeGroupsCount = coverage.recipeGroups;
      } else {
        // Mongo 口径:distinct 计数(去重后的 recipe_key 数)+ 集合文档数
        imagesWithKey = (
          await this.imagesModel.collection.distinct('recipe_key', {
            recipe_key: { $exists: true, $nin: [null, ''] },
          })
        ).length;
        recipeGroupsCount = await this.recipeGroupModel.collection.countDocuments({});
      }

      // 覆盖率不足 95%:触发全量重建
      if (recipeGroupsCount < imagesWithKey * 0.95) {
        this.logger.warn(
          `recipe_groups coverage low: ${recipeGroupsCount} < 95% of ${imagesWithKey}, rebuilding`,
        );
        let result: { updated: number; requested_keys: number };
        if (this.readMode) {
          // 切读期:只重建 SQLite
          result = rebuildRecipeGroupsSqlite(this.sqliteDb);
        } else {
          // Mongo 为主:重建 Mongo;双写时 SQLite 同步重建
          result = await rebuildRecipeGroups(
            this.imagesModel,
            this.recipeGroupModel,
          );
          if (this.dualWrite) {
            rebuildRecipeGroupsSqlite(this.sqliteDb);
          }
        }
        this.logger.log(`recipe_groups rebuilt: ${result.updated}`);
        return { rebuilt: true, ...result };
      }
      // 覆盖率正常:无需重建,返回当前计数
      return {
        rebuilt: false,
        images_with_key: imagesWithKey,
        recipe_groups: recipeGroupsCount,
      };
    } catch (err) {
      // 自愈失败不影响主流程:记录后返回 { error }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`recipe_groups self-heal failed: ${msg}`);
      return { error: msg };
    }
  }

  // ----------------------------------------------------------- status

  /**
   * 汇总同步状态(供 GET /api/sync-status):
   * 含运行态、进度、上次摘要、版本号、缓冲水位、flush 状态、ComfyUI 轮询状态。
   * @returns 平铺状态对象(snake_case 兼容旧 Python 契约)
   */
  getSyncStatus(): Record<string, unknown> {
    return {
      running: this.syncState.running,
      last_run_at: this.syncState.lastRunAt,
      // 旧版 Python 契约别名,前端仍按 last_finished_at / last_checked_at 展示
      last_finished_at: this.syncState.lastRunAt,
      last_checked_at: this.syncState.lastRunAt,
      progress: this.syncState.progress,
      last_summary: this.syncState.lastSummary,
      error: this.syncState.error,
      interval_seconds: this.syncIntervalMs / 1000,
      has_updates: this.syncState.hasUpdates,
      change_version: this.syncState.changeVersion,
      pending_count: this.pendingBuffer.size(),
      flush: {
        running: this.flushRunning,
        last_flush_at: this.lastFlushAt,
        last_summary: this.lastFlushSummary,
      },
      comfy_history: this.comfyPoller?.getStatus() ?? { running: false },
    };
  }

  /**
   * 复刻旧版 POST /api/sync-status/ack:客户端确认已消费更新。
   * 清除 hasUpdates 标记(changeVersion 保留,供增量比对)。
   * @returns { ok: true, change_version } 当前版本号
   */
  acknowledgeSyncUpdates(): Record<string, unknown> {
    this.syncState.hasUpdates = false;
    return {
      ok: true,
      change_version: this.syncState.changeVersion,
    };
  }

  /** 汇总 watcher 状态(供 GET /api/watcher/status)。 */
  getWatcherStatus(): Record<string, unknown> {
    return {
      running: this.watcherState.running,
      last_event_at: this.watcherState.lastEventAt,
      last_event_type: this.watcherState.lastEventType,
      processed_count: this.watcherState.processedCount,
      error: this.watcherState.error,
    };
  }

  /** 汇总备份状态:直接透传 BackupService.getStatus()。 */
  getBackupStatus(): Record<string, unknown> {
    return this.backup.getStatus();
  }

  /** 手动触发一次备份(controller /api/backup/trigger 用):透传 BackupService.runBackup()。 */
  runBackup(): Promise<Record<string, unknown>> {
    return this.backup.runBackup();
  }
}
