/**
 * manual_label_categories 集合(标注分类)的 Mongoose schema。
 *
 * 职责:存储用户自定义的标注分类(key 标识 + label 展示名)。默认分类
 * 由网关在启动时补齐(见 labels 控制器 onModuleInit),用户在标注库页
 * 可增删,列表接口 /api/manual-labels 的分类下拉与快速标注表单共用。
 *
 * 被谁使用:labels 模块(分类 CRUD 接口)。
 * 数据流向:标注库页写分类 → labels 接口落库 → 分类下拉/校验消费。
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ManualLabelCategoriesDocument = HydratedDocument<ManualLabelCategories>;

@Schema({ collection: 'manual_label_categories', timestamps: false })
export class ManualLabelCategories {
  // 分类标识(唯一,URL 路径 / 标注 category 字段的值,建有唯一索引)
  @Prop()
  key!: string;

  // 分类展示名(下拉框与列表徽章显示)
  @Prop()
  label!: string;

  // 创建时间(排序:默认分类在前,后加的排后)
  @Prop()
  created_at?: Date;
}

export const ManualLabelCategoriesSchema =
  SchemaFactory.createForClass(ManualLabelCategories);

// key 唯一:创建分类查重 + 幂等种子
ManualLabelCategoriesSchema.index(
  { key: 1 },
  { name: 'uniq_manual_label_cat_key', unique: true },
);
