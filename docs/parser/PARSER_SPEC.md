# parser.py 实现规范

> 本文档对 `workflow_db/parser.py`（共 734 行）的现有行为进行**描述**，作为系统基石层
> 的唯一参考。任何对该文件的修改都应当先对照本文档，确认行为契约不被破坏。
>
> parser.py 在本项目中被视为**只读基石**，本规范基于其当前实现反向还原，不引入新行为。
>
> 配套数据契约：[`docs/contracts/record.schema.json`](../contracts/record.schema.json)
>
> 关联系统上下文:系统架构与 Worker 协议见 [`../contracts/parse_worker_protocol.md`](../contracts/parse_worker_protocol.md)

## 1. 在系统中的位置

parser.py 是图片元数据 → 数据库记录的唯一转换层。当前架构下由
`workflow_db/parse_worker`(经 NestJS 网关 `nest_gateway/src/workers/parse-worker.ts`
spawn 的长驻进程)调用;产出 record 经网关 `lib/ingest.ts` / `lib/archive.ts`
入库(SQLite 默认 / MongoDB 可选)。

```text
图像文件 (PNG/WebP/JPEG)
        │
        │  iter_image_files(root)         扫描文件系统，返回排序后的 Path 列表
        ▼
parse_image(path, scan_root)            本模块入口，单图 → record dict
        │
        ├─ extract_image_metadata()       PIL 读取 + 元数据规范化
        ├─ WorkflowGraph(...)             封装 prompt / workflow 两套图
        ├─ collect_sampler_settings()     提取 KSampler 家族
        ├─ collect_prompt_groups()        正负 Prompt / by_sampler
        ├─ collect_latent_settings()      分辨率 / batch_size
        ├─ collect_model_settings()       基座模型 / checkpoint 节点
        ├─ collect_lora_settings()        LoraLoader / Stacker / Power Lora
        └─ build_file_info()              文件元信息与 sha256
        ▼
record dict  ──►  parse_worker(JSON-RPC)  ──►  NestJS 网关 lib/ingest.ts  ──►  SQLite(默认)/ MongoDB
```

### 1.1 parse_worker 适配边界（核心冻结）

`parser.py` 只负责从图片中读取并解释已有的通用 PNG/WebP 元数据。网关的
`workflow_db.parse_worker.methods.parse_image` 在其输出之后，按以下顺序执行**本地、
无网络**后处理：

```text
parser.parse_image
  → novelai.apply          NovelAI Comment JSON
  → a1111.apply            A1111 parameters/comment infotext
  → comfyui_recovery.apply 已嵌入 raw_prompt 图中的本地文本恢复
  → metadata_diagnostics.apply
```

适配器边界约束：

- 适配器只消费 `parser.py` 已放入 `record.metadata` 的值，或同一次解析中已嵌入的
  本地工作流图；不读取站点索引、`ai_json`、标签或其他远程 oracle，也不发起 HTTP 请求。
- 适配器只在目标字段为空或可安全补充时恢复 prompt/参数；已有 parser 结果优先保留。
  每个恢复的 prompt payload 保留 `source_node_type`/`branch_label` 等来源信息，报告工具
  可将 full worker 输出与 parser 基线区分。
- A1111 与 ComfyUI 恢复是离线开发和运行时 worker 的同一代码路径；它们不改变
  `parser.py` 的核心函数、record 顶层字段语义或 schema。
- ComfyUI 恢复从 sampler 的 `positive` / `negative` 输入开始携带极性追溯。遇到
  Bus 类节点时，仅沿同名输入端口继续；存在 UI workflow 时会以实际输出端口名核验，
  不把任何输出序号定义为全局正/负语义。无命名匹配的 Bus 分支保持未解析。
- 保留 `CLIPTextEncode` 输入契约的自定义节点（class type 包含
  `CLIPTextEncode` 且有字面量 `text`）可被恢复，例如 `smZ CLIPTextEncode`。
- **连线字面量清洗**：`CLIPTextEncode` / `Text Multiline` 等节点的 `text`
  为连线值时，parser 基线会产出 `str(["41", 0])` 形态的污染条目；
  `comfyui_recovery.apply` 先剔除该类条目（含 `by_sampler`），再对因此变空的
  分支执行恢复，并重建 `search_text`。正常 prompt 文本（含 `[artist:1.2]`
  等权重写法）不会被误删。
- **text 连线追踪**：`text` 为连线时沿 text 端口向上游追溯。上游为未知节点时，
  按「sampler 分支名 → 通用文本字段（`text` / `prompt` / `positive_prompt` /
  `negative_prompt` / `string` / `String` / `value`）→ 组织器 `widget_data` 分类值」提取
  字面量；拼接变体 `CR Combine Prompt`、`ZML_MultiTextInput3/5`、
  `JoinStringMulti`（`string_N` 动态字段）按各自字段表递归解析；
  未知节点的 `conditioning` 连线视为透传继续追溯，
  `ConditioningZeroOut` 等清空型节点视为空条件终止。
- **恢复起点扩展**：`CFGGuider` 等名字含 `guider` 且持 positive/negative 输入的
  节点同样作为恢复起点；`SamplerCustomAdvanced` 等含 `guider` 输入的节点沿
  guider 连线追溯，适配 `SamplerCustomAdvanced → CFGGuider → CLIPTextEncode`
  链路。
- A1111 退化 infotext（`Negative prompt:` 后直接换行接参数行）中，负向匹配
  不再吞掉换行导致整段参数被误判为 negative prompt。
