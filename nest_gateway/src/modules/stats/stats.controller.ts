/**
 * stats 模块 —— 统计页 API 控制器(stats.controller.ts)
 *
 * 职责:镜像旧版 FastAPI /api/stats/* 的 9 个端点,提供统计页全部数据:
 *   GET overview            总览(图片总数/TOP10 模型与 LoRA/日期边界与均值)
 *   GET heatmap             按"日期×小时"的热力数据
 *   GET prompt-keywords     提示词关键词频率/覆盖度
 *   GET lora-frequency      LoRA 出现频率
 *   GET lora-cooccurrence   LoRA 共现(以 focus_lora 为中心)
 *   GET lora-profile        LoRA 画像(共现 LoRA + 关联提示词层)
 *   GET lora-keywords       LoRA → 关键词 分组统计
 *   GET prompt-layers       提示词层(positive 层)统计,可按 target_lora 过滤
 *   GET prompt-cooccurrence 关键词共现(以 keyword 为中心,实时)
 *
 * 缓存策略(与旧版对齐):
 *   - 无过滤条件 → 走 stats_summaries 缓存(避免每次全量计算)
 *   - 有过滤条件 → 实时从 stats_docs 计算
 *   - overview/heatmap 始终实时聚合 images 集合
 *   - readMode(SQLITE_READ=1)时读路径走 SQLite 对应查询
 *   - isEnginePending(纯远程未配库)时各端点返回空数据(静默降级)
 */
import {
  Controller,
  Get,
  Inject,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type Database from 'better-sqlite3';
import { Images, ImagesDocument, StatsDocs, StatsDocsDocument, StatsSummaries, StatsSummariesDocument } from '../../schemas';
import {
  hasParsedWorkflow,
  iterPositivePromptLayers,
  iterPromptKeywords,
  normalizePromptLine,
  isZeroWeightEntry,
} from '../../lib/stats_cache';
import { Counter } from '../../utils/counter';
import { escapeRegExp } from '../../utils/escape-regex';
import { SQLITE_DB } from '../../sqlite/sqlite.module';
import {
  statsDocsForAnalysis,
  statsHeatmap,
  statsOverview,
  statsSummary,
} from '../../sqlite/reader';
import { statsSummaryReadySqlite } from '../../lib/stats_cache';
import { isEnginePending } from '../../lib/engine';

/**
 * 统计查询参数(全部来自 URL query,均为可选字符串):
 *   q                全文关键词(模糊匹配 prompts.search_text)
 *   filename         文件名过滤(正则模糊)
 *   base_model       基础模型子串匹配(家族名,忽略大小写)
 *   lora             LoRA 名(多端点复用:过滤 / 聚焦目标)
 *   from_date/to_date 创建日期区间(YYYY-MM-DD)
 *   limit            返回条数
 *   include_quality  预留:是否包含质量维度
 *   top_loras        关键词统计的 LoRA 排行条数
 *   top_keywords     每 LoRA 的关键词条数
 *   target_lora      prompt-layers 的目标 LoRA
 *   keyword          prompt-cooccurrence 的目标关键词
 */
interface StatsQuery {
  q?: string;
  filename?: string;
  base_model?: string;
  lora?: string;
  from_date?: string;
  to_date?: string;
  limit?: string;
  include_quality?: string;
  top_loras?: string;
  top_keywords?: string;
  target_lora?: string;
  keyword?: string;
}

/**
 * 判断是否存在"实时计算"类过滤条件:
 * 任意一个分析过滤字段非空即返回 true(此时不走 stats_summaries 缓存)。
 * 注意:limit/top_loras/top_keywords/target_lora/keyword 等"输出形状"
 * 参数不算过滤条件(它们只改变返回条数,不改变查询范围)。
 * @param q 解析后的查询参数
 * @returns 存在过滤条件返回 true
 */
function hasAnalysisFilters(q: StatsQuery): boolean {
  return Boolean(
    (q.q ?? '').trim() ||
      (q.filename ?? '').trim() ||
      (q.base_model ?? '').trim() ||
      (q.lora ?? '').trim() ||
      (q.from_date ?? '').trim() ||
      (q.to_date ?? '').trim(),
  );
}

/**
 * limit 解析(宽松版):undefined/非法/负数一律回退默认值,
 * 合法值钳制到 [0, max]。与 labels 的 parseLimit 不同:
 * 这里静默回退而非 400(统计端点对畸形参数容忍度高)。
 * @param raw 原始 limit 字符串
 * @param def 默认值
 * @param max 上限
 * @returns 解析后的非负整数 limit
 */
function parseLimit(raw: string | undefined, def: number, max = 200): number {
  const n = raw ? parseInt(raw, 10) : def;
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, max);
}

