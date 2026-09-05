/**
 * lib/ingest.ts — 移植自已移除的 workflow_db/ingest.py(迁移前 343 行)。
 *
 * 核心流程:
 *   1. 文件遍历(fs/promises readdir recursive)
 *   2. 变化检测(size/mtime 对比 load_existing_index)
 *   3. 对变化文件调 parseFn(由调用方注入 parse worker 调用)
 *   4. mongoose bulkWrite($pull 旧 + $set/$push/$inc 新 + upsert)
 *   5. 删除清理($pull 已删除文件 + delete empty batches)
 *   6. 后处理:stats_summary 重建 + recipe_groups 局部重建
 *
 * parseFn 注入设计:lib 层不直接依赖 ParseWorkerService,
 * 由 service/controller 注入(解耦 + 可测试)。
 *
 * 数据流:orchestration.service 的 sync_loop 周期性调用 ingest(),
 * 产出 IngestSummary 供 /api/sync-status 与日志;批写路径与
 * archive.ts 的单条路径(watcher/comfy 归档)共享 Mongo 集合与
 * SQLite 镜像库,同一批元素只会被其中一条路径改写($pull+$push 幂等)。
 * 全函数围绕"增量"设计:skip 复用旧记录,changed/new 重解析,
 * 删除/移动由清理阶段兜底,双形式路径(/mnt/d vs D:\)贯穿全程去重。
 */
import { readdir, realpath, stat } from 'fs/promises';
import type { Stats } from 'fs';
import { join, relative, resolve, extname } from 'path';
import { Model } from 'mongoose';
import type Database from 'better-sqlite3';
import { buildRecipeKey } from './recipe_keys';
import {
  buildStatsCacheDocument,
  rebuildStatsSummaryCache,
  statsSummaryReady,
  rebuildStatsSummaryCacheSqlite,
  statsSummaryReadySqlite,
} from './stats_cache';
import {
  rebuildRecipeGroups,
  rebuildRecipeGroupsSqlite,
} from './recipe_groups';
import { isAccessiblePath, normalizePathForPlatform } from './paths';
import { validateRecord } from '../contracts/record';
import { isValidMetadataSidecars } from '../schemas/images.schema';
import {
  BatchWrite,
  StatsDocWrite,
  buildScanIndex,
  deleteEmptyBatches,
  removeExactPaths,
  removeResolvedPaths,
  statsDocWriteFromCache,
  upsertBatchAndChildren,
  upsertStatsDoc,
} from '../sqlite/repo';
import { withTransaction } from '../sqlite/db';
import { InstanceStamp, stampImageEntry } from './instance';

/** 参与扫描的图片扩展名白名单(与 parser 端一致,大小写不敏感)。 */
const IMAGE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg']);

/**
 * mtime_ns 比较容差(1ms)。与 flushPending 一致:
 * DB 值来自 Python st_mtime_ns 经 JSON double 序列化,扫描值来自
 * Node mtimeMs(double)* 1e6 floor,两条 double 舍入路径存在数百 ns 噪声,
 * 精确相等会导致几乎全部 skip 未命中(实测 diff=256ns)。
 * 1ms 容差既吸收噪声,又远小于真实文件修改间隔(毫秒级写入场景
 * 才会误判 skip——对入库准确性无影响,仅影响 skip 计数)。
 */
const MTIME_TOLERANCE_NS = 1_000_000;

/**
 * Mongo 批量操作缓冲兜底上限:任何情况下(含 skipMongo 误用、
 * dryRun 预览、flush 被跳过)都不允许 operations 数组无界增长。
 * 达到该值时 flushBatchIfFull 强制落盘/清空。
 * 注意:MAX_OPERATIONS 是"兜底"而非"主触发器"——正常路径由
 * batchSize(默认 500)驱动,此上限只在 batchSize 被改大或 flush
 * 被跳过时截断,防大库首扫 OOM。
 */
const MAX_OPERATIONS = 5000;

/**
 * 扫描产出的单文件条目(iterInventoryFiles 的 yield 类型)。
 * path/resolvedPath 为扫描路径,relativePath 供诊断,
 * sizeBytes/mtimeNs 供变化检测与指纹索引。
 */
interface InventoryEntry {
  /** 拼接出的扫描路径(可能含未解析的符号链接前缀)。 */
  path: string;
  /** resolve() 后的绝对路径(入库与去重基准)。 */
  resolvedPath: string;
  /** 相对扫描根的路径(诊断/日志用)。 */
  relativePath: string;
  /** 文件字节数(移动/重命名指纹的第一分量)。 */
  sizeBytes: number;
  /** mtime 纳秒(变化检测与指纹匹配的第二分量)。 */
  mtimeNs: number;
}

/**
 * 库中已有记录的最小索引形态(byPath 的 value)。
 * 字段可选:历史数据可能缺 size/mtime(早期入库),语义按"未知"处理。
 */
interface ExistingIndexEntry {
  sizeBytes?: number;
  mtimeNs?: number;
  batchKey?: string;
  recipeKey?: string;
  /** 该元素在库中的存储路径(用于移动检测后的 $pull / stats_docs 删除)。 */
  storedPath?: string;
}

/**
 * 已有记录索引:
 *   - byPath:变化检测(双路径形式注册)
 *   - byFingerprint:按 sizeBytes 分桶,移动/重命名识别时再按 mtime 容差过滤
 *     (mtime_ns 经 double 换算有数百 ns 噪声,见 MTIME_TOLERANCE_NS);
 *     只对 sizeBytes/mtimeNs 均 >0 的元素注册(飞行前检查已确认指纹齐全)。
 *   - storedFormsByNorm:归一化路径 → 库中实际存储形式集合(→ recipe_key),
 *     用于双形式存储(/mnt/d 与 D:\ 重复元素)惰性去重。
 */
interface ExistingIndex {
  /** 存储路径(含归一化变体)→ 元素索引;变化检测的第一入口。 */
  byPath: Map<string, ExistingIndexEntry>;
  /** size 分桶 → 元素列表;移动/重命名识别的第二入口。 */
  byFingerprint: Map<number, ExistingIndexEntry[]>;
  /** 归一化路径 → {实际存储形式 → recipe_key};双形式去重入口。 */
  storedFormsByNorm: Map<string, Map<string, string>>;
}

