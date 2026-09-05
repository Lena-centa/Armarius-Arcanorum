/**
 * labels 模块 —— 手动标注控制器(labels.controller.ts)
 *
 * 职责:提供"人工标签(manual-labels)"、"提示词批注(prompt-annotations)"
 * 与"标注分类(manual-label-categories)"三套 CRUD:
 *   GET  /api/manual-labels        列表(支持 category/lora/q/from/to/limit 过滤)
 *   POST /api/manual-labels        新建标签
 *   PUT  /api/manual-labels/:id    更新标签
 *   DELETE /api/manual-labels/:id  删除标签
 *   GET  /api/manual-label-categories    分类列表(默认 + 用户自定义)
 *   POST /api/manual-label-categories    新增分类
 *   DELETE /api/manual-label-categories/:key  删除分类(分类下有标注时 409)
 *   GET  /api/prompt-annotations   批注列表(按 name 过滤)
 *   POST /api/prompt-annotations   创建/upsert 批注(按 signature 唯一)
 *
 * 分类说明:分类不是硬编码白名单,而是库表数据(默认 6 类随库种子写入,
 * 用户可在标注库页增删)。新建/更新标注校验分类必须存在于分类集合;
 * 删除分类前检查该分类下是否还有标注(有则 409,避免产生孤儿标注)。
 *
 * 数据层策略:
 *   - 原生 MongoDB collection API(绕过 mongoose schema 过滤 ——
 *     manual-labels 存在 schema 外字段,如 loras/search_text)
 *   - SQLITE_READ=1 切读:读走 SQLite(reader 层),写只落 SQLite
 *   - SQLITE_DUAL_WRITE=1 双写:写路径 Mongo + SQLite 同时落
 *   - 切读期 Mongo _id 用内置时间戳字符串代替(仅 SQLite 时无 ObjectId)
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ObjectId } from 'mongodb';
import type Database from 'better-sqlite3';
import {
  ManualLabelCategories,
  ManualLabelCategoriesDocument,
  ManualLabels,
  ManualLabelsDocument,
  PromptAnnotations,
  PromptAnnotationsDocument,
} from '../../schemas';
import { RequireAuth } from '../../common/auth';
import { SQLITE_DB } from '../../sqlite/sqlite.module';
import {
  countLabelsByCategory,
  getLabel,
  getLabelCategory,
  listAnnotations,
  listLabelCategories,
  listLabels,
} from '../../sqlite/reader';
import { escapeRegExp } from '../../utils/escape-regex';
import {
  deleteLabel,
  deleteLabelCategory,
  upsertAnnotation,
  upsertLabel,
  upsertLabelCategory,
} from '../../sqlite/repo';

/**
 * 判断 SQLite 中 annotation 是否存在(upsert 计数用)。
 * 创建批注时先查是否存在,以对齐 Mongo updateOne(upsert) 的
 * matched/modified/upserted 三计数语义。
 * @param db SQLite 数据库实例
 * @param signature 批注唯一签名(prompt 指纹)
 * @returns 存在返回 true
 */
function qAnnotation(
  db: Database.Database,
  signature: string,
): boolean {
  return (
    (db
      .prepare('SELECT COUNT(*) AS c FROM prompt_annotations WHERE id = ?')
      .get(signature) as { c: number }).c > 0
  );
}

/**
 * 默认标注分类(随 SQLite 建表种子 / Mongo 启动补齐,用户可增删)。
 * 与前端快速标注的 QA_CATEGORIES 兜底保持一致。
 */
const DEFAULT_CATEGORIES: Array<[string, string]> = [
  ['character', '角色'],
  ['style', '风格'],
  ['concept', '概念'],
  ['quality', '质量'],
  ['negative', '负面'],
  ['technique', '技法'],
];

/**
 * 分类标识 key 合法性:字母/数字开头,仅含字母数字、下划线、连字符。
 * key 会进 URL 路径(删除接口)与标注 category 字段,收紧字符集防注入。
 */
const CATEGORY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * 24 位 hex 字符串 → ObjectId(原生 collection API 不做隐式转换,否则 PUT/DELETE 永不匹配)。
 * 非 24 位 hex(如切读期生成的 'label-xxx' 字符串 id)原样返回。
 * @param id 前端传来的标签 id
 * @returns ObjectId 或原字符串
 */
function mongoId(id: string): string | ObjectId {
  return /^[0-9a-fA-F]{24}$/.test(id) ? new ObjectId(id) : id;
}

