/**
 * images 集合(批次文档)的 Mongoose schema 定义。
 *
 * 职责:承载 parser.py 产出的单图 record 经 ingest 层按 batch_key 聚合后的
 * 批次文档——每份文档共享同一采样参数指纹,含批次级字段
 * (model / loras / prompts / samplers / latent,取自批内代表 record)与
 * 批内每张图片的明细 images[]。
 *
 * 被谁使用:
 *   - 写入路径:ingest / archive 服务按此 schema 批量 upsert 落库
 *   - 读取路径:images / stats / generate / parse 等模块按此 schema 查询
 *   - 与 contracts/record.ts(zod) 对应:record 是单图契约(parser 产出),
 *     本 schema 是批次文档契约;批次级字段结构与 record 同名字段一致,
 *     images[] 元素对应 ImageEntrySchema(ingest 层组装,含 source 打标)。
 *
 * 数据流向:parser.py 产出 record(单图)→ ingest 按 batch_key 聚合 →
 *          images 集合写入 → 网关查询接口(搜索 / 详情 / 统计)读取。
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ImagesDocument = HydratedDocument<Images>;

/**
 * 与 parser.py resolve_input_value() 的透传语义严格对齐:
 *   - 字面量 number / string:直接 widget 值或 Primitive 节点按字段名取值
 *   - 未解析的节点引用对象 { node_id, class_type, inputs }:连线值,
 *     如 SimpleMath+ / Get Image Size 等无法静态求值的输入
 *   - null:值为空或缺失时的占位
 * 全部经 Schema.Types.Mixed 存储,避免 mongoose 做类型强转;
 * 注意:与 contracts/record.ts 的 LinkValueSchema 语义对应但定义有差异
 * (本处含 null、无 array;zod 侧含 array、无 null;record.schema.json 为三态),
 * 变更契约需按 AGENTS.md 门槛三端同步 + fixtures 回归。
 */
export type LinkValue = string | number | Record<string, unknown> | null;

/**
 * 单文件元信息(parser.py build_file_info() 产物,对应 record.file)。
 * 在批次文档中出现于两处:
 *   - 批次级语义对应的主文件(与顶层 record.file 对齐)
 *   - images[].file(批内每张图片)
 * stats_docs 集合的 file 字段也复用同名字段结构(见 stats-docs.schema.ts)。
 */
class FileInfo {
  // 文件基础名(不含目录);parser 必产
  @Prop({ required: true })
  filename!: string;

  // 图片名 = 文件名去扩展名(path.stem),供 image_name 索引查询
  @Prop()
  image_name!: string;

  // 文件扩展名(如 .png / .webp),展示与类型过滤用
  @Prop()
  extension!: string;

  // 相对 scan_root 的路径;scan_root 未配置时退化为纯文件名(parser 规则)
  @Prop()
  relative_path!: string;

  // 解析前的原始路径(扫描 / 同步时的输入路径)
  @Prop()
  source_path!: string;

  // 绝对解析路径(parser 必产);独立远端图片库条目可缺省
  @Prop()
  resolved_path?: string;

  // Windows 原生环境下的可访问路径(parser 对 /mnt/ 形式路径产出;读取侧 lib/paths.ts 用作候选路径)
  @Prop()
  windows_path?: string;

  // 文件大小(字节),统计与展示用
  @Prop()
  size_bytes!: number;

  // 修改时间(epoch 秒,UTC),与 captured_at 同源
  @Prop()
  mtime!: number;

  // 修改时间(epoch 纳秒,UTC);精确排序 / 去重的依据(建有索引)
  @Prop()
  mtime_ns!: number;

  // 路径级唯一键(resolved_path 的 SHA-256,非内容哈希);支撑 /api/thumb / /api/image 定位
  @Prop()
  sha256!: string;

  // 图像格式(PIL 读取,如 PNG / JPEG)
  @Prop()
  format?: string;

  // PIL mode(如 RGB / RGBA)
  @Prop()
  mode?: string;

