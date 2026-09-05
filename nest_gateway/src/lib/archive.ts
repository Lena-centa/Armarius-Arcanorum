/**
 * lib/archive.ts — 复刻 app.py _archive_generated_outputs / _upsert_single_record /
 * _remove_single_record_by_path。
 *
 * T-016 原子性:$pull 与 $push 用 mongoose Connection.transaction() 包成事务,
 * 消除 watcher + sync 并发窗口。
 *
 * parseFn 注入设计:lib 层不直接依赖 ParseWorkerService(与 ingest.ts 一致)。
 *
 * 数据流(三个入口,均为"单条/少量"写路径,与 ingest 的批量扫描互补):
 *   - archiveGeneratedOutputs:generate.controller 在 ComfyUI 出图后调用,
 *     把 summary.images(type=output)归档入库
 *   - upsertSingleRecord:orchestration(watcher 新文件/变更)调用
 *   - removeSingleRecordByPath:orchestration(watcher 删除)调用
 * 三者共享同一套"先 $pull 旧形式 → 再 $push 新元素 → 清空批 → 重建
 * recipe_groups"流程,并同步 SQLite 镜像(sqliteDb 提供时)。
 */
import { existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { Connection, Model } from 'mongoose';
import type Database from 'better-sqlite3';
import { buildRecipeKey } from './recipe_keys';
import { buildStatsCacheDocument } from './stats_cache';
import {
  rebuildRecipeGroups,
  rebuildRecipeGroupsSqlite,
} from './recipe_groups';
import { isAccessiblePath, normalizePathForPlatform } from './paths';
import { InstanceStamp, stampImageEntry } from './instance';
import { validateRecord } from '../contracts/record';
import { isValidMetadataSidecars } from '../schemas/images.schema';
import {
  BatchWrite,
  deleteEmptyBatches,
  readBatchByPath,
  removeExactPaths,
  statsDocWriteFromCache,
  upsertBatchAndChildren,
  upsertStatsDoc,
} from '../sqlite/repo';

/**
 * 读批次(captured_at/recipe_key,archive 的 mongo findOne 等价)。
 *
 * @param db       SQLite 镜像库
 * @param batchKey 目标批次 key
 * @returns {captured_at, recipe_key} 或 null(批次不存在)
 *
 * 用途:SQLite 单引擎(skipMongo)下替代 Mongo findOne 的当前批次查询,
 * 供"是否新建批次($inc batch_count)"与"是否沿用旧 captured_at"判定。
 */
function dbBatchByKey(
  db: Database.Database,
  batchKey: string,
): { captured_at?: unknown; recipe_key?: string } | null {
  const row = db
    .prepare('SELECT captured_at, recipe_key FROM batches WHERE batch_key = ?')
    .get(batchKey) as
    | { captured_at: string | null; recipe_key: string | null }
    | undefined;
  return row
    ? {
        captured_at: row.captured_at ?? undefined,
        recipe_key: row.recipe_key ?? undefined,
      }
    : null;
}

/**
 * SQLite 镜像:按 batch_key 合并旧批次元素(排除 pulledPaths)并追加新元素,
 * 字段取 record(或旧 doc 条件分支),整批覆盖重写。
 * Mongo $pull + $push 的最终态等价。
 * recipeKey 缺省时沿用旧 doc 的 recipe_key(纯摘除场景)。
 *
 * @param db              SQLite 镜像库
 * @param batchKey        目标批次 key
 * @param recipeKey       新的 recipe_key(undefined 时沿用旧 doc 值)
 * @param record          parser 产物(useRecordFields 时字段来源)
 * @param pulledPaths     本次要摘除的路径列表(不进入新批次)
 * @param useRecordFields true=字段取 record;$set 条件分支等价
 * @param pushImages      追加的新 image entry 列表
 *
 * 内部逻辑:
 *   1. 读旧 doc_json(不存在按空对象)
 *   2. 选字段来源:useRecordFields ? record : 旧 doc(与 Mongo $set 条件一致)
 *   3. 读 batch_images 全部行,过滤 pulledPaths,反序列化保留旧元素
 *   4. 拼 images = 旧元素(去摘除) + pushImages,组装 BatchWrite 整批重写
 *
 * 注意:loraNames 在 SQLite 版额外 sort(写入 lora 关联表,顺序无语义);
 * batch_count 恒等于重写后 images 长度(不依赖 $inc 记账)。
 */
function sqliteRewriteBatch(
  db: Database.Database,
  batchKey: string,
  recipeKey: string | undefined,
  record: Record<string, unknown>,
  pulledPaths: string[],
  useRecordFields: boolean,
  pushImages: Array<Record<string, unknown>> = [],
): void {
  const oldRow = db
    .prepare('SELECT doc_json FROM batches WHERE batch_key = ?')
    .get(batchKey) as { doc_json: string } | undefined;
  const old = oldRow
    ? (JSON.parse(oldRow.doc_json) as Record<string, unknown>)
    : {};
  const fields = useRecordFields
    ? {
        captured_at: record.captured_at,
        created_date: record.created_date,
        created_hour: record.created_hour,
        created_weekday: record.created_weekday,
        model: record.model ?? {},
        loras: record.loras ?? {},
        prompts: record.prompts ?? {},
        samplers: record.samplers ?? [],
        latent: record.latent ?? {},
      }
    : {
        // 纯摘除场景:不动批次元数据,仅换 recipe_key(见 key 行)
        captured_at: old.captured_at,
        created_date: old.created_date,
        created_hour: old.created_hour,
        created_weekday: old.created_weekday,
        model: old.model ?? {},
        loras: old.loras ?? {},
        prompts: old.prompts ?? {},
        samplers: old.samplers ?? [],
        latent: old.latent ?? {},
      };
  const key = recipeKey ?? String(old.recipe_key ?? '');
  // 旧元素:排除被摘除路径,保留原序
  const existing = (
    db
      .prepare(
        'SELECT resolved_path, image_json FROM batch_images WHERE batch_key = ?',
      )
      .all(batchKey) as Array<{ resolved_path: string; image_json: string }>
  )
    .filter((r) => !pulledPaths.includes(r.resolved_path))
    .map((r) => JSON.parse(r.image_json) as Record<string, unknown>);
  const images = [...existing, ...pushImages];
  const loraNames = (
    ((fields.loras as { names?: string[] } | undefined)?.names ?? []).filter(
      Boolean,
    ) as string[]
  ).sort();
  const batch: BatchWrite = {
    batchKey,
    capturedAt: fields.captured_at,
    createdDate: fields.created_date,
    createdHour: fields.created_hour,
    createdWeekday: fields.created_weekday,
    recipeKey: key,
    model: fields.model,
    loras: fields.loras,
    prompts: fields.prompts,
    samplers: fields.samplers,
    latent: fields.latent,
    batchCount: images.length,
    images,
    loraNames,
    docJson: JSON.stringify({
      batch_key: batchKey,
      captured_at: fields.captured_at,
      created_date: fields.created_date,
      created_hour: fields.created_hour,
      created_weekday: fields.created_weekday,
      model: fields.model,
      loras: fields.loras,
      prompts: fields.prompts,
      samplers: fields.samplers,
      latent: fields.latent,
      recipe_key: key,
      batch_count: images.length,
      images,
    }),
  };
  upsertBatchAndChildren(db, batch, null);
}

/**
 * image entry 的固定字段键(与 _image_entry_from_record 对齐;
 * 与 ingest.ts 的裁剪集合一致,保证两种写路径产物同构)。
 */
const IMAGE_ENTRY_KEYS = [
  'captured_at',
  'created_date',
  'created_hour',
  'created_weekday',
  'file',
  'metadata',
  'workflow',
] as const;

/**
 * 从 record 提取 image entry(与 _image_entry_from_record 对齐)。
 *
 * @param record parser 产物
 * @param stamp  多网关实例打标(可选;提供时写入 entry.source)
 * @returns 裁剪后的 image entry(固定字段集,workflow 等大字段原样保留)
 *
 * 内部逻辑:按 IMAGE_ENTRY_KEYS 白名单拷贝字段(字段不存在则跳过,
 * 保证 entry 形状稳定);stamp 存在时经 stampImageEntry 打标。
 * 注意 entry 是浅拷贝——file/metadata/workflow 仍与 record 共享引用,
 * 调用方不得就地修改这些字段。
 */
export function imageEntryFromRecord(
  record: Record<string, unknown>,
  stamp?: InstanceStamp,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const key of IMAGE_ENTRY_KEYS) {
    if (key in record) entry[key] = record[key];
  }
  // 多网关打标:image 级 source(与 file 兄弟),透传定位图片持有者
  if (stamp) stampImageEntry(entry, stamp);
  return entry;
}

