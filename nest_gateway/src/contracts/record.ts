/**
 * record 数据契约的 zod schema(单一事实来源)。
 *
 * 职责:定义 parser.py 产出的单图 record 的结构与约束,网关侧据此
 * 做运行时校验(validateRecord)与类型推导(Record 类型)。
 *
 * 对应关系:
 *   - 字段语义与 docs/contracts/record.schema.json、docs/parser/PARSER_SPEC.md
 *     §4.2 输出 record 结构严格一致
 *   - 每个 schema 均对应 parser.py 中一个收集器 / 构建函数
 *     (collect_sampler_settings / build_file_info / resolve_input_value 等)
 *   - 修改任何字段都必须同步:parser.py、PARSER_SPEC.md、
 *     record.schema.json、本文件、images.schema.ts(mongoose 侧)
 *
 * 数据流向:parser.py(worker 进程)产出 record → 网关校验(validateRecord)
 *          → ingest 批次组装 → images 集合落库。
 */
import { z } from 'zod';

/**
 * 文件元信息(对应 parser.py build_file_info() 产物,与 images.schema.ts
 * 的 FileInfo 类同构)。
 */
export const FileInfoSchema = z.object({
  // 文件基础名(parser 必产)
  filename: z.string(),
  // 图片名(可选,搜索用)
  image_name: z.string().optional(),
  // 扩展名
  extension: z.string().optional(),
  // 相对 scan_root 的路径(未配置时退化为文件名)
  relative_path: z.string().optional(),
  // 解析前原始路径
  source_path: z.string().optional(),
  // 绝对解析路径(parser 必产;唯一性 / 查询主键)
  resolved_path: z.string(),
  // Windows 侧路径(可为 null)
  windows_path: z.string().nullable().optional(),
  // 文件大小(字节)
  size_bytes: z.number().optional(),
  // 修改时间(epoch 秒)
  mtime: z.number().optional(),
  // 修改时间(epoch 纳秒,排序 / 去重)
  mtime_ns: z.number().optional(),
  // 路径 sha256(resolved_path 字符串的 SHA-256,路径级唯一键;见 PARSER_SPEC §10.1)
  sha256: z.string().optional(),
  // 图像格式(可为 null,如 PIL 无法识别时)
  format: z.string().nullable().optional(),
  // PIL mode(可为 null)
  mode: z.string().nullable().optional(),
  // 像素宽(可为 null)
  width: z.number().nullable().optional(),
  // 像素高(可为 null)
  height: z.number().nullable().optional(),
});

/**
 * 入库后 image entry 使用的文件摘要。远端图片库条目可以没有
 * 本地 resolved_path,但必须保留 filename + sha256 供列表展示与网关路由。
 * parser 顶层 record 仍使用 FileInfoSchema,因此冻结的 parser 产物语义不变。
 */
export const StoredImageFileInfoSchema = FileInfoSchema.extend({
  resolved_path: z.string().optional(),
});

export const ImageSourceSchema = z
  .object({
    instance_id: z.string().optional(),
    base_url: z.string().optional(),
    protocol: z
      .enum(['wfdb-gateway-v1', 'wfdb-image-library-v1'])
      .optional(),
    asset_id: z.string().optional(),
  })
  .nullable();

/**
 * 原始元数据快照(parser.py 从图片 EXIF / tEXt 提取,对应 record.metadata)。
 */
export const MetadataInfoSchema = z.object({
  // 原始元数据键名列表
  raw_keys: z.array(z.string()).optional(),
  // ComfyUI 嵌入的 prompt JSON 原文(可为 null)
  raw_prompt: z.string().nullable().optional(),
  // ComfyUI 嵌入的 workflow JSON 原文(可为 null)
  raw_workflow: z.string().nullable().optional(),
  // A1111 风格 parameters 原文(可为 null)
  raw_parameters: z.string().nullable().optional(),
  // NovelAI 图片 Comment 元数据原文(parse_worker 层 novelai 适配器注入,
  // 非 parser.py 产物;见 docs/parser/NOVELAI_SUPPORT.md)
  raw_novelai: z.string().nullable().optional(),
  // 其余原始键值对(透传; malformed 值兼容保留)
  extra: z
    .union([z.record(z.string(), z.unknown()), z.string(), z.null()])
    .optional(),
  // parse-worker sidecars: adapter evidence plus metadata diagnostics;
  // each sidecar value is a JSON object
  extra_diagnostics: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
});

