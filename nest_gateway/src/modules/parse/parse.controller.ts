import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { existsSync, statSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { Model } from 'mongoose';
import type Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { basename, extname, join } from 'path';
import { Images, ImagesDocument } from '../../schemas';
import { ParseWorkerService } from '../../workers/parse-worker.service';
import { SQLITE_DB } from '../../sqlite/sqlite.module';
import { batchBySha256 } from '../../sqlite/reader';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { firstAccessiblePath } from '../../lib/paths';
import { buildSeedImages } from '../../lib/seed_images';
import {
  WorkerRequestTimeout,
  WorkerRpcError,
  WorkerUnavailableError,
} from '../../workers/parse-worker';
import { ThumbCache } from './thumb-cache';
import { isEnginePending } from '../../lib/engine';
import { RequireAuth } from '../../common/auth';
import { instanceStamp } from '../../lib/instance';
import {
  isPassthroughRequest,
  passthroughPath,
  passthroughTarget,
  proxyToPeer,
} from '../../lib/passthrough';

// 缩略图边长合法区间:[64, 1024],越界/非整数由 parseSize 抛 422
const THUMB_MIN = 64;
const THUMB_MAX = 1024;
// 未传 w/h 时的默认边长(360px,兼顾清晰度与渲染成本)
const THUMB_DEFAULT = 360;

// ComfyUI /view 回读超时(20s):超时 abort,防止 ComfyUI 无响应时挂住请求
const COMFY_VIEW_TIMEOUT_MS = 20_000;

// P1#8:内存缓冲上传必须限流(32MB 单文件,单文件),超限由 multer 抛 413
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

// P1#14:ComfyUI /view 参数白名单(路径穿越/SSRF 防护)
// filename/subfolder 允许字符集:字母数字与 . _ - /(斜杠仅用于子目录拼接)
const COMFY_VIEW_NAME_RE = /^[A-Za-z0-9._\-\/]+$/;
// 允许的 type 取值:ComfyUI /view 仅支持 output/temp/input 三类目录
const COMFY_VIEW_TYPES = new Set(['output', 'temp', 'input']);
// 控制字符集合(0x00-0x1F 与 DEL):路径参数中一律拒绝
const COMFY_VIEW_CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * multer 上传文件的轻量形状(与 Express.Multer.File 兼容的子集):
 * originalname —— 客户端原始文件名(取 basename 后用于展示与扩展名判定);
 * buffer —— 文件内容(内存缓冲,受 FileInterceptor limits.fileSize 限制);
 * size —— 字节数(超限时 multer 直接抛 413,不会到达 handler)。
 */
interface UploadedFileLike {
  originalname?: string;
  buffer?: Buffer;
  size?: number;
}

/**
 * ============================================================
 * parse.controller — WorkflowDB NestJS 网关的解析/缩略图/ComfyUI 视图接口层。
 *
 * 文件职责:
 *  1. 图片解析 /api/parse-image(上传文件)与 /api/parse-comfy-image
 *     (从 ComfyUI /view 回读),产出 transient 详情结构;
 *  2. 缩略图 /api/thumb/:sha256(worker 渲染 WebP + 内存 LRU 缓存);
 *  3. ComfyUI /view 的受控回读(SSRF/路径穿越防护)。
 *
 * 路由一览(前缀 /api):
 *   POST /api/parse-image        —— multipart 上传单图(≤32MB),解析后返回详情
 *   POST /api/parse-comfy-image  —— 按 {filename,subfolder,type} 从 ComfyUI
 *                                    /view 回读图片再解析
 *   GET  /api/thumb/:sha256      —— 缩略图(WebP,w/h 可选 64~1024)
 *
 * 数据流向:
 *   parse-image:请求体(multer 内存缓冲)→ parseTempImagePayload → 临时目录
 *     落盘 → ParseWorkerService.parseImage → 整形 shapeSingleRecordDetail
 *     → 前端 Detail 结构(source_mode=transient)。
 *   parse-comfy-image:入参白名单校验 → fetchComfyViewImage(带超时/类型校验)
 *     → 同一 parseTempImagePayload 链路。
 *   thumb:ThumbCache 命中 → 直接回;未命中 → findResolvedPath(SQLite/Mongo/
 *     内存视图,失败走纯远程透传)→ worker.makeThumb 渲染 → 写缓存 → sendWebp。
 *
 * 前端消费对应:解析结果复用前端 Detail 详情渲染;缩略图以
 * <img src="/api/thumb/<sha256>?w=360&h=360"> 形式在卡片/详情页使用,
 * 响应带 Cache-Control: public, max-age=86400 供浏览器缓存。
 * ============================================================
 */
/**
 * Mirrors legacy FastAPI /api/thumb/{sha256} (app.py:1994-2024):
 * cache lookup -> resolve path from Mongo -> render -> cache -> bytes.
 */
@Controller('api')
export class ParseController {
  // 缩略图内存缓存:键 sha256+w+h → WebP 字节,LRU 上限 500 条
  // (协议 §10:缓存归网关持有,worker 每次渲染新字节,见 thumb-cache.ts)
  private readonly thumbCache = new ThumbCache();
  // SQLite 只读模式:路径/元数据查询走 better-sqlite3,不依赖 Mongo
  private readonly readMode: boolean;

  constructor(
    private readonly worker: ParseWorkerService,
    private readonly config: ConfigService,
    private readonly orchestration: OrchestrationService,
    @Inject(SQLITE_DB) private readonly sqliteDb: Database.Database,
    @InjectModel(Images.name)
    private readonly imagesModel: Model<ImagesDocument>,
  ) {
    this.readMode = this.config.get<boolean>('sqlite.readMode') ?? false;
  }

  // ----------------------------------------------------------- /api/parse-image

  /**
   * POST /api/parse-image — multipart 单图上传并解析(需登录)。
   *
   * 入参:multipart 字段 file(FileInterceptor:≤32MB、单文件,超限 413)。
   * 流程:引擎就绪与文件名/内容校验 → parseTempImagePayload(临时目录落盘 →
   * worker.parseImage → transient 详情整形)。
   * 返回:shapeSingleRecordDetail 产物(前端 Detail 结构,source_mode=transient)。
   * 异常:纯远程待配库 → 503;缺文件名/空内容 → 400;解析失败 → 400(附摘要)。
   */
  @Post('parse-image')
  @RequireAuth()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  async parseUploadedImage(
    @UploadedFile() file?: UploadedFileLike,
  ): Promise<Record<string, unknown>> {
    // 纯远程待配库:解析结果无处可写
    if (isEnginePending(this.config)) {
      throw new ServiceUnavailableException(
        '未配置数据库(纯远程模式:请在设置页配置 MongoDB 连接串后重启)',
      );
    }
    // 文件名必填:用于扩展名推断与展示名;空白视为缺失
    const filename = String(file?.originalname ?? '').trim();
    if (!filename) {
      throw new BadRequestException('filename is required');
    }
    // 内容非空校验(0 字节文件无法解析)
    const payload = file?.buffer;
    if (!payload || payload.length === 0) {
      throw new BadRequestException('uploaded file is empty');
    }
    try {
      return await this.parseTempImagePayload(payload, filename);
    } catch (err) {
      // 已有 HTTP 语义的异常(worker 503 等)直接透传;
      // 其余解析失败统一 400,并附截断错误摘要便于前端/日志定位
      if (err instanceof HttpException) {
        throw err;
      }
      throw new BadRequestException(
        `Unable to parse uploaded image: ${this.summarizeError(err)}`,
      );
    }
  }

  // ----------------------------------------------------------- /api/parse-comfy-image

  /**
   * POST /api/parse-comfy-image — 从 ComfyUI /view 回读图片并解析(需登录)。
   *
   * 入参:{ filename(必填), subfolder?, type? },全部经 fetchComfyViewImage
   * 的白名单校验(防 SSRF/路径穿越)。
   * 用途:前端"解析 ComfyUI 当前输出图"——图片由 ComfyUI 托管、不在本地
   * 扫描目录,先回读到内存再走解析链路。
   * 返回:与 parse-image 相同的 transient Detail 结构。
   */
  @Post('parse-comfy-image')
  @RequireAuth()
  async parseComfyImage(
    @Body() body: { filename?: string; subfolder?: string; type?: string },
  ): Promise<Record<string, unknown>> {
    if (isEnginePending(this.config)) {
      throw new ServiceUnavailableException(
        '未配置数据库(纯远程模式:请在设置页配置 MongoDB 连接串后重启)',
      );
    }
    // 文件名必填(subfolder/type 可缺省,内部有默认值)
    const filename = String(body.filename ?? '').trim();
    if (!filename) {
      throw new BadRequestException('filename is required');
    }
    try {
      // 先经白名单校验 + 超时保护从 ComfyUI /view 回读图片内容
      const payload = await this.fetchComfyViewImage(
        filename,
        body.subfolder,
        body.type,
      );
      // 复用上传解析链路:落临时目录 → worker 解析 → transient 整形
      return await this.parseTempImagePayload(payload, filename);
    } catch (err) {
      // 与 parse-image 相同策略:HTTP 异常透传,其余 400 + 摘要
      if (err instanceof HttpException) {
        throw err;
      }
      throw new BadRequestException(
        `Unable to parse ComfyUI image: ${this.summarizeError(err)}`,
      );
    }
  }

  /**
   * 复刻旧版 _write_payload_to_temp_file + _parse_temp_image_payload:
   * 写入 os.tmpdir 下的临时目录(前缀 workflow_db_parse_)、parseImage、
   * file 字段改写为 transient 语义,finally 删除临时目录。
   *
   * 输入:payload —— 图片二进制;originalName —— 原始文件名。
   * 输出:shapeSingleRecordDetail 的 transient 详情(不入库、无持久路径)。
   * 关键语义:file 字段被改写为 is_transient_upload=true 的"虚拟文件"——
   * resolved_path/source_path/windows_path 置 null,只保留文件名与哈希,
   * 前端据此呈现"临时上传"态并禁用本地文件操作。
   */
  private async parseTempImagePayload(
    payload: Buffer,
    originalName: string,
  ): Promise<Record<string, unknown>> {
    // worker 已失败:503,避免把 worker 故障伪装成图片解析失败
    if (this.worker.getState() === 'failed') {
      throw new ServiceUnavailableException('parse worker unavailable');
    }
    // 文件名归一:仅取 basename(去客户端路径),缺省回落 upload.png
    const filename = basename(originalName || 'upload.png') || 'upload.png';
    // 扩展名保留原始格式(PNG/JPG/WebP 等),无扩展名回落 .png
    const suffix = extname(filename) || '.png';
    // 独立临时目录:并发上传互不干扰,finally 统一回收
    const tempDir = await mkdtemp(join(tmpdir(), 'workflow_db_parse_'));
    const tempPath = join(
      tempDir,
      `${basename(filename, extname(filename))}${suffix}`,
    );
    try {
      // 落盘后交给 worker 解析(scanRoot 传空:不关联扫描目录)
      await writeFile(tempPath, payload);
      const record = await this.worker.parseImage(tempPath, '');
      // ---- file 字段 transient 化 ----
      // 解析出的 resolved_path 指向临时文件(即将删除),必须置 null:
      // 防止前端/透传把临时路径当持久路径使用
      const file = (record.file ?? {}) as Record<string, unknown>;
      file.filename = filename;
      file.image_name = basename(filename, extname(filename));
      file.source_path = null;
      file.resolved_path = null;
      file.relative_path = filename;
      file.windows_path = null;
      // transient 标记:前端识别"临时上传"来源(无本地文件可操作)
      file.is_transient_upload = true;
      record.file = file;
      // 展示补全是 best-effort:失败时必须退回 parser 原始 Record,不能让
      // enrichment 影响上传解析的可用性或持久化语义。
      let effectiveRecord = record;
      let enrichment:
        | {
            diagnostics: Record<string, unknown>;
            provenance: Record<string, unknown>;
          }
        | undefined;
      try {
        const enriched = await this.worker.enrichRecord(record);
        effectiveRecord = enriched.effective_record;
        enrichment = {
          diagnostics: enriched.diagnostics,
          provenance: enriched.provenance,
        };
      } catch {
        // Older/unavailable workers still return the authoritative parser view.
      }
      // diagnostics/provenance 放在展示包装中,不混入 Record 或后续入库路径。
      const detail = this.shapeSingleRecordDetail(effectiveRecord);
      if (enrichment) {
        detail.enrichment = enrichment;
      }
      return detail;
    } finally {
      // 无论成败删除临时目录(force 吞掉不存在等错误)
      await rm(tempDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  /**
   * 复刻旧版 _fetch_comfy_view_image:GET {comfyuiBaseUrl}/view,20s 超时。
   * P1#14 SSRF/路径穿越防护:
   *   - filename/subfolder 仅允许 [A-Za-z0-9._-/],拒绝 `..`、`\`、控制字符;
   *   - type 仅允许 output|temp|input;
   *   - 响应 content-type 必须为 image/*,否则拒绝(防内网探测/非图片回读)。
   *
   * 输入:filename(必填)、subfolder(可空)、type(默认 output)。
   * 返回:图片二进制 Buffer。
   * 异常:type 非法 / 参数校验失败 → 400;HTTP 非 2xx → Error(调用方兜底 400);
   * 响应非 image/* → 400;超时 → AbortError(调用方兜底 400)。
   */
  private async fetchComfyViewImage(
    filename: string,
    subfolder?: string,
    imageType?: string,
  ): Promise<Buffer> {
    const baseUrl = (
      this.config.get<string>('comfyuiBaseUrl') ?? 'http://127.0.0.1:8188'
    ).replace(/\/+$/, '');
    // 缺省归位:subfolder 空串、type 默认 output;随后全部走白名单校验
    const subfolderStr = String(subfolder ?? '').trim();
    const type = String(imageType ?? 'output').trim() || 'output';
    // type 白名单:仅 ComfyUI 原生三类目录
    if (!COMFY_VIEW_TYPES.has(type)) {
      throw new BadRequestException('type must be one of: output, temp, input');
    }
    // filename 必须非空、subfolder 允许空串,均拒绝 .. 反斜杠与控制字符
    if (!this.assertComfyViewParam('filename', filename, true)) {
      throw new BadRequestException(
        `invalid filename: only [A-Za-z0-9._\\-/] allowed, no "..", backslash or control characters`,
      );
    }
    if (!this.assertComfyViewParam('subfolder', subfolderStr, false)) {
      throw new BadRequestException(
        `invalid subfolder: only [A-Za-z0-9._\\-/] allowed, no "..", backslash or control characters`,
      );
    }
    // URLSearchParams 负责正确编码查询参数
    const params = new URLSearchParams({
      filename,
      subfolder: subfolderStr,
      type,
    });
    // 20s 超时保护:AbortController + 定时器,finally 清理
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMFY_VIEW_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/view?${params}`, {
        signal: controller.signal,
      });
      // 非 2xx 视为回读失败(调用方统一转 400 并附摘要)
      if (!response.ok) {
        throw new Error(`ComfyUI /view returned HTTP ${response.status}`);
      }
      // 内容类型必须 image/*:即使白名单参数合法,也防止被诱导回读
      // 非图片内容(缩小内网探测面)
      const contentType = String(response.headers.get('content-type') ?? '');
      if (!/^image\//i.test(contentType)) {
        throw new BadRequestException(
          `ComfyUI /view returned unexpected content-type: ${contentType || 'missing'}`,
        );
      }
      return Buffer.from(await response.arrayBuffer());
    } finally {
      // 无论成败都要清掉定时器,避免句柄泄漏
      clearTimeout(timer);
    }
  }

  /**
   * P1#14:ComfyUI 文件路径参数校验。subfolder 允许为空串,filename 必须非空。
   *
   * 输入:value —— 待校验参数;required —— 是否必填(subfolder 传 false)。
   * 返回:是否合法。拒绝规则依次:
   *   1. 空串仅 required=false 时合法;
   *   2. 含 "..":路径穿越;
   *   3. 含反斜杠:Windows 分隔符混用,统一拒绝;
   *   4. 含控制字符(0x00-0x1F / DEL);
   *   5. 不匹配 [A-Za-z0-9._\-/] 白名单。
   */
  private assertComfyViewParam(
    _name: string,
    value: string,
    required: boolean,
  ): boolean {
    if (value === '') return !required;
    if (value.includes('..')) return false;
    if (value.includes('\\')) return false;
    if (COMFY_VIEW_CONTROL_RE.test(value)) return false;
    return COMFY_VIEW_NAME_RE.test(value);
  }

  /**
   * 复刻旧版 _single_record_to_detail + _shape_batch_doc(batch 模式):
   * 单图整形为前端 Detail 结构,source_mode=transient、details_pending=false。
   *
   * 输入:worker.parseImage 的单图 record(文件级)。
   * 输出:单成员 batch 形态的 Detail 文档——batch_key 缺省时取
   * file.sha256 或 filename 兜底;batch 对象与 images.controller 的
   * shapeBatchDoc 结构对齐(key/count/seeds/seed_images/files_preview/images);
   * group_mode='batch'、details_pending=false、source_mode='transient'。
   * 前端消费:Detail 页按 batch/seed_images 渲染;transient 态禁用本地
   * 文件操作并显示"临时上传"标识。
   */
  private shapeSingleRecordDetail(
    record: Record<string, unknown>,
  ): Record<string, unknown> {
    // 组装单成员 image entry:只挑与 ImageEntry 结构兼容的字段,
    // 其余 record 顶层字段(model/prompts 等)保留在 batch 层级
    const imageEntry: Record<string, unknown> = {};
    for (const key of [
      'captured_at',
      'created_date',
      'created_hour',
      'created_weekday',
      'file',
      'metadata',
      'workflow',
    ]) {
      if (key in record) imageEntry[key] = record[key];
    }
    // batch 文档组装:batch_key 优先级 batch_key → sha256 → filename
    const file = (record.file ?? {}) as Record<string, unknown>;
    const batchImages = this.buildBatchImages([imageEntry]);
    const samplers = (record.samplers ?? []) as Array<{
      seed?: unknown;
    }>;
    const doc: Record<string, unknown> = {
      batch_key: record.batch_key ?? file.sha256 ?? file.filename,
      batch_count: 1,
      captured_at: record.captured_at,
      created_date: record.created_date,
      created_hour: record.created_hour,
      created_weekday: record.created_weekday,
      model: record.model ?? {},
      loras: record.loras ?? {},
      prompts: record.prompts ?? {},
      samplers: record.samplers ?? [],
      latent: record.latent ?? {},
      images: [imageEntry],
    };
    if (batchImages.length > 0) {
      doc.file = batchImages[0];
    }
    doc.batch = {
      key: doc.batch_key,
      count: batchImages.length,
      seeds: samplers
        .filter((s) => s.seed !== null && s.seed !== undefined)
        .map((s) => s.seed),
      seed_images: buildSeedImages(samplers, [imageEntry]),
      files_preview: batchImages.slice(0, 5).map((img) => img.filename),
      images: batchImages,
    };
    doc.group_mode = 'batch';
    doc.details_pending = false;
    doc.source_mode = 'transient';
    return doc;
  }

  /**
   * 复刻旧版 _build_batch_images:按 (resolved_path, sha256) 去重,
   * 产出 {filename, sha256, resolved_path, windows_path, width, height}。
   *
   * 输入:images —— image entry 数组(可能含无 file / 无路径的占位)。
   * 输出:去重后的精简 file 列表。为什么用拼接键:同一文件可能经多个源
   * 路径入档(resolved_path 不同),拼接 (resolved_path, sha256) 去重更稳;
   * \u0000 是路径中不会出现的分隔符,杜绝 "ab"+"c" == "a"+"bc" 类歧义。
   */
  private buildBatchImages(
    images: Array<{ file?: Record<string, unknown> }>,
  ): Array<Record<string, unknown>> {
    // Map 键去重:保留每个唯一 (resolved_path, sha256) 组合的首个条目
    const map = new Map<string, Record<string, unknown>>();
    for (const image of images) {
      const f = image?.file;
      // 无 file 或既无哈希也无路径的条目跳过(占位/失败记录)
      if (!f) continue;
      const sha256 = f.sha256 as string | undefined;
      const resolvedPath = f.resolved_path as string | undefined;
      if (!sha256 && !resolvedPath) continue;
      // 组合键以 \u0000 分隔:路径中不会出现的字符,避免拼接歧义
      const key = `${String(resolvedPath ?? '')}\u0000${String(sha256 ?? '')}`;
      if (!map.has(key)) {
        map.set(key, {
          filename: f.filename,
          sha256,
          resolved_path: resolvedPath,
          windows_path: f.windows_path,
          width: f.width,
          height: f.height,
        });
      }
    }
    return [...map.values()];
  }

  /**
   * 错误摘要:把异常消息压成单行并截断到 limit(默认 400)字符,
   * 用于拼进 400 响应消息,便于前端/日志快速定位,防止异常信息拖垮响应体。
   */
  private summarizeError(err: unknown, limit = 400): string {
    const text = (err instanceof Error ? err.message : String(err))
      .replace(/\n/g, ' ')
      .trim();
    if (text.length <= limit) {
      return text;
    }
    return `${text.slice(0, limit)}...<truncated>`;
  }

  // ----------------------------------------------------------- /api/thumb/:sha256

  /**
   * GET /api/thumb/:sha256 — 缩略图(WebP)。
   *
   * 路径参数:sha256;查询参数:w / h(默认 360,区间 [64,1024],
   * 非整数/越界抛 422)。
   * 链路:ThumbCache 命中直接回 → findResolvedPath 定位文件(存储层 +
   * 内存视图兜底,失败则纯远程透传)→ 文件存在性校验 →
   * worker.makeThumb 渲染 → 写缓存 → sendWebp(带 1 天 Cache-Control)。
   * 异常:纯远程待配库 / 未定位文件 / 透传失败 → 404;源文件缺失 → 404;
   * worker 错误经 mapWorkerError 映射(503/504/404/422/500)。
   */
  @Get('thumb/:sha256')
  async getThumbnail(
    @Param('sha256') sha256: string,
    @Query('w') wRaw: string | undefined,
    @Query('h') hRaw: string | undefined,
    @Res() res: Response,
    @Req() req: Request,
  ): Promise<void> {
    // w/h 解析:缺省 360,越界/非整数 422;两参数独立校验
    const w = this.parseSize(wRaw, 'w');
    const h = this.parseSize(hRaw, 'h');

    // 纯远程待配库:直接 404,避免对占位 Mongo 超时
    if (isEnginePending(this.config)) {
      throw new NotFoundException('Image not found');
    }

    // 缓存命中直接回字节,跳过 worker 渲染(内容 sha256 寻址,无需 TTL)
    const cached = this.thumbCache.get(sha256, w, h);
    if (cached) {
      this.sendWebp(res, cached);
      return;
    }

    // 定位本地文件路径(含内存视图兜底);source 供纯远程透传决策
    const { path: resolvedPath, source } = await this.findResolvedPath(sha256);
    if (!resolvedPath) {
      // 纯远程透传:按 image entry 的 source.base_url 代理到持有网关
      // (passthroughTarget 拒绝非 http(s) 与自引用,防环见 lib/passthrough.ts)
      const selfBaseUrl = instanceStamp(this.config).base_url;
      const proxyPolicy = {
        allowedHosts:
          this.config.get<string[]>('remoteProxy.allowedHosts') ?? [],
      };
      const peer = passthroughTarget(
        source ? { source } : undefined,
        selfBaseUrl,
        proxyPolicy,
      );
      const peerPath = passthroughPath(
        source ? { source } : undefined,
        sha256,
        'thumbnail',
        { w: wRaw, h: hRaw },
      );
      if (peer && peerPath && !isPassthroughRequest(req.headers)) {
        // 透传时原样带上 w/h(缺省项不拼),对端渲染同尺寸缩略图
        if (await proxyToPeer(peer, peerPath, res, proxyPolicy)) {
          return;
        }
      }
      throw new NotFoundException('Image not found');
    }
    // 文件存在性复核:记录与磁盘可能已脱节(被移动/删除),防御性检查
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
      throw new NotFoundException('Source file missing');
    }

    // 交给 worker 渲染(协议约定:worker 总是渲染新鲜字节,缓存归网关)
    let thumb;
    try {
      thumb = await this.worker.makeThumb(resolvedPath, w, h);
    } catch (err) {
      // worker 异常(不可用/超时/源文件缺失/参数非法)映射为对应 HTTP 状态
      throw this.mapWorkerError(err);
    }

    // 渲染成功后写缓存,再统一走 sendWebp 下发(缓存键 sha256+w+h)
    this.thumbCache.set(sha256, w, h, thumb.data);
    this.sendWebp(res, thumb.data);
  }

  /**
   * 缩略图边长解析:缺省 THUMB_DEFAULT(360);非整数或越界
   * [THUMB_MIN(64), THUMB_MAX(1024)] 抛 422(UnprocessableEntityException,
   * 与"参数可取但值不可处理"的语义匹配)。
   * 为什么钳制:过小无意义,过大会放大渲染成本并撑爆缓存。
   */
  private parseSize(raw: string | undefined, name: 'w' | 'h'): number {
    if (raw === undefined) {
      return THUMB_DEFAULT;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < THUMB_MIN || value > THUMB_MAX) {
      throw new UnprocessableEntityException(
        `${name} must be an integer in [${THUMB_MIN}, ${THUMB_MAX}]`,
      );
    }
    return value;
  }

  /**
   * 按 sha256 定位缩略图源文件路径(返回可访问路径 + 来源实例信息)。
   *
   * 查找顺序:
   *   1. 存储层按 sha256 取命中 image entry(SQLite batchBySha256 /
   *      Mongo 'images.$' 位置投影 + lean);
   *   2. 精确匹配 entry 的 file,未匹配时回退首图 file;
   *   3. firstAccessiblePath 按 [resolved, 归一化, windows] 取真实存在的
   *      路径(WSL 时代路径在 Windows 侧需归一化,见 lib/paths.ts);
   *   4. 仍不可访问 → orchestration.findMemoryFileBySha256 内存视图兜底
   *      (未入库图片也可出缩略图)。
   * 返回:{ path: string|null, source?: {base_url} } —— path 供渲染,
   * source 供纯远程透传决策。
   */
  private async findResolvedPath(sha256: string): Promise<{
    path: string | null;
    source?: {
      base_url?: string;
      protocol?: string;
      asset_id?: string;
    };
  }> {
    // 双数据源定位批次文档;Mongo 用位置投影只取命中子文档 + lean 减开销
    let doc: Record<string, unknown> | null = null;
    if (this.readMode) {
      doc = batchBySha256(this.sqliteDb, sha256);
    } else {
      const mdoc = await this.imagesModel
        .findOne({ 'images.file.sha256': sha256 }, { 'images.$': 1, _id: 0 })
        .lean()
        .exec();
      doc = mdoc as unknown as Record<string, unknown> | null;
    }
    const entry = (
      doc as {
        images?: Array<{
          file?: {
            resolved_path?: string;
            windows_path?: string;
            sha256?: string;
          };
          source?: {
            base_url?: string;
            protocol?: string;
            asset_id?: string;
          };
        }>;
      }
    )?.images?.find((img) => img.file?.sha256 === sha256);
    const file =
      entry?.file ??
      (
        doc as {
          images?: Array<{
            file?: { resolved_path?: string; windows_path?: string };
          }>;
        }
      )?.images?.[0]?.file;
    // 跨平台:历史数据为 WSL 路径,Windows 侧按 [resolved, 归一化, windows] 取可访问路径
    // (firstAccessiblePath 内部已尝试平台归一化,见 lib/paths.ts)
    const accessible = firstAccessiblePath(
      file?.resolved_path,
      file?.windows_path,
    );
    if (accessible) {
      return { path: accessible, source: entry?.source };
    }
    // 内存视图兜底:未入库图片也可出缩略图(缓冲中图片尚未 flush,文件已就绪)
    const memory = await this.orchestration.findMemoryFileBySha256(sha256);
    return {
      path:
        firstAccessiblePath(memory?.resolved_path, memory?.windows_path) ??
        null,
      source: entry?.source,
    };
  }

  /**
   * 缩略图 worker(makeThumb)错误 → HTTP 异常映射(协议见
   * docs/contracts/parse_worker_protocol.md):
   *   - worker 不可用 → 503;请求超时 → 504;
   *   - RPC 错误码:-32001 源文件缺失 → 404;-32602 参数非法 → 422;
   *   - 其余 → 500。
   */
  private mapWorkerError(err: unknown): HttpException {
    if (err instanceof WorkerUnavailableError) {
      // worker 未就绪:503,前端可提示稍后重试
      return new ServiceUnavailableException(err.message);
    }
    if (err instanceof WorkerRequestTimeout) {
      // 渲染超时:504 网关超时
      return new HttpException(err.message, HttpStatus.GATEWAY_TIMEOUT);
    }
    if (err instanceof WorkerRpcError) {
      // 源文件缺失:与本地 existsSync 检查同语义 → 404
      if (err.code === -32001) {
        return new NotFoundException('Source file missing');
      }
      // 参数非法(尺寸越界等):422,与 parseSize 的校验状态一致
      if (err.code === -32602) {
        return new UnprocessableEntityException(err.message);
      }
      // 未知 RPC 错误:500
      return new HttpException(
        `Thumbnail generation failed: ${err.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return new HttpException(
      'Thumbnail generation failed',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /**
   * 统一缩略图响应头并下发 WebP 字节:
   * Content-Type image/webp、Cache-Control public max-age=86400(内容由
   * sha256 决定不可变,浏览器可放心缓存 1 天)、显式 Content-Length
   * (避免 chunked,便于浏览器/代理流式处理)。
   */
  private sendWebp(res: Response, data: Buffer): void {
    res
      .status(HttpStatus.OK)
      .set({
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': String(data.length),
      })
      .end(data);
  }
}