- A1111 适配器从正向 prompt 的标准 `<lora:name:weight>` 标签补充空的 `record.loras`：
  保留 prompt 原文，按 `(name, weight)` 顺序去重，并将 weight 同步写入 `strength`、
  `strength_model` 与 `strength_clip`。负向 prompt 标签、畸形标签及已有 LoRA 结果不参与覆盖。
- `metadata.extra.parse_diagnostics`（畸形 `extra` 时为 `metadata.extra_diagnostics`）仅记录
  metadata 的可用性、缺失字段和结构问题。诊断不是参数来源，不覆盖业务字段。

### 1.2 缺失 metadata 的语义

缺失、空或损坏的 metadata 不得通过文件名、模型名、图片内容、站点数据或经验规则猜测
prompt、seed、sampler、尺寸或模型。无法从本地元数据安全恢复的字段保持缺失；诊断可记录
`metadata_absent`、`metadata_partial`、`metadata_invalid` 等状态及结构化 issue code。
`chunk_offsets` 只在实际扫描到 chunk 时记录，未扫描时保持空对象，不虚构偏移。

`parse_worker.methods.parse_image` 的返回值仍为 `{"record": record, "warnings": []}`；上层
若需验证适配器效果，应同时比较冻结 parser 输出与 full worker 的 `record.prompts`，不能把
外部索引内容当作运行时真值。

调用方(当前架构为 NestJS 网关,直接 import parser.py 的路径):

- `workflow_db/parse_worker/methods.py` — 经 JSON-RPC 调 `parse_image`(网关 `nest_gateway/src/workers/parse-worker.ts` spawn)
- `nest_gateway/src/lib/ingest.ts` — 网关入库层消费 record(经 parse_worker 返回)

其他 `parser` 关键字均来自 `argparse` 自身的 `parser` 变量名，与本模块无关。

## 2. 顶层常量

| 常量 | 值 | 作用 |
|---|---|---|
| `SUPPORTED_EXTENSIONS` | `{".png", ".webp", ".jpg", ".jpeg"}` | `iter_image_files` 仅采集这些后缀 |
| `PRIMITIVE_NODE_TYPES` | `{"PrimitiveInt", "PrimitiveFloat", "PrimitiveString", "Seed (rgthree)"}` | 在 `resolve_input_value` 中按字段名取值 |
| `TEXT_NODE_TYPES` | `{"CLIPTextEncode", "Text Multiline", "Text Concatenate", "Text to Conditioning", "CR Text", "Text Prompt (JPS)", "Text Concatenate (JPS)", "CR Text Concatenate"}` | 用于 Prompt 回退判定;JPS/CR 变体见 [`KNOWN_GAPS.md`](KNOWN_GAPS.md) §2 |
| `SAMPLER_HINTS` | `("ksampler", "sampler")` | 大小写不敏感匹配,挑选 sampler 节点;**排除** `Sampler Selector` 与 `KSamplerSelect`(名称选择器,详见 KNOWN_GAPS §1.3) |
| `LATENT_HINTS` | `("latent",)` | 当前未直接使用，预留 |
| `LORA_STRENGTH_STEP` | `0.05` | LoRA 强度对齐步长 |
| `LORA_STRENGTH_EPSILON` | `1e-9` | 对齐容差 |

`normalize_lora_strength(value)`：把 0.05 步进的浮点数吸附到网格，否则原样返回。
仅 `int/float`（非 `bool`）类型才参与吸附，结果保留 10 位小数。

## 3. 核心数据结构

### 3.1 `WorkflowGraph`

`WorkflowGraph` 是 [`WORKFLOW_IR.md`](WORKFLOW_IR.md) 定义的
`WorkflowIR` 兼容门面，封装两种节点图，同时建立不落库的节点/连线语义索引：

- `prompt: dict[str, Any]` — ComfyUI 嵌入的 API prompt 图，键为节点 id（字符串）
- `workflow: dict[str, Any] | None` — ComfyUI UI workflow（含 `nodes[]`、`links[]`），
  用于判定节点 bypass 状态，可空

提供的查询方法：

| 方法 | 行为 |
|---|---|
| `node(node_id)` | 按 `str(node_id)` 在 `prompt` 中取节点；`None` 入参返回 `None` |
| `node_inputs(node_id)` | 返回节点的 `inputs` 字典，节点缺失返回 `{}` |
| `node_type(node_id)` | 返回 `class_type` 字符串，节点缺失返回 `""` |
| `workflow_node(node_id)` | 在预建 UI 节点索引中按 `id` 查找节点 |
| `node_is_bypassed(node_id)` | 判定 bypass：`flags.bypassed` / `flags.disabled` / `mode ∈ {2,4}` |
| `normalize_link(value)` | 模块级函数：将 `[node_id, output_index]` 规范化为 `(str, int)` |

兼容查询之外，实例暴露 `nodes/raw_edges/semantic_edges`。连线的 source slot、target
field、declared type、polarity、branch 与 provenance 是一等语义；节点同时带
`NodeDefinitionView/NodeBehavior`，边带 `source_operation/path_effect`。未知定义显示
`missing`，未知行为必须是 `opaque`，只有静态
证明的直接输出派生才是 `identity`。collector 沿链接求值时不得删除这些节点或边。
IR 只用于同次解析和按需派生，**不增加 record 字段**。

