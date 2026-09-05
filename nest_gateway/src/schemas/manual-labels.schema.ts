/**
 * manual_lora_prompt_labels 集合(手动标注)的 Mongoose schema。
 *
 * 职责:人工维护的"词条 → 语义标注"数据——用户可为某个 LoRA 名、
 * prompt 片段或任意关键词(经 search_text)附加分类 / 别名 / 备注,
 * 供搜索界面与统计展示做人工语义修正(如将 lora 归入某类别)。
 *
 * 被谁使用:labels 模块(标注 CRUD 接口)。
 * 数据流向:前端标注管理页写入 → labels 接口落库 → 查询侧消费。
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ManualLabelsDocument = HydratedDocument<ManualLabels>;

@Schema({ collection: 'manual_lora_prompt_labels', timestamps: false })
export class ManualLabels {
  // 标注分类(如 lora / artist / sampler / style 等,建有索引)
  @Prop()
  category!: string;

  // 关联的 LoRA 名:单个字符串或字符串数组两种形态,
  // 用 Object 存储以兼容(避免 mongoose 强转为单值)
  @Prop({ type: Object })
  loras?: string | string[];

  // 词条显示名(规范后的可读名称,建有索引)
  @Prop()
  name?: string;

  // 检索文本:被标注的原始文本(全文检索 / 关键词匹配用,建有索引)
  @Prop()
  search_text?: string;

  // 标注创建时间(建有倒序索引,按最新标注排序)
  @Prop()
  created_at?: Date;

  // 附加元数据(结构不定,透传)
  @Prop({ type: Object })
  metadata?: Record<string, unknown>;
}

export const ManualLabelsSchema = SchemaFactory.createForClass(ManualLabels);

// 按分类查询(如"该分类下所有标注")
ManualLabelsSchema.index({ category: 1 }, { name: 'manual_label_category' });
// 按 LoRA 名反查标注
ManualLabelsSchema.index({ loras: 1 }, { name: 'manual_label_loras' });
// 按显示名查询
ManualLabelsSchema.index({ name: 1 }, { name: 'manual_label_name' });
// 按检索文本匹配(搜索时联查)
ManualLabelsSchema.index(
  { search_text: 1 },
  { name: 'manual_label_search_text' },
);
// 按创建时间倒序(最新标注优先)
ManualLabelsSchema.index(
  { created_at: -1 },
  { name: 'manual_label_created_at' },
);
