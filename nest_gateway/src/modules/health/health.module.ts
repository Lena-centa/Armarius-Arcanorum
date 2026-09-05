/**
 * health 模块 —— 健康检查模块装配(health.module.ts)
 *
 * 职责:注册 HealthController(/api/health),注入其依赖的两个模块:
 *   - WorkersModule:提供 ParseWorkerService(worker 状态)
 *   - OrchestrationModule:提供 OrchestrationService(数据库状态)
 * 纯组合模块,无自有 provider。
 */
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { WorkersModule } from '../../workers/workers.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';

@Module({
  imports: [WorkersModule, OrchestrationModule],
  controllers: [HealthController],
})
export class HealthModule {}
