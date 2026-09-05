import type { ConfigService } from '@nestjs/config';
import type { EngineState } from '../config/configuration';

/**
 * 数据引擎状态辅助(纯远程模式与"无库首启"降级共用)。
 *
 * 状态:
 *   sqlite          — SQLite 单引擎(未配 MONGODB_URI 且非纯远程)
 *   mongo           — 已配 MONGODB_URI(含纯远程模式配库后)
 *   remote-pending  — 纯远程开关开启但 MONGODB_URI 尚未配置(首次启动无库)
 *
 * 数据流:读端点控制器(images/parse/generate/stats 的 controller)在进入
 * 业务逻辑前调用 isEnginePending,若处于 remote-pending 直接返回空集,
 * 避免占位 Mongo 连接的连接超时拖垮首启体验。配置值来自
 * config/configuration.ts 的 EngineState 枚举,此处只做读取不做推导。
 */
export function engineState(config: ConfigService): EngineState {
  return config.get<EngineState>('engine') ?? 'sqlite';
}

/**
 * remote-pending:数据引擎待配置,读端点应返回空集而非触发占位 Mongo 超时。
 *
 * @param config NestJS ConfigService(注入 application config)
 * @returns true 表示引擎未就绪,调用方应短路返回空响应
 *
 * 内部逻辑:engineState 取配置的 engine 字段,缺省兜底 'sqlite'
 * (未配 MONGODB_URI 的历史行为,保证旧配置兼容);
 * 只有显式 remote-pending 才返回 true,其余一律视为可用引擎。
 */
export function isEnginePending(config: ConfigService): boolean {
  return engineState(config) === 'remote-pending';
}
