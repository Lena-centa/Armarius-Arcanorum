/**
 * favorites 集合(图片收藏)的 Mongoose schema。
 *
 * 职责:按图片 sha256 记录用户收藏,用于收藏夹视图聚合展示。
 * 与 images 集合解耦 —— 收藏只存定位键 + 展示所需的最小快照
 * (filename / batch_key / captured_at),原图与完整记录由
 * sha256 / batch_key 反向解析(thumb / images/details)。
 *
 * 被谁使用:favorites 模块(收藏 CRUD);前端收藏夹视图读取。
 * 数据流向:预览/列表收藏切换写入 → favorites 集合 → 收藏夹展示读取。
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type FavoritesDocument = HydratedDocument<Favorites>;

@Schema({ collection: 'favorites', timestamps: false })
export class Favorites {
  // 收藏定位键之一:图片 sha256(与 category 组成复合唯一键)
  @Prop()
  sha256!: string;

  // 展示快照:文件名(列表/预览均需)
  @Prop()
  filename?: string;

  // 所属批次键:打开完整预览用(可空,临时/未入库图无批次)
  @Prop()
  batch_key?: string;

  // 收藏子分类(用户自定义,对应 favorite_categories 的 key)。
  // 必填语义:空串 = 未分类,参与复合唯一键 —— 一图可同时归属多个分类
  @Prop({ required: true, default: '' })
  category!: string;

  // 收藏时的记录时间(ISO-8601,排序用)
  @Prop()
  captured_at?: string;

  // 备注(自由文本,可选)
  @Prop()
  note?: string;

  @Prop()
  created_at?: Date;

  @Prop()
  updated_at?: Date;
}

export const FavoritesSchema = SchemaFactory.createForClass(Favorites);

// (sha256, category) 复合唯一索引:同一张图在每个分类下至多一条收藏(幂等 upsert 定位键)。
// 旧版单列唯一索引 uniq_favorite_sha256({sha256:1}) 会阻止一图多分类,
// 由 favorites controller 启动时幂等替换(见 onModuleInit)。
FavoritesSchema.index(
  { sha256: 1, category: 1 },
  { name: 'uniq_favorite_sha_category', unique: true },
);
