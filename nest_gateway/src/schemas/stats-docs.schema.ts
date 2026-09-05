/**
 * stats_docs 集合(单图统计缓存)的 Mongoose schema。
 *
 * 职责:缓存"单图 → 是否解析出工作流 / 模型 / LoRA / prompt"等统计投影,
 * 供统计页做全库扫描式聚合,避免反复解析 images 大文档(按文件路径唯一)。
 *
 * 数据流向:stats 模块扫描时写入 / 更新(缓存)→ 统计查询读取;
 * 字段结构是 images 文档对应字段的轻量投影。
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StatsDocsDocument = HydratedDocument<StatsDocs>;

@Schema({ collection: 'stats_docs', timestamps: false })
export class StatsDocs {
  // 文件标识:resolved_path(绝对路径)唯一索引,upsert 定位键;
  // 其余字段为展示 / 过滤用快照
  @Prop({ type: Object })
  file!: {
    resolved_path: string;
    filename?: string;
    image_name?: string;
    size_bytes?: number;
    mtime_ns?: number;
    sha256?: string;
  };

  // 是否解析出内嵌工作流(建有索引,按解析状态过滤统计)
  @Prop()
  has_parsed_workflow?: boolean;

  // 捕获日期 %Y-%m-%d(UTC,按日聚合)
  @Prop()
  created_date?: string;

  // 模型快照(仅 base_model,按模型统计)
  @Prop({ type: Object })
  model?: {
    base_model?: string;
  };

  // LoRA 快照(名称列表,按 LoRA 统计)
  @Prop({ type: Object })
  loras?: {
    names?: string[];
  };

  // prompt 快照(全文检索串,按关键词统计)
  @Prop({ type: Object })
  prompts?: {
    search_text?: string;
  };

  // 捕获时间(UTC)
  @Prop()
  captured_at?: Date;
}

export const StatsDocsSchema = SchemaFactory.createForClass(StatsDocs);

// resolved_path 唯一索引:同一文件只保留一份统计投影(缓存 upsert 定位)
StatsDocsSchema.index(
  { 'file.resolved_path': 1 },
  { name: 'uniq_stats_doc_resolved_path', unique: true },
);
// 解析状态索引:按"是否解析出工作流"过滤
StatsDocsSchema.index(
  { has_parsed_workflow: 1 },
  { name: 'stats_doc_has_parsed_workflow' },
);
// 捕获日期倒序:按日聚合
StatsDocsSchema.index({ created_date: -1 }, { name: 'stats_doc_created_date' });
// base_model 索引:按模型统计
StatsDocsSchema.index(
  { 'model.base_model': 1 },
  { name: 'stats_doc_base_model' },
);
// LoRA 名称索引:按 LoRA 统计
StatsDocsSchema.index({ 'loras.names': 1 }, { name: 'stats_doc_lora_names' });
// prompt 全文检索索引:按关键词统计
StatsDocsSchema.index(
  { 'prompts.search_text': 1 },
  { name: 'stats_doc_prompt_search_text' },
);
// 按图名过滤
StatsDocsSchema.index(
  { 'file.image_name': 1 },
  { name: 'stats_doc_image_name' },
);
// 按文件名过滤
StatsDocsSchema.index({ 'file.filename': 1 }, { name: 'stats_doc_filename' });
