/**
 * ComfyUI 近实时通道的共享工具:
 * - parseHistoryImages:把 ComfyUI GET /history 响应解析为输出图片列表
 * - resolveComfyImagePath:优先 ComfyUI output 目录,回退 scanRoot 候选
 * - PendingBuffer:内存缓冲(实时事件只进内存,flush 循环批量 diff 入库)
 *
 * 数据流:fs.watch 文件系统事件与 ComfyUI history 轮询(comfy-history-poller)
 * 都只把路径写入 PendingBuffer;orchestration 的 flush 循环周期性 drain
 * 缓冲,把路径交给 ingest/archive 的 diff 逻辑批量入库。本模块是
 * 两类实时源的公共底座,不含任何 DB 依赖。
 */

import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';

/** ComfyUI 图片引用(API /history 与 /view 共用的定位三元组)。 */
export interface ComfyImageRef {
  /** 文件名。 */
  filename: string;
  /** 输出目录下的子目录(通常为空)。 */
  subfolder: string;
  /** 类型:'output' / 'temp' / 'input' 等。 */
  type: string;
}

/** 一条已完成的 ComfyUI prompt 及其输出图片列表。 */
export interface HistoryPromptItem {
  /** ComfyUI 端生成的 prompt id(唯一)。 */
  prompt_id: string;
  /** status.completed 是否 === true(仅完成的 prompt 才归档)。 */
  completed: boolean;
  /** 该 prompt 的全部输出图片引用。 */
  images: ComfyImageRef[];
}

/**
 * 解析 ComfyUI /history 响应。
 * 原始结构:{prompt_id: {outputs: {node_id: {images: [{filename,subfolder,type}]}}, status: {completed, status_str}}}
 *
 * @param raw /history 的 JSON 载荷(未知类型,防御性解析)
 * @returns HistoryPromptItem[];结构不符/字段缺失的层级安全跳过
 *
 * 内部逻辑(逐层防御):
 *   1. 顶层非对象 → [] ;按 prompt_id 遍历 entry
 *   2. entry 非对象跳过;仅从 outputs 各节点的 images 数组收集图片
 *   3. 单张图:filename 空串剔除;subfolder/type 缺省补 ''/'output'
 *   4. completed 严格取 status.completed === true(缺失视为未完成)
 *
 * 边界:对端结构变化只导致该层条目丢失,不会抛异常污染调用方;
 * 每层都做 Array.isArray 检查,避免 undefined.map 崩溃。
 */