  // 像素宽度
  @Prop()
  width?: number;

  // 像素高度
  @Prop()
  height?: number;
}

/**
 * 原始元数据快照(parser.py 从图片 EXIF / tEXt / parameters 提取,
 * 对应 record.metadata)。仅供"原样查看 / 排查解析问题",不参与检索字段构建。
 */
class MetadataInfo {
  // 原始元数据键名列表(便于前端渲染 key-value 清单)
  @Prop({ type: [String] })
  raw_keys?: string[];

  // ComfyUI 嵌入的 prompt JSON 字符串(未反序列化的原文)
  @Prop()
  raw_prompt?: string;

  // ComfyUI 嵌入的 workflow JSON 字符串(原文)
  @Prop()
  raw_workflow?: string;

  // A1111 风格 parameters 字符串(兼容 stable-diffusion 生态图片)
  @Prop()
  raw_parameters?: string;

  // NovelAI 图片 Comment 元数据原文(parse_worker 层 novelai 适配器注入,
  // 非 parser.py 产物;见 docs/parser/NOVELAI_SUPPORT.md)
  @Prop()
  raw_novelai?: string;

  // 其余原始元数据键值对(透传,不做结构化; malformed 值兼容保留)
  @Prop({ type: Object })
  extra?: Record<string, unknown> | string | null;

  // parse-worker sidecars: A1111 evidence, diagnostics, and future adapters.
  // Runtime validation is attached to the concrete ImagesSchema path below.
  @Prop({ type: Object })
  extra_diagnostics?: Record<string, Record<string, unknown>>;
}

/**
 * 工作流级统计(parser.py 从内嵌 prompt / workflow JSON 统计得出,
 * 对应 record.workflow)。
 */
class WorkflowInfo {
  // 是否内嵌 workflow(ComfyUI 保存图片时嵌入完整 workflow)
  @Prop()
  has_embedded_workflow?: boolean;

  // prompt 图中的节点数
  @Prop()
  prompt_node_count?: number;

  // workflow 图中的节点数(可能缺失,缺失时为 null)
  @Prop()
  workflow_node_count?: number;

  // 按 class_type 统计的节点数量分布(如 {"KSampler": 2, "CLIPTextEncode": 4})
  @Prop({ type: Object })
  node_type_counts?: Record<string, number>;
}

/**
 * 批内单张图片的明细条目(ingest / archive 层组装,非 parser 单图产物;
 * 字段与单图 record 顶部字段对齐,便于按批次文档一体查询批内各图)。
 */
class ImageEntry {
  // 捕获时间(UTC,源自文件 mtime)
  @Prop()
  captured_at?: Date;

  // 捕获日期字符串 %Y-%m-%d(UTC)
  @Prop()
  created_date?: string;

  // 捕获小时 0-23(UTC)
  @Prop()
  created_hour?: number;

  // 捕获星期 周一=0 ... 周日=6(UTC)
  @Prop()
  created_weekday?: number;

  // 该图文件元信息(见 FileInfo)
  @Prop({ type: FileInfo })
  file?: FileInfo;

  // 该图原始元数据快照
  @Prop({ type: MetadataInfo })
  metadata?: MetadataInfo;

  // 该图工作流统计
  @Prop({ type: WorkflowInfo })
  workflow?: WorkflowInfo;

  /**
   * 多网关共享库:来源实例打标(ingest 层写入,非 parser 产物)。
   * 透传(纯远程图片访问)按此定位持有该图片的网关。
   */
  @Prop({ type: Object })
  source?: {
    instance_id?: string;
    base_url?: string;
    protocol?: 'wfdb-gateway-v1' | 'wfdb-image-library-v1';
    asset_id?: string;
  };
}

/**
 * 采样器设置(parser.py collect_sampler_settings() 产物,对应
 * record.samplers[])。所有数值字段经 resolve_input_value() 解析,
 * 因此可能是字面量、节点引用对象或数组(批量种子)。
 */