/**
 * Stats controller — 9 endpoints mirroring legacy FastAPI /api/stats/*.
 *
 * Cache strategy (与旧版对齐):
 *   - 无过滤条件 → 走 stats_summaries 缓存
 *   - 有过滤条件 → 实时从 stats_docs 计算
 *   - overview/heatmap 始终实时聚合 images 集合
 */
@Controller('api/stats')
export class StatsController {
  /** 切读开关(SQLITE_READ=1):读路径走 SQLite 替代 Mongo。 */
  private readonly readMode: boolean;

  constructor(
    private readonly config: ConfigService,
    @Inject(SQLITE_DB) private readonly sqliteDb: Database.Database,
    @InjectModel(Images.name) private readonly imagesModel: Model<ImagesDocument>,
    @InjectModel(StatsDocs.name) private readonly statsDocsModel: Model<StatsDocsDocument>,
    @InjectModel(StatsSummaries.name) private readonly statsSummaryModel: Model<StatsSummariesDocument>,
  ) {
    this.readMode = this.config.get<boolean>('sqlite.readMode') ?? false;
  }

  // ----------------------------------------------------------- cache helpers

  /**
   * 读统计缓存(stats_summaries 集合 / SQLite summaries 表)。
   * 纯远程未配库时返回 null(等价于"缓存未就绪",调用方走实时计算空结果)。
   * @param kind 缓存种类(prompt_keywords / lora_frequency / lora_cooccurrence /
   *             lora_profile / lora_keywords / prompt_layers)
   * @param focusLora 聚焦 LoRA(仅 lora_cooccurrence / lora_profile 使用,
   *                  作为复合键 focus_lora)
   * @returns 缓存文档(无 _id)或 null
   */
  private async getStatsSummary(
    kind: string,
    focusLora = '',
  ): Promise<Record<string, unknown> | null> {
    if (isEnginePending(this.config)) {
      return null;
    }
    if (this.readMode) {
      return statsSummary(this.sqliteDb, kind, focusLora);
    }
    const query: Record<string, unknown> = { kind };
    if (focusLora) query.focus_lora = focusLora;
    const doc = await this.statsSummaryModel.collection.findOne(query, {
      projection: { _id: 0 },
    });
    return doc as Record<string, unknown> | null;
  }

  /**
   * 统计缓存是否已就绪(meta 文档存在 = 至少完整构建过一次)。
   * 用于调用方决定是直接返回"缓存未就绪"提示还是走实时计算。
   * @returns 缓存可读返回 true
   */
  private async cachedStatsReady(): Promise<boolean> {
    if (isEnginePending(this.config)) {
      return false;
    }
    if (this.readMode) {
      return statsSummaryReadySqlite(this.sqliteDb);
    }
    const doc = await this.statsSummaryModel.collection.findOne(
      { _id: 'meta' } as never,
      { projection: { _id: 1 } },
    );
    return doc !== null;
  }