> **重要约定**：API prompt 的节点 id 一律按 `str(...)` 处理；workflow UI 节点 id 同样
> 通过 `str(node.get("id"))` 比较，原始类型（int/str）不影响匹配。

### 3.2 ComfyUI 链接结构

prompt 图中节点输入值有两种形态：

1. **字面量**：直接放在字段中（字符串/数字）
2. **节点链接**：形如 `["<node_id>", <output_index>]`

`normalize_link(value)` 仅在 `value` 是长度 ≥ 2、node id 为 str/int（非 bool）、output
slot 可转 int（非 bool）的 list/tuple 时返回 `(str(value[0]), int(value[1]))`，否则返回
`None`。这一收窄仅规范 malformed 输入；有效 fixture 行为不变。

## 4. 入口函数 `parse_image`

签名：

```python
def parse_image(path: Path, scan_root: Path | None = None) -> dict[str, Any]
```

### 4.1 处理流程

1. `extract_image_metadata(path)` 取出 `metadata` dict 与 `image_info` dict
   - 通过 `PIL.Image.open` 读取，把 `image.info` 拷贝为普通 dict
   - `image_info` 仅保留 `format / mode / width / height`
   - 打开失败抛 `ValueError(f"Unable to open image {path}: {exc}")`
   - 兼容 A1111：当不存在 `parameters` 但存在 `comment` 时，把 `comment` 复制到 `parameters`
2. `parse_json_field` 把 `metadata["prompt"]` 与 `metadata["workflow"]` 尝试 JSON 反序列化
3. 构造 `WorkflowGraph(prompt_graph or {}, workflow_data or None)`
4. 顺序执行收集器：

   ```text
   collect_sampler_settings(graph)         → samplers
   collect_prompt_groups(graph, samplers)  → prompt_summary
   collect_latent_settings(graph, samplers)→ latent
   collect_model_settings(graph, samplers) → model
   collect_lora_settings(graph, model)     → loras
   ```

5. 计算 `captured_at`：`datetime.fromtimestamp(st_mtime, tz=timezone.utc)`
   - 注意是 **UTC**，不是本地时区
6. 计算 `relative_path`：
   - 当 `scan_root` 非空且 `path.is_relative_to(scan_root)` 时，取相对路径
   - 否则退化为 `path.name`
7. `resolved_path = path.resolve(strict=False)`（不要求目标存在）

### 4.2 输出 record 结构

输出字段与 `docs/contracts/record.schema.json` 严格对应：

| 字段 | 来源 / 规则 |
|---|---|
| `captured_at` | 文件 mtime（UTC, tz-aware） |
| `batch_key` | `batch_group_key(samplers, sha256_fallback=file.sha256, size=_batch_size_token(latent, file))` |
| `created_date` | `captured_at.strftime("%Y-%m-%d")` |
| `created_hour` | `captured_at.hour`（0-23） |
| `created_weekday` | `captured_at.weekday()`（周一=0，周日=6） |
| `file` | `build_file_info(...)` 结果（详见 §10） |
| `metadata` | 原始元数据快照（详见 §11） |
| `workflow` | 工作流级统计（详见 §12） |
| `model` | 见 §7 |
| `loras` | 见 §8 |
| `prompts` | 见 §6 |
| `samplers` | 见 §5 |
| `latent` | 见 §9 |

> **注意 `created_*` 字段**：所有时间维度均基于 UTC mtime，非本地时区。统计热力图
> 直接使用这些字段，若需本地时区展示应由消费方自行转换。

## 5. Sampler 收集 — `collect_sampler_settings`

- 遍历 `graph.prompt`，**仅**当 `class_type` 小写形式包含 `SAMPLER_HINTS`
  任一子串（`"ksampler"` 或 `"sampler"`）时纳入
- **排除名称选择器**：`Sampler Selector` 与 `KSamplerSelect`（二者仅作采样器
  名称下拉、无 `seed/steps`，不是真实 sampler），否则会被 hint 误收
- 每个 sampler 提取字段，所有字段都通过 `resolve_input_value` 解析：
  `seed / steps / cfg / sampler_name / scheduler / denoise / noise_seed`
- `noise_seed`（KSamplerAdvanced 的独立噪声种子，Video/Advanced 工作流）仅在输入存在时产出，
  缺失时被过滤，不影响既有 record 语义
- `seed_source`：当 `seed` 输入通过连线传入时，追溯其来源节点产出
  `{node_id, node_type}`（provenance，供展示溯源与重放时定位可变 seed 目标）；
  直接 widget 值（无连线）不产出该字段
- 末尾过滤：值为 `None / "" / {}` 的键被剔除
- 返回 list，顺序与 prompt 图 dict 迭代顺序一致（即 JSON 解析后的插入顺序）

> 未提取但 ComfyUI 中常见的 `latent_image` / `model` 字段不在 sampler dict 中；
> 它们分别在 §9 latent、§7 model 中被消费。
>
> **Seed 语义（与展示/重放对齐）**：标准 KSampler 单个 seed 生成整批噪声
> （`prepare_noise(latent, seed)` 一次 `randn(batch, ...)`），同批次图片共享该 seed，
> 不存在独立 per-image seed；复现依据 = `seed + noise_seed + latent.batch_size/尺寸 +
> 采样参数链`。seed 为列表（批量种子节点）时，`sampler.seed` 保留列表原样。

## 6. Prompt 收集 — `collect_prompt_groups`

### 6.1 总体策略