class SamplerEntry {
  // 采样器节点 id(prompt 图中的 node id)
  @Prop()
  node_id?: string;

  // 采样器节点类型(如 KSampler / KSamplerAdvanced)
  @Prop()
  node_type?: string;

  // 随机种子;数组 = 批量种子节点 per-image seeds(2026-08-11 起支持)
  @Prop({ type: Object })
  seed?: LinkValue;

  // 采样步数
  @Prop({ type: Object })
  steps?: LinkValue;

  // CFG 引导强度
  @Prop({ type: Object })
  cfg?: LinkValue;

  // 采样器名称(如 euler / dpmpp_2m)
  @Prop({ type: Object })
  sampler_name?: LinkValue;

  // 调度器名称(如 normal / karras)
  @Prop({ type: Object })
  scheduler?: LinkValue;

  // 去噪强度(0-1,img2img / hires 修复链路使用)
  @Prop({ type: Object })
  denoise?: LinkValue;

  // seed 来源节点溯源:seed 经连线传入时追溯产出 {node_id, node_type};
  // 直接 widget 值(无连线)不产出该字段
  // (DATA-01:此前缺 Prop,mongoose strict 模式入库时剥掉 → Mongo 侧永久丢字段)
  @Prop({ type: Object })
  seed_source?: { node_id?: string; node_type?: string };

  // KSamplerAdvanced 的独立噪声种子(Video / Advanced 工作流,缺失时过滤)
  // (DATA-01:同上,补 Prop 与 zod 契约(record.ts)对齐)
  @Prop({ type: Object })
  noise_seed?: LinkValue;
}

/**
 * 单个 LoRA 使用记录(parser.py collect_lora_settings() 产物,对应
 * record.loras.items[])。strength 为合并强度字段(Power Lora Loader
 * 场景与 strength_model 同值);可为 null(上游缺值透传)。
 */
class LoraItem {
  // 加载该 LoRA 的 LoraLoader 节点 id
  @Prop()
  node_id?: string;

  // 加载该 LoRA 的节点类型(class_type,如 LoraLoader)
  @Prop()
  source?: string;

  // LoRA 名称(lora_name 输入解析值,通常含相对路径与扩展名)
  @Prop()
  name?: string;

  // 模型端强度
  @Prop({ type: Object })
  strength_model?: LinkValue;

  // CLIP 端强度
  @Prop({ type: Object })
  strength_clip?: LinkValue;

  // 加载槽位(多 LoRA 堆叠时的顺序,展示用)
  @Prop()
  slot?: number;

  // 合并强度(strength_clip == strength_model 时的单值表示;可为 null)
  @Prop({ type: Object })
  strength?: LinkValue;
}

/**
 * LoRA 汇总信息(对应 record.loras)。
 */
class LoraInfo {
  // LoRA 数量
  @Prop()
  count?: number;

  // 全部 LoRA 名称(去重,建有索引,按名检索)
  @Prop({ type: [String] })
  names?: string[];

  // LoRA 明细列表(每项含节点 / 强度,见 LoraItem)
  @Prop({ type: [LoraItem] })
  items?: LoraItem[];

  // 采样器模型来源节点 id(复用 sampler_model_source_id,展示用)
  @Prop()
  model_source_hint?: string;
}

/**
 * 单个模型相关节点(parser.py collect_model_settings() 产物,
 * 对应 record.model.nodes[])。任一字段有值即被纳入;值仅为字符串字面量(连线值不纳入)。
 */
class ModelNode {
  // 节点 id
  @Prop()
  node_id?: string;

  // 节点类型(如 CheckpointLoaderSimple / UNETLoader)
  @Prop()
  node_type?: string;

  // checkpoint 名称
  @Prop({ type: Object })
  ckpt_name?: LinkValue;

  // UNet 名称(FLUX 等新架构)
  @Prop({ type: Object })
  unet_name?: LinkValue;