/**
 * 工作流级统计(parser.py 从内嵌 prompt / workflow JSON 统计得出)。
 */
export const WorkflowInfoSchema = z.object({
  // 是否内嵌 workflow
  has_embedded_workflow: z.boolean().optional(),
  // prompt 图节点数
  prompt_node_count: z.number().optional(),
  // workflow 图节点数(可为 null)
  workflow_node_count: z.number().nullable().optional(),
  // 按 class_type 统计的节点分布
  node_type_counts: z.record(z.string(), z.number()).optional(),
});

/**
 * parser.py resolve_input_value() passthrough: a literal number/string when
 * the input is a scalar, a node-reference object
 * ({ node_id, class_type, inputs }) when the value is an unresolvable link
 * (e.g. SimpleMath+, Get Image Size), or an array when the input is a batch
 * seed list (批量种子节点,per-image seeds,2026-08-11).
 */
// 注意:与 images.schema.ts 的 LinkValue(mongoose 侧)语义对应,但两处定义
// 实际存在差异(本文件含 array 分支、无 null;mongoose 侧含 null、无 array;
// docs/contracts/record.schema.json 的 linkValue 为 number|string|object 三态)。
// 变更任一契约需按 AGENTS.md 门槛三端同步 + fixtures 回归。
export const LinkValueSchema = z.union([
  z.number(),
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.union([z.number(), z.string(), z.record(z.string(), z.unknown())])),
]);

/**
 * 采样器设置(对应 parser.py collect_sampler_settings() 产物,
 * record.samplers[] 的元素)。
 */
export const SamplerEntrySchema = z.object({
  // 采样器节点 id
  node_id: z.string().optional(),
  // 采样器节点类型
  node_type: z.string().optional(),
  // 随机种子(可为数组:批量种子节点 per-image seeds)
  seed: LinkValueSchema.optional(),
  // seed 来源节点 provenance:seed 经连线传入时追溯产出 {node_id, node_type};
  // 直接 widget 值(无连线)不产出该字段
  seed_source: z
    .object({
      node_id: z.string(),
      node_type: z.string(),
    })
    .optional(),
  // 采样步数
  steps: LinkValueSchema.optional(),
  // CFG 引导强度
  cfg: LinkValueSchema.optional(),
  // 采样器名称
  sampler_name: LinkValueSchema.optional(),
  // 调度器名称
  scheduler: LinkValueSchema.optional(),
  // 去噪强度
  denoise: LinkValueSchema.optional(),
  // KSamplerAdvanced 的独立噪声种子(Video / Advanced 工作流,缺失时过滤)
  noise_seed: LinkValueSchema.optional(),
});

/**
 * prompt 分层片段(对应 parser.py split_prompt_layers() 产物)。
 */
export const PromptLayerSchema = z.object({
  // 层序号(从 0 起)
  layer_index: z.number().optional(),
  // 该层整块文本
  text: z.string().optional(),
  // 按行切分(去空白行)
  lines: z.array(z.string()).optional(),
  // 按 "," 切分 token(去空白)
  tokens: z.array(z.string()).optional(),
});

/**
 * 单条 prompt 条目(parser.py collect_prompt_groups() 产物)。
 */
export const PromptEntrySchema = z.object({
  // 完整 prompt 文本
  text: z.string().optional(),
  // 分层结构
  layers: z.array(PromptLayerSchema).optional(),
  // 来源节点 id(可为 null)
  source_node_id: z.string().nullable().optional(),
  // 来源节点类型(可为 null)
  source_node_type: z.string().nullable().optional(),
  // 分支标签(可为 null;参与整体去重签名)
  branch_label: z.string().nullable().optional(),
});

/**
 * 单个 LoRA 使用记录(parser.py collect_lora_settings() 产物)。
 */
export const LoraItemSchema = z.object({
  // 加载节点 id
  node_id: z.string().optional(),
  // 产出该 LoRA 的节点类型(class_type)
  source: z.string().optional(),
  // LoRA 文件名(工作流 lora_name 解析值,含目录/扩展名)
  name: z.string().optional(),
  // 模型端强度
  strength_model: LinkValueSchema.optional(),
  // CLIP 端强度
  strength_clip: LinkValueSchema.optional(),
  // 加载槽位
  slot: z.number().optional(),
  // 合并强度(model/clip 同值时的单值表示;缺值可为 null)
  strength: LinkValueSchema.nullable().optional(),
});

