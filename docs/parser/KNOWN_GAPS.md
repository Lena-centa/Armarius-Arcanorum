# parser 相关盲区与派生层契约

> 本文件记录 parser 索引层与派生层(`sampler_view.py` / `node_graph.py`)的
> **剩余盲区**与**派生层行为契约**。历史盲区与扩展记录已随实现完成移除,
> 如需回溯见 git 历史。
>
> 关联:
> - [`PARSER_SPEC.md`](PARSER_SPEC.md) — parser.py 行为契约(只读基石)
> - [`contracts/record.schema.json`](../contracts/record.schema.json) — 数据契约
>
> 扫描样本:契约测试 fixtures(开发仓库,不在发布包)。
> 前端展示完整性依赖覆盖度,本清单是扩展优先级依据。

## 1. 剩余盲区(低优先级,不影响核心字段)

### 1.1 SAM / Ultralytics 检测器

- `SAMLoader`、`UltralyticsDetectorProvider` 等检测器节点
- **影响**:不影响 record 核心字段
- **优先级**:P3

### 1.2 Detailer 子工作流

- `DetailerForEachDebugPipe`、`FaceDetailerPipe` 等
- **影响**:Detailer 内部 prompt 会重复进入统计
- **扩展方案**:标记 detailer 子工作流,过滤重复 prompt
- **优先级**:P3

### 1.3 宏节点内部 ControlNet

- 官方 `ControlNetLoader` + `ControlNetApplyAdvanced` 已由派生层
  `extract_controlnets_from_chain` 覆盖(`editable.controlnets`)
- **遗留盲区**:宏节点内部 ControlNet 若藏进自定义字段(概率低,
  CONTROL_NET 必须显式连线)仍无法识别;ACN/Inspire 变体字段名差异
  需真实样本验证
- **优先级**:P3

### 1.4 持续扫描约定

未来发现新节点类型时:

1. 加入本清单
2. 标注优先级
3. 评估是否需要立即扩展(取决于是否影响前端展示)
4. 按**受控扩展流程**实施——parser.py 核心冻结,节点扩展仅在
   `docs/parser/PARSER_SPEC.md` 修改门槛内进行(节点扩展:新增至少
   1 个最小复现 fixture + 旧 fixtures 回归全绿)

## 2. 发布版本弹性适配(待发布时 P0)

> **触发条件**:系统从单机扩展到对外发布时,本节需求立即升级为 P0。

### 2.1 单机版本与发布版本的根本差异

| 维度 | 单机版本(当前) | 发布版本(目标) |
|---|---|---|
| 工作流来源 | 用户自己构造,高度可控 | 任意用户上传,生态全谱 |
| 节点类型覆盖 | 已知节点集合足够 | 必须处理未知节点 |
| 失败模式 | 漏采集(静默)可接受 | 不能崩溃、不能丢字段 |
| 扩展频率 | 偶尔(发现盲区时) | 持续(每次有新 ComfyUI 插件) |
| 维护成本 | 低(本地适配) | 高(需响应社区) |

### 2.2 当前 parser 在发布场景的失败模式

- **静默丢弃**:`collect_prompt_entries_from_link` 未识别的 class_type 直接
  `return []`,前端看不到该节点有 prompt
- **字段名硬编码**:`collect_model_settings` 仅识别
  `ckpt_name / unet_name / model_name / vae_name / clip_name`
- **hint 误判风险**:hint 匹配机制在生态扩大时会持续产生误判

### 2.3 候选策略

- **策略 A:未知节点"降级展示"** — 未识别节点进入
  `record.unclassified_nodes[]`,前端提示"含 N 个未识别节点"。需要新增
  schema 字段(record.schema.json + record.ts + mongoose + 前端)
- **策略 B:基于连线的"通用回退解析"** — 不靠 class_type 分支,靠连线结构
  推断角色。不改变 schema
- **策略 C:声明式节点注册表** — 节点识别改为外部 YAML 配置,社区可贡献

### 2.4 推荐组合(发布时 P0 必选)

- **单机版本(当前阶段)**:保持硬编码集合(性能高、可控),不引入未分类字段
- **发布版本**:必须实施策略 A + 策略 B 的简化版,后期可选策略 C

