/**
 * lib/recipe_keys.ts — 移植自已移除的 workflow_db/recipe_keys.py。
 *
 * buildRecipeKey: 从 model/loras/prompts/samplers/latent 构建 SHA1 哈希,
 * 用于 recipe_groups 分组(相同配方 = 相同 recipe_key)。
 *
 * 数据流:ingest.ts / archive.ts 在每条 record 入库前调用 buildRecipeKey,
 * 产物写入 batch.recipe_key;recipe_groups 按 recipe_key 聚合,
 * 前端"配方"视图以它为主键。哈希稳定性是本模块的生命线——
 * 键值参与分组、去重、局部重建的 delete 过滤,任何序列化顺序抖动
 * 都会造成同配方不同 key 的幽灵分组。
 */
import { createHash } from 'crypto';

/**
 * Lora 规范化字段形状。
 * 参与哈希的字段全集:name/source/strength_model/strength_clip/weight/slot/enabled。
 * 字段裁剪的意义:工作流节点原始负载含大量非配方字段(如连线 id),
 * 裁剪后只有"配方语义"字段进入哈希,否则同配方不同连线会分裂成两个 key。
 */
interface LoraItem {
  /** Lora 文件名(定位符)。 */
  name?: string;
  /** 来源路径(可选)。 */
  source?: string;
  /** 模型权重(可选)。 */
  strength_model?: number;
  /** CLIP 权重(可选)。 */
  strength_clip?: number;
  /** 旧版权重别名(可选)。 */
  weight?: number;
  /** 槽位(可选)。 */
  slot?: number;
  /** 启用开关(可选)。 */
  enabled?: boolean;
}

/**
 * Sampler 条目(透传类型)。normalizedSamplerRecipeItems 裁剪后
 * 仅剩非 seed 字段进入哈希(seed 不入配方)。
 */
interface SamplerItem {
  [key: string]: unknown;
}

/**
 * 稳定 JSON 序列化:递归 key 排序 + JSON.stringify。
 * 保证不同插入顺序的对象产出相同字符串,哈希值不受字段顺序影响。
 * @param value 任意可序列化值
 * @returns 排序后的 JSON 字符串
 */
function jsonStable(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * 递归按键名升序排序对象;数组按序递归处理元素(数组顺序是语义的一部分,
 * 如 prompt 顺序,不排序);null/标量原样返回。
 * @param value 待排序值
 * @returns 键已排序的副本(不修改入参)
 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Lora 配方字段归一化。
 *
 * @param items 原始 loras.items(可为 undefined/含非对象脏元素)
 * @returns 裁剪后的 LoraItem[]:剔除非对象元素,保留固定字段集,
 *          enabled 缺省补 true —— 归一化后每个元素字段集合完全一致,
 *          序列化形状稳定(不随 parser 版本波动)
 *
 * 边界:字段保留"显式 undefined"与"缺省"在 JSON.stringify 中同样被省略,
 * 因此这里用解构展开原样透传各字段即可,无需 ?? 兜底;
 * 唯一显式兜底的是 enabled(缺省视为启用,归一化到 true)。
 */
export function normalizedLoraRecipeItems(
  items: LoraItem[] | undefined,
): LoraItem[] {
  if (!items) return [];
  return items
    .filter((item): item is LoraItem => typeof item === 'object' && item !== null)
    .map((item) => ({
      name: item.name,
      source: item.source,
      strength_model: item.strength_model,
      strength_clip: item.strength_clip,
      weight: item.weight,
      slot: item.slot,
      enabled: item.enabled ?? true,
    }));
}

/**
 * Sampler 配方字段归一化:剔除 seed 相关字段。
 *
 * @param items 原始 samplers 数组
 * @returns 去掉 seed/seed_randomize 后的条目(其余字段原样保留、不排序,
 *          依赖 jsonStable 兜底)
 *
 * 设计动机:seed 是"运行实例"属性而非"配方"属性——同一配方不同 seed
 * 必须归并到同一 recipe_key,故显式排除,避免种子差异分裂分组。
 */
export function normalizedSamplerRecipeItems(
  items: SamplerItem[] | undefined,
): SamplerItem[] {
  if (!items) return [];
  return items
    .filter((item): item is SamplerItem => typeof item === 'object' && item !== null)
    .map((item) => {
      const { seed, seed_randomize, ...rest } = item;
      return rest;
    });
}

/**
 * 从单条 record 构建配方哈希键 `recipe:<sha1>`。
 *
 * @param doc parser 产出的完整 record(取 model/loras/prompts/samplers/latent)
 * @returns 形如 `recipe:<40位十六进制 sha1>` 的稳定标识
 *
 * 内部逻辑(分步):
 *   1. 取五类配方字段,各自归一化:
 *      - model/latent:原样对象(缺省 {})
 *      - loras:normalizedLoraRecipeItems(固定字段集 + enabled 兜底)
 *      - prompts:仅 positive/negative 两数组(缺省 [])
 *      - samplers:normalizedSamplerRecipeItems(剔除 seed)
 *   2. jsonStable(payload):递归键排序后序列化
 *      —— 同一配方的任何字段书写顺序都会折叠为同一字符串
 *   3. sha1(payload) → 前缀 `recipe:` 防碰撞、可读、便于调试
 *
 * 边界:哈希只依赖字段内容,不依赖 batch_key/路径/时间等身份字段;
 * 空配方(所有字段缺省)也会产出确定键,由调用方按业务判定是否合法。
 */
export function buildRecipeKey(doc: Record<string, unknown>): string {
  const loras = (doc.loras as { items?: LoraItem[] }) ?? {};
  const prompts = (doc.prompts as { positive?: unknown[]; negative?: unknown[] }) ?? {};
  const payload = {
    model: (doc.model as Record<string, unknown>) ?? {},
    loras: normalizedLoraRecipeItems(loras.items),
    prompts: {
      positive: prompts.positive ?? [],
      negative: prompts.negative ?? [],
    },
    samplers: normalizedSamplerRecipeItems(doc.samplers as SamplerItem[]),
    latent: (doc.latent as Record<string, unknown>) ?? {},
  };
  const digest = createHash('sha1').update(jsonStable(payload), 'utf8').digest('hex');
  return `recipe:${digest}`;
}
