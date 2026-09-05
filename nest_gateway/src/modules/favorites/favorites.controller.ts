/**
 * favorites 模块 —— 图片收藏控制器(favorites.controller.ts)
 *
 * 职责:提供图片收藏的 CRUD(按 (sha256, category) 复合键幂等)与收藏分类的 CRUD:
 *   GET    /api/favorites        收藏列表(按图聚合;categories 重复参数 + mode=or|and,返回 categories)
 *   POST   /api/favorites        收藏/更新(按 (sha256, category) 复合键幂等 upsert)
 *   DELETE /api/favorites/:sha256 取消收藏(删全部分类);
 *         /api/favorites/:sha256?category=x 仅移出该分类
 *   GET    /api/favorite-categories    收藏分类列表(默认 + 用户自定义)
 *   POST   /api/favorite-categories    新增收藏分类
 *   DELETE /api/favorite-categories/:key  删除收藏分类(分类下有收藏时 409)
 *
 * 一图多分类:同一张图可在多个分类下各存一条收藏(复合唯一键),
 * 空串 category = 未分类(参与复合键,与显式分类同等地位)。
 *
 * 分类说明:收藏子分类与标注分类同构 —— 不是硬编码白名单,而是库表数据
 * (默认 6 类随 SQLite 建表种子 / Mongo 启动补齐,用户在筛选区增删)。
 * 新建/更新收藏校验分类必须存在于分类集合;删除分类前检查该分类下是否
 * 还有收藏(有则 409,避免产生孤儿收藏)。
 *
 * 数据层策略(与 labels 模块一致):
 *   - 原生 MongoDB collection API(绕过 mongoose schema 过滤)
 *   - SQLITE_READ=1 切读:读走 SQLite(reader 层),写只落 SQLite
 *   - SQLITE_DUAL_WRITE=1 双写:写路径 Mongo + SQLite 同时落
 *   - 切读期无 Mongo 主键问题:收藏主键即 (sha256, category),无需生成 ObjectId
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  OnModuleInit,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type Database from 'better-sqlite3';
import { FavoriteCategories, FavoriteCategoriesDocument, Favorites, FavoritesDocument } from '../../schemas';
import { RequireAuth } from '../../common/auth';
import { SQLITE_DB } from '../../sqlite/sqlite.module';
import {
  countFavoritesByCategory,
  getFavorite,
  getFavoriteCategory,
  listFavoriteCategories,
  listFavorites,
} from '../../sqlite/reader';
import {
  deleteFavorite,
  deleteFavoriteCategory,
  upsertFavorite,
  upsertFavoriteCategory,
} from '../../sqlite/repo';

/**
 * 默认收藏分类(随 SQLite 建表种子 / Mongo 启动补齐,用户可增删)。
 * 面向图片收藏的使用场景,与标注分类区分。
 */
const DEFAULT_CATEGORIES: Array<[string, string]> = [
  ['character', '人物'],
  ['scene', '场景'],
  ['composition', '构图'],
  ['color', '色彩'],
  ['inspiration', '灵感'],
  ['inbox', '待整理'],
];

/**
 * 分类标识 key 合法性:字母/数字开头,仅含字母数字、下划线、连字符。
 * key 会进 URL 路径(删除接口)与收藏 category 字段,收紧字符集防注入。
 */
const CATEGORY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * 收藏时间排序值:created_at/updated_at 可能是 Date(Mongo 原生)或
 * ISO 字符串(SQLite doc_json),统一转毫秒时间戳(空/非法回退 0)。
 */
function favoriteTimeValue(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(String(value ?? '')).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 收藏行按图聚合(一图多分类,Mongo 路径;SQLite reader 同语义):
 * 同 sha256 的全部分类行合并为一条 —— 基底快照取 updated_at 最新一行
 * (展示字段/备注以最新为准),categories 携带该图全部分类;
 * 排序 = 图内 created_at 最大值降序(最近收藏在前)。
 */
function aggregateFavoritesByImage(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const bySha = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const sha = String(row.sha256 ?? '');
    if (!sha) continue;
    const list = bySha.get(sha);
    if (list) list.push(row);
    else bySha.set(sha, [row]);
  }
  const aggregated: Array<{ latest: number; item: Record<string, unknown> }> = [];
  for (const [sha, docs] of bySha) {
    const base = docs
      .slice()
      .sort(
        (a, b) => favoriteTimeValue(b.updated_at) - favoriteTimeValue(a.updated_at),
      )[0];
    aggregated.push({
      latest: Math.max(...docs.map((d) => favoriteTimeValue(d.created_at))),
      item: {
        ...base,
        sha256: sha,
        categories: docs.map((d) => String(d.category ?? '')),
      },
    });
  }
  aggregated.sort((a, b) => b.latest - a.latest);
  return aggregated.map((entry) => entry.item);
}

