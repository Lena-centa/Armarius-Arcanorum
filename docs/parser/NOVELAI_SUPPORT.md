# NovelAI 图片解析支持(NOVELAI_SUPPORT)

> 状态:parse_worker 层零侵入适配器(2026-08-16 落地)。
> 本文件是 `workflow_db/novelai.py` 的行为契约;parser.py 冻结核心不受影响。
> 互联网公开来源样本、chunk fixture 与本文的样本来源说明仅用于**离线开发参考和回归**，
> 不是运行时依赖；运行时只消费图片自身已嵌入的本地 metadata，不访问远程服务、
> `index.json` 或 `ai_json`。

## 1. 背景与定位

本系统原只解析 ComfyUI 生态图片(PNG tEXt `prompt`/`workflow` 块 + A1111 `parameters` 兼容)。
NovelAI 生成图携带完全不同的元数据格式(PNG tEXt `Comment` 块内嵌 JSON),此前
落入 `record.metadata.extra` 但 `prompts` 为空,被所有列表/统计/搜索的
`prompts.positive` 硬过滤而不可见。

本适配器在 **parse_worker 层后处理**(`workflow_db/parse_worker/methods.py` 的
`parse_image` RPC 包装处,调用 `workflow_db.novelai.apply`),把 NovelAI 元数据
映射进 record 既有字段,实现 ComfyUI 与 NovelAI 图片**同时解析、共存入库**:
ComfyUI 图片经检测门必然不命中,解析路径与历史行为完全一致。

## 2. NovelAI 元数据格式(事实依据,2026-08 调研)

- PNG tEXt 块:`Comment`(JSON 字符串,核心字段 `prompt`/`uc`(负面)/`seed`/`scale`(CFG)/
  `steps`/`sampler`/`model`/`noise_schedule`/`sm`/`sm_dyn`/`cfg_rescale`)、
  `Description`(prompt 纯文本)、`Software`(恒为 `"NovelAI"`)、`Source`(模型串,
  如 `Stable Diffusion 1D44365E` / `NovelAI Diffusion V4.5 4BDE2A90`)。
  另有 alpha 通道 stealth 层(同一 JSON 的 gzip 副本,本适配器不读取)。
- **t2i/i2i 同构**:两种模式共用同一 Comment JSON 结构,i2i 仅多
  `strength`(去噪强度)/`noise` 两个可选键;源图不嵌入元数据。适配器无需按模式分支。
- **V4 双格式(2025 起)**:新增 `v4_prompt`/`v4_negative_prompt` 结构化对象
  (`caption.base_caption` + `char_captions[].char_caption`),但顶层平铺字段仍写;
  NAI 新/旧格式并存甚至"随机"二选一。适配器对**双格式并存**与**仅新格式**均兼容。
- **双格式语义补齐(2026-08-23 修复)**:双格式下顶层平铺 `prompt`/`uc` 仅含
  base_caption,**角色 prompt 只存在于 `char_captions[].char_caption`**(如
  146643178 样本:miku/luka 双角色)。适配器以顶层平铺为 base,其后再追加
  非空 char_captions(`", "` 连接);若角色文本已内联于 base(未观测到的写法)
  则不重复追加。

## 3. 检测规则(检测门)

`extract_comment(metadata)` 双条件命中才判定为 NovelAI:

1. **强信号**:`extra.Software` 含 `novelai`,或 `extra.Source` 含
   `stable diffusion` / `nai-diffusion` / `nai_diffusion`;
2. **JSON 签名**:`extra.Comment` 可解析为 JSON,且含 `scale`+`sampler` 组合,
   或含 `v4_prompt` 对象。

A1111(comment 为 infotext 文本)、ComfyUI(prompt 为节点图结构)必然不满足
签名条件;任何不命中都原样返回 record,零副作用。

## 4. 字段映射

| NovelAI 字段 | 映射到 record | 说明 |
|---|---|---|
| `prompt`(顶层优先)/`v4_prompt.caption.base_caption`(回退)/`Description` chunk(再回退,真实 V1/V2 样本的 Comment 无 prompt 键) + `v4_prompt.caption.char_captions[].char_caption`(非空时追加,双格式下角色 prompt 仅存于此) | `prompts.positive[0]` | 复用 `prompt_payload()`;`source_node_type="NovelAI"`、`branch_label="novelai-positive"`;原文保留 NAI 权重语法(`{}`/`[]`)不转换 |
| `uc`(顶层优先)/`v4_negative_prompt.caption.base_caption`(回退) + 其 `char_captions[].char_caption`(非空时追加) | `prompts.negative[0]` | 同上,`branch_label="novelai-negative"` |
| 二者 | `prompts.search_text` | 复用 `build_prompt_search_text()`,全文检索可用 |
| `seed`(仅非零 int) | `samplers[0].seed` | **seed=0 防御**:NAI 随机种子语义未知,0/缺失不参与批次键,保持每图一批 |
| `steps` / `scale` / `sampler` / `noise_schedule` | `samplers[0].steps/cfg/sampler_name/scheduler` | 与 ComfyUI sampler 条目字段名对齐,前端直接渲染 |
| `model`(缺失时回退 `extra.Source`) | `model.base_model` + `model.nodes[0]={node_type:"NovelAI", model_name}` | 筛选下拉自然出现 NAI 模型名 |
| `file.width/height`(实测像素) | `latent.width/height` | 不依赖 Comment 内尺寸字段 |
| 非零 seed | `batch_key` 重算为 `nai:` + `batch_group_key(...)` | **批次隔离**:`nai:` 前缀防止与 ComfyUI 同 seed 同尺寸批次合并(共存要求) |
| `Comment` 原文 | `metadata.raw_novelai`(新增可选字段) | 与 `raw_parameters`(A1111)对称;前端徽标与排障用 |