  // 通用模型名称(部分加载器使用 model_name 字段)
  @Prop({ type: Object })
  model_name?: LinkValue;

  // VAE 名称
  @Prop({ type: Object })
  vae_name?: LinkValue;

  // CLIP 名称
  @Prop({ type: Object })
  clip_name?: LinkValue;
}

/**
 * 模型信息汇总(对应 record.model)。
 */
class ModelInfo {
  // 基准模型名(parser 规则:优先 ckpt_name → unet_name → model_name)
  @Prop({ type: Object })
  base_model?: LinkValue;

  // 产出 base_model 的节点 id(与 base_model 同节点)
  @Prop()
  checkpoint_node_id?: string;

  // 第一个 sampler 的 inputs.model 连线目标节点 id(采样模型来源追溯)
  @Prop()
  sampler_model_source_id?: string;

  // 所有模型相关节点明细(见 ModelNode)
  @Prop({ type: [ModelNode] })
  nodes?: ModelNode[];
}

/**
 * prompt 文本的分层片段(parser.py split_prompt_layers() 产物,
 * 按 \n\n 切分非空块)。
 */
class PromptLayer {
  // 层序号,从 0 起
  @Prop()
  layer_index?: number;

  // 该层整块文本(去首尾空白)
  @Prop()
  text?: string;

  // 按行切分后的行列表(去空白行)
  @Prop({ type: [String] })
  lines?: string[];

  // 用 "," 替换换行后切分的 token 列表(去空白,标签 / 关键词提取用)
  @Prop({ type: [String] })
  tokens?: string[];
}

/**
 * 单条 prompt 条目(parser.py collect_prompt_groups() 产物,
 * 对应 record.prompts.positive[] / negative[] 的元素)。
 */
class PromptEntry {
  // 完整 prompt 文本
  @Prop()
  text?: string;

  // 按空行切分后的分层结构(见 PromptLayer)
  @Prop({ type: [PromptLayer] })
  layers?: PromptLayer[];

  // 来源节点 id(追踪 prompt 来自哪个 CLIPTextEncode 等节点)
  @Prop()
  source_node_id?: string;

  // 来源节点类型
  @Prop()
  source_node_type?: string;

  // 分支标签(AttentionCouple / ConditioningCombine 等分支溯源;
  // 参与整体去重签名,不同分支下相同文本会保留多份)
  @Prop()
  branch_label?: string;
}

/**
 * 按采样器维度组织的 prompt 组(对应 record.prompts.by_sampler[],
 * 保留每 sampler 原始 positive / negative,不去重)。
 */
class SamplerPrompt {
  // 采样器节点 id
  @Prop()
  node_id?: string;

  // 采样器节点类型
  @Prop()
  node_type?: string;

  // 该采样器的正向 prompt 列表
  @Prop({ type: [PromptEntry] })
  positive?: PromptEntry[];

  // 该采样器的负向 prompt 列表
  @Prop({ type: [PromptEntry] })
  negative?: PromptEntry[];
}

/**
 * prompt 汇总信息(对应 record.prompts)。
 */
class PromptInfo {
  // 整体正向 prompt 列表((text, branch_label) 签名去重后)
  @Prop({ type: [PromptEntry] })
  positive?: PromptEntry[];

  // 整体负向 prompt 列表(同上,去重)
  @Prop({ type: [PromptEntry] })
  negative?: PromptEntry[];

  // 按采样器维度的原始 prompt 分组(不去重,见 SamplerPrompt)
  @Prop({ type: [SamplerPrompt] })
  by_sampler?: SamplerPrompt[];

  // 全文检索串:所有 positive + negative 的 text 以 \n\n 拼接
  // (parser.py build_prompt_search_text()),建有索引支持关键词搜索
  @Prop()
  search_text?: string;
}

/**
 * latent 的来源节点(parser.py collect_latent_settings() 产物,
 * 对应 record.latent.sources[])。
 */
