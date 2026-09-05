/**
 * labels 模块 —— 手动标注模块装配(labels.module.ts)
 *
 * 职责:为 LabelsController 注册两个 Mongoose 模型:
 *   - ManualLabels:人工标签(manual-labels 集合)
 *   - PromptAnnotations:提示词批注(prompt-annotations 集合)
 * 仅 controller + 模型,无额外 provider(读写逻辑全部内聚在 controller,
 * SQLite 读写经 sqlite.module 的全局注入 token SQLITE_DB)。
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ManualLabelCategories,
  ManualLabelCategoriesSchema,
  ManualLabels,
  ManualLabelsSchema,
  PromptAnnotations,
  PromptAnnotationsSchema,
} from '../../schemas';
import { LabelsController } from './labels.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ManualLabels.name, schema: ManualLabelsSchema },
      { name: PromptAnnotations.name, schema: PromptAnnotationsSchema },
      {
        name: ManualLabelCategories.name,
        schema: ManualLabelCategoriesSchema,
      },
    ]),
  ],
  controllers: [LabelsController],
})
export class LabelsModule {}
