/**
 * sqlite/repo.ts — 写路径 SQL 数据访问层(主用化核心)。
 *
 * 语义与 lib/ingest.ts / lib/archive.ts 的 Mongo bulkWrite 对齐:
 *   - upsertBatchAndChildren:整批覆盖重写(batches 物化列 + doc_json + 子表 + stats_doc)
 *   - removeResolvedPaths:按 resolved_path 摘除元素 + 删 stats_doc(空批由调用方清理)
 *   - deleteEmptyBatches:清空无元素批次(FK CASCADE 连带子表)
 *   - buildScanIndex:loadExistingIndex 等价索引(byPath / byFingerprint / storedFormsByNorm)
 *
 * 双写过渡期由 ingest/archive 在 dualWrite 开关下调用;阶段 5 后为唯一写路径。
 *
 * 数据流向:
 *   ingest/archive(parse 产物)→ 本文件写原语 → SQLite 表
 *   (batches / batch_images / batch_lora_names / stats_docs /
 *    stats_doc_lora_names / fts_batches / fts_stats_docs 等)
 *   所有写操作均经 withTransaction 包裹,保证"主表 + 子表 + FTS"最终态一致;
 *   读路径(reader.ts)与回填/对比脚本(sqlite-backfill.ts)直接消费这些表。
 */

import type Database from 'better-sqlite3';
import { imageLocationKey } from '../lib/image_location';
import { normalizePathForPlatform } from '../lib/paths';
import { withTransaction } from './db';

// ---------------------------------------------------------------------------
// 类型(与 ingest.ts 的 ExistingIndex 同构)
// ---------------------------------------------------------------------------

/**
 * 扫描索引单条目,对应一条 batch_images 行。
 *
 * 字段语义:
 *   - batchKey:所属批次主键(→ batches.batch_key)
 *   - recipeKey:批次归属 recipe 主键
 *   - sizeBytes / mtimeNs:文件指纹要素(大小 + 修改时间)。
 *     扫描时用于识别"同路径但内容已变"的文件——仅路径相同而
 *     指纹不同视为新文件,与 Mongo 侧 size+mtime 判重语义一致
 *   - storedPath:入库时的 resolved_path 原样值(未归一化)
 */
export interface ScanIndexEntry {
  batchKey: string;
  recipeKey: string;
  sizeBytes?: number;
  mtimeNs?: number;
  storedPath: string;
}

/**
 * 扫描索引(loadExistingIndex 的内存等价物,供 ingest 去重判定):
 *
 *   - byPath:路径(含跨平台归一形式)→ 条目。扫描某文件时先查
 *     byPath 判断"该路径是否已入库"
 *   - byFingerprint:sizeBytes → 条目列表。同大小候选,配合 mtime 做指纹级查重
 *   - storedFormsByNorm:归一化路径 → { 各存储形式 → recipeKey }。
 *     同一文件在库内可能有多种路径写法(WSL / Windows 盘符形式),
 *     按归一化路径聚合后,删除时能一次摘除所有等价形式
 */
export interface ScanIndex {
  byPath: Map<string, ScanIndexEntry>;
  byFingerprint: Map<number, ScanIndexEntry[]>;
  storedFormsByNorm: Map<string, Map<string, string>>;
}

/**
 * 一条批次写记录(ingest 解析产出的最终形态,含子元素)。
 *
 * 字段语义(unknown = 原样透传,写入时按需物化或进 doc_json):
 *   - batchKey / recipeKey:主键与归属
 *   - capturedAt / createdDate / createdHour / createdWeekday:时间维度,物化为列
 *     (created_date 等是列表页过滤/排序的检索列)
 *   - model / loras / prompts / samplers / latent:解析出的结构体,
 *     序列化进 doc_json,其中 prompts.search_text、model.base_model 同时物化为列
 *   - batchCount:批内图片数(物化为列)
 *   - images:子元素数组(每项含 file、captured_at 等),展开写 batch_images 子表
 *   - loraNames:去重排序后的 lora 名,写 batch_lora_names 子表
 *   - docJson:整档 JSON(reader 的详情/分析查询原样返回,不重新组档)
 */
export interface BatchWrite {
  batchKey: string;
  capturedAt: unknown;
  createdDate: unknown;
  createdHour: unknown;
  createdWeekday: unknown;
  recipeKey: string;
  model: unknown;
  loras: unknown;
  prompts: unknown;
  samplers: unknown;
  latent: unknown;
  batchCount: number;
  images: Array<Record<string, unknown>>;
  loraNames: string[];
  docJson: string;
}

