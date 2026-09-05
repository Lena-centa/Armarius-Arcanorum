/**
 * lib/recipe_groups.ts — 移植自已移除的 workflow_db/recipe_groups.py。
 *
 * 核心函数:
 *   rebuildRecipeGroups — 全量或局部(affected_recipe_keys)重建 recipe_groups 集合
 *
 * pipeline 逻辑:
 *   $match recipe_key 存在 → $sort captured_at desc → $group by recipe_key
 *   (取 $first 最新批次的字段 + $push batch_keys/members/每批 images)
 *   → $addFields flat_images($concatArrays 合并各批 images,每批上限 5)
 *   → $project 整理(images 裁剪为预览所需字段 + 全局上限 100;
 *     seeds $reduce concatArrays)
 *
 * NestJS schema 的 index 已在 recipe-groups.schema.ts 中定义,
 * 不需要手动 ensure_indexes(Python 版的 ensure_recipe_group_indexes)。
 *
 * 数据流:ingest.ts / archive.ts 在写入/删除后,把 affected recipe_key 列表
 * 传入 rebuildRecipeGroups(局部重建)或传空(全量重建);读端 images.controller
 * 从 recipe_groups 集合按 recipe_key 直读,前端"配方"视图消费。
 * SQLite 版 rebuildRecipeGroupsSqlite 与之语义等价;readMode 下为主写路径,
 * 双写模式下为镜像。
 */
import { Model } from 'mongoose';
import type Database from 'better-sqlite3';
import { withTransaction } from '../sqlite/db';

/** aggregate pipeline 阶段容器(宽松类型,保持与 Python 版 pipeline 对齐)。 */
interface PipelineStage {
  [key: string]: unknown;
}

/**
 * 构建 recipe_group aggregate pipeline（与 Python 版对齐）。
 *
 * @param matchFilter 可选前置过滤(局部重建时传 {recipe_key: {$in: [...]}},
 *                    全量重建时缺省;会在非空 recipe_key 过滤之前先应用)
 * @returns Mongo aggregate pipeline 阶段数组
 *
 * 阶段设计(自底向上):
 *   1. $match:过滤 recipe_key 存在且非空/非 null 的批次
 *   2. $sort:captured_at desc —— 决定 $first 取到的是"最新批次"字段
 *   3. $group by recipe_key:
 *      - 最新批次的展示字段(model/loras/prompts/samplers/latent 等 $first)
 *      - batch_keys/成员列表 $push 全量
 *      - batch_count 按批次计数;image_count 累加每批 images 长度
 *      - 每批 images 用 $slice 收 5 张($push 数组嵌套,后续 $reduce 展平)
 *      - first_file 取最新批次首图;files_preview 在 $project 被重定义为跨批次前 5
 *   4. $addFields flat_images:$reduce 把各组"每批 5 张"合并为跨批次列表
 *   5. $project:裁剪 images 为预览字段(约 400B/元素)并 $slice 全局 100;
 *      全量元素含 workflow 平均 16KB,100 张 ≈ 1.6MB,不可行
 *
 * 注意:samplers.seed 数组($push '$samplers.seed')逐批入 seed_lists,
 * 最后 $reduce 展平——seed 顺序为"批次序 × 批内序"。
 */
