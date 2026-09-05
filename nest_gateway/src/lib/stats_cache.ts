/**
 * lib/stats_cache.ts — 移植自已移除的 workflow_db/stats_cache.py 的核心缓存逻辑。
 *
 * 三个核心函数:
 *   buildStatsCacheDocument  — 从单条 record 构建 stats_doc
 *   rebuildStatsSummaryCache — 从 stats_docs 重建 stats_summaries（LoRA 频率/共现/profile/keywords/layers）
 *   rebuildStatsDocCacheFromImages — 从 images 集合重建 stats_docs（展开 images 数组）
 *
 * 辅助函数(prompt 清洗/关键词提取)与 Python 版语义对齐。
 *
 * 数据流(写路径→读路径):
 *   ingest.ts / archive.ts 在 record 入库的同时调用 buildStatsCacheDocument,
 *   stats_docs 以 resolved_path 为 _id 独立存储,避免每次统计全量扫 images;
 *   stats_summaries 由 rebuildStatsSummaryCache 从 stats_docs 全量聚合
 *   (meta / lora_frequency / prompt_keywords / lora_keywords / prompt_layers /
 *    lora_cooccurrence::X / lora_profile::X 七类文档),stats.controller 直接读;
 *   SQLite 版(SQLITE_READ=1)与 Mongo 版共用 computeStatsSummaryCache /
 *   statsDocFromBatchDoc 纯计算函数,保证双端产物 byte-equal。
 *   另有过期清理:lora_cooccurrence/lora_profile 按 activeIds 集合兜底删除。
 */
import { Model } from 'mongoose';
import type Database from 'better-sqlite3';
import { Counter } from '../utils/counter';
import { withTransaction } from '../sqlite/db';
import { imageLocationKey } from './image_location';

// ---------------------------------------------------------------------------
// 常量（与 stats_cache.py 对齐）
// ---------------------------------------------------------------------------

/**
 * 权重后缀正则:匹配行尾 `:数字`(如 `:1.2`、`:-1`),用于剥离
 * 带权重 prompt token 的权重后缀,使 `foo` 与 `foo:1.2` 归一为同一关键词。
 */
const WEIGHT_SUFFIX_RE = /:-?\d+(?:\.\d+)?$/;
/**
 * 零权重正则:匹配 `:0` / `:0.0` 及尾部残留括号/引号。
 * 零权重 token 语义上等于"不存在"(移除采样),统计时必须剔除,
 * 否则会向关键词/层统计注入噪声。
 */
const ZERO_WEIGHT_RE = /:\s*0+(?:\.0+)?\s*[\)\]\}]?\s*$/;
/** 清洗时剥离的行首尾包裹字符集合(括号/引号/空格)。 */
const WRAP_CHARS = " ()[]{}'\"";

/**
 * 质量控制词集合(负向去噪词 + 通用质量词)。
 * 与 Python 版逐字一致;这些词不承载配方语义,统计时剔除,
 * 避免 lora_keywords / prompt_keywords 被 masterpiece/watermark 刷屏。
 */
const QUALITY_CONTROL_PATTERNS = new Set([
  'masterpiece',
  'best quality',
  'high quality',
  'ultra detailed',
  'detailed',
  'very aesthetic',
  'absurdres',
  '4k',
  '8k',
  'lowres',
  'worst quality',
  'low quality',
  'normal quality',
  'bad quality',
  'bad anatomy',
  'watermark',
  'text',
  'signature',
  'blurry',
]);

// ---------------------------------------------------------------------------
// 辅助函数（prompt 清洗/关键词提取）
// ---------------------------------------------------------------------------

/**
 * prompt 行归一化清洗(与 Python 版逐字符对齐)。
 *
 * @param line 原始 prompt 行(可能含包裹括号、权重后缀、多余空格)
 * @returns 小写、去包裹字符、去权重后缀、压缩空白、逗号无空格的形式
 *
 * 清洗顺序(顺序敏感,与 Python 版一致):
 *   1. trim + toLowerCase(大小写不敏感归并)
 *   2. 去行首尾包裹字符 `()[]{}'"` 与空格
 *   3. 去尾部权重后缀 `:数字`(WEIGHT_SUFFIX_RE)
 *   4. 再次去行首尾包裹字符(权重后缀剥离后可能暴露新的包裹括号)
 *   5. 连续空白压缩为单空格
 *   6. ` ,` → `,` 且 `, ` → `,`(逗号两侧去空格,统一 token 切分形态)
 *
 * 边界:清洗结果是"关键词比较基准"而非展示文本——展示仍用原始行,
 * 归一化值只作去重与频次统计的 key。
 */