/**
 * stats_doc 写记录(buildStatsCacheDocument 产物)。
 *
 * 字段语义:
 *   - resolvedPath:主键,唯一标识一条文件维度统计(对应原路径)
 *   - filename / imageName / createdDate / capturedAt:物化列,供过滤/排序
 *   - hasParsedWorkflow:workflow 解析是否成功,统计页的分析过滤条件
 *   - baseModel / searchText:物化列,支撑等值/LIKE 检索,避免全扫 doc_json
 *   - loraNames:写 stats_doc_lora_names 子表(EXISTS 筛选用)
 *   - docJson:整档 JSON(分析接口原样返回)
 */
export interface StatsDocWrite {
  resolvedPath: string;
  filename: unknown;
  imageName: unknown;
  createdDate: unknown;
  hasParsedWorkflow: boolean;
  baseModel: unknown;
  searchText: unknown;
  capturedAt: unknown;
  loraNames: string[];
  docJson: string;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * LIKE 模式转义(% _ \)。
 *
 * SQL 侧统一使用 `ESCAPE '\'` 子句,此处把用户/路径输入里的
 * `%` `_` `\` 转义为 `\%` `\_` `\\`,防止通配符注入——
 * 例如路径含 `%` 时,不转义会匹配到大量无关行。
 */
function likeEscape(p: string): string {
  return p.replace(/[\\%_]/g, (m) => `\\${m}`);
}

// ---------------------------------------------------------------------------
// labels 写入
// ---------------------------------------------------------------------------

/**
 * manual-label upsert(_id 字符串化主键,doc_json 整档)。
 *
 * @param db 目标连接
 * @param id 标签主键(_id 字符串形式)
 * @param doc 完整标签文档(类别/loras/name 同时物化为列,供列表页过滤)
 *
 * 语义:
 *   - INSERT OR REPLACE 按主键 id 覆盖;REPLACE 删除旧行重建,
 *     因此 doc_json 与物化列永远来自同一份 doc
 *   - category/name 空值回退 null;loras 数组序列化 JSON 文本
 *     (列表页对 loras 做 LIKE 子串匹配,见 reader.listLabels)
 *   - 事务内执行:REPLACE + 物化列投影原子完成
 */
export function upsertLabel(
  db: Database.Database,
  id: string,
  doc: Record<string, unknown>,
): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT OR REPLACE INTO manual_lora_prompt_labels(id, category, loras, name, doc_json)
       VALUES (?,?,?,?,?)`,
    ).run(
      id,
      doc.category ? String(doc.category) : null,
      Array.isArray(doc.loras)
        ? JSON.stringify(doc.loras)
        : (doc.loras ?? null),
      doc.name ? String(doc.name) : null,
      JSON.stringify(doc),
    );
  });
}

/**
 * manual-label 删除。
 *
 * @param db 目标连接
 * @param id 标签主键
 * @returns 实际删除的行数(0 = id 不存在,幂等)
 */
export function deleteLabel(db: Database.Database, id: string): number {
  return withTransaction(db, () => {
    const result = db
      .prepare('DELETE FROM manual_lora_prompt_labels WHERE id = ?')
      .run(id);
    // better-sqlite3 run() 的 changes 为受影响行数
    return result.changes;
  });
}

/**
 * 标注分类 upsert(INSERT OR REPLACE 按 key 覆盖)。
 *
 * @param db 目标连接
 * @param key 分类标识(主键)
 * @param doc 完整分类文档(key/label,可含 created_at 等元数据)
 *
 * 语义:REPLACE 删除旧行重建,doc_json 与物化 label 列永远来自同一份 doc;
 * label 空值回退为 key(防止展示空名)。
 */
export function upsertLabelCategory(
  db: Database.Database,
  key: string,
  doc: Record<string, unknown>,
): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT OR REPLACE INTO manual_label_categories(key, label, doc_json)
       VALUES (?,?,?)`,
    ).run(key, doc.label ? String(doc.label) : key, JSON.stringify(doc));
  });
}

/**
 * 标注分类删除。
 *
 * @param db 目标连接
 * @param key 分类标识
 * @returns 实际删除的行数(0 = key 不存在,幂等)
 */
export function deleteLabelCategory(
  db: Database.Database,
  key: string,
): number {
  return withTransaction(db, () => {
    const result = db
      .prepare('DELETE FROM manual_label_categories WHERE key = ?')
      .run(key);
    return result.changes;
  });
}

/**
 * prompt-annotation upsert(按 signature 幂等,签名不存在时插入)。
 *
 * @param db 目标连接
 * @param signature 注解签名(= prompt_annotations.id 主键)
 * @param doc 完整注解文档
 *
 * 语义:ON CONFLICT(id) DO UPDATE——已有签名只更新 doc_json,
 * 不删除重建(与 INSERT OR REPLACE 的区别:保留行内其他可能字段,
 * 也避免主键重建带来的关联副作用)。
 */
export function upsertAnnotation(
  db: Database.Database,
  signature: string,
  doc: Record<string, unknown>,
): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO prompt_annotations(id, doc_json) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET doc_json = excluded.doc_json`,
    ).run(signature, JSON.stringify(doc));
  });
}

