/**
 * lib/seed_images.ts — batch 级 seed→图片 对齐派生(2026-08-11)。
 *
 * 将 samplers[].seed 与 batch.images[] 按 index 对齐,产出
 * `batch.seed_images`: [{ sha256, filename, seeds: [阶段1..阶段N] }],
 * 每行与 images[i] 对应。
 *
 * 语义(与 PARSER_SPEC §5 seed 语义对齐):
 *  - sampler.seed 为数组(批量种子节点)→ 每张图独立 seed,index 对齐
 *  - sampler.seed 为标量(标准 KSampler,整批共享)→ 每张图填充同一值
 *  - sampler.seed 无法解析(连线/对象)→ 该阶段占位 null(保持数组 index == sampler index)
 *
 * 对齐守卫:
 *  - seed 数组长度 != images 数(跨批 $push 追加时不可靠)→ 该阶段整体 null
 *  - images / samplers 为空 → 返回 []
 *
 * 注意:跨批合并(recipe 多批、各批 seed 不同)时由调用方负责判定
 * 不调用本函数(见 images.controller shapeRecipeGroupDoc 的 batch_count 守卫)。
 *
 * 数据流:读端专用派生——parse.controller / images.controller 从库中读出
 * batch 文档后,调用 buildSeedImages(samplers, images) 把 seed 打散到每张
 * 图,响应给浏览器渲染(seed 输入框逐图预填)。纯函数、无 IO,不落库。
 */
export interface SeedImageEntry {
  /** 图片 sha256(无则 null)。 */
  sha256: string | null;
  /** 图片文件名(无则 null)。 */
  filename: string | null;
  /** 与 samplers 数组 index 对齐的各阶段 seed 值(无法解析的阶段为 null)。 */
  seeds: Array<unknown>;
}

/**
 * 把 samplers 的 seed 与 images 按 index 对齐,构建逐图 seed 列表。
 *
 * @param samplers parser 产出的 samplers 数组(每阶段一个元素,seed 可为
 *                 数组[批量节点] / 标量[共享] / 其他[未解析])
 * @param images   batch.images 数组(每张图一个元素,取 file.sha256/filename)
 * @returns 每张图一行的 {sha256, filename, seeds[]};非法输入返回 []
 *
 * 内部逻辑(分步):
 *   1. 守卫:samplers 或 images 非数组、或 images 为空 → []。
 *      注意不要求 samplers 非空——samplers 缺省时每行 seeds 为空数组,
 *      与"无 seed 信息"语义一致
 *   2. 预建 rows[images.length] 的二维骨架(每行一个空数组)
 *   3. 逐 sampler 处理 seed:
 *      a. seed 为数组且长度 == images 数 → index 对齐逐行 push
 *         (批量种子节点,一张图一个 seed)
 *      b. seed 为数组但长度不符 → 该阶段所有行 push null
 *         (跨批 $push 追加后长度不可靠,宁缺毋滥,保持行数=阶段数)
 *      c. seed 为 number/string 标量 → 所有行 push 同一值
 *         (标准 KSampler 整批共享一个 seed)
 *      d. 其余(连线节点/对象等未解析形态)→ 所有行 push null 占位,
 *         保证每行 seeds.length == samplers.length(前端按 index 取阶段)
 *   4. 收尾:逐图产出 {sha256, filename, seeds: rows[index]}
 *
 * 边界:返回行数恒等于 images.length;sha256/filename 缺省补 null
 * (不省略字段,保证响应 JSON 结构稳定)。
 */
export function buildSeedImages(
  samplers: Array<{ seed?: unknown }> | undefined | null,
  images:
    | Array<{ file?: { sha256?: unknown; filename?: unknown } }>
    | undefined
    | null,
): SeedImageEntry[] {
  if (
    !Array.isArray(samplers) ||
    !Array.isArray(images) ||
    images.length === 0
  ) {
    return [];
  }
  const rows: Array<Array<unknown>> = images.map(() => []);
  for (const sampler of samplers) {
    const seed = sampler?.seed;
    if (Array.isArray(seed)) {
      if (seed.length === images.length) {
        seed.forEach((value, index) => rows[index].push(value));
      } else {
        for (const row of rows) row.push(null);
      }
    } else if (typeof seed === 'number' || typeof seed === 'string') {
      for (const row of rows) row.push(seed);
    } else {
      for (const row of rows) row.push(null);
    }
  }
  return images.map((img, index) => ({
    sha256: (img?.file?.sha256 as string | null) ?? null,
    filename: (img?.file?.filename as string | null) ?? null,
    seeds: rows[index],
  }));
}
