/**
 * orchestration 模块 —— 编排模块装配(orchestration.module.ts)
 *
 * 职责:组装"同步 + 近实时通道 + watcher + 备份"的后台服务,对外提供:
 *   - OrchestrationService:核心编排(全量同步循环 / ComfyUI 轮询 / fs 监听 /
 *     flush 缓冲 / recipe_groups 自愈 / 状态查询)
 *   - BackupService:备份循环(定时器 + 执行 + 留存清理)
 *   - OrchestrationController:/api/watcher/*、/api/sync-*、/api/backup/*
 *
 * 依赖:
 *   - Mongoose 4 个模型(images/stats_docs/stats_summaries/recipe_groups)
 *   - WorkersModule:ParseWorkerService 由它提供(消除与 ParseModule 的
 *     循环依赖,故不直接 import ParseModule)
 *
 * 导出:OrchestrationService 供 HealthController 等外部模块注入。
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Images,
  ImagesSchema,
  StatsDocs,
  StatsDocsSchema,
  StatsSummaries,
  StatsSummariesSchema,
  RecipeGroups,
  RecipeGroupsSchema,
} from '../../schemas';
import { WorkersModule } from '../../workers/workers.module';
import { OrchestrationService } from './orchestration.service';
import { BackupService } from './backup.service';
import { OrchestrationController } from './orchestration.controller';

/**
 * @Module 元数据:
 *   imports —— 4 个 mongoose 模型 + WorkersModule
 *   controllers —— OrchestrationController
 *   providers —— OrchestrationService + BackupService(BackupService 仅本模块内部使用)
 *   exports —— OrchestrationService(供 health 等模块注入)
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Images.name, schema: ImagesSchema },
      { name: StatsDocs.name, schema: StatsDocsSchema },
      { name: StatsSummaries.name, schema: StatsSummariesSchema },
      { name: RecipeGroups.name, schema: RecipeGroupsSchema },
    ]),
    // ParseWorkerService 由 WorkersModule 提供(消除与 ParseModule 的循环依赖)
    WorkersModule,
  ],
  controllers: [OrchestrationController],
  providers: [OrchestrationService, BackupService],
  exports: [OrchestrationService],
})
export class OrchestrationModule {}
