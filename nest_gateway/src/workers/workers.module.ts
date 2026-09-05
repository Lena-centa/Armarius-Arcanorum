/**
 * WorkersModule — worker 服务(ParseWorkerService)的独立宿主模块。
 * 设计意图:
 *   - parse / orchestration / generate / health 四个业务模块共同消费同一个
 *     parse worker 单例,避免各自 spawn 浪费子进程;
 *   - ParseWorkerService 只依赖 ConfigService,不依赖任何业务模块,
 *     独立成模块可切断 ParseModule ⇄ OrchestrationModule 的 forwardRef 循环依赖。
 * 注意:GenerateWorkerService 注册在 GenerateModule(业务模块)侧,未在此集中托管。
 */
import { Module } from '@nestjs/common';
import { ParseWorkerService } from './parse-worker.service';

/**
 * ParseWorkerService 独立宿主模块:
 * parse / orchestration / generate / health 共同消费 parse worker,
 * 独立成模块可切断 ParseModule ⇄ OrchestrationModule 的 forwardRef 循环依赖。
 */
@Module({
  // 提供 ParseWorkerService 单例:supervisor 生命周期随模块启动/销毁(onModuleInit/Destroy)
  providers: [ParseWorkerService],
  // 导出给 parse/orchestration/generate/health 等消费方注入使用
  exports: [ParseWorkerService],
})
export class WorkersModule {}
