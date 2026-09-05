/**
 * tags 模块 —— Danbooru tag 补全参考控制器(tags.controller.ts)
 *
 * 提供三条查表能力线(全部纯 SQLite,网关零 ML;资产缺失时静默降级):
 *   GET /api/tag-suggest?q=&limit=       搜索框字面/别名联想
 *   GET /api/tag-related?tag=&limit=     单 tag 索引:LLR+GNN 邻居 RRF 融合
 *                                         + 语义分类分组(角色/背景/环境/
 *                                           特征/构图) + wiki 官方特征
 *   GET /api/batch-suggestions?batch_key= 导入时预计算的组推荐(读主库结果表)
 *
 * 降级语义:danbooru 库文件缺失(未构建)或总开关关闭 → enabled=false,
 * 前端"空即隐藏"、不报错;batch-suggestions 依赖主库 batch_tag_suggestions
 * 表(未建/无数据时 payload=null)。
 */
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Database from 'better-sqlite3';
import { SQLITE_DB } from '../../sqlite/sqlite.module';
import {
  DANBOORU_DB,
  relatedTags,
  suggestPrefix,
  type DanbooruTag,
  type RelatedResult,
} from '../../sqlite/danbooru';

interface TagSuggestConfig {
  enabled?: boolean;
  dbPath?: string;
}

@Controller('api')
export class TagsController {
  private readonly enabled: boolean;

  constructor(
    @Inject(DANBOORU_DB) private readonly danbooru: Database.Database | null,
    @Inject(SQLITE_DB) private readonly sqliteDb: Database.Database,
    config: ConfigService,
  ) {
    const ts = (config.get<TagSuggestConfig>('tagSuggest') ?? {}) as TagSuggestConfig;
    this.enabled = ts.enabled !== false && this.danbooru !== null;
  }

  /** 联想:字面前缀(范围扫描)+ 别名层(多语言)。 */
  @Get('tag-suggest')
  tagSuggest(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ): { enabled: boolean; items: DanbooruTag[] } {
    if (!this.enabled) return { enabled: false, items: [] };
    const items = suggestPrefix(this.danbooru!, String(q ?? ''), clampLimit(limit, 20));
    return { enabled: true, items };
  }

  /** 单 tag 索引:混合推荐 + 语义分类分组 + 官方特征(需求 1)。 */
  @Get('tag-related')
  tagRelated(
    @Query('tag') tag?: string,
    @Query('limit') limit?: string,
  ): { enabled: boolean } & RelatedResult {
    if (!this.enabled) return { enabled: false, tag: null, related: [], categories: {} };
    const result = relatedTags(this.danbooru!, String(tag ?? ''), clampLimit(limit, 10));
    return { enabled: true, ...result };
  }

  /** 导入时预计算的组推荐(需求 2,读主库结果表)。 */
  @Get('batch-suggestions')
  batchSuggestions(
    @Query('batch_key') batchKey?: string,
  ): { enabled: boolean; payload: unknown } {
    if (!batchKey) return { enabled: true, payload: null };
    try {
      const row = this.sqliteDb
        .prepare('SELECT payload FROM batch_tag_suggestions WHERE batch_key = ?')
        .get(String(batchKey)) as { payload: string } | undefined;
      if (!row) return { enabled: true, payload: null };
      return { enabled: true, payload: JSON.parse(row.payload) };
    } catch {
      // 表未建(SQLite 主库 schema 未迁移)或 JSON 损坏 → 静默降级
      return { enabled: true, payload: null };
    }
  }
}

/** limit 参数收敛(1..50,默认值兜底)。 */
function clampLimit(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 50);
}
