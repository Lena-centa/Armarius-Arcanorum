/**
 * sqlite/reader.ts — 读路径 SQL 层(切读后控制器查询入口)。
 *
 * 与各控制器的 Mongo 查询语义对齐:
 *   - $regex 'i' 子串 → LIKE '%..%'(ASCII 大小写不敏感,SQLite 默认)
 *   - 数组字段筛选 → EXISTS 子表 / NOT EXISTS
 *   - distinct → SELECT DISTINCT(物化列/子表,避免 doc_json 全扫)
 *   - 详情/分析读 doc_json(原样文档)
 *
 * 数据流向:
 *   各控制器(images / stats / generate / labels ...)→ 本文件查询函数
 *   → SQLite 表(batches / recipe_groups / stats_docs / 子表 / fts_*)。
 *   列表页走"物化列过滤 + doc_json 取档"两段式:WHERE 用检索列
 *   命中后只回读 doc_json 列,避免大字段参与过滤全扫;
 *   写入侧(repo.ts)保证物化列与 doc_json 同事务更新,读到的永远一致。
 */

import type Database from 'better-sqlite3';
import { bothPlatformForms } from './repo';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * LIKE 模式转义:% _ \ 前缀反斜杠,配合 SQL `ESCAPE '\'` 使用,
 * 防止用户输入中的通配符被当作模式(注入式误匹配)。
 */
function likeEscape(p: string): string {
  return p.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * 把用户查询词包装为子串匹配模式:%<转义后词>%。
 */
function likePattern(q: string): string {
  return `%${likeEscape(q)}%`;
}

/**
 * FTS5 MATCH 查询串构造:多词 OR,每词一个引号 phrase。
 *
 * phrase 引号内的原文交由 FTS 分词器处理:`akiyama_mizuki` 与
 * `akiyama mizuki` 同为 phrase(akiyama, mizuki)——天然覆盖
 * search_text 里下划线/空格两种 tag 写法;词内双引号按 FTS
 * 语法转义(防御性,tag 名实际不含引号)。
 */
function ftsOrQuery(terms: string[]): string {
  return terms
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ');
}

/**
 * search_text 匹配条件:
 *   - qOr(IP 遍历展开词集)走 FTS5 MATCH(倒排索引,百词级毫秒);
 *     词集若用 LIKE OR 链是全表扫 × 每行百次子串匹配(实测 26s),
 *     FTS 通过 rowid 子查询回连主表(fts 行与主表行 rowid 对齐,
 *     由写路径显式指定 rowid 与启动自愈共同保证)。
 *   - q 单词保持 LIKE 子串:用户部分词输入依赖子串语义
 *     (如 `girl` 命中 `1girl`),token 级 FTS 会漏;
 *     IP 词集是完整 tag 名,token 级 phrase 语义正好。
 * "任一命中即命中" = 与 Mongo $regex alternation 同语义。
 *
 * @param ftsTable qOr 路径使用的 FTS 表名(与被查主表配对:
 *                 batches→fts_batches 等,默认 fts_batches)
 */
function searchTextCond(
  where: string[],
  params: Array<string | number>,
  q?: string,
  qOr?: string[],
  ftsTable = 'fts_batches',
): void {
  if (qOr && qOr.length) {
    where.push(
      `rowid IN (SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ?)`,
    );
    params.push(ftsOrQuery(qOr));
  } else if (q) {
    where.push(`search_text LIKE ? ESCAPE '\\'`);
    params.push(likePattern(q));
  }
}

/**
 * base_model 家族匹配的归一化:
 *   1. 小写(LIKE 对 ASCII 大小写不敏感,但归一后两边一致更稳);
 *   2. 连字符 → 下划线(库内同家族命名混用,如 anima-base-v1.0 vs anima_baseV10);
 *   3. 剥 .safetensors 后缀(同模型带/不带后缀分裂为两条记录)。
 * 不做更深归一(版本号写法 v1.0/v10、空格等):子串匹配只需家族段对齐。
 */
function normalizeBaseModel(value: string): string {
  return value.toLowerCase().replace(/-/g, '_').replace(/\.safetensors/g, '');
}

/**
 * base_model 过滤的 SQL 列表达式:列值经与 normalizeBaseModel 相同的
 * 归一化后参与 LIKE,配合参数侧归一,实现"家族名子串匹配"。
 * 函数包裹使 idx_batches_base_model 等值索引失效,但批次数级小,
 * 全表扫描可接受(家族匹配本身就是跨值扫描语义)。
 */
const BASE_MODEL_NORM_SQL = `LOWER(REPLACE(REPLACE(base_model, '-', '_'), '.safetensors', ''))`;

/**
 * base_model 过滤条件:归一化列 LIKE 归一化参数(ESCAPE 转义通配符)。
 */
function baseModelFilter(
  where: string[],
  params: Array<string | number>,
  baseModel: string,
): void {
  where.push(`${BASE_MODEL_NORM_SQL} LIKE ? ESCAPE '\\'`);
  params.push(likePattern(normalizeBaseModel(baseModel)));
}

/**
 * LIMIT 兜底:负值/NaN/0 回退默认,超大值 clamp 到上限。
 * SQLite 负 LIMIT 语义是"无限制",恶意或异常入参可直接放大为全表扫描,
 * 这里在 reader 层统一夹紧(controller 侧另有参数校验)。
 *
 * @param limit 入参(可能来自 query string,未经类型保证)
 * @param fallback 非法值回退的默认页大小(默认 50)
 * @param max 有效页大小的上限(默认 200)
 * @returns [1, max] 范围内的安全值
 */
function clampLimit(limit: number, fallback = 50, max = 200): number {
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(limit, max);
}

/**
 * 日期/时间边界规范化:纯日期(YYYY-MM-DD)补 UTC 零点(from)/日末(to),
 * 与 captured_at(UTC ISO)字符串比较兼容,语义等价原 created_date 天粒度;
 * 已带时间的值(前端已转 UTC ISO)原样参与比较。调用方须保证 value 非空。
 *
 * @param value from_date/to_date 入参(可含时间,已通过非空守卫)
 * @param isTo 是否为结束边界(补日末 23:59:59.999Z)
 * @returns 规范化比较串
 */
function normalizeDateBound(value: string, isTo: boolean): string {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return isTo ? `${v}T23:59:59.999Z` : `${v}T00:00:00.000Z`;
  }
  return v;
}

