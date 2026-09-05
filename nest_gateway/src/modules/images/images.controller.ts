import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type Database from 'better-sqlite3';
import { existsSync, statSync } from 'fs';
import {
  Images,
  ImagesDocument,
  RecipeGroups,
  RecipeGroupsDocument,
} from '../../schemas';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { GenerateWorkerService } from '../../workers/generate-worker.service';
import {
  WorkerRequestTimeout,
  WorkerRpcError,
  WorkerUnavailableError,
} from '../../workers/generate-worker';
import { firstAccessiblePath, isPathUnderRoots } from '../../lib/paths';
import { isEnginePending } from '../../lib/engine';
import { RequireAuth } from '../../common/auth';
import { buildSeedImages, SeedImageEntry } from '../../lib/seed_images';
import { escapeRegExp } from '../../utils/escape-regex';
import { instanceStamp } from '../../lib/instance';
import {
  isPassthroughRequest,
  passthroughPath,
  passthroughTarget,
  proxyToPeer,
} from '../../lib/passthrough';
import { SQLITE_DB } from '../../sqlite/sqlite.module';
import { DANBOORU_DB, expandIpChars } from '../../sqlite/danbooru';
import {
  batchBySha256,
  batchDetails,
  imageRefs,
  listBatches,
  listOptions,
  listRecipes,
} from '../../sqlite/reader';

/**
 * LoRA 多值筛选规格:正向与排除各自独立 与/或 组合。
 *   - include + includeMode:'or' 命中任一(默认)| 'and' 全部包含
 *   - exclude + excludeMode:'and' 全部不含(默认,任一命中即排除)|
 *     'or' 不同时含全部(仅当全部命中才排除)
 * 单值等价于任一 mode(向后兼容旧 lora/exclude_lora 参数)。
 */
interface LoraFilterSpec {
  include: string[];
  includeMode: 'and' | 'or';
  exclude: string[];
  excludeMode: 'and' | 'or';
}

const IMAGE_REF_FILE_FIELDS = [
  'filename',
  'image_name',
  'sha256',
  'resolved_path',
  'windows_path',
  'source_path',
] as const;

type ImageRefMatchType =
  | 'sha256_exact'
  | 'path_exact'
  | 'filename_exact'
  | 'filename_partial'
  | 'path_partial'
  | 'sha256_partial';

/** 图片引用搜索统一使用小写 `/` 路径,允许用户混用 Windows/POSIX 分隔符。 */
function normalizeImageRefText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, '/');
}

/** Mongo 正则仍是字面量匹配,仅把路径分隔符扩成 `/` 与 `\` 两种安全变体。 */
function imageRefMongoRegex(q: string): string {
  const variants = new Set([
    q,
    q.replace(/[\\/]+/g, '/'),
    q.replace(/[\\/]+/g, '\\'),
  ]);
  return [...variants].filter(Boolean).map(escapeRegExp).join('|');
}

/**
 * 计算匹配种类与排序权重。精确 SHA/路径/文件名优先,随后是文件名、路径、
 * SHA 子串;返回 null 表示该文件只是同批图片,自身并未命中。
 */
function imageRefMatch(
  item: Record<string, unknown>,
  rawQuery: string,
): { type: ImageRefMatchType; rank: number } | null {
  const q = normalizeImageRefText(rawQuery);
  if (!q) return null;
  const filename = normalizeImageRefText(item.filename);
  const imageName = normalizeImageRefText(item.image_name);
  const sha256 = normalizeImageRefText(item.sha256);
  const paths = ['resolved_path', 'windows_path', 'source_path']
    .map((key) => normalizeImageRefText(item[key]))
    .filter(Boolean);
  if (sha256 === q) return { type: 'sha256_exact', rank: 0 };
  if (paths.includes(q)) return { type: 'path_exact', rank: 1 };
  if (filename === q || imageName === q)
    return { type: 'filename_exact', rank: 2 };
  if (filename.includes(q) || imageName.includes(q))
    return { type: 'filename_partial', rank: 3 };
  if (paths.some((path) => path.includes(q)))
    return { type: 'path_partial', rank: 4 };
  if (sha256.includes(q)) return { type: 'sha256_partial', rank: 5 };
  return null;
}

/**
 * 引用判重键降级链:SHA → 规范化路径 → 批次内存储键 → 批次+文件名。
 * 因此同名不同路径会保留,同一引用在多个批次重复出现则折叠。
 */
function imageRefIdentity(item: Record<string, unknown>): string {
  const sha256 = normalizeImageRefText(item.sha256);
  if (sha256) return `sha256:${sha256}`;
  for (const key of ['resolved_path', 'windows_path', 'source_path']) {
    const path = normalizeImageRefText(item[key]);
    if (path) return `path:${path}`;
  }
  const batchKey = String(item.batch_key ?? '');
  const storageKey = normalizeImageRefText(item.storage_key);
  if (storageKey) return `batch:${batchKey}:${storageKey}`;
  return `legacy:${batchKey}:${normalizeImageRefText(item.filename)}:${normalizeImageRefText(item.created_date)}`;
}

/** 按匹配质量排序、折叠重复引用,并补充供前端解释与判重的元数据。 */
function shapeImageRefItems(
  candidates: Array<Record<string, unknown>>,
  q: string,
  limit: number,
): Array<Record<string, unknown>> {
  const matched = candidates
    .map((item) => ({ item, match: imageRefMatch(item, q) }))
    .filter(
      (
        entry,
      ): entry is {
        item: Record<string, unknown>;
        match: { type: ImageRefMatchType; rank: number };
      } => entry.match !== null,
    )
    .sort(
      (a, b) =>
        a.match.rank - b.match.rank ||
        String(b.item.captured_at ?? b.item.created_date ?? '').localeCompare(
          String(a.item.captured_at ?? a.item.created_date ?? ''),
        ),
    );
  const unique = new Map<string, Record<string, unknown>>();
  for (const { item, match } of matched) {
    const refKey = imageRefIdentity(item);
    const existing = unique.get(refKey);
    if (existing) {
      existing.duplicate_count = Number(existing.duplicate_count ?? 1) + 1;
      continue;
    }
    const shaped = { ...item };
    delete shaped.storage_key;
    unique.set(refKey, {
      ...shaped,
      ref_key: refKey,
      match_type: match.type,
      duplicate_count: 1,
    });
  }
  return [...unique.values()].slice(0, limit);
}

/**
 * ============================================================
 * images.controller — WorkflowDB NestJS 网关的图片库 HTTP 接口层。
 *
 * 文件职责:
 *  1. 图片批次列表 /api/images 与摘要列表 /api/images/summary(batch/recipe
 *     两种 group_mode 分页,含内存视图合并);
 *  2. 批次详情 /api/images/details(POST,按 batch_key 批量取全量文档);
 *  3. 原图下发 /api/image/:sha256(本地文件 / 纯远程透传代理);
 *  4. ComfyUI 工作流打开 /api/image/:sha256/open-comfyui;
 *  5. 筛选器选项 /api/options、来源实例 /api/instances、引用搜索 /api/image-refs。
 *
 * 路由一览(前缀 /api,由 @Controller('api') 声明):
 *   GET  /options                     —— base_models/loras 可选值(前端筛选器)
 *   GET  /instances                   —— 多网关共享库的来源实例列表
 *   GET  /images                      —— 批次分页列表(batch/recipe group_mode)
 *   GET  /images/summary              —— 列表卡片摘要(仅投影字段,轻量)
 *   POST /images/details              —— 按 batch_keys 批量取批次详情
 *   GET  /image/:sha256               —— 原图文件下发(本地文件 / 纯远程透传)
 *   POST /image/:sha256/open-comfyui  —— 把内嵌 UI workflow 推入 ComfyUI 并返回链接
 *   GET  /image-refs                  —— 按文件名/路径/SHA 搜索图片引用
 *
 * 数据流向:
 *   请求 → 控制器(参数校验 parseLimit/page、buildFilter 构造 Mongo 过滤条件、
 *   group_mode 分派)→ 存储层二选一:
 *     - SQLite readMode(只读):sqlite/reader.ts 的 listBatches / listRecipes /
 *       batchDetails / batchBySha256 / imageRefs / listOptions;
 *     - Mongo:imagesModel(images 集合)与 recipeGroupModel(recipe_groups 集合)
 *       的原生 collection 查询(distinct / find / countDocuments)。
 *   → 内存视图合并:orchestration.getMemoryView()(近实时缓冲、未 flush 入库的
 *     图片)与 Mongo 结果按 batch_key 去重(Mongo 优先)后合并排序分页。
 *   → 响应整形:shapeRecipeGroupDoc(recipe 模式嵌套 batch/recipe 对象)、
 *     shapeBatchDoc(batch 模式补 batch 对象)→ 与前端 app.js 消费结构对应。
 *
 * 前端消费对应:
 *   - batch 模式 items[i] 为 batch 级文档:{ batch_key, created_date,
 *     captured_at, model, loras, images[{file:{filename,sha256}}], ... };
 *     卡片仅用摘要字段,详情页再 POST /images/details 取全量。
 *   - recipe 模式 items[i] 含嵌套 batch{key,count,seeds,seed_images,
 *     files_preview,images} 与 recipe{key,batch_count,batch_keys,members}。
 * ============================================================
 */