```text
for sampler in samplers:
    从 sampler.inputs.positive 取 prompt
    从 sampler.inputs.negative 取 prompt
    positive 缺失时回退到 sampler.inputs.model 链路（仅 positive）
按 (text, branch_label) 去重 → 写入整体 positive/negative
若整体 positive 仍为空 → collect_prompt_fallback
若整体 negative 仍为空 → collect_negative_prompt_fallback
```

- **每 sampler 维度**保留各自的 `positive / negative` 列表（不去重）
- **整体维度**用 `(text, branch_label)` 签名集合去重
- positive 兜底走 `collect_prompt_fallback`（遍历 `Text Multiline / Text Concatenate /
  Text to Conditioning` 节点）
- negative 兜底走 `collect_negative_prompt_fallback`：扫描所有 `CLIPTextEncode`，
  文本小写形式包含 `worst quality / bad anatomy / watermark / lowres / blurry` 任一关键词
  即视为负面 prompt

### 6.2 链路解析 — `collect_prompt_entries_from_link`

按节点 `class_type` 分支处理，**递归**遍历，受 `visited` 集合保护防环：

| class_type | 行为 |
|---|---|
| `CLIPTextEncode` | 取 `inputs.text`，非空则产出 1 个 entry |
| `Text to Conditioning` | 递归 `inputs.text` |
| `ConditioningCombine` | 分别递归 `conditioning_1` 与 `conditioning_2`，分支标签分别追加 `:1` / `:2` |
| `AttentionCouple` | 递归 `base_prompt` + `regions` |
| `AttentionCoupleRegions` | 按 key 排序，遍历所有 `region_*` 字段 |
| `AttentionCoupleRegion` | 递归 `cond`，分支标签为 `region` |
| `ConditioningSetMask` | 递归 `conditioning`（mask 区域设置，透传文本链） |
| `ConditioningSetArea` / `ConditioningSetAreaPercentage` / `ConditioningSetAreaStrength` | 递归 `conditioning`，分支标签为 class_type（官方区域节点，KNOWN_GAPS §2.3） |
| `RegionalConditioningSimple //Inspire` | 递归 `conditioning`（Inspire Pack 区域节点，字段 `mask/conditioning/strength`） |
| `RegionalPromptSimple //Inspire` | 取 `inputs.prompt` 直接文本（Inspire Pack，字段 `mask/prompt/strength`） |
| `Text Multiline` | 取 `inputs.text` |
| `Text Concatenate` | 调 `resolve_input_value([node_id, 0])`，再 `flatten_text_chunks`，用 `\n\n` 连接 |
| 其他，类名小写含 `controlnet` 或 `conditioning` | 遍历 `positive/negative/conditioning/cond/base_prompt/regions` 中存在的字段递归 |
| 其他 | 返回空 list |

> **branch_label 语义**：用于追踪 prompt 在工作流中的来源分支，参与整体去重签名。
> 不同分支下相同文本会保留多份。

### 6.3 `collect_prompt_entries_from_value`

- 若 value 是节点链接 → 转 `collect_prompt_entries_from_link`
- 若是字符串且非空 → 直接作为一个 entry
- 否则 → `resolve_input_value` → `flatten_text_chunks` 拼接

### 6.4 Prompt payload 结构

```python
{
    "text": str,
    "layers": split_prompt_layers(text),  # 见下
    "source_node_id": str | None,
    "source_node_type": str | None,
    "branch_label": str | None,
}
```

`split_prompt_layers(text)` 按 `\n\n` 切分非空块，每块产出：

```python
{
    "layer_index": int,      # 从 0 起
    "text": str,             # 去首尾空白后的整块
    "lines": list[str],      # 按行切，去空白行
    "tokens": list[str],     # 用 "," 替换换行后切 token，去空白
}
```

### 6.5 search_text

`build_prompt_search_text(positive, negative)`：把所有 positive + negative 的
`text` 字段用 `\n\n` 拼成单一字符串，供全文检索使用。

## 7. Model 收集 — `collect_model_settings`

遍历 prompt 图所有节点，对每个节点尝试提取
`ckpt_name / unet_name / model_name / vae_name / clip_name`，全部经
`resolve_input_value` 解析。

- 任一字段有值即把节点纳入 `nodes[]`
- `base_model`：首个同时含有 `ckpt_name / unet_name / model_name` 之一输入的节点，
  优先取 `ckpt_name`，再取 `unet_name`，再取 `model_name`
- `checkpoint_node_id`：与 base_model 同一节点
- `sampler_model_source_id`：第一个 sampler 的 `inputs.model` 链接目标节点 id

返回结构：

```python
{
    "base_model": Any | None,
    "checkpoint_node_id": str | None,
    "sampler_model_source_id": str | None,
    "nodes": [
        {"node_id": ..., "node_type": ..., "<field>": <value>, ...},
        ...
    ],
}
```

## 8. LoRA 收集 — `collect_lora_settings`

### 8.1 处理顺序与来源

