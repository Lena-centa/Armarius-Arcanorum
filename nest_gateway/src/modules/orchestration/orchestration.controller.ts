/**
 * orchestration 模块 —— 编排控制器(orchestration.controller.ts)
 *
 * 职责:暴露编排服务的 HTTP 端点,薄封装直接透传 OrchestrationService:
 *   - watcher/events  :Windows FileSystemWatcher 文件事件 webhook(写)
 *   - sync-now        :手动触发一次全量同步(写)
 *   - sync-status     :查询同步状态(读)
 *   - sync-status/ack :确认已消费同步更新(写)
 *   - watcher/status  :查询 watcher 状态(读)
 *   - backup/status   :查询备份状态(读)
 *   - backup/trigger  :手动触发一次备份(写)
 *
 * 安全模型:所有写端点挂 @RequireAuth;watcher 路径在进入 service 之前
 * 先做路径白名单校验(controller 层先行,service 内还会再查一次)。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
} from '@nestjs/common';
import { RequireAuth } from '../../common/auth';
import {
  OrchestrationService,
  isAllowedWatcherPath,
} from './orchestration.service';

/**
 * Orchestration controller — watcher webhook + sync/backup status 端点。
 *
 * 写操作端点(watcher/events、sync-now、sync-status/ack、backup/trigger)
 * 均挂 @RequireAuth;watcher 路径在 controller 层先行白名单校验。
 */
@Controller('api')
export class OrchestrationController {
  constructor(private readonly orch: OrchestrationService) {}

  // POST /api/watcher/events — Windows FileSystemWatcher webhook
  // 入参:{ event_type: created|changed|deleted, resolved_path: 绝对路径 }
  @Post('watcher/events')
  @RequireAuth()
  async watcherEvent(
    @Body() body: { event_type?: string; resolved_path?: string },
  ): Promise<Record<string, unknown>> {
    // controller 层先行白名单校验:路径越界直接 400,不进入解析/删除逻辑
    const check = isAllowedWatcherPath(
      body.resolved_path ?? '',
      this.orch.getWatcherAllowedRoots(),
    );
    if (!check.ok) {
      throw new BadRequestException(check.error);
    }
    // 校验通过:转交 service 处理(内部还会再校验一次,防并发中配置变化)
    return this.orch.handleWatcherEvent(body);
  }

  // POST /api/sync-now — 手动触发同步(全量 scan+parse+diff 入库)
  @Post('sync-now')
  @RequireAuth()
  async syncNow(): Promise<Record<string, unknown>> {
    // 同步中再次触发会被 service 幂等跳过(返回 skipped:true)
    return this.orch.runSync();
  }

  // GET /api/sync-status — 查询同步状态(进度/上次摘要/change_version 等)
  @Get('sync-status')
  async syncStatus(): Promise<Record<string, unknown>> {
    return this.orch.getSyncStatus();
  }

  // POST /api/sync-status/ack — 客户端确认已消费更新(清 has_updates 标记)
  @Post('sync-status/ack')
  @RequireAuth()
  async syncStatusAck(): Promise<Record<string, unknown>> {
    return this.orch.acknowledgeSyncUpdates();
  }

  // GET /api/watcher/status — 查询 watcher 状态(最近事件/处理计数/错误)
  @Get('watcher/status')
  async watcherStatus(): Promise<Record<string, unknown>> {
    return this.orch.getWatcherStatus();
  }

  // GET /api/backup/status — 查询备份状态(运行中/上次时间/目录)
  @Get('backup/status')
  async backupStatus(): Promise<Record<string, unknown>> {
    return this.orch.getBackupStatus();
  }

  // POST /api/backup/trigger — 手动触发备份(绕过定时器,立即执行一次)
  @Post('backup/trigger')
  @RequireAuth()
  async backupTrigger(): Promise<Record<string, unknown>> {
    return this.orch.runBackup();
  }
}