/**
 * favorite upsert((sha256, category) 复合键幂等,已存在时覆盖 doc_json)。
 *
 * 同一张图在同一分类下重复收藏视为更新快照
 * (filename / batch_key / note 变更后同步),不会产生重复行;
 * 不同分类各自独立成行(一图多分类)。
 *
 * @param db 目标连接
 * @param sha256 收藏定位键之一(图片 sha256)
 * @param category 收藏子分类(空串 = 未分类,参与复合键)
 * @param doc 完整收藏文档(快照 + 时间戳)
 */
export function upsertFavorite(
  db: Database.Database,
  sha256: string,
  category: string,
  doc: Record<string, unknown>,
): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO favorites(sha256, category, doc_json) VALUES (?, ?, ?)
       ON CONFLICT(sha256, category) DO UPDATE SET doc_json = excluded.doc_json`,
    ).run(sha256, category, JSON.stringify(doc));
  });
}

/**
 * favorite 删除(两语义)。
 *
 * @param db 目标连接
 * @param sha256 收藏定位键之一(图片 sha256)
 * @param category 可选:传值 = 仅删该分类一条(复合键精确匹配);
 *                 不传 = 删该图全部分类(取消收藏)
 * @returns 实际删除的行数(0 = 无匹配,幂等)
 */
export function deleteFavorite(
  db: Database.Database,
  sha256: string,
  category?: string,
): number {
  return withTransaction(db, () => {
    const result =
      category === undefined
        ? db.prepare('DELETE FROM favorites WHERE sha256 = ?').run(sha256)
        : db
            .prepare('DELETE FROM favorites WHERE sha256 = ? AND category = ?')
            .run(sha256, category);
    // better-sqlite3 run() 的 changes 为受影响行数
    return result.changes;
  });
}

/**
 * 收藏分类 upsert(INSERT OR REPLACE 按 key 覆盖)。
 *
 * @param db 目标连接
 * @param key 分类标识(主键)
 * @param doc 完整分类文档(key/label,可含 created_at 等元数据)
 *
 * 语义:REPLACE 删除旧行重建,doc_json 与物化 label 列永远来自同一份 doc;
 * label 空值回退为 key(防止展示空名)。
 */
export function upsertFavoriteCategory(
  db: Database.Database,
  key: string,
  doc: Record<string, unknown>,
): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT OR REPLACE INTO favorite_categories(key, label, doc_json)
       VALUES (?,?,?)`,
    ).run(key, doc.label ? String(doc.label) : key, JSON.stringify(doc));
  });
}

/**
 * 收藏分类删除。
 *
 * @param db 目标连接
 * @param key 分类标识
 * @returns 实际删除的行数(0 = key 不存在,幂等)
 */
export function deleteFavoriteCategory(
  db: Database.Database,
  key: string,
): number {
  return withTransaction(db, () => {
    const result = db
      .prepare('DELETE FROM favorite_categories WHERE key = ?')
      .run(key);
    return result.changes;
  });
}

/**
 * 路径的双平台形式集合(自身 + 跨平台形式),与宿主平台无关。
 *
 * 输入 Windows 盘符形式(D:\a\b)输出 {D:\a\b, /mnt/d/a/b};
 * 输入 WSL 形式(/mnt/d/a/b)输出 {/mnt/d/a/b, D:\a\b};
 * 其他形式原样返回。
 *
 * 用途:同一条入库路径在双平台下书写不同,删除/查询时展开所有
 * 等价形式,保证跨平台一致性(见 removeResolvedPaths / readBatchByPath)。
 *
 * @param p 原始路径
 * @returns 去重后的形式集合(最多 2 项)
 */
export function bothPlatformForms(p: string): string[] {
  const out = [p];
  // WSL 形式 /mnt/<盘符>/<余下> → Windows 盘符形式 <盘符>:\<余下>
  const mnt = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p);
  if (mnt) {
    out.push(`${mnt[1].toUpperCase()}:\\${mnt[2].replace(/\//g, '\\')}`);
  }
  // Windows 盘符形式 <盘符>:[/\]<余下> → WSL 形式 /mnt/<盘符>/<余下>
  const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
  if (drive) {
    out.push(`/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`);
  }
  // 两种转换各自只会在对应形式时命中,去重保险(如 p 本身两端都匹配)
  return [...new Set(out)];
}