/**
 * Favorites controller — 图片收藏 CRUD + 收藏分类 CRUD。
 * 实例字段与 labels 控制器同语义:
 *   writeSqlite  是否写 SQLite(切读或双写时为 true)
 *   writeMongo   是否写 Mongo(仅非切读时为 true)
 *   readMode     切读开关(决定读路径走哪)
 *   categoriesSeeded  默认分类是否已补种(Mongo 路径幂等标记)
 */
// 类级鉴权(GW-01/VULN-01):收藏/收藏分类含全部写端点,未配 token 时仅放行
// 回环来源,显式 0.0.0.0 部署时远端必须持 token(与 settings 同策略)
@RequireAuth()
@Controller('api')
export class FavoritesController implements OnModuleInit {
  private readonly writeSqlite: boolean;
  private readonly writeMongo: boolean;
  private readonly readMode: boolean;
  private categoriesSeeded = false;

  constructor(
    private readonly config: ConfigService,
    @Inject(SQLITE_DB) private readonly sqliteDb: Database.Database,
    @InjectModel(Favorites.name) private readonly favoritesModel: Model<FavoritesDocument>,
    @InjectModel(FavoriteCategories.name)
    private readonly categoriesModel: Model<FavoriteCategoriesDocument>,
  ) {
    this.readMode = this.config.get<boolean>('sqlite.readMode') ?? false;
    this.writeSqlite =
      this.readMode || (this.config.get<boolean>('sqlite.dualWrite') ?? false);
    // 单引擎模式(SQLITE_READ=1)下写只落 SQLite
    this.writeMongo = !this.readMode;
  }

