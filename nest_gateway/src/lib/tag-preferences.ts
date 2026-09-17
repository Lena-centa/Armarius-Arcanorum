/**
 * 人工偏好信号采集(tag-preferences.ts)。
 *
 * 数据飞轮的反馈半环:`favorites` 记录了用户明确的正面评价(收藏某张图),
 * 但此前没有任何业务逻辑消费它——收藏了也不影响任何推荐/打分。
 * 本模块把"被收藏图片的 positive prompt"采集出来,交给 worker 侧
 * `suggest` 做偏好加权(tag_suggest.preference_boost),让用户的实际
 * 偏好回到推荐结果里。
 *
 * 为什么采集 prompt 文本而不是 tag id:词表(vocab_sorted.npy)与分词器
 * 都在 Python 侧,id 编码属于 worker 内部知识。网关只负责它独有的能力——
 * 查库(把 sha256 映射到批次文档),跨边界传原文,由 worker 统一分词与查表。
 *
 * 为什么只消费 favorites、不消费 prompt_annotations:
 *   favorites 是明确的正面动作(用户主动收藏这张图),语义上就是"喜欢"。
 *   prompt_annotations 存的是"给这段 prompt 起个可读别名"(name/note/lines),
 *   属于描述性标注,不含褒贬立场——把它当正面信号是编造语义。故本模块
 *   只采 favorites;批注的价值在展示降噪,不在打分。
 */

import type { ConfigService } from '@nestjs/config';
import type Database from 'better-sqlite3';
import type { Model } from 'mongoose';

/** 单次采集的收藏样本上限:反映"最近喜欢什么",防历史淹没与查询无界。 */
export const PREFERENCE_SAMPLE_LIMIT = 200;

/**
 * 采集被收藏图片的 positive prompt 文本。
 *
 * @param options.config        配置(决定 SQLite 单引擎 / Mongo 轨道)
 * @param options.sqliteDb      SQLite 库(读模式时提供)
 * @param options.favoritesModel favorites 集合 Model(Mongo 轨道)
 * @param options.imagesModel   images(批次)集合 Model(Mongo 轨道)
 * @param options.limit         样本上限(默认 PREFERENCE_SAMPLE_LIMIT)
 * @returns positive prompt 文本列表(每张收藏图一条,按收藏时间倒序);
 *          无收藏 / 收藏图不在库内时返回空数组
 *
 * 内部逻辑:
 *   1. 取收藏的 sha256(时间倒序 + 限幅;多分类收藏同一图只算一次)
 *   2. 逐个 sha 查所属批次文档,取 prompts.positive
 *   3. positive 为数组时按逗号拼接成一段文本
 * 边界:任一 sha 查不到批次(图已移出库)直接跳过,不产生空信号;
 * 全流程只读;单条查询失败只跳过该条。
 */
export async function collectPreferencePrompts(options: {
  config: ConfigService;
  sqliteDb?: Database.Database | null;
  favoritesModel?: Model<unknown> | null;
  imagesModel?: Model<unknown> | null;
  limit?: number;
}): Promise<string[]> {
  const {
    config,
    sqliteDb = null,
    favoritesModel = null,
    imagesModel = null,
    limit = PREFERENCE_SAMPLE_LIMIT,
  } = options;
  const readMode = config.get<boolean>('sqlite.readMode') ?? false;
  const shas = readMode
    ? favoriteShasSqlite(sqliteDb, limit)
    : await favoriteShasMongo(favoritesModel, limit);
  if (!shas.length) return [];

  const prompts: string[] = [];
  for (const sha of shas) {
    try {
      const doc = readMode
        ? batchDocSqlite(sqliteDb, sha)
        : await batchDocMongo(imagesModel, sha);
      const positive = (doc?.prompts as { positive?: unknown } | undefined)
        ?.positive;
      if (!Array.isArray(positive)) continue;
      const text = positive
        .map((value) => {
          // 真实文档里 positive 元素是 {text} 形态(扫描与归档都按此写库);
          // 兼容历史/异形的纯字符串条目
          if (typeof value === 'string') return value.trim();
          const nested = (value as { text?: unknown } | null)?.text;
          return typeof nested === 'string' ? nested.trim() : '';
        })
        .filter(Boolean)
        .join(', ');
      if (text) prompts.push(text);
    } catch {
      continue; // 单条失败不影响其余样本
    }
  }
  return prompts;
}

/** SQLite 轨道:收藏 sha 列表(去重 + 时间倒序 + 限幅)。 */
function favoriteShasSqlite(
  db: Database.Database | null,
  limit: number,
): string[] {
  if (!db) return [];
  const rows = db
    .prepare(
      `SELECT sha256,
              MAX(COALESCE(json_extract(doc_json, '$.updated_at'),
                           json_extract(doc_json, '$.created_at'), '')) AS ts
         FROM favorites GROUP BY sha256 ORDER BY ts DESC LIMIT ?`,
    )
    .all(limit) as Array<{ sha256: string }>;
  return rows.map((row) => String(row.sha256 ?? '')).filter(Boolean);
}

/** SQLite 轨道:按 sha 取批次文档。 */
function batchDocSqlite(
  db: Database.Database | null,
  sha256: string,
): Record<string, unknown> | null {
  if (!db) return null;
  const row = db
    .prepare(
      `SELECT b.doc_json FROM batch_images bi
         JOIN batches b ON b.batch_key = bi.batch_key
        WHERE bi.sha256 = ? LIMIT 1`,
    )
    .get(sha256) as { doc_json: string } | undefined;
  return row ? (JSON.parse(row.doc_json) as Record<string, unknown>) : null;
}

/** Mongo 轨道:收藏 sha 列表(按 updated_at 倒序去重)。 */
async function favoriteShasMongo(
  model: Model<unknown> | null,
  limit: number,
): Promise<string[]> {
  if (!model) return [];
  const docs = (await model.collection
    .aggregate([
      { $sort: { updated_at: -1, created_at: -1 } },
      { $group: { _id: '$sha256' } },
      { $limit: limit },
    ])
    .toArray()) as Array<{ _id?: unknown }>;
  return docs.map((doc) => String(doc._id ?? '')).filter(Boolean);
}

/** Mongo 轨道:按 sha 取批次文档(images 集合,位置投影只取命中子文档)。 */
async function batchDocMongo(
  model: Model<unknown> | null,
  sha256: string,
): Promise<Record<string, unknown> | null> {
  if (!model) return null;
  const doc = (await model.collection.findOne(
    { 'images.file.sha256': sha256 },
    { projection: { _id: 0, prompts: 1, batch_key: 1 } },
  )) as Record<string, unknown> | null;
  return doc ?? null;
}