/** 单次 ingest 的结果摘要(返回给 /api/sync-status 与日志)。 */
export interface IngestSummary {
  /** 本次扫描根目录。 */
  scan_root: string;
  /** 扫描发现的图片文件总数。 */
  discovered: number;
  /** 未变化的文件数(复用旧记录,未解析)。 */
  skipped: number;
  /** 全新文件数(库中无记录且未命中移动识别)。 */
  new: number;
  /** 内容变化的文件数(含移动/重命名,旧记录已被 $pull)。 */
  changed: number;
  /** 从磁盘消失、被清理的文件数(按归一化路径去重计数)。 */
  removed: number;
  /** 双形式存储去重:被清理的重复元素个数(/mnt/d 与 D:\ 同文件双份)。 */
  deduped: number;
  /** 是否启用了删除清理(limit>0 的受限扫描不清理)。 */
  allow_deletes: boolean;
  /** 实际调用 parseFn 成功的文件数。 */
  parsed: number;
  /** 解析失败的文件数。 */
  failed: number;
  /** 解析失败明细(最多 20 条,error 截断 200 字符)。 */
  failures: Array<{ path: string; error: string }>;
  /** 单批 flush 的批量大小(500)。 */
  batch_size: number;
  /** 是否为预览模式(只统计不落盘)。 */
  dry_run: boolean;
  /** bulkWrite upsert 计数(动态追加,见函数尾部)。 */
  upserted?: number;
  /** bulkWrite modified 计数。 */
  modified?: number;
  /** bulkWrite matched 计数。 */
  matched?: number;
  /** bulkWrite delete 计数。主库删除走 $pull($pull 计入上面 modified)+
   *  空批 deleteMany(计入 deleted_empty_batches),bulkWrite 内无独立
   *  deleteOne,故本字段通常为 0;removed 才是"移除条目数"的权威口径。 */
  deleted?: number;
  /** Mongo 清空的空批次文档数。 */
  deleted_empty_batches?: number;
  /** SQLite 清空的空批次数。 */
  sqlite_deleted_empty_batches?: number;
  /** stats_summary 重建结果(Mongo 版,有刷新时才存在)。 */
  stats_cache?: Record<string, unknown>;
  /** recipe_groups 重建结果(Mongo 版)。 */
  recipe_groups?: Record<string, unknown>;
  /** stats_summary 重建结果(SQLite 版)。 */
  sqlite_stats_cache?: Record<string, unknown>;
  /** recipe_groups 重建结果(SQLite 版)。 */
  sqlite_recipe_groups?: Record<string, unknown>;
}

/** 同步过程中的实时进度(与旧版 GET /api/sync-status 的 progress 契约一致)。 */
export interface SyncProgress {
  /** 当前阶段:'scan' / 'cleanup'(与 emitProgress 的调用点对应)。 */
  stage: string;
  discovered: number;
  skipped: number;
  new: number;
  changed: number;
  removed: number;
  failed: number;
  parsed: number;
}

/**
 * 递归遍历目录,产出图片文件条目。
 * 复刻 Python iter_inventory_files。
 *
 * @param root  扫描根目录
 * @param limit 产出上限(0=无限;limit>0 时同时关闭删除清理,
 *              用于受限/预览扫描)
 * @yields InventoryEntry(迭代式,配合 for await 边扫边处理,
 *         不把全目录条目载入内存)
 *
 * 内部逻辑:
 *   1. 显式栈 DFS(readdir 结果入栈)
 *   2. 符号链接按**目标真实类型**分流(stat 跟随链接,Dirent 判定不可靠):
 *      - 指向目录 → 压栈目标真实路径(而非链接路径)
 *      - 指向文件 → 按文件参与扩展名过滤与产出
 *      - 悬空/非常规 → 跳过
 *   3. 压真实路径带来两项确定性:
 *      - 环防护:目录间互链、自指链接的 realpath 相同,出栈时命中
 *        expandedDirs 即跳过,不死循环
 *      - 路径稳定:同一目录经任意链接到达都以同一 resolved_path 入库,
 *        不再受「链接名 vs 真实目录名」字母序影响
 *   4. 不可读目录(读权限不足)与 stat 失败(竞态删除)安全跳过
 *   5. 文件过滤:非 file 跳过;扩展名不在 IMAGE_EXTENSIONS 跳过
 *   6. mtimeNs 由 mtimeMs(double 毫秒)× 1e6 取整而来——与 Python
 *      st_mtime_ns 存在 double 舍入差,由 MTIME_TOLERANCE_NS 吸收
 *   7. 到达 limit 立即 return(不再继续展开栈)
 */
async function* iterInventoryFiles(
  root: string,
  limit = 0,
): AsyncGenerator<InventoryEntry> {
  let yielded = 0;
  const stack: string[] = [root];
  // 符号链接环防护:已展开(读过内容)目录的 realpath 集合。目录(含符号
  // 链接)出栈展开前先解析真实路径,已展开则跳过——目录间互相链接的环、
  // 指向已遍历目录的符号链接都不会被重复遍历,防死循环挂死。
  const expandedDirs = new Set<string>();

  while (stack.length > 0) {
    const currentDir = stack.pop()!;
    let currentReal = '';
    try {
      currentReal = await realpath(currentDir);
    } catch {
      continue; // 悬空链接/不可解析目录:跳过
    }
    if (expandedDirs.has(currentReal)) continue; // 环或已展开目录
    expandedDirs.add(currentReal);
    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue; // 读权限不足等:跳过该目录
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      // 已解析的 stat(仅符号链接分支需要提前探测,复用给文件分支避免二次 stat)
      let preStats: Stats | null = null;

      if (entry.isSymbolicLink()) {
        // Dirent 的类型判定对链接不可靠(isDirectory() 恒为 false),必须用
        // stat(跟随链接)探测目标真实类型,再分流:
        //   目录 → 压栈目标**真实路径**而非链接路径
        //   文件 → 落到下方文件分支
        //   其他/悬空 → 跳过
        try {
          preStats = await stat(fullPath);
        } catch {
          continue; // 悬空链接:目标不存在
        }
        if (preStats.isDirectory()) {
          // 压真实路径:同一目录无论经多少个链接到达,都以同一个
          // resolved_path 入库 —— 否则「链接名 vs 真实目录名」的字母序
          // 会决定 DFS 先展开谁,进而决定入库路径,改名即可引发路径跳变。
          try {
            stack.push(await realpath(fullPath));
          } catch {
            continue; // 竞态删除:目标已消失
          }
          continue;
        }
        if (!preStats.isFile()) continue; // socket/FIFO 等非常规目标
        // 指向文件的链接:落文件分支(旧实现一律压栈,下轮 readdir 抛
        // ENOTDIR 被吞 → 这类图片永远不会被扫描入库)
      } else if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      } else if (!entry.isFile()) {
        continue; // socket/FIFO 等非常规条目
      }

      if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

      let stats = preStats;
      if (!stats) {
        try {
          stats = await stat(fullPath);
        } catch {
          continue; // 竞态删除/权限:跳过该文件
        }
      }

      const resolvedPath = resolve(fullPath);
      const relativePath = relative(root, fullPath);
      yielded += 1;
      // Node.js Stats 有 mtimeMs(浮点毫秒),转纳秒与 Python st_mtime_ns 对齐
      const mtimeNs = Math.floor(stats.mtimeMs * 1e6);
      yield {
        path: fullPath,
        resolvedPath,
        relativePath,
        sizeBytes: stats.size,
        mtimeNs,
      };

      if (limit > 0 && yielded >= limit) return;
    }
  }
}