/**
 * doc_json 列解析为文档数组(剔除 Mongo 内部 _id,与投影 {_id:0} 对齐)。
 *
 * @param rows doc_json 字符串行
 * @returns 文档对象数组
 *
 * 说明:_id 是 Mongo 历史字段,SQLite 侧由主键承担标识职责;
 * 剔除后保证下游拿到的是"业务文档"而非存储杂质,与 Mongo 接口输出一致。
 */
function parseDocs(rows: Array<{ doc_json: string }>): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const doc = JSON.parse(r.doc_json) as Record<string, unknown>;
    delete doc._id;
    return doc;
  });
}

/**
 * 批次列表过滤条件(与 Mongo 查询参数一一对应):
 *   - q:search_text 子串(对应 $regex 'i')
 *   - excludeQ:排除词数组,每个词一条 search_text NOT LIKE(对应 $not 正则)
 *   - filename:批内任意图 filename 子串
 *   - baseModel:物化列归一化子串(家族匹配,见 baseModelFilter)
 *   - loras/loraMode 与 excludeLoras/excludeLoraMode:子表 EXISTS 组合
 *     (多值与/或,语义见 loraNamesCond;单值等价于任一 mode)
 *   - fromDate / toDate:captured_at 区间
 */
export interface BatchListFilter {
  /** 单一检索词:search_text 子串匹配。与 qOr 二选一,set qOr 优先。 */
  q?: string;
  /** IP 遍历展开词集(多词 OR):任一命中即命中,取代 q 的单词匹配。 */
  qOr?: string[];
  excludeQ?: string[];
  filename?: string;
  baseModel?: string;
  /** 正向 LoRA 名单;空/缺省 = 不过滤。 */
  loras?: string[];
  /** 正向组合:'or' 命中任一(默认)| 'and' 全部包含。 */
  loraMode?: 'and' | 'or';
  /** 排除 LoRA 名单;空/缺省 = 不排除。 */
  excludeLoras?: string[];
  /** 排除组合:'and' 全部不含(默认,任一命中即排除)| 'or' 不同时含全部(仅全占才排除)。 */
  excludeLoraMode?: 'and' | 'or';
  fromDate?: string;
  toDate?: string;
}

/** 分页:skip = 偏移,limit = 每页条数(由 clampLimit 夹紧)。 */
export interface Page {
  skip: number;
  limit: number;
  /** 可选的调用方上限;未提供时回落到 200。 */
  maxLimit?: number;
}

/**
 * 多值 LoRA 正向/排除筛选 → 子表 EXISTS 组合条件(batches/recipes 共用)。
 *
 * 语义(与 Mongo 侧 $in/$all/$nin/$not.$all 一一对应):
 *   - 正向 or:任一命中 → 单条 EXISTS(name IN (?,...))
 *   - 正向 and:全部包含 → 每名一条 EXISTS 相 AND
 *   - 排除 and:全部不含 → 任一命中即排除 → 单条 NOT EXISTS(name IN)
 *   - 排除 or:不同时含全部 → 至少缺一 → 每名一条 NOT EXISTS 用 OR 连接
 *
 * @param mainTable 主表别名(batches / recipe_groups,与调用点一致)
 * @param keyCol    批键列名(batch_key / recipe_key),子表与主表同名关联
 */
function loraNamesCond(
  where: string[],
  params: Array<string | number>,
  filter: Pick<
    BatchListFilter,
    'loras' | 'loraMode' | 'excludeLoras' | 'excludeLoraMode'
  >,
  mainTable: string,
  keyCol: string,
): void {
  const existsSql = (name: string, negated = false): string =>
    `${negated ? 'NOT EXISTS' : 'EXISTS'} (SELECT 1 FROM ${tableOf(mainTable)} bl
               WHERE bl.${keyCol} = ${mainTable}.${keyCol} AND bl.name = ?)`;
  if (filter.loras && filter.loras.length > 0) {
    if ((filter.loraMode ?? 'or') === 'or') {
      const holders = filter.loras.map(() => '?').join(', ');
      where.push(
        `EXISTS (SELECT 1 FROM ${tableOf(mainTable)} bl
               WHERE bl.${keyCol} = ${mainTable}.${keyCol}
               AND bl.name IN (${holders}))`,
      );
      params.push(...filter.loras);
    } else {
      for (const name of filter.loras) {
        where.push(existsSql(name));
        params.push(name);
      }
    }
  }
  if (filter.excludeLoras && filter.excludeLoras.length > 0) {
    if ((filter.excludeLoraMode ?? 'and') === 'and') {
      const holders = filter.excludeLoras.map(() => '?').join(', ');
      where.push(
        `NOT EXISTS (SELECT 1 FROM ${tableOf(mainTable)} bl
                   WHERE bl.${keyCol} = ${mainTable}.${keyCol}
                   AND bl.name IN (${holders}))`,
      );
      params.push(...filter.excludeLoras);
    } else {
      // 不同时含全部 ⇔ 至少缺一 ⇔ 各名 NOT EXISTS 的 OR(整体加括号防外层 AND 粘连)
      const clauses = filter.excludeLoras.map((name) => existsSql(name, true));
      where.push(`(${clauses.join(' OR ')})`);
      params.push(...filter.excludeLoras);
    }
  }
}

