/**
 * Mongoose schema 的统一出口(barrel 文件)。
 *
 * 被谁使用:各业务模块(images / labels / stats 等)在
 * MongooseModule.forFeature([...]) 中注册,并在 service 里以
 * @InjectModel 注入对应的 model token。
 *
 * 集合清单(命名与 Mongo collection 一一对应):
 *   - images                 批次文档(parser record + ingest 批次组装)
 *   - stats_docs             单图统计缓存(供统计页全库聚合)
 *   - stats_summaries        统计汇总缓存(按 kind 预聚合结果)
 *   - recipe_groups          配方聚合(同一 recipe_key 的批次聚合)
 *   - manual_lora_prompt_labels 手动标注(collection 名 manual_lora_prompt_labels)
 *   - prompt_annotations     prompt 标注(signature → 名称 / 备注)
 */
export { Images, ImagesSchema } from './images.schema';
export type { ImagesDocument } from './images.schema';
export { StatsDocs, StatsDocsSchema } from './stats-docs.schema';
export type { StatsDocsDocument } from './stats-docs.schema';
export { StatsSummaries, StatsSummariesSchema } from './stats-summaries.schema';
export type { StatsSummariesDocument } from './stats-summaries.schema';
export { RecipeGroups, RecipeGroupsSchema } from './recipe-groups.schema';
export type { RecipeGroupsDocument } from './recipe-groups.schema';
export { ManualLabels, ManualLabelsSchema } from './manual-labels.schema';
export type { ManualLabelsDocument } from './manual-labels.schema';
export {
  ManualLabelCategories,
  ManualLabelCategoriesSchema,
} from './manual-label-categories.schema';
export type { ManualLabelCategoriesDocument } from './manual-label-categories.schema';
export {
  PromptAnnotations,
  PromptAnnotationsSchema,
} from './prompt-annotations.schema';
export type { PromptAnnotationsDocument } from './prompt-annotations.schema';
export { Favorites, FavoritesSchema } from './favorites.schema';
export type { FavoritesDocument } from './favorites.schema';
export {
  FavoriteCategories,
  FavoriteCategoriesSchema,
} from './favorite-categories.schema';
export type { FavoriteCategoriesDocument } from './favorite-categories.schema';