/**
 * 物化标量:undefined/null → null,字符串原样,其余 JSON 序列化。
 * 用于 base_model 等"可能是嵌套对象"的字段,保证列值可比较、可排序。
 */
function scalar(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * batch_images 的 SQLite 物化主键。本地图片沿用 resolved_path;
 * 独立远端图片库无本地路径时,用 source + asset_id/sha256 生成
 * 仅存储层可见的逻辑键。image_json 仍保留原始 entry,不伪造 file 路径。
 */
function imageStorageKey(
  image: Record<string, unknown>,
  index: number,
): string {
  return imageLocationKey(image) ?? `remote://unknown/${index}`;
}

/**
 * 时间戳物化:undefined/null → null;Date → ISO 字符串;
 * 字符串/数字原样转字符串;其余 JSON 序列化。
 * 统一时间列的存储格式(ISO 8601 文本),使字符串比较与排序等价时间序。
 */
function iso(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// 写原语
// ---------------------------------------------------------------------------

/**
 * 整批覆盖重写(事务内):
 *   1. 清批次子表(batch_images / batch_lora_names / fts 旧行)
 *   2. INSERT OR REPLACE batches(物化列 + doc_json)
 *   3. 重插子表 + stats_docs(含 stats_doc_lora_names)
 *
 * 与 Mongo 的 $pull(旧元素)+ $set/$push(新元素)最终态等价,
 * SQLite 侧以"最终态覆盖"实现,天然满足批内唯一性。
 *
 * @param db 目标连接
 * @param batch 批次完整写记录(含全部子元素)
 * @param statsDoc 关联的 stats_doc 写记录;null 表示本批不产出 stats
 *
 * 调用场景:ingest/archive 单条 upsert(dualWrite 或主写路径)。
 * 为什么"先删子表再整批插入"而不是逐行 upsert:
 *   批内图片集合可能收缩(删除或更换路径),逐行 upsert 无法清除
 *   已不在新集合中的旧行;整批覆盖使子表 = 本次写入快照。
 */
export function upsertBatchAndChildren(
  db: Database.Database,
  batch: BatchWrite,
  statsDoc: StatsDocWrite | null,
): void {
  withTransaction(db, () => {
    // 读旧行 rowid + search_text:rowid 用于 FTS 行对齐(fts_batches.rowid
    // 必须等于 batches.rowid,读路径按 rowid 回连);旧文本仅作注释参考
    const oldRow = db
      .prepare(
        'SELECT rowid AS rid, search_text FROM batches WHERE batch_key = ?',
      )
      .get(batch.batchKey) as
      | { rid: number; search_text: string | null }
      | undefined;

    // 1. 清空两张子表(无 FK 依赖,先删父行前的子行)
    db.prepare('DELETE FROM batch_images WHERE batch_key = ?').run(
      batch.batchKey,
    );
    db.prepare('DELETE FROM batch_lora_names WHERE batch_key = ?').run(
      batch.batchKey,
    );

    // 2. 物化列投影:model.base_model、prompts.search_text 从嵌套结构取出;
    //    has_positive 由 prompts.positive 数组是否非空推导(与 Mongo 查询等价)
    const baseModel = scalar(
      (batch.model as { base_model?: unknown } | undefined)?.base_model,
    );
    const searchText = scalar(
      (batch.prompts as { search_text?: unknown } | undefined)?.search_text,
    );
    const hasPositive =
      Array.isArray(
        (batch.prompts as { positive?: unknown } | undefined)?.positive,
      ) && (batch.prompts as { positive?: unknown[] }).positive!.length > 0
        ? 1
        : 0;

    // INSERT OR REPLACE:主键 batch_key 冲突时整行替换,
    // 物化列与 doc_json 永远来自同一份 batch,无半新半旧状态。
    // 显式指定 rowid=旧值:REPLACE 默认会给新行分配新 rowid,会让
    // 主表 rowid 漂移、FTS 对齐失效;固定旧 rowid 保证行标识稳定
    db.prepare(
      `INSERT OR REPLACE INTO batches(
        rowid, batch_key, captured_at, created_date, created_hour, created_weekday,
        recipe_key, batch_count, base_model, has_positive, search_text, doc_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      oldRow?.rid ?? null,
      batch.batchKey,
      iso(batch.capturedAt),
      iso(batch.createdDate),
      batch.createdHour ?? null,
      batch.createdWeekday ?? null,
      batch.recipeKey,
      batch.batchCount,
      baseModel,
      hasPositive,
      searchText,
      batch.docJson,
    );
    // 最终 rowid:覆盖场景沿用旧值;新插入取 last_insert_rowid()
    const rid =
      oldRow?.rid ??
      (db.prepare('SELECT last_insert_rowid() AS r').get() as { r: number }).r;

    // 3. FTS 同步:按 rowid 先删后插(旧行文本残留即清除;
    //    rowid 对齐使删除精确到本批次,不影响其他批次)
    db.prepare('DELETE FROM fts_batches WHERE rowid = ?').run(rid);
    // 4. 新 search_text 插入 FTS(非空才插,空文本无检索价值)
    if (searchText) {
      db.prepare(
        'INSERT INTO fts_batches(rowid, search_text) VALUES (?,?)',
      ).run(rid, searchText);
    }

    // 5. 重插 batch_images 子表(每张图一行):
    //    INSERT OR REPLACE 由(batch_key, resolved_path)联合主键去重;
    //    远端条目无 resolved_path 时用 source/asset_id 逻辑键兜底,
    //    其余 file 字段逐项物化,整图 json 进 image_json
    const insertImage = db.prepare(
      `INSERT OR REPLACE INTO batch_images(
        batch_key, resolved_path, source_path, filename, image_name,
        sha256, mtime_ns, size_bytes, captured_at, image_json)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const [index, img] of batch.images.entries()) {
      const file = (img.file as Record<string, unknown> | undefined) ?? {};
      insertImage.run(
        batch.batchKey,
        imageStorageKey(img, index),
        scalar(file.source_path),
        scalar(file.filename),
        scalar(file.image_name),
        scalar(file.sha256),
        file.mtime_ns ?? null,
        file.size_bytes ?? null,
        iso(img.captured_at),
        JSON.stringify(img),
      );
    }

    // 6. 重插 batch_lora_names 子表(lora 过滤 EXISTS 查询的数据源)
    const insertLora = db.prepare(
      'INSERT OR REPLACE INTO batch_lora_names(batch_key, name) VALUES (?,?)',
    );
    for (const name of batch.loraNames) {
      insertLora.run(batch.batchKey, name);
    }

    // 7. 关联 stats_doc 一并写入(同一事务,保证批次↔统计不撕裂)
    if (statsDoc) {
      upsertStatsDoc(db, statsDoc);
    }
  });
}

/**
 * 单条 stats_doc 写入(upsert + lora 子表 + fts)。
 *
 * @param db 目标连接
 * @param statsDoc 文件维度统计写记录(以 resolved_path 为主键)
 *
 * 与 upsertBatchAndChildren 的差异:stats_doc 是文件粒度,不随批覆盖;
 * 这里按 resolved_path 整行 REPLACE,先删子表再重插,语义一致。
 */
export function upsertStatsDoc(
  db: Database.Database,
  statsDoc: StatsDocWrite,
): void {
  withTransaction(db, () => {
    // 旧行 rowid:FTS 行对齐键(fts_stats_docs.rowid = stats_docs.rowid)
    const oldRow = db
      .prepare('SELECT rowid AS rid FROM stats_docs WHERE resolved_path = ?')
      .get(statsDoc.resolvedPath) as { rid: number } | undefined;
    // 先清 lora 子表(保证子表 = 本次写入快照,不含已移除的旧 lora)
    db.prepare('DELETE FROM stats_doc_lora_names WHERE resolved_path = ?').run(
      statsDoc.resolvedPath,
    );
    // 主表 REPLACE:物化列逐个投影;布尔列转 0/1;
    // baseModel/searchText 为假值时落 null(空串不进检索列)。
    // 显式 rowid=旧值,防 REPLACE 分配新 rowid 导致 FTS 对齐失效
    db.prepare(
      `INSERT OR REPLACE INTO stats_docs(
        rowid, resolved_path, filename, image_name, created_date, has_parsed_workflow,
        base_model, search_text, captured_at, doc_json)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      oldRow?.rid ?? null,
      statsDoc.resolvedPath,
      statsDoc.filename ?? null,
      statsDoc.imageName ?? null,
      iso(statsDoc.createdDate),
      statsDoc.hasParsedWorkflow ? 1 : 0,
      statsDoc.baseModel ? scalar(statsDoc.baseModel) : null,
      statsDoc.searchText ? scalar(statsDoc.searchText) : null,
      iso(statsDoc.capturedAt),
      statsDoc.docJson,
    );
    const rid =
      oldRow?.rid ??
      (db.prepare('SELECT last_insert_rowid() AS r').get() as { r: number }).r;
    // lora 子表重插(EXISTS/NOT EXISTS 筛选数据源)
    const insertSLora = db.prepare(
      'INSERT OR REPLACE INTO stats_doc_lora_names(resolved_path, name) VALUES (?,?)',
    );
    for (const name of statsDoc.loraNames) {
      insertSLora.run(statsDoc.resolvedPath, name);
    }
    // FTS 同步:按 rowid 先删后插(search_text 从 A 变 B 时旧 A 行
    // 不再残留;非空才插,空文本无检索价值)
    db.prepare('DELETE FROM fts_stats_docs WHERE rowid = ?').run(rid);
    if (statsDoc.searchText) {
      db.prepare(
        'INSERT INTO fts_stats_docs(rowid, search_text) VALUES (?,?)',
      ).run(rid, scalar(statsDoc.searchText) ?? '');
    }
  });
}

/**
 * Mongo stats_cache 文档 → StatsDocWrite(buildStatsCacheDocument 产物)。
 * ingest/archive 双写共用。
 *
 * @param cacheDoc Mongo stats_cache 文档(file/prompts/loras/model 嵌套结构)
 * @returns SQLite 写记录;loraNames 去重过滤空值后排序
 *          (确定性输出,便于双写对比与测试断言)
 *
 * 字段映射:file.resolved_path → resolvedPath(主键);
 * prompts.search_text → searchText;model.base_model → baseModel;
 * has_parsed_workflow 转布尔;capturedAt 置 null
 * (stats_docs 表该列仅作展示,来源文档无此字段)。
 */
export function statsDocWriteFromCache(
  cacheDoc: Record<string, unknown>,
): StatsDocWrite {
  const file = (cacheDoc.file as Record<string, unknown>) ?? {};
  const prompts = (cacheDoc.prompts as { search_text?: unknown }) ?? {};
  const loras = (cacheDoc.loras as { names?: string[] }) ?? {};
  return {
    resolvedPath: String(file.resolved_path ?? ''),
    filename: file.filename ?? null,
    imageName: file.image_name ?? null,
    createdDate: cacheDoc.created_date ?? null,
    hasParsedWorkflow: Boolean(cacheDoc.has_parsed_workflow),
    baseModel:
      (cacheDoc.model as { base_model?: unknown } | undefined)?.base_model ??
      null,
    searchText: prompts.search_text ?? null,
    capturedAt: null,
    loraNames: [...new Set((loras.names ?? []).filter(Boolean))].sort(),
    docJson: JSON.stringify(cacheDoc),
  };
}

/**
 * 按 resolved_path 摘除元素:删除 batch_images 中该路径的所有行、
 * 对应 stats_docs;空批次由 deleteEmptyBatches 统一清理。
 * 双形式路径(归一化相同)一并删除。
 *
 * @param db 目标连接
 * @param paths 要移除的 resolved_path 列表
 *
 * 语义对齐 Mongo 的 $pull:images 数组中按 resolved_path 摘除元素,
 * 同时摘除其 stats_doc。跨平台形式展开的原因:库内同一文件
 * 可能以 WSL/Windows 两种形式存在(不同批次或不同扫描写入),
 * 归一化后应视作同一条路径一并删除。
 */
export function removeResolvedPaths(
  db: Database.Database,
  paths: string[],
): void {
  // 空列表直接返回,避免生成 `IN ()` 非法 SQL
  if (paths.length === 0) return;
  withTransaction(db, () => {
    // 展开所有跨平台形式,去重后拼参数占位符
    const variants = new Set<string>();
    for (const p of paths) {
      for (const form of bothPlatformForms(p)) variants.add(form);
    }
    const list = [...variants];
    // 动态 IN 列表:占位符数量 = 路径数(参数化查询,防注入)
    const placeholders = list.map(() => '?').join(',');
    // FTS 行先于主表行删(主表行删除后无法再按 rowid 关联);
    // 其余子行(batch_images)随后摘除,batches 主行由 deleteEmptyBatches 清
    db.prepare(
      `DELETE FROM fts_stats_docs WHERE rowid IN (
         SELECT rowid FROM stats_docs WHERE resolved_path IN (${placeholders}))`,
    ).run(...list);
    db.prepare(
      `DELETE FROM batch_images WHERE resolved_path IN (${placeholders})`,
    ).run(...list);
    db.prepare(
      `DELETE FROM stats_docs WHERE resolved_path IN (${placeholders})`,
    ).run(...list);
  });
}

/**
 * 精确字符串删除(不做跨平台形式展开):与 Mongo $pull $in(精确值)对齐。
 * 用于双形式去重——stale 形式与当前形式归一化相同,按精确串只删 stale。
 *
 * @param db 目标连接
 * @param paths 要精确删除的 resolved_path 列表
 *
 * 场景:同文件以两种形式各入库一次,去重时要保留当前形式、
 * 只删过期的另一形式。若走 removeResolvedPaths(展开双形式)
 * 会把两条全删掉,因此这里按字面值精确匹配。
 */
export function removeExactPaths(db: Database.Database, paths: string[]): void {
  if (paths.length === 0) return;
  withTransaction(db, () => {
    const list = [...new Set(paths)];
    const placeholders = list.map(() => '?').join(',');
    // FTS 行先于主表行删(rowid 关联依赖主表行存在)
    db.prepare(
      `DELETE FROM fts_stats_docs WHERE rowid IN (
         SELECT rowid FROM stats_docs WHERE resolved_path IN (${placeholders}))`,
    ).run(...list);
    db.prepare(
      `DELETE FROM batch_images WHERE resolved_path IN (${placeholders})`,
    ).run(...list);
    db.prepare(
      `DELETE FROM stats_docs WHERE resolved_path IN (${placeholders})`,
    ).run(...list);
  });
}

/**
 * 清理无元素批次(子表孤儿行由本函数显式清除)。返回删除批次数。
 *
 * @param db 目标连接
 * @returns 被删除的批次行数
 *
 * 触发时机:removeResolvedPaths 之后由调用方调度;
 * batch_images 是"批次是否为空"的事实来源——
 * NOT IN (SELECT DISTINCT batch_key FROM batch_images) 即无任何图片的批次。
 * 注意:SQLite 外键默认不强制(schema 未 PRAGMA foreign_keys=ON),子表
 * REFERENCES batches ON DELETE CASCADE 不会生效,故删除主行后须显式
 * 清掉孤儿子行(batch_lora_names),与 schema.ts 重灌倒序 DELETE 约定一致。
 */
export function deleteEmptyBatches(db: Database.Database): number {
  return withTransaction(db, () => {
    // FTS 行先删(空批次判定与主表删除同一谓词,rowid 关联依赖主表行存在)
    db.prepare(
      `DELETE FROM fts_batches WHERE rowid IN (
         SELECT rowid FROM batches
         WHERE batch_key NOT IN (SELECT DISTINCT batch_key FROM batch_images))`,
    ).run();
    const result = db
      .prepare(
        `DELETE FROM batches
         WHERE batch_key NOT IN (SELECT DISTINCT batch_key FROM batch_images)`,
      )
      .run();
    // 显式清孤儿子行(级联未开启,须手动;batch_images 对空批已无行,此处防
    // loras 子表与未来任何子表在批次删除前的残留)
    db.prepare(
      `DELETE FROM batch_lora_names
       WHERE batch_key NOT IN (SELECT batch_key FROM batches)`,
    ).run();
    return result.changes;
  });
}

/**
 * 按路径(含跨平台形式)查所属批次(upsertSingleRecord 的 mongo findOne 等价)。
 *
 * @param db 目标连接
 * @param pathVariants 路径形式列表(通常为 bothPlatformForms 展开结果)
 * @returns 匹配批次的 { batchKey, recipeKey, capturedAt };无匹配返回 null
 *
 * 说明:JOIN batch_images 才能按路径反查批次(batches 主表不存路径),
 * LIMIT 1 取任意一条(同路径跨批次时取数据库顺序第一条,与 Mongo
 * findOne 的未排序返回行为一致)。
 */
export function readBatchByPath(
  db: Database.Database,
  pathVariants: string[],
): { batchKey: string; recipeKey: string; capturedAt: unknown } | null {
  if (pathVariants.length === 0) return null;
  const placeholders = pathVariants.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT b.batch_key AS batchKey, b.recipe_key AS recipeKey, b.captured_at AS capturedAt
       FROM batches b JOIN batch_images bi ON bi.batch_key = b.batch_key
       WHERE bi.resolved_path IN (${placeholders}) LIMIT 1`,
    )
    .get(...pathVariants) as
    | { batchKey: string; recipeKey: string | null; capturedAt: string | null }
    | undefined;
  if (!row) return null;
  return {
    batchKey: row.batchKey ?? '',
    recipeKey: row.recipeKey ?? '',
    capturedAt: row.capturedAt,
  };
}

// ---------------------------------------------------------------------------
// 读原语(索引构建)
// ---------------------------------------------------------------------------

/**
 * 构建扫描索引(loadExistingIndex 等价):
 * 按 scanRoot 两种路径形式前缀,批量读 batches JOIN batch_images,
 * 在 TS 侧构建 byPath / byFingerprint / storedFormsByNorm。
 *
 * @param db 目标连接
 * @param scanRoot 扫描根目录(前缀匹配,只加载扫描范围内的历史数据)
 * @returns 见 ScanIndex
 *
 * 调用方:ingest 主流程,扫描开始前构建,用于全量去重判定。
 * 性能要点:一次 LIKE 前缀查询 + TS 侧归组,避免逐文件反查。
 */
export function buildScanIndex(
  db: Database.Database,
  scanRoot: string,
): ScanIndex {
  // 1. 前缀规范化:去掉尾部斜杠(避免 '/' 与 '' 两前缀不同);
  //    normPrefix 为跨平台归一形式
  const prefix = scanRoot.replace(/[\\/]+$/, '');
  const normPrefix = normalizePathForPlatform(prefix);
  // Windows 盘符正斜杠形式(D:/x)在 win32 下 normalizePathForPlatform 不转换,
  // 而 path.join 入库为反斜杠形式(D:\x)——补反斜杠变体,否则索引恒空全量重判 new
  // 补这一变体是历史教训:曾因索引恒空导致全量重新入库重复数据。
  const backslashPrefix = /^[A-Za-z]:\//.test(prefix)
    ? prefix.replace(/\//g, '\\')
    : prefix;
  // 去重后得到前缀候选集(最多 3 种:原样 / 归一 / 反斜杠)
  const variants = [...new Set([prefix, normPrefix, backslashPrefix])];
  // 2. 每个前缀生成两个 LIKE 谓词(斜杠/反斜杠续接),OR 连接;
  //    ESCAPE '\' 声明反斜杠转义符,配合 likeEscape 防通配符注入
  const where = variants
    .map(
      () =>
        "(bi.resolved_path LIKE ? ESCAPE '\\' OR bi.resolved_path LIKE ? ESCAPE '\\')",
    )
    .join(' OR ');
  const params: string[] = [];
  for (const v of variants) {
    const esc = likeEscape(v);
    // 反斜杠形式:字面 \ 后跟通配符(LIKE ESCAPE 下 \\ 才是字面反斜杠)
    // 第一个参数匹配反斜杠续接(Windows 路径),第二个匹配斜杠续接(WSL 路径)
    params.push(`${esc}\\\\%`, `${esc}/%`);
  }

  // 3. 三个索引容器:路径→条目 / 指纹→条目列表 / 归一路径→各存储形式
  const byPath = new Map<string, ScanIndexEntry>();
  const byFingerprint = new Map<number, ScanIndexEntry[]>();
  const storedFormsByNorm = new Map<string, Map<string, string>>();

  // 4. 一次查询取出范围内全部 (batch, image) 关联行;
  //    只取索引所需列,不取 doc_json(避免大字段全量载入)
  const rows = db
    .prepare(
      `SELECT b.batch_key AS batchKey, b.recipe_key AS recipeKey,
              bi.resolved_path AS resolvedPath, bi.size_bytes AS sizeBytes,
              bi.mtime_ns AS mtimeNs
       FROM batch_images bi JOIN batches b ON b.batch_key = bi.batch_key
       WHERE ${where}`,
    )
    .all(...params) as Array<{
    batchKey: string;
    recipeKey: string | null;
    resolvedPath: string;
    sizeBytes: number | null;
    mtimeNs: number | null;
  }>;

  // 5. TS 侧归组:
  for (const row of rows) {
    const path = row.resolvedPath;
    if (!path) continue;
    const entry: ScanIndexEntry = {
      batchKey: row.batchKey ?? '',
      recipeKey: row.recipeKey ?? '',
      sizeBytes: row.sizeBytes ?? 0,
      mtimeNs: row.mtimeNs ?? 0,
      storedPath: path,
    };
    // byPath 同时注册原样路径与归一化路径(两者指向同一条目),
    // 使扫描侧无论用哪种形式书写路径都能命中
    byPath.set(path, entry);
    const norm = normalizePathForPlatform(path);
    if (norm !== path) {
      byPath.set(norm, entry);
    }
    // storedFormsByNorm:归一化路径 → { 存储形式 → recipeKey },
    // 记录该文件在库内的全部写法,供去重时摘除等价形式
    let forms = storedFormsByNorm.get(norm);
    if (!forms) {
      forms = new Map<string, string>();
      storedFormsByNorm.set(norm, forms);
    }
    forms.set(path, row.recipeKey ?? '');
    // 指纹索引:仅当 size 与 mtime 都 > 0 才登记(0 值无指纹意义),
    // 同 size 的候选聚成列表,扫描时再按 mtime 精确判定
    if (entry.sizeBytes! > 0 && entry.mtimeNs! > 0) {
      const list = byFingerprint.get(entry.sizeBytes!);
      if (list) {
        list.push(entry);
      } else {
        byFingerprint.set(entry.sizeBytes!, [entry]);
      }
    }
  }

  return { byPath, byFingerprint, storedFormsByNorm };
}
