/**
 * ============================================================
 * images.module — 图片库 HTTP 接口模块装配(纯依赖注入声明)。
 *
 * 文件职责(本文件只做装配,不含业务逻辑):
 *  1. 注册 Mongo 模型:Images(images 集合,batch 级批次文档)与
 *     RecipeGroups(recipe_groups 集合,配方聚合文档),供 ImagesController
 *     以 @InjectModel 注入;
 *  2. 引入 OrchestrationModule:提供 OrchestrationService(内存视图 /
 *     近实时缓冲查询 getMemoryView、findMemoryFileBySha256 未入库兜底),
 *     用于列表/摘要/选项接口的内存合并与未入库图片的原图定位;
 *  3. 引入 GenerateModule:提供 GenerateWorkerService(RPC 客户端,
 *     push_workflow 用于 /api/image/:sha256/open-comfyui 把内嵌 UI
 *     workflow 写入 ComfyUI 用户工作流目录);
 *  4. 声明唯一控制器 ImagesController(路由前缀 /api,实现见
 *     images.controller.ts)。
 *
 * 装配关系:
 *   AppModule → ImagesModule
 *   ImagesModule ├─ MongooseModule.forFeature(Images, RecipeGroups)
 *                ├─ OrchestrationModule(导出 OrchestrationService)
 *                └─ GenerateModule(导出 GenerateWorkerService)
 * 控制器额外注入的 SQLITE_DB(由 @Global SqliteModule 全局提供)与
 * ConfigService(全局 ConfigModule)无需本模块显式 import。
 *
 * 数据流向:
 *   HTTP 请求 → ImagesController(参数校验 parseLimit / buildFilter 构造
 *   Mongo 过滤条件 / group_mode 分派)→ 存储层二选一(Mongo 集合直查 /
 *   SQLite 只读 reader)→ 内存视图合并(orchestration.getMemoryView,
 *   未入库图片同样可见)→ 响应整形(shapeRecipeGroupDoc /
 *   shapeBatchDoc)返回前端。
 * ============================================================
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import type Database from 'better-sqlite3';
import {
  Images,
  ImagesSchema,
  RecipeGroups,
  RecipeGroupsSchema,
} from '../../schemas';
import { DANBOORU_DB, sharedDanbooru } from '../../sqlite/danbooru';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { GenerateModule } from '../generate/generate.module';
import { ImagesController } from './images.controller';

export { DANBOORU_DB };

/**
 * @Module 元数据说明:
 *   imports —— forFeature 注册 2 个 Mongo 模型 + 2 个业务模块;
 *     forFeature 注册的模型作用域限定在当前模块,ImagesController
 *     @InjectModel 注入的 model token 即由此提供;
 *     OrchestrationModule / GenerateModule 各自导出核心 service,
 *     本模块只消费、不重复声明 provider;
 *   controllers —— ImagesController(/api/* 路由);
 *   providers —— 仅 DANBOORU_DB 工厂(danbooru 只读连接,供 expandIpChars);
 *     其余控制器依赖由 imports 提供。
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      // images 集合(batch 级批次文档,parser record + ingest 批次组装):
      // /api/images、/api/images/summary、/api/images/details 的
      // batch group_mode 数据源,以及 options / instances / image-refs
      // / image 原图的 Mongo 侧数据源
      { name: Images.name, schema: ImagesSchema },
      // recipe_groups 集合(同一 recipe_key 的跨批聚合文档):
      // recipe group_mode 列表与摘要(/api/images?group_mode=recipe、
      // /api/images/summary?group_mode=recipe)的 Mongo 数据源
      { name: RecipeGroups.name, schema: RecipeGroupsSchema },
    ]),
    // 内存视图:OrchestrationService.getMemoryView 在列表 / 摘要 / 选项
    // 接口中与存储层结果按 batch_key 去重合并(Mongo 优先),保证
    // "近实时缓冲、尚未 flush 入库"的图片也能被查询命中;
    // findMemoryFileBySha256 兜底未入库图片的原图定位
    OrchestrationModule,
    // 生成 worker 客户端:GenerateWorkerService.call('push_workflow', ...)
    // 通过 RPC 把图片内嵌的 UI workflow 写入 ComfyUI 用户工作流目录,
    // open-comfyui 路由依赖
    GenerateModule,
  ],
  controllers: [ImagesController],
  providers: [
    {
      provide: DANBOORU_DB,
      useFactory: (config: ConfigService): Database.Database | null => {
        const tagSuggest = (config.get<{ enabled?: boolean; dbPath?: string }>(
          'tagSuggest',
        ) ?? {}) as { enabled?: boolean; dbPath?: string };
        if (tagSuggest.enabled === false) return null;
        // 共享连接:与 tags 模块 / parse worker 归属注入复用同一连接,
        // IpCharIndex 内存索引全进程只构建一次
        return sharedDanbooru(tagSuggest.dbPath ?? '');
      },
      inject: [ConfigService],
    },
  ],
})
export class ImagesModule {}