/** lora 名字子表名:按主表别名映射(batches→batch_lora_names,recipe_groups→recipe_lora_names)。 */
function tableOf(mainTable: string): string {
  return mainTable === 'batches' ? 'batch_lora_names' : 'recipe_lora_names';
}

// ---------------------------------------------------------------------------
// images 控制器
// ---------------------------------------------------------------------------

/**
 * 批次列表(全文档):LIKE 搜索 + 子表 EXISTS 筛选 + 日期列 + 排序分页。
 *
 * @param db 目标连接
 * @param filter 过滤条件(见 BatchListFilter)
 * @param page 分页参数
 * @returns { items: 全档文档数组, total: 满足条件的总数(分页前) }
 *
 * 语义要点:
 *   - 恒有 has_positive = 1(与 Mongo 默认查询一致,只返回含正向 prompt 的批次)
 *   - 筛选组合用 AND 连接(与 Mongo 多条件叠加语义一致)
 *   - 先 COUNT 再 SELECT,两次查询复用同一 whereSql 与参数
 *   - 排序 captured_at DESC, batch_key DESC:稳定排序,分页不重不漏
 *     (captured_at 同值场景由 batch_key 定序)
 */
export function listBatches(
  db: Database.Database,
  filter: BatchListFilter,
  page: Page,
): { items: Array<Record<string, unknown>>; total: number } {
  const where: string[] = ['has_positive = 1'];
  const params: Array<string | number> = [];

  // 搜索词:物化列 search_text 子串匹配(ESCAPE 声明反斜杠转义);
  // qOr(IP 遍历展开词集)优先于 q 单词(走 fts_batches,见 searchTextCond)
  searchTextCond(where, params, filter.q, filter.qOr, 'fts_batches');
  // 排除词:每个词一条 NOT LIKE(与 Mongo 的 $not alternation 同语义,
  // 命中任一排除词即排除;词已在 controller 层按空白拆好)
  for (const w of filter.excludeQ ?? []) {
    where.push('search_text NOT LIKE ? ESCAPE \'\\\'');
    params.push(likePattern(w));
  }
  // filename:相关子查询——存在任意一张图 filename 匹配;
  // EXISTS 对每行做短路判定,优于把图表拉进来 JOIN(避免行数膨胀)
  if (filter.filename) {
    where.push(
      `EXISTS (SELECT 1 FROM batch_images bi WHERE bi.batch_key = batches.batch_key
               AND bi.filename LIKE ? ESCAPE '\\')`,
    );
    params.push(likePattern(filter.filename));
  }
  // base_model 家族匹配:归一化列子串(小写/连字符转下划线/剥 .safetensors)
  if (filter.baseModel) {
    baseModelFilter(where, params, filter.baseModel);
  }
  // 多值 LoRA 正向/排除(与/或组合,语义见 loraNamesCond)
  loraNamesCond(where, params, filter, 'batches', 'batch_key');
  // 时间区间:captured_at 为 UTC ISO 文本列,字符串比较即时间序比较;
  // 纯日期由 normalizeDateBound 补 UTC 边界(等价 created_date 天粒度语义)
  if (filter.fromDate) {
    where.push('captured_at >= ?');
    params.push(normalizeDateBound(filter.fromDate, false));
  }
  if (filter.toDate) {
    where.push('captured_at <= ?');
    params.push(normalizeDateBound(filter.toDate, true));
  }

  const whereSql = where.join(' AND ');
  // 总数与页数据分两次执行(COUNT 不取 doc_json,代价小)
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM batches WHERE ${whereSql}`).get(...params) as {
      c: number;
    }
  ).c;
  // 页数据:只回读 doc_json 列,过滤已在 WHERE 完成;
  // LIMIT/OFFSET 为参数化绑定,limit 经 clampLimit 夹紧
  const rows = db
    .prepare(
      `SELECT doc_json FROM batches WHERE ${whereSql}
       ORDER BY captured_at DESC, batch_key DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, clampLimit(page.limit, 50, page.maxLimit), page.skip) as Array<{ doc_json: string }>;

  return { items: parseDocs(rows), total };
}

/**
 * recipe 列表(全文档):has_positive 过滤 + LIKE 搜索 + filename 预览匹配。
 *
 * 与 listBatches 的差异:
 *   - 主表为 recipe_groups(按 recipe_key 去重的聚合批次)
 *   - filename 过滤无法走子表(recipe 不落图子表),改用
 *     json_each 展开 doc_json.images 数组 + json_extract 取 file.filename 匹配
 *   - lora 过滤走 recipe_lora_names 子表
 */