### 2.5 实施时机判据

满足任一即升级为 P0:

1. 系统确定要对外发布(用户基数扩大)
2. 实际用户上报"工作流字段缺失"
3. 出现新 ComfyUI 主流插件未被识别 — 按 P1 处理

## 3. 派生层设计契约(活规范,2026-07-19 定型)

> 本节是 `sampler_view.py`(editable 派生层)与 `node_graph.py` 的行为契约。
> 派生层从 `raw_prompt` 构建可编辑视图,供 `comfy_replay.build_replay_source`
> 的 editable 复用;**不动 parser.py(索引层冻结,fixtures 回归
> 保护),不改 record schema,无数据迁移**。

### 3.1 PoC 三轮验证结论

| 轮次 | 样本 | 关键发现 |
|---|---|---|
| 第一轮 | 51 fixtures(API prompt 图) | LoRA 0 差异;model 差异 = VAE/CLIP 在旁路链;10 个多 sampler 工作流 |
| 第二轮 | workflow_refer 19 个 UI workflow | CreateHookLora 全部在 sampler 链上(显式连线);11 个链外 LoRA(detailer/孤立);14 个多 sampler |
| 第三轮 | civitai WAN2.1 I2V(宏节点封装) | 类名 hint 失效,拓扑签名识别成功;链追溯需 link type 非 field 名 |

**核心结论**:class_type hint 与 field 名字面量都脆弱,唯有 link type
(ComfyUI 连线语义类型)是跨节点通用的稳定语义。

### 3.2 派生层设计契约

1. **根识别 — 拓扑签名优先,hint fallback**
   - 拓扑签名:input 含 `model`(或 `model_*`)+ `positive` + `negative` +
     `latent_image`(或 `source_image`/`image`/`latent`)→ 生成核心
   - hint fallback:class_type 含 `ksampler`/`sampler`(排除
     `Sampler Selector` / `KSamplerSelect` 两个名称选择器)
   - 拓扑签名是主路径,因聚合节点可能不含 sampler 字样

2. **链追溯 — 图遍历第一性(工作流本质是图)**
   - 从 sampler 出发,沿所有 input 边全连通 BFS(不过滤 link type),得到
     完整上游连通分量
   - `guider`/`pipe`/`scheduler`/`sigmas` 等打包节点标 `transparent`,
     图遍历自动穿过,不需为每种打包机制特化解包逻辑
   - 角色由节点 class_type 产出语义定,不由"从哪条边到达"定(UNETLoader
     永远是 model 角色)
   - link type 作辅助标注(标准 `MODEL`/`POSITIVE`/`NEGATIVE`/`LATENT`/
     `IMAGE` 映射),非过滤条件;自定义 link type 不阻断遍历

3. **未知节点降级展示**
   - 连线上的未知 class_type 节点,按所在链的 link type 定角色
     (model/prompt/latent/post),保留可编辑性

4. **widget 值读取**
   - `CreateHookLora` / `Power Lora Loader (rgthree)` 等:沿链定位节点后
     读 `widgets_values` 取 LoRA 名/强度(input 无连线)

### 3.3 editable 三区块(2026-08-04 扩展,零 schema 变更)

1. **`editable.controlnets`**(`extract_controlnets_from_chain`):
   - apply 识别:宽容 class_type 匹配(官方 + ACN 插件变体)
   - loader 溯源:沿 `control_net` 连线定位 loader,读 `control_net_name`
   - 极性判定:反向 BFS 定 apply 输出槽归属 sampler 正/负链
   - `bindings[]`:每 (apply×sampler) 一条,含 sampler_id/polarity/steps/
     effective_start_step/effective_end_step(`round(steps*percent)`)
   - UI workflow 兜底:被 bypass 的节点仍展示,标 `bypassed: true`
   - `apply_replay_edits` 支持强度/生效范围/模型名编辑