1. **跳过 bypass 节点**：`graph.node_is_bypassed(node_id)` 为 True 直接跳过
2. 按节点 `class_type` 分支：

   - `LoraLoader`：取 `lora_name`，值为 `"None"` 视为未挂载；产出
     `strength_model / strength_clip`（均为解析后的值）
   - `CreateHookLora`：ComfyUI hook 机制 LoRA loader,字段与 `LoraLoader` 完全一致
     (`lora_name / strength_model / strength_clip`),同语义处理(详见 KNOWN_GAPS §1.1)
   - `LoRA Stacker`：按 `lora_count`（默认 0）循环 `1..max(lora_count,1)`，
     取 `lora_name_<i>`、`lora_wt_<i>`、`model_str_<i>`、`clip_str_<i>`，
     名称为空或 `"None"` 跳过
   - `Power Lora Loader (rgthree)` / `Power Lora Loader`：从 **workflow** 节点的
     `widgets_values[]` 中读取，每个 widget 是 dict，取 `lora` 字段；

     - `on` 字段为假值（`False / 0 / "0" / "false" / "False"`）跳过
     - `strength` / `strengthTwo` 经 `normalize_lora_strength` 吸附

> **重要差异**：Power Lora Loader 的数据来源是 **workflow UI 节点**的
> `widgets_values`，而非 prompt API 图。这意味着只有同时存在 workflow 嵌入时
> 该类节点才会被解析。

### 8.2 去重与输出

按 `(source, name, strength, strength_model, strength_clip)` 五元组去重，保留首次出现。

```python
{
    "count": int,
    "names": list[str],
    "items": [...],
    "model_source_hint": model.get("sampler_model_source_id"),
}
```

## 9. Latent 收集 — `collect_latent_settings`

对每个 sampler 节点取 `latent_image` 链接目标节点，提取该节点的
`width / height / batch_size / empty_latent_width / empty_latent_height`，
过滤掉空值后加入 `candidates[]`。

- 若有候选：以第一个 candidate 为基础，复制后追加 `sources` 字段（包含所有候选）
- 当 `width` 缺失但 `empty_latent_width` 存在时，回退使用 `empty_latent_width`
- `height` 同理
- 无候选返回 `{}`

## 10. 文件信息 — `build_file_info`

```python
{
    "filename": path.name,
    "image_name": path.stem,
    "extension": path.suffix.lower(),
    "relative_path": <相对 scan_root 或文件名>,
    "source_path": str(path),
    "resolved_path": str(resolved_path),
    "windows_path": <见下> or None,
    "size_bytes": file_stats.st_size,
    "mtime": file_stats.st_mtime,
    "mtime_ns": file_stats.st_mtime_ns,
    "sha256": <见下>,
    "format": image_info.format,
    "mode": image_info.mode,
    "width": image_info.width,
    "height": image_info.height,
}
```

### 10.1 `sha256` 的真实含义

**重要**：`sha256` 不是文件内容的哈希，而是 `resolved_path` 字符串的 SHA-256：

```python
sha256 = hashlib.sha256(str(resolved_path).encode("utf-8")).hexdigest()
```

这意味着：

- 同一路径多次解析得到相同 `sha256`，可作为路径级唯一键
- 文件内容变更（同名覆盖）不会改变 `sha256`
- 不能用作内容去重或防篡改校验

缩略图 API `/api/thumb/{sha256}` 与原图 API `/api/image/{sha256}` 均依赖此键，
因此它们本质上是"按路径定位文件"。

### 10.2 `windows_path` 转换

仅当 `resolved_path.parts` 形如 `("/", "mnt", "<drive>", ...)` 时转换：

- 取 `parts[2]` 大写化 + `:` 作为盘符
- 剩余部分用 `PureWindowsPath` 拼接
- 例：`/mnt/d/erxx/a.png` → `D:\erxx\a.png`
- 其他路径返回 `None`

## 11. metadata 字段

```python
{
    "raw_keys": sorted(metadata.keys()),
    "raw_prompt": metadata.get("prompt"),       # 原始字符串/对象，未 JSON 解析
    "raw_workflow": metadata.get("workflow"),
    "raw_parameters": metadata.get("parameters"),
    "extra": {k: v for k in metadata if k not in {"prompt", "workflow", "parameters"}},
}
```

- `raw_*` 保留原始未解析形态，便于审计
- `extra` 收纳所有其他 PNG/WebP chunk（如 `workflow` 之外的 EXIF、`Comment` 等）
- `raw_novelai`：NovelAI 图片的 `Comment` 元数据原文，由 parse_worker 层适配器
  （`workflow_db/novelai.py`，见 `docs/parser/NOVELAI_SUPPORT.md`）注入，
  非 parser.py 产物；parser.py 不产出、不消费该字段

## 12. workflow 字段

```python
{
    "has_embedded_workflow": bool(graph.prompt) or bool(workflow_data),
    "prompt_node_count": len(graph.prompt),
    "workflow_node_count": len(workflow_data["nodes"]) if workflow else None,
    "node_type_counts": Counter(node.class_type for node in prompt),
}
```

- `has_embedded_workflow` 只要 prompt 或 workflow 任一非空即为 True
- `node_type_counts` 仅统计 prompt API 图，不统计 workflow UI 节点
- `workflow_node_count` 在 workflow 缺失时为 `None`，不是 0

## 13. 批次键 — `batch_group_key`

```python
def batch_group_key(samplers, sha256_fallback="", size=None) -> str
```

按优先级生成：

1. 收集所有 sampler 的 `seed`：
   - `int/float`（非 bool）→ `str(int(seed))`
   - `str` → 尝试 `int(float(seed))`，失败则 `f"s:{seed}"`
   - `list`（批量种子节点）→ 逐元素按上述规则展平参与分组（2026-08-11 扩展）
