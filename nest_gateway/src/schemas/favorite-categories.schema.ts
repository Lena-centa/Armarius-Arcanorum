/**
 * favorite_categories 集合(收藏分类)的 Mongoose schema。
 *
 * 职责:存储用户自定义的图片收藏分类(key 标识 + label 展示名)。默认分类
 * 由网关在启动时补齐(见 favorites 控制器 onModuleInit),用户在图片列表
 * 的 filters--compact 收藏筛选处可增删;收藏接口 /api/favorites 的分类
 * 下拉与单图收藏弹窗的分类选择共用。
 *
 * 被谁使用:favorites 模块(收藏分类 CRUD 接口)。
 * 数据流向:筛选区管理分类 → favorites 接口落库 → 收藏分类下拉/校验消费。
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type FavoriteCategoriesDocument = HydratedDocument<FavoriteCategories>;

@Schema({ collection: 'favorite_categories', timestamps: false })
export class FavoriteCategories {
  // 分类标识(唯一,URL 路径 / 收藏 category 字段的值,建有唯一索引)
  @Prop()
  key!: string;

  // 分类展示名(下拉框与收藏卡片徽章显示)
  @Prop()
  label!: string;

  // 创建时间(排序:默认分类在前,后加的排后)
  @Prop()
  created_at?: Date;
}

export const FavoriteCategoriesSchema =
  SchemaFactory.createForClass(FavoriteCategories);

// key 唯一:创建分类查重 + 幂等种子
FavoriteCategoriesSchema.index(
  { key: 1 },
  { name: 'uniq_favorite_cat_key', unique: true },
);
