# Workflow Semantic IR 规范

> 状态：增量接入。`parser.py` 已通过兼容门面构建 IR，但 record 字段语义保持冻结。
>
> 关联：[`PARSER_SPEC.md`](PARSER_SPEC.md)、[`KNOWN_GAPS.md`](KNOWN_GAPS.md)、
> [`record.schema.json`](../contracts/record.schema.json)。

## 1. 定位

ComfyUI workflow 是允许共享上游、多输入、多输出以及异常环的有向图，不是语法树。
本项目沿用 AST 这一产品术语，但实现必须是 graph-backed semantic IR。

IR 的职责：

- 规范化 API prompt 与可选 UI workflow 的节点坐标系；
- 原样保留字面量输入和节点连线的区别；
- 把输出槽、目标端口、link type、极性和证据来源作为连线语义；
- 把节点实现表示为有证据等级的操作契约，而不是仅按 class_type 命名；
- 为 parser、prompt recovery、sampler view、node graph 提供共享查询基础；
- 遇到未知节点、缺失节点、动态节点定义或异常环时安全降级，不执行第三方代码。

IR 不写入 record，不落库。`metadata.raw_prompt/raw_workflow` 仍是可重建 IR 的事实来源。

## 2. 不可破坏约束

### 2.1 连线是一等语义

一个语义绑定由以下坐标共同确定：

```text
(source_node_id, source_slot, target_node_id, target_field, semantic_branch)
```

不能只按节点 id 去重。相同节点可能通过不同输出槽同时进入 positive/negative，或被多个
sampler 共享；这些绑定必须分别保留。

IR 同时提供：

- `LinkExpr`：节点输入中的原始链接表达式；
- `RawEdge`：不带推断的无损边；
- `SemanticEdge`：带 declared type、kind、polarity、branch、provenance、confidence 的边。

`SemanticEdge` 还携带源节点的 `source_operation` 与 `path_effect`。`path_effect`
只能是静态证明后的 `identity`、已知派生的 `transformed` 或安全降级的 `opaque`。

值解析器可以沿 `LinkExpr` 求值，但不得以求值结果替换或删除边。

### 2.2 顺序稳定

节点顺序沿用 API prompt JSON 插入顺序。现有 parser 的 sampler 顺序、base model 首个匹配、
prompt 去重顺序和 batch key 均依赖该顺序。任何 canonical 排序只能用于离线注册表，不能改变
运行时节点遍历顺序。

### 2.3 共享节点不展开

IR 按 node id 保存节点，不能把 DAG 复制成树。循环在建图阶段只形成边，不递归展开；具体
visitor 使用 path-local visited 和深度上限控制遍历。

### 2.4 证据优先级

连线类型证据按以下顺序使用：

1. UI workflow link type 与真实目标端口；
2. 离线 Node Definition Registry 的一致输入/输出声明；
3. API prompt 的目标字段名；
4. 无法判断时 `other/unknown`，不得猜测为具体生成语义。

多个仓库对同一 class_type 的端口类型声明冲突时，registry 返回未知，不任意选择定义。
API prompt 本身不携带仓库来源；本机扩展加载器若能证明实际注册实现，可通过
`selected_definition_ids[class_type] = repo::class_type` 显式消歧。没有该证据时必须保留
`conflict/opaque`，不得采用 canonical 排序结果作为运行时语义。

对于可访问的 ComfyUI 实例，`nodes_parse live-registry` 读取 `/object_info` 建立
运行时注册表。节点输入、输出和 `python_module` 以实际实例为权威；静态定义库只补充
实现行为。若安装了 ComfyUI-Manager，其 `mode=local&skip_update=true` 清单提供已启用
仓库证据；不会触发更新检查。其次才使用安装目录与仓库名精确匹配，或至少三个独立
class_type 以 80% 以上比例共同指向同一仓库且名称 token 也相符。多个包共用
`python_module` 时，只有 class_type 唯一命中且仓库启用/名称相符才允许节点级消歧；
ComfyUI 核心模块族只允许映射到 `comfyanonymous/ComfyUI`。否则行为继续为 `opaque`。

### 2.5 未知不等于透明

