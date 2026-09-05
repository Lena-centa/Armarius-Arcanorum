/**
 * stats_summaries 集合(统计汇总缓存)的 Mongoose schema。
 *
 * 职责:按 kind(统计口径,如 top_loras / trend / heatmap)预聚合的结果缓存,
 * 附带生成时间戳与参与统计的文档数,供统计页直接展示,
 * 避免每次请求实时聚合全库。
 *
 * 数据流向:stats 模块按口径计算后 upsert → 统计页查询读取;
 * 相同 kind(+ focus_lora)只保留最新一份汇总。
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StatsSummariesDocument = HydratedDocument<StatsSummaries>;

@Schema({ collection: 'stats_summaries', timestamps: false })
export class StatsSummaries {
  // 汇总口径标识(查询键,建有索引;同口径覆盖写)
  @Prop()
  kind!: string;

  // 焦点 LoRA 名:以某 LoRA 为焦点(透视统计)时的目标名,
  // 非焦点口径时为空(与 kind 组合定位汇总,建有索引)
  @Prop()
  focus_lora?: string;

  // 聚合数据体(结构随 kind 而定,透传)
  @Prop({ type: Object })
  data?: Record<string, unknown>;

  // 明细行列表(如 Top N 榜单的行,Object 透传)
  @Prop({ type: [Object] })
  items?: Record<string, unknown>[];

  // 参与本次统计的文档总数(展示统计规模)
  @Prop()
  total_docs?: number;

  // 汇总生成时间(缓存新鲜度判断)
  @Prop()
  updated_at?: Date;

  // 与 focus_lora 共现的 LoRA 列表(共现统计,Object 透传)
  @Prop({ type: [Object] })
  co_loras?: Record<string, unknown>[];

  // 关联 prompt 列表(展示用,Object 透传)
  @Prop({ type: [Object] })
  prompts?: Record<string, unknown>[];
}

export const StatsSummariesSchema =
  SchemaFactory.createForClass(StatsSummaries);

// kind 索引:按口径查询汇总
StatsSummariesSchema.index({ kind: 1 }, { name: 'stats_summary_kind' });
// focus_lora 索引:按焦点 LoRA 查询(透视统计)
StatsSummariesSchema.index(
  { focus_lora: 1 },
  { name: 'stats_summary_focus_lora' },
);