export function listRecipes(
  db: Database.Database,
  filter: BatchListFilter,
  page: Page,
): { items: Array<Record<string, unknown>>; total: number } {
  const where: string[] = ['has_positive = 1'];
  const params: Array<string | number> = [];

  searchTextCond(where, params, filter.q, filter.qOr, 'fts_recipe_groups');
  // 排除词:命中任一即排除(与 listBatches 同语义)
  for (const w of filter.excludeQ ?? []) {
    where.push('search_text NOT LIKE ? ESCAPE \'\\\'');
    params.push(likePattern(w));
  }
  if (filter.filename) {
    // Mongo 在 recipe 文档的 images 预览数组上做 $regex filename 匹配
    // json_each 把 doc_json.$.images 数组展开成行,json_extract 逐行取
    // file.filename;EXISTS 短路:命中任一预览图即满足
    where.push(
      `EXISTS (SELECT 1 FROM json_each(recipe_groups.doc_json, '$.images') je
               WHERE json_extract(je.value, '$.file.filename') LIKE ? ESCAPE '\\')`,
    );
    params.push(likePattern(filter.filename));
  }
  if (filter.baseModel) {
    baseModelFilter(where, params, filter.baseModel);
  }
  // 多值 LoRA 正向/排除(与/或组合,与 listBatches 同语义)
  loraNamesCond(where, params, filter, 'recipe_groups', 'recipe_key');
  // 时间区间:captured_at 为 UTC ISO 文本列,字符串比较即时间序比较
  if (filter.fromDate) {
    where.push('captured_at >= ?');
    params.push(normalizeDateBound(filter.fromDate, false));
  }
  if (filter.toDate) {
    where.push('captured_at <= ?');
    params.push(normalizeDateBound(filter.toDate, true));
  }

  // 无过滤条件时 whereSql 为空串,拼接需小心:SELECT ... FROM recipe_groups WHERE
  // 会语法错误,故条件集为空时生成 ''(不拼 WHERE);batches 恒有
  // has_positive=1 条件故无此问题
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM recipe_groups ${whereSql}`)
      .get(...params) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT doc_json FROM recipe_groups ${whereSql}
       ORDER BY captured_at DESC, recipe_key DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, clampLimit(page.limit, 50, page.maxLimit), page.skip) as Array<{ doc_json: string }>;

  return { items: parseDocs(rows), total };
}

/**
 * 详情批量读:batch_key IN → doc_json 原样。
 *
 * @param db 目标连接
 * @param batchKeys 批次主键列表
 * @returns 文档数组(顺序与查询返回一致,不保证与入参顺序相同)
 */
export function batchDetails(
  db: Database.Database,
  batchKeys: string[],
): Array<Record<string, unknown>> {
  // 空列表返回空数组,避免生成 `IN ()` 非法 SQL
  if (batchKeys.length === 0) return [];
  const placeholders = batchKeys.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT doc_json FROM batches WHERE batch_key IN (${placeholders})`)
    .all(...batchKeys) as Array<{ doc_json: string }>;
  return parseDocs(rows);
}

/**
 * sha256 → 包含该文件的批次文档(Mongo findOne 等价)。
 *
 * @param db 目标连接
 * @param sha256 文件哈希
 * @returns 首个包含该文件的批次全档;未命中返回 null
 *
 * 路径:batch_images 子表按 sha256 命中后 JOIN 回 batches 取 doc_json;
 * 同哈希多批次时 LIMIT 1 取其一。
 */
export function batchBySha256(
  db: Database.Database,
  sha256: string,
): Record<string, unknown> | null {
  const row = db
    .prepare(
      `SELECT b.doc_json FROM batch_images bi
       JOIN batches b ON b.batch_key = bi.batch_key
       WHERE bi.sha256 = ? LIMIT 1`,
    )
    .get(sha256) as { doc_json: string } | undefined;
  return row ? (JSON.parse(row.doc_json) as Record<string, unknown>) : null;
}

/**
 * image-refs:按图片文件元数据搜索并直接返回文件级引用项。
 *
 * 匹配字段:filename / image_name / sha256 / resolved_path / windows_path /
 * source_path。路径分隔符统一成 `/`,因此 Windows 路径也可用 `/` 搜索。
 * 这里不能复用 batches.search_text:后者是 prompt 文本,且命中批次后展开
 * 全部图片会把未命中的同批图片错误带进结果。
 *
 * @param db 目标连接
 * @param q 文件名、路径或 SHA 子串
 * @param limit 候选条数上限(经 clampLimit 夹紧)
 * @returns 已展开的文件级引用项;排序/判重由控制器统一完成
 */
export function imageRefs(
  db: Database.Database,
  q: string,
  limit: number,
): Array<Record<string, unknown>> {
  const normalizedQuery = q.trim().toLowerCase().replace(/\\/g, '/');
  if (!normalizedQuery) return [];
  const pattern = likePattern(normalizedQuery);
  const searchableFields = [
    'bi.filename',
    'bi.image_name',
    'bi.sha256',
    "json_extract(bi.image_json, '$.file.resolved_path')",
    "json_extract(bi.image_json, '$.file.windows_path')",
    "json_extract(bi.image_json, '$.file.source_path')",
  ];
  const matchSql = searchableFields
    .map(
      (field) =>
        `LOWER(REPLACE(COALESCE(${field}, ''), CHAR(92), '/')) LIKE ? ESCAPE '\\'`,
    )
    .join(' OR ');
  const rows = db
    .prepare(
      `SELECT bi.image_json, bi.resolved_path AS storage_key,
              b.batch_key, b.created_date, b.captured_at, b.base_model,
              (SELECT json_group_array(bl.name)
                 FROM batch_lora_names bl
                WHERE bl.batch_key = b.batch_key) AS loras_json
         FROM batch_images bi
         JOIN batches b ON b.batch_key = bi.batch_key
        WHERE b.has_positive = 1 AND (${matchSql})
        ORDER BY b.captured_at DESC, b.batch_key DESC
        LIMIT ?`,
    )
    .all(...searchableFields.map(() => pattern), clampLimit(limit)) as Array<{
    image_json: string;
    storage_key: string;
    batch_key: string;
    created_date: string | null;
    captured_at: string | null;
    base_model: string | null;
    loras_json: string | null;
  }>;
  return rows.map((row) => {
    const image = JSON.parse(row.image_json) as {
      file?: Record<string, unknown>;
    };
    return {
      ...(image.file ?? {}),
      batch_key: row.batch_key,
      storage_key: row.storage_key,
      created_date: row.created_date,
      captured_at: row.captured_at,
      base_model: row.base_model,
      loras: row.loras_json ? (JSON.parse(row.loras_json) as string[]) : [],
    };
  });
}

/**
 * options:distinct base_model / loras(batch 级,has_positive=1)。
 *
 * @param db 目标连接
 * @returns { baseModels, loras } 两组去重后升序列表(不含 null/空串)
 *
 * 语义:前端筛选下拉的候选值;base_model 走物化列 DISTINCT,
 * lora 走子表 DISTINCT + JOIN 回批次过滤 has_positive。
 */