/**
 * 读取已有批次文档,构建 (resolved_path -> file_info) 索引。
 * 复刻 Python load_existing_index。
 *
 * 跨平台:历史数据可能以 /mnt/d/... 或 D:\... 两种形式入库,
 * 索引同时覆盖两种前缀,键也按两种形式分别注册,避免同一文件
 * 因路径形式不同被重复判定为新文件。
 *
 * @param imagesModel images 集合 Model
 * @param scanRoot    扫描根目录(前缀过滤基准)
 * @returns ExistingIndex(byPath/byFingerprint/storedFormsByNorm 三索引)
 *
 * 内部逻辑:
 *   1. 前缀归一:resolve(scanRoot) + normalizePathForPlatform +
 *      反斜杠变体(win32 下 D:/x 与 D:\x 并存,索引必须三前缀全覆盖,
 *      否则索引恒空 → 全量误判 new)
 *   2. 正则转义前缀后 $regex 前缀匹配(注意模板串中需双反斜杠,
 *      运行时正则才是 [\\/];写成 [\/] 反斜杠路径永远不匹配)
 *   3. 游标读取投影字段(batch_key/recipe_key/每图 file 三字段)
 *   4. 逐元素构建 entry,按 [原路径, 归一化路径] 双键注册 byPath;
 *      归一化形式 → 存储形式集合(storedFormsByNorm);
 *      指纹仅对 size/mtime 均 >0 的元素注册(飞行前检查)
 *
 * 边界:历史缺 size/mtime 的元素进不了指纹索引——它们永远无法被
 * 移动识别,按新文件处理(重新解析,代价可接受)。
 */