  /**
   * 启动时向 Mongo 补齐默认分类(幂等,已存在不覆盖),
   * 并完成收藏复合唯一索引的幂等迁移(旧单列唯一索引 → 复合索引)。
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.ensureFavoriteIndexes();
    } catch {
      // 索引迁移失败不阻断启动:复合索引由 schema 定义,多数库已就绪
    }
    try {
      await this.ensureDefaultCategories();
    } catch {
      // 引擎不可用(Mongo 关闭)时忽略:收藏功能仍可走 SQLite
    }
  }

  /**
   * Mongo 收藏索引迁移(幂等):
   * 旧版单列唯一索引 uniq_favorite_sha256({sha256:1}) 会阻止一图多分类写入,
   * 存在时删除;复合唯一索引 (sha256, category) 由 schema 定义,此处显式幂等创建兜底
   * (mongoose autoIndex 之外的保险,兼容 autoIndex 关闭的部署)。
   */
  private async ensureFavoriteIndexes(): Promise<void> {
    if (!this.writeMongo) return;
    try {
      await this.favoritesModel.collection.dropIndex('uniq_favorite_sha256');
    } catch {
      // 旧索引不存在(全新库/已迁移)时忽略
    }
    await this.favoritesModel.collection.createIndex(
      { sha256: 1, category: 1 },
      { name: 'uniq_favorite_sha_category', unique: true },
    );
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
   * 全量收藏分类列表(统一入口,读路径按引擎分流)。
   *
   * @returns { key, label } 数组(默认分类在前,用户自定义排后)
   */
  private async categoryList(): Promise<Array<Record<string, unknown>>> {
    if (this.readMode) {
      return listFavoriteCategories(this.sqliteDb);
    }
    await this.ensureDefaultCategories();
    const docs = await this.categoriesModel.collection
      .find({}, { projection: { _id: 0 } })
      .sort({ created_at: 1, key: 1 })
      .toArray();
    return docs as Array<Record<string, unknown>>;
  }

  /**
   * limit 解析:非法/负值拒绝,1~max 钳制(防 SQLite LIMIT -1 全表返回)。
   * @param raw query 里的原始 limit 字符串(可能 undefined)
   * @param def 缺省值
   * @param max 上限(收藏列表给更大上限,前端星标索引一次拉全)
   * @returns 解析后的合法 limit 数值
   * @throws HttpException 400 —— limit 不是有限数字或 < 1
   */
  private parseLimit(raw: string | undefined, def: number, max = 1000): number {
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
   * GET /api/favorites — 收藏列表(一图多分类:按图聚合返回)。
   * 过滤:categories 重复参数(categories=a&categories=b)+
   *   mode=or|and(缺省 or):
   *   - or:图在任一指定分类下即命中
   *   - and:图须同时归属全部分类
   * 旧单值参数 category=x 等价 categories=[x](向后兼容)。
   * 排序:最近收藏的图在前。readMode 走 SQLite。
   * 返回 items 每图一条(含该图全部分类 categories 数组,供前端卡片
   * 显示多徽章),同时携带全部分类,供筛选区候选/徽章一次性渲染。
   * @param limitRaw 条数上限 query(缺省 200,上限 1000;作用于聚合后的图数)
   * @returns { items, count, categories }
   */
  @Get('favorites')
  async listFavorites(
    @Query('category') category?: string,
    @Query('categories') categoriesRaw?: string | string[],
    @Query('mode') modeRaw?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<Record<string, unknown>> {
    const limit = this.parseLimit(limitRaw, 200, 1000);
    // 多值 categories(重复参数)+ 单值 category 兼容合并
    const rawList = Array.isArray(categoriesRaw)
      ? categoriesRaw
      : categoriesRaw
        ? [categoriesRaw]
        : [];
    const categories = [...rawList, ...(category ? [category] : [])]
      .map((c) => String(c).trim())
      .filter(Boolean);
    const mode: 'and' | 'or' = modeRaw === 'and' ? 'and' : 'or';
    let docs: Array<Record<string, unknown>>;
    if (this.readMode) {
      docs = listFavorites(this.sqliteDb, categories, mode, limit);
    } else {
      docs = await this.listFavoritesMongo(categories, mode, limit);
    }
    return { items: docs, count: docs.length, categories: await this.categoryList() };
  }

  /**
   * Mongo 路径收藏列表(与 SQLite reader 同语义,按图聚合):
   *   or:$match category $in → 命中任一;
   *   and:$match $in → $group by sha256 → 命中分类数 = N(全部分类齐备)。
   * 再取命中图的全部分类行,JS 侧聚合排序截断。
   */
  private async listFavoritesMongo(
    categories: string[],
    mode: 'and' | 'or',
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    let shaList: string[];
    if (categories.length) {
      const matched = (await this.favoritesModel.collection
        .aggregate([
          { $match: { category: { $in: categories } } as never },
          { $group: { _id: '$sha256', hits: { $sum: 1 } } },
          ...(mode === 'and' ? [{ $match: { hits: categories.length } }] : []),
        ])
        .toArray()) as Array<{ _id: string }>;
      shaList = matched.map((m) => String(m._id));
    } else {
      shaList = (await this.favoritesModel.collection.distinct('sha256')) as string[];
    }
    if (!shaList.length) return [];
    const rows = (await this.favoritesModel.collection
      .find({ sha256: { $in: shaList } } as never, { projection: { _id: 0 } })
      .toArray()) as Array<Record<string, unknown>>;
    return aggregateFavoritesByImage(rows).slice(0, limit);
  }

  /**
   * POST /api/favorites — 收藏/更新(按 (sha256, category) 复合键幂等 upsert)。
   * 校验:sha256 必填(400);category 非空时必须存在于收藏分类集合(400)。
   * 一图多分类:同一张图按 category 各存一条,互不覆盖。
   * 首次收藏补 created_at;同键重复收藏保留首次 created_at、刷新 updated_at
   * 与展示快照(filename/batch_key/captured_at/note 变更后同步)。
   * @param body { sha256, filename?, batch_key?, captured_at?, category?, note?, ...任意快照字段 }
   * @returns 收藏后的完整文档
   */
  @Post('favorites')
  async addFavorite(@Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sha256 = String(body.sha256 ?? '').trim();
    if (!sha256) {
      throw new HttpException('sha256 is required', HttpStatus.BAD_REQUEST);
    }
    // 分类合法性校验:非空分类必须存在于收藏分类集合(空串 = 未分类)
    const category = String(body.category ?? '').trim();
    if (category) {
      const categories = await this.categoryList();
      if (!categories.some((c) => (c as { key: string }).key === category)) {
        throw new HttpException('Invalid category', HttpStatus.BAD_REQUEST);
      }
    }

    const now = new Date();
    // 同键已有收藏时保留首次 created_at(双引擎各自读当前档)
    const existing = this.writeSqlite
      ? getFavorite(this.sqliteDb, sha256, category)
      : ((await this.favoritesModel.collection
          .findOne(
            { sha256, category } as never,
            { projection: { _id: 0 } },
          )) as Record<string, unknown> | null);
    const doc: Record<string, unknown> = {
      ...body,
      sha256,
      // 空串 = 未分类,参与复合键(不再写 undefined,保证键语义稳定)
      category,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    if (this.writeMongo) {
      await this.favoritesModel.collection.updateOne(
        { sha256, category } as never,
        { $set: doc },
        { upsert: true },
      );
    }
    if (this.writeSqlite) {
      upsertFavorite(this.sqliteDb, sha256, category, doc);
    }
    return doc;
  }

  /**
   * DELETE /api/favorites/:sha256 — 取消收藏(两语义)。
   * 不带 query = 删该图全部分类(取消收藏);?category=x = 仅移出该分类。
   * Mongo 与 SQLite 都执行删除,返回实际删除计数(任一引擎命中即 ≥1)。
   * @param sha256 收藏定位键之一(图片 sha256)
   * @param categoryRaw 可选 query:目标分类(空串视为未分类)
   * @returns { deleted: number }
   */
  @Delete('favorites/:sha256')
  async removeFavorite(
    @Param('sha256') sha256: string,
    @Query('category') categoryRaw?: string,
  ): Promise<Record<string, unknown>> {
    // 注意区分「未传 query」与「query 为空串(未分类)」:
    // undefined = 删全部;'' = 只删未分类那条
    const category = categoryRaw === undefined ? undefined : String(categoryRaw).trim();
    let deletedCount = 0;
    if (this.writeMongo) {
      const filter = (category === undefined ? { sha256 } : { sha256, category }) as never;
      // 删全部可能涉及多条(一图多分类),单分类为复合键唯一一条
      const result =
        category === undefined
          ? await this.favoritesModel.collection.deleteMany(filter)
          : await this.favoritesModel.collection.deleteOne(filter);
      deletedCount = result.deletedCount;
    }
    if (this.writeSqlite) {
      deletedCount = deleteFavorite(this.sqliteDb, sha256, category) || deletedCount;
    }
    return { deleted: deletedCount };
  }

  // ----------------------------------------------------------- favorite-categories

  /**
   * GET /api/favorite-categories — 收藏分类列表(默认 + 用户自定义)。
   * 排序:默认分类(created_at=epoch)在前,后加的自定义分类排后。
   * @returns { items } items 为 { key, label } 数组
   */
  @Get('favorite-categories')
  async listCategories(): Promise<Record<string, unknown>> {
    return { items: await this.categoryList() };
  }

  /**
   * POST /api/favorite-categories — 新增收藏分类。
   * 校验:key 必须匹配 CATEGORY_KEY_RE(字母/数字开头,仅含字母数字/下划线/连字符,
   * 因 key 会进 URL 路径与收藏 category 字段);label 非空;key 已存在则 409。
   * 写入:非切读期插 Mongo;SQLite 侧始终 upsert 兜底。
   * @param body { key, label }
   * @returns { item } item 为 { key, label }
   */
  @Post('favorite-categories')
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
      ? getFavoriteCategory(this.sqliteDb, key)
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
      upsertFavoriteCategory(this.sqliteDb, key, doc);
    }
    return { item: { key, label } };
  }

  /**
   * DELETE /api/favorite-categories/:key — 删除收藏分类。
   * 前置检查:该分类下仍有收藏则 409(避免产生孤儿收藏,前端提示先清理/迁移)。
   * 写入:非切读期删 Mongo;SQLite 侧始终删除。返回实际删除计数。
   * @param key 分类标识
   * @returns { deleted: number }
   */
  @Delete('favorite-categories/:key')
  async deleteCategory(
    @Param('key') key: string,
  ): Promise<Record<string, unknown>> {
    // 分类下仍有收藏:拒绝删除(先迁移/清理收藏再删分类)
    const count = this.readMode
      ? countFavoritesByCategory(this.sqliteDb, key)
      : await this.favoritesModel.collection.countDocuments({ category: key } as never);
    if (count > 0) {
      throw new HttpException(
        `Category "${key}" still has ${count} favorite(s)`,
        HttpStatus.CONFLICT,
      );
    }

    let deletedCount = 0;
    if (this.writeMongo) {
      const result = await this.categoriesModel.collection.deleteOne({ key } as never);
      deletedCount = result.deletedCount;
    }
    if (this.writeSqlite) {
      deletedCount = deleteFavoriteCategory(this.sqliteDb, key) || deletedCount;
    }
    return { deleted: deletedCount };
  }
}