## 5. 容错与失败态

- 任何字段缺失 / 类型异常 / 结构未知 → 跳过该字段继续映射;
- `apply()` 整体包裹 try/except,异常时原样返回 record——**绝不阻断入库**
  (失败态与现状一致:NAI 图保持空 prompts 不可见,不产生错误记录);
- 未检测到 NovelAI 的图片(含 ComfyUI / A1111 / 无元数据图)逐字节原样返回。

## 6. 与冻结核心的关系

- **只导入不修改**:`workflow_db/novelai.py` 从 `workflow_db.parser` 导入
  `prompt_payload` / `build_prompt_search_text` / `batch_group_key`,保证字段结构
  与核心语义一致;parser.py 本体零改动,golden fixtures 回归全绿。
- 契约新增 `metadata.raw_novelai`(optional)已三端同步:
  `docs/contracts/record.schema.json`、`nest_gateway/src/contracts/record.ts`(zod)、
  `nest_gateway/src/schemas/images.schema.ts`;旧记录无此字段,deep-equal 不受影响。
- **依赖约定**:未来 parser.py 修改上述三个被导入函数(冻结区改动)时,
  须同步核对本适配器的调用签名与语义。

## 7. 已知限制(明确降级项)

- 无 `raw_prompt`/`raw_workflow` → 详情页节点图、「在 ComfyUI 打开」、生成重放
  对 NAI 记录自动不可用(前端已静默降级,属既有行为);
- stealth alpha 层不解析(Comment 块已足够;个别仅 stealth 的图留作后续);
- NAI prompt 权重语法(`{}`/`[]`)原样保留,不做 ComfyUI `(tag:weight)` 转换
  (展示与搜索语义正确,重放本就不支持)。

## 8. 测试

- `tests/test_novelai_adapter.py`(unittest,26 例):检测门 / 平铺映射 / V4 caption /
  双格式(含 char_captions 补齐)/ i2i 附加字段 / seed=0 防御 / 畸形容错 /
  ComfyUI 与 A1111 不命中 /
  **真实样本全回归**(`TestRealChunks`:遍历 `chunks/` 全部真实 chunk fixture,
  每 checkpoint ≥3 张,断言与 Comment 内嵌参数自洽)。
- 测试样本(fixtures/chunks)与回归脚本随**开发仓库**(不在发布包);本协议以 `docs/contracts/record.schema.json` 为准。
- 运行(开发环境):`runtime/venv/Scripts/python.exe -m unittest tests.test_novelai_adapter -v`。
- 适配器产出字段不进 parser collect 链路(NAI 字段语义不匹配),由适配器自持测试覆盖。

## 9. 真实样本来源与覆盖(离线开发参考)

历史样本曾来自互联网公开 API 与图片下载流程；这些来源仅用于构造本地 fixture 和
离线回归，**不属于运行时依赖，也不是当前离线分析工具的 oracle**。当前验证必须以本地
PNG chunk 和 `parse_worker` full worker 输出为准；不得在运行时或分析工具中读取
`index.json` 的 `ai_json`，不得访问远程 API。

**历史样本覆盖(2026-08-16 采集,仅作外部离线参考；不参与当前运行时或分析验收):**
NAI 2.0 起每大版本/checkpoint ≥3 张,共 39 张；历史 worker 直调与外部 oracle
曾全部一致。图不入仓库,仅 chunk 元数据入 `chunks/`。

| 大版本 | checkpoint(Source chunk) | 样本数 |
|---|---|---|
| V2 | Stable Diffusion 81274D13 / 31D10243 / F4D50568 | 3×3 |
| V3 | Stable Diffusion XL C1E1DE52 / 7BCCAA2C | 3×2 |
| V4 | NovelAI Diffusion V4 79F47848 / 37442FCA / 4F49EC75 / F6E18726 | 3×4 |
| V4.5 | NovelAI Diffusion V4.5 4BDE2A90 / B9F340FD / 1229B44F / C02D4F98 | 3×4 |

已知情况:部分旧作品经 CLIP Studio 等二次导出后 PNG chunk 已剥离(站点 ai_json
仍保留元数据),此类图不适用「文件 chunk → 适配器」链路,采集时已剔除并换图。
