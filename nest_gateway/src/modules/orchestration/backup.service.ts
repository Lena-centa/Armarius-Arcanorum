/**
 * orchestration 子服务 —— 数据备份(backup.service.ts)
 *
 * 职责:管理周期备份定时器 + 执行备份 + 留存清理,从 OrchestrationService
 * 拆出以保证单一职责。备份目标二选一:
 *   - SQLite 切读期(SQLITE_READ=1):用 better-sqlite3 原生 VACUUM INTO 备份
 *     (backupTo),无需外部工具
 *   - 过渡期(默认):通过 child_process.execFile 调 mongodump 快照 Mongo
 *
 * 生命周期:OrchestrationService.onModuleInit 调 startLoop 启动,
 * onModuleDestroy 调 stopLoop 停止;手动触发走 controller → runBackup()。
 *
 * 配置项:
 *   backupDir                (WORKFLOW_DB_BACKUP_DIR)           备份输出目录,空=停用
 *   backupIntervalDays       (WORKFLOW_DB_BACKUP_INTERVAL_DAYS) 间隔天数,>0 按天,否则每小时
 *   sqlite.readMode / mongo.uri / mongo.db                      备份引擎与目标库
 *
 * 留存策略:成功后只保留最近 BACKUP_RETAIN_COUNT(=7)份,最旧的删除。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { SQLITE_DB } from '../../sqlite/sqlite.module';
import { backupTo } from '../../sqlite/db';

/**
 * 备份状态(供 /api/backup/status 与 getStatus() 输出):
 *   running   当前是否正在执行备份(防重入)
 *   lastRunAt 最近一次成功备份的时间
 *   error     最近一次失败的原因(成功后清空)
 */
export interface BackupState {
  running: boolean;
  lastRunAt?: Date;
  error?: string;
}

/** 备份留存份数(成功后清理最旧,仅保留最近 N 份)。 */
const BACKUP_RETAIN_COUNT = 7;