/**
 * Labels controller — manual-labels CRUD + 分类 CRUD + prompt-annotations。
 * 用原生 MongoDB 查询绕过 mongoose schema 过滤（manual-labels 有 schema 外字段）。
 * 切读(SQLITE_READ=1)时读走 SQLite;写双落(双写或切读期)。
 *
 * 实例字段:
 *   writeSqlite  是否写 SQLite(切读或双写时为 true)
 *   writeMongo   是否写 Mongo(仅非切读时为 true,即单引擎切读期只写 SQLite)
 *   readMode     切读开关(决定读路径走哪)
 *   categoriesSeeded  默认分类是否已补种(Mongo 路径幂等标记)
 */
// 类级鉴权(GW-01/VULN-01):标注/分类含全部写端点,未配 token 时仅放行回环
// 来源,显式 0.0.0.0 部署时远端必须持 token(与 settings/orchestration 同策略)
@RequireAuth()
@Controller('api')
export class LabelsController implements OnModuleInit {
  private readonly writeSqlite: boolean;
  private readonly writeMongo: boolean;
  private readonly readMode: boolean;
  private categoriesSeeded = false;

  constructor(
    private readonly config: ConfigService,
    @Inject(SQLITE_DB) private readonly sqliteDb: Database.Database,
    @InjectModel(ManualLabels.name) private readonly labelsModel: Model<ManualLabelsDocument>,
    @InjectModel(PromptAnnotations.name) private readonly annotationsModel: Model<PromptAnnotationsDocument>,
    @InjectModel(ManualLabelCategories.name)
    private readonly categoriesModel: Model<ManualLabelCategoriesDocument>,
  ) {
    this.readMode = this.config.get<boolean>('sqlite.readMode') ?? false;
    this.writeSqlite =
      this.readMode || (this.config.get<boolean>('sqlite.dualWrite') ?? false);
    // 单引擎模式(SQLITE_READ=1)下写只落 SQLite
    this.writeMongo = !this.readMode;
  }

  /**
   * 启动时向 Mongo 补齐默认分类(幂等,已存在不覆盖)。
   * SQLite 由建表种子负责,此方法仅 Mongo 路径需要。
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.ensureDefaultCategories();
    } catch {
      // 引擎不可用(Mongo 关闭)时忽略:标注功能仍可走 SQLite
    }
  }

  /**
   * Mongo 路径默认分类幂等补种:$setOnInsert + upsert 只插入缺失项,
   * created_at 用 epoch(排序时默认分类恒排最前)。
   */
  private async ensureDefaultCategories(): Promise<void> {
    if (!this.writeMongo || this.categoriesSeeded) return;
    const ops = DEFAULT_CATEGORIES.map(([key, label]) => ({
      updateOne: {
        filter: { key },
        update: { $setOnInsert: { key, label, created_at: new Date(0) } },
        upsert: true,
      },
    }));
    await this.categoriesModel.collection.bulkWrite(ops as never, {
      ordered: false,
    });
    this.categoriesSeeded = true;
  }

  /**
   * 全量分类列表(统一入口,读路径按引擎分流)。
   *
   * @returns { key, label } 数组(默认分类在前,用户自定义排后)
   */
  private async categoryList(): Promise<Array<Record<string, unknown>>> {
    if (this.readMode) {
      return listLabelCategories(this.sqliteDb);
    }
    await this.ensureDefaultCategories();
    const docs = await this.categoriesModel.collection
      .find({}, { projection: { _id: 0 } })
      .sort({ created_at: 1, key: 1 })
      .toArray();
    return docs as Array<Record<string, unknown>>;
  }

