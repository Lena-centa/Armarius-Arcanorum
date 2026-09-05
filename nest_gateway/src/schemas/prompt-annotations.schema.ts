/**
 * prompt_annotations 集合(prompt 标注)的 Mongoose schema。
 *
 * 职责:对特定 prompt 文本(signature 指纹)人工标注可读名称与备注,
 * 用于把无意义的提示词长串映射为别名(统计 / 展示降噪)。
 *
 * 被谁使用:labels 模块(标注管理);展示数据经存储层(doc_json)读取。
 * 数据流向:标注管理接口写入 → prompt_annotations 集合 → 展示查询读取。
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PromptAnnotationsDocument = HydratedDocument<PromptAnnotations>;

@Schema({ collection: 'prompt_annotations', timestamps: false })
export class PromptAnnotations {
  // 标注定位键:prompt 文本的指纹 / 原文(唯一索引,upsert 定位)
  @Prop()
  signature!: string;

  // 标注名称(可读别名,建有索引)
  @Prop()
  name!: string;

  // 附加结构化数据(结构不定,透传)
  @Prop({ type: Object })
  data?: Record<string, unknown>;

  // 标注时的逐行文本(便于人工对齐 / 复核)
  @Prop({ type: [String] })
  lines?: string[];

  // 规范化后的逐行文本(去空白 / 统一换行后,用于与查询串匹配)
  @Prop({ type: [String] })
  normalized_lines?: string[];

  // 标注备注(自由文本)
  @Prop()
  note?: string;
}

export const PromptAnnotationsSchema =
  SchemaFactory.createForClass(PromptAnnotations);

// signature 唯一索引:同一 prompt 指纹只允许一条标注(upsert 定位键)
PromptAnnotationsSchema.index(
  { signature: 1 },
  { name: 'uniq_annotation_signature', unique: true },
);
// 按标注名称查询
PromptAnnotationsSchema.index({ name: 1 }, { name: 'annotation_name' });