2. **`editable.regions`**(`extract_region_views`):
   - 区域节点识别:AttentionCouple 家族 + ConditioningSetArea 三兄弟 +
     Inspire Regional*
   - cond 上游文本收集(经 Text to Conditioning/Concatenate/Reroute/Combine 中继)
   - mask 链拓扑追溯(不解析像素):GrowMaskWithBlur 等关键参数 + 终点
     (LoadImage MASK 槽/SolidMask/ImageToMask)

3. **`node_graph`**(`build_node_graph`,按需派生不落库):
   - nodes: id/class_type/title/role/polarity/bypassed/params/origin/behavior
   - edges: from/from_slot/to/to_field/type/kind/source_operation/path_effect;
     UI links 权威 type,纯 API 图按字段名推断
   - groups: sampler 连通分量 + unattached 兜底
   - 双格式兼容:workflow `version==1`(reroute 对象 links)与六元组
   - 自 2026-08-24 起由 `WorkflowIR.semantic_edges` 提供边；source slot、target
     field、link type、polarity 与 provenance 不再由各消费者重复推断

### 3.3 Workflow Semantic IR（2026-08-24）

- 实现：`workflow_db/workflow_ir.py`；规范：[`WORKFLOW_IR.md`](WORKFLOW_IR.md)
- `parser.WorkflowGraph` 为兼容门面，record 输出和 schema 不变
- 工作流按属性图保存而非展开成树；共享节点、同节点不同输出槽、同节点正负分支分别保留
- UI link type 优先，离线节点注册表其次，API target field 作安全推断
- 节点行为契约区分 identity/transform/sample/sink/side_effect/constant/opaque；
  数据路径透明不代表节点没有下载、缓存或资源状态副作用，未知节点也不是透明管道
- 输出槽派生关系决定边的 identity/transformed/opaque 路径效应
- `node_graph` 已接入；`sampler_view` / `comfyui_recovery` 仍按分阶段计划迁移

**守卫**:`tests/` 下 test_controlnet / test_regions / test_node_graph(18 测试);
fixtures 回归(50 fixtures PASS)+ 双后端断言
(74 样本 round-trip 稳定)。

### 3.4 已验证的边界

- [已完成] CreateHookLora:经 ConditioningSetPropertiesAndCombine 显式连线,纯拓扑
  可追溯(非运行时注册)
- [已完成] 宏节点封装:拓扑签名识别根(`UmeAiRT_VideoGenerator`)
- [已完成] detailer 子工作流:11 个链外 LoRA 自动过滤
- [已完成] 多 sampler 归属:14 个多 sampler 工作流可按 sampler 分别归因
- [警告] pipe 机制(`ToBasicPipe` 等):部分 sampler 的 model 经 pipe 打包传入,
  需解包(实现细节)
- [警告] 自定义 link type:需按 input field 名映射角色(实现细节)

## 4. 多网关共享库的已定边界(2026-08)

> 多网关共享库语义边界(打标在 ingest 层),**与 parser 无关**,此处记录
> 共享库语义边界:

- [已完成] **实例归属**:每条 `images[]` 打 `source{instance_id, base_url}`(image 级),
  纯远程透传按此定位持有网关;存量数据无打标 → 透传回退 404
- [已完成] **独立远端图片库**:`wfdb-image-library-v1` 支持无本地
  `resolved_path` 的 Mongo image entry,按 `source.asset_id` 代理原图/缩略图;
  构建契约见 `docs/remote_image_library.md`
- [警告] **单副本边界**:当前一图只有一个 `source`;远端图片库/持有
  网关离线时资产不可用,但元数据查询仍可用。多副本需后续
  `assets.replicas[]` 模型
- [已完成] **纯远程模式**:`WORKFLOW_DB_REMOTE=1` 不建本地 SQLite(内存库占位)、
  不启动 sync/watcher/comfy 轮询;未配 MONGODB_URI 首启为 `remote-pending`
  空集状态
- [警告] **batch_key 跨用户碰撞**:固定 seed 生成相同 batch_key,跨用户同 seed
  时并入同一 batch(doc 级字段后写者覆盖,但归属在 image 级,透传不受影响)。
  罕见,已接受,不做命名空间化
- [警告] **recipe_key 跨用户合并**:同配方跨实例并入同一 recipe_groups(期望行为)