  /**
   * 时间边界规范化:纯日期补 UTC 日界,带时间的值原样返回。
   *
   * @param value from/to 入参(YYYY-MM-DD 或含时间的 ISO 串)
   * @param isTo 结束边界补 23:59:59.999Z,起始边界补 00:00:00.000Z
   * @returns 规范化比较串
   */
  private dateBound(value: string, isTo: boolean): string {
    const v = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return isTo ? `${v}T23:59:59.999Z` : `${v}T00:00:00.000Z`;
    }
    return v;
  }

  // ----------------------------------------------------------- manual-labels

  /**
   * limit 解析:非法/负值拒绝,1~200 钳制(防 SQLite LIMIT -1 全表返回)。
   * 语义比 stats 的 parseLimit 更严格:这里是显式 400(前端传错能立即发现),
   * stats 侧是静默回退默认值。
   * @param raw query 里的原始 limit 字符串(可能 undefined)
   * @param def 缺省值
   * @param max 上限(默认 200)
   * @returns 解析后的合法 limit 数值
   * @throws HttpException 400 —— limit 不是有限数字或 < 1
   */
  private parseLimit(raw: string | undefined, def: number, max = 200): number {
    if (raw === undefined) return def;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new HttpException(
        `limit must be between 1 and ${max}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return Math.min(n, max);
  }

  /**
   * GET /api/manual-labels — 标签列表。
   * 过滤条件:
   *   category:精确匹配分类
   *   lora:按 loras 数组正则模糊匹配(转义用户输入防正则注入)
   *   q:按 search_text(名称+loras 小写拼接)模糊搜索
   *   from/to:created_at 区间(前端 date input 传 YYYY-MM-DD)
   * 排序:updated_at 降序 → created_at 降序。readMode 走 SQLite。
   * 返回的 items 每项含 id(SQLite 主键 / Mongo _id 字符串化,前端编辑定位用)。
   * @returns { items, categories, count } categories 为 { key, label } 数组
   */
  @Get('manual-labels')
  async listLabels(
    @Query('category') category?: string,
    @Query('lora') lora?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<Record<string, unknown>> {
    const limit = this.parseLimit(limitRaw, 100);
    // 构造 Mongo filter(仅传入的条件);正则部分用 escapeRegExp 转义
    const filter: Record<string, unknown> = {};
    if (category) filter.category = category;
    if (lora) filter.loras = { $regex: escapeRegExp(lora), $options: 'i' };
    if (q) filter.search_text = { $regex: escapeRegExp(q), $options: 'i' };
    if (from) filter.created_at = { ...(filter.created_at as object), $gte: this.dateBound(from, false) };
    if (to) filter.created_at = { ...(filter.created_at as object), $lte: this.dateBound(to, true) };

    let docs: Array<Record<string, unknown>>;
    if (this.readMode) {
      // 切读:SQLite 同语义查询(SQLite 侧已注入 id)
      docs = listLabels(this.sqliteDb, { category, lora, q, from, to, limit });
    } else {
      // Mongo:取 _id 用于 id 字段,按更新时间倒序,截取 limit 条
      const rows = await this.labelsModel.collection
        .find(filter, { projection: { _id: 1 } })
        .sort({ updated_at: -1, created_at: -1 })
        .limit(limit)
        .toArray();
      docs = rows.map((row) => {
        const doc = { ...row } as Record<string, unknown>;
        doc.id = String(row._id);
        delete doc._id;
        return doc;
      });
    }

    return {
      items: docs,
      categories: await this.categoryList(),
      count: docs.length,
    };
  }

  /**
   * POST /api/manual-labels — 新建标签。
   * 校验:category 必须存在于分类集合(否则 400);name 非空。
   * 构造:name/category 规范化 + 时间戳 + search_text(名称+loras 小写拼接,
   * 供搜索)。切读期无 Mongo 时 _id 用 'label-' + 时间戳36进制 代替。
   * @param body 标签字段(name/category/loras 等,允许任意额外字段透传)
   * @returns { item } item 含 id 的完整文档
   */
  @Post('manual-labels')
  async createLabel(@Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    // 入参规范化:name/category 去首尾空白
    const name = String(body.name ?? '').trim();
    const category = String(body.category ?? '').trim();
    const categories = await this.categoryList();
    if (!categories.some((c) => (c as { key: string }).key === category)) {
      throw new HttpException('Invalid category', HttpStatus.BAD_REQUEST);
    }
    if (!name) {
      throw new HttpException('Name is required', HttpStatus.BAD_REQUEST);
    }

    // 组装文档:保留前端全部字段,覆写 name/category,补时间戳与搜索文本
    const now = new Date();
    const doc: Record<string, unknown> = {
      ...body,
      name,
      category,
      created_at: now,
      updated_at: now,
      // search_text = name + 各 lora 名,小写,空格分隔(模糊搜索用)
      search_text: [name, ...(Array.isArray(body.loras) ? body.loras : [])].join(' ').toLowerCase(),
    };

    // 写入:非切读期插 Mongo;切读期生成本地时间戳 id(无 Mongo 主键)
    const result = this.writeMongo
      ? await this.labelsModel.collection.insertOne(doc as never)
      : { insertedId: 'label-' + Date.now().toString(36) };
    // 需要落 SQLite 时同步 upsert
    if (this.writeSqlite) {
      upsertLabel(this.sqliteDb, String(result.insertedId), doc);
    }
    return { item: { ...doc, id: String(result.insertedId) } };
  }

  /**
   * PUT /api/manual-labels/:label_id — 更新标签。
   * 流程:合并 body 与新 updated_at → 改 name 时重算 search_text → 剔除 _id →
   * Mongo findOneAndUpdate(返回更新后文档);SQLite 侧先读当前值再合并写回。
   * 两侧都无记录时抛 404。
   * @param labelId 标签 id(24 位 hex 或切读期字符串 id)
   * @param body 待更新字段(partial;category 变更时校验必须存在于分类集合)
   * @returns { item } item 为更新后的完整文档(含 id)
   * @throws HttpException 404 —— 标签不存在
   */
  @Put('manual-labels/:label_id')
  async updateLabel(
    @Param('label_id') labelId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // 组装更新集:body + 刷新 updated_at
    const update: Record<string, unknown> = { ...body, updated_at: new Date() };
    // 分类变更时校验合法性(必须存在于分类集合)
    if (body.category !== undefined) {
      const category = String(body.category ?? '').trim();
      const categories = await this.categoryList();
      if (!categories.some((c) => (c as { key: string }).key === category)) {
        throw new HttpException('Invalid category', HttpStatus.BAD_REQUEST);
      }
      update.category = category;
    }
    if (body.name) {
      // name 变更 → search_text 必须同步重算,否则搜索仍命中旧文本
      update.search_text = [String(body.name), ...(Array.isArray(body.loras) ? body.loras : [])].join(' ').toLowerCase();
    }
    // _id 不可被 body 覆盖
    delete update._id;

    let result: Record<string, unknown> | null = null;
    if (this.writeMongo) {
      // 原子更新并返回更新后文档(returnDocument: 'after')
      const mr = await this.labelsModel.collection.findOneAndUpdate(
        { _id: mongoId(labelId) } as never,
        { $set: update },
        { returnDocument: 'after', projection: { _id: 0 } },
      );
      result = mr as Record<string, unknown> | null;
    }
    if (this.writeSqlite) {
      // SQLite:读当前值 → 合并更新 → 写回;Mongo 未命中时用它兜底结果
      const current = getLabel(this.sqliteDb, labelId);
      if (current) {
        upsertLabel(this.sqliteDb, labelId, { ...current, ...update });
        if (!result) result = { ...current, ...update };
      }
    }
    // 两个引擎都没有该记录:404
    if (!result) {
      throw new HttpException('Label not found', HttpStatus.NOT_FOUND);
    }
    return { item: { ...result, id: labelId } };
  }

  /**
   * DELETE /api/manual-labels/:label_id — 删除标签。
   * Mongo 与 SQLite 都执行删除,返回实际删除计数(任一引擎命中即 ≥1)。
   * @param labelId 标签 id
   * @returns { deleted: number }
   */
  @Delete('manual-labels/:label_id')
  async deleteLabel(@Param('label_id') labelId: string): Promise<Record<string, unknown>> {
    let deletedCount = 0;
    if (this.writeMongo) {
      const result = await this.labelsModel.collection.deleteOne({ _id: mongoId(labelId) } as never);
      deletedCount = result.deletedCount;
    }
    if (this.writeSqlite) {
      // SQLite 删除成功则累加(Mongo 未删除时保证返回值正确)
      deletedCount = deleteLabel(this.sqliteDb, labelId) || deletedCount;
    }
    return { deleted: deletedCount };
  }

  // ----------------------------------------------------------- manual-label-categories

  /**
   * GET /api/manual-label-categories — 分类列表(默认 + 用户自定义)。
   * 排序:默认分类(created_at=epoch)在前,后加的自定义分类排后。
   * @returns { items } items 为 { key, label } 数组
   */
  @Get('manual-label-categories')
  async listCategories(): Promise<Record<string, unknown>> {
    return { items: await this.categoryList() };
  }

  /**
   * POST /api/manual-label-categories — 新增分类。
   * 校验:key 必须匹配 CATEGORY_KEY_RE(字母/数字开头,仅含字母数字/下划线/连字符,
   * 因 key 会进 URL 路径与标注 category 字段);label 非空;key 已存在则 409
   * (分类是引用完整性键,不允许静默覆盖)。
   * 写入:非切读期插 Mongo;SQLite 侧始终 upsert 兜底。
   * @param body { key, label }
   * @returns { item } item 为 { key, label }
   */
  @Post('manual-label-categories')
  async createCategory(
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const key = String(body.key ?? '').trim();
    const label = String(body.label ?? '').trim();
    if (!CATEGORY_KEY_RE.test(key)) {
      throw new HttpException(
        'Invalid category key (letters/digits/_/- only, must start with a letter or digit)',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!label) {
      throw new HttpException('Label is required', HttpStatus.BAD_REQUEST);
    }

    // key 查重:已存在则 409(用户可删除后重建,不允许静默覆盖已有分类)
    const existing = this.readMode
      ? getLabelCategory(this.sqliteDb, key)
      : await this.categoriesModel.collection.findOne({ key } as never);
    if (existing) {
      throw new HttpException(
        `Category "${key}" already exists`,
        HttpStatus.CONFLICT,
      );
    }

    const doc: Record<string, unknown> = {
      key,
      label,
      created_at: new Date(),
    };
    if (this.writeMongo) {
      await this.categoriesModel.collection.insertOne(doc as never);
    }
    if (this.writeSqlite) {
      upsertLabelCategory(this.sqliteDb, key, doc);
    }
    return { item: { key, label } };
  }

  /**
   * DELETE /api/manual-label-categories/:key — 删除分类。
   * 前置检查:该分类下仍有标注则 409(避免产生孤儿标注,前端提示先清理/迁移)。
   * 写入:非切读期删 Mongo;SQLite 侧始终删除。返回实际删除计数。
   * @param key 分类标识
   * @returns { deleted: number }
   */
  @Delete('manual-label-categories/:key')
  async deleteCategory(
    @Param('key') key: string,
  ): Promise<Record<string, unknown>> {
    // 分类下仍有标注:拒绝删除(先迁移/清理标注再删分类)
    const count = this.readMode
      ? countLabelsByCategory(this.sqliteDb, key)
      : await this.labelsModel.collection.countDocuments({ category: key } as never);
    if (count > 0) {
      throw new HttpException(
        `Category "${key}" still has ${count} label(s)`,
        HttpStatus.CONFLICT,
      );
    }

    let deletedCount = 0;
    if (this.writeMongo) {
      const result = await this.categoriesModel.collection.deleteOne({ key } as never);
      deletedCount = result.deletedCount;
    }
    if (this.writeSqlite) {
      deletedCount = deleteLabelCategory(this.sqliteDb, key) || deletedCount;
    }
    return { deleted: deletedCount };
  }

  // ----------------------------------------------------------- prompt-annotations

  /**
   * GET /api/prompt-annotations — 批注列表。
   * 可选按 name 正则模糊过滤(转义输入);无排序(按集合自然序),截取 limit 条。
   * @returns { items, count }
   */
  @Get('prompt-annotations')
  async listAnnotations(
    @Query('name') name?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<Record<string, unknown>> {
    const limit = this.parseLimit(limitRaw, 100);
    const filter: Record<string, unknown> = {};
    if (name) filter.name = { $regex: escapeRegExp(name), $options: 'i' };

    let docs: Array<Record<string, unknown>>;
    if (this.readMode) {
      docs = listAnnotations(this.sqliteDb, name, limit);
    } else {
      docs = await this.annotationsModel.collection
        .find(filter, { projection: { _id: 0 } })
        .limit(limit)
        .toArray();
    }

    return { items: docs, count: docs.length };
  }

  /**
   * POST /api/prompt-annotations — 创建/更新批注(按 signature 幂等 upsert)。
   * signature/name 均必填(400)。Mongo 用 updateOne(upsert:true) 返回
   * matched/modified/upserted 计数;SQLite 侧先查存在性,构造等价计数。
   * @param body { signature, name, ...任意批注字段 }
   * @returns { matched, modified, upserted }
   */
  @Post('prompt-annotations')
  async createAnnotation(@Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    // 校验必填字段(signature 是幂等键,name 是展示名)
    const signature = String(body.signature ?? '').trim();
    const name = String(body.name ?? '').trim();
    if (!signature) {
      throw new HttpException('signature is required', HttpStatus.BAD_REQUEST);
    }
    if (!name) {
      throw new HttpException('name is required', HttpStatus.BAD_REQUEST);
    }

    const doc = { ...body, signature, name };
    let matched = 0;
    let modified = 0;
    let upserted = 0;
    if (this.writeMongo) {
      // Mongo:按 signature upsert
      const result = await this.annotationsModel.collection.updateOne(
        { signature } as never,
        { $set: doc },
        { upsert: true },
      );
      matched = result.matchedCount;
      modified = result.modifiedCount;
      upserted = result.upsertedCount;
    }
    if (this.writeSqlite) {
      // SQLite:先查存在性,再写;存在→matched=1,不存在→upserted=1
      // (modified 无法精确统计,保持 Mongo 侧原值)
      const before = qAnnotation(this.sqliteDb, signature);
      upsertAnnotation(this.sqliteDb, signature, doc);
      upserted = before ? upserted : 1;
      matched = before ? 1 : matched;
    }
    return { matched, modified, upserted };
  }
}
