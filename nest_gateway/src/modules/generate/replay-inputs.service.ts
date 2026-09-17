/**
 * Replay 输入素材探活与回填(replay-inputs.service.ts)。
 *
 * 解决的问题:重放含参考图的工作流时,若 ComfyUI 宿主机 input/temp 目录里
 * 对应的文件已被清理,提交后 ComfyUI 会直接抛"文件未找到",网关侧完全没有
 * 前置探测;更关键的是——把库内图片喂进 ComfyUI 是血缘回路闭合的前提:
 * 源图在库内 → 提交时上传到 ComfyUI input/ → 生成图的写入侧记录
 * `is_changed` 内容哈希 → 该哈希与 `batch_images.content_sha256` 相等 →
 * 血缘边解析为 resolved。
 *
 * 职责边界:
 *   1. 探活(只读):对提交负载里每个图像 loader 引用,问 ComfyUI
 *      `GET /view?filename=..&subfolder=..&type=input|temp` 是否可达
 *   2. 回填(Upload-if-missing):缺失时用**与血缘解析同一套三级匹配**
 *      (内容哈希 → 精确路径 → 唯一文件名)在库内找回源图,读字节后
 *      POST /upload/image 传回 ComfyUI,并按需要改写 prompt 引用
 *   3. 如实报告:既不在库内也不在 ComfyUI = 必然执行失败,交由调用方
 *      前置拒绝(避免提交一个注定崩掉的任务)
 *
 * 关键设计取舍:
 *   - **探活不确定不阻断**:ComfyUI 不可达/探测报错时整体跳过(返回零计数),
 *     让 ComfyUI 自己报错。把"探测失败"当"文件缺失"会在网络抖动时误拒
 *     正常提交。
 *   - **同名上传优先**:上传名取引用 basename,使 prompt 不必改写;只有
 *     ComfyUI 返回的实际落盘名不同(去重改名)才改写对应节点输入。
 *   - **只处理图像 loader**:节点清单由 worker 的 image_loader_refs 给出,
 *     与血缘候选共用同一 loader 定义,避免"探活过的图"与"记进血缘的图"错位。
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { extname, join } from 'path';
import { ParseWorkerService } from '../../workers/parse-worker.service';
import type { ImageLoaderRef } from '../../workers/parse-worker';
// 注意:必须是**值导入**(不能 `import type`)——Nest 靠 emit 的 design:paramtypes
// 解析依赖,类型导入会被完全擦除,运行时报 "can't resolve dependencies ... Function"。
// 单测直接 new 该类不会暴露这一点,故有一条元数据守卫测试盯着(见 spec)。
import { LineageService } from '../lineage/lineage.service';

/** 探活/上传共用的最小 fetch 契约(测试注入打桩;默认 globalThis.fetch)。 */
export type FetchLike = (
  url: string,
  init?: { method?: string; body?: FormData; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}>;

/** 一个探不到的引用(库内也没有 → 提交必然失败)。 */
export interface MissingReplayInput {
  node_id: string;
  raw_ref: string;
}

/**
 * 待归档的输入素材:只在 ComfyUI 侧存在、库内没有的源图。
 *
 * 这类素材(外站下载图、ComfyUI 临时文件、画板涂鸦)是血缘边的父节点,
 * 但 ComfyUI 的 input/temp 是可清理目录——不在任务完成时取回入库,
 * 源图消失后血缘边就永久停在 unresolved/ambiguous。条目在探活阶段顺手
 * 判定产出,零额外探测。
 */
export interface ReplayInputCapture {
  node_id: string;
  raw_ref: string;
  /** 在 ComfyUI 侧的文件名(取字节用) */
  filename: string;
  /** input/temp 下的子目录(clipspace 等) */
  subfolder: string;
}

export interface EnsureInputsResult {
  /** 实际探活的去重引用数 */
  checked: number;
  /** ComfyUI 侧本来就在的引用数 */
  present: number;
  /** 由库内回填上传的引用数 */
  uploaded: number;
  /** 既不在 ComfyUI 也无法从库内找回的引用(调用方据此前置拒绝) */
  missing: MissingReplayInput[];
  /** 仅存于 ComfyUI 的素材(调用方在任务完成后归档,见 captureMaterials) */
  capture: ReplayInputCapture[];
}

/** 探活超时:单次 /view 探测上限(图片可能较大,给足 15s)。 */
const PROBE_TIMEOUT_MS = 15_000;
/** 上传超时:整张源图经 multipart 上传的上限。 */
const UPLOAD_TIMEOUT_MS = 60_000;
/** 素材取回超时:归档时下载源图的单次上限(比探活宽,图片可能较大)。 */
const CAPTURE_TIMEOUT_MS = 60_000;

/** loader 引用的解析结果(input 与 temp 两个候选位置)。 */
interface RefLocation {
  filename: string;
  subfolder: string;
}

/** ComfyUI 容器内的根前缀(`/app/comfyui`、`/workspace/ComfyUI` 等):整段剥掉。 */
const CONTAINER_ROOT_RE = /^(?:[a-z]:)?(?:\/(?:app|comfyui|workspace))*\/(?:app|comfyui|workspace)(?=\/)/i;
/** input/ 或 temp/ 段本身:它是"类型"而非子目录,探活时单独指定。 */
const TYPE_SEGMENT_RE = /^(?:input|temp)$/i;
/** ComfyUI 在文件名后附的来源标记(` [input]` / ` [temp]`,可多层叠加)。 */
const REF_SUFFIX_RE = /\s+\[(?:input|temp)\]$/i;

/**
 * 把 loader 的 raw_ref 归一到 ComfyUI `input/` 下的相对位置。
 *
 * 与 Python 侧 `image_lineage._clean_ref` 同一套语义(两侧必须等价:worker
 * 下发什么、网关就按什么探活):
 *   1. 剥净 ` [input]` / ` [temp]` 尾注(可多层)——
 *      worker 本该剥好,这里再剥一次是防御旧 worker 下发脏引用:
 *      带尾注会让 `/view` 必然 404,把在库的图误判缺失并重复上传
 *   2. 反斜杠统一为正斜杠
 *   3. 去掉容器根(`/app/comfyui` 等)
 *   4. 去掉 `input` / `temp` 段(类型由调用方按 input→temp 顺序探测)
 *   5. 其余段最后一个是 filename,前面的是真实 subfolder;若前面出现盘符
 *      (`C:` 等)说明是外部路径,此时只认 filename(外部目录不是
 *      ComfyUI 内的合法子目录)
 *
 * 实测 raw_ref 形态混杂:纯文件名、`clipspace/x.png`(画板涂鸦的真实子目录)、
 * Docker 内路径 `/app/comfyui/input/x.png`、以及另一台机器的 Windows 绝对路径
 * `C:\Projects\...\x.png`。不归一的后果:探活会去问
 * `input/app/comfyui/input/x.png`(必然 404),把本来就在 ComfyUI 上的图
 * 误判为缺失,再重复上传一份。
 *
 * @param rawRef loader 引用原文
 * @returns {filename, subfolder};空引用返回双空串
 */
export function splitRefLocation(rawRef: string): RefLocation {
  let cleaned = String(rawRef ?? '')
    .trim()
    .replace(/\\/g, '/');
  let stripped = cleaned.replace(REF_SUFFIX_RE, '');
  while (stripped !== cleaned) {
    cleaned = stripped;
    stripped = cleaned.replace(REF_SUFFIX_RE, '');
  }
  if (!cleaned) return { filename: '', subfolder: '' };
  cleaned = cleaned.replace(CONTAINER_ROOT_RE, '');
  const segments = cleaned.split('/').filter(Boolean);
  // 去掉 input/temp 段(可能与容器前缀相邻,也可能独立出现)
  const rest = segments.filter((segment) => !TYPE_SEGMENT_RE.test(segment));
  // 外部绝对路径(残留盘符段):目录结构来自别的机器,不是 ComfyUI 子目录
  const hasDriveSegment = rest.some((segment) => /^[a-z]:$/i.test(segment));
  const filename = rest.pop() ?? '';
  if (hasDriveSegment) {
    return { filename, subfolder: '' };
  }
  return { filename, subfolder: rest.join('/') };
}

@Injectable()
export class ReplayInputsService {
  private readonly logger = new Logger(ReplayInputsService.name);
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: ConfigService,
    private readonly worker: ParseWorkerService,
    private readonly lineage: LineageService,
    // 测试注入口:生产运行时由 Nest 传入 undefined,回落到 globalThis.fetch。
    // @Optional() 是必需的——否则 Nest 会把这个函数类型当作待解析依赖,
    // 报 "can't resolve dependencies of the ReplayInputsService"。
    @Optional() fetchImpl?: FetchLike,
  ) {
    this.fetchImpl =
      fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /**
   * 提交前确保所有图像 loader 引用在 ComfyUI 侧可用。
   *
   * @param prompt 即将提交的 API 负载(会被就地改写:引用名变化时同步更新)
   * @returns 探活/回填/缺失计数
   *
   * 内部逻辑(分步):
   *   1. 取 loader 清单(worker RPC);空清单直接返回
   *   2. 按 raw_ref 去重(同一张图喂多个 loader 只探一次)
   *   3. 逐个探活:/view 先 input 后 temp,2xx 即视为在
   *   4. 缺失的:库内三级匹配找回 → 读字节 → POST /upload/image 同名上传;
   *      ComfyUI 返回落盘名不同则改写该 ref 的全部节点输入
   *   5. 仍无法找回的记入 missing,交由调用方拒绝提交
   *
   * 边界:任何一步探测超时/报错都视为"不确定"——整体跳过探活(不误拒);
   * 单张图回填失败不影响其余图;上传异常只记日志并计入 missing。
   */
  async ensureInputs(prompt: Record<string, unknown>): Promise<EnsureInputsResult> {
    const result: EnsureInputsResult = {
      checked: 0,
      present: 0,
      uploaded: 0,
      missing: [],
      capture: [],
    };
    let refs: ImageLoaderRef[];
    try {
      refs = await this.worker.imageLoaderRefs(prompt);
    } catch (err) {
      // worker 不可用:探活是辅助步骤,不能因此阻断提交
      this.logger.warn(
        `image loader refs unavailable, skip preflight: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return result;
    }
    if (!refs.length) return result;

    // raw_ref 去重:同一张参考图喂多个 loader(CN + i2i)只探一次、只传一次
    const byRef = new Map<string, ImageLoaderRef[]>();
    for (const ref of refs) {
      const key = String(ref.raw_ref ?? '').trim();
      if (!key) continue;
      const bucket = byRef.get(key) ?? [];
      bucket.push(ref);
      byRef.set(key, bucket);
    }

    const baseUrl = String(
      this.config.get<string>('comfyuiBaseUrl') ?? 'http://127.0.0.1:8188',
    ).replace(/\/+$/, '');

    /** 待探活的引用条目(去重后,带解析好的位置)。 */
    const entries: Array<{
      rawRef: string;
      group: ImageLoaderRef[];
      location: RefLocation;
    }> = [];

    for (const [rawRef, group] of byRef) {
      result.checked += 1;
      const location = splitRefLocation(rawRef);
      if (!location.filename) continue;
      entries.push({ rawRef, group, location });
    }
    if (!entries.length) return result;

    // 并发探活:引用之间互不依赖(各自只读 ComfyUI),串行时耗时随引用数
    // 线性叠加(实测每个服务端延迟 5ms 时 8 个引用串行 84ms、并发 16ms)。
    // 真实工作流实测最多 18 个 loader,串行白等多轮往返。
    // 全部探完再决策:原串行版遇到"不确定"就地返回,语义是整体放弃探活
    // (返回全零计数)——并发版同样在任一处不确定时返回全零,行为一致。
    const probes = await Promise.all(
      entries.map((entry) => this.probe(baseUrl, entry.location)),
    );
    if (probes.some((probe) => probe === 'unknown')) {
      // 探测不确定:整体放弃探活(含素材清单),交回 ComfyUI 自己的报错
      return { checked: 0, present: 0, uploaded: 0, missing: [], capture: [] };
    }

    for (let i = 0; i < entries.length; i += 1) {
      const { rawRef, group, location } = entries[i];
      if (probes[i] === 'present') {
        result.present += 1;
        // 只存于 ComfyUI 的素材要归档:库内已有时跳过(已有记录无需重复,
        // 重复归档反而让内容哈希多解)。这一步复用回填的同一套库内匹配,
        // 库内查找失败=素材不在库内,恰好就是"需要归档"的判据。
        const inLibrary = (await this.lookupLibrary(group[0])) !== null;
        if (!inLibrary) {
          result.capture.push({
            node_id: String(group[0].node_id ?? ''),
            raw_ref: rawRef,
            filename: location.filename,
            subfolder: location.subfolder,
          });
        }
        continue;
      }

      const uploadedName = await this.backfill(prompt, group[0], baseUrl, location);
      if (uploadedName === null) {
        result.missing.push({
          node_id: String(group[0].node_id ?? ''),
          raw_ref: rawRef,
        });
        continue;
      }
      result.uploaded += 1;
      if (uploadedName !== location.filename) {
        this.rewriteRef(prompt, group, rawRef, uploadedName);
      }
    }
    return result;
  }

  /**
   * 把仅存于 ComfyUI 的输入素材取回落到本地内容寻址目录。
   *
   * 生成任务完成后 ComfyUI 的 input/temp 可能被清理;素材不在库里,
   * 血缘边的父节点就永久缺失。落盘命名 <dataDir>/inputs/<内容哈希><扩展名>:
   * 内容寻址保证同一素材只存一份(重复捕获直接复用),也让入库后的
   * content_sha256 与素材字节天然一致——血缘按内容哈希即可解析父图。
   *
   * @param captures ensureInputs 产出的素材清单
   * @returns 落盘(或已存在)的绝对路径;单条失败只记日志并跳过
   *
   * 内部逻辑:
   *   1. 逐条从 ComfyUI /view(input 优先、temp 兜底)取字节
   *   2. 算内容哈希;已在库内(同哈希)则跳过——避免同内容第二份记录
   *   3. 目标文件已存在或本轮已写过 → 复用;否则写盘
   * 边界:取字节/写盘失败都只记日志,不抛出——归档不该因单张素材失败中断。
   */
  async captureMaterials(
    captures: ReplayInputCapture[],
  ): Promise<string[]> {
    const baseUrl = String(
      this.config.get<string>('comfyuiBaseUrl') ?? 'http://127.0.0.1:8188',
    ).replace(/\/+$/, '');
    const dataDir = String(this.config.get<string>('dataDir') ?? '').trim();
    const written: string[] = [];
    const seenDigest = new Set<string>();

    for (const item of captures) {
      if (!item.filename) continue;
      const bytes = await this.fetchMaterialBytes(baseUrl, item);
      if (!bytes) continue;
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (seenDigest.has(digest)) continue;
      seenDigest.add(digest);
      // 同内容已在库内:素材本身已记录,再落一份会让按内容哈希解析父图多解
      try {
        if (await this.lineage.locateLibraryImage({ raw_ref: '', content_sha256: digest })) {
          continue;
        }
      } catch {
        // 库内查询失败按"未入库"处理:宁可多存一份可清理的副本
      }
      if (!dataDir) continue;
      const target = join(dataDir, 'inputs', `${digest}${extname(item.filename)}`);
      try {
        if (!existsSync(target)) {
          await mkdir(join(dataDir, 'inputs'), { recursive: true });
          await writeFile(target, bytes);
        }
        written.push(target);
      } catch (err) {
        this.logger.warn(
          `capture material failed for ${item.raw_ref}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return written;
  }

  /** 从 ComfyUI /view 取素材字节(input 优先、temp 兜底);取不到返回 null。 */
  private async fetchMaterialBytes(
    baseUrl: string,
    item: ReplayInputCapture,
  ): Promise<Buffer | null> {
    for (const type of ['input', 'temp'] as const) {
      const params = new URLSearchParams({
        filename: item.filename,
        subfolder: item.subfolder,
        type,
      });
      try {
        const resp = await this.fetchImpl(`${baseUrl}/view?${params}`, {
          signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
        });
        if (!resp.ok || !resp.arrayBuffer) continue;
        return Buffer.from(await resp.arrayBuffer());
      } catch {
        continue;
      }
    }
    return null;
  }

  /** 库内查找(与回填共用),查询异常按未命中处理。 */
  private async lookupLibrary(
    ref: ImageLoaderRef,
  ): Promise<Awaited<ReturnType<LineageService['locateLibraryImage']>>> {
    try {
      return await this.lineage.locateLibraryImage({
        raw_ref: String(ref.raw_ref ?? ''),
        content_sha256: ref.content_sha256 ?? null,
      });
    } catch (err) {
      this.logger.warn(
        `library lookup failed for ${String(ref.raw_ref ?? '')}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * 探活单个引用:input 优先,temp 兜底。
   * @returns 'present' 命中 / 'missing' 明确 404 / 'unknown' 探测不确定
   */
  private async probe(
    baseUrl: string,
    location: RefLocation,
  ): Promise<'present' | 'missing' | 'unknown'> {
    // 两个候选位置都 404 才算缺失;任一不确定即不确定
    let sawUnknown = false;
    for (const type of ['input', 'temp'] as const) {
      const params = new URLSearchParams({
        filename: location.filename,
        subfolder: location.subfolder,
        type,
      });
      try {
        const resp = await this.fetchImpl(`${baseUrl}/view?${params}`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (resp.ok) return 'present';
        if (resp.status !== 404 && resp.status !== 400) sawUnknown = true;
      } catch {
        sawUnknown = true;
      }
    }
    return sawUnknown ? 'unknown' : 'missing';
  }

  /**
   * 从库内找回源图并上传到 ComfyUI input/。
   *
   * @param prompt   提交负载(不改写;改写由调用方在拿到返回名后做)
   * @param ref      该引用的 loader 条目(带内容哈希)
   * @param baseUrl  ComfyUI 地址
   * @param location 引用位置(决定上传名)
   * @returns 实际落盘的文件名;库内找不到/读取或上传失败返回 null
   *
   * 为什么用 locateLibraryImage 而不是自己查库:该方法的匹配优先级
   * (内容哈希 → 精确路径 → 唯一文件名)与血缘边解析完全一致——
   * 若库内匹配不到,血缘边同样解析不了,此处如实报缺失即可。
   */
  private async backfill(
    prompt: Record<string, unknown>,
    ref: ImageLoaderRef,
    baseUrl: string,
    location: RefLocation,
  ): Promise<string | null> {
    const located = await this.lookupLibrary(ref);
    const localPath = located?.resolved_path;
    if (!localPath) return null;

    let bytes: Buffer;
    try {
      bytes = await readFile(localPath);
    } catch {
      return null;
    }

    try {
      const form = new FormData();
      form.set('image', new Blob([new Uint8Array(bytes)]), location.filename);
      form.set('filename', location.filename);
      // overwrite=true:避免 ComfyUI 去重改名导致 prompt 引用错位
      form.set('overwrite', 'true');
      form.set('type', 'input');
      const resp = await this.fetchImpl(`${baseUrl}/upload/image`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      const payload = (await resp.json?.()) as { name?: unknown } | undefined;
      const name = String(payload?.name ?? '').trim();
      return name || location.filename;
    } catch (err) {
      this.logger.warn(
        `upload-if-missing failed for ${location.filename}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * 把引用了 rawRef 的全部 loader 节点指向新落盘名。
   *
   * 改写字段由 worker 随引用一并给出(raw_ref_field):与提取侧同一份
   * 优先级定义,"提取认得的字段"必然改写得到,不会因两处字段表分叉而漏改。
   */
  private rewriteRef(
    prompt: Record<string, unknown>,
    group: ImageLoaderRef[],
    rawRef: string,
    uploadedName: string,
  ): void {
    const target = splitRefLocation(rawRef);
    const replacement = target.subfolder
      ? `${target.subfolder}/${uploadedName}`
      : uploadedName;
    for (const ref of group) {
      const node = prompt[String(ref.node_id ?? '')];
      if (!node || typeof node !== 'object') continue;
      const inputs = (node as { inputs?: Record<string, unknown> }).inputs;
      if (!inputs) continue;
      const field = String(ref.raw_ref_field ?? '').trim();
      if (!field) continue;
      if (typeof inputs[field] === 'string') inputs[field] = replacement;
    }
  }
}
