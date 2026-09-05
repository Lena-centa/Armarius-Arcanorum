/**
 * In-memory thumbnail cache (NestJS owns caching per protocol §10 —
 * the worker always renders fresh bytes).
 *
 * Mirrors the legacy app's memory cache intent: keyed by sha256+w+h,
 * LRU eviction (refresh on get) once the cap is reached. No TTL: entries are
 * immutable by content hash (sha256), so staleness is impossible for a given
 * key.
 *
 * 中文说明 — 缩略图内存 LRU 缓存:
 *   - 为什么不需要 TTL:键含 sha256(内容寻址),同一键的字节恒等,
 *     不存在"过期"概念,只受容量限制;
 *   - 淘汰策略:基于 Map 的插入序,set 时先删后插(get 命中时也刷新
 *     到尾部),满员时淘汰最旧键——即 LRU(最近最少使用);
 *   - 上限:默认 500 条(构造函数可配),每条为一张 WebP 字节,
 *     防止图片库漫游时缓存无界增长;
 *   - 用途:parse.controller 的 /api/thumb/:sha256 网关侧缓存,
 *     worker 每次只渲染新字节,缓存命中直接下发。
 */
export class ThumbCache {
  // 缓存本体:Map 按插入顺序迭代——尾部 = 最近使用,头部 = 最久未用。
  // 键 = sha256:w x h,值 = 渲染好的 WebP 字节
  private readonly entries = new Map<string, Buffer>();

  // maxEntries 默认 500:缓存条数上限,构造时注入便于测试与调参
  constructor(private readonly maxEntries = 500) {}

  // 缓存键:sha256 保证内容唯一,后缀 w/h 使不同尺寸的缩略图各占一条
  private key(sha256: string, w: number, h: number): string {
    return `${sha256}:${w}x${h}`;
  }

  /**
   * 读取缓存:命中则把该键"刷新"到 Map 尾部(先删后插),
   * 维持 LRU 序——热条目不会因满员而先被淘汰。
   * 返回:WebP 字节;未命中返回 undefined(由调用方走渲染链路)。
   */
  get(sha256: string, w: number, h: number): Buffer | undefined {
    const key = this.key(sha256, w, h);
    const hit = this.entries.get(key);
    if (hit) {
      // Refresh recency so hot entries survive eviction.
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  /**
   * 写入缓存:先删后插(幂等覆盖 + 置为最新),随后循环淘汰最老键
   * 直到条数回到上限内。写入者(parse.controller)保证 data 是
   * worker 刚渲染的完整 WebP 字节。
   */
  set(sha256: string, w: number, h: number, data: Buffer): void {
    const key = this.key(sha256, w, h);
    this.entries.delete(key);
    this.entries.set(key, data);
    // 逐条淘汰最久未用键:Map 迭代序的头部即最老;size 超限前循环
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }
}