/**
 * 为 ComfyUI 输出图片生成候选文件路径。
 * 复刻 _generated_image_candidates。
 *
 * @param image    ComfyUI 图片引用({filename, subfolder})
 * @param scanRoot 扫描根目录
 * @returns 去重后的候选路径列表(按优先级排序,首个存在者即命中)
 *
 * 候选优先级(subfolder 时):
 *   scanRoot/subfolder/filename → scanRoot/today/subfolder/filename
 * 然后一律补 scanRoot/filename → scanRoot/today/filename。
 * 顺序敏感:scanRoot 系优先(入库路径与 sync 口径一致)。
 */
function generatedImageCandidates(
  image: { filename?: string; subfolder?: string },
  scanRoot: string,
): string[] {
  const filename = image.filename ?? '';
  const subfolder = image.subfolder ?? '';
  if (!filename) return [];

  const candidates: string[] = [];
  if (subfolder) {
    candidates.push(join(scanRoot, subfolder, filename));
    candidates.push(join(scanRoot, 'today', subfolder, filename));
  }
  candidates.push(join(scanRoot, filename));
  candidates.push(join(scanRoot, 'today', filename));

  // 去重:subfolder 为空时前两项与后两项可能重复
  return [...new Set(candidates)];
}

/**
 * 解析 ComfyUI 输出图片的文件系统路径。
 * 复刻 _resolve_generated_image_path。
 *
 * @param image    ComfyUI 图片引用
 * @param scanRoot 扫描根目录
 * @returns 第一个真实存在的候选文件的绝对路径;全部 miss 返回 null
 */