export function normalizePromptLine(line: string): string {
  let cleaned = String(line).trim().toLowerCase();
  cleaned = cleaned.replace(/^[ ()[\]{}'"]+|[ ()[\]{}'"]+$/g, '');
  cleaned = cleaned.replace(WEIGHT_SUFFIX_RE, '');
  cleaned = cleaned.replace(/^[ ()[\]{}'"]+|[ ()[\]{}'"]+$/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ');
  return cleaned.replace(/ ,/g, ',').replace(/, /g, ',');
}

/**
 * 判断一行是否为零权重条目(`:0` / `:0.0` 结尾)。
 * @param value 原始行
 * @returns true 表示该行权重为 0,统计时应剔除
 */
export function isZeroWeightEntry(value: string): boolean {
  return ZERO_WEIGHT_RE.test(String(value).trim());
}

/**
 * 词边界判定:normalized 行按逗号切分为 token,任一 token 与质量控制词
 * 完全相等才算命中。避免子串误命中(`text`→`texture`、`4k`→`4k.`)。
 *
 * @param line 原始 prompt 行
 * @returns true 表示该行含质量控制词(整行应从统计中剔除)
 */
export function lineIsQualityControl(line: string): boolean {
  const normalized = normalizePromptLine(line);
  if (!normalized) return false;
  const tokens = normalized.split(',');
  for (const token of tokens) {
    if (QUALITY_CONTROL_PATTERNS.has(token.trim())) return true;
  }
  return false;
}

/**
 * Prompt 层(已清洗、去重后)。
 * label:原始行(展示用);normalized:归一化行(统计 key)。
 */
interface PromptLayer {
  label: string;
  normalized: string;
}

/** prompt 条目结构(parser 产物 prompts.positive[] 的元素形态)。 */
interface PromptEntry {
  /** 层列表,每层含原始行数组。 */
  layers?: Array<{ lines?: string[] }>;
}

/** stats_doc 的 prompts 段结构。 */
interface StatsDocPrompts {
  positive?: PromptEntry[];
  negative?: PromptEntry[];
  search_text?: string;
}

/** stats_doc 文档形态(仅声明统计相关字段)。 */
interface StatsDoc {
  file?: {
    resolved_path?: string;
    filename?: string;
    image_name?: string;
  };
  created_date?: string;
  model?: { base_model?: string };
  loras?: { names?: string[] };
  prompts?: StatsDocPrompts;
  has_parsed_workflow?: boolean;
}

/**
 * 从 positive prompts 提取去重后的 layer（不含质量控制词和零权重）。
 * 复刻 stats_cache.py iter_positive_prompt_layers。
 *
 * @param doc 含 prompts.positive 的文档(stats_doc 或 record)
 * @returns PromptLayer[]:每层一行 {label: 原始行, normalized: 归一化行};
 *          空行/零权重/质量控制/清洗后为空的行全部剔除
 *
 * 内部逻辑:
 *   1. 遍历 positive 每个 prompt 的每层 lines
 *   2. 逐行过滤:空串 / 零权重 / 质量控制词 → 跳过(不进入统计)
 *   3. 归一化后再判空(如仅权重后缀的行,剥离后为空)
 *   4. 层内保留全部非空行后,整层进列表(label 用 \n 拼接还原)
 *
 * 边界:与 iterPromptKeywords 的区别——keywords 全局按归一化去重,
 * layers 按层聚合(保留层结构,供 lora_profile 的 prompt 关联分析)。
 */
export function iterPositivePromptLayers(
  doc: { prompts?: StatsDocPrompts },
): PromptLayer[] {
  const layers: PromptLayer[] = [];
  const positive = doc?.prompts?.positive ?? [];
  for (const prompt of positive) {
    for (const layer of prompt?.layers ?? []) {
      const originalLines: string[] = [];
      const normalizedLines: string[] = [];
      for (const line of layer?.lines ?? []) {
        const stripped = String(line).trim();
        if (
          !stripped ||
          isZeroWeightEntry(stripped) ||
          lineIsQualityControl(stripped)
        ) {
          continue;
        }
        const normalized = normalizePromptLine(stripped);
        if (!normalized) continue;
        originalLines.push(stripped);
        normalizedLines.push(normalized);
      }
      if (originalLines.length && normalizedLines.length) {
        layers.push({
          label: originalLines.join('\n'),
          normalized: normalizedLines.join('\n'),
        });
      }
    }
  }
  return layers;
}

/**
 * 从 positive prompts 提取去重后的关键词行。
 * 复刻 stats_cache.py iter_prompt_keywords。
 *
 * @param doc 含 prompts.positive 的文档
 * @returns string[]:跨层全局去重后的原始行列表(首个出现顺序)
 *
 * 内部逻辑:与 iterPositivePromptLayers 相同的行过滤规则,
 * 差异在于去重范围是"文档全局"——seen 集合按归一化值判定,
 * 重复关键词只保留首次出现的原始行(展示形态保留)。
 */
export function iterPromptKeywords(
  doc: { prompts?: StatsDocPrompts },
): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  const positive = doc?.prompts?.positive ?? [];
  for (const prompt of positive) {
    for (const layer of prompt?.layers ?? []) {
      for (const line of layer?.lines ?? []) {
        const stripped = String(line).trim();
        if (
          !stripped ||
          isZeroWeightEntry(stripped) ||
          lineIsQualityControl(stripped)
        ) {
          continue;
        }
        const normalized = normalizePromptLine(stripped);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        keywords.push(stripped);
      }
    }
  }
  return keywords;
}

// ---------------------------------------------------------------------------
// 核心函数
// ---------------------------------------------------------------------------

/**
 * 检查 record 是否已解析工作流。
 * 复刻 stats_cache.py has_parsed_workflow。
 *
 * @param record record/stats_doc
 * @returns prompts.positive 为非空数组即 true
 *
 * 用途:rebuild 时只统计 has_parsed_workflow=true 的文档——
 * 未解析工作流的记录没有可信 prompt/lora 信息,计入会稀释统计。
 */
export function hasParsedWorkflow(record: {
  prompts?: { positive?: unknown[] };
}): boolean {
  const positive = record?.prompts?.positive;
  return Array.isArray(positive) && positive.length > 0;
}

/**
 * 从单条 record 构建 stats_doc 缓存文档。
 * 复刻 stats_cache.py build_stats_cache_document。
 *
 * @param record parser 产出的 record(batch 文档的字段子集)
 * @returns stats_doc:以 file.resolved_path 为 _id 的扁平缓存,
 *          仅保留统计所需字段(file 摘要 / created_date / model.base_model /
 *          loras.names 排序去重 / prompts / has_parsed_workflow / updated_at)
 *
 * 设计:stats_docs 是 images 的"统计投影"——剥离 workflow 大字段,
 * 单文档 ~KB 级,rebuild 全扫成本可控;updated_at 每次入库刷新,
 * 供调试与增量策略参考。
 */
export function buildStatsCacheDocument(record: StatsDoc): Record<string, unknown> {
  const fileInfo = record.file ?? {};
  return {
    _id: fileInfo.resolved_path,
    file: {
      resolved_path: fileInfo.resolved_path,
      filename: fileInfo.filename,
      image_name: fileInfo.image_name,
    },
    created_date: record.created_date,
    model: {
      base_model: record.model?.base_model,
    },
    loras: {
      names: sortedUnique(record.loras?.names ?? []),
    },
    prompts: {
      positive: record.prompts?.positive ?? [],
      negative: record.prompts?.negative ?? [],
      search_text: record.prompts?.search_text ?? '',
    },
    has_parsed_workflow: hasParsedWorkflow(record),
    updated_at: new Date(),
  };
}

/**
 * 检查 stats_summary 缓存是否就绪（meta 文档存在）。
 * 复刻 stats_cache.py stats_summary_ready。
 *
 * @param statsSummaryModel stats_summaries 集合 Model
 * @returns true 表示 meta 文档存在(缓存可用);false 表示需先重建
 *
 * 用途:ingest 结束后按此判断是否强制刷新汇总——
 * 首次启动/缓存被清空时即使无数据变更也要重建一次。
 */
export async function statsSummaryReady(
  statsSummaryModel: Model<unknown>,
): Promise<boolean> {
  const doc = await statsSummaryModel
    .collection
    .findOne({ _id: 'meta' } as never, { projection: { _id: 1 } });
  return doc !== null;
}

/** 重建汇总的结果计数(返回给调用方,用于日志/监控)。 */
interface RebuildSummaryResult {
  /** 参与聚合的 stats_docs 数。 */
  total_docs: number;
  /** 去重后的 lora 名称数。 */
  lora_count: number;
  /** lora 共现集合数(即 focus_lora 数)。 */
  cooccurrence_sets: number;
  /** lora profile 数。 */
  lora_profiles: number;
}

/**
 * 从 images 集合文档展开为 stats_docs 缓存文档(每条 image 一行)。
 * 复刻 stats_cache.py rebuild_stats_doc_cache_from_images 的构建逻辑;
 * Mongo 重建与 SQLite 重建共用,保证双端产物一致。
 *
 * @param doc 一张 batch 文档(含 images[] 与 batch 级统计字段)
 * @param now 统一时间戳(同批文档共用同一 updated_at)
 * @returns [{resolvedPath, doc}]——每个 image 一行,doc 结构与
 *          buildStatsCacheDocument 产物一致;远端 image 用 asset locator 逻辑键
 *
 * 内部逻辑:
 *   1. 取 doc.images[](可能缺省),本地图读 file.resolved_path
 *   2. 远端图无 resolved_path 时用 source.instance_id + asset_id/sha256
 *      生成 remote:// 逻辑 _id;全部定位字段都缺失才跳过
 *   3. batch 级字段(created_date/model/loras/prompts)对每张图复制一份,
 *      loras.names 经 sortedUnique 归一化,has_parsed_workflow 用 batch 的
 *      prompts.positive 判定
 *
 * 注意:一行一图意味着 stats_docs 数 == 全库图片数,
 * 重建是"展开"(denormalize),与 buildStatsCacheDocument 的"单记录投影"互补:
 * 前者用于全量重建,后者用于增量写入,产物形状必须一致(byte-equal)。
 */
export function statsDocFromBatchDoc(
  doc: StatsDoc,
  now: Date,
): Array<{ resolvedPath: string; doc: Record<string, unknown> }> {
  const images =
    (doc as {
      images?: Array<{
        file?: {
          resolved_path?: string;
          filename?: string;
          image_name?: string;
          sha256?: string;
        };
        source?: { instance_id?: string; asset_id?: string };
      }>;
    }).images ?? [];
  const out: Array<{ resolvedPath: string; doc: Record<string, unknown> }> = [];
  for (const img of images) {
    const fileInfo = img?.file ?? {};
    const resolvedPath = imageLocationKey(img);
    if (!resolvedPath) continue;
    out.push({
      resolvedPath,
      doc: {
        _id: resolvedPath,
        file: {
          resolved_path: resolvedPath,
          filename: fileInfo.filename,
          image_name: fileInfo.image_name,
        },
        created_date: (doc as { created_date?: string }).created_date,
        model: {
          base_model: (doc as { model?: { base_model?: string } }).model?.base_model,
        },
        loras: {
          names: sortedUnique(
            (doc as { loras?: { names?: string[] } }).loras?.names ?? [],
          ),
        },
        prompts: {
          positive: (doc as { prompts?: { positive?: unknown[] } }).prompts?.positive ?? [],
          negative: (doc as { prompts?: { negative?: unknown[] } }).prompts?.negative ?? [],
          search_text: (doc as { prompts?: { search_text?: string } }).prompts?.search_text ?? '',
        },
        has_parsed_workflow: hasParsedWorkflow(
          doc as { prompts?: { positive?: unknown[] } },
        ),
        updated_at: now,
      },
    });
  }
  return out;
}

/**
 * 纯计算:从 stats_docs 构建 stats_summaries 全量载荷。
 * Mongo 版 rebuildStatsSummaryCache 与 SQLite 版共用,保证双端 byte-equal。
 * 返回 { _id → 完整 $set 文档 } 载荷 + activeIds(过期清理用)+ 汇总计数。
 *
 * @param docs 待聚合的 stats_docs(调用方已过滤 has_parsed_workflow=true)
 * @returns {
 *   payloads:  七类汇总文档的 {_id, doc} 载荷(与旧 bulkWrite $set 逐字一致)
 *   activeIds: 本次重建产出的全部 _id(含基础类),供删除过期
 *              lora_cooccurrence/lora_profile 用
 *   total_docs / lora_count / cooccurrence_sets / lora_profiles: 汇总计数
 * }
 *
 * 聚合维度(每类文档的构建逻辑):
 *   meta                  — 总文档数 + 时间戳
 *   lora_frequency        — 每 lora 出现文档数 + 占比
 *   prompt_keywords       — 关键词出现次数/文档命中数/占比/密度
 *   lora_keywords         — 按文档数排名前 8 的 lora,各带关键词频次
 *   prompt_layers         — 层出现次数/文档命中/占比/密度
 *   lora_cooccurrence::X  — lora X 与其余 lora 的共现频次
 *   lora_profile::X       — lora X 的共现 lora + 关联 prompt 层频次
 */
export function computeStatsSummaryCache(
  docs: StatsDoc[],
): {
  payloads: Array<{ _id: string; doc: Record<string, unknown> }>;
  activeIds: Set<string>;
  total_docs: number;
  lora_count: number;
  cooccurrence_sets: number;
  lora_profiles: number;
} {
  // ---- 统计账本(全部在内存中累加,最后一次性产出载荷) ----
  // lora 维度:出现频次 / 共现计数 / 文档命中 / prompt 关联
  const loraFrequency = new Counter<string>();
  const loraCooccurrence = new Map<string, Counter<string>>();
  const loraDocHits = new Counter<string>();
  const loraPromptOccurrences = new Map<string, Counter<string>>();
  const loraPromptDocs = new Map<string, Counter<string>>();
  const promptLabelMap = new Map<string, string>();

  // prompt_keywords 维度:出现频次 / 文档命中 / 展示 label 还原
  const promptKeywordOccurrences = new Counter<string>();
  const promptKeywordDocHits = new Counter<string>();
  const promptKeywordLabelMap = new Map<string, string>();
  // lora_keywords 维度:每个 lora 独立的关键词频次账本(docs 计数 + Counter)
  const loraKeywordGroups = new Map<
    string,
    { docs: number; counter: Counter<string> }
  >();
  // prompt_layers 维度:层出现频次 / 文档命中 / 展示 label
  const promptLayerOccurrences = new Counter<string>();
  const promptLayerDocHits = new Counter<string>();
  const promptLayerLabelMap = new Map<string, string>();

  let totalDocs = 0;

  // ---- 逐文档累加阶段:每份 stats_doc 贡献一次计数 ----
  for (const statsDoc of docs) {
    // lora 名称排序去重(作为"该文档使用哪些 lora"的判定基准)
    const loraNames = sortedUnique(statsDoc.loras?.names ?? []);
    totalDocs += 1;

    // prompt_keywords 账本:
    // 关键词原始行列表 → 出现次数记 occurrences(可重复出现),
    // 文档命中记 docHits(按去重后的集合,一文档只算一次);
    // labelMap 存 归一化→原始 映射,展示时还原首个书写形态
    const keywords = iterPromptKeywords(statsDoc);
    const keywordSet = new Set(keywords);
    promptKeywordOccurrences.update(keywords);
    promptKeywordDocHits.update([...keywordSet]);
    for (const kw of keywords) {
      const normalized = normalizePromptLine(kw);
      if (normalized) {
        promptKeywordLabelMap.set(normalized, kw);
      }
    }

    // prompt_layers 账本:层按 normalized 计频次/文档命中,
    // label 只在首次出现时记录(同归一化值不同原始形态取首个)
    const layers = iterPositivePromptLayers(statsDoc);
    const layerSet = new Set<string>();
    for (const layer of layers) {
      promptLayerOccurrences.update([layer.normalized]);
      layerSet.add(layer.normalized);
      if (!promptLayerLabelMap.has(layer.normalized)) {
        promptLayerLabelMap.set(layer.normalized, layer.label);
      }
    }
    promptLayerDocHits.update([...layerSet]);

    // lora 相关账本:仅当文档确含 lora 才进入(无 lora 文档不贡献 lora 统计)
    if (loraNames.length > 0) {
      // lora_keywords:每个 lora 一个关键词桶,记录出现文档数 + 关键词频次
      for (const loraName of loraNames) {
        let bucket = loraKeywordGroups.get(loraName);
        if (!bucket) {
          bucket = { docs: 0, counter: new Counter<string>() };
          loraKeywordGroups.set(loraName, bucket);
        }
        bucket.docs += 1;
        bucket.counter.update([...keywordSet]);
      }

      // lora_frequency:频次与文档命中(单文档多 lora 各自 +1)
      loraFrequency.update(loraNames);
      loraDocHits.update(loraNames);

      // 共现与 profile:以每个 lora 为 focus 展开——
      // 共现计数排除自身;prompt 关联同时记 occurrences(可重复)与 docs(去重)
      for (const focusLora of loraNames) {
        let coOcc = loraCooccurrence.get(focusLora);
        if (!coOcc) {
          coOcc = new Counter<string>();
          loraCooccurrence.set(focusLora, coOcc);
        }
        coOcc.update(loraNames.filter((n) => n !== focusLora));

        let promptOcc = loraPromptOccurrences.get(focusLora);
        if (!promptOcc) {
          promptOcc = new Counter<string>();
          loraPromptOccurrences.set(focusLora, promptOcc);
        }
        promptOcc.update(layers.map((l) => l.normalized));

        let promptDocs = loraPromptDocs.get(focusLora);
        if (!promptDocs) {
          promptDocs = new Counter<string>();
          loraPromptDocs.set(focusLora, promptDocs);
        }
        promptDocs.update([...layerSet]);
      }
    }
  }

  // ---- 载荷产出阶段:账本 → 文档载荷(与旧 bulkWrite operations 的 $set 内容逐字一致) ----
  const now = new Date();
  const payloads: Array<{ _id: string; doc: Record<string, unknown> }> = [];
  // activeIds 预置五类基础文档 _id(恒存在);动态的
  // lora_cooccurrence::X / lora_profile::X 在下方逐个加入,
  // 未在本次重建出现的历史 _id 将作为过期项被删除
  const activeIds = new Set<string>([
    'meta',
    'lora_frequency',
    'prompt_keywords',
    'lora_keywords',
    'prompt_layers',
  ]);

  // meta:全量重建的锚点文档,statsSummaryReady 以此判断缓存是否就绪
  payloads.push({
    _id: 'meta',
    doc: { kind: 'meta', total_docs: totalDocs, updated_at: now },
  });

  // lora_frequency:按频次降序(mostCommon),占比按总文档数百分比
  payloads.push({
    _id: 'lora_frequency',
    doc: {
      kind: 'lora_frequency',
      total_docs: totalDocs,
      items: loraFrequency.mostCommon().map(([label, count]) => ({
        label,
        doc_hits: count,
        percentage: totalDocs ? round2((count / totalDocs) * 100) : 0,
      })),
      updated_at: now,
    },
  });

  // prompt_keywords:占比以文档命中数为分母(同文档内重复出现不虚增占比),
  // density = 出现次数/文档命中(单文档内平均出现密度)
  payloads.push({
    _id: 'prompt_keywords',
    doc: {
      kind: 'prompt_keywords',
      total_docs: totalDocs,
      items: promptKeywordOccurrences.mostCommon().map(([label, count]) => {
        const normalized = normalizePromptLine(label);
        const docHits = promptKeywordDocHits.get(label) ?? 0;
        return {
          label: promptKeywordLabelMap.get(normalized) ?? label,
          count,
          doc_hits: docHits,
          percentage: totalDocs ? round2((docHits / totalDocs) * 100) : 0,
          density: docHits ? round3(count / docHits) : 0,
        };
      }),
      updated_at: now,
    },
  });

  // lora_keywords:按出现文档数取前 8 个 lora(热点 lora 才值得展示),
  // 每个 lora 最多 12 个高频关键词,占比以该 lora 的文档数为分母
  const rankedLoras = [...loraKeywordGroups.entries()]
    .sort((a, b) => b[1].docs - a[1].docs)
    .slice(0, 8);
  payloads.push({
    _id: 'lora_keywords',
    doc: {
      kind: 'lora_keywords',
      total_docs: totalDocs,
      items: rankedLoras.map(([loraName, payload]) => {
        const docsCount = payload.docs;
        return {
          lora: loraName,
          docs: docsCount,
          keywords: payload.counter.mostCommon(12).map(([label, count]) => ({
            label,
            doc_hits: count,
            percentage: docsCount ? round2((count / docsCount) * 100) : 0,
          })),
        };
      }),
      updated_at: now,
    },
  });

  // prompt_layers:与 prompt_keywords 同构(occurrences/docHits/占比/密度)
  payloads.push({
    _id: 'prompt_layers',
    doc: {
      kind: 'prompt_layers',
      total_docs: totalDocs,
      items: promptLayerOccurrences.mostCommon().map(([label, count]) => {
        const docHits = promptLayerDocHits.get(label) ?? 0;
        return {
          label: promptLayerLabelMap.get(label) ?? label,
          count,
          doc_hits: docHits,
          percentage: totalDocs ? round2((docHits / totalDocs) * 100) : 0,
          density: docHits ? round3(count / docHits) : 0,
        };
      }),
      updated_at: now,
    },
  });

  // 动态文档:每个 lora 一个共现文档 + 一个 profile 文档,
  // _id 以 `::` 分隔 focus_lora;同时登记进 activeIds 供过期清理
  for (const [focusLora, counter] of loraCooccurrence) {
    // lora_cooccurrence::X:lora X 与哪些 lora 共现、各多少次
    const docId = `lora_cooccurrence::${focusLora}`;
    activeIds.add(docId);
    const focusDocs = loraDocHits.get(focusLora) ?? 0;
    payloads.push({
      _id: docId,
      doc: {
        kind: 'lora_cooccurrence',
        focus_lora: focusLora,
        total_docs: focusDocs,
        items: counter.mostCommon().map(([label, count]) => ({
          label,
          doc_hits: count,
          percentage: focusDocs ? round2((count / focusDocs) * 100) : 0,
        })),
        updated_at: now,
      },
    });

    // lora_profile::X:lora X 的共现 lora + 关联 prompt 层频次
    // (label 经 promptLabelMap 还原为首次书写形态,找不到时兜底归一化值)
    const profileId = `lora_profile::${focusLora}`;
    activeIds.add(profileId);
    const promptCounter = loraPromptOccurrences.get(focusLora) ?? new Counter<string>();
    const promptDocCounter = loraPromptDocs.get(focusLora) ?? new Counter<string>();
    payloads.push({
      _id: profileId,
      doc: {
        kind: 'lora_profile',
        focus_lora: focusLora,
        total_docs: focusDocs,
        co_loras: counter.mostCommon().map(([label, count]) => ({
          label,
          doc_hits: count,
          percentage: focusDocs ? round2((count / focusDocs) * 100) : 0,
        })),
        prompts: promptCounter.mostCommon().map(([label, count]) => {
          const docHits = promptDocCounter.get(label) ?? 0;
          return {
            label: promptLabelMap.get(label) ?? label,
            count,
            doc_hits: docHits,
            percentage: focusDocs ? round2((docHits / focusDocs) * 100) : 0,
            density: docHits ? round3(count / docHits) : 0,
          };
        }),
        updated_at: now,
      },
    });
  }

  // 汇总计数:lora_count 用频率账本条目数,cooccurrence/profile 用各自 Map 大小
  return {
    payloads,
    activeIds,
    total_docs: totalDocs,
    lora_count: loraFrequency.size,
    cooccurrence_sets: loraCooccurrence.size,
    lora_profiles: loraPromptOccurrences.size,
  };
}

/**
 * 从 stats_docs 重建 stats_summaries 聚合缓存(Mongo 版)。
 * 复刻 stats_cache.py rebuild_stats_summary_cache。
 *
 * @param statsDocsModel    stats_docs 集合(数据源)
 * @param statsSummaryModel stats_summaries 集合(目标)
 * @returns 汇总计数(total_docs/lora_count/cooccurrence_sets/lora_profiles)
 *
 * 内部逻辑:
 *   1. 全量读取 has_parsed_workflow=true 的 stats_docs(仅投影统计所需字段,
 *      避免拉回 prompts 之外的大字段)
 *   2. computeStatsSummaryCache 纯计算载荷 + activeIds
 *   3. 逐载荷 upsert($set,按 _id)
 *   4. 过期清理:kind 为 lora_cooccurrence/lora_profile 且 _id 不在
 *      activeIds 的文档删除(某 lora 本次重建不再出现,历史统计作废)
 *
 * 注意:全量重建是 O(全库文档),由 ingest 尾部按需触发
 * (数据变更时),不随每条记录实时增量。
 */
export async function rebuildStatsSummaryCache(
  statsDocsModel: Model<unknown>,
  statsSummaryModel: Model<unknown>,
): Promise<RebuildSummaryResult> {
  const docs: StatsDoc[] = [];
  const cursor = statsDocsModel.collection.find(
    { has_parsed_workflow: true },
    { projection: { _id: 0, 'loras.names': 1, 'prompts.positive': 1 } },
  );
  for await (const doc of cursor) {
    docs.push(doc as StatsDoc);
  }

  // 纯计算与 IO 分离:compute 无副作用,双端(SQLite)可复用
  const { payloads, activeIds, ...counters } = computeStatsSummaryCache(docs);

  // 载荷 → upsert 操作(按 _id 幂等,重复重建不产生重复文档)
  const operations: Array<{
    updateOne: {
      filter: Record<string, unknown>;
      update: { $set: Record<string, unknown> };
      upsert: boolean;
    };
  }> = payloads.map((p) => ({
    updateOne: {
      filter: { _id: p._id },
      update: { $set: p.doc },
      upsert: true,
    },
  }));
  if (operations.length > 0) {
    await statsSummaryModel.collection.bulkWrite(operations as never, {
      ordered: false,
    });
  }

  // 删除过期的 lora_cooccurrence / lora_profile
  // ($nin 大集合注意:activeIds 规模 = 热点 lora 数,可接受;
  // 基础五类文档不在删除范围——它们不在 kind 过滤内)
  await statsSummaryModel.collection.deleteMany({
    kind: { $in: ['lora_cooccurrence', 'lora_profile'] },
    _id: { $nin: [...activeIds].sort() } as never,
  } as never);

  return counters;
}

/**
 * 从 images 集合重建 stats_docs 缓存（展开 images 数组为单条记录）。
 * 复刻 stats_cache.py rebuild_stats_doc_cache_from_images。
 *
 * @param imagesModel    images 集合(数据源)
 * @param statsDocsModel stats_docs 集合(目标,先全清再重建)
 * @param sourceFilter   可选过滤(如按 instance_id 限定来源网关)
 * @returns { rebuilt: 重建的 stats_doc 行数 }
 *
 * 内部逻辑:
 *   1. 全清 stats_docs(重建是整体替换语义,残留旧行会造成幽灵统计)
 *   2. 游标读取 images,经 statsDocFromBatchDoc 逐批展开为单图文档
 *   3. 累积 upsert 操作,每 500 条 flush 一次 bulkWrite(防操作数组无界)
 *   4. 收尾 flush 余量
 *
 * 边界:image 无本地 resolved_path 时使用 remote:// 逻辑键;只有
 * path/asset_id/sha256/filename 全缺才不进入 rebuilt 计数。sourceFilter
 * 传入时只重建匹配子集
 * (但 deleteMany 仍清全表——调用方应只在确需整体重建时使用)。
 */
export async function rebuildStatsDocCacheFromImages(
  imagesModel: Model<unknown>,
  statsDocsModel: Model<unknown>,
  sourceFilter: Record<string, unknown> = {},
): Promise<{ rebuilt: number }> {
  await statsDocsModel.collection.deleteMany({});

  let rebuilt = 0;
  const now = new Date();
  const batchSize = 500;
  let operations: Array<{
    updateOne: {
      filter: Record<string, unknown>;
      update: { $set: Record<string, unknown> };
      upsert: boolean;
    };
  }> = [];

  // 投影仅拉取展开所需的字段(file 摘要 + 远端 source locator +
  // batch 级统计字段),
  // 避免把 workflow 大字段拖进内存
  const cursor = imagesModel.collection.find(sourceFilter, {
    projection: {
      _id: 0,
      created_date: 1,
      model: 1,
      loras: 1,
      prompts: 1,
      'images.file.resolved_path': 1,
      'images.file.filename': 1,
      'images.file.image_name': 1,
      'images.file.sha256': 1,
      'images.source.instance_id': 1,
      'images.source.asset_id': 1,
    },
  });

  // 逐文档展开:一张 batch 可能产出多张图 → 多条 upsert
  for await (const doc of cursor) {
    for (const { resolvedPath, doc: cacheDoc } of statsDocFromBatchDoc(
      doc as StatsDoc,
      now,
    )) {
      operations.push({
        updateOne: {
          filter: { _id: resolvedPath },
          update: { $set: cacheDoc },
          upsert: true,
        },
      });
      rebuilt += 1;

      // 批量落盘:达到 batchSize 即 flush,控制单次 bulkWrite 大小
      // 与内存占用(全库级重建时 images 可达十万级)
      if (operations.length >= batchSize) {
        await statsDocsModel.collection.bulkWrite(
          operations.map((op) => ({
            updateOne: {
              filter: op.updateOne.filter,
              update: op.updateOne.update as any,
              upsert: op.updateOne.upsert,
            },
          })) as any,
          { ordered: false },
        );
        operations = [];
      }
    }
  }

  // 收尾:flush 不足一桶的余量
  if (operations.length > 0) {
    await statsDocsModel.collection.bulkWrite(
      operations.map((op) => ({
        updateOne: {
          filter: op.updateOne.filter,
          update: op.updateOne.update as any,
          upsert: op.updateOne.upsert,
        },
      })) as any,
      { ordered: false },
    );
  }

  return { rebuilt };
}

// ---------------------------------------------------------------------------
// SQLite 落盘版(双写过渡期镜像,阶段 5 后为主写路径)
// ---------------------------------------------------------------------------

/**
 * stats_summary 就绪检查(SQLite)。
 *
 * @param db SQLite 镜像库
 * @returns stats_summaries 表存在 kind='meta' 行即 true
 *          (与 Mongo 版 statsSummaryReady 语义等价:meta 是重建完成的锚点)
 */
export function statsSummaryReadySqlite(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT 1 AS c FROM stats_summaries WHERE kind = 'meta'")
    .get() as { c: number } | undefined;
  return row !== undefined;
}

/**
 * 从 stats_docs 重建 stats_summaries(SQLite 版)。
 * 与 Mongo 版共用 computeStatsSummaryCache,载荷逐字一致。
 *
 * @param db SQLite 镜像库
 * @returns 汇总计数(与 Mongo 版同型)
 *
 * 内部逻辑:
 *   1. 读 has_parsed_workflow=1 的 stats_docs(doc_json 反序列化)
 *   2. computeStatsSummaryCache 纯计算(与 Mongo 版共享,保证 byte-equal)
 *   3. 事务内先 DELETE 全表再 INSERT:PK 是 (kind, focus_lora),
 *      focus_lora 为 NULL 的基础类在 SQLite 中 NULL ≠ NULL,REPLACE 不去重,
 *      直接重插会产生重复行(读 API 可能拿到旧空行)
 *
 * 注意:activeIds 在 SQLite 版无用(void 掉)——过期清理由
 * "先清全表"天然完成,不存在残留 lora_cooccurrence/lora_profile。
 */
export async function rebuildStatsSummaryCacheSqlite(
  db: Database.Database,
): Promise<RebuildSummaryResult> {
  const rows = db
    .prepare(
      'SELECT doc_json FROM stats_docs WHERE has_parsed_workflow = 1',
    )
    .all() as Array<{ doc_json: string }>;
  const docs: StatsDoc[] = rows.map((r) => JSON.parse(r.doc_json) as StatsDoc);

  const { payloads, activeIds, ...counters } = computeStatsSummaryCache(docs);

  withTransaction(db, () => {
    // 先清全表再插入:PK (kind, focus_lora) 对 focus_lora=NULL 的基础类
    // 不去重(SQLite NULL ≠ NULL),REPLACE 会让多次重建产生重复行,
    // API 读到的可能是旧空行
    db.exec('DELETE FROM stats_summaries');
    const insert = db.prepare(
      'INSERT OR REPLACE INTO stats_summaries(kind, focus_lora, doc_json) VALUES (?,?,?)',
    );
    for (const p of payloads) {
      const kind = String(p.doc.kind ?? '');
      const focus = p.doc.focus_lora ? String(p.doc.focus_lora) : null;
      insert.run(kind, focus, JSON.stringify(p.doc));
    }
  });

  void activeIds;
  return counters;
}

/**
 * 从 batches 重建 stats_docs 缓存(SQLite 版)。
 * 与 Mongo 版共用 statsDocFromBatchDoc,产物一致。
 *
 * @param db SQLite 镜像库
 * @returns { rebuilt: 重建的 stats_doc 行数 }
 *
 * 内部逻辑:
 *   1. 读全量 batches.doc_json
 *   2. 事务内先清 stats_docs(FK CASCADE 连带清 stats_doc_lora_names)
 *      与 fts_stats_docs(FTS 表需独立清,否则残留旧检索词)
 *   3. 逐批展开为单图行,同步写三处:主表(含冗余检索列)、
 *      lora 关联表、FTS 检索表(search_text 有值才插,防空行占位)
 *
 * 与 Mongo 版差异:stats_docs 行含冗余列(filename/image_name/base_model/
 * search_text/captured_at),供 SQL 查询端直接过滤,无需反序列化 doc_json。
 */
export async function rebuildStatsDocCacheFromImagesSqlite(
  db: Database.Database,
): Promise<{ rebuilt: number }> {
  const rows = db
    .prepare('SELECT doc_json FROM batches')
    .all() as Array<{ doc_json: string }>;
  const now = new Date();

  let rebuilt = 0;
  withTransaction(db, () => {
    db.exec('DELETE FROM stats_docs'); // FK CASCADE 连带 stats_doc_lora_names
    db.exec('DELETE FROM fts_stats_docs');
    const insert = db.prepare(
      `INSERT OR REPLACE INTO stats_docs(
        resolved_path, filename, image_name, created_date, has_parsed_workflow,
        base_model, search_text, captured_at, doc_json)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    const insertLora = db.prepare(
      'INSERT OR REPLACE INTO stats_doc_lora_names(resolved_path, name) VALUES (?,?)',
    );
    for (const row of rows) {
      const doc = JSON.parse(row.doc_json) as StatsDoc;
      // 每张图一行:主表冗余列取 statsDocFromBatchDoc 产物的对应字段,
      // captured_at 列此处恒 null(来源 doc 未投影该字段,保持列结构稳定)
      for (const { resolvedPath, doc: rawDoc } of statsDocFromBatchDoc(doc, now)) {
        const sd = rawDoc as unknown as StatsDoc;
        insert.run(
          resolvedPath,
          (sd.file as { filename?: unknown }).filename ?? null,
          (sd.file as { image_name?: unknown }).image_name ?? null,
          sd.created_date ?? null,
          sd.has_parsed_workflow ? 1 : 0,
          (sd.model as { base_model?: unknown }).base_model ? String((sd.model as { base_model?: unknown }).base_model) : null,
          String(sd.prompts?.search_text ?? '') || null,
          null,
          JSON.stringify(sd),
        );
        const names = (sd.loras as { names?: string[] } | undefined)?.names ?? [];
        for (const name of names) {
          insertLora.run(resolvedPath, name);
        }
        rebuilt += 1;
      }
    }
    // FTS 整表按 rowid 对齐回填(fts_stats_docs.rowid = stats_docs.rowid,
    // 读路径按 rowid 回连主表;逐行插入无法拿到主表 rowid,故循环后统一回填)
    db.exec(
      `INSERT INTO fts_stats_docs(rowid, search_text)
       SELECT rowid, search_text FROM stats_docs
       WHERE search_text IS NOT NULL AND search_text != ''`,
    );
  });
  return { rebuilt };
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 去重 + 过滤空串 + 排序(统计键的统一归一化出口)。 */
function sortedUnique(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))].sort();
}

/** 保留两位小数(占比计算)。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 保留三位小数(密度计算)。 */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