  /**
   * 从 stats_docs 查过滤后的文档(实时计算用)。
   * 过滤构造:has_parsed_workflow 恒为 true(只统计已解析的工作流),
   * 叠加 base_model 子串(家族名,忽略大小写)/ loras.names / created_date 区间 /
   * filename 正则 / search_text 全文正则(用户输入全部 escapeRegExp 转义)。
   * readMode 走 SQLite 等价查询(statsDocsForAnalysis)。
   * @param q 查询参数
   * @returns 命中文档数组(无 _id)
   */
  private async docsForAnalysis(q: StatsQuery): Promise<Record<string, unknown>[]> {
    if (isEnginePending(this.config)) {
      return [];
    }
    if (this.readMode) {
      return statsDocsForAnalysis(this.sqliteDb, {
        q: q.q,
        filename: q.filename,
        baseModel: q.base_model,
        lora: q.lora,
        fromDate: q.from_date,
        toDate: q.to_date,
      });
    }
    // Mongo 侧组装 filter
    const filter: Record<string, unknown> = { has_parsed_workflow: true };
    if (q.base_model)
      filter['model.base_model'] = { $regex: escapeRegExp(q.base_model), $options: 'i' };
    if (q.lora) filter['loras.names'] = q.lora;
    // 日期区间:闭区间 [from, to]
    if (q.from_date || q.to_date) {
      filter.created_date = {};
      if (q.from_date) (filter.created_date as Record<string, unknown>)['$gte'] = q.from_date;
      if (q.to_date) (filter.created_date as Record<string, unknown>)['$lte'] = q.to_date;
    }
    if (q.filename) filter['file.filename'] = { $regex: escapeRegExp(q.filename), $options: 'i' };
    if (q.q) {
      filter['prompts.search_text'] = { $regex: escapeRegExp(q.q), $options: 'i' };
    }
    return this.statsDocsModel.collection
      .find(filter, { projection: { _id: 0 } })
      .toArray();
  }

  // ----------------------------------------------------------- overview (实时)

