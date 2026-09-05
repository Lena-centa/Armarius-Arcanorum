/**
 * stats 模块 —— 统计模块装配(stats.module.ts)
 *
 * 职责:为 StatsController 注册三个 Mongoose 模型:
 *   - Images:overview / heatmap 的实时聚合源
 *   - StatsDocs:过滤后实时统计的计算源(has_parsed_workflow 文档)
 *   - StatsSummaries:无过滤条件下的缓存命中源
 * 仅 controller + 模型注册,无自有 provider。
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Images,
  ImagesSchema,
  StatsDocs,
  StatsDocsSchema,
  StatsSummaries,
  StatsSummariesSchema,
} from '../../schemas';
import { StatsController } from './stats.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Images.name, schema: ImagesSchema },
      { name: StatsDocs.name, schema: StatsDocsSchema },
      { name: StatsSummaries.name, schema: StatsSummariesSchema },
    ]),
  ],
  controllers: [StatsController],
})
export class StatsModule {}