/**
 * 单个模型相关节点(parser.py collect_model_settings() 产物,
 * record.model.nodes[] 的元素)。
 */
export const ModelNodeSchema = z.object({
  // 节点 id
  node_id: z.string().optional(),
  // 节点类型
  node_type: z.string().optional(),
  // checkpoint 名称
  ckpt_name: LinkValueSchema.optional(),
  // UNet 名称
  unet_name: LinkValueSchema.optional(),
  // 通用模型名称
  model_name: LinkValueSchema.optional(),
  // VAE 名称
  vae_name: LinkValueSchema.optional(),
  // CLIP 名称
  clip_name: LinkValueSchema.optional(),
});

/**
 * batch 文档的 image entry(ingest/archive 层组装,非 parser 单图产物)。
 * source 为多网关共享库打标(instance_id + base_url),透传定位图片持有网关。
 */
// 与 images.schema.ts 的 ImageEntry 类同构(该文件为 mongoose 侧存储)。
export const ImageEntrySchema = z
  .object({
    // 捕获时间(UTC;字符串 datetime 或 Date 均接受,统一时间格式容错)
    captured_at: z.string().datetime().or(z.date()).optional(),
    // 捕获日期 %Y-%m-%d(UTC)
    created_date: z.string().optional(),
    // 捕获小时 0-23(UTC)
    created_hour: z.number().optional(),
    // 捕获星期 周一=0(UTC)
    created_weekday: z.number().optional(),
    // 该图文件元信息;远端库条目允许缺本地 resolved_path
    file: StoredImageFileInfoSchema,
    // 该图原始元数据快照
    metadata: MetadataInfoSchema.optional(),
    // 该图工作流统计
    workflow: WorkflowInfoSchema.optional(),
    // 多网关共享库来源打标(可为 null / 缺失)
    source: ImageSourceSchema.optional(),
  })
  .superRefine((entry, ctx) => {
    const isRemoteLibrary =
      entry.source?.protocol === 'wfdb-image-library-v1';
    if (!entry.file.resolved_path && !isRemoteLibrary) {
      ctx.addIssue({
        code: 'custom',
        path: ['file', 'resolved_path'],
        message:
          'resolved_path is required unless source.protocol is wfdb-image-library-v1',
      });
    }
    if (isRemoteLibrary) {
      if (!entry.file.sha256?.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['file', 'sha256'],
          message: 'sha256 is required for a remote image library entry',
        });
      }
      if (!entry.source?.base_url?.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['source', 'base_url'],
          message: 'base_url is required for a remote image library entry',
        });
      } else {
        try {
          const url = new URL(entry.source.base_url);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error('unsupported protocol');
          }
        } catch {
          ctx.addIssue({
            code: 'custom',
            path: ['source', 'base_url'],
            message:
              'base_url must be an absolute http(s) URL for a remote image library entry',
          });
        }
      }
      if (!entry.source?.asset_id?.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['source', 'asset_id'],
          message: 'asset_id is required for a remote image library entry',
        });
      }
    }
  });

/**
 * 单图 record 契约(parser.py 产出,结构与 PARSER_SPEC.md §4.2 一致)。
 * WorkflowIR/WorkflowAST 仅为 Python 同次解析的内部语义图，不序列化进 record；
 * 因此本次 IR 接入不新增或放宽任何 DTO 字段。
 * 注意:recipe_key 由网关侧 lib/recipe_keys.ts、images 由 ingest 在入库
 * 阶段补充;image_refs / _image_refs_up_to_date 为预留字段,当前无写入方。
 */