/**
 * 备份循环(WORKFLOW_DB_BACKUP_DIR 配置):SQLite 原生备份(切读期)
 * 或 mongodump(过渡期)。从 OrchestrationService 拆出,职责单一:
 * 定时器生命周期 + 备份执行 + 留存清理。
 *
 * 字段说明:
 *   backupDir  备份输出目录绝对路径(空串 = 备份功能停用)
 *   readMode   SQLITE_READ=1 时走 SQLite 原生备份
 *   timer      周期定时器句柄(空 = 未启动)
 *   state      对外暴露的运行状态(controller 透传)
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);
  private readonly backupDir: string;
  private readonly readMode: boolean;
  private timer: NodeJS.Timeout | null = null;
  readonly state: BackupState = { running: false };

  constructor(
    private readonly config: ConfigService,
    @Inject(SQLITE_DB) private readonly sqliteDb: Database.Database,
  ) {
    // 从配置读取备份目录与引擎开关;缺省:目录空(停用)、不切读(走 mongodump)
    this.backupDir = this.config.get<string>('backupDir') ?? '';
    this.readMode = this.config.get<boolean>('sqlite.readMode') ?? false;
  }

  /** 备份是否启用:backupDir 非空即视为启用(供 onModuleInit 判断)。 */
  get enabled(): boolean {
    return this.backupDir.length > 0;
  }

  /** 备份目录只读访问器(供 OrchestrationService 展示)。 */
  get dir(): string {
    return this.backupDir;
  }

  /**
   * 汇总当前备份状态(snake_case 字段兼容旧 Python 契约),
   * 供 controller /api/backup/status 透传。
   * @returns { running, last_run_at, error, backup_dir } 平铺状态对象
   */
  getStatus(): Record<string, unknown> {
    return {
      running: this.state.running,
      last_run_at: this.state.lastRunAt,
      error: this.state.error,
      backup_dir: this.backupDir,
    };
  }

  /** 启动周期定时器(幂等)。WORKFLOW_DB_BACKUP_INTERVAL_DAYS>0 按天计;未设置/<=0 每小时。 */
  startLoop(): void {
    // 幂等保护:已启动(或未启用)时直接返回,不重复 setInterval
    if (this.timer) return;
    if (!this.enabled) return;
    this.timer = setInterval(
      // 周期回调:runBackup 内部自行处理失败,这里再兜一层错误日志
      () =>
        this.runBackup().catch((err) => {
          this.logger.error(`backup loop error: ${err.message}`);
        }),
      this.intervalMs(),
    );
    this.logger.log(
      `backup loop started (interval=${this.intervalMs()}ms, dir=${this.backupDir})`,
    );
  }

  /** 停止定时器(幂等;进程退出 / 模块销毁时调用)。 */
  stopLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 计算备份周期毫秒数:WORKFLOW_DB_BACKUP_INTERVAL_DAYS 解析成功且 >0
   * 时按"天×24h"换算;否则(未设置/非法/<=0)回退每小时一次。
   * @returns 毫秒间隔
   */
  private intervalMs(): number {
    const raw =
      this.config.get<string>('backupIntervalDays') ??
      process.env.WORKFLOW_DB_BACKUP_INTERVAL_DAYS ??
      '';
    const days = Number(raw);
    if (Number.isFinite(days) && days > 0) {
      return Math.round(days * 24 * 3600_000);
    }
    return 3600_000;
  }

  /**
   * 执行一次备份(供定时器与手动触发共用):
   *   1. 防重入:state.running 时直接返回 { skipped: true }
   *   2. 未配置目录:记录 error 返回,不执行
   *   3. 创建目录 → 时间戳命名备份文件
   *   4. 切读期:backupTo(SQLite VACUUM INTO);否则 mongodump
   *      (先校验 uri scheme 白名单,防任意命令注入)
   *   5. 成功后:更新 lastRunAt、清 error、清理旧备份
   * 全程 try/finally 保证 state.running 复位。
   * @returns { output?, engine?, error?, skipped? } 结果对象
   */
  async runBackup(): Promise<Record<string, unknown>> {
    // 防重入:上一轮尚未结束则跳过本轮
    if (this.state.running) {
      return { skipped: true };
    }
    // 未配置备份目录:视为停用,只记录原因不抛异常
    if (!this.backupDir) {
      const msg = 'backup disabled: WORKFLOW_DB_BACKUP_DIR not set';
      this.state.error = msg;
      return { error: msg };
    }
    // 置 running 标记,防止下一轮定时器与本轮并发
    this.state.running = true;
    this.logger.log('backup started');

    try {
      // 确保目录存在(幂等),文件名带 ISO 时间戳(冒号/点替换为 - 兼容文件名)
      mkdirSync(this.backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const outFile = `${this.backupDir}/backup_${ts}`;

      // 切读期(SQLITE_READ=1)用 SQLite 原生备份;过渡期仍 mongodump
      if (this.readMode) {
        try {
          // SQLite 原生备份:VACUUM INTO 到独立文件,无外部依赖
          await backupTo(this.sqliteDb, `${outFile}.sqlite3`);
          // 成功:刷新时间戳、清错误、清理超出留存份数的旧备份
          this.state.lastRunAt = new Date();
          this.state.error = undefined;
          this.cleanupOldBackups();
          this.logger.log(`backup done (sqlite): ${outFile}.sqlite3`);
          return { output: `${outFile}.sqlite3`, engine: 'sqlite' };
        } catch (err) {
          // 失败:记录原因,不抛(定时器循环会继续下一轮)
          const msg = err instanceof Error ? err.message : String(err);
          this.state.error = msg;
          this.logger.error(`backup failed (sqlite): ${msg}`);
          return { error: msg, engine: 'sqlite' };
        }
      }

      // --- mongodump 分支(过渡期) ---
      // 从配置取 Mongo 连接串与库名(缺省本地默认值)
      const mongoUri =
        this.config.get<string>('mongo.uri') ?? 'mongodb://127.0.0.1:27017';
      const mongoDb =
        this.config.get<string>('mongo.db') ?? 'comfy_workflow_archive';

      // P0#1:scheme 白名单,拒绝非 mongodb/mongodb+srv 的 uri(防注入/任意命令)
      // uri 会被原样作为 CLI 参数传给 mongodump,必须先行校验
      if (!/^mongodb(\+srv)?:\/\//i.test(mongoUri.trim())) {
        const msg =
          'backup failed: mongo uri must start with mongodb:// or mongodb+srv://';
        this.state.error = msg;
        this.logger.error(msg);
        return { error: msg };
      }

      // 用 execFile(而非 exec)避免 shell 解释,参数以数组传递进一步防注入
      return new Promise((resolvePromise) => {
        execFile(
          'mongodump',
          ['--uri', mongoUri, '--db', mongoDb, '--out', outFile],
          (error) => {
            if (error) {
              // 失败:优先提取错误信息;ENOENT 说明 mongodump 未安装,
              // 给出安装提示或改用 SQLite 备份的建议
              let msg =
                error instanceof Error ? error.message : String(error);
              if (
                error instanceof Error &&
                (error as NodeJS.ErrnoException).code === 'ENOENT'
              ) {
                msg =
                  'mongodump not found: install MongoDB Database Tools, or set SQLITE_READ=1 to use the native SQLite backup';
              }
              this.state.error = msg;
              this.logger.error(`backup failed: ${msg}`);
              resolvePromise({ error: msg });
            } else {
              // 成功:刷新 lastRunAt(仅成功)、清错误、清理旧备份、返回输出路径
              this.state.lastRunAt = new Date();
              this.state.error = undefined;
              this.cleanupOldBackups();
              this.logger.log(`backup done: ${outFile}`);
              resolvePromise({ output: outFile });
            }
          },
        );
      });
    } catch (err) {
      // mkdirSync 等同步异常兜底
      const msg = err instanceof Error ? err.message : String(err);
      this.state.error = msg;
      return { error: msg };
    } finally {
      // 无论成败都要复位 running,允许下一轮备份
      this.state.running = false;
    }
  }

  /**
   * P1#12 备份留存:备份成功后清理 backupDir 下最旧的备份,
   * 仅保留最近 BACKUP_RETAIN_COUNT 份(文件名时间戳字典序即时间序)。
   * 扫描条件:仅处理 backup_ 前缀(不误删用户其他文件),整体 try/catch
   * 保证清理失败不影响备份本身的结果返回。
   */
  private cleanupOldBackups(): void {
    try {
      // 列出 backup_* 文件 → 字典序排序(时间戳即序) → 掐头保留最近 7 份
      const toRemove = readdirSync(this.backupDir)
        .filter((name) => name.startsWith('backup_'))
        .sort()
        .slice(0, -BACKUP_RETAIN_COUNT);
      for (const name of toRemove) {
        const full = join(this.backupDir, name);
        try {
          // recursive+force:目录与文件都能删,不存在也不报错
          rmSync(full, { recursive: true, force: true });
          this.logger.log(`backup retention: removed ${full}`);
        } catch (err) {
          // 单文件删除失败不中断整体清理
          this.logger.warn(
            `backup retention: failed to remove ${full}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      // readdirSync 失败(目录被外部删除等):仅告警
      this.logger.warn(
        `backup retention scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