没有行为证据的节点一律是 `opaque transform`。只有输出槽被静态证明直接来自唯一输入、
且没有输入修改时，数据路径才可标记为 `transparent/identity`。透明路径与节点操作是两个
维度：节点可以保持数据引用不变，同时执行下载、清缓存或审计等 `side_effect`。透明管道仍
保留为节点，用于表达数据确实经过了一次操作；不得从图中删除。

## 3. 数据结构

`workflow_db.workflow_ir` 提供：

- `WorkflowIR` / `WorkflowAST`：canonical graph；
- `AstNode`：原节点、输入表达式、UI 节点与 bypass 信息；
- `LiteralExpr` / `LinkExpr`：输入表达式；
- `RawEdge` / `SemanticEdge`：原始边和语义边；
- `NodeDefinitionRegistry`：离线节点定义只读视图；
- `NodeDefinitionView`：附着到遇见节点的 definition id、端口共识与冲突状态；
- `NodeBehavior` / `OutputDerivation`：节点操作和输出来源契约；
- `classify_edge_kind`：以目标端口优先的边分类。

`parser.WorkflowGraph` 是 `WorkflowIR` 的兼容门面。冻结 collectors 仍使用
`node/node_inputs/node_type/workflow_node/node_is_bypassed`，同时可访问 richer IR。

## 4. Node Definition Registry

注册表来自 `utils.nodes_parse` 对第三方源码的静态 AST 审计。节点定义主键必须是：

```text
(repo, class_type)
```

产物 v2 包含：

- `definitions`：全部定义，键为 `repo::class_type`；
- `class_type_index`：class_type 到全部 definition id；
- `collisions`：跨仓库同名定义；
- `records`：为旧消费者保留的 canonical 视图，按仓库名稳定选择。

源码只做静态读取，禁止 import 或执行第三方扩展。旧版接口与静态注册的
Comfy Extension V3 (`get_node_list` + `define_schema`)均可提取；动态 node id、
动态列表或无法解析的接口必须保留 unresolved 状态和证据，不得当作“不存在节点”。

每条 definition 可包含 `semantic`：

- `operation`：`identity/transform/sample/sink/side_effect/constant/opaque`；
- `output_derivations`：output slot 到输入字段或静态表达式的映射；
- `side_effects`：文件、网络、输出 sink、输入修改；
- `determinism` / `batch_behavior`；
- `transparent`、`provenance`、`confidence`。

Python 是图灵完备语言，静态分析不承诺还原任意函数的完整业务含义。无法证明的表达式必须
停留在 `opaque` 或 partial，不允许以 class_type 名字猜成 identity。

## 5. 覆盖状态

覆盖报告以四个互不替代的维度统计：

1. `definition`：端口和类型是否可解析；
2. `behavior`：节点操作契约是否已知；
3. `path`：各输出槽的数据来源能否传播；
4. `record_projection`：真实 fixture 是否证明语义进入 record。

“生态状态已盘点”不等于四个维度均覆盖。源码定义命中也不自动提升 behavior/path/record。

全生态审计为每个索引 class_type 输出一种状态：

- `parser_known`
- `observed_direct_coverage`
- `observed_topology_coverage`
- `observed_derived_coverage`
- `observed_isolated`
- `observed_needs_probe`
- `generic_generation_candidate`
- `extracted_non_generation`
- `extracted_unresolved`
- `dynamic_mapping_unresolved`
- `fetch_failed`
- `index_only`

静态接口命中只说明可以生成通用 IR 注解，不等价于 record 字段已经正确。只有合成图探针或
真实 workflow fixture 证明字段损失，才能进入 parser 受控扩展流程。

## 6. 接入顺序

1. `WorkflowGraph` 兼容门面与 record deep-equal 守卫；
2. `node_graph` 消费 semantic edges；
3. prompt recovery 与 sampler view 逐个迁移；
4. AST record emitter 只做 shadow diff；
5. 长期完全一致后，才评估切换冻结 collectors，保留 legacy fallback。

每一步都必须保持 fixtures 字段级 deep-equal，并单独覆盖多输出槽、共享节点、正负极性、
Bus/Switch、bypass、v1 links、blueprint 子图、缺失节点和异常环。