class LatentSource {
  // 生成该 latent 的节点 id(如 EmptyLatentImage / VAEDecode 等)
  @Prop()
  node_id?: string;

  // 节点类型
  @Prop()
  node_type?: string;

  // 宽度(LinkValue:字面量或未解析节点引用)
  @Prop({ type: Object })
  width?: LinkValue;

  // 高度
  @Prop({ type: Object })
  height?: LinkValue;

  // 批量大小
  @Prop({ type: Object })
  batch_size?: LinkValue;
}

/**
 * latent 设置汇总(对应 record.latent)。
 */
class LatentInfo {
  // 主 latent 节点 id(通常为采样器直接连接者)
  @Prop()
  node_id?: string;

  // 主 latent 节点类型
  @Prop()
  node_type?: string;

  // 宽度(px)
  @Prop({ type: Object })
  width?: LinkValue;

  // 高度(px)
  @Prop({ type: Object })
  height?: LinkValue;

  // 批量大小(同批张数,复现噪声时参与计算)
  @Prop({ type: Object })
  batch_size?: LinkValue;

  // EmptyLatentImage 节点的显式宽度(与 width 可不同,如 upscale 链路)
  @Prop({ type: Object })
  empty_latent_width?: LinkValue;

  // EmptyLatentImage 节点的显式高度
  @Prop({ type: Object })
  empty_latent_height?: LinkValue;

  // latent 来源节点明细(可能多级,如 VAE Encode → EmptyLatentImage)
  @Prop({ type: [LatentSource] })
  sources?: LatentSource[];
}

/**
 * images 集合的批次文档(collection: 'images',不启用 mongoose timestamps,
 * 时间字段由 parser / ingest 显式写入)。
 *
 * 一份文档 = 一个 batch:同批图片共享同一采样参数指纹 batch_key;
 * 批次级字段(model / loras / prompts / samplers / latent)取自批内
 * 代表 record,批内各图明细放在 images[]。
 */
@Schema({ collection: 'images', timestamps: false })
export class Images {
  // 批次键:采样参数指纹生成的去重键(parser.py batch_group_key()),
  // 唯一索引,作为批量 upsert 的定位键
  @Prop()
  batch_key!: string;

  // 批次代表图的捕获时间(UTC)
  @Prop()
  captured_at?: Date;

  // 捕获日期 %Y-%m-%d(UTC)
  @Prop()
  created_date?: string;

  // 捕获小时 0-23(UTC)
  @Prop()
  created_hour?: number;

  // 捕获星期 周一=0 ... 周日=6(UTC)
  @Prop()
  created_weekday?: number;

  // 模型信息(见 ModelInfo)
  @Prop({ type: ModelInfo })
  model?: ModelInfo;

  // LoRA 信息(见 LoraInfo)
  @Prop({ type: LoraInfo })
  loras?: LoraInfo;

  // prompt 信息(见 PromptInfo)
  @Prop({ type: PromptInfo })
  prompts?: PromptInfo;

  // 采样器列表(见 SamplerEntry)
  @Prop({ type: [SamplerEntry] })
  samplers?: SamplerEntry[];

  // latent 信息(见 LatentInfo)
  @Prop({ type: LatentInfo })
  latent?: LatentInfo;

  // 配方键:批次聚合到"配方"(recipe)分组的键,不在 parser.py 产出范围,
  // 由 ingest 层(recipe_keys.py)补充,关联 recipe_groups 集合
  @Prop()
  recipe_key?: string;

  // 批内图片数量(ingest 层统计写入,列表展示用)
  @Prop()
  batch_count?: number;

  // 批内单图明细列表(见 ImageEntry)
  @Prop({ type: [ImageEntry] })
  images?: ImageEntry[];
}

// 由 class 装饰器元数据生成 mongoose schema(字段类型 / 嵌套结构)
export const ImagesSchema = SchemaFactory.createForClass(Images);

