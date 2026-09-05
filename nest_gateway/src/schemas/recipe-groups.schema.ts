/**
 * recipe_groups 集合(配方聚合)的 Mongoose schema。
 *
 * 职责:把同一 recipe_key 的多个批次聚合为一份"配方"文档,
 * 提供配方级统计(stats)与代表性字段快照(model / loras / prompts),
 * 供"配方视角"的列表与详情查询,避免逐批次聚合。
 *
 * 数据流向:ingest 层在批次落库时按 recipe_key 聚合 upsert →
 *           stats / 详情页按配方查询读取。
 * 注:recipe_key 由 ingest 层(lib/recipe_keys.ts)补充,不在 parser.py 产出范围。
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type RecipeGroupsDocument = HydratedDocument<RecipeGroups>;

@Schema({ collection: 'recipe_groups', timestamps: false })
export class RecipeGroups {
  // 配方键(唯一索引,upsert 定位键;同一配方跨批次聚合;多网关共享库时跨实例)
  @Prop()
  recipe_key!: string;

  // 聚合内最近的捕获时间(UTC,建有倒序索引,配方列表时间线)
  @Prop()
  captured_at?: Date;

  // 聚合内最近的捕获日期 %Y-%m-%d(UTC)
  @Prop()
  created_date?: string;

  // 配方代表性模型快照(供列表展示,不做全量节点明细)
  @Prop({ type: Object })
  model?: {
    base_model?: string;
  };

  // 配方代表性 LoRA 快照(名称列表,建有索引可检索)
  @Prop({ type: Object })
  loras?: {
    names?: string[];
  };

  // 配方代表性 prompt 快照(全文检索串,建有索引可搜索)
  @Prop({ type: Object })
  prompts?: {
    search_text?: string;
  };

  // 聚合内图片路径快照列表(含 file.filename 等,Object 数组透传,
  // 建有 filename 索引可按图名反查配方)
  @Prop({ type: [Object] })
  images?: Record<string, unknown>[];

  // 配方统计(引擎侧预计算,结构随聚合逻辑而定,透传)
  @Prop({ type: Object })
  stats?: Record<string, unknown>;

  // 聚合包含的批次 / 图片数量(展示用)
  @Prop()
  count?: number;

  // 聚合内各批次的 batch_key 列表(与 images 集合的批次文档关联)
  @Prop({ type: [String] })
  batch_keys?: string[];
}

export const RecipeGroupsSchema = SchemaFactory.createForClass(RecipeGroups);

// recipe_key 唯一索引:配方去重与聚合 upsert 定位
RecipeGroupsSchema.index(
  { recipe_key: 1 },
  { name: 'uniq_recipe_key', unique: true },
);
// 捕获时间倒序:配方列表时间线
RecipeGroupsSchema.index(
  { captured_at: -1 },
  { name: 'recipe_captured_at_desc' },
);
// 捕获日期倒序:按日聚合统计
RecipeGroupsSchema.index(
  { created_date: -1 },
  { name: 'recipe_created_date_desc' },
);
// base_model 索引:按模型筛选配方
RecipeGroupsSchema.index(
  { 'model.base_model': 1 },
  { name: 'recipe_base_model' },
);
// LoRA 名称索引:按 LoRA 筛选配方
RecipeGroupsSchema.index({ 'loras.names': 1 }, { name: 'recipe_lora_names' });
// prompt 全文检索索引:按关键词搜索配方
RecipeGroupsSchema.index(
  { 'prompts.search_text': 1 },
  { name: 'recipe_prompt_search_text' },
);
// 聚合内图片文件名索引:按图名反查所属配方
RecipeGroupsSchema.index(
  { 'images.file.filename': 1 },
  { name: 'recipe_image_filename' },
);