export function listOptions(db: Database.Database): {
  baseModels: string[];
  loras: string[];
} {
  const baseRows = db
    .prepare(
      `SELECT DISTINCT base_model FROM batches
       WHERE has_positive = 1 AND base_model IS NOT NULL AND base_model != ''
       ORDER BY base_model`,
    )
    .all() as Array<{ base_model: string }>;
  const loraRows = db
    .prepare(
      `SELECT DISTINCT bl.name FROM batch_lora_names bl
       JOIN batches b ON b.batch_key = bl.batch_key
       WHERE b.has_positive = 1 AND bl.name IS NOT NULL AND bl.name != ''
       ORDER BY bl.name`,
    )
    .all() as Array<{ name: string }>;
  return {
    baseModels: baseRows.map((r) => r.base_model),
    loras: loraRows.map((r) => r.name),
  };
}

// ---------------------------------------------------------------------------
// stats 控制器
// ---------------------------------------------------------------------------

/**
 * stats_docs 分析过滤条件:
 *   - q:search_text 子串
 *   - filename / baseModel / fromDate / toDate / lora:物化列或子表过滤
 */
export interface StatsDocsFilter {
  q?: string;
  filename?: string;
  baseModel?: string;
  lora?: string;
  fromDate?: string;
  toDate?: string;
}

/**
 * stats_docs 分析查询(实时计算路径),返回完整 doc_json 文档。
 *
 * @param db 目标连接
 * @param filter 过滤条件
 * @returns 满足条件的所有 stats 文档(无分页——分析引擎在内存聚合)
 *
 * 语义要点:
 *   - 恒有 has_parsed_workflow = 1(只分析解析成功的数据)
 *   - lora 走 stats_doc_lora_names 子表 EXISTS
 *   - 返回全量文档供统计页实时聚合(小数据量场景,避免物化缓存过期)
 */
export function statsDocsForAnalysis(
  db: Database.Database,
  filter: StatsDocsFilter,
): Array<Record<string, unknown>> {
  const where: string[] = ['has_parsed_workflow = 1'];
  const params: Array<string | number> = [];

  if (filter.baseModel) {
    baseModelFilter(where, params, filter.baseModel);
  }
  if (filter.lora) {
    where.push(
      `EXISTS (SELECT 1 FROM stats_doc_lora_names sl
               WHERE sl.resolved_path = stats_docs.resolved_path AND sl.name = ?)`,
    );
    params.push(filter.lora);
  }
  // stats_docs 的 captured_at 当前恒为 NULL,日期筛选继续使用 created_date
  if (filter.fromDate) {
    where.push('created_date >= ?');
    params.push(filter.fromDate);
  }
  if (filter.toDate) {
    where.push('created_date <= ?');
    params.push(filter.toDate);
  }
  if (filter.filename) {
    where.push('filename LIKE ? ESCAPE \'\\\'');
    params.push(likePattern(filter.filename));
  }
  if (filter.q) {
    where.push('search_text LIKE ? ESCAPE \'\\\'');
    params.push(likePattern(filter.q));
  }

  const rows = db
    .prepare(`SELECT doc_json FROM stats_docs WHERE ${where.join(' AND ')}`)
    .all(...params) as Array<{ doc_json: string }>;
  return parseDocs(rows);
}

/**
 * stats_summaries 缓存读(kind + focus_lora)。
 *
 * @param db 目标连接
 * @param kind 统计种类(如总览/画像)
 * @param focusLora 聚焦 lora,空串时只按 kind 查询
 * @returns 缓存文档;未命中返回 null
 *
 * 语义:分析页优先读缓存汇总,回退实时计算(见 statsDocsForAnalysis)。
 */
export function statsSummary(
  db: Database.Database,
  kind: string,
  focusLora = '',
): Record<string, unknown> | null {
  // focusLora 有值走复合主键查询,无值只按 kind 查(可能命中多条,取第一条)
  const row = focusLora
    ? (db
        .prepare(
          'SELECT doc_json FROM stats_summaries WHERE kind = ? AND focus_lora = ?',
        )
        .get(kind, focusLora) as { doc_json: string } | undefined)
    : (db
        .prepare('SELECT doc_json FROM stats_summaries WHERE kind = ?')
        .get(kind) as { doc_json: string } | undefined);
  return row ? (JSON.parse(row.doc_json) as Record<string, unknown>) : null;
}

/**
 * overview:总数 + base_model/lora top10 + 日期/sampler 统计。
 *
 * @param db 目标连接
 * @returns {
 *   totalImages: 有正向 prompt 的批次总数,
 *   baseModels / loras: 出现次数 top10(label, count),
 *   dateBounds: { first_date, last_date, avg_steps, avg_cfg }(空统计键不出现)
 * }
 *
 * 数据来源:batches 主表聚合(COUNT / GROUP BY)与 doc_json 内嵌
 * samplers[0] 的 AVG(JSON1 函数 json_extract)。
 */
