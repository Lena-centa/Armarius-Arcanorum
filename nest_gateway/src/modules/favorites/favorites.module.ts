/**
 * favorites 模块 —— 图片收藏模块装配(favorites.module.ts)
 *
 * 职责:为 FavoritesController 注册 Favorites 的 Mongoose 模型。
 * 仅 controller + 模型,无额外 provider(读写逻辑全部内聚在 controller,
 * SQLite 读写经 sqlite.module 的全局注入 token SQLITE_DB)。
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FavoriteCategories, FavoriteCategoriesSchema, Favorites, FavoritesSchema } from '../../schemas';
import { FavoritesController } from './favorites.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Favorites.name, schema: FavoritesSchema },
      { name: FavoriteCategories.name, schema: FavoriteCategoriesSchema },
    ]),
  ],
  controllers: [FavoritesController],
})
export class FavoritesModule {}
