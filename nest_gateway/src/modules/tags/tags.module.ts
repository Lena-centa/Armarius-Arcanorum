/**
 * tags 模块 —— Danbooru tag 补全参考装配(tags.module.ts)
 *
 * 提供 DANBOORU_DB provider:danbooru 库的只读连接单例(工厂探测)。
 * 文件缺失 / 总开关关闭 → null(controller 对空响应,前端空即隐藏)。
 * 与主库 SQLITE_DB(全局注入)相互独立 —— danbooru 库由
 * tools/build_danbooru_db.py 一次性构建,不参与主库 schema/迁移。
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Database from 'better-sqlite3';
import { DANBOORU_DB, sharedDanbooru } from '../../sqlite/danbooru';
import { TagsController } from './tags.controller';

export { DANBOORU_DB };

@Module({
  controllers: [TagsController],
  providers: [
    {
      provide: DANBOORU_DB,
      useFactory: (config: ConfigService): Database.Database | null => {
        const tagSuggest = (config.get<{ enabled?: boolean; dbPath?: string }>(
          'tagSuggest',
        ) ?? {}) as { enabled?: boolean; dbPath?: string };
        if (tagSuggest.enabled === false) return null;
        // 共享连接:与 images 模块 / parse worker 归属注入复用同一连接,
        // IpCharIndex 内存索引全进程只构建一次
        return sharedDanbooru(tagSuggest.dbPath ?? '');
      },
      inject: [ConfigService],
    },
  ],
})
export class TagsModule {}