export function statsOverview(db: Database.Database): {
  totalImages: number;
  baseModels: Array<{ label: string; count: number }>;
  loras: Array<{ label: string; count: number }>;
  dateBounds: Record<string, unknown>;
} {
  const totalImages = (
    db.prepare('SELECT COUNT(*) AS c FROM batches WHERE has_positive = 1').get() as {
      c: number;
    }
  ).c;

  // base_model top10:GROUP BY 物化列 + COUNT 降序
  const baseModels = (
    db
      .prepare(
        `SELECT base_model AS label, COUNT(*) AS count FROM batches
         WHERE has_positive = 1 AND base_model IS NOT NULL AND base_model != ''
         GROUP BY base_model ORDER BY count DESC LIMIT 10`,
      )
      .all() as Array<{ label: string; count: number }>
  ).map((r) => ({ label: r.label, count: r.count }));

  // lora top10:JOIN 子表后 GROUP BY lora 名(同一 lora 可属多批)
  const loras = (
    db
      .prepare(
        `SELECT bl.name AS label, COUNT(*) AS count FROM batch_lora_names bl
         JOIN batches b ON b.batch_key = bl.batch_key
         WHERE b.has_positive = 1 AND bl.name IS NOT NULL AND bl.name != ''
         GROUP BY bl.name ORDER BY count DESC LIMIT 10`,
      )
      .all() as Array<{ label: string; count: number }>
  ).map((r) => ({ label: r.label, count: r.count }));

  // 日期边界 + 平均采样参数:MIN/MAX 物化列 + AVG json_extract 内嵌字段
  const bounds = db
    .prepare(
      `SELECT MIN(created_date) AS first_date, MAX(created_date) AS last_date,
              AVG(json_extract(doc_json, '$.samplers[0].steps')) AS avg_steps,
              AVG(json_extract(doc_json, '$.samplers[0].cfg')) AS avg_cfg
       FROM batches WHERE has_positive = 1`,
    )
    .get() as { first_date: string | null; last_date: string | null; avg_steps: number | null; avg_cfg: number | null };
  const dateBounds: Record<string, unknown> = {
    first_date: bounds.first_date ?? undefined,
    last_date: bounds.last_date ?? undefined,
    avg_steps: bounds.avg_steps ?? undefined,
    avg_cfg: bounds.avg_cfg ?? undefined,
  };
  // 与 Mongo 输出对齐:空统计键不出现
  // (如数据为空时 Mongo 侧根本没有这些字段,这里删除 undefined 键对齐)
  for (const k of ['first_date', 'last_date', 'avg_steps', 'avg_cfg']) {
    if (dateBounds[k] === undefined) delete dateBounds[k];
  }

  return { totalImages, baseModels, loras, dateBounds };
}

/**
 * heatmap:按 created_date/created_hour 分组(物化列 + doc_json 兜底)。
 *
 * @param db 目标连接
 * @returns 按日期/小时分组的计数数组(日期升序、小时升序)
 *
 * 物化列缺失时(历史数据未投影),COALESCE 回退到 doc_json 内嵌的
 * images[0].created_date / created_hour;WHERE 里同样用 COALESCE 过滤
 * 空值,保证 GROUP BY 的 key 非空。注意 WHERE 中不能引用 SELECT 别名,
 * 因此过滤条件重复书写 COALESCE 表达式。
 */
export function statsHeatmap(
  db: Database.Database,
): Array<{ heatmap_date: string; heatmap_hour: number; count: number }> {
  return db
    .prepare(
      `SELECT COALESCE(created_date, json_extract(doc_json, '$.images[0].created_date')) AS heatmap_date,
              COALESCE(created_hour, json_extract(doc_json, '$.images[0].created_hour')) AS heatmap_hour,
              COUNT(*) AS count
       FROM batches
       WHERE has_positive = 1
         AND COALESCE(created_date, json_extract(doc_json, '$.images[0].created_date')) IS NOT NULL
         AND COALESCE(created_date, json_extract(doc_json, '$.images[0].created_date')) != ''
         AND COALESCE(created_hour, json_extract(doc_json, '$.images[0].created_hour')) IS NOT NULL
       GROUP BY heatmap_date, heatmap_hour
       ORDER BY heatmap_date ASC, heatmap_hour ASC`,
    )
    .all() as Array<{ heatmap_date: string; heatmap_hour: number; count: number }>;
}

// ---------------------------------------------------------------------------
// generate 控制器
// ---------------------------------------------------------------------------

/**
 * distinct base_model(stats_docs, has_parsed_workflow)。
 *
 * generate 页模型下拉的候选值:只统计解析成功的文档,
 * 排除 null 与空串(空串无法作为合法模型名)。
 */