async function loadExistingIndex(
  imagesModel: Model<unknown>,
  scanRoot: string,
): Promise<ExistingIndex> {
  const prefix = resolve(scanRoot);
  const normPrefix = normalizePathForPlatform(prefix);
  // Windows 盘符正斜杠形式(D:/x)在 win32 下 normalizePathForPlatform 不转换,
  // 而 path.join 入库为反斜杠形式(D:\x)——补反斜杠变体,否则索引恒空全量重判 new
  const backslashPrefix = /^[A-Za-z]:\//.test(prefix)
    ? prefix.replace(/\//g, '\\')
    : prefix;
  // 转义正则元字符,把路径当字面量前缀匹配
  const escaped = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const byPath = new Map<string, ExistingIndexEntry>();
  const byFingerprint = new Map<number, ExistingIndexEntry[]>();
  const storedFormsByNorm = new Map<string, Map<string, string>>();

  // 前缀过滤:只拉扫描根下的记录(全库扫描时降 IO)
  const cursor = imagesModel.collection.find(
    {
      'images.file.resolved_path': {
        // 注意:模板串中需两个转义反斜杠,运行时正则才是 [\\/](匹配 \ 或 /);
        // 写成 [\/] 时运行时只剩转义的 /,反斜杠路径永远不匹配(索引为空)。
        $regex: `^(${escaped(prefix)}|${escaped(normPrefix)}|${escaped(backslashPrefix)})[\\\\/]`,
      },
    },
    {
      projection: {
        _id: 0,
        batch_key: 1,
        recipe_key: 1,
        'images.file.resolved_path': 1,
        'images.file.size_bytes': 1,
        'images.file.mtime_ns': 1,
      },
    },
  );

  for await (const doc of cursor) {
    const d = doc as {
      batch_key?: string;
      recipe_key?: string;
      images?: Array<{
        file?: {
          resolved_path?: string;
          size_bytes?: number;
          mtime_ns?: number;
        };
      }>;
    };
    for (const image of d.images ?? []) {
      const file = image.file;
      const path = file?.resolved_path;
      if (!path) {
        continue; // 无路径元素无法参与变化检测
      }
      const entry: ExistingIndexEntry = {
        batchKey: d.batch_key ?? '',
        recipeKey: d.recipe_key ?? '',
        sizeBytes: file.size_bytes ?? 0,
        mtimeNs: file.mtime_ns ?? 0,
        storedPath: path,
      };
      // 两种路径形式注册为同一文件的键
      byPath.set(path, entry);
      const norm = normalizePathForPlatform(path);
      if (norm !== path) {
        byPath.set(norm, entry);
      }
      // 归一化路径 → 实际存储形式集合(双形式存储检测)
      let forms = storedFormsByNorm.get(norm);
      if (!forms) {
        forms = new Map<string, string>();
        storedFormsByNorm.set(norm, forms);
      }
      forms.set(path, d.recipe_key ?? '');
      // 指纹索引:按 size 分桶,mtime 在识别时按容差过滤;
      // 每个存储路径只注册一次(不按双形式重复注册)
      if (entry.sizeBytes! > 0 && entry.mtimeNs! > 0) {
        const list = byFingerprint.get(entry.sizeBytes!);
        if (list) {
          list.push(entry);
        } else {
          byFingerprint.set(entry.sizeBytes!, [entry]);
        }
      }
    }
  }
  return { byPath, byFingerprint, storedFormsByNorm };
}

/**
 * 主 ingest 函数。
 *
 * @param parseFn 由调用方注入的 parse 函数(通常调 parse_worker JSON-RPC)
 *
 * @param scanRoot          扫描根目录
 * @param imagesModel       images 集合 Model(Mongo 批写目标)
 * @param statsDocsModel    stats_docs 集合 Model(统计投影批写目标)
 * @param statsSummaryModel stats_summaries 集合 Model(尾部汇总重建目标)
 * @param recipeGroupModel  recipe_groups 集合 Model(尾部组重建目标)
 * @param parseFn           (path, scanRoot) => record;失败抛错会被捕获计数
 * @param options           可选控制:
 *   - limit:产出上限(>0 同时关闭删除清理,用于受限扫描)
 *   - batchSize:单批 flush 的文件数/操作数阈值(默认 500)
 *   - dryRun:预览模式(全流程只统计不落盘)
 *   - onProgress:实时进度回调(每文件触发一次,供 /api/sync-status)
 *   - sqliteDb:SQLite 镜像库(提供时写路径同时落 SQLite)
 *   - skipMongo:SQLite 单引擎(索引/写/删全部走 SQLite,不碰 Mongo)
 *   - instance:多网关打标(逐图写 source{instance_id,base_url})
 * @returns IngestSummary 摘要(计数 + 失败明细 + 重建结果)
 *
 * 阶段总览:
 *   A. 建索引(skipMongo 走 buildScanIndex,否则 loadExistingIndex)
 *   B. 扫描循环:skip 判定 → 移动识别 → parseFn → 组批操作(内存缓冲)
 *   C. 删除清理(仅 allowDeletes):已消失文件 $pull + stats_doc 删除
 *   D. 尾批 flush + 空批清理
 *   E. stats_summary 重建(有变更或缓存未就绪时)
 *   F. recipe_groups 局部重建(affectedRecipeKeys 非空时)
 * 内存上界:operations ≤ max(batchSize, MAX_OPERATIONS),SQLite pending
 * 以 batch_key 为键、filesSinceFlush 驱动落盘。
 */
export async function ingest(
  scanRoot: string,
  imagesModel: Model<unknown>,
  statsDocsModel: Model<unknown>,
  statsSummaryModel: Model<unknown>,
  recipeGroupModel: Model<unknown>,
  parseFn: (path: string, scanRoot: string) => Promise<Record<string, unknown>>,
  options: {
    limit?: number;
    batchSize?: number;
    dryRun?: boolean;
    /** 实时进度回调(每处理一个文件后触发,供 /api/sync-status 展示)。 */
    onProgress?: (progress: SyncProgress) => void;
    /** SQLite 镜像库(双写过渡):提供时写路径同时落 SQLite。 */
    sqliteDb?: Database.Database;
    /** SQLite 单引擎(SQLITE_READ=1):跳过全部 Mongo 读写,索引取自 SQLite。 */
    skipMongo?: boolean;
    /** 多网关实例打标:逐图片写入 source{instance_id,base_url}。 */
    instance?: InstanceStamp;
  } = {},
): Promise<IngestSummary> {
  const limit = options.limit ?? 0;
  const batchSize = options.batchSize ?? 500;
  const dryRun = options.dryRun ?? false;
  const onProgress = options.onProgress;
  const sqliteDb = options.sqliteDb;
  const skipMongo = options.skipMongo ?? false;

  // ---- 统计计数(扫描循环 + 清理阶段累计,最终并入 summary) ----
  let discovered = 0;
  let parsed = 0;
  let skipped = 0;
  let newFiles = 0;
  let changedFiles = 0;
  let removedFiles = 0;
  let failed = 0;
  let written = 0;
  let modified = 0;
  let matched = 0;
  let deleted = 0;
  let deduped = 0;

  const failures: Array<{ path: string; error: string }> = [];
  /** B3.3 zod 运行时校验告警(仅记录,不阻断写入)。 */
  const recordIssues: Array<{ path: string; issues: string[] }> = [];
  /** Mongo 批写缓冲(bulkWrite 操作数组,flush 时清空)。 */
  const operations: Array<Record<string, unknown>> = [];
  /** stats_docs 批写缓冲(与 operations 同生命周期)。 */
  const statsCacheOperations: Array<Record<string, unknown>> = [];
  /** 本次涉及的 recipe_key 集合(尾部局部重建输入)。 */
  const affectedRecipeKeys = new Set<string>();

  /**
   * Mongo 批量操作缓冲仅服务于 Mongo 写入:skipMongo(SQLite 单引擎)下
   * 不 push,删除/去重直接走 sqliteStalePaths/sqliteRemovePaths 已有机制,
   * 避免大库首扫时 operations 无界增长 OOM。
   */
  const pushMongoOp = (op: Record<string, unknown>): void => {
    if (skipMongo) return;
    operations.push(op);
  };
  const pushStatsCacheOp = (op: Record<string, unknown>): void => {
    if (skipMongo) return;
    statsCacheOperations.push(op);
  };
  /** 自上次 flush 起处理的文件数:skipMongo 下 operations 恒为空,
   * 须以文件数驱动 SQLite pending/removals 批量落盘(内存上界 = batchSize)。 */
  let filesSinceFlush = 0;

  // ---- SQLite 双写状态(最终态覆盖):batch 级 pending + 待删除路径 ----
  /**
   * SQLite 单批 pending:按 batch_key 聚合的"最后一帧"写入状态。
   * 同一 batch 的多张图在同一轮扫描中只落一次盘(last-write-wins
   * 字段 + 逐路径 images Map),与 Mongo 的逐文件 $push 语义最终等价。
   */
  interface SqlitePending {
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
    /** 逐 resolved_path → image entry(批内唯一,追加顺序 = 扫描顺序)。 */
    images: Map<string, Record<string, unknown>>;
    /** 逐 stats_doc _id → 写入载荷。 */
    statsDocs: Map<string, StatsDocWrite>;
  }
  const sqlitePending = new Map<string, SqlitePending>();
  /** 待删除路径(整库精确删除:与 Mongo 的 $pull+$in 对齐)。 */
  const sqliteRemovePaths = new Set<string>();
  /** 双形式去重:stale 形式精确删除(与 Mongo $pull $in 对齐,不做跨形式展开)。 */
  const sqliteStalePaths = new Set<string>();

  /**
   * SQLite pending 落盘:事务内逐 batch 重写(batch + 子表 + stats_doc)。
   * 由 flushBatchIfFull / 尾批 flush 调用;pending 为空时零开销。
   */
  const flushSqlitePending = (): void => {
    if (!sqliteDb || sqlitePending.size === 0) return;
    const db = sqliteDb;
    // 增量合并预编译:按 batch_key 读库中已有图片(与 pending 合并后整批 REPLACE)
    const selectExistingImages = db.prepare(
      'SELECT resolved_path, image_json FROM batch_images WHERE batch_key = ?',
    );
    // 取出即清空:落盘失败时该批记录丢失,由下轮 sync 重扫兜底
    const pending = [...sqlitePending.values()];
    sqlitePending.clear();
    withTransaction(db, () => {
      for (const p of pending) {
        // 合并库中已有同批次图片:REPLACE 是整批覆盖,若只含本次解析的
        // 部分图会清掉库中未变图(下轮又判 new,重复入库死循环);
        // Mongo 侧 $pull/$push 增量无此问题,SQLite 需在此补齐
        // (pending 内同路径已存在时保持后写者胜,不覆盖)。
        for (const row of selectExistingImages.all(p.batchKey) as Array<{
          resolved_path: string;
          image_json: string;
        }>) {
          if (!p.images.has(row.resolved_path)) {
            try {
              p.images.set(row.resolved_path, JSON.parse(row.image_json));
            } catch {
              // 脏行忽略:由下轮 sync 重扫兜底
            }
          }
        }
        const images = [...p.images.values()];
        const batch: BatchWrite = {
          batchKey: p.batchKey,
          capturedAt: p.capturedAt,
          createdDate: p.createdDate,
          createdHour: p.createdHour,
          createdWeekday: p.createdWeekday,
          recipeKey: p.recipeKey,
          model: p.model,
          loras: p.loras,
          prompts: p.prompts,
          samplers: p.samplers,
          latent: p.latent,
          batchCount: images.length,
          images,
          // lora 关联表列:仅取 names(去空串)
          loraNames: (
            (p.loras as { names?: string[] } | undefined)?.names ?? []
          ).filter(Boolean) as string[],
          // doc_json:与 Mongo 文档字段逐字一致(读端反序列化直接可用)
          docJson: JSON.stringify({
            batch_key: p.batchKey,
            captured_at: p.capturedAt,
            created_date: p.createdDate,
            created_hour: p.createdHour,
            created_weekday: p.createdWeekday,
            model: p.model,
            loras: p.loras,
            prompts: p.prompts,
            samplers: p.samplers,
            latent: p.latent,
            recipe_key: p.recipeKey,
            batch_count: images.length,
            images,
          }),
        };
        upsertBatchAndChildren(db, batch, null);
        // 同批的 stats_doc 更新一起落盘(同一事务)
        for (const sd of p.statsDocs.values()) {
          upsertStatsDoc(db, sd);
        }
      }
    });
  };

  /**
   * SQLite 删除落盘:待删除路径(removeResolvedPaths 展开路径匹配)
   * 与 stale 形式(removeExactPaths 精确匹配)分两类清理。
   */
  const flushSqliteRemovals = (): void => {
    if (!sqliteDb) return;
    if (sqliteRemovePaths.size > 0) {
      removeResolvedPaths(sqliteDb, [...sqliteRemovePaths]);
      sqliteRemovePaths.clear();
    }
    if (sqliteStalePaths.size > 0) {
      removeExactPaths(sqliteDb, [...sqliteStalePaths]);
      sqliteStalePaths.clear();
    }
  };

  // 建索引:skipMongo 用 SQLite 全扫,否则 Mongo 前缀查询
  const existingIndex = skipMongo
    ? buildScanIndex(sqliteDb as Database.Database, scanRoot)
    : await loadExistingIndex(imagesModel, scanRoot);
  /** 本次扫描产出的全部解析后路径(删除清理的"存在集")。 */
  const currentPaths = new Set<string>();
  // limit>0 的受限扫描不做删除清理(只扫部分目录,不能把"未见"当"已删")
  const allowDeletes = limit <= 0;
  // 移动/重命名文件的旧存储路径(已从 byFingerprint 识别),删除清理阶段跳过
  const movedStoredPaths = new Set<string>();

  /** 实时进度上报(skip / parse / cleanup 三处调用,onProgress 为空时零开销)。 */
  const emitProgress = (stage: string): void => {
    if (!onProgress) return;
    onProgress({
      stage,
      discovered,
      skipped,
      new: newFiles,
      changed: changedFiles,
      removed: removedFiles,
      failed,
      parsed,
    });
  };

  /** 批量落盘:operations 达到 batchSize(或 MAX_OPERATIONS 兜底)时 flush(供解析路径与 skip 路径共用)。 */
  const flushBatchIfFull = async (): Promise<void> => {
    filesSinceFlush += 1;
    // 兜底上限:任何配置下都不允许操作数组无界增长
    const overCap =
      operations.length >= MAX_OPERATIONS ||
      statsCacheOperations.length >= MAX_OPERATIONS;
    if (dryRun) {
      // dryRun 只预览不落盘;数组兜底清理防大库预览 OOM
      if (overCap) {
        operations.length = 0;
        statsCacheOperations.length = 0;
      }
      return;
    }
    // 双阈值:操作数达到 batchSize 或 自上次 flush 处理文件数达到 batchSize
    // (后者覆盖 skip 密集场景——skip 不产生操作,但 SQLite pending 仍需落盘)
    if (
      !overCap &&
      operations.length < batchSize &&
      filesSinceFlush < batchSize
    ) {
      return;
    }
    filesSinceFlush = 0;
    if (!skipMongo && operations.length > 0) {
      // 非 ordered 批量:单条失败不阻断整批(变化检测幂等,下轮重扫)
      const result = await imagesModel.collection.bulkWrite(
        operations as never,
        { ordered: false },
      );
      written += result.upsertedCount ?? 0;
      modified += result.modifiedCount ?? 0;
      matched += result.matchedCount ?? 0;
      deleted += result.deletedCount ?? 0;
      if (statsCacheOperations.length > 0) {
        await statsDocsModel.collection.bulkWrite(
          statsCacheOperations as never,
          { ordered: false },
        );
      }
    }
    // operations 仅用于 Mongo 写入:落库(或 skipMongo/dryRun 丢弃)后一律清空
    operations.length = 0;
    statsCacheOperations.length = 0;
    flushSqlitePending();
    flushSqliteRemovals();
  };

  /**
   * 双形式存储去重:同一文件以 /mnt/d 与 D:\ 两种形式重复入库时,
   * 保留当前扫描形式,$pull 其余形式并删除其 stats_docs、纳入 recipe 重建。
   * skip 与 parse 两条路径都调用;stale 为空时零开销。
   *
   * @param normKey  归一化路径(双形式的公共键)
   * @param keepPath 本次扫描命中的形式(保留它,其余全清)
   */
  const issueStaleFormDedupe = (normKey: string, keepPath: string): void => {
    const formsMap = existingIndex.storedFormsByNorm.get(normKey);
    if (!formsMap) return;
    // stale = 库中存在但非当前扫描形式的所有存储形式
    const stale = [...formsMap.keys()].filter((f) => f !== keepPath);
    if (stale.length === 0) return;
    deduped += stale.length;
    // SQLite 镜像:stale 精确删除(与 Mongo $pull 的 $in 对齐)
    for (const f of stale) sqliteStalePaths.add(f);
    pushMongoOp({
      updateMany: {
        filter: { 'images.file.resolved_path': { $in: stale } },
        update: {
          $pull: { images: { 'file.resolved_path': { $in: stale } } },
        },
      },
    });
    // stale 形式对应统计投影删除 + recipe 重建(避免统计/聚合残留脏数据)
    for (const f of stale) {
      pushStatsCacheOp({ deleteOne: { filter: { _id: f } } });
      const rk = formsMap.get(f)?.trim() ?? '';
      if (rk) affectedRecipeKeys.add(rk);
    }
  };

  // ---- 扫描主循环:逐文件 skip 判定 / 移动识别 / 解析 / 组批 ----
  for await (const entry of iterInventoryFiles(scanRoot, limit)) {
    discovered += 1;
    // 登记"当前存在"集合(删除清理阶段反向判定)
    currentPaths.add(entry.resolvedPath);

    const normKey = normalizePathForPlatform(entry.resolvedPath);
    // 变化检测入口:双键查找(解析后形式优先,归一化形式兜底)
    const existing =
      existingIndex.byPath.get(entry.resolvedPath) ??
      existingIndex.byPath.get(normKey);
    // 库里必须已存在当前扫描形式的记录才允许 skip;
    // 仅有旧形式(如 wsl-only)时落入 parse 路径,重建当前形式记录
    const hasCurrentForm =
      existingIndex.storedFormsByNorm.get(normKey)?.has(entry.resolvedPath) ??
      false;
    // skip 三条件:有记录 && 记录含当前形式 && size+mtime 匹配
    // (mtime 用容差比较吸收 double 噪声;size 精确相等——同文件尺寸必相同)
    if (
      existing &&
      hasCurrentForm &&
      existing.sizeBytes === entry.sizeBytes &&
      Math.abs((existing.mtimeNs ?? 0) - entry.mtimeNs) < MTIME_TOLERANCE_NS
    ) {
      skipped += 1;
      // 双形式存储去重:当前形式已是最新,清理其余历史形式
      issueStaleFormDedupe(normKey, entry.resolvedPath);
      await flushBatchIfFull(); // skip 也推进 flush 计数(驱动 SQLite 落盘)
      emitProgress('scan');
      continue;
    }

    // 移动/重命名识别:路径未命中但指纹命中(size 分桶 + mtime 容差),
    // 且旧位置确已不在磁盘(isAccessiblePath 守卫:旧位置仍在 =
    // 保留 mtime 的拷贝,按新文件处理)。移动文件仍需重新解析
    // (sha256 是路径哈希,record 需按新路径重建),
    // 但按 changed 计数(不再产生 removed+new 对),并即时清理旧位置记录。
    let movedFrom: ExistingIndexEntry[] = [];
    if (!existing && entry.sizeBytes > 0 && entry.mtimeNs > 0) {
      // size 分桶取出候选(只对指纹齐全的元素有效),逐候选容差过滤
      const candidates = existingIndex.byFingerprint.get(entry.sizeBytes) ?? [];
      movedFrom = candidates.filter((c) => {
        if (!c.storedPath) return false;
        // mtime 超出容差:不是同一文件(同 size 巧合)
        if (Math.abs((c.mtimeNs ?? 0) - entry.mtimeNs) >= MTIME_TOLERANCE_NS) {
          return false;
        }
        // 归一化后同路径:自身双形式,不算移动
        if (normalizePathForPlatform(c.storedPath) === normKey) return false;
        // 最终守卫:旧位置必须确已不在磁盘,否则视为"保留 mtime 的拷贝"
        return !isAccessiblePath(c.storedPath);
      });
    }

    try {
      const record = await parseFn(entry.path, scanRoot);
      parsed += 1;

      // B3.3 zod 运行时校验(守护):parser 产出结构漂移时告警,不阻断写入
      const check = validateRecord(record);
      if (!check.ok) {
        recordIssues.push({
          path: entry.path,
          issues: check.issues.slice(0, 5),
        });
      }

      // 计数:命中旧记录或移动识别 → changed;否则 new
      if (existing || movedFrom.length > 0) {
        changedFiles += 1;
      } else {
        newFiles += 1;
      }

      // 派生键值:统计投影文档 + 配方键 + 批次键
      const statsCacheRecord = buildStatsCacheDocument(record as never);
      const recipeKey = buildRecipeKey(record);

      // batch_key 优先 record.batch_key,回退 file.resolved_path,再兜底扫描路径
      const batchKey =
        (record.batch_key as string) ??
        (record.file as { resolved_path?: string })?.resolved_path ??
        entry.resolvedPath;

      // 裁剪 image entry(固定字段集,与 archive.imageEntryFromRecord 同构)
      const imageEntry: Record<string, unknown> = {};
      for (const k of [
        'captured_at',
        'created_date',
        'created_hour',
        'created_weekday',
        'file',
        'metadata',
        'workflow',
      ]) {
        if (k in record) imageEntry[k] = record[k];
      }
      // 多网关打标:image 级 source(与 file 兄弟),透传定位图片持有者
      if (options.instance) stampImageEntry(imageEntry, options.instance);
      const diagnostics = (
        imageEntry as { metadata?: { extra_diagnostics?: unknown } }
      ).metadata?.extra_diagnostics;
      if (diagnostics !== undefined && !isValidMetadataSidecars(diagnostics)) {
        throw new Error(
          'metadata.extra_diagnostics contains invalid sidecar values',
        );
      }

      // SQLite 双写:按 batch_key 累积最终态(last-write-wins 字段 + 逐路径图片)
      if (sqliteDb) {
        let pending = sqlitePending.get(batchKey);
        if (!pending) {
          // 首见:初始化整批字段,images/statsDocs 空 Map
          pending = {
            batchKey,
            capturedAt: record.captured_at,
            createdDate: record.created_date,
            createdHour: record.created_hour,
            createdWeekday: record.created_weekday,
            recipeKey,
            model: record.model ?? {},
            loras: record.loras ?? {},
            prompts: record.prompts ?? {},
            samplers: record.samplers ?? [],
            latent: record.latent ?? {},
            images: new Map(),
            statsDocs: new Map(),
          };
          sqlitePending.set(batchKey, pending);
        } else {
          // 已存在:覆盖字段(同批多文件,后写者胜)
          pending.capturedAt = record.captured_at;
          pending.createdDate = record.created_date;
          pending.createdHour = record.created_hour;
          pending.createdWeekday = record.created_weekday;
          pending.recipeKey = recipeKey;
          pending.model = record.model ?? {};
          pending.loras = record.loras ?? {};
          pending.prompts = record.prompts ?? {};
          pending.samplers = record.samplers ?? [];
          pending.latent = record.latent ?? {};
        }
        const resolvedPath = String(
          (record.file as { resolved_path?: string } | undefined)
            ?.resolved_path ?? '',
        );
        // 逐路径图片入 Map(批内唯一,Map 天然去重)
        if (resolvedPath) {
          pending.images.set(resolvedPath, imageEntry);
        }
        pending.statsDocs.set(
          String(statsCacheRecord._id ?? resolvedPath),
          statsDocWriteFromCache(statsCacheRecord as never),
        );
      }

      const existingBatchKey = existing?.batchKey;
      const existingRecipeKey = existing?.recipeKey?.trim() ?? '';
      // 同一文件可能以 /mnt/d/... 与 D:\... 两种形式入库,pull 覆盖两种
      const pathVariants = [
        ...new Set(
          [
            entry.resolvedPath,
            normalizePathForPlatform(entry.resolvedPath),
          ].filter(Boolean),
        ),
      ];

      // 旧批次摘除:该文件可能曾在别的批次(移动),从旧批次 $pull,
      // 保证文件只归属当前批次(批间唯一性)
      if (existingBatchKey) {
        pushMongoOp({
          updateOne: {
            filter: { batch_key: existingBatchKey },
            update: {
              $pull: {
                images: { 'file.resolved_path': { $in: pathVariants } },
              },
            },
          },
        });
      }
      // 新旧 recipe_key 都纳入尾部局部重建(旧组聚合结果同时失效)
      if (existingRecipeKey) affectedRecipeKeys.add(existingRecipeKey);
      affectedRecipeKeys.add(recipeKey);

      // 移动/重命名自愈:即时 $pull 旧存储位置的元素(覆盖其全部路径形式),
      // 旧路径 stats_docs 删除,旧批次 recipe_key 纳入重建;
      // 旧路径登记进 movedStoredPaths,删除清理阶段不再重复计数。
      if (movedFrom.length > 0) {
        // 旧路径展开为双形式(与索引注册规则一致,防残留单形式)
        const oldPaths = [
          ...new Set(
            movedFrom
              .flatMap((c) => [
                c.storedPath,
                normalizePathForPlatform(c.storedPath ?? ''),
              ])
              .filter(Boolean),
          ),
        ] as string[];
        // 登记:删除清理阶段跳过(避免重复计数)
        for (const p of oldPaths) movedStoredPaths.add(p);
        pushMongoOp({
          updateMany: {
            filter: { 'images.file.resolved_path': { $in: oldPaths } },
            update: {
              $pull: { images: { 'file.resolved_path': { $in: oldPaths } } },
            },
          },
        });
        // 旧路径的统计投影与 SQLite 记录一并删除
        for (const p of oldPaths) {
          pushStatsCacheOp({ deleteOne: { filter: { _id: p } } });
          sqliteRemovePaths.add(p);
        }
        // 旧位置的 recipe_key 纳入重建(该组少了一张图,聚合需刷新)
        for (const c of movedFrom) {
          const rk = c.recipeKey?.trim() ?? '';
          if (rk) affectedRecipeKeys.add(rk);
        }
      }

      // 双形式存储去重(解析路径):清理非当前形式的历史存储元素,
      // 覆盖 wsl-only 形式(仅有 /mnt/d 记录时,重推当前形式后旧形式在此清除)
      issueStaleFormDedupe(normKey, entry.resolvedPath);

      // 目标批次 upsert:$setOnInsert 定批次身份,$set 字段覆盖,
      // $push 追加图片;batch_count 由 $inc 维护(仅真正的新元素)
      const batchUpdate: Record<string, unknown> = {
        $setOnInsert: { batch_key: batchKey },
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
        $push: { images: imageEntry },
      };
      // 移动文件净计数不变(旧元素即时 $pull),不 $inc
      if (!existing && movedFrom.length === 0) {
        batchUpdate.$inc = { batch_count: 1 };
      }

      // 批内去重:先清除目标批次内该路径的所有形式,再 push,保证批内唯一
      pushMongoOp({
        updateOne: {
          filter: { batch_key: batchKey },
          update: {
            $pull: { images: { 'file.resolved_path': { $in: pathVariants } } },
          },
        },
      });
      pushMongoOp({
        updateOne: {
          filter: { batch_key: batchKey },
          update: batchUpdate,
          upsert: true,
        },
      });

      // 统计投影 upsert(以 resolved_path 为 _id,整体覆盖)
      pushStatsCacheOp({
        updateOne: {
          filter: { _id: statsCacheRecord._id },
          update: { $set: statsCacheRecord },
          upsert: true,
        },
      });

      await flushBatchIfFull();
      emitProgress('scan');
    } catch (exc) {
      // 单文件失败不中断扫描:计数 + 明细(截断 200 字符)
      failed += 1;
      const errMsg = exc instanceof Error ? exc.message : String(exc);
      failures.push({ path: entry.path, error: errMsg.slice(0, 200) });
      emitProgress('scan');
    }
  }

  // 删除清理:按文件(归一化路径)去重,避免同一文件双路径形式被重复计数。
  // existingIndex 对同一文件注册两种路径形式(resolved + normalizePathForPlatform),
  // 历史数据中同一文件可能同时以 /mnt/d/... 与 D:\... 两种形式存于不同批次,
  // 而 currentPaths 只含扫描产出的解析后形式;因此以「key 或其归一化形式
  // 不在 currentPaths」判断文件已从磁盘消失,并按归一化路径合并计数。
  // $pull 操作仍按全部存储形式下发(幂等,兼容两种历史路径形式)。
  const removedByNorm = new Map<string, string[]>();
  if (allowDeletes) {
    for (const [storedPath] of existingIndex.byPath) {
      // 移动/重命名的旧路径已在扫描循环内即时清理,不再计入 removed
      if (movedStoredPaths.has(storedPath)) {
        continue;
      }
      // 存在性判定:扫描产出的解析后形式 或 其归一化形式 命中任一即"还在"
      const present =
        currentPaths.has(storedPath) ||
        currentPaths.has(normalizePathForPlatform(storedPath));
      if (present) {
        continue;
      }
      // 按归一化路径归组:同一文件的双形式只计一次 removed
      const norm = normalizePathForPlatform(storedPath);
      const forms = removedByNorm.get(norm);
      if (forms) {
        forms.push(storedPath);
      } else {
        removedByNorm.set(norm, [storedPath]);
      }
    }
  }
  // 展平 + 排序(确定性顺序,日志/删除可复现)
  const removedPaths = [...removedByNorm.values()].flat().sort();
  removedFiles = removedByNorm.size;
  emitProgress('cleanup');

  if (removedPaths.length) {
    for (const resolvedPath of removedPaths) {
      const existing = existingIndex.byPath.get(resolvedPath);
      const existingRecipeKey = existing?.recipeKey?.trim() ?? '';
      if (existingRecipeKey) affectedRecipeKeys.add(existingRecipeKey);
      sqliteRemovePaths.add(resolvedPath);
      pushMongoOp({
        updateOne: {
          filter: { 'images.file.resolved_path': resolvedPath },
          update: {
            $pull: { images: { 'file.resolved_path': resolvedPath } },
          },
        },
      });
    }
    // 对应统计投影批量删除(与 images $pull 一一对应)
    for (const resolvedPath of removedPaths) {
      pushStatsCacheOp({
        deleteOne: { filter: { _id: resolvedPath } },
      });
    }
  }

  // ---- 汇总构建:核心计数先行(动态计数在下方各阶段追加) ----
  const summary: IngestSummary = {
    scan_root: scanRoot,
    discovered,
    skipped,
    new: newFiles,
    changed: changedFiles,
    removed: removedFiles,
    deduped,
    allow_deletes: allowDeletes,
    parsed,
    failed,
    failures: failures.slice(0, 20),
    batch_size: batchSize,
    dry_run: dryRun,
  };

  // dryRun 提前返回:仅预览计数,不落盘不重建
  if (dryRun) return summary;

  // B3.3:打印 zod 校验告警(每个文件最多 5 条 issue,总量截断)
  if (recordIssues.length > 0) {
    const sample = recordIssues.slice(0, 10);
    for (const item of sample) {
      console.warn(
        `[ingest] record schema deviation ${item.path}: ${item.issues.join('; ')}`,
      );
    }
    if (recordIssues.length > sample.length) {
      console.warn(
        `[ingest] ... ${recordIssues.length - sample.length} more records with schema deviations (not blocking)`,
      );
    }
  }

  // 执行剩余操作:扫描循环结束后的尾批(不满 batchSize 的余量)
  if (!skipMongo && operations.length > 0) {
    const result = await imagesModel.collection.bulkWrite(operations as never, {
      ordered: false,
    });
    written += result.upsertedCount ?? 0;
    modified += result.modifiedCount ?? 0;
    matched += result.matchedCount ?? 0;
    deleted += result.deletedCount ?? 0;
  }

  if (!skipMongo && statsCacheOperations.length > 0) {
    await statsDocsModel.collection.bulkWrite(statsCacheOperations as never, {
      ordered: false,
    });
  }

  // SQLite 双写:剩余 pending flush + 删除清理 + 空批清理
  flushSqlitePending();
  flushSqliteRemovals();
  let sqliteDeletedEmptyBatches = 0;
  if (sqliteDb) {
    sqliteDeletedEmptyBatches = deleteEmptyBatches(sqliteDb);
  }

  // 清理空批次:所有 images 被 $pull 掏空的批次文档直接删除
  let emptyBatchResult = { deletedCount: 0 };
  if (!skipMongo) {
    emptyBatchResult = await imagesModel.collection.deleteMany({
      images: { $size: 0 },
    });
  }

  // 计数并入 summary
  summary.upserted = written;
  summary.modified = modified;
  summary.matched = matched;
  summary.deleted = deleted;
  summary.deleted_empty_batches = emptyBatchResult.deletedCount ?? 0;
  summary.sqlite_deleted_empty_batches = sqliteDeletedEmptyBatches;

  // stats_summary 重建(dedup 删除 stats_docs 也需要刷新汇总)
  // 触发条件:有数据变更(new/changed/removed/deduped 任一 >0)
  // 或缓存未就绪(meta 缺失:首启/缓存被清)
  const shouldRefreshStats =
    newFiles + changedFiles + removedFiles + deduped > 0 ||
    (skipMongo
      ? !statsSummaryReadySqlite(sqliteDb as Database.Database)
      : !(await statsSummaryReady(statsSummaryModel)));

  if (shouldRefreshStats) {
    // SQLite 与 Mongo 双端重建(共用 computeStatsSummaryCache,byte-equal)
    if (sqliteDb) {
      summary.sqlite_stats_cache = (await rebuildStatsSummaryCacheSqlite(
        sqliteDb,
      )) as unknown as Record<string, unknown>;
    }
    if (!skipMongo) {
      summary.stats_cache = (await rebuildStatsSummaryCache(
        statsDocsModel,
        statsSummaryModel,
      )) as unknown as Record<string, unknown>;
    }
  }

  // recipe_groups 局部重建:仅受影响 key(与全量重建相比代价 O(组数))
  if (affectedRecipeKeys.size > 0) {
    if (sqliteDb) {
      summary.sqlite_recipe_groups = (await rebuildRecipeGroupsSqlite(
        sqliteDb,
        [...affectedRecipeKeys],
      )) as unknown as Record<string, unknown>;
    }
    if (!skipMongo) {
      summary.recipe_groups = (await rebuildRecipeGroups(
        imagesModel,
        recipeGroupModel,
        [...affectedRecipeKeys],
      )) as unknown as Record<string, unknown>;
    }
  }

  return summary;
}