/**
 * Images controller — 图片列表/摘要/详情/代理/选项/引用搜索。
 *
 * /api/images 支持 batch group_mode(直接查 images 集合分页)。
 * recipe group_mode 查 recipe_groups 集合。
 * 内存视图(近实时缓冲,未入库)与 Mongo 结果合并返回:batch 模式下
 * 内存中待 flush 的图片可直接被列表/摘要/选项/原图/缩略图查询命中。
 */
type CapturedAtRange = { $gte?: Date; $lte?: Date };

function capturedAtBound(value: string, isTo: boolean): Date {
  const trimmed = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T${isTo ? '23:59:59.999' : '00:00:00.000'}Z`
    : trimmed;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(
      'from_date/to_date must be a valid ISO date or timestamp',
    );
  }
  return parsed;
}

function sqliteCapturedAtBounds(filter: Record<string, unknown>): {
  fromDate?: string;
  toDate?: string;
} {
  const range = filter.captured_at as CapturedAtRange | undefined;
  return {
    fromDate: range?.$gte?.toISOString(),
    toDate: range?.$lte?.toISOString(),
  };
}

@Controller('api')
export class ImagesController {
  /** Mongo images 集合名(取配置 mongo.collection,默认 "images")。 */
  private readonly collectionName: string;
  /** SQLite 只读模式开关(配置 sqlite.readMode):为 true 时查询全走 better-sqlite3。 */
  private readonly readMode: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly orchestration: OrchestrationService,
    private readonly generateWorker: GenerateWorkerService,
    @Inject(SQLITE_DB) private readonly sqliteDb: Database.Database,
    @InjectModel(Images.name)
    private readonly imagesModel: Model<ImagesDocument>,
    @InjectModel(RecipeGroups.name)
    private readonly recipeGroupModel: Model<RecipeGroupsDocument>,
    @Inject(DANBOORU_DB) private readonly danbooruDb: Database.Database | null,
  ) {
    // 注入依赖:config(配置)、orchestration(内存视图)、generateWorker(RPC)、
    // sqliteDb(SQLite 只读库)、两个 Mongo Model(images / recipe_groups 集合)
    this.collectionName =
      this.config.get<string>('mongo.collection') ?? 'images';
    this.readMode = this.config.get<boolean>('sqlite.readMode') ?? false;
  }

  // ----------------------------------------------------------- /api/options

  /**
   * GET /api/options — 返回 base_models / loras 可选项(前端筛选器下拉数据)。
   *
   * 数据源:纯远程待配库 → 空集;SQLite readMode → listOptions 本地查;
   * Mongo → images 集合 distinct 聚合;最后与内存视图(未入库图片)合并。
   * 返回结构:{ base_models: string[], loras: string[] },均去空、去重、排序。
   */
  @Get('options')
  async options(): Promise<Record<string, unknown>> {
    // remote-pending(纯远程未配库):返回空集,避免对占位 Mongo 超时
    if (isEnginePending(this.config)) {
      return { base_models: [], loras: [] };
    }
    // 双数据源二选一:SQLite 只读模式直接查本地库;Mongo 模式走 distinct 聚合
    let baseModels: unknown[] = [];
    let loras: unknown[] = [];
    if (this.readMode) {
      // SQLite:选项来自本地库缓存,无需网络往返
      const opt = listOptions(this.sqliteDb);
      baseModels = opt.baseModels;
      loras = opt.loras;
    } else {
      const coll = this.imagesModel.collection;
      // Mongo:仅统计"含有效正向提示词"的文档(与列表查询同口径),
      // distinct 直接命中 model.base_model 与 loras.names 索引
      const baseFilter = {
        'prompts.positive': { $exists: true, $nin: [null, '', []] },
      };
      // 两个 distinct 并行发出,缩短响应时间
      [baseModels, loras] = await Promise.all([
        coll.distinct('model.base_model', baseFilter),
        coll.distinct('loras.names', baseFilter),
      ]);
    }
    // 合并内存视图(未入库图片的模型/LoRA 也可选):Set 天然去重,
    // 内存中待 flush 图片用到的 base_model/LoRA 同样进入选项池
    const memoryModels = new Set<string>();
    const memoryLoras = new Set<string>();
    for (const doc of await this.orchestration.getMemoryView()) {
      const model = (doc.model as { base_model?: unknown } | undefined)
        ?.base_model;
      if (model) memoryModels.add(String(model));
      const names =
        (doc.loras as { names?: unknown[] } | undefined)?.names ?? [];
      for (const name of names) {
        if (name) memoryLoras.add(String(name));
      }
    }
    return {
      base_models: [
        ...new Set([...baseModels.filter(Boolean), ...memoryModels]),
      ].sort(),
      loras: [...new Set([...loras.filter(Boolean), ...memoryLoras])].sort(),
    };
  }

  // ----------------------------------------------------------- /api/instances

  /**
   * GET /api/instances — 多网关共享库:图片来源实例列表(前端筛选器)。
   *
   * 语义:images 集合 images[].source.instance_id 的 distinct 值 —— 哪些网关
   * 往共享库写过图片(ingest 层打标,见 schemas/images.schema.ts 的 source 字段)。
   * SQLite 单引擎 / readMode / 纯远程待配库无实例概念,直接返回空数组。
   * 返回结构:{ items: string[] },空值过滤后排序。
   */
  @Get('instances')
  async instances(): Promise<{ items: string[] }> {
    if (this.readMode || isEnginePending(this.config)) {
      return { items: [] };
    }
    const values = await this.imagesModel.collection.distinct(
      'images.source.instance_id',
      { 'images.source.instance_id': { $exists: true, $nin: [null, ''] } },
    );
    return {
      items: (values as string[]).filter(Boolean).sort(),
    };
  }

  // ----------------------------------------------------------- /api/images

  /**
   * limit 查询参数解析:非法/负值拒绝,1~max 钳制(默认上限 200)。
   *
   * 输入:raw —— ?limit= 原始字符串;def —— 缺省值;max —— 上限。
   * 返回:钳制后的正整数;异常:非有限数或 <1 → 400(BadRequestException)。
   * 为什么钳制:SQLite 侧 LIMIT 为 -1/0 会全表返回或空集;大 limit 也会放大
   * 内存视图合并与响应体的成本。
   */
  private parseLimit(raw: string | undefined, def: number, max = 200): number {
    if (raw === undefined) return def;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new BadRequestException(`limit must be between 1 and ${max}`);
    }
    return Math.min(n, max);
  }

  /**
   * GET /api/images — 批次分页列表(batch / recipe 两种 group_mode)。
   *
   * 查询参数(全部可选):
   *   q            —— prompts.search_text 正则匹配(转义 + 忽略大小写)
   *   filename     —— 文件名匹配(images.file.filename)
   *   base_model   —— model.base_model 子串匹配(家族名,忽略大小写)
   *   lora         —— 命中 loras.names 含该值的批次
   *   exclude_lora —— 排除含该 LoRA 的批次($ne)
   *   from_date/to_date —— captured_at UTC 时间区间(闭区间)
   *   group_mode   —— 'recipe' 查 recipe_groups 集合,其余视为 batch
   *   instance     —— 来源网关实例过滤(仅 Mongo 生效)
   *   page/limit   —— 分页(limit 默认 50,上限 200)
   *
   * 返回结构:{ items, total, page, limit, group_mode, pages }。
   * 纯远程待配库(isEnginePending)直接返回空壳,避免对占位 Mongo 超时。
   * 数据流:listImages → buildFilter → listBatchGrouped / listRecipeGrouped。
   */
  @Get('images')
  async listImages(
    @Query('q') q?: string,
    @Query('filename') filename?: string,
    @Query('base_model') baseModel?: string,
    // LoRA 多值:重复参数 lora=A&lora=B;旧单值形态等价于单元数组
    @Query('lora') lora?: string | string[],
    @Query('exclude_lora') excludeLora?: string | string[],
    // 组合语义:lora_mode or|and(缺省 or)、exclude_lora_mode and|or(缺省 and)
    @Query('lora_mode') loraMode?: string,
    @Query('exclude_lora_mode') excludeLoraMode?: string,
    @Query('exclude_q') excludeQ?: string,
    @Query('from_date') fromDate?: string,
    @Query('to_date') toDate?: string,
    @Query('group_mode') groupMode?: string,
    @Query('instance') instance?: string,
    @Query('page') pageRaw?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<Record<string, unknown>> {
    // 页码:非法值回落 1,下限钳 1;limit 经 parseLimit(默认 50,上限 200)
    const page = Math.max(parseInt(pageRaw ?? '1', 10) || 1, 1);
    const limit = this.parseLimit(limitRaw, 50);
    // exclude_q:前端已按行/空格/逗号拆好词并空格连接传参,这里按空白拆回
    const excludeWords = this.splitExcludeQ(excludeQ);
    // LoRA 多值与/或规格(正向/排除独立组合,见 LoraFilterSpec)
    const loraSpec = this.parseLoraFilter(
      lora,
      loraMode,
      excludeLora,
      excludeLoraMode,
    );
    // group_mode 分派:仅显式 'recipe' 走 recipe_groups,其余(含缺省)一律 batch
    const mode = groupMode === 'recipe' ? 'recipe' : 'batch';
    // IP 遍历展开:q 若精确解析为 copyright/IP tag,取其角色词集做 OR
    // 检索(让"搜 IP → 带出该系列角色图")。danbooru 库缺失 / 非版权
    // / 解析不定 → null,正文维持原字面匹配。
    const qExpansion = q ? expandIpChars(this.danbooruDb, q) : null;
    // 纯远程待配库:数据库未就绪,返回空壳避免对占位 Mongo 超时
    if (isEnginePending(this.config)) {
      return {
        items: [],
        total: 0,
        page,
        limit,
        group_mode: mode,
        pages: 0,
      };
    }
    const filter = this.buildFilter(
      q,
      filename,
      baseModel,
      excludeWords,
      fromDate,
      toDate,
      instance,
      qExpansion?.terms,
    );

    // 按 group_mode 分派:recipe 聚合查询 / batch 直查 + 内存视图合并
    if (mode === 'recipe') {
      return this.listRecipeGrouped(
        filter,
        loraSpec,
        page,
        limit,
        excludeWords,
        qExpansion?.terms,
      );
    }
    return this.listBatchGrouped(
      filter,
      loraSpec,
      page,
      limit,
      excludeWords,
      qExpansion?.terms,
    );
  }

  /**
   * exclude_q 参数拆词:前端按行/空格/逗号分隔并空格连接传参,
   * 这里按空白拆回词数组(排除词粒度是"词",词内含空格视为多词)。
   */
  private splitExcludeQ(excludeQ?: string): string[] {
    if (!excludeQ) return [];
    return excludeQ.split(/\s+/).filter((w) => w.length > 0);
  }

  /**
   * 从 Mongo 形状的 $regex 条件还原 escapeRegExp 前的原始查询串。
   * SQLite 侧 baseModel 需要原文参与归一化子串:escaped 形态的 '\.' 会让
   * reader 的 normalizeBaseModel 扩展名剥离(/\.safetensors/)失配,导致
   * options 下拉给出的带扩展名值在列表查询中恒空(b15 沙箱实测)。
   * escapeRegExp 是逐字符加反斜杠,逐对剥离即可无损还原。
   */
  private rawRegexSource(cond: unknown): string | undefined {
    const regex = (cond as { $regex?: string } | undefined)?.$regex;
    return regex?.replace(/\\(.)/g, '$1');
  }

  /**
   * 查询参数 → Mongo 过滤条件(batch / recipe 两集合共用)。
   *
   * 输出约定:
   *   - 恒含 prompts.positive 有效性过滤(与 options 的 baseFilter 同口径);
   *   - q / filename 用 escapeRegExp 转义后的正则 + $options:'i';
   *   - LoRA 多值与/或不在此构造(见 LoraFilterSpec / withLoraFilterToMongo,
   *     SQLite 侧由调用点拆回标量数组);
   *   - 时间区间用 $gte/$lte 比较 captured_at(Date);
   *   - instance 仅 Mongo 语义(SQLite readMode 不支持,读取端会忽略)。
   * 注意:SQLite 分支会把这个对象"拆回"标量参数,见 listBatches 调用点。
   */
  private buildFilter(
    q?: string,
    filename?: string,
    baseModel?: string,
    excludeWords?: string[],
    fromDate?: string,
    toDate?: string,
    instance?: string,
    qOr?: string[],
  ): Record<string, unknown> {
    // 基础条件:必须含正向提示词(排除空文档/解析失败占位记录);
    // $nin 覆盖 null、空串、空数组三种"无有效 prompt"形态
    const filter: Record<string, unknown> = {
      'prompts.positive': { $exists: true, $nin: [null, '', []] },
    };
    // 全文检索字段:search_text 是 parser 预生成的检索串,正则已转义防注入,
    // $options:'i' 大小写不敏感(与 parser.py build_prompt_search_text 对齐);
    // 正向 q 与排除词(exclude_q)合并到同一字段对象:$regex 命中 + $not 拒中,
    // 二者可同时存在(Mongo 允许同字段对象共存多个操作符)
    const searchCond: Record<string, unknown> = {};
    if (q) {
      if (qOr && qOr.length) {
        // IP 遍历展开词集:任一命中即命中(OR),与 SQLite qOr 同语义。
        // 每个词各自 escapeRegExp,避免 alternation 内的 | 破坏分组。
        searchCond.$regex = [q, ...qOr.map((w) => escapeRegExp(w))].join('|');
      } else {
        searchCond.$regex = escapeRegExp(q);
      }
      searchCond.$options = 'i';
    }
    if (excludeWords && excludeWords.length > 0) {
      // 多词用 alternation 合并:命中任一排除词即排除(OR 语义,同 SQLite 多条 NOT LIKE)
      searchCond.$not = {
        $regex: excludeWords.map((w) => escapeRegExp(w)).join('|'),
        $options: 'i',
      };
    }
    if (Object.keys(searchCond).length > 0) {
      filter['prompts.search_text'] = searchCond;
    }
    // 文件名匹配:recipe 模式下该字段覆盖 recipe_groups 全部成员批次文件名
    if (filename)
      filter['images.file.filename'] = {
        $regex: escapeRegExp(filename),
        $options: 'i',
      };
    // base_model 家族匹配:子串 + 忽略大小写(与 SQLite 侧归一化子串的
    // 核心语义对齐;连字符/下划线互换与剥 .safetensors 是 SQLite 侧增强,
    // Mongo 原文只做子串——输入家族名如 "anima" 两边命中一致)
    if (baseModel)
      filter['model.base_model'] = {
        $regex: escapeRegExp(baseModel),
        $options: 'i',
      };
    // 命中指定 LoRA / 排除指定 LoRA:已上收为 LoraFilterSpec
    // (多值与/或,见 parseLoraFilter / withLoraFilterToMongo),此处不再构造。
    // 历史注记:旧实现把两者先后写入同一 filter['loras.names'] 键,
    // 后设置者覆盖前者 —— 同时传 lora 与 exclude_lora 时正向条件会丢失。
    // 时间区间:Mongo 用 Date,SQLite 调用点转换为 UTC ISO 文本
    if (fromDate || toDate) {
      const dateFilter: CapturedAtRange = {};
      if (fromDate) dateFilter.$gte = capturedAtBound(fromDate, false);
      if (toDate) dateFilter.$lte = capturedAtBound(toDate, true);
      filter.captured_at = dateFilter;
    }
    // 多网关实例过滤:仅 Mongo 支持(SQLite readMode 不支持,读取端忽略)
    if (instance) filter['images.source.instance_id'] = instance;
    return filter;
  }

  /**
   * LoRA 查询参数 → LoraFilterSpec(多值与/或规格;无任何 lora 条件时 undefined)。
   * 兼容旧单值形态:lora=X 等价于 lora=X&lora_mode=* 任意档位下的单元数组。
   * mode 缺省:正向 or / 排除 and(即"C 和 D 都不含",与单值历史行为一致);
   * 非法值回落缺省。名单去空白、去重。
   */
  private parseLoraFilter(
    lora?: string | string[],
    loraMode?: string,
    excludeLora?: string | string[],
    excludeLoraMode?: string,
  ): LoraFilterSpec | undefined {
    const toList = (value?: string | string[]): string[] => {
      const raw = Array.isArray(value) ? value : value ? [value] : [];
      return [...new Set(raw.map((item) => item.trim()).filter(Boolean))];
    };
    const include = toList(lora);
    const exclude = toList(excludeLora);
    if (!include.length && !exclude.length) return undefined;
    return {
      include,
      includeMode: loraMode === 'and' ? 'and' : 'or',
      exclude,
      excludeMode: excludeLoraMode === 'or' ? 'or' : 'and',
    };
  }

  /**
   * 把 LoraFilterSpec 并入 Mongo 过滤对象(返回新对象,不改传入值):
   *   - 正向或 $in / 正向且 $all
   *   - 排除且 $nin(任一命中即排除)/ 排除或 $not.$all(仅全占才排除)
   * 正向与排除用顶层 $and 并列 —— 修复旧实现同键互相覆盖导致
   * "含 A 但不含 C"组合失效的缺陷。无 spec 或两名单皆空时原样返回。
   */
  private withLoraFilterToMongo(
    filter: Record<string, unknown>,
    spec?: LoraFilterSpec,
  ): Record<string, unknown> {
    if (!spec) return filter;
    const clauses: Array<Record<string, unknown>> = [];
    if (spec.include.length > 0) {
      clauses.push({
        'loras.names':
          spec.includeMode === 'and'
            ? { $all: spec.include }
            : { $in: spec.include },
      });
    }
    if (spec.exclude.length > 0) {
      clauses.push({
        'loras.names':
          spec.excludeMode === 'and'
            ? { $nin: spec.exclude }
            : { $not: { $all: spec.exclude } },
      });
    }
    if (!clauses.length) return filter;
    const existing = Array.isArray(filter.$and)
      ? (filter.$and as Array<Record<string, unknown>>)
      : [];
    return { ...filter, $and: [...existing, ...clauses] };
  }

  /**
   * LoraFilterSpec 的内存侧判定(供 memoryMatchesFilter 调用):
   * 与 SQL EXISTS 组合/Mongo 操作符严格同语义,见 LoraFilterSpec 注释。
   */
  private loraSpecMatches(names: string[], spec: LoraFilterSpec): boolean {
    if (spec.include.length > 0) {
      const hits = spec.include.filter((name) => names.includes(name)).length;
      // 且:命中数须等于全部;或:至少命中一个
      if (
        spec.includeMode === 'and' ? hits < spec.include.length : hits === 0
      ) {
        return false;
      }
    }
    if (spec.exclude.length > 0) {
      const hits = spec.exclude.filter((name) => names.includes(name)).length;
      // 且(全部不含):任一命中即排除;或(不同时含全部):全占才排除
      if (
        spec.excludeMode === 'and' ? hits > 0 : hits === spec.exclude.length
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * batch group_mode 分页列表核心实现。
   *
   * 流程:SQLite/Mongo 二选一取本页 + total → 内存视图过滤合并(与 Mongo
   * 按 batch_key 去重,Mongo 优先)→ 合并后按 captured_at 降序重排再切片。
   * 返回壳:{ items, total, page, limit, group_mode:'batch', pages }。
   */
  private async listBatchGrouped(
    filter: Record<string, unknown>,
    loraSpec: LoraFilterSpec | undefined,
    page: number,
    limit: number,
    excludeWords: string[],
    qOr?: string[],
  ): Promise<Record<string, unknown>> {
    // 分页偏移:第 1 页 skip=0
    const skip = (page - 1) * limit;

    let items: Array<Record<string, unknown>>;
    let total: number;
    // 双数据源二选一;SQLite 分支需要把 Mongo 过滤对象拆回标量参数
    if (this.readMode) {
      const result = listBatches(
        this.sqliteDb,
        {
          q: (filter['prompts.search_text'] as { $regex?: string } | undefined)
            ?.$regex,
          qOr,
          filename: (
            filter['images.file.filename'] as { $regex?: string } | undefined
          )?.$regex,
          baseModel: this.rawRegexSource(filter['model.base_model']),
          loras: loraSpec?.include,
          loraMode: loraSpec?.includeMode,
          excludeLoras: loraSpec?.exclude,
          excludeLoraMode: loraSpec?.excludeMode,
          excludeQ: excludeWords.length > 0 ? excludeWords : undefined,
          ...sqliteCapturedAtBounds(filter),
        },
        { skip, limit },
      );
      items = result.items;
      total = result.total;
    } else {
      const query = this.withLoraFilterToMongo(filter, loraSpec);
      // Mongo 分支:find 只取本页(先按 captured_at 降序再 skip/limit),
      // 与 countDocuments 并行;total 供前端分页器使用
      [items, total] = await Promise.all([
        this.imagesModel.collection
          .find(query, { projection: { _id: 0 } })
          .sort({ captured_at: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        this.imagesModel.collection.countDocuments(query),
      ]);
    }

    // 合并内存视图:过滤 + 与 Mongo 按 batch_key 去重(Mongo 优先)+ 排序分页
    // memoryMatchesFilter 与 buildFilter 同口径(见该方法注释),只保留
    // 本页过滤条件下"内存中待 flush"的批次
    const memoryItems = (await this.orchestration.getMemoryView()).filter(
      (doc) => this.memoryMatchesFilter(doc, filter, loraSpec),
    );
    if (memoryItems.length > 0) {
      // Mongo 已命中的 batch_key 集合:同 key 内存批次视为重复
      // (Mongo 优先,避免 flush 前后重复展示)
      const mongoKeys = new Set(
        items.map((d) => (d as { batch_key?: string }).batch_key),
      );
      // 合并后整体按 captured_at 降序重排:两个数据源各自有序,
      // 直接拼接会破坏全局顺序,必须重排后再切片
      const merged = [
        ...items,
        ...memoryItems.filter((d) => !mongoKeys.has(d.batch_key as string)),
      ].sort((a, b) =>
        String((b as { captured_at?: string }).captured_at ?? '').localeCompare(
          String((a as { captured_at?: string }).captured_at ?? ''),
        ),
      );
      // 重排后的分页语义:total = Mongo 总数 + 内存增量(去重后),
      // pages 随之重算;items 取合并序列的 [skip, skip+limit) 窗口
      return {
        items: merged.slice(skip, skip + limit),
        total:
          total +
          memoryItems.filter((d) => !mongoKeys.has(d.batch_key as string))
            .length,
        page,
        limit,
        group_mode: 'batch',
        pages: Math.ceil(
          (total +
            memoryItems.filter((d) => !mongoKeys.has(d.batch_key as string))
              .length) /
            limit,
        ),
      };
    }
    // 无内存增量:直接返回存储层结果(响应壳与合并分支一致)
    return {
      items,
      total,
      page,
      limit,
      group_mode: 'batch',
      pages: Math.ceil(total / limit),
    };
  }

  /**
   * 内存视图文档的过滤匹配(与 buildFilter 同口径,轻量实现)。
   *
   * 为什么需要:内存视图文档与 Mongo batch 文档同构(见
   * orchestration.getMemoryView),但没走 Mongo 查询,必须用 JS 复刻
   * buildFilter 的全部条件做内存侧过滤。
   * 输入:doc —— 内存视图 batch 文档;filter —— buildFilter 产物。
   * 输出:boolean,全部命中才 true;正则语义与 Mongo $regex/'i' 一致,
   * 日期按 captured_at 的 epoch 值比较(兼容 Date 与 ISO 字符串)。
   */
  private memoryMatchesFilter(
    doc: Record<string, unknown>,
    filter: Record<string, unknown>,
    loraSpec?: LoraFilterSpec,
  ): boolean {
    // 预取参与过滤的字段(内存文档与 Mongo 文档字段路径一致)
    const prompts = doc.prompts as
      | { search_text?: unknown; positive?: unknown }
      | undefined;
    const model = doc.model as { base_model?: unknown } | undefined;
    const loras = doc.loras as { names?: unknown[] } | undefined;
    const filename =
      (doc.images as Array<{ file?: { filename?: string } }> | undefined)?.[0]
        ?.file?.filename ?? '';

    // q / exclude_q 条件:从 Mongo 过滤对象取回正则串重建 RegExp,
    // 语义与 $regex+'i' 对齐;含 $not 形态时(排除词)命中即排除
    const q = filter['prompts.search_text'] as
      | { $regex?: string; $not?: { $regex?: string } }
      | undefined;
    if (q) {
      const text = String(prompts?.search_text ?? '');
      if (q.$regex && !new RegExp(q.$regex, 'i').test(text)) return false;
      if (q.$not?.$regex && new RegExp(q.$not.$regex, 'i').test(text))
        return false;
    }
    // filename 条件:内存文档取第一张图的文件名做正则匹配
    if (filter['images.file.filename']) {
      const re = new RegExp(
        String((filter['images.file.filename'] as { $regex: string }).$regex),
        'i',
      );
      if (!re.test(filename)) return false;
    }
    // base_model 家族匹配:正则子串 + 'i'(与 buildFilter 的 $regex 同语义)
    if (
      filter['model.base_model'] &&
      !new RegExp(
        String((filter['model.base_model'] as { $regex: string }).$regex),
        'i',
      ).test(String(model?.base_model ?? ''))
    ) {
      return false;
    }
    // lora 多值与/或条件:LoraFilterSpec 判定(与 SQL EXISTS 组合/Mongo
    // 操作符同语义,见 loraSpecMatches);无 spec 即不过滤
    if (loraSpec) {
      const names = (loras?.names ?? []).map(String);
      if (!this.loraSpecMatches(names, loraSpec)) return false;
    }
    // 时间区间:按 epoch 比较,兼容内存文档中的 Date 与 ISO 字符串
    const dateFilter = filter.captured_at as CapturedAtRange | undefined;
    if (dateFilter) {
      const captured = new Date(doc.captured_at as string | Date).getTime();
      if (!Number.isFinite(captured)) return false;
      if (dateFilter.$gte && captured < dateFilter.$gte.getTime()) return false;
      if (dateFilter.$lte && captured > dateFilter.$lte.getTime()) return false;
    }
    return true;
  }

  /**
   * recipe group_mode 分页列表核心实现(查 recipe_groups 集合)。
   *
   * 与 listBatchGrouped 的差异:recipe 模式不合并内存视图 —— 内存缓冲是
   * 单批(batch)语义,合并进 recipe 聚合会破坏 batch_keys 跨批结构。
   * 输出:items 经 shapeRecipeGroupDoc 整形为前端嵌套结构,
   * 壳:{ items, total, page, limit, group_mode:'recipe', pages }。
   */
  private async listRecipeGrouped(
    filter: Record<string, unknown>,
    loraSpec: LoraFilterSpec | undefined,
    page: number,
    limit: number,
    excludeWords: string[],
    qOr?: string[],
  ): Promise<Record<string, unknown>> {
    const skip = (page - 1) * limit;
    // 与 listImageSummaries 的 recipe 分支同口径:文本/文件名过滤透传
    // (recipe_groups 文档含跨批次最多 100 个文件名,filename 匹配范围覆盖
    // 全部成员批次,详见 API_DESIGN.md §5.6)
    const common = {
      q: (filter['prompts.search_text'] as { $regex?: string } | undefined)
        ?.$regex,
      qOr,
      filename: (
        filter['images.file.filename'] as { $regex?: string } | undefined
      )?.$regex,
      baseModel: this.rawRegexSource(filter['model.base_model']),
      loras: loraSpec?.include,
      loraMode: loraSpec?.includeMode,
      excludeLoras: loraSpec?.exclude,
      excludeLoraMode: loraSpec?.excludeMode,
      excludeQ: excludeWords.length > 0 ? excludeWords : undefined,
      ...sqliteCapturedAtBounds(filter),
    };

    let rawItems: Array<Record<string, unknown>>;
    let total: number;
    // 双数据源二选一;Mongo 分支 filter 直接适用于 recipe_groups 集合
    // (两集合字段路径同构)
    if (this.readMode) {
      const result = listRecipes(this.sqliteDb, common, { skip, limit });
      rawItems = result.items;
      total = result.total;
    } else {
      // Mongo 分支:find 只取本页(先降序再 skip/limit),count 并行取总数
      const query = this.withLoraFilterToMongo(filter, loraSpec);
      [rawItems, total] = await Promise.all([
        this.recipeGroupModel.collection
          .find(query, { projection: { _id: 0 } })
          .sort({ captured_at: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        this.recipeGroupModel.collection.countDocuments(query),
      ]);
    }
    // 每条 recipe 文档整形为前端嵌套结构后返回
    return {
      items: rawItems.map((doc) => this.shapeRecipeGroupDoc(doc)),
      total,
      page,
      limit,
      group_mode: 'recipe',
      pages: Math.ceil(total / limit),
    };
  }

  // ----------------------------------------------------------- /api/images/summary

  /**
   * recipe_groups 文档 → 前端响应结构整形(镜像旧版 _shape_recipe_group_doc)。
   *
   * 产出结构:
   *   - 顶层:原文档字段 + batch_key(=recipe_key)+ file(首图)+
   *     group_mode:'recipe' + details_pending:false;
   *   - batch 对象:{ key, count, seeds, seed_images, files_preview(前 5),
   *     images(全量), batch_keys, batch_count } —— 与 batch 模式详情同构,
   *     前端可复用同一套卡片/详情渲染逻辑;
   *   - recipe 对象:{ key, batch_count, batch_keys, members }。
   * 前端消费对应:app.js 卡片渲染读 items[i].batch(images/files_preview)与
   * model/loras/prompts;详情跳转用 items[i].batch_key 调 /api/images/details。
   */
  private shapeRecipeGroupDoc(
    doc: Record<string, unknown>,
  ): Record<string, unknown> {
    // 成员批次文件列表:先取 file,再过滤掉无 sha256/resolved_path 的条目
    // (recipe_groups 中可能含解析失败/无文件的占位记录)
    const rawImages =
      (doc.images as Array<{
        file?: Record<string, unknown>;
        source?: Record<string, unknown>;
      }>) ?? [];
    const batchImages = rawImages
      .filter((img) => Boolean(img?.file?.sha256 || img?.file?.resolved_path))
      .map(
        (img): Record<string, unknown> => ({
          ...(img.file as Record<string, unknown>),
          source: img.source ?? undefined,
        }),
      )
      .filter((f) => Boolean(f.sha256 || f.resolved_path))
      .map((f) => ({
        filename: f.filename,
        sha256: f.sha256,
        resolved_path: f.resolved_path,
        windows_path: f.windows_path,
        width: f.width,
        height: f.height,
        size_bytes: f.size_bytes,
        format: f.format,
        mode: f.mode,
        source: f.source,
      }));

    // 跨批元信息:batch_keys 记录该 recipe 聚合的全部成员批次
    const batchKeys = (doc.batch_keys as string[]) ?? [];
    const seeds = (doc.seeds as unknown[]) ?? [];
    const recipeKey = doc.recipe_key as string;
    const firstImage = batchImages[0] ?? {};
    const imageCount = (doc.image_count as number) ?? batchImages.length;
    // 跨批合并(recipe 多批、各批 seed 可能不同)时:
    // 1. 若为单批(batchKeys <= 1),直接通过 buildSeedImages 对齐
    // 2. 若多批聚合(batchKeys > 1),优先从 members 逐批展开 seeds 对齐到 batchImages;若无 members 则按 seeds 兜底
    const members = (doc.members as Array<Record<string, unknown>>) ?? [];
    let seedImages: SeedImageEntry[] = [];
    if (batchKeys.length <= 1) {
      seedImages = buildSeedImages(
        doc.samplers as Array<{ seed?: unknown }>,
        rawImages,
      );
    } else if (members.length > 0) {
      const memberSeedRows: Array<unknown[]> = [];
      for (const m of members) {
        const mSeeds = Array.isArray(m.seeds)
          ? m.seeds
          : m.seeds !== null && m.seeds !== undefined
            ? [m.seeds]
            : [];
        const mCount =
          typeof m.count === 'number' && m.count > 0 ? m.count : 1;
        for (let i = 0; i < mCount; i++) {
          memberSeedRows.push(mSeeds);
        }
      }
      seedImages = batchImages.map((img, idx) => ({
        sha256: (img.sha256 as string) ?? null,
        filename: (img.filename as string) ?? null,
        seeds:
          memberSeedRows[idx] ??
          (seeds[idx] !== null && seeds[idx] !== undefined ? [seeds[idx]] : []),
      }));
    } else if (seeds.length > 0) {
      seedImages = batchImages.map((img, idx) => ({
        sha256: (img.sha256 as string) ?? null,
        filename: (img.filename as string) ?? null,
        seeds:
          seeds[idx] !== null && seeds[idx] !== undefined ? [seeds[idx]] : [],
      }));
    }

    // 浅拷贝原文档,再补派生字段;batch_key 在 recipe 模式下取 recipe_key,
    // 便于前端统一按 batch_key 走详情流程
    const result: Record<string, unknown> = { ...doc };
    result['batch_key'] = recipeKey;
    result['file'] = firstImage;
    // group_mode 标记 recipe 语义;details_pending 恒 false(聚合文档已含全量数据)
    result['group_mode'] = 'recipe';
    result['details_pending'] = false;
    // batch 嵌套对象:与 batch 模式详情结构对齐,前端统一渲染
    result['batch'] = {
      key: recipeKey,
      count: imageCount,
      seeds,
      seed_images: seedImages,
      files_preview: batchImages.slice(0, 5).map((img) => img.filename),
      images: batchImages,
      batch_keys: batchKeys,
      batch_count: batchKeys.length,
    };
    // recipe 嵌套对象:保留跨批聚合信息(成员批次列表与数量)
    result['recipe'] = {
      key: recipeKey,
      batch_count: batchKeys.length,
      batch_keys: batchKeys,
      members: doc.members ?? [],
    };
    return result;
  }

  /**
   * GET /api/images/summary — 列表卡片摘要(batch / recipe 两种 group_mode)。
   *
   * 与 /api/images 同参数语义,差异:
   *   - Mongo 查询只投影卡片字段,减小响应体;
   *   - limit 上限放宽到 500(摘要卡片列表更长);
   *   - recipe 模式结果同样经 shapeRecipeGroupDoc 整形;
   *   - batch 模式内存视图合并只取投影字段(Mongo 卡片结构同构)。
   * 返回结构:{ items, total, page, limit, group_mode, pages }。
   * 前端消费:列表页卡片(缩略图 + 文件名 + 模型/LoRA 标签)数据源。
   */
  @Get('images/summary')
  async listImageSummaries(
    @Query('q') q?: string,
    @Query('filename') filename?: string,
    @Query('base_model') baseModel?: string,
    // LoRA 多值:重复参数 lora=A&lora=B;旧单值形态等价于单元数组
    @Query('lora') lora?: string | string[],
    @Query('exclude_lora') excludeLora?: string | string[],
    // 组合语义:lora_mode or|and(缺省 or)、exclude_lora_mode and|or(缺省 and)
    @Query('lora_mode') loraMode?: string,
    @Query('exclude_lora_mode') excludeLoraMode?: string,
    @Query('exclude_q') excludeQ?: string,
    @Query('from_date') fromDate?: string,
    @Query('to_date') toDate?: string,
    @Query('group_mode') groupMode?: string,
    @Query('instance') instance?: string,
    @Query('page') pageRaw?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<Record<string, unknown>> {
    // 页码/limit:limit 在此允许到 500(与 /api/images 的 200 上限不同)
    const page = Math.max(parseInt(pageRaw ?? '1', 10) || 1, 1);
    const limit = Math.min(parseInt(limitRaw ?? '50', 10) || 50, 500);
    const excludeWords = this.splitExcludeQ(excludeQ);
    // LoRA 多值与/或规格(正向/排除独立组合,见 LoraFilterSpec)
    const loraSpec = this.parseLoraFilter(
      lora,
      loraMode,
      excludeLora,
      excludeLoraMode,
    );
    const mode = groupMode === 'recipe' ? 'recipe' : 'batch';
    const qExpansion = q ? expandIpChars(this.danbooruDb, q) : null;
    // 纯远程待配库:返回空壳,避免对占位 Mongo 超时
    if (isEnginePending(this.config)) {
      return {
        items: [],
        total: 0,
        page,
        limit,
        group_mode: mode,
        pages: 0,
      };
    }
    const filter = this.buildFilter(
      q,
      filename,
      baseModel,
      excludeWords,
      fromDate,
      toDate,
      instance,
      qExpansion?.terms,
    );
    const skip = (page - 1) * limit;

    // recipe 分支:查 recipe_groups;batch 分支:查 images + 内存视图
    if (mode === 'recipe') {
      if (this.readMode) {
        const result = listRecipes(
          this.sqliteDb,
          {
            q: (
              filter['prompts.search_text'] as { $regex?: string } | undefined
            )?.$regex,
            qOr: qExpansion?.terms,
            filename: (
              filter['images.file.filename'] as { $regex?: string } | undefined
            )?.$regex,
            baseModel: this.rawRegexSource(filter['model.base_model']),
            loras: loraSpec?.include,
            loraMode: loraSpec?.includeMode,
            excludeLoras: loraSpec?.exclude,
            excludeLoraMode: loraSpec?.excludeMode,
            excludeQ: excludeWords.length > 0 ? excludeWords : undefined,
            ...sqliteCapturedAtBounds(filter),
          },
          { skip, limit, maxLimit: 500 },
        );
        // SQLite recipe 分支:本地聚合结果同样整形后返回
        const items = result.items.map((doc) => this.shapeRecipeGroupDoc(doc));
        return {
          items,
          total: result.total,
          page,
          limit,
          group_mode: mode,
          pages: Math.ceil(result.total / limit),
        };
      }
      // Mongo recipe 分支:并行 find(投影全文档,整形需要较多字段)+ count
      const query = this.withLoraFilterToMongo(filter, loraSpec);
      const [rawItems, total] = await Promise.all([
        this.recipeGroupModel.collection
          .find(query, { projection: { _id: 0 } })
          .sort({ captured_at: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        this.recipeGroupModel.collection.countDocuments(query),
      ]);
      // 整形后返回 recipe 摘要列表(结构同 /api/images 的 recipe 分支)
      const items = rawItems.map((doc) =>
        this.shapeRecipeGroupDoc(doc as Record<string, unknown>),
      );
      return {
        items,
        total,
        page,
        limit,
        group_mode: mode,
        pages: Math.ceil(total / limit),
      };
    }

    // ---- batch 分支 ----
    const coll = this.imagesModel.collection;
    const qOr = qExpansion?.terms;
    let items: Array<Record<string, unknown>>;
    let total: number;
    // SQLite readMode:本地库同步查询
    if (this.readMode) {
      const result = listBatches(
        this.sqliteDb,
        {
          q: (filter['prompts.search_text'] as { $regex?: string } | undefined)
            ?.$regex,
          qOr,
          filename: (
            filter['images.file.filename'] as { $regex?: string } | undefined
          )?.$regex,
          baseModel: this.rawRegexSource(filter['model.base_model']),
          loras: loraSpec?.include,
          loraMode: loraSpec?.includeMode,
          excludeLoras: loraSpec?.exclude,
          excludeLoraMode: loraSpec?.excludeMode,
          excludeQ: excludeWords.length > 0 ? excludeWords : undefined,
          ...sqliteCapturedAtBounds(filter),
        },
        { skip, limit, maxLimit: 500 },
      );
      // SQLite 分支就地整形为卡片投影结构(与 Mongo projection 对齐):
      // 只保留卡片渲染字段,images 仅留 filename/sha256 与来源实例
      items = result.items.map((d) => ({
        batch_key: d.batch_key,
        created_date: d.created_date,
        captured_at: d.captured_at,
        model: d.model,
        loras: d.loras,
        recipe_key: (d.recipe_key as string | undefined) ?? null,
        batch_count: d.batch_count,
        image_count: (d.images as unknown[] | undefined)?.length ?? 0,
        images: (
          (d.images as
            | Array<{
                file?: Record<string, unknown>;
                source?: { instance_id?: string };
              }>
            | undefined) ?? []
        ).map((img) => ({
          file: { filename: img.file?.filename, sha256: img.file?.sha256 },
          source: img.source ?? undefined,
        })),
      }));
      total = result.total;
    } else {
      // Mongo 分支:显式投影卡片字段(避免全文档回传),与 count 并行
      const query = this.withLoraFilterToMongo(filter, loraSpec);
      [items, total] = await Promise.all([
        coll
          .find(query, {
            projection: {
              _id: 0,
              batch_key: 1,
              created_date: 1,
              captured_at: 1,
              'model.base_model': 1,
              'loras.names': 1,
              'images.file.filename': 1,
              'images.file.sha256': 1,
              'images.source.instance_id': 1,
              recipe_key: 1,
              batch_count: 1,
              image_count: 1,
            },
          })
          .sort({ captured_at: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        coll.countDocuments(query),
      ]);
    }
    // 合并内存视图(summary 只取投影字段):先过滤,再整形为与 Mongo
    // projection 同构的卡片结构,后续合并无需区分来源
    const memoryItems = (await this.orchestration.getMemoryView()).filter(
      (doc) => this.memoryMatchesFilter(doc, filter, loraSpec),
    );
    if (memoryItems.length > 0) {
      const mongoKeys = new Set(
        items.map((d) => (d as { batch_key?: string }).batch_key),
      );
      // 内存增量:去掉与 Mongo 重复的 batch_key,映射为卡片投影结构
      // (recipe_key 置 null:内存缓冲为单批,无 recipe 语义)
      const extra = memoryItems
        .filter((d) => !mongoKeys.has(d.batch_key as string))
        .map((d) => ({
          batch_key: d.batch_key,
          created_date: d.created_date,
          captured_at: d.captured_at,
          model: d.model,
          loras: d.loras,
          recipe_key: null,
          batch_count: d.batch_count,
          image_count: (d.images as unknown[]).length,
          images: (d.images as Array<{ file?: Record<string, unknown> }>).map(
            (img) => ({
              file: {
                filename: img.file?.filename,
                sha256: img.file?.sha256,
              },
            }),
          ),
        }));
      // 合并后按 captured_at 降序重排再切片(与 listBatchGrouped 同策略)
      const merged = [...items, ...extra].sort((a, b) =>
        String((b as { captured_at?: string }).captured_at ?? '').localeCompare(
          String((a as { captured_at?: string }).captured_at ?? ''),
        ),
      );
      // total/pages 计入内存增量,保证分页器一致
      const totalMerged = total + extra.length;
      return {
        items: merged.slice(skip, skip + limit),
        total: totalMerged,
        page,
        limit,
        group_mode: mode,
        pages: Math.ceil(totalMerged / limit),
      };
    }
    // 无内存增量:直接返回存储层结果
    return {
      items,
      total,
      page,
      limit,
      group_mode: mode,
      pages: Math.ceil(total / limit),
    };
  }

  // ----------------------------------------------------------- /api/images/details

  /**
   * POST /api/images/details — 按 batch_keys 批量取批次详情。
   *
   * 请求体:{ batch_keys: string[] }。
   * 校验:batch_keys 必须为数组(否则 400),长度上限 200(防超大 $in 查询)。
   * 语义:列表/摘要页卡片经 batch_key 跳转详情页,一次最多取 200 个批次;
   * 空数组 / 纯远程待配库直接返回 { items: [] }。
   * 数据源:SQLite readMode → batchDetails;Mongo → $in 查询(全文档投影)。
   * 返回:{ items: 经 shapeBatchDoc 整形的详情文档 }。
   */
  @Post('images/details')
  async imageDetails(
    @Body() body: { batch_keys?: string[] },
  ): Promise<Record<string, unknown>> {
    // 入参校验:非数组 / 超 200 拒绝;空数组与纯远程待配库短路返回空结果
    const batchKeys = body.batch_keys ?? [];
    if (!Array.isArray(batchKeys)) {
      throw new BadRequestException('batch_keys must be an array');
    }
    if (batchKeys.length > 200) {
      throw new BadRequestException('batch_keys exceeds limit of 200');
    }
    if (!batchKeys.length || isEnginePending(this.config)) {
      return { items: [] };
    }
    let docs: Array<Record<string, unknown>>;
    // 双数据源:SQLite 本地批量查 / Mongo $in 查询
    if (this.readMode) {
      docs = batchDetails(this.sqliteDb, batchKeys);
    } else {
      docs = await this.imagesModel.collection
        .find({ batch_key: { $in: batchKeys } }, { projection: { _id: 0 } })
        .toArray();
    }
    // 每条文档整形为 batch 详情结构后返回(与 /api/images 详情页消费一致)
    return {
      items: docs.map((doc) => this.shapeBatchDoc(doc)),
    };
  }

  /**
   * batch 模式(batch group_mode)详情响应整形:为 raw batch doc 补 `batch`
   * 对象(batch 模式 doc 无 batch_count/batch_keys,单批语义恒成立)。
   *
   * batch 对象与 shapeRecipeGroupDoc 的 batch 对象结构对齐:
   * { key, count, seeds, seed_images, files_preview(前 5), images, batch_count:1 }。
   * seed_images 由 buildSeedImages 把 samplers[].seed 与 images[] 按 index
   * 对齐生成(语义见 lib/seed_images.ts);单批场景对齐恒可靠,故无条件调用。
   */
  private shapeBatchDoc(doc: Record<string, unknown>): Record<string, unknown> {
    const rawImages =
      (doc.images as Array<{
        file?: Record<string, unknown>;
        source?: Record<string, unknown>;
      }>) ?? [];
    const batchImages = rawImages
      .filter((img) => Boolean(img?.file?.sha256 || img?.file?.resolved_path))
      .map(
        (img): Record<string, unknown> => ({
          ...(img.file as Record<string, unknown>),
          source: img.source ?? undefined,
        }),
      );
    // seed → 图片对齐:单批内 samplers 与 images 一一对应,buildSeedImages
    // 按 index 生成每张图的 seed 阶段列表
    const samplers = (doc.samplers as Array<{ seed?: unknown }>) ?? [];
    const seedImages = buildSeedImages(samplers, rawImages);
    const imageCount = batchImages.length;
    // 浅拷贝原文档并补派生字段;batch 模式恒为单批语义
    const result: Record<string, unknown> = { ...doc };
    result['group_mode'] = 'batch';
    result['details_pending'] = false;
    result['batch'] = {
      key: doc.batch_key,
      count: imageCount,
      // seeds:各采样器阶段 seed 的去空列表(前端展示/重生成用)
      seeds: samplers
        .map((s) => s?.seed)
        .filter((s) => s !== null && s !== undefined),
      seed_images: seedImages,
      files_preview: batchImages.slice(0, 5).map((f) => f.filename),
      images: batchImages,
      batch_count: 1,
    };
    return result;
  }

  // ----------------------------------------------------------- /api/image/:sha256

  /**
   * GET /api/image/:sha256 — 原图文件下发。
   *
   * 路径参数:sha256 —— 定位 images[].file.sha256。
   * 文件定位顺序:
   *   1. 存储层按 sha256 查 batch 文档(SQLite / Mongo,'images.$' 只投影
   *      命中子文档,避免整批回传);
   *   2. 取 sha256 精确匹配的 image entry 的 file;
   *   3. 未入库(内存视图)图片 → findMemoryFileBySha256 兜底;
   *   4. firstAccessiblePath 按 [resolved, 归一化, windows] 取真实存在的路径
   *      (历史 WSL 路径在 Windows 侧需归一化,见 lib/paths.ts)。
   * 响应:命中本地文件 → res.sendFile;无本地文件但记录含远端 source.base_url
   * → 按 source.protocol 透传到持有网关或独立图片库;两者皆败 → 404。
   */
  @Get('image/:sha256')
  async getImage(
    @Param('sha256') sha256: string,
    @Res() res: Response,
    @Req() req: Request,
  ): Promise<void> {
    if (isEnginePending(this.config)) {
      throw new NotFoundException('Image not found');
    }
    let doc: Record<string, unknown> | null = null;
    // 双数据源按 sha256 定位批次;Mongo 用位置投影 'images.$' 只取
    // 命中 sha256 的那个 image entry
    if (this.readMode) {
      doc = batchBySha256(this.sqliteDb, sha256);
    } else {
      doc = await this.imagesModel.collection.findOne(
        { 'images.file.sha256': sha256 },
        { projection: { 'images.$': 1, _id: 0 } },
      );
    }
    const entry = (
      doc as {
        images?: Array<{
          file?: {
            resolved_path?: string;
            windows_path?: string;
            sha256?: string;
          };
          source?: {
            base_url?: string;
            protocol?: string;
            asset_id?: string;
          };
        }>;
      } | null
    )?.images?.find((img) => img.file?.sha256 === sha256);
    let file =
      entry?.file ??
      (
        doc as {
          images?: Array<{
            file?: { resolved_path?: string; windows_path?: string };
          }>;
        }
      )?.images?.[0]?.file;
    // 内存视图兜底:未入库图片也可直接访问原图(缓冲中图片尚未 flush,
    // 但文件已就绪,应立即可预览)
    if (!file?.resolved_path && !file?.windows_path) {
      const memory = await this.orchestration.findMemoryFileBySha256(sha256);
      if (memory?.resolved_path || memory?.windows_path) {
        file = memory;
      }
    }
    // 跨平台:历史数据为 WSL 路径,Windows 侧按 [resolved, 归一化, windows] 取可访问路径
    const accessible = firstAccessiblePath(
      file?.resolved_path,
      file?.windows_path,
    );
    if (!accessible) {
      // 纯远程透传:按 image entry 的 source 协议代理到持有网关/图片库;
      // passthroughTarget 拒绝非 http(s) 与自引用,isPassthroughRequest
      // 拒绝嵌套代理(防环,详见 lib/passthrough.ts)
      const selfBaseUrl = instanceStamp(this.config).base_url;
      const proxyPolicy = {
        allowedHosts:
          this.config.get<string[]>('remoteProxy.allowedHosts') ?? [],
      };
      const peer = passthroughTarget(entry, selfBaseUrl, proxyPolicy);
      const peerPath = passthroughPath(entry, sha256, 'original');
      if (peer && peerPath && !isPassthroughRequest(req.headers)) {
        // 流式代理:对端成功写出响应即返回;失败时若响应头已发出
        // (部分内容已写),不能抛 HttpException,由 proxyToPeer 负责销毁连接
        if (await proxyToPeer(peer, peerPath, res, proxyPolicy)) {
          return;
        }
        // 透传已写部分响应后失败:响应头已发出,不能再抛 HttpException,
        // 直接销毁 socket 避免 headers-sent 错误与悬挂连接
        if (res.destroyed || res.headersSent || res.writableEnded) {
          return;
        }
      }
      throw new NotFoundException('Image not found');
    }
    // 库记录投毒防线(GW-09):原图仅允许下发扫描根 / ComfyUI 输出目录内的
    // 文件;记录被篡改后路径落在白名单根之外 → 404,防止网关被当任意本地
    // 文件读取器。白名单根未配置(纯远程模式)时跳过,远端图片走透传分支
    const allowedRoots = [
      this.config.get<string>('scanRoot'),
      this.config.get<string>('comfyOutputDir'),
    ].filter((root): root is string => Boolean(root));
    if (allowedRoots.length > 0 && !isPathUnderRoots(accessible, allowedRoots)) {
      throw new NotFoundException('Image not found');
    }
    res.sendFile(accessible);
  }

  // --------------------------------------------------- /api/image/:sha256/open-comfyui

  /**
   * 把图片内嵌的 UI workflow 写入 ComfyUI 用户目录(user/default/workflows/),
   * 返回 ComfyUI 根地址;工作流由用户在 ComfyUI 的 Workflows 侧边栏打开
   * (官方前端不支持 URL 参数直接载入工作流,见 Comfy-Org/ComfyUI#9858)。
   *
   * 替代失效的"在 Windows 打开"(依赖服务端在 Windows 且文件在本地);
   * 新机制只依赖 ComfyUI 可达,与本地文件/平台无关,纯远程模式同样可用。
   *
   * POST /api/image/:sha256/open-comfyui
   * 流程:findDocBySha256 定位批次 → parseEmbeddedWorkflow 宽容解析
   * metadata.raw_workflow → generateWorker RPC push_workflow 写文件
   * → 返回 { ok, filename, url: comfyuiBaseUrl }(前端负责提示手动打开)。
   * 异常:图片不存在 / 未嵌入工作流 → 404;worker 错误经 mapWorkerError
   * 映射(503 / 504 / 502 / 400 / 500)。
   */
  // 方法级鉴权(GW-02/VULN-02):该端点会把工作流写入 ComfyUI userdata,属
  // 写操作;未配 token 时仅放行回环,0.0.0.0 部署时远端必须持 token
  @RequireAuth()
  @Post('image/:sha256/open-comfyui')
  async openInComfyUI(
    @Param('sha256') sha256: string,
  ): Promise<Record<string, unknown>> {
    if (isEnginePending(this.config)) {
      throw new NotFoundException('Image not found');
    }
    // sha256 格式校验(GW-02):文件名由 sha256.slice(0, 8) 构造,
    // 非法输入('../../..' 恰为 8 字符等)在此拒绝,不进入下游流程
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new BadRequestException('invalid sha256');
    }
    const doc = await this.findDocBySha256(sha256);
    if (!doc) {
      throw new NotFoundException('Image not found');
    }
    // 宽容解析内嵌 UI workflow;解析失败说明该图未携带可打开的工作流
    const workflow = this.parseEmbeddedWorkflow(doc);
    if (!workflow) {
      throw new NotFoundException(
        '该图片未嵌入可打开的工作流(需含 UI workflow 元数据)',
      );
    }
    // 文件名规则:wfdb-<sha256 前 8 位>.json,同一图幂等覆盖
    const filename = `wfdb-${sha256.slice(0, 8)}.json`;
    try {
      // 经 generate worker RPC 写入 ComfyUI 用户工作流目录;
      // worker 可能改写文件名,以返回值为准
      const pushed = (await this.generateWorker.call('push_workflow', {
        workflow,
        filename,
      })) as { ok?: boolean; filename?: string };
      const usedName = pushed?.filename ?? filename;
      // 打开链接:ComfyUI 官方前端不支持 URL 载入工作流(?workflow= 会被忽略,
      // 见 Comfy-Org/ComfyUI#9858),故只返回根地址;文件已写入
      // user/default/workflows/,由前端提示用户从 Workflows 侧边栏打开
      const comfyuiBaseUrl = String(
        this.config.get<string>('comfyuiBaseUrl') ?? 'http://127.0.0.1:8188',
      ).replace(/\/+$/, '');
      return {
        ok: true,
        filename: usedName,
        url: comfyuiBaseUrl,
      };
    } catch (err) {
      throw this.mapWorkerError(err);
    }
  }

  /**
   * 从 batch doc 提取可载入 ComfyUI 的 UI workflow。
   * 入库时 raw_workflow 为原始字符串,此处做宽容解析。
   *
   * 注意存放位置:归档层(doc.metadata)与扫描同步层(images[].metadata,
   * doc.metadata 为空)不一致——两者都回退尝试。
   *
   * 解析规则:
   *   1. 优先 doc.metadata.raw_workflow,其次首图 images[0].metadata.raw_workflow;
   *   2. 字符串则 JSON.parse(失败返回 null);
   *   3. 空值 / 非对象 / 数组返回 null;
   *   4. 通过则返回对象(内容不校验,能否加载由 ComfyUI 决定)。
   */
  private parseEmbeddedWorkflow(
    doc: Record<string, unknown>,
  ): Record<string, unknown> | null {
    // 两层元数据回退:先归档层 doc.metadata,再扫描同步层首图 metadata
    const docMeta =
      (doc.metadata as { raw_workflow?: unknown } | undefined) ?? {};
    const firstImage = Array.isArray(doc.images) ? doc.images[0] : undefined;
    const imgMeta =
      (firstImage as { metadata?: { raw_workflow?: unknown } } | undefined)
        ?.metadata ?? {};
    const raw =
      docMeta.raw_workflow ??
      (imgMeta as { raw_workflow?: unknown }).raw_workflow;
    let value = raw;
    // 字符串形式(入库路径)需宽容 JSON 解析;解析失败视为未嵌入工作流
    if (typeof raw === 'string') {
      try {
        value = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    // 空值 / 非对象 / 数组均不是合法 workflow 对象
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  /**
   * 按 sha256 定位包含该图片的 batch 文档(SQLite / Mongo 二选一)。
   * Mongo 侧取全文档(不含 _id)——调用方需要 images 全量做工作流提取。
   */
  private async findDocBySha256(
    sha256: string,
  ): Promise<Record<string, unknown> | null> {
    if (this.readMode) {
      return batchBySha256(this.sqliteDb, sha256);
    }
    return await this.imagesModel.collection.findOne(
      { 'images.file.sha256': sha256 },
      { projection: { _id: 0 } },
    );
  }

  /**
   * generate worker(push_workflow)错误 → HTTP 异常映射。
   * 错误码约定:-32010/-32011 定义于 workflow_db/generate_worker/methods.py
   * (ERR_COMFYUI_UNREACHABLE / ERR_COMFYUI_HTTP);-32602 为 JSON-RPC 标准码;
   * 协议框架见 docs/contracts/parse_worker_protocol.md(与 generate worker 仅方法清单不同)。
   *   - worker 不可用 → 503;请求超时 → 504;
   *   - RPC:-32010 ComfyUI 不可达 → 503; -32011 校验/写入失败 → 502;
   *          -32602 参数非法 → 400; 其余 → 500。
   */
  private mapWorkerError(err: unknown): HttpException {
    if (err instanceof WorkerUnavailableError) {
      // worker 进程未启动/已退出:503,前端提示服务未就绪
      return new ServiceUnavailableException(err.message);
    }
    if (err instanceof WorkerRequestTimeout) {
      // 超时:504 网关超时
      return new HttpException(err.message, HttpStatus.GATEWAY_TIMEOUT);
    }
    if (err instanceof WorkerRpcError) {
      // ComfyUI 不可达:503,与 worker 不可用同语义
      if (err.code === -32010) {
        return new ServiceUnavailableException('ComfyUI unreachable');
      }
      // ComfyUI 校验/写入失败:502(上游是 ComfyUI,视为坏网关)
      if (err.code === -32011) {
        return new HttpException(
          `ComfyUI 校验/写入失败: ${err.message}`,
          HttpStatus.BAD_GATEWAY,
        );
      }
      // 参数非法:400,属调用方问题
      if (err.code === -32602) {
        return new BadRequestException(err.message);
      }
      // 未知 RPC 错误:按内部错误处理
      return new HttpException(err.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return new HttpException(
      'Generate worker error',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  // ----------------------------------------------------------- /api/image-refs

  /**
   * GET /api/image-refs — 按图片文件名、image_name、路径或 SHA 搜索。
   *
   * 查询参数:q —— 字面量子串(空白则返回空);limit —— 返回条数上限(默认 50)。
   * 返回文件级结果,不会把同批次中未命中的图片带入。重名不同路径分别保留;
   * 同一引用按 SHA → 路径 → 批次键降级折叠,duplicate_count 说明折叠数量。
   */
  @Get('image-refs')
  async imageRefs(
    @Query('q') q?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<Record<string, unknown>> {
    const limit = this.parseLimit(limitRaw, 50);
    // 空检索词无意义;纯远程待配库同样短路
    if (!q?.trim() || isEnginePending(this.config)) {
      return { items: [], count: 0 };
    }
    // 多取一小批候选,避免前排重复引用折叠后不足 limit 条;最终仍严格截断。
    const candidateLimit = Math.min(200, Math.max(limit * 5, limit));
    let candidates: Array<Record<string, unknown>>;
    if (this.readMode) {
      candidates = imageRefs(this.sqliteDb, q, candidateLimit);
    } else {
      const regex = imageRefMongoRegex(q);
      const docs = await this.imagesModel.collection
        .find(
          {
            $or: IMAGE_REF_FILE_FIELDS.map((field) => ({
              [`images.file.${field}`]: { $regex: regex, $options: 'i' },
            })),
          },
          {
            projection: {
              _id: 0,
              batch_key: 1,
              captured_at: 1,
              'images.file': 1,
              created_date: 1,
              'model.base_model': 1,
              'loras.names': 1,
            },
          },
        )
        .sort({ captured_at: -1 })
        .limit(candidateLimit)
        .toArray();
      candidates = docs.flatMap((doc) =>
        (
          (
            doc as {
              images?: Array<{ file?: Record<string, unknown> }>;
            }
          ).images ?? []
        ).map((img, imageIndex) => ({
          ...(img.file ?? {}),
          batch_key: (doc as { batch_key?: string }).batch_key,
          storage_key: String(imageIndex),
          created_date: (doc as { created_date?: string }).created_date,
          captured_at: (doc as { captured_at?: string }).captured_at,
          base_model: (doc as { model?: { base_model?: string } }).model
            ?.base_model,
          loras: (doc as { loras?: { names?: string[] } }).loras?.names ?? [],
        })),
      );
    }
    const items = shapeImageRefItems(candidates, q, limit);
    return { items, count: items.length };
  }
}
