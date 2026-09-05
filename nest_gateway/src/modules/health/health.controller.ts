/**
 * health 模块 —— 健康检查控制器(health.controller.ts)
 *
 * 职责:提供 GET /api/health 探活端点,聚合两个子系统的健康度:
 *   - parse worker 子进程状态(ParseWorkerService.getState())
 *   - 数据库引擎与 SQLite 主库可用性(OrchestrationService.getDatabaseStatus())
 *
 * 判定规则:workerState === 'ready' 且 sqlite === 'ok' 时 status=ok,
 * 任一不满足 → status=degraded(不返回 5xx,供负载均衡/前端探活使用)。
 * 数据来源说明:orchestration 与 workers 均经其模块导出注入,避免循环依赖。
 */
import { Controller, Get } from '@nestjs/common';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { ParseWorkerService } from '../../workers/parse-worker.service';

@Controller('api')
export class HealthController {
  constructor(
    private readonly orch: OrchestrationService,
    private readonly worker: ParseWorkerService,
  ) {}

  /**
   * GET /api/health — 服务健康状态。
   * @returns {
   *   status: 'ok' | 'degraded',
   *   worker: ParseWorkerState 字符串(如 ready/starting/failed),
   *   database: { engine, sqlite } 引擎与 SQLite 可用性
   * }
   */
  @Get('health')
  check(): {
    status: string;
    worker: string;
    database: ReturnType<OrchestrationService['getDatabaseStatus']>;
  } {
    // 采集两个子系统的实时状态
    const workerState = this.worker.getState();
    const database = this.orch.getDatabaseStatus();
    // 判定:worker 就绪 + SQLite 打开 = 健康,否则降级
    const ok = workerState === 'ready' && database.sqlite === 'ok';
    return {
      status: ok ? 'ok' : 'degraded',
      worker: workerState,
      database,
    };
  }
}