  /**
   * GET /api/stats/overview — 总览(始终实时聚合 images 集合,不走缓存):
   *   total_images:prompts.positive 非空的图片总数
   *   base_models:TOP10 模型(count 降序)
   *   loras:TOP10 LoRA(先 $unwind 展开 loras.names 数组再分组)
   *   date_bounds:首/末创建日期 + 平均步数/CFG(取 samplers 数组首元素)
   * readMode 走 SQLite(statsOverview)。
   * @returns { total_images, base_models, loras, date_bounds }
   */
  @Get('overview')
  async overview(): Promise<Record<string, unknown>> {
    // 纯远程未配库:返回全零空结构(前端可直接渲染)
    if (isEnginePending(this.config)) {
      return { total_images: 0, base_models: [], loras: [], date_bounds: {} };
    }
    if (this.readMode) {
      const r = statsOverview(this.sqliteDb);
      return {
        total_images: r.totalImages,
        base_models: r.baseModels,
        loras: r.loras,
        date_bounds: r.dateBounds,
      };
    }
    const coll = this.imagesModel.collection;
    // 基础过滤:只统计有有效 positive prompt 的批次(与旧版口径一致)
    const baseFilter = { 'prompts.positive': { $exists: true, $nin: [null, '', []] } };
    const totalImages = await coll.countDocuments(baseFilter);

    // TOP10 模型:按 model.base_model 分组计数降序
    const baseModels = await coll
      .aggregate([
        { $match: baseFilter },
        { $match: { 'model.base_model': { $nin: [null, ''] } } },
        { $group: { _id: '$model.base_model', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ])
      .toArray();

    // TOP10 LoRA:先 $unwind 展开数组元素,再分组计数降序
    const loras = await coll
      .aggregate([
        { $match: baseFilter },
        { $unwind: '$loras.names' },
        { $match: { 'loras.names': { $nin: [null, ''] } } },
        { $group: { _id: '$loras.names', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ])
      .toArray();

    // 日期边界与均值:min/max created_date + 首采样器 steps/cfg 的平均
    const dateBounds = await coll
      .aggregate([
        { $match: baseFilter },
        {
          $group: {
            _id: null,
            first_date: { $min: '$created_date' },
            last_date: { $max: '$created_date' },
            avg_steps: { $avg: { $arrayElemAt: ['$samplers.steps', 0] } },
            avg_cfg: { $avg: { $arrayElemAt: ['$samplers.cfg', 0] } },
          },
        },
      ])
      .toArray();

    // 输出形状:模型/LoRA 归一为 { label, count }
    return {
      total_images: totalImages,
      base_models: baseModels.map((r) => ({ label: r._id, count: r.count })),
      loras: loras.map((r) => ({ label: r._id, count: r.count })),
      date_bounds: dateBounds[0] ?? {},
    };
  }

  // ----------------------------------------------------------- heatmap (实时)

  /**
   * GET /api/stats/heatmap — "日期×小时"热力(始终实时聚合 images 集合):
   * 以 created_date/created_hour 为坐标(批次级缺省时回退到首张图的
   * images.created_date/created_hour),分组计数,按日期、小时升序输出。
   * @returns { items: [{ date, hour, count }] }
   */
  @Get('heatmap')
  async heatmap(): Promise<Record<string, unknown>> {
    if (isEnginePending(this.config)) {
      return { items: [] };
    }
    if (this.readMode) {
      const rows = statsHeatmap(this.sqliteDb);
      return {
        items: rows.map((r) => ({
          date: r.heatmap_date,
          hour: r.heatmap_hour,
          count: r.count,
        })),
      };
    }
    const coll = this.imagesModel.collection;
    // 与 overview 同款基础过滤
    const baseFilter = { 'prompts.positive': { $exists: true, $nin: [null, '', []] } };
    const rows = await coll
      .aggregate([
        { $match: baseFilter },
        {
          // 坐标取值:批次级字段优先,缺省回退首图数组元素
          $project: {
            heatmap_date: {
              $ifNull: ['$created_date', { $arrayElemAt: ['$images.created_date', 0] }],
            },
            heatmap_hour: {
              $ifNull: ['$created_hour', { $arrayElemAt: ['$images.created_hour', 0] }],
            },
          },
        },
        // 过滤无效坐标(日期空或小时 null)
        { $match: { heatmap_date: { $nin: [null, ''] }, heatmap_hour: { $ne: null } } },
        {
          // 按 (date, hour) 组合分组计数
          $group: {
            _id: { date: '$heatmap_date', hour: '$heatmap_hour' },
            count: { $sum: 1 },
          },
        },
        // 输出顺序:日期升序、小时内升序
        { $sort: { '_id.date': 1, '_id.hour': 1 } },
      ])
      .toArray();

    return {
      items: rows.map((r) => ({
        date: r._id?.date,
        hour: r._id?.hour,
        count: r.count,
      })),
    };
  }

  // ----------------------------------------------------------- prompt-keywords

  /**
   * GET /api/stats/prompt-keywords — 提示词关键词统计。
   * 无过滤条件:优先返回缓存(prompt_keywords),截断到 limit 条并标 cache_hit。
   * 有过滤/无缓存:实时计算 —— 遍历命中文档的关键词(iterPromptKeywords):
   *   count = 关键词总出现次数;doc_hits = 出现该词的文档数;
   *   percentage = doc_hits/totalDocs;density = count/doc_hits(平均每文档次数)。
   * 标签规范化:关键词经 normalizePromptLine 归一,labelMap 保留首个原始写法。
   * @returns { items, total_docs, cache_hit }
   */
  @Get('prompt-keywords')
  async promptKeywords(@Query() q: StatsQuery): Promise<Record<string, unknown>> {
    const limit = parseLimit(q.limit, 30);

    // 缓存路径:无过滤条件时优先命中
    if (!hasAnalysisFilters(q)) {
      const cached = await this.getStatsSummary('prompt_keywords');
      if (cached) {
        const items = (cached.items as Array<Record<string, unknown>>) ?? [];
        return {
          ...cached,
          items: items.slice(0, limit),
          cache_hit: true,
        };
      }
    }

    // 实时计算
    const docs = await this.docsForAnalysis(q);
    const occurrences = new Counter<string>();
    const docHits = new Counter<string>();
    const labelMap = new Map<string, string>();

    for (const doc of docs) {
      const keywords = iterPromptKeywords(doc as never);
      // 同文档内关键词去重后计 doc_hits(去重后的集合只加一次)
      const keywordSet = new Set(keywords);
      occurrences.update(keywords);
      docHits.update([...keywordSet]);
      // 记录规范化 → 原始写法 的映射(首个出现者为准,已有写入则保留首个)
      for (const kw of keywords) {
        const normalized = normalizePromptLine(kw);
        if (normalized && !labelMap.has(normalized)) {
          labelMap.set(normalized, kw);
        }
      }
    }

    const totalDocs = docs.length;
    return {
      items: occurrences.mostCommon(limit).map(([label, count]) => {
        const normalized = normalizePromptLine(label);
        const hits = docHits.get(label) ?? 0;
        return {
          // 展示原始写法(规范化后首个版本)
          label: labelMap.get(normalized) ?? label,
          count,
          doc_hits: hits,
          // percentage 保留两位小数
          percentage: totalDocs ? Math.round((hits / totalDocs) * 10000) / 100 : 0,
          // density 保留三位小数(平均每文档出现次数)
          density: hits ? Math.round((count / hits) * 1000) / 1000 : 0,
        };
      }),
      total_docs: totalDocs,
      cache_hit: false,
    };
  }

  // ----------------------------------------------------------- lora-frequency

  /**
   * GET /api/stats/lora-frequency — LoRA 出现频率。
   * 无过滤条件:缓存(lora_frequency);否则实时:每文档 LoRA 名去重后计频。
   * @returns { items: [{ label, doc_hits, percentage }], total_docs, cache_hit }
   */
  @Get('lora-frequency')
  async loraFrequency(@Query() q: StatsQuery): Promise<Record<string, unknown>> {
    const limit = parseLimit(q.limit, 50);

    if (!hasAnalysisFilters(q)) {
      const cached = await this.getStatsSummary('lora_frequency');
      if (cached) {
        const items = (cached.items as Array<Record<string, unknown>>) ?? [];
        return { ...cached, items: items.slice(0, limit), cache_hit: true };
      }
    }

    // 实时:文档内去重计数(doc_hits 语义 = 含该 LoRA 的文档数)
    const docs = await this.docsForAnalysis(q);
    const freq = new Counter<string>();
    for (const doc of docs) {
      const names = (doc as { loras?: { names?: string[] } }).loras?.names ?? [];
      freq.update([...new Set(names.filter(Boolean))]);
    }
    const totalDocs = docs.length;
    return {
      items: freq.mostCommon(limit).map(([label, count]) => ({
        label,
        doc_hits: count,
        percentage: totalDocs ? Math.round((count / totalDocs) * 10000) / 100 : 0,
      })),
      total_docs: totalDocs,
      cache_hit: false,
    };
  }

  // ----------------------------------------------------------- lora-cooccurrence

  /**
   * GET /api/stats/lora-cooccurrence — 以 focus_lora 为中心的 LoRA 共现统计。
   * 必须提供 lora 参数(缺省返回空结果)。过滤条件剥离 lora 本身后
   * (lora 是聚焦对象而非过滤条件),无其他过滤时优先走缓存(lora_cooccurrence
   * + focus_lora 复合键);实时计算只统计包含 focus_lora 的文档,统计其
   * 其余 LoRA 的出现频次(自身被排除)。
   * @returns { items, total_docs(含聚焦 LoRA 的文档数), focus_lora, cache_hit }
   */
  @Get('lora-cooccurrence')
  async loraCooccurrence(@Query() q: StatsQuery): Promise<Record<string, unknown>> {
    const focusLora = (q.lora ?? '').trim();
    const limit = parseLimit(q.limit, 50);
    if (!focusLora) {
      return { items: [], total_docs: 0, focus_lora: '' };
    }

    // 缓存判断:把 lora 从过滤条件中剔除(聚焦参数不影响过滤语义)
    if (!hasAnalysisFilters({ ...q, lora: '' })) {
      const cached = await this.getStatsSummary('lora_cooccurrence', focusLora);
      if (cached) {
        const items = (cached.items as Array<Record<string, unknown>>) ?? [];
        return { ...cached, items: items.slice(0, limit), cache_hit: true };
      }
    }

    // 实时:过滤条件保留 focusLora(只取含它的文档)
    const docs = await this.docsForAnalysis({ ...q, lora: focusLora });
    const coOcc = new Counter<string>();
    let matchedDocs = 0;
    for (const doc of docs) {
      const names = new Set(
        (doc as { loras?: { names?: string[] } }).loras?.names?.filter(Boolean) ?? [],
      );
      if (!names.has(focusLora)) continue;
      matchedDocs += 1;
      // 只统计"除 focusLora 以外"的共现 LoRA
      coOcc.update([...names].filter((n) => n !== focusLora));
    }
    return {
      items: coOcc.mostCommon(limit).map(([label, count]) => ({
        label,
        doc_hits: count,
        percentage: matchedDocs ? Math.round((count / matchedDocs) * 10000) / 100 : 0,
      })),
      total_docs: matchedDocs,
      focus_lora: focusLora,
      cache_hit: false,
    };
  }

  // ----------------------------------------------------------- lora-profile

  /**
   * GET /api/stats/lora-profile — LoRA 画像:共现 LoRA + 关联的 positive
   * 提示词层。必须提供 lora 参数。缓存键 lora_profile + focus_lora;
   * 实时计算中,prompts 统计按"提示词层"(iterPositivePromptLayers)计频:
   *   count = 层出现总次数;doc_hits = 出现该层的文档数。
   * @returns { focus_lora, total_docs, co_loras, prompts, cache_hit }
   */
  @Get('lora-profile')
  async loraProfile(@Query() q: StatsQuery): Promise<Record<string, unknown>> {
    const focusLora = (q.lora ?? '').trim();
    const limit = parseLimit(q.limit, 50);
    if (!focusLora) {
      return { focus_lora: '', total_docs: 0, co_loras: [], prompts: [] };
    }

    // 缓存:剔除 lora 后的其余过滤条件为空才可命中
    if (!hasAnalysisFilters({ ...q, lora: '' })) {
      const cached = await this.getStatsSummary('lora_profile', focusLora);
      if (cached) {
        return { ...cached, cache_hit: true };
      }
    }

    const docs = await this.docsForAnalysis({ ...q, lora: focusLora });
    // coLora:共现 LoRA 计数;prompt:层计数;promptDoc:层文档数
    const coLoraCounter = new Counter<string>();
    const promptCounter = new Counter<string>();
    const promptDocCounter = new Counter<string>();
    const labelMap = new Map<string, string>();
    let matchedDocs = 0;

    for (const doc of docs) {
      const names = new Set(
        (doc as { loras?: { names?: string[] } }).loras?.names?.filter(Boolean) ?? [],
      );
      if (!names.has(focusLora)) continue;
      matchedDocs += 1;
      coLoraCounter.update([...names].filter((n) => n !== focusLora));

      // 层统计:同文档内层去重计入 doc 计数,出现次数全量累计
      const layers = iterPositivePromptLayers(doc as never);
      const seen = new Set<string>();
      for (const layer of layers) {
        promptCounter.update([layer.normalized]);
        seen.add(layer.normalized);
        if (!labelMap.has(layer.normalized)) {
          labelMap.set(layer.normalized, layer.label);
        }
      }
      promptDocCounter.update([...seen]);
    }

    return {
      focus_lora: focusLora,
      total_docs: matchedDocs,
      co_loras: coLoraCounter.mostCommon(limit).map(([label, count]) => ({
        label,
        doc_hits: count,
        percentage: matchedDocs ? Math.round((count / matchedDocs) * 10000) / 100 : 0,
      })),
      prompts: promptCounter.mostCommon(limit).map(([label, count]) => {
        const hits = promptDocCounter.get(label) ?? 0;
        return {
          label: labelMap.get(label) ?? label,
          count,
          doc_hits: hits,
          percentage: matchedDocs ? Math.round((hits / matchedDocs) * 10000) / 100 : 0,
          density: hits ? Math.round((count / hits) * 1000) / 1000 : 0,
        };
      }),
      cache_hit: false,
    };
  }

  // ----------------------------------------------------------- lora-keywords

  /**
   * GET /api/stats/lora-keywords — 按 LoRA 分组的关键词统计。
   * 输出 top_loras(默认 8,上限 30)个最常用 LoRA,每个 LoRA 附带
   * top_keywords(默认 12,上限 50)个关联关键词。实时计算:对每个文档
   * 的每个 LoRA,把文档关键词集合累入对应桶(桶.docs 为该 LoRA 文档数)。
   * @returns { items: [{ lora, docs, keywords }], total_docs, cache_hit }
   */
  @Get('lora-keywords')
  async loraKeywords(@Query() q: StatsQuery): Promise<Record<string, unknown>> {
    const topLoras = parseLimit(q.top_loras ?? q.limit, 8, 30);
    const topKeywords = parseLimit(q.top_keywords, 12, 50);

    // 无过滤条件时优先缓存
    if (!hasAnalysisFilters(q)) {
      const cached = await this.getStatsSummary('lora_keywords');
      if (cached) {
        return { ...cached, cache_hit: true };
      }
    }

    const docs = await this.docsForAnalysis(q);
    // bucket:loraName → { docs: 文档数, counter: 关键词计数 }
    const loraGroups = new Map<string, { docs: number; counter: Counter<string> }>();

    for (const doc of docs) {
      // 文档内 LoRA 名去重
      const names = [...new Set(
        (doc as { loras?: { names?: string[] } }).loras?.names?.filter(Boolean) ?? [],
      )];
      if (!names.length) continue;
      // 文档关键词集合(同文档去重,避免一文档刷高频次)
      const keywords = iterPromptKeywords(doc as never);
      const keywordSet = new Set(keywords);
      // 每个 LoRA 桶都累加一次该文档及其关键词
      for (const loraName of names) {
        let bucket = loraGroups.get(loraName);
        if (!bucket) {
          bucket = { docs: 0, counter: new Counter<string>() };
          loraGroups.set(loraName, bucket);
        }
        bucket.docs += 1;
        bucket.counter.update([...keywordSet]);
      }
    }

    const totalDocs = docs.length;
    // 按文档数降序取 topN LoRA
    const ranked = [...loraGroups.entries()]
      .sort((a, b) => b[1].docs - a[1].docs)
      .slice(0, topLoras);

    return {
      items: ranked.map(([loraName, payload]) => ({
        lora: loraName,
        docs: payload.docs,
        keywords: payload.counter.mostCommon(topKeywords).map(([label, count]) => ({
          label,
          doc_hits: count,
          percentage: payload.docs ? Math.round((count / payload.docs) * 10000) / 100 : 0,
        })),
      })),
      total_docs: totalDocs,
      cache_hit: false,
    };
  }

  // ----------------------------------------------------------- prompt-layers

  /**
   * GET /api/stats/prompt-layers — positive 提示词层统计。
   * target_lora 可选:只统计包含该 LoRA 的文档(并输出 target_docs)。
   * 无任何过滤(含 target_lora 为空)时优先缓存(prompt_layers);
   * 层计数与 lora-profile 的 prompts 同口径(count/总次数 + doc_hits/文档数)。
   * @returns { items, total_docs, target_docs, target_lora, cache_hit }
   */
  @Get('prompt-layers')
  async promptLayers(@Query() q: StatsQuery): Promise<Record<string, unknown>> {
    const limit = parseLimit(q.limit, 50);
    const targetLora = (q.target_lora ?? '').trim();

    if (!hasAnalysisFilters(q) && !targetLora) {
      const cached = await this.getStatsSummary('prompt_layers');
      if (cached) {
        const items = (cached.items as Array<Record<string, unknown>>) ?? [];
        return {
          ...cached,
          items: items.slice(0, limit),
          target_docs: 0,
          target_lora: '',
          cache_hit: true,
        };
      }
    }

    const docs = await this.docsForAnalysis(q);
    const occurrences = new Counter<string>();
    const docHits = new Counter<string>();
    const labelMap = new Map<string, string>();
    let targetDocs = 0;

    for (const doc of docs) {
      // 层遍历与去重(与 lora-profile 的 prompts 计算同构)
      const layers = iterPositivePromptLayers(doc as never);
      const seen = new Set<string>();
      // target 判定:无 target_lora 时全部文档计入;有则只计含它的文档
      let hasTarget = !targetLora;
      if (targetLora) {
        const names = new Set(
          (doc as { loras?: { names?: string[] } }).loras?.names?.filter(Boolean) ?? [],
        );
        hasTarget = names.has(targetLora);
        if (hasTarget) targetDocs += 1;
      }
      // 注意:layers 统计不按 hasTarget 过滤(与旧版语义一致,
      // target_lora 只影响 target_docs 计数与过滤文档来源)
      for (const layer of layers) {
        occurrences.update([layer.normalized]);
        seen.add(layer.normalized);
        if (!labelMap.has(layer.normalized)) {
          labelMap.set(layer.normalized, layer.label);
        }
      }
      docHits.update([...seen]);
    }

    const totalDocs = docs.length;
    return {
      items: occurrences.mostCommon(limit).map(([label, count]) => {
        const hits = docHits.get(label) ?? 0;
        return {
          label: labelMap.get(label) ?? label,
          count,
          doc_hits: hits,
          percentage: totalDocs ? Math.round((hits / totalDocs) * 10000) / 100 : 0,
          density: hits ? Math.round((count / hits) * 1000) / 1000 : 0,
        };
      }),
      total_docs: totalDocs,
      target_docs: targetDocs,
      target_lora: targetLora,
      cache_hit: false,
    };
  }

  // ----------------------------------------------------------- prompt-cooccurrence (实时)

  /**
   * GET /api/stats/prompt-cooccurrence — 以 keyword 为中心的关键词共现
   * (始终实时计算,不走缓存)。必须提供 keyword 参数。只统计"规范化后"
   * 包含该关键词的文档,统计其余关键词(排除自身)的出现频次。
   * @returns { items, total_docs(含目标关键词的文档数), keyword }
   */
  @Get('prompt-cooccurrence')
  async promptCooccurrence(@Query() q: StatsQuery): Promise<Record<string, unknown>> {
    const keyword = (q.keyword ?? '').trim();
    const limit = parseLimit(q.limit, 30);
    if (!keyword) {
      return { items: [], total_docs: 0, keyword: '' };
    }

    const docs = await this.docsForAnalysis(q);
    const coOcc = new Counter<string>();
    const docHits = new Counter<string>();
    let matchedDocs = 0;
    // 目标关键词规范化(共现匹配也按规范化后的集合判断)
    const keywordNormalized = normalizePromptLine(keyword);

    for (const doc of docs) {
      const keywords = iterPromptKeywords(doc as never);
      // 规范化集合判断是否含目标词(容忍大小写/空白差异)
      const normalizedSet = new Set(keywords.map(normalizePromptLine));
      if (!normalizedSet.has(keywordNormalized)) continue;
      matchedDocs += 1;
      // 其余关键词(规范化后不等于目标的)计入共现
      const otherKeywords = keywords.filter(
        (k) => normalizePromptLine(k) !== keywordNormalized,
      );
      coOcc.update(otherKeywords);
      // doc_hits:同文档去重
      docHits.update([...new Set(otherKeywords)]);
    }

    return {
      items: coOcc.mostCommon(limit).map(([label, count]) => {
        const hits = docHits.get(label) ?? 0;
        return {
          label,
          count,
          doc_hits: hits,
          percentage: matchedDocs ? Math.round((hits / matchedDocs) * 10000) / 100 : 0,
          density: hits ? Math.round((count / hits) * 1000) / 1000 : 0,
        };
      }),
      total_docs: matchedDocs,
      keyword,
    };
  }
}
