/**
 * Counter — 复刻 Python collections.Counter 的最小实现。
 *
 * 用于 stats_cache.ts 的频率/共现统计，与 Python 版语义对齐。
 *
 * 职责:对离散键(字符串)做出现次数累计,并提供按计数降序的
 * Top-N 查询;不维护额外顺序语义、不支持减法(与 Python Counter
 * 的常用子集对齐)。
 *
 * 泛型约束 K extends string:键类型限定为字符串(覆盖本仓库全部
 * 用法:模型名 / LoRA 名等),底层用原生 Map,键比较为严格相等。
 *
 * 边界说明:
 *  - get 对不存在的键返回 0 而非抛错,调用方无需先判存在;
 *  - mostCommon 的排序是稳定排序(Array.prototype.sort 在 V8 中稳定),
 *    计数相同时保持插入顺序;
 *  - mostCommon(0) 返回空数组;n 超过键数时返回全部条目;
 *  - update 对空迭代器是 no-op;同一键重复出现多次则多次累加。
 */
export class Counter<K extends string> {
  // 内部存储:Map 提供 O(1) 读写;计数从 0 起步,累加递增
  private map = new Map<K, number>();

  /**
   * 批量计数:对 items 中每个元素计数 +1。
   * 输入:任意可迭代的键集合(数组 / Set / 生成器均可)。
   * 输出:void,副作用写入内部 map(元素可重复,重复则累加多次)。
   * 边界:首次出现的键以 0 + 1 起步(?? 0 兜底);
   * 遍历顺序不影响最终计数结果。
   */
  update(items: Iterable<K>): void {
    for (const item of items) {
      this.map.set(item, (this.map.get(item) ?? 0) + 1);
    }
  }

  /**
   * 取单个 key 的计数。
   * 输入:key —— 查询的键。
   * 输出:number,该键累计计数;不存在时返回 0(与 Python
   * Counter[key] 语义一致,不抛异常)。
   */
  get(key: K): number {
    return this.map.get(key) ?? 0;
  }

  /** 唯一键数量(与 Python len(counter) 对齐,用于归一化计算)。 */
  get size(): number {
    return this.map.size;
  }

  /**
   * 按计数降序排列,返回 [key, count] 元组数组;可选限制前 n 个。
   * 输入:n —— 可选整数,返回条数上限;不传则返回全部。
   * 输出:Array<[K, number]>,已按 count 降序;计数相同时保持
   * 插入顺序(稳定排序)。
   * 边界:n = 0 返回空数组;n 超过键数时返回全部条目;
   * 返回的是新数组(拷贝),修改它不影响内部 map。
   */
  mostCommon(n?: number): Array<[K, number]> {
    const entries = [...this.map.entries()].sort((a, b) => b[1] - a[1]);
    return n !== undefined ? entries.slice(0, n) : entries;
  }

  /**
   * 迭代器(与 Map 语义一致):供 for..of / 解构等场景直接消费
   * 内部 map 的 [key, count] 键值对序列,顺序为插入顺序。
   */
  entries(): IterableIterator<[K, number]> {
    return this.map.entries();
  }
}
