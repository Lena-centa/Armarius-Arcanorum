/**
 * generate 模块 —— 生成页(Replay)模块装配定义(generate.module.ts)
 *
 * 职责:为 GenerateController 提供依赖:
 *   1. Mongoose 模型注册(images / stats_docs / recipe_groups 三张集合,
 *      注入 generate.controller 的 @InjectModel 用)
 *   2. WorkersModule(提供 GenerateWorkerService 与 ParseWorkerService,
 *      二者实际 provider 由 workers 模块统一管理)
 *
 * 导出:GenerateWorkerService 供其他模块(AppModule / 需要 submit 的场景)复用。
 * 注意:ParseWorkerService 由 WorkersModule 提供,此处不重复注册,
 * 与 ParseModule 的依赖关系完全解耦。
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Images,
  ImagesSchema,
  RecipeGroups,
  RecipeGroupsSchema,
  StatsDocs,
  StatsDocsSchema,
} from '../../schemas';
import { WorkersModule } from '../../workers/workers.module';
import { GenerateWorkerService } from '../../workers/generate-worker.service';
import { GenerateController } from './generate.controller';

/**
 * @Module 元数据:
 *   imports —— forFeature 注册 3 个 mongoose 模型 + WorkersModule
 *   controllers —— 本模块唯一的控制器 GenerateController(/api/generate/*)
 *   providers —— GenerateWorkerService 声明为本地 provider(生命周期归本模块)
 *   exports —— 导出给外部模块注入使用
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Images.name, schema: ImagesSchema },
      { name: StatsDocs.name, schema: StatsDocsSchema },
      { name: RecipeGroups.name, schema: RecipeGroupsSchema },
    ]),
    WorkersModule,
  ],
  controllers: [GenerateController],
  providers: [GenerateWorkerService],
  exports: [GenerateWorkerService],
})
export class GenerateModule {}