export function resolveGeneratedImagePath(
  image: { filename?: string; subfolder?: string },
  scanRoot: string,
): string | null {
  for (const candidate of generatedImageCandidates(image, scanRoot)) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return resolve(candidate);
      }
    } catch {
      continue; // stat 抛错(权限/非法路径):尝试下一候选
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// archiveGeneratedOutputs — 复刻 _archive_generated_outputs
// ---------------------------------------------------------------------------

interface ArchiveSummary {
  images?: Array<{ type?: string; filename?: string; subfolder?: string }>;
}

/** 归档结果(返回给调用方,供响应与日志)。 */
export interface ArchiveResult {
  /** 成功归档的图片数。 */
  archived: number;
  /** 涉及(被改写)的批次去重数。 */
  batches: number;
  /** 归档图片的已解析绝对路径列表。 */
  paths: string[];
}

/**
 * 异步归档生成输出。
 *
 * 从 summary.images 取 type=output 的图片,对每张:
 * resolve path → parseFn → build_recipe_key → $pull + $push + $set → stats_docs 更新
 * → 清理空批次 → recipe_groups 局部重建
 *
 * @param summary      ComfyUI 提交摘要(取 images 列表)
 * @param imagesModel  images 集合 Model
 * @param statsDocsModel stats_docs 集合 Model
 * @param recipeGroupModel recipe_groups 集合 Model
 * @param parseFn      解析函数(调用方注入,通常走 parse worker)
 * @param scanRoot     扫描根目录(路径解析基准)
 * @param sqliteDb     SQLite 镜像库(提供时双写)
 * @param skipMongo    SQLite 单引擎:跳过全部 Mongo 读写
 * @param instance     多网关打标
 * @returns 归档结果计数
 *
 * 内部逻辑(逐图):
 *   1. resolve 文件系统路径;miss 则跳过(resolveGeneratedImagePath)
 *   2. parseFn 解析;失败跳过(文件可能半写/瞬时不可读)
 *   3. 定 batchKey(batch_key → resolved_path → 跳过无键记录)
 *   4. 查当前批次(决定 $inc batch_count 与 $set 条件分支)
 *   5. 事务化 $pull(从所有批次摘除该路径) + $push(进目标批次) + $set
 *   6. 更新 stats_docs(upsert)+ SQLite 镜像摘除/重写/upsert
 *   7. 收尾:清空批 → recipe_groups 局部重建(新老 recipe_key 均纳入)
 *
 * 边界:单图失败不影响其他图;无 output 图直接返回零结果。
 */
export async function archiveGeneratedOutputs(
  summary: ArchiveSummary,
  imagesModel: Model<unknown>,
  statsDocsModel: Model<unknown>,
  recipeGroupModel: Model<unknown>,
  parseFn: (path: string, scanRoot: string) => Promise<Record<string, unknown>>,
  scanRoot: string,
  sqliteDb?: Database.Database,
  skipMongo = false,
  instance?: InstanceStamp,
): Promise<ArchiveResult> {
  // 只归档 type=output 的输出图(temp/input 等中间产物不入库)
  const outputImages = (summary.images ?? []).filter(
    (img) => img.type === 'output',
  );
  if (outputImages.length === 0) {
    return { archived: 0, batches: 0, paths: [] };
  }

  let archived = 0;
  /** 被改写的批次集合(去重,收尾时按批重建)。 */
  const touchedBatches = new Set<string>();
  const resolvedPaths: string[] = [];
  /** 涉及新旧 recipe_key(重建 recipe_groups 的输入)。 */
  const affectedRecipeKeys = new Set<string>();

  const preparedOutputs: Array<{
    resolvedPath: string;
    record: Record<string, unknown>;
    batchKey: string;
    recipeKey: string;
    resolvedPathStr: string;
    imageEntry: Record<string, unknown>;
  }> = [];

  // 预解析并校验全部输出,在任何 Mongo/SQLite 写入前完成 sidecar 守卫。
  for (const image of outputImages) {
    const resolvedPath = resolveGeneratedImagePath(image, scanRoot);
    if (!resolvedPath) continue;

    let record: Record<string, unknown>;
    try {
      record = await parseFn(resolvedPath, scanRoot);
    } catch {
      continue; // 解析失败:本轮跳过,由 sync 扫描兜底
    }

    const batchKey = String(
      record.batch_key ??
        (record.file as { resolved_path?: string })?.resolved_path ??
        '',
    ).trim();
    if (!batchKey) continue; // 无键记录无法入库,跳过

    const recipeKey = buildRecipeKey(record);
    const resolvedPathStr =
      (record.file as { resolved_path?: string })?.resolved_path ??
      resolvedPath;
    const imageEntry = imageEntryFromRecord(record, instance);
    const diagnostics = (
      imageEntry as { metadata?: { extra_diagnostics?: unknown } }
    ).metadata?.extra_diagnostics;
    if (diagnostics !== undefined && !isValidMetadataSidecars(diagnostics)) {
      throw new Error(
        'metadata.extra_diagnostics contains invalid sidecar values',
      );
    }
    preparedOutputs.push({
      resolvedPath,
      record,
      batchKey,
      recipeKey,
      resolvedPathStr,
      imageEntry,
    });
  }

  for (const prepared of preparedOutputs) {
    const {
      resolvedPath,
      record,
      batchKey,
      recipeKey,
      resolvedPathStr,
      imageEntry,
    } = prepared;

    // 查目标批次当前状态(SQLite 单引擎走 dbBatchByKey)
    const currentBatch = skipMongo
      ? ((sqliteDb ? dbBatchByKey(sqliteDb, batchKey) : null) as {
          captured_at?: unknown;
          recipe_key?: string;
        } | null)
      : ((await imagesModel.collection.findOne(
          { batch_key: batchKey },
          { projection: { captured_at: 1, recipe_key: 1 } },
        )) as { captured_at?: unknown; recipe_key?: string } | null);

    const existingRecipeKey = currentBatch?.recipe_key?.trim() ?? '';

    // $set 字段:recipe_key 总是更新;其他字段仅在 captured_at 更新时同步
    // (规则:当前批次不存在 / record 无 captured_at / 旧批次无 captured_at /
    //  record 时间不早于旧批次 —— 任一成立则整组 $set)
    const batchSet: Record<string, unknown> = { recipe_key: recipeKey };
    const recordCapturedAt = record.captured_at as unknown;
    if (
      currentBatch === null ||
      recordCapturedAt == null ||
      currentBatch.captured_at == null ||
      (recordCapturedAt as Date) >= (currentBatch.captured_at as Date)
    ) {
      batchSet.captured_at = recordCapturedAt;
      batchSet.created_date = record.created_date;
      batchSet.model = record.model ?? {};
      batchSet.loras = record.loras ?? {};
      batchSet.prompts = record.prompts ?? {};
      batchSet.samplers = record.samplers ?? [];
      batchSet.latent = record.latent ?? {};
    }

    const batchUpdate: Record<string, unknown> = {
      $setOnInsert: { batch_key: batchKey },
      $push: { images: imageEntry },
      $set: batchSet,
    };
    // 新建批次才 $inc batch_count(已有批次只 $push,$inc 会虚增)
    if (currentBatch === null) {
      batchUpdate.$inc = { batch_count: 1 };
    }

    // T-016 原子性:$pull + $push 用 Connection.transaction() 包成事务,
    // 消除与 sync_loop bulk ingest 并发的窗口(与 upsertSingleRecord 同模式)。
    // 若 MongoDB 不支持事务(单机模式),fallback 到非事务顺序执行。
    const doPullAndPush = async (session?: unknown) => {
      // $pull 旧条目(如果该 resolved_path 已存在于其他批次)
      await imagesModel.collection.updateMany(
        { 'images.file.resolved_path': resolvedPathStr },
        {
          $pull: { images: { 'file.resolved_path': resolvedPathStr } },
        } as never,
        session ? ({ session } as never) : undefined,
      );

      await imagesModel.collection.updateOne(
        { batch_key: batchKey },
        batchUpdate as never,
        session ? ({ upsert: true, session } as never) : { upsert: true },
      );
    };

    try {
      // 尝试事务(需要副本集)
      await imagesModel.db.transaction(async (session) => {
        await doPullAndPush(session);
      });
    } catch {
      // Fallback:非事务顺序执行(与旧 Python 版行为一致)
      await doPullAndPush();
    }

    // 统计投影 upsert(以 resolved_path 为 _id)
    if (!skipMongo) {
      await statsDocsModel.collection.updateOne(
        { _id: resolvedPathStr } as never,
        { $set: buildStatsCacheDocument(record as never) },
        { upsert: true },
      );
    }

    // SQLite 镜像:$pull 全批次精确摘除 + 目标批次条件合并重写 + stats_doc
    if (sqliteDb) {
      removeExactPaths(sqliteDb, [resolvedPathStr]);
      // 与 Mongo 的 $set 条件分支复用同一判定(保证双端字段一致)
      const useRecordFields =
        currentBatch === null ||
        recordCapturedAt == null ||
        currentBatch.captured_at == null ||
        (recordCapturedAt as Date) >= (currentBatch.captured_at as Date);
      sqliteRewriteBatch(
        sqliteDb,
        batchKey,
        recipeKey,
        record,
        [resolvedPathStr],
        useRecordFields,
        [imageEntry],
      );
      upsertStatsDoc(
        sqliteDb,
        statsDocWriteFromCache(
          buildStatsCacheDocument(record as never) as never,
        ),
      );
    }

    archived += 1;
    touchedBatches.add(batchKey);
    resolvedPaths.push(resolvedPath);
    affectedRecipeKeys.add(recipeKey);
    // 旧 key 与新 key 不同时,旧组的聚合结果也失效了
    if (existingRecipeKey && existingRecipeKey !== recipeKey) {
      affectedRecipeKeys.add(existingRecipeKey);
    }
  }

  // 收尾:清空批(被 $pull 掏空的批次) + recipe_groups 局部重建
  if (archived > 0) {
    if (!skipMongo) {
      await imagesModel.collection.deleteMany({ images: { $size: 0 } });
    }
    if (sqliteDb) {
      deleteEmptyBatches(sqliteDb);
    }
  }

  if (affectedRecipeKeys.size > 0) {
    if (!skipMongo) {
      await rebuildRecipeGroups(imagesModel, recipeGroupModel, [
        ...affectedRecipeKeys,
      ]);
    }
    if (sqliteDb) {
      rebuildRecipeGroupsSqlite(sqliteDb, [...affectedRecipeKeys]);
    }
  }

  return {
    archived,
    batches: touchedBatches.size,
    paths: resolvedPaths,
  };
}

// ---------------------------------------------------------------------------
// upsertSingleRecord — 复刻 _upsert_single_record (含 T-016 原子性)
// ---------------------------------------------------------------------------

export interface UpsertResult {
  recipeKey: string;
  existingRecipeKey: string;
  /** 移动/重命名自愈:被清理的旧存储路径(同指纹、旧位置已不在磁盘)。 */
  movedFrom: string[];
}

/**
 * 单条记录 upsert(watcher webhook 路径)。
 *
 * T-016 原子性:$pull 与 $push 用 Connection.transaction() 包成事务,
 * 消除与 sync_loop bulk ingest 并发的窗口。
 *
 * 如果 MongoDB 不支持事务(单机模式),fallback 到非事务两次 update。
 *
 * @param record           parser 产物(必须含 batch_key 与 file.resolved_path)
 * @param imagesModel      images 集合 Model
 * @param statsDocsModel   stats_docs 集合 Model
 * @param recipeGroupModel recipe_groups 集合 Model
 * @param connection       mongoose 连接(事务载体)
 * @param sqliteDb         SQLite 镜像库(提供时双写)
 * @param skipMongo        SQLite 单引擎:跳过全部 Mongo 读写
 * @param instance         多网关打标
 * @returns UpsertResult(新/旧 recipe_key 与移动自愈的旧路径列表)
 * @throws Error 缺 batch_key 或缺 resolved_path 时抛错(调用方按 400 处理)
 *
 * 内部逻辑(分步):
 *   1. 校验 batch_key/resolved_path 存在;zod 结构告警(不阻断)
 *   2. 双路径形式归一(pathVariants:resolved + normalizePathForPlatform)
 *      —— sha256 是路径哈希,两种形式哈希不同,查询/去重必须全覆盖
 *   3. 查该路径现有归属(旧批次/旧 recipe_key)
 *   4. 移动/重命名检测:同 size+mtime 指纹、不同存储路径、旧位置已不在磁盘
 *      → 清理旧元素(isAccessiblePath 守卫防止误伤"保留 mtime 的拷贝")
 *   5. 事务化 $pull(旧批次+目标批次+移动旧路径)+ $push + $set
 *   6. stats_docs upsert + 移动旧路径 stats_docs 删除
 *   7. SQLite 镜像同步(摘除/重写/upsert)
 *   8. 清空批 + recipe_groups 局部重建(新/旧/移动涉及 key 全量纳入)
 */
export async function upsertSingleRecord(
  record: Record<string, unknown>,
  imagesModel: Model<unknown>,
  statsDocsModel: Model<unknown>,
  recipeGroupModel: Model<unknown>,
  connection: Connection,
  sqliteDb?: Database.Database,
  skipMongo = false,
  instance?: InstanceStamp,
): Promise<UpsertResult> {
  const batchKey = String(
    record.batch_key ??
      (record.file as { resolved_path?: string })?.resolved_path ??
      '',
  ).trim();
  if (!batchKey) throw new Error('missing batch_key');

  // B3.3 zod 运行时校验(守护):结构漂移告警,不阻断写入
  const schemaCheck = validateRecord(record);
  if (!schemaCheck.ok) {
    console.warn(
      `[archive] record schema deviation ${batchKey}: ${schemaCheck.issues.slice(0, 5).join('; ')}`,
    );
  }

  const recipeKey = buildRecipeKey(record);
  const resolvedPath =
    (record.file as { resolved_path?: string })?.resolved_path?.trim() ?? '';
  if (!resolvedPath) throw new Error('missing resolved_path');
  // 同一文件可能以 WSL(/mnt/d/...)与 Windows(D:\...)两种路径形式入库,
  // sha256 是路径哈希,两种形式哈希不同。查询与去重一律覆盖两种形式。
  const pathVariants = [
    ...new Set(
      [resolvedPath, normalizePathForPlatform(resolvedPath)].filter(Boolean),
    ),
  ];

  // 查该路径在库中的现有归属(决定 $pull 目标与旧 recipe_key)
  let existing: { batch_key?: string; recipe_key?: string } | null = null;
  if (skipMongo) {
    const hit = sqliteDb ? readBatchByPath(sqliteDb, pathVariants) : null;
    existing = hit
      ? { batch_key: hit.batchKey, recipe_key: hit.recipeKey }
      : null;
  } else {
    existing = (await imagesModel.collection.findOne(
      { 'images.file.resolved_path': { $in: pathVariants } },
      { projection: { batch_key: 1, recipe_key: 1, captured_at: 1 } },
    )) as { batch_key?: string; recipe_key?: string } | null;
  }

  const existingBatchKey = existing?.batch_key?.trim() ?? '';
  const existingRecipeKey = existing?.recipe_key?.trim() ?? '';

  // 移动/重命名检测:同指纹(size_bytes+mtime_ns)但存储路径不同的元素
  // = 同一文件的旧位置。isAccessiblePath 守卫:旧位置确已不在磁盘才清理,
  // 避免误伤保留 mtime 的拷贝(拷贝场景两条记录都应保留)。
  const fileInfo = record.file as
    | { size_bytes?: number; mtime_ns?: number }
    | undefined;
  const sizeBytes =
    typeof fileInfo?.size_bytes === 'number' ? fileInfo.size_bytes : 0;
  const mtimeNs =
    typeof fileInfo?.mtime_ns === 'number' ? fileInfo.mtime_ns : 0;
  const movedFromPaths: string[] = [];
  const movedFromRecipeKeys = new Set<string>();
  if (!skipMongo && sizeBytes > 0 && mtimeNs > 0) {
    // 指纹精确匹配(不等容差:记录内存储的是 parser 算好的同一套值,
    // 不需要 MTIME_TOLERANCE_NS 的 double 噪声容差)
    const movedCursor = imagesModel.collection.find(
      {
        'images.file.size_bytes': sizeBytes,
        'images.file.mtime_ns': mtimeNs,
        'images.file.resolved_path': { $nin: pathVariants },
      },
      {
        projection: {
          recipe_key: 1,
          'images.file.resolved_path': 1,
          'images.file.size_bytes': 1,
          'images.file.mtime_ns': 1,
        },
      },
    );
    for await (const doc of movedCursor) {
      const d = doc as {
        recipe_key?: string;
        images?: Array<{
          file?: {
            resolved_path?: string;
            size_bytes?: number;
            mtime_ns?: number;
          };
        }>;
      };
      for (const img of d.images ?? []) {
        const p = img.file?.resolved_path;
        if (!p || pathVariants.includes(p)) continue;
        if (img.file?.size_bytes !== sizeBytes) continue;
        if (img.file?.mtime_ns !== mtimeNs) continue;
        if (isAccessiblePath(p)) continue; // 旧位置仍在 → 拷贝,不是移动
        movedFromPaths.push(p);
        const rk = d.recipe_key?.trim();
        if (rk) movedFromRecipeKeys.add(rk);
      }
    }
  }

  const imageEntry = imageEntryFromRecord(record, instance);
  const diagnostics = (
    imageEntry as { metadata?: { extra_diagnostics?: unknown } }
  ).metadata?.extra_diagnostics;
  if (diagnostics !== undefined && !isValidMetadataSidecars(diagnostics)) {
    throw new Error(
      'metadata.extra_diagnostics contains invalid sidecar values',
    );
  }
  // 查目标批次是否已存在(决定 $inc batch_count 与 $setOnInsert)
  const currentBatch = skipMongo
    ? sqliteDb
      ? dbBatchByKey(sqliteDb, batchKey)
      : null
    : ((await imagesModel.collection.findOne(
        { batch_key: batchKey },
        { projection: { captured_at: 1 } },
      )) as { captured_at?: unknown } | null);

  const batchUpdate: Record<string, unknown> = {
    $setOnInsert: { batch_key: batchKey },
    $push: { images: imageEntry },
    $set: {
      captured_at: record.captured_at,
      created_date: record.created_date,
      created_hour: record.created_hour,
      created_weekday: record.created_weekday,
      model: record.model ?? {},
      loras: record.loras ?? {},
      prompts: record.prompts ?? {},
      samplers: record.samplers ?? [],
      latent: record.latent ?? {},
      recipe_key: recipeKey,
    },
  };
  // 目标批次不存在 → 本次新建,$inc 计数;已存在则仅追加
  if (currentBatch === null) {
    batchUpdate.$inc = { batch_count: 1 };
  }

  // T-016: $pull + $push 原子化
  const doPullAndPush = async (session?: unknown) => {
    // 从旧批次与目标批次同时清除该路径的所有形式,保证批内唯一
    // (同一文件只能存在于一个批次;两批次同路径场景取目标批次为准)
    const pullFrom = new Set<string>();
    if (existingBatchKey) pullFrom.add(existingBatchKey);
    pullFrom.add(batchKey);
    for (const bk of pullFrom) {
      await imagesModel.collection.updateOne(
        { batch_key: bk },
        {
          $pull: { images: { 'file.resolved_path': { $in: pathVariants } } },
        } as never,
        session ? ({ session } as never) : undefined,
      );
    }
    // 移动/重命名自愈:清除旧存储位置的元素(指纹匹配 + 已不在磁盘)
    if (movedFromPaths.length > 0) {
      await imagesModel.collection.updateMany(
        { 'images.file.resolved_path': { $in: movedFromPaths } },
        {
          $pull: { images: { 'file.resolved_path': { $in: movedFromPaths } } },
        } as never,
        session ? ({ session } as never) : undefined,
      );
    }
    await imagesModel.collection.updateOne(
      { batch_key: batchKey },
      batchUpdate as never,
      session ? ({ upsert: true, session } as never) : { upsert: true },
    );
  };

  if (!skipMongo) {
    try {
      // 尝试事务(需要副本集)
      await connection.transaction(async (session) => {
        await doPullAndPush(session);
      });
    } catch {
      // Fallback:非事务两次 update(与旧 Python 版行为一致)
      await doPullAndPush();
    }

    // 统计投影 upsert(以 resolved_path 为 _id)
    await statsDocsModel.collection.updateOne(
      { _id: resolvedPath } as never,
      { $set: buildStatsCacheDocument(record as never) },
      { upsert: true },
    );

    // 移动/重命名自愈:旧路径的 stats_docs 一并删除(新路径已在上面 upsert)
    for (const oldPath of movedFromPaths) {
      await statsDocsModel.collection.deleteOne({ _id: oldPath } as never);
    }
  }

  // SQLite 镜像:$pull 精确摘除(旧批次/移动路径)+ 目标批次重写 + stats_doc
  if (sqliteDb) {
    if (movedFromPaths.length > 0) {
      removeExactPaths(sqliteDb, movedFromPaths);
    }
    // 旧批次(≠ 目标批次)摘除该路径:纯摘除场景,元数据沿用旧 doc
    if (existingBatchKey && existingBatchKey !== batchKey) {
      sqliteRewriteBatch(
        sqliteDb,
        existingBatchKey,
        undefined,
        record,
        pathVariants,
        false,
      );
    }
    // 目标批次:字段取 record,追加新元素
    sqliteRewriteBatch(
      sqliteDb,
      batchKey,
      recipeKey,
      record,
      pathVariants,
      true,
      [imageEntry],
    );
    upsertStatsDoc(
      sqliteDb,
      statsDocWriteFromCache(buildStatsCacheDocument(record as never) as never),
    );
  }

  // 清空批:$pull 可能掏空旧批次,直接删除空壳
  if (!skipMongo) {
    await imagesModel.collection.deleteMany({ images: { $size: 0 } });
  }
  if (sqliteDb) {
    deleteEmptyBatches(sqliteDb);
  }

  // recipe_groups 局部重建:新 key + 旧 key + 移动涉及的旧 key 全量纳入
  const recipeKeys = [
    ...new Set(
      [recipeKey, existingRecipeKey, ...movedFromRecipeKeys].filter(Boolean),
    ),
  ];
  if (!skipMongo) {
    await rebuildRecipeGroups(imagesModel, recipeGroupModel, recipeKeys);
  }
  if (sqliteDb) {
    rebuildRecipeGroupsSqlite(sqliteDb, recipeKeys);
  }

  return { recipeKey, existingRecipeKey, movedFrom: movedFromPaths };
}

// ---------------------------------------------------------------------------
// removeSingleRecordByPath — 复刻 _remove_single_record_by_path
// ---------------------------------------------------------------------------

/**
 * 按 resolved_path 删除单条记录(watcher remove 事件)。
 *
 * @param resolvedPath   被删除文件的库内路径
 * @param imagesModel    images 集合 Model
 * @param statsDocsModel stats_docs 集合 Model
 * @param recipeGroupModel recipe_groups 集合 Model
 * @param sqliteDb       SQLite 镜像库(提供时同步删除)
 * @param skipMongo      SQLite 单引擎:跳过全部 Mongo 读写
 * @returns 该文件原先所属的 recipe_key(空串=未找到;调用方用于日志)
 *
 * 内部逻辑:
 *   1. 查该路径的现有归属(取 recipe_key)
 *   2. Mongo:$pull 全集合匹配该路径的元素 → 清空批 → 删 stats_doc
 *   3. SQLite:精确路径删除 + 空批清理
 *   4. recipe_groups 局部重建(仅当存在旧 key)
 *
 * 边界:路径不在库中时静默返回空 key(删除幂等);
 * 本函数不做双形式展开——删除事件带的是库内原路径,精确匹配即可。
 */
export async function removeSingleRecordByPath(
  resolvedPath: string,
  imagesModel: Model<unknown>,
  statsDocsModel: Model<unknown>,
  recipeGroupModel: Model<unknown>,
  sqliteDb?: Database.Database,
  skipMongo = false,
): Promise<string> {
  let existingRecipeKey = '';
  if (skipMongo) {
    // SQLite 单引擎:查询归属 + 精确删除走镜像库
    const hit = sqliteDb ? readBatchByPath(sqliteDb, [resolvedPath]) : null;
    existingRecipeKey = hit?.recipeKey ?? '';
  } else {
    const existing = (await imagesModel.collection.findOne(
      { 'images.file.resolved_path': resolvedPath },
      { projection: { batch_key: 1, recipe_key: 1 } },
    )) as { recipe_key?: string } | null;
    existingRecipeKey = existing?.recipe_key?.trim() ?? '';

    // $pull:从所有批次摘除该元素(路径唯一性由入库时保证,理论上只中一条)
    await imagesModel.collection.updateMany(
      { 'images.file.resolved_path': resolvedPath },
      { $pull: { images: { 'file.resolved_path': resolvedPath } } } as never,
    );

    // 清理被掏空的批次壳
    await imagesModel.collection.deleteMany({ images: { $size: 0 } });

    // 统计投影同步删除
    await statsDocsModel.collection.deleteOne({ _id: resolvedPath } as never);
  }

  if (sqliteDb) {
    removeExactPaths(sqliteDb, [resolvedPath]);
    deleteEmptyBatches(sqliteDb);
  }

  // 仅当确有旧归属时才重建(避免全库空跑)
  if (existingRecipeKey) {
    if (!skipMongo) {
      await rebuildRecipeGroups(imagesModel, recipeGroupModel, [
        existingRecipeKey,
      ]);
    }
    if (sqliteDb) {
      rebuildRecipeGroupsSqlite(sqliteDb, [existingRecipeKey]);
    }
  }

  return existingRecipeKey;
}