2. 有 seed 且 `size` 可用 → `"seed:" + "|".join(seeds) + f"@{w}x{h}"`
3. 有 seed 无 `size` → `"seed:" + "|".join(seeds)`
4. 无 seed 但有 sha256 → `"file:" + sha256`
5. 兜底 → `"batch:unknown"`

`size` 来源（`_batch_size_token(latent, file_info)`）：

- `latent.width/height` 均为正整数 → 用之（生成画布尺寸，2026-08-12 扩展）
- 否则回退 `file.width/height`（PIL 实测像素，恒可用）
- 均不可用 → `None`（不加尺寸后缀，维持原键）

> **批次语义**：相同 seed 序列 + 相同 latent 尺寸的图片被视为同一次生成批次
> （同一 prompt 多张出图）。latent 尺寸不同视为不同生成事件——固定 seed
> 工作流（如 PrimitiveInt 节点）会在多次执行间复用同一 seed，仅凭 seed 无法
> 区分不同分辨率的独立生成，故尺寸参与分组。
> `seed` 为字符串且无法转数字时使用 `s:` 前缀以避免与数字 seed 冲突。
> seed 为列表时按元素展平，保证批量种子批次也能确定性分组。

## 14. `resolve_input_value` — 节点值解析器

签名：`resolve_input_value(graph, value, depth=0) -> Any`

### 14.1 递归与防环

- `depth > 12` 时立即返回原值（深度保护，防无限递归）
- 通过 `normalize_link` 判定是否为节点链接
- 节点链接目标节点缺失时返回原 value（保留链接结构）

### 14.2 class_type 分支

| class_type | 行为 |
|---|---|
| `PRIMITIVE_NODE_TYPES` | 依次尝试 `value / seed / number / float / int` 字段；输出索引 0 且以上均无时取首个 input 字段 |
| `Text Multiline` | 取 `inputs.text` |
| `Text Concatenate` | 取 `text_a + delimiter + text_b`，整体 `.strip()` |
| `Text to Conditioning` | 递归 `inputs.text` |
| `CLIPTextEncode` | 取 `inputs.text`（默认 `""`） |
| `__blueprint_input` / `__blueprint_output` / `__external_node` | 返回原 value（转换器注入的模板端口占位节点，无可解析值；2026-08-04） |
| `AbsNode` | 递归 `input1`，按类型取绝对值；字符串尝试 `int`/`float` 解析 |
| `ConditioningCombine` | 返回 dict 包含 `conditioning_1` 与 `conditioning_2` 的解析结果 |
| `ImpactConditionalBranch` | 递归 `cond`，仅当解析结果为 bool 时按真值递归 `tt_value` / `ff_value`；cond 非 bool（缺失/未解析）时返回原 value 不猜分支（2026-08-28） |
| 其他 | 返回 `{"node_id", "class_type", "inputs"}` 包装对象（不解析） |

> **条件分支的单标量解包（2026-08-28）**：`ImpactConditionalBranch` 选中的值若
> 落在未知节点引用壳上，且该节点 `inputs` 恰有一个标量字面量（如 `easy int` /
> `easy float` 的 `value`、`Sampler Selector [RvTools]` 的 `sampler_name`），
> 则该 widget 即为分支输出值，直接解包为该标量。多输入、含连线、非标量形态
> 保持引用壳不变。典型场景：Impact Pack 条件分支 + easy-use 参数分组 +
> RvTools 采样器选择器组成的 turbo/质量双档参数切换。

### 14.3 透传规则

- 非 list/tuple 值原样返回（包括 dict、int、str、bool、None）
- 链接目标节点缺失时，**返回原始链接数组**而非 None
- 未识别的 class_type 返回包装对象，让上层能识别"未解析的节点引用"

> 此包装对象即 `record.schema.json` 中 `linkValue` 定义里的
> `{node_id, class_type, inputs}` 形态。

## 15. 辅助函数

### 15.1 `iter_image_files(root)`

- `os.walk(root, followlinks=True)` 递归
- 后缀大小写不敏感匹配 `SUPPORTED_EXTENSIONS`
- 返回排序后的 `list[Path]`（按字符串排序）

### 15.2 `extract_image_metadata(path)`

- `PIL.Image.open` 读取，`dict(image.info)` 拷贝避免引用问题
- 异常捕获 `UnidentifiedImageError` 与 `OSError`，统一抛 `ValueError`
- A1111 兼容：缺 `parameters` 时回退 `comment` 字段

### 15.3 `parse_json_field(value)`

- 字符串尝试 `json.loads`，失败时原样返回字符串
- 非字符串原样返回

### 15.4 `flatten_text_chunks(value)`

递归展平嵌套 str/dict/list 为字符串列表，过滤空白项。

## 16. 已知约束与陷阱

1. **`sha256` 是路径哈希，不是内容哈希** — 见 §10.1
2. **时间字段为 UTC** — `created_hour` / `created_weekday` 基于文件 mtime 的 UTC
3. **Power Lora Loader 依赖 workflow 嵌入** — 缺少 workflow UI 图时该类 LoRA 不会被解析
4. **bypass 节点完全不参与 LoRA 收集** — 与 README 中"Bypass LoRA 视为未使用"一致
5. **`depth > 12` 时解析中断** — 极深嵌套的工作流可能拿到未解析的链接
6. **Power Lora Loader 的 `strength` 同时写入三个字段** —
   `strength / strength_model / strength_clip` 在 `strengthTwo` 缺失时三者相同
