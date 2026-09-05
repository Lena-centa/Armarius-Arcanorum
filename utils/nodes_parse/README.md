# nodes_parse

ComfyUI 生态节点定义解析工具库（开发者离线工具，不随应用发布）。

职责范围：

- 生态索引：拉取/缓存 ComfyUI-Manager 的 `extension-node-map.json` 与 `custom-node-list.json`
- 接口提取：克隆扩展源码后 AST 解析旧版 `NODE_CLASS_MAPPINGS` /
  `INPUT_TYPES` / `RETURN_TYPES`，以及 V3 `get_node_list` / `define_schema`
- 行为契约：静态分析节点函数体，提取内部采样、输出派生、直通、side effect、
  determinism 与 seed 操作；无法证明的行为保持 `opaque`
- 注册表 v2：以 `(repo, class_type)` 为定义主键，保留跨仓库同名冲突；
  `records` 只是按仓库名稳定选择的向后兼容视图
- 全生态状态矩阵：每个索引 class_type 均标记 parser known、通用生成候选、
  待探针、动态 mapping 未解析、抓取失败或仅索引等状态

产出喂给 parser 受控扩展流程（AGENTS.md）与 `docs/parser/KNOWN_GAPS.md` §1.4 持续扫描约定。

红线：只读扩展源码做静态分析，不执行任何第三方扩展代码。

已有源码缓存可用 `python -m utils.nodes_parse.cli reanalyze-cache` 重跑静态
分析，也可通过 `--repos owner/name,...` 只重跑指定仓库；`rebuild-cache` 仅重建
聚合文件。这些操作都不访问网络。

行为指纹同样支持 `fingerprint --repos owner/name,...`，用于只分析本轮新增或
修复过的仓库，同时保留并重新汇总其他仓库已有指纹。聚合缓存重建会保留未变仓库
的指纹，并只对本轮重新提取的仓库失效，避免定向扩展使既有语义退化为 `opaque`。

静态接口/指纹命中不等价于 parser 已正确产出 record。只有合成图探针或真实
workflow fixture 证明字段损失，才进入 AGENTS.md 的受控扩展流程。

覆盖报告分别统计 definition、behavior、path、record projection；任何单一维度
都不能代表节点已被完整理解。

对正在运行的 ComfyUI，可执行：

```bash
python -m utils.nodes_parse.cli live-registry --url http://host:8188
```

该命令只读取 `/system_stats`、`/object_info`，并在安装 ComfyUI-Manager 时读取
其 `mode=local&skip_update=true` 本地扩展清单；不会检查更新或提交 workflow。生成的
`live/runtime_registry.json` 以运行时端口定义为权威，并只在 Python 模块到缓存
仓库存在高置信度映射时继承静态行为契约。它可直接传给
`NodeDefinitionRegistry.from_artifact()`；未证明的节点接口仍已知，但行为保持
`opaque`。

输出依赖按函数内全部赋值分支做保守并集；多分支可以证明 `transform`，但只有
单一直接输入派生才能证明 `identity`，控制流复杂度不会被当作透明证据。

V3 节点既可能由 `get_node_list` 注册，也可能继续出现在
`NODE_CLASS_MAPPINGS`。当静态 `define_schema.node_id` 与映射键一致时，接口会由
schema 补强，并以明确的 `execute` 作为行为入口；函数自身
`**kwargs["端口名"]` 的访问也会作为输入依赖证据，`io.NodeOutput` 只作为返回
封装器。整个过程不会导入或执行第三方代码。

对于包装第三方节点的子类，只有当缓存中的同名外部基类对执行入口形成一致共识，
且子类确实覆写该方法时，行为分析才会继承入口名和基类端口，并记录
`external_base_consensus` provenance；基类的最终 operation 不会直接继承。

`core_nodes_instantiated` 保留加载、解码、ControlNet 与采样等核心节点调用证据；
只有 KSampler/SamplerCustom 系列或核心采样函数调用才会设置
`internal_sampling`，加载器与解码器本身不会被计作采样。

为限制大型扩展仓库的内存占用，行为指纹一次只保留一个节点定义文件的 AST，
仓库内未被定义引用的 vendored/model 源码树不会进入索引，单文件超过 2 MiB
则跳过并写入 `skipped_oversize_source_files`。helper 仅在同一文件内追踪，跨文件
调用保守保持未知。单个执行函数的输出依赖追踪最多 50,000 步，超过预算的剩余
依赖保持 `opaque`，避免复杂赋值图造成无界 CPU/内存消耗。

运行时覆盖必须分开解读：`runtime_definition_coverage` 表示接口定义覆盖；
`behavior_resolved_coverage` 排除静态分析仍为 `opaque` 的契约；`path_states` 再按
节点全部输出槽统计 `known/partial/opaque/terminal`。不能用“已附着静态契约”冒充
“行为已解析”。