export function parseHistoryImages(raw: unknown): HistoryPromptItem[] {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const items: HistoryPromptItem[] = [];
  for (const [promptId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const e = entry as {
      outputs?: Record<string, { images?: unknown }>;
      status?: { completed?: boolean; status_str?: string };
    };
    const images: ComfyImageRef[] = [];
    // 收集全部输出节点的图片(outputs 可能有多个 SaveImage 类节点)
    for (const node of Object.values(e.outputs ?? {})) {
      if (!node || !Array.isArray(node.images)) {
        continue;
      }
      for (const img of node.images) {
        if (!img || typeof img !== 'object') {
          continue;
        }
        const ref = img as Partial<ComfyImageRef>;
        const filename = String(ref.filename ?? '').trim();
        if (!filename) {
          continue;
        }
        images.push({
          filename,
          subfolder: String(ref.subfolder ?? '').trim(),
          type: String(ref.type ?? 'output').trim() || 'output',
        });
      }
    }
    const completed = e.status?.completed === true;
    items.push({ prompt_id: promptId, completed, images });
  }
  return items;
}

/**
 * 解析 ComfyUI 输出图片的文件系统路径。
 *
 * 候选顺序(scanRoot 系列优先,保证入库路径与 sync 扫描口径一致,
 * 避免同一文件以两个路径入库导致变更检测 miss):
 *   1. scanRoot/subfolder/filename 与 scanRoot/today/subfolder/filename
 *   2. COMFY_OUTPUT_DIR/subfolder/filename(输出目录仅作兜底,
 *      用于输出落在扫描根之外的场景)
 * 返回绝对路径;找不到返回 null。
 *
 * @param image          ComfyUI 图片引用
 * @param scanRoot       扫描根目录(sync 口径,优先命中)
 * @param comfyOutputDir 显式配置的输出目录(可为空;仅绝对路径才参与)
 * @returns 第一个真实存在的文件的绝对路径;全部 miss 返回 null
 *
 * 内部逻辑:
 *   1. 生成候选列表:scanRoot 下 [subfolder/]filename 与 today/ 变体,
 *      再补 comfyOutputDir(仅 isAbsolute 校验过的值,防止相对路径
 *      拼出意外位置)
 *   2. Set 去重(scanRoot 与输出目录重叠时防重复 stat)
 *   3. 逐个 existsSync+isFile 探测,命中即 resolve 返回
 *      (resolve 归一为绝对路径,与 sync 扫描产出的 resolved_path 形式一致)
 *
 * 边界:stat 抛异常(权限/路径非法)时跳过该候选继续;
 * 目录命中不算(必须 isFile,防止把目录当图片归档)。
 */
export function resolveComfyImagePath(
  image: ComfyImageRef,
  scanRoot: string,
  comfyOutputDir: string,
): string | null {
  const filename = image.filename || '';
  const subfolder = image.subfolder || '';
  const candidates: string[] = [];

  if (scanRoot) {
    if (subfolder) {
      candidates.push(join(scanRoot, subfolder, filename));
      candidates.push(join(scanRoot, 'today', subfolder, filename));
    }
    candidates.push(join(scanRoot, filename));
    candidates.push(join(scanRoot, 'today', filename));
  }
  if (comfyOutputDir && isAbsolute(comfyOutputDir)) {
    if (subfolder) {
      candidates.push(join(comfyOutputDir, subfolder, filename));
    }
    candidates.push(join(comfyOutputDir, filename));
  }

  for (const candidate of [...new Set(candidates)]) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return resolve(candidate);
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 自动探测 ComfyUI 输出目录。
 *
 * 原理:从 /history 取最近一张已完成图片 {filename, subfolder},
 * 在候选根列表中验证文件存在性,第一个命中即视为输出目录。
 * 候选根:scanRoot/today、scanRoot、常见 ComfyUI 默认位置。
 * 返回探测到的目录绝对路径;探测失败返回 null(回退 scanRoot 候选)。
 *
 * @param baseUrl  ComfyUI API 地址
 * @param scanRoot 扫描根目录
 * @returns 探测到的输出目录绝对路径;失败 null
 *
 * 内部逻辑:
 *   1. 组装候选根:scanRoot/today、scanRoot(优先,与扫描口径一致),
 *      再补常见默认位(home 下的 ComfyUI/output 等;win32 追加 C:/D:/ 盘符位)
 *   2. GET {baseUrl}/history?max_items=1,AbortController + 10s 超时
 *      (fetch 无内置超时,防 ComfyUI 挂起拖死启动流程)
 *   3. 取响应里第一张含 filename 的图片作为探针
 *   4. 用探针逐个候选根拼路径,existsSync 命中即返回该根
 *
 * 边界:任何环节失败(HTTP 非 2xx/超时/无探针/无命中)都归一到 null,
 * 调用方退化为"只用 scanRoot 候选"的保守模式。
 */
export async function detectComfyOutputDir(
  baseUrl: string,
  scanRoot: string,
): Promise<string | null> {
  const candidates: string[] = [];
  if (scanRoot) {
    candidates.push(join(scanRoot, 'today'));
    candidates.push(scanRoot);
  }
  const home = homedir();
  candidates.push(
    join(home, 'ComfyUI', 'output'),
    join(home, 'comfy', 'ComfyUI', 'output'),
    join(home, 'comfy', 'output'),
  );
  if (process.platform === 'win32') {
    candidates.push('C:/ComfyUI/output', 'D:/ComfyUI/output');
  }

  try {
    // fetch 超时防护:10s 未响应即 abort,finally 中清理定时器
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/history?max_items=1`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) {
      return null;
    }
    const raw = (await resp.json()) as Record<string, { outputs?: Record<string, { images?: unknown }> }>;
    // 找第一张含 filename 的图片作为探测探针(响应字段形状同 parseHistoryImages)
    let probe: ComfyImageRef | null = null;
    for (const entry of Object.values(raw)) {
      for (const node of Object.values(entry?.outputs ?? {})) {
        for (const img of Array.isArray(node?.images) ? node.images : []) {
          if (img && typeof img === 'object') {
            const ref = img as Partial<ComfyImageRef>;
            if (ref.filename) {
              probe = {
                filename: String(ref.filename),
                subfolder: String(ref.subfolder ?? ''),
                type: String(ref.type ?? 'output'),
              };
              break;
            }
          }
        }
        if (probe) break;
      }
      if (probe) break;
    }
    if (!probe) {
      return null;
    }
    // 用探针文件验证候选根:谁先命中文件存在性,谁就是输出目录
    for (const root of candidates) {
      try {
        const candidate = probe.subfolder
          ? join(root, probe.subfolder, probe.filename)
          : join(root, probe.filename);
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return resolve(root);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** 图片扩展名白名单(与 parser 扫描一致)。 */
export function isImageFile(path: string): boolean {
  return /\.(png|webp|jpe?g)$/i.test(path);
}

/**
 * 内存缓冲:实时通道(fs.watch / ComfyUI 轮询)只写入路径,
 * flush 循环批量 diff 后入库。上限保护,超限时最旧条目被丢弃。
 *
 * 设计:Map<resolve后的路径, {seenAt, attempts}>——
 *   - key 用 resolve() 归一,防同一文件不同相对写法重复入队
 *   - seenAt 记录首见时间(未来可做滞留告警)
 *   - attempts 记录处理失败次数(flush 失败重试判定,见 takeAll/requeue)
 * 单飞语义:add 对已存在路径返回 false,调用方可据此跳过重复工作。
 */
export class PendingBuffer {
  private readonly entries = new Map<string, { seenAt: number; attempts: number }>();

  /**
   * @param maxSize 容量上限(默认 5000);超限时按插入序丢弃最旧条目,
   *                避免 fs.watch 风暴(单次批量拷贝数千文件)撑爆内存
   */
  constructor(private readonly maxSize = 5000) {}

  /**
   * 入队一个待处理路径。
   * @param path 任意形式路径(内部 resolve 归一)
   * @returns true 表示新增;false 表示已存在(调用方可跳过)
   */
  add(path: string): boolean {
    const resolved = resolve(path);
    if (this.entries.has(resolved)) {
      return false;
    }
    if (this.entries.size >= this.maxSize) {
      // 满员时淘汰最旧(Map 迭代序 = 插入序,首个即最旧)
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    this.entries.set(resolved, { seenAt: Date.now(), attempts: 0 });
    return true;
  }

  /** 查询路径是否在缓冲中(resolve 归一后判定)。 */
  has(path: string): boolean {
    return this.entries.has(resolve(path));
  }

  /** 返回当前全部待处理路径(不 drain)。 */
  paths(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * 批量取出全部待处理路径并清空。
   * 适用:处理方不关心失败重试的简单场景(路径交给 diff 逻辑,
   * 失败由下一轮扫描兜底)。
   */
  drain(): string[] {
    const paths = [...this.entries.keys()];
    this.entries.clear();
    return paths;
  }

  /**
   * 批量取出全部待处理条目(保留 attempts,供 flush 失败重试判断)。
   * 与 drain 的区别:返回值带 attempts 计数,清空后处理失败的路径
   * 可经 requeue 放回并累加次数。
   */
  takeAll(): Array<{ path: string; attempts: number }> {
    const items = [...this.entries.entries()].map(([path, { attempts }]) => ({
      path,
      attempts,
    }));
    this.entries.clear();
    return items;
  }

  /**
   * 处理失败时放回(带 attempts 计数;显式传入 attempts 时以其为准)。
   * @param path     失败路径
   * @param attempts 显式指定重试次数(可选);缺省时在原有基础上 +1
   *
   * 注意:放回会刷新 seenAt 吗?不会——保留原 seenAt,避免重试
   * 掩盖滞留时长。attempts 供调用方做"重试 N 次后放弃"策略。
   */
  requeue(path: string, attempts?: number): void {
    const resolved = resolve(path);
    const prev = this.entries.get(resolved);
    this.entries.set(resolved, {
      seenAt: prev?.seenAt ?? Date.now(),
      attempts: attempts ?? (prev?.attempts ?? 0) + 1,
    });
  }

  /** 当前缓冲大小。 */
  size(): number {
    return this.entries.size;
  }

  /** 查询路径的重试次数(不在缓冲中返回 0)。 */
  getAttempts(path: string): number {
    return this.entries.get(resolve(path))?.attempts ?? 0;
  }
}