export const RecordSchema = z.object({
  // 捕获时间(UTC,源自文件 mtime)
  captured_at: z.string().datetime().or(z.date()).optional(),
  // 批次键(batch_group_key(samplers, sha256_fallback=file.sha256, size=_batch_size_token(latent, file)))
  batch_key: z.string(),
  // 捕获日期 %Y-%m-%d(captured_at.strftime,UTC;parser 必产)
  created_date: z.string(),
  // 捕获小时 0-23(UTC;parser 必产)
  created_hour: z.number(),
  // 捕获星期 周一=0(UTC;parser 必产)
  created_weekday: z.number(),
  // 文件元信息(parser 必产)
  file: FileInfoSchema,
  // 原始元数据快照
  metadata: MetadataInfoSchema.optional(),
  // 工作流统计
  workflow: WorkflowInfoSchema.optional(),
  // 模型信息(collect_model_settings 产物):
  // base_model 优先 ckpt_name → unet_name → model_name;
  // checkpoint_node_id 与 base_model 同节点;
  // sampler_model_source_id = 第一个 sampler 的 inputs.model 链接目标节点 id
  model: z
    .object({
      base_model: LinkValueSchema.nullable().optional(),
      checkpoint_node_id: z.string().nullable().optional(),
      sampler_model_source_id: z.string().nullable().optional(),
      nodes: z.array(ModelNodeSchema).optional(),
    })
    .optional(),
  // LoRA 信息(collect_lora_settings 产物)
  loras: z
    .object({
      count: z.number().optional(),
      names: z.array(z.string()).optional(),
      items: z.array(LoraItemSchema).optional(),
      model_source_hint: z.string().nullable().optional(),
    })
    .optional(),
  // prompt 信息(collect_prompt_groups + build_prompt_search_text 产物):
  // positive / negative 按 (text, branch_label) 去重;
  // by_sampler 按采样器保留原始分组(仅组内去重,不做全局去重);
  // search_text 为全部文本的 \n\n 拼接(全文检索)
  prompts: z
    .object({
      positive: z.array(PromptEntrySchema).optional(),
      negative: z.array(PromptEntrySchema).optional(),
      by_sampler: z
        .array(
          z.object({
            node_id: z.string().optional(),
            node_type: z.string().optional(),
            positive: z.array(PromptEntrySchema).optional(),
            negative: z.array(PromptEntrySchema).optional(),
          }),
        )
        .optional(),
      search_text: z.string().optional(),
    })
    .optional(),
  // 采样器列表(collect_sampler_settings 产物)
  samplers: z.array(SamplerEntrySchema).optional(),
  // latent 信息(collect_latent_settings 产物)
  latent: z
    .object({
      node_id: z.string().optional(),
      node_type: z.string().optional(),
      width: LinkValueSchema.optional(),
      height: LinkValueSchema.optional(),
      batch_size: LinkValueSchema.optional(),
      empty_latent_width: LinkValueSchema.optional(),
      empty_latent_height: LinkValueSchema.optional(),
      sources: z
        .array(
          z.object({
            node_id: z.string().optional(),
            node_type: z.string().optional(),
            width: LinkValueSchema.optional(),
            height: LinkValueSchema.optional(),
            batch_size: LinkValueSchema.optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  // 配方键(ingest 层经 lib/recipe_keys.ts buildRecipeKey 补充,非 parser 产物)
  recipe_key: z.string().optional(),
  // 图片引用路径列表(预留字段,当前无写入方)
  image_refs: z.array(z.string()).optional(),
  // 内部标记:image_refs 是否已与磁盘对齐(预留,当前无维护方)
  _image_refs_up_to_date: z.boolean().optional(),
  // 批内图片明细(ingest 层组装,元素见 ImageEntrySchema)
  images: z.array(ImageEntrySchema).optional(),
});

// 由 RecordSchema 推导出的 TS 类型(业务代码可直接引用 Record)
export type Record = z.infer<typeof RecordSchema>;

/**
 * 运行时校验(写入路径守卫):对 parser/worker 产出的 record 做 zod 校验。
 * 校验失败仅告警并返回 false——不抛错、不阻断写入(防止误丢合法但非常规的
 * 记录),但保留问题明细供排障。
 */
export function validateRecord(record: unknown): {
  ok: boolean;
  issues: string[];
} {
  // safeParse:校验失败不抛异常,统一走 issues 分支
  const result = RecordSchema.safeParse(record);
  if (result.success) {
    return { ok: true, issues: [] };
  }
  // 把 zod 的 issue 列表压平为 "字段路径: 错误消息" 的可读文本,
  // 路径为空时用 (root) 表示根级错误
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}