export function distinctStatsBaseModels(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT base_model FROM stats_docs
         WHERE has_parsed_workflow = 1 AND base_model IS NOT NULL AND base_model != ''
         ORDER BY base_model`,
      )
      .all() as Array<{ base_model: string }>
  ).map((r) => r.base_model);
}

/**
 * distinct loras(stats_doc_lora_names 子表)。
 *
 * generate 页 lora 下拉候选:JOIN stats_docs 过滤解析成功,
 * 再对子表名去重升序。
 */
export function distinctStatsLoras(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT sl.name FROM stats_doc_lora_names sl
         JOIN stats_docs s ON s.resolved_path = sl.resolved_path
         WHERE s.has_parsed_workflow = 1 AND sl.name IS NOT NULL AND sl.name != ''
         ORDER BY sl.name`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

// ---------------------------------------------------------------------------
// orchestration self-heal
// ---------------------------------------------------------------------------

/**
 * recipe_groups 覆盖率统计(批次的 distinct recipe_key 数 vs recipe_groups 行数)。
 *
 * @param db 目标连接
 * @returns {
 *   imagesWithKey: batches 中有非空 recipe_key 的 distinct 数,
 *   recipeGroups: recipe_groups 表行数
 * }
 *
 * 用途:orchestration self-heal 判定"recipe 聚合是否掉队"——
 * 两数差距过大说明需要重建 recipe_groups。
 */
export function recipeCoverage(db: Database.Database): {
  imagesWithKey: number;
  recipeGroups: number;
} {
  const imagesWithKey = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT recipe_key) AS c FROM batches
         WHERE recipe_key IS NOT NULL AND recipe_key != ''`,
      )
      .get() as { c: number }
  ).c;
  const recipeGroups = (
    db.prepare('SELECT COUNT(*) AS c FROM recipe_groups').get() as { c: number }
  ).c;
  return { imagesWithKey, recipeGroups };
}

// ---------------------------------------------------------------------------
// labels 控制器
// ---------------------------------------------------------------------------

/**
 * manual-labels 列表(category 精确 / loras、search_text 子串 / created_at 区间)。
 *
 * @param db 目标连接
 * @param opts { category?: 分类精确匹配, lora?: loras JSON 子串,
 *               q?: doc_json.search_text 子串, from?: created_at 起始边界,
 *               to?: created_at 结束边界, limit: 条数上限 }
 * @returns 标签文档数组(按 updated_at 降序,其次 created_at 降序),
 *          每项补 id 字段 = SQLite 主键(前端编辑/删除定位用)
 *
 * 注意 loras 是 JSON 文本列,LIKE 子串在 JSON 字符串上做——语义为
 * "任意 lora 名包含该子串"(与 Mongo 的 $in 数组语义有差异,灰度对比期已知)。
 */
export function listLabels(
  db: Database.Database,
  opts: { category?: string; lora?: string; q?: string; from?: string; to?: string; limit: number },
): Array<Record<string, unknown>> {
  const where: string[] = [];
  const params: Array<string> = [];
  if (opts.category) {
    where.push('category = ?');
    params.push(opts.category);
  }
  if (opts.lora) {
    where.push('loras LIKE ? ESCAPE \'\\\'');
    params.push(likePattern(opts.lora));
  }
  if (opts.q) {
    where.push("json_extract(doc_json, '$.search_text') LIKE ? ESCAPE '\\'");
    params.push(likePattern(opts.q));
  }
  // 时间区间:created_at 为 UTC ISO 文本,纯日期由 normalizeDateBound 补边界
  if (opts.from) {
    where.push("json_extract(doc_json, '$.created_at') >= ?");
    params.push(normalizeDateBound(opts.from, false));
  }
  if (opts.to) {
    where.push("json_extract(doc_json, '$.created_at') <= ?");
    params.push(normalizeDateBound(opts.to, true));
  }
  // 无过滤条件时同样不拼 WHERE(见 listRecipes 的说明)
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT id, doc_json FROM manual_lora_prompt_labels ${whereSql}
       ORDER BY json_extract(doc_json, '$.updated_at') DESC,
                json_extract(doc_json, '$.created_at') DESC
       LIMIT ?`,
    )
    .all(...params, clampLimit(opts.limit)) as Array<{ id: string; doc_json: string }>;
  return rows.map((r) => {
    const doc = JSON.parse(r.doc_json) as Record<string, unknown>;
    delete doc._id;
    // id 从主键列注入(与 Mongo 路径的 _id→id 映射对齐,前端编辑定位用)
    doc.id = r.id;
    return doc;
  });
}

/**
 * 标注分类全量列表(key 为分类标识,label 为展示名)。
 *
 * @param db 目标连接
 * @returns 分类数组(按写入顺序 rowid,默认分类在前)
 */
export function listLabelCategories(db: Database.Database): Array<Record<string, unknown>> {
  const rows = db
    .prepare('SELECT key, label FROM manual_label_categories ORDER BY rowid')
    .all() as Array<{ key: string; label: string }>;
  return rows.map((r) => ({ key: r.key, label: r.label }));
}

/**
 * 标注分类单条读(存在性判断 / 创建查重用)。
 *
 * @param db 目标连接
 * @param key 分类标识
 * @returns { key, label } 或 null
 */
export function getLabelCategory(db: Database.Database, key: string): Record<string, unknown> | null {
  const row = db
    .prepare('SELECT key, label FROM manual_label_categories WHERE key = ?')
    .get(key) as { key: string; label: string } | undefined;
  return row ? { key: row.key, label: row.label } : null;
}

/**
 * 某分类下的标注条数(删除分类前的占用检查)。
 *
 * @param db 目标连接
 * @param key 分类标识
 * @returns 该分类下 manual_lora_prompt_labels 行数
 */
export function countLabelsByCategory(db: Database.Database, key: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS c FROM manual_lora_prompt_labels WHERE category = ?')
      .get(key) as { c: number }
  ).c;
}

/**
 * prompt-annotations 列表(name 子串)。
 *
 * @param db 目标连接
 * @param name 注解名子串;undefined 时返回全部
 * @param limit 条数上限(经 clampLimit 夹紧)
 * @returns 注解文档数组
 */
export function listAnnotations(
  db: Database.Database,
  name: string | undefined,
  limit: number,
): Array<Record<string, unknown>> {
  // name 缺失时不带 WHERE 直接取全部(两分支避免动态拼 SQL 注入面)
  const rows = name
    ? (db
        .prepare(
          `SELECT doc_json FROM prompt_annotations
           WHERE json_extract(doc_json, '$.name') LIKE ? ESCAPE '\\'
           LIMIT ?`,
        )
        .all(likePattern(name), clampLimit(limit)) as Array<{ doc_json: string }>)
    : (db
        .prepare('SELECT doc_json FROM prompt_annotations LIMIT ?')
        .all(clampLimit(limit)) as Array<{ doc_json: string }>);
  return parseDocs(rows);
}

/**
 * manual-label 单条读(更新返回 after 用)。
 *
 * @param db 目标连接
 * @param id 标签主键
 * @returns 标签全档;不存在返回 null
 */
export function getLabel(db: Database.Database, id: string): Record<string, unknown> | null {
  const row = db
    .prepare('SELECT doc_json FROM manual_lora_prompt_labels WHERE id = ?')
    .get(id) as { doc_json: string } | undefined;
  return row ? (JSON.parse(row.doc_json) as Record<string, unknown>) : null;
}

/**
 * 收藏时间排序值:doc_json 内 created_at/updated_at 为 ISO 字符串,
 * 统一转毫秒时间戳比较(空/非法回退 0,稳定排序)。
 */