7. **`raw_prompt` / `raw_workflow` 保留原始字符串** — 即使 JSON 解析失败也保留原值
8. **prompt 图节点 id 强制 `str()` 转换** — 数字 id 不会破坏查找
9. **`collect_negative_prompt_fallback` 仅识别特定关键词** —
   `worst quality / bad anatomy / watermark / lowres / blurry`，
   其他形式的负面 prompt 在缺失 sampler 信息时不会被识别

## 17. 与数据契约的对应

本模块输出严格对应 [`docs/contracts/record.schema.json`](../contracts/record.schema.json)：

| schema 顶层字段 | 产出函数 |
|---|---|
| `captured_at` / `created_date` / `created_hour` / `created_weekday` | `parse_image` 主体 |
| `batch_key` | `batch_group_key` |
| `file` | `build_file_info` |
| `metadata` | `parse_image` 主体 |
| `workflow` | `parse_image` 主体（Counter + 长度统计） |
| `model` | `collect_model_settings` |
| `loras` | `collect_lora_settings` |
| `prompts` | `collect_prompt_groups` + `build_prompt_search_text` |
| `samplers` | `collect_sampler_settings` |
| `latent` | `collect_latent_settings` |

> `recipe_key` / `image_refs` / `_image_refs_up_to_date` 字段不在 parser.py 产出范围，
> 由 NestJS 网关 `lib/recipe_keys.ts` 与 `lib/ingest.ts` 在入库阶段补充。

### 17.1 入库层扩展:image entry `source` 打标(非 parser 产物)

多网关共享库(2026-08)在**入库层**(NestJS `lib/ingest.ts` / `lib/archive.ts`)
对每条 batch `images[]` entry 附加 `source: {instance_id, base_url}`,用于
纯远程图片透传定位持有网关。约束:

- **不在 parser.py 产出**:`parse_image` 的单图 record 无 `source` 字段;
  batch 文档组装时由 `stampImageEntry()` 写入(file 的兄弟字段,不侵入
  `file` 语义,不改变本契约任何既有字段)。
- **image 级而非 doc 级**:跨用户同 seed 批合并($push 到已有 batch)时,
  doc 级字段会被后写者覆盖,image 级归属才可靠。
- 契约:见 `docs/contracts/record.schema.json` 的 `images[].source`(可选);
  mongoose `ImageEntry.source`(可选)。存量数据无该字段,透传对其回退 404。
- **独立远端图片库**:`source.protocol = "wfdb-image-library-v1"`
  时必须同时存在 `source.asset_id` / `source.base_url` 与
  `file.filename` / `file.sha256`;该类 entry 允许缺省本地
  `file.resolved_path`。读端代理到
  `/v1/assets/{asset_id}` 或 `/v1/assets/{asset_id}/thumbnail`。完整协议与
  构建 Schema 见 `docs/remote_image_library.md` 及
  `docs/contracts/remote-image-library-v1.schema.json`。
- 上述放宽只属于**入库后的 `images[]` entry**;顶层 parser record
  的 `file.resolved_path` 仍必产,`build_file_info` / `sha256` 语义不变。

## 18. 修改风险等级

任何修改都需评估以下风险面：

| 风险面 | 影响范围 |
|---|---|
| 修改 `parse_image` 输出字段名 | 直接破坏网关入库(`lib/ingest.ts`)、API、所有前端 |
| 修改 `sha256` 计算方式 | 破坏所有 `/api/thumb/{sha256}` 与 `/api/image/{sha256}` 路由 |
| 修改 `batch_group_key` | 破坏批次模型与历史去重 |
| 修改 `resolve_input_value` 透传规则 | 改变 `linkValue` 契约，影响 schema 校验 |
| 修改 `collect_lora_settings` 去重键 | 改变统计缓存与历史 LoRA 频率 |
| 修改时间字段时区 | 破坏热力图统计与 `created_date` 过滤 |
| 修改 `PRIMITIVE_NODE_TYPES` / `TEXT_NODE_TYPES` | 改变节点解析覆盖面，可能漏采或重采 |

修改建议流程：

1. 先在本文档对照行为差异
2. 同步更新 `docs/contracts/record.schema.json`
3. 通知 NestJS 网关消费方(`lib/ingest.ts` / `lib/archive.ts` / 前端)
4. 评估 `stats_cache.py` 是否需要重建

## 19. 变更记录

### 19.1 seed 完整解析(2026-08-11,`feat(parser)`)

**目标**:解析结果可完全复现生成参数——补 `noise_seed`(KSamplerAdvanced 独立噪声
种子)与 `seed_source`(seed 来源节点 provenance),并让 `batch_group_key` 支持
列表 seed。

**改动**:

- `collect_sampler_settings` 新增 `noise_seed` / `seed_source`(均可选,缺失时
  过滤/不产出,既有 record 字节不变;见 `seed_source_info` / `_seed_token`)
- `batch_group_key` 对 list seed 逐元素展平(原行为:list 静默丢弃)
- 契约同步:`record.schema.json` samplers 项 + `nest_gateway/src/contracts/record.ts`
  zod `SamplerEntrySchema`
- 派生层/重放层对齐:`sampler_view.SAMPLER_PARAM_FIELDS` 与
  `comfy_replay.SAMPLER_FIELDS` / `NUMERIC_SAMPLER_FIELDS` 补 `noise_seed`
  (seed 重放仍走 `find_mutable_seed_target` 溯源写回来源节点)