export function isValidMetadataSidecars(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.keys(value as Record<string, unknown>).every((key) => {
    const sidecar = (value as Record<string, unknown>)[key];
    return (
      sidecar !== null && typeof sidecar === 'object' && !Array.isArray(sidecar)
    );
  });
}

// Nested class metadata is represented as mixed subdocuments by the existing
// batch schema. Attach the validator to the real images array path so document
// validation enforces the same object-valued sidecar contract at runtime.
ImagesSchema.path('images').validate({
  validator: (images: unknown) =>
    !Array.isArray(images) ||
    images.every((image) => {
      if (image === null || typeof image !== 'object') return true;
      const entry = image as {
        file?: {
          filename?: unknown;
          sha256?: unknown;
          resolved_path?: unknown;
        };
        source?: {
          base_url?: unknown;
          protocol?: unknown;
          asset_id?: unknown;
        };
        metadata?: { extra_diagnostics?: unknown };
      };
      const diagnostics = entry.metadata?.extra_diagnostics;
      if (
        diagnostics !== undefined &&
        !isValidMetadataSidecars(diagnostics)
      ) {
        return false;
      }
      // 部分测试/投影文档可只含 metadata;只在 file 存在时校验定位契约。
      if (!entry.file) return true;
      if (
        typeof entry.file.resolved_path === 'string' &&
        entry.file.resolved_path.trim()
      ) {
        return true;
      }
      return (
        entry.source?.protocol === 'wfdb-image-library-v1' &&
        typeof entry.file.filename === 'string' &&
        Boolean(entry.file.filename.trim()) &&
        typeof entry.file.sha256 === 'string' &&
        Boolean(entry.file.sha256.trim()) &&
        typeof entry.source.base_url === 'string' &&
        /^https?:\/\//i.test(entry.source.base_url) &&
        typeof entry.source.asset_id === 'string' &&
        Boolean(entry.source.asset_id.trim())
      );
    }),
  message:
    'image entry must have a local resolved_path or a valid wfdb-image-library-v1 source; metadata sidecar values must be objects',
});

// batch_key 唯一索引:批次去重与批量 upsert 定位
ImagesSchema.index({ batch_key: 1 }, { name: 'uniq_batch_key', unique: true });
// 批内图片绝对路径索引:按路径反查所属批次 / 落库去重
ImagesSchema.index(
  { 'images.file.resolved_path': 1 },
  { name: 'images_file_resolved_path' },
);
// 批内图片源路径索引:按扫描源路径查询
ImagesSchema.index(
  { 'images.file.source_path': 1 },
  { name: 'images_file_source_path' },
);
// 批内图片 sha256 索引:内容级去重与完整性查询
ImagesSchema.index({ 'images.file.sha256': 1 }, { name: 'images_file_sha256' });
// 批内图片 mtime_ns 索引:按修改时间精确排序
ImagesSchema.index(
  { 'images.file.mtime_ns': 1 },
  { name: 'images_file_mtime_ns' },
);
// 批内图片 image_name 索引:按图名检索
ImagesSchema.index(
  { 'images.file.image_name': 1 },
  { name: 'images_image_name' },
);
// 捕获时间倒序:时间线浏览的主排序索引
ImagesSchema.index({ captured_at: -1 }, { name: 'captured_at_desc' });
// 配方 × 时间复合索引:recipe 聚合页的时间线查询
ImagesSchema.index(
  { recipe_key: 1, captured_at: -1 },
  { name: 'recipe_key_captured_at' },
);
// 捕获日期倒序:按日聚合统计
ImagesSchema.index({ created_date: -1 }, { name: 'created_date_desc' });
// base_model 索引:按模型筛选
ImagesSchema.index({ 'model.base_model': 1 }, { name: 'base_model' });
// LoRA 名称索引:按 LoRA 筛选
ImagesSchema.index({ 'loras.names': 1 }, { name: 'lora_names' });
// prompt 全文检索索引:按关键词搜索 prompt
ImagesSchema.index(
  { 'prompts.search_text': 1 },
  { name: 'prompt_search_text' },
);