function favoriteTimeValue(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(String(value ?? '')).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * favorites 列表(一图多分类:按图聚合返回)。
 *
 * 过滤语义(categories 名单非空时):
 *   - mode 'or':图在任一指定分类下即命中(category IN (...))
 *   - mode 'and':图须同时归属全部分类(GROUP BY sha256
 *     HAVING COUNT(DISTINCT category) = N)
 * 名单为空 = 全部收藏。
 *
 * 排序:图内各分类行 created_at 最大值降序(最近收藏的图在前)。
 * 返回:每图一条 —— 基底快照取该图 updated_at 最新的一行(展示字段/备注
 * 以最新为准),categories 携带该图全部分类(供前端卡片显示多徽章)。
 *
 * @param db 目标连接
 * @param categories 收藏子分类名单(undefined/空 = 全部)
 * @param mode 名单组合方式 'or' | 'and'
 * @param limit 条数上限(钳制后作用于聚合后的图数)
 * @returns 按图聚合的收藏文档数组
 */
export function listFavorites(
  db: Database.Database,
  categories: string[] | undefined,
  mode: 'and' | 'or',
  limit: number,
): Array<Record<string, unknown>> {
  const catList = (categories ?? [])
    .map((c) => String(c).trim())
    .filter(Boolean);
  // 阶段 1:命中图集合(占位符数量由参数决定,无字符串拼接注入面)
  let shas: string[];
  if (catList.length) {
    const placeholders = catList.map(() => '?').join(', ');
    shas =
      mode === 'and'
        ? (
            db
              .prepare(
                `SELECT sha256 FROM favorites
                 WHERE category IN (${placeholders})
                 GROUP BY sha256
                 HAVING COUNT(DISTINCT category) = ?`,
              )
              .all(...catList, catList.length) as Array<{ sha256: string }>
          ).map((r) => r.sha256)
        : (
            db
              .prepare(
                `SELECT DISTINCT sha256 FROM favorites
                 WHERE category IN (${placeholders})`,
              )
              .all(...catList) as Array<{ sha256: string }>
          ).map((r) => r.sha256);
  } else {
    shas = (
      db.prepare('SELECT DISTINCT sha256 FROM favorites').all() as Array<{
        sha256: string;
      }>
    ).map((r) => r.sha256);
  }
  // 阶段 2:逐图取全部分类行,聚合为单条(limit 作用于聚合后的图数)
  const rowStmt = db.prepare(
    'SELECT category, doc_json FROM favorites WHERE sha256 = ?',
  );
  const aggregated: Array<{ latest: number; item: Record<string, unknown> }> = [];
  for (const sha of shas) {
    const rows = rowStmt.all(sha) as Array<{
      category: string;
      doc_json: string;
    }>;
    if (!rows.length) continue;
    const docs = rows.map(
      (row) => JSON.parse(row.doc_json) as Record<string, unknown>,
    );
    // 基底快照取最近更新的一条分类行
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
        categories: rows.map((row) => row.category),
      },
    });
  }
  aggregated.sort((a, b) => b.latest - a.latest);
  return aggregated.slice(0, clampLimit(limit)).map((entry) => entry.item);
}

/**
 * favorites 单条读(更新/删除前存在性判断)。
 *
 * @param db 目标连接
 * @param sha256 收藏定位键之一(图片 sha256)
 * @param category 可选:传值 = (sha256, category) 复合键精确读;
 *                 不传 = 该图任一条(多分类时任一分类存在即命中,取首条)
 * @returns 收藏全档;不存在返回 null
 */
export function getFavorite(
  db: Database.Database,
  sha256: string,
  category?: string,
): Record<string, unknown> | null {
  const row =
    category === undefined
      ? (db
          .prepare('SELECT doc_json FROM favorites WHERE sha256 = ? LIMIT 1')
          .get(sha256) as { doc_json: string } | undefined)
      : (db
          .prepare('SELECT doc_json FROM favorites WHERE sha256 = ? AND category = ?')
          .get(sha256, category) as { doc_json: string } | undefined);
  return row ? (JSON.parse(row.doc_json) as Record<string, unknown>) : null;
}

/**
 * 收藏分类列表(默认分类 + 用户自定义)。
 *
 * @param db 目标连接
 * @returns 分类数组(按写入顺序 rowid,默认分类在前)
 */
export function listFavoriteCategories(db: Database.Database): Array<Record<string, unknown>> {
  const rows = db
    .prepare('SELECT key, label FROM favorite_categories ORDER BY rowid')
    .all() as Array<{ key: string; label: string }>;
  return rows.map((r) => ({ key: r.key, label: r.label }));
}

/**
 * 收藏分类单条读(存在性判断 / 创建查重用)。
 *
 * @param db 目标连接
 * @param key 分类标识
 * @returns { key, label } 或 null
 */
export function getFavoriteCategory(db: Database.Database, key: string): Record<string, unknown> | null {
  const row = db
    .prepare('SELECT key, label FROM favorite_categories WHERE key = ?')
    .get(key) as { key: string; label: string } | undefined;
  return row ? { key: row.key, label: row.label } : null;
}

/**
 * 某分类下的收藏条数(删除分类前的占用检查)。
 *
 * @param db 目标连接
 * @param key 分类标识
 * @returns 该分类下 favorites 行数(按 doc_json.category 匹配)
 */
export function countFavoritesByCategory(db: Database.Database, key: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM favorites
         WHERE json_extract(doc_json, '$.category') = ?`,
      )
      .get(key) as { c: number }
  ).c;
}

// ---------------------------------------------------------------------------
// 跨平台路径辅助(供控制器复用)
// ---------------------------------------------------------------------------

/**
 * 再导出 repo.ts 的路径形式展开工具:控制器在删除/按路径查询前
 * 需要把入参路径展开为双平台形式,统一走此入口。
 */
export { bothPlatformForms };