export function recipeGroupAggregatePipeline(
  matchFilter?: Record<string, unknown>,
): PipelineStage[] {
  const pipeline: PipelineStage[] = [];
  if (matchFilter) {
    pipeline.push({ $match: matchFilter });
  }
  pipeline.push(
    { $match: { recipe_key: { $exists: true, $nin: [null, ''] } } },
    // 排序先行:保证 $first 语义为"captured_at 最新的批次"
    { $sort: { captured_at: -1 } },
    {
      $group: {
        _id: '$recipe_key',
        recipe_key: { $first: '$recipe_key' },
        // 兼容旧前端契约:batch_key 字段填 recipe_key(聚合组无单一批次身份)
        batch_key: { $first: '$recipe_key' },
        captured_at: { $first: '$captured_at' },
        created_date: { $first: '$created_date' },
        created_hour: { $first: '$created_hour' },
        created_weekday: { $first: '$created_weekday' },
        model: { $first: '$model' },
        loras: { $first: '$loras' },
        prompts: { $first: '$prompts' },
        samplers: { $first: '$samplers' },
        latent: { $first: '$latent' },
        batch_keys: { $push: '$batch_key' },
        batch_count: { $sum: 1 },
        image_count: { $sum: { $size: { $ifNull: ['$images', []] } } },
        // 每批 seed 列表逐批收进 seed_lists(数组嵌套,后续 $reduce 展平)
        seed_lists: { $push: '$samplers.seed' },
        // 每批最多收 5 张,后续 $reduce 合并为跨批次列表(再全局截断)
        images: { $push: { $slice: ['$images', 5] } },
        first_file: { $first: { $arrayElemAt: ['$images.file', 0] } },
        files_preview: { $first: { $slice: ['$images.file.filename', 5] } },
        members: {
          $push: {
            batch_key: '$batch_key',
            created_date: '$created_date',
            created_hour: '$created_hour',
            captured_at: '$captured_at',
            count: { $size: { $ifNull: ['$images', []] } },
            seeds: '$samplers.seed',
            files_preview: { $slice: ['$images.file.filename', 3] },
            file: { $arrayElemAt: ['$images.file', 0] },
          },
        },
      },
    },
    {
      $addFields: {
        // 合并各批图片列表(每批上限 5),供 $project 跨批次截断
        flat_images: {
          $reduce: {
            input: '$images',
            initialValue: [],
            in: { $concatArrays: ['$$value', '$$this'] },
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        recipe_key: 1,
        batch_key: 1,
        captured_at: 1,
        created_date: 1,
        created_hour: 1,
        created_weekday: 1,
        model: 1,
        loras: 1,
        prompts: 1,
        samplers: 1,
        latent: 1,
        batch_keys: 1,
        batch_count: 1,
        image_count: 1,
        first_file: 1,
        members: 1,
        // 跨批次合并后的图片列表:裁剪为预览所需字段,全局上限 100
        // (元素 ~400B,100 张 ≈ 40KB;full 元素含 workflow 平均 16KB,不可行)
        images: {
          $slice: [
            {
              $map: {
                input: '$flat_images',
                as: 'img',
                in: {
                  captured_at: '$$img.captured_at',
                  created_date: '$$img.created_date',
                  created_hour: '$$img.created_hour',
                  created_weekday: '$$img.created_weekday',
                  // 缺省字段统一 $ifNull 补 null,保持元素形状恒定
                  file: {
                    filename: { $ifNull: ['$$img.file.filename', null] },
                    sha256: { $ifNull: ['$$img.file.sha256', null] },
                    resolved_path: {
                      $ifNull: ['$$img.file.resolved_path', null],
                    },
                    windows_path: {
                      $ifNull: ['$$img.file.windows_path', null],
                    },
                    width: { $ifNull: ['$$img.file.width', null] },
                    height: { $ifNull: ['$$img.file.height', null] },
                    size_bytes: { $ifNull: ['$$img.file.size_bytes', null] },
                    format: { $ifNull: ['$$img.file.format', null] },
                    mode: { $ifNull: ['$$img.file.mode', null] },
                  },
                  // 远端图片库定位信息必须跟随预览条目,
                  // 否则 recipe 详情无法展示资产来源。
                  source: { $ifNull: ['$$img.source', null] },
                },
              },
            },
            100,
          ],
        },
        // 预览文件名:取合并列表前 5(不再受限于最新批次的张数)
        files_preview: {
          $slice: [
            {
              $map: {
                input: '$flat_images',
                as: 'img',
                in: '$$img.file.filename',
              },
            },
            5,
          ],
        },
        // seeds:seed_lists(每批一个数组)展平为单层
        seeds: {
          $reduce: {
            input: '$seed_lists',
            initialValue: [],
            in: { $concatArrays: ['$$value', '$$this'] },
          },
        },
      },
    },
  );
  return pipeline;
}

/** 重建结果计数(返回给调用方,用于日志/监控)。 */
interface RebuildResult {
  /** 写入 recipe_groups 的组数(aggregate 产出的文档数)。 */
  updated: number;
  /** 请求重建的 recipe_key 数(0 表示全量重建)。 */
  requested_keys: number;
}

/**
 * 重建 recipe_groups 集合（全量或局部）。
 *
 * 复刻 Python rebuild_recipe_groups:
 *   - recipe_keys 为空 → 全量重建(delete_many({}) + aggregate all)
 *   - recipe_keys 非空 → 局部重建(delete affected + aggregate filtered)
 *
 * @param imagesModel      images 集合 Model(数据源)
 * @param recipeGroupModel recipe_groups 集合 Model(目标)
 * @param recipeKeys       可选,指定局部重建的 recipe_key 列表
 * @returns 重建结果计数
 *
 * 内部逻辑:
 *   1. 归一化 recipeKeys(trim + 去重 + 排序;空数组 = 全量)
 *   2. 按范围跑 aggregate pipeline 取组文档
 *   3. 先删后插串行化:deleteMany 与 replaceOne 若同批 ordered:false
 *      会竞态(先插后删 → 局部重建结果被清空);此前被 self-heal
 *      全量重建掩盖
 *   4. 逐组 replaceOne(upsert)写回
 *
 * 边界:aggregate 产出无 recipe_key 的文档跳过;无操作时不发 bulkWrite。
 */
export async function rebuildRecipeGroups(
  imagesModel: Model<unknown>,
  recipeGroupModel: Model<unknown>,
  recipeKeys?: string[],
): Promise<RebuildResult> {
  // trim+去重+排序:同一 key 的不同书写形式收敛为一个,排序稳定删除顺序
  const normalizedKeys = [
    ...new Set((recipeKeys ?? []).map((k) => k.trim()).filter(Boolean)),
  ].sort();

  // 局部重建带前置过滤;全量重建不加(跑全库)
  const matchFilter = normalizedKeys.length
    ? { recipe_key: { $in: normalizedKeys } }
    : undefined;

  const docs = await imagesModel.collection
    .aggregate(recipeGroupAggregatePipeline(matchFilter))
    .toArray();

  // 先删后插串行化:deleteMany 与 replaceOne 若同批 ordered:false 会竞态
  // (先插后删 → 局部重建结果被清空);此前被 self-heal 全量重建掩盖
  if (normalizedKeys.length) {
    await recipeGroupModel.collection.deleteMany({
      recipe_key: { $in: normalizedKeys },
    });
  } else {
    await recipeGroupModel.collection.deleteMany({});
  }

  const operations: Array<{
    replaceOne: {
      filter: Record<string, unknown>;
      replacement: Record<string, unknown>;
      upsert: boolean;
    };
  }> = [];

  // 逐组写回:replaceOne 幂等(整体替换),upsert 兜底首次出现
  for (const doc of docs) {
    const recipeKey = String(doc.recipe_key ?? '').trim();
    if (!recipeKey) continue;
    operations.push({
      replaceOne: {
        filter: { recipe_key: recipeKey },
        replacement: doc as Record<string, unknown>,
        upsert: true,
      },
    });
  }

  if (operations.length) {
    await recipeGroupModel.collection.bulkWrite(operations as never, {
      ordered: false,
    });
  }

  return {
    updated: docs.length,
    requested_keys: normalizedKeys.length,
  };
}

// ---------------------------------------------------------------------------
// SQLite 落盘版(与 aggregate pipeline 语义等价;readMode 下为主写路径,双写模式下为镜像)
// ---------------------------------------------------------------------------

/** 取文档的 images 数组(非数组按空处理)。 */
function recipeImages(
  d: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return Array.isArray(d.images)
    ? (d.images as Array<Record<string, unknown>>)
    : [];
}

/** 取图片的 file 对象(缺省 undefined)。 */
function recipeFile(img: Record<string, unknown> | undefined): unknown {
  return (img?.file as Record<string, unknown> | undefined) ?? undefined;
}

/**
 * Mongo 点路径语义:samplers.seed 对数组按元素投影。
 * samplers 为数组时返回每元素 seed 的数组,否则空数组。
 *
 * @param samplers 批次 samplers 字段
 * @returns seed 值数组(与 samplers 元素一一对应;非数组返回 [])
 */
function samplerSeeds(samplers: unknown): unknown[] {
  if (!Array.isArray(samplers)) return [];
  return samplers.map((s) => (s as { seed?: unknown })?.seed);
}

/**
 * TS 分组(recipeGroupAggregatePipeline 的 $group/$addFields/$project 等价)。
 * 输入按 captured_at DESC 排序,输出与 pipeline 的 recipe_groups 文档一致。
 *
 * @param docs 已按 captured_at DESC 排序的批次文档(batches 表读出)
 * @returns 与 Mongo aggregate 产物逐字段对齐的组文档列表
 *
 * 对齐要点:
 *   - $first == 每组首个元素(依赖入参已排序)
 *   - images 每批 slice(0,5) 再展平,最后全局 slice(0,100)
 *   - files_preview 取展平列表前 5;seeds 逐批展平
 *   - 预览 file 字段固定 9 键、缺省补 null
 */
export function groupRecipeDocs(
  docs: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  // 按键分组(保持 docs 传入顺序 = 每组的 batch 序,captured_at desc 已保证)
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const doc of docs) {
    const key = String(doc.recipe_key ?? '').trim();
    if (!key) continue;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(doc);
  }

  const out: Array<Record<string, unknown>> = [];
  for (const [key, batchDocs] of groups) {
    // first = 最新批次($first 语义);展示字段全部取自它
    const first = batchDocs[0] as {
      batch_key?: unknown;
      captured_at?: unknown;
      created_date?: unknown;
      created_hour?: unknown;
      created_weekday?: unknown;
      model?: unknown;
      loras?: unknown;
      prompts?: unknown;
      samplers?: unknown;
      latent?: unknown;
    };
    // 每批最多 5 张后展平(与 pipeline 的 $slice+$reduce 一致)
    const flatImages = batchDocs.flatMap((d) => recipeImages(d).slice(0, 5));

    // members:逐批成员摘要(文件名预览 3 张、首图 file、seed 列表)
    const members = batchDocs.map((d) => {
      const imgs = recipeImages(d);
      return {
        batch_key: d.batch_key,
        created_date: d.created_date,
        created_hour: d.created_hour,
        captured_at: d.captured_at,
        count: imgs.length,
        seeds: samplerSeeds(d.samplers),
        files_preview: imgs
          .slice(0, 3)
          .map((i) => (i.file as { filename?: unknown } | undefined)?.filename),
        file: recipeFile(imgs[0]),
      };
    });

    out.push({
      recipe_key: key,
      // 与 Mongo pipeline 一致:batch_key 字段填 recipe_key(组级契约)
      batch_key: key,
      captured_at: first.captured_at,
      created_date: first.created_date,
      created_hour: first.created_hour,
      created_weekday: first.created_weekday,
      model: first.model,
      loras: first.loras,
      prompts: first.prompts,
      samplers: first.samplers,
      latent: first.latent,
      batch_keys: batchDocs.map((d) => d.batch_key),
      batch_count: batchDocs.length,
      image_count: batchDocs.reduce((s, d) => s + recipeImages(d).length, 0),
      first_file: recipeFile(recipeImages(first)[0]),
      members,
      // 预览图片:固定 9 键裁剪(与 pipeline 的 $project $map 一致),全局 100 张
      images: flatImages
        .map((img) => {
          const file = (img.file as Record<string, unknown> | undefined) ?? {};
          const previewFile: Record<string, unknown> = {};
          for (const k of [
            'filename',
            'sha256',
            'resolved_path',
            'windows_path',
            'width',
            'height',
            'size_bytes',
            'format',
            'mode',
          ]) {
            previewFile[k] = file[k] ?? null;
          }
          return {
            captured_at: img.captured_at,
            created_date: img.created_date,
            created_hour: img.created_hour,
            created_weekday: img.created_weekday,
            file: previewFile,
            source: img.source ?? null,
          };
        })
        .slice(0, 100),
      files_preview: flatImages
        .map((i) => (i.file as { filename?: unknown } | undefined)?.filename)
        .slice(0, 5),
      seeds: batchDocs.flatMap((d) => samplerSeeds(d.samplers)),
    });
  }
  return out;
}

/**
 * 重建 recipe_groups(SQLite 版):从 batches 按 captured_at DESC 读取,
 * TS 分组(与 Mongo aggregate 等价),整类或局部(recipe_keys)重写。
 * 两种模式均在事务尾部把 fts_recipe_groups 按 rowid 整表重对齐。
 *
 * @param db         SQLite 镜像库
 * @param recipeKeys 局部重建的 key 列表;空数组 = 全量重建
 * @returns 重建结果计数
 *
 * 内部逻辑:
 *   1. WHERE 按需拼参(局部用 IN 占位符;全量过滤空 key)
 *   2. 按 captured_at DESC 读 batches.doc_json 并反序列化
 *   3. groupRecipeDocs 分组(与 Mongo 产物对齐)
 *   4. 事务内重写:
 *      - 局部:DELETE 目标 key;全量:清 recipe_groups
 *      - 每组 INSERT OR REPLACE 主表(冗余列:base_model/search_text/count/
 *        batch_keys/has_positive + doc_json 全量)
 *      - 每组的 lora 名逐条入 recipe_lora_names
 *
 * 边界:FTS 无论局部/全量统一整表重对齐(局部 REPLACE 给主表行
 * 分配新 rowid,逐行维护易错;千行级整表重建 <1s,快照语义简单可靠)。
 */
export function rebuildRecipeGroupsSqlite(
  db: Database.Database,
  recipeKeys: string[] = [],
): RebuildResult {
  const normalizedKeys = [
    ...new Set(recipeKeys.map((k) => k.trim()).filter(Boolean)),
  ].sort();

  const where = normalizedKeys.length
    ? `WHERE recipe_key IN (${normalizedKeys.map(() => '?').join(',')})`
    : "WHERE recipe_key IS NOT NULL AND recipe_key != ''";
  const params = normalizedKeys.length ? normalizedKeys : [];
  // 排序保证 groupRecipeDocs 的 $first 语义(组内最新批次)
  const rows = db
    .prepare(`SELECT doc_json FROM batches ${where} ORDER BY captured_at DESC`)
    .all(...params) as Array<{ doc_json: string }>;
  const docs = rows.map(
    (r) => JSON.parse(r.doc_json) as Record<string, unknown>,
  );
  const grouped = groupRecipeDocs(docs);

  withTransaction(db, () => {
    // 先删:局部仅删目标 key;全量清整表(FTS 在尾部统一按 rowid 重对齐)
    if (normalizedKeys.length) {
      db.prepare(
        `DELETE FROM recipe_groups WHERE recipe_key IN (${normalizedKeys.map(() => '?').join(',')})`,
      ).run(...normalizedKeys);
    } else {
      db.exec('DELETE FROM recipe_groups');
    }
    // 主表:冗余列供 SQL 过滤(无 FTS 也能按 search_text LIKE 查)
    const insert = db.prepare(
      `INSERT OR REPLACE INTO recipe_groups(
        recipe_key, captured_at, created_date, base_model, search_text,
        count, batch_keys, has_positive, doc_json)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    const insertLora = db.prepare(
      'INSERT OR REPLACE INTO recipe_lora_names(recipe_key, name) VALUES (?,?)',
    );
    for (const doc of grouped) {
      const model = doc.model as { base_model?: unknown } | undefined;
      const prompts = doc.prompts as
        | {
            search_text?: unknown;
            positive?: unknown;
          }
        | undefined;
      const loras = doc.loras as { names?: unknown[] } | undefined;
      // has_positive:positive 为非空数组 → 1(供"仅正向 prompt"过滤)
      const positive = prompts?.positive;
      const hasPositive =
        Array.isArray(positive) && positive.length > 0 ? 1 : 0;
      insert.run(
        doc.recipe_key as string,
        doc.captured_at ? String(doc.captured_at) : null,
        doc.created_date ? String(doc.created_date) : null,
        model?.base_model ? String(model.base_model) : null,
        prompts?.search_text ? String(prompts.search_text) : null,
        (doc.batch_count as number) ?? null,
        JSON.stringify(doc.batch_keys),
        hasPositive,
        JSON.stringify(doc),
      );
      for (const name of (loras?.names ?? []) as Array<unknown>) {
        insertLora.run(doc.recipe_key as string, String(name));
      }
    }
    // FTS 整表按 rowid 重对齐(局部 REPLACE 会给主表行分配新 rowid,
    // 逐行维护易错;整表重建千行级 <1s,统一在事务尾部快照对齐)
    db.exec('DELETE FROM fts_recipe_groups');
    db.exec(
      `INSERT INTO fts_recipe_groups(rowid, search_text)
       SELECT rowid, search_text FROM recipe_groups
       WHERE search_text IS NOT NULL AND search_text != ''`,
    );
  });

  return {
    updated: grouped.length,
    requested_keys: normalizedKeys.length,
  };
}
