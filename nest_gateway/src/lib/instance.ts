import type { ConfigService } from '@nestjs/config';

/**
 * 多网关共享库:实例来源打标。
 *
 * 每条入库图片的 image entry 打上 source{instance_id, base_url}(file 的兄弟字段,
 * 不动 parser 产物语义)。透传(纯远程图片访问)按 image entry 的 source 定位持有网关。
 *
 * 不放 doc 级:跨用户同 seed 批合并($push 到已有 batch)时,doc 级字段会被
 * 后写者覆盖,image 级归属才可靠。
 *
 * 数据流:orchestration.service 在 ingest/archive 入口用 instanceStamp(config)
 * 构造打标对象 → 经 ingest()/archiveGeneratedOutputs()/upsertSingleRecord() 的
 * options.instance 参数 → stampImageEntry 就地写入 image entry →
 * 图片读端(images.controller)从 entry.source.base_url 做网关透传(passthrough.ts)。
 * 存储位置是 Mongo/SQLite 的 batch.images[].source,与 parser 产物的 file 平级,
 * 不影响 recipe_key/sha256 等核心字段语义。
 */
export interface InstanceStamp {
  /** 网关实例唯一标识(config 的 instance.id / instance_id,空时兜底 'default')。 */
  instance_id: string;
  /** 该网关对外可达的 base_url(透传代理目标 origin,可为空=仅打标不参与透传)。 */
  base_url: string;
}

type InstanceConfig = Partial<InstanceStamp> & {
  id?: string;
  baseUrl?: string;
};

/**
 * 从应用配置构造实例打标。
 *
 * @param config NestJS ConfigService(instance 段:{id, baseUrl} 或 {instance_id, base_url})
 * @returns 归一化后的 InstanceStamp;instance_id 空串时兜底 'default',
 *          base_url 仅 trim(非法值留给透传端 passthroughTarget 再校验)
 *
 * 内部逻辑:config.get 缺省 {} → Partial 化,逐字段 String()+trim() 兜底,
 * 同时接受 configuration.ts 的 camelCase 与入库用的 snake_case,
 * 保证任何配置形态(缺段/空串/非法类型)都不会产出 undefined 字段,
 * 入库 JSON 结构恒定 {instance_id, base_url}。
 */
export function instanceStamp(config: ConfigService): InstanceStamp {
  const instance = (config.get<InstanceConfig>('instance') ??
    {}) as InstanceConfig;
  return {
    instance_id:
      String(instance.instance_id ?? instance.id ?? '').trim() || 'default',
    base_url: String(instance.base_url ?? instance.baseUrl ?? '').trim(),
  };
}

/**
 * 给单条 image entry 打来源标记(就地修改,幂等)。
 *
 * @param entry 待写入库的 image entry(record 裁剪后的字段集合)
 * @param stamp 实例打标
 * @returns 打标后的 entry(与入参同一对象引用,便于链式使用)
 *
 * 内部逻辑:仅当 instance_id 非空才写入 entry.source —— 未配置实例标识时
 * 保持 entry 原样,避免向历史格式注入多余字段导致 schema 漂移;
 * 重复调用会整体覆盖 source(就地修改,幂等)。
 */
export function stampImageEntry(
  entry: Record<string, unknown>,
  stamp: InstanceStamp,
): Record<string, unknown> {
  if (stamp.instance_id) {
    entry.source = {
      instance_id: stamp.instance_id,
      base_url: stamp.base_url,
    };
  }
  return entry;
}