- 新增 fixture `0055_seed_ksa_noise_seed.json`(KSamplerAdvanced + PrimitiveNode
  seed 链 + noise_seed);49 个既有 fixture 的 samplers 黄金输出补充 `seed_source`

**回归**:fixtures 回归通过(56/56);`record.spec.ts` 2/2 PASS;
`tests/` 派生层 49/49 PASS(既有 `test_derived_summary` HTTP 502 为环境依赖,
基线同样失败)。

**迁移评估**:`noise_seed` / `seed_source` 均为可选字段,存量记录缺失时前端
回退展示;`batch_key` 对存量标量 seed 记录输出不变,无数据迁移。增量扫描
重新解析后新字段自动补全,无需重建 stats 缓存(统计不消费新字段)。

### 19.2 batch 级 seed→图片 对齐派生(2026-08-11,`feat(seed-images)`)

**目标**:当每张图片本身有独立 seed(工作流 seed 输入为列表,批量种子节点)时,
在批次对象内存入 seed→图片 的对齐映射;标量 seed(标准 KSampler)同样生成
(每张图填充同一值,诚实呈现"整批共享")。

**改动**(parser 零改动,全部为组装/查询层派生):

- 新函数 `nest_gateway/src/lib/seed_images.ts` `buildSeedImages(samplers, images)`:
  - `sampler.seed` 为数组且长度 == images 数 → index 对齐(每张图独立 seed)
  - `sampler.seed` 为标量 → 每张图填充同一值
  - 长度不匹配(跨批 `$push` 追加)/无法解析(连线对象)→ 该阶段占位 `null`
  - 产出 `batch.seed_images`: `[{sha256, filename, seeds: [阶段1..阶段N]}]`,
    每行与 `batch.images[i]` 对应,`seeds` 数组 index == sampler index
- 接入点(3 处,与现有 `batch.seeds` 派生同位置):
  - `images.controller.ts` `shapeRecipeGroupDoc`:recipe 模式,**仅单批**
    (`batch_keys.length <= 1`)生成 — 多批 recipe 的 samplers 取最新批次
    ($first),与合并 images 无法精确对齐
  - `images.controller.ts` `shapeBatchDoc`:batch 模式 `/api/images/details`
    响应补 `batch` 对象(该模式此前无 `batch.seeds`,一并补齐)
  - `parse.controller.ts` `shapeSingleRecordDetail`:transient 批次
- 契约:`record.ts` zod `LinkValueSchema` 增加数组类型(批量种子 list seed
  此前无法通过校验,属隐藏缺口)

**阶段语义(与展示层契约)**:

- 多 sampler 大概率对应多次采样:首个阶段为主采样(denoise 1.0),
  后续阶段为后处理/放大(denoise < 1),其 seed 常为固定小值(1/4 等)
  —— 50 个 fixtures 中 10 个多 sampler 记录 100% 符合该模式
  (第二 sampler seed 恒为 4,denoise 0.45)
- 前端按"阶段"分组展示:主采样/后处理标注 + `固定` 标记(标量 seed 或
  数组全同),消除"多 seed 拼接"的歧义

**回归**:fixtures 回归通过(57/57,新增 `0060_seed_batch_seed.json`:
批量种子 + 后处理固定 seed 1);`record.spec.ts`(含 list seed 校验)2/2;
`seed_images.spec.ts` 6/6;`ingest/archive` 非 SQLite 测试全绿。

**迁移评估**:`seed_images` 为 API 响应派生字段,不入库、不改既有 doc 字段,
零迁移;存量数据经 detail/recipe 查询自动获得映射(无 list seed 时生成
标量共享映射,不影响展示回退)。

### 19.3 batch_key 增加尺寸维度(2026-08-12,`feat(parser)`)

**目标**:固定 seed 工作流(seed 来自 PrimitiveInt 等固定节点)会在多次执行
间复用同一 seed,`batch_group_key` 仅按 seed 分组会把不同分辨率的独立生成
事件错误合并为同一批次。实测源图(`D:\example\...\attept\nsfw_00039_.png`
864×1440 与 `nsfw_00053_.png` 1880×1440,seed 均固定为 70928044177154)被
并入批次 `seed:70928044177154`。

**改动**:

- `batch_group_key` 新增 `size` 参数:有 seed 且尺寸可用时键追加
  `@<w>x<h>`(如 `seed:70928044177154@864x1440`),无尺寸时维持原格式
- 新增 `_batch_size_token(latent, file_info)`:latent 尺寸优先(生成画布),
  缺失回退 file 尺寸(PIL 实测像素),均不可用返回 `None`
- `parse_image` 的 `batch_key` 派生同步传入 size(见 §4.2)
- 契约:`batch_key` 仍为 string,`record.schema.json` / `record.ts` 无类型
  变更,注释同步
- 消费方核对:batch_key 全链路仅作不透明定位键(ingest upsert / 查询),
  无人解析 `seed:` 前缀;`seed_images`(按 sampler.seed 派生)、`recipe_key`
  (已含 latent 维度)、前端展示均不解析 key → 无需改动

**回归**:fixtures 回归通过(58/58,batch_key 重算
回写,排版不变);`record.spec.ts` 全绿;`tests/` 派生层全绿。

**迁移评估**:键格式变化 → 存量库(batches / batch_images / Mongo images)
旧键失效,需全量重灌(SQLite:TRUNCATE_SQL + 全量重扫 D:/example;Mongo
按新键重建)。增量扫描解析新文件自动使用新键。
