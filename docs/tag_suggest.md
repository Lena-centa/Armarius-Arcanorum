# Danbooru Tag 补全参考

基于 `D:/gnn` 训练完成的 danbooru tag GNN（test AUC 0.959）与共现图资产，为工作流搜索
提供三条能力线。**网关运行时零 ML、零嵌入常驻**——联想/单 tag 索引纯 SQLite 查表，
组推荐在扫描入库时由 worker 预计算落库。

## 能力线

| 能力 | 端点 / 触发 | 运行时形态 | 常驻内存 |
|---|---|---|---|
| 搜索框联想（字面 + 多语言别名） | `GET /api/tag-suggest` | SQLite `tags`/`tag_alias` 查表 | 0 |
| 单 tag 索引（两部分：wiki 官方特征 + 分类推荐） | `GET /api/tag-related`（悬停/右键） | SQLite `wiki_traits`+`tag_category`+`edges`+`tag_gnn_nn` | 0 |
| 补全参考（导入时组推荐预计算） | ingest 挂钩 + `GET /api/batch-suggestions` | worker GNN 58MB（ingest 时） | 58MB |

> **NL 整句语义搜索已移除**（2026-08-19）：查询空间开放导致句子嵌入无法预计算，
> 运行时依赖 e5+FAISS ~1.7GB 常驻 + ~26s 冷启动，性价比不足。语义查询由
> `tag_alias` 多语言别名层（22 万别名，36.5% 带中文）兜底；若未来需要，
> 可离线蒸馏 `nl_phrase` 词典表（短语→tag）实现纯 SQLite 近似。

## 两部分设计（P9）

单 tag 索引拆为"权威特征 + 分类推荐"两部分，悬浮窗对应两区块：

1. **权威特征 `traits`**（力求准确可靠，**仅 character 类型 tag 返回**）：
   条目**仅**来自 wiki 参考图（`!post #id`，编辑人工挑选）实际携带的 tag
   （`wiki_traits` 表，1.34M 行）——凡 wiki 配图中出现的（vote ≥1）全量返回，
   **数量不定值、不截断**；`vote_official`（official_art 图数）是排序信号而非
   过滤门槛，官方立绘条目排前（如 hataya_misuzu 仅一张 official art 配图，
   其服饰/发色特征即取自该图）。`tag_category` 表（112k 行）为特征打语义类别
   （发色/发型/瞳色/服饰/配饰/表情/身体/构图/背景/...）。非 character 类型
   （general/copyright 等）不返回特征——特征语义只在"角色→其外观特征"方向成立；
   wiki 无数据时特征区缺省，**不做共现估计兜底**（非 wiki 来源一律不进特征区）；
   紧凑浮层限高滚动预览，完整面板全量展开。
2. **分类推荐 `categories`**：LLR+GNN 邻居 RRF 融合后按 `tag_category` 语义分组
   （角色/作品/构图/背景/环境/发色/发型/瞳色/服饰/配饰/表情/身体/动作/...），
   前端按类别分行展示；旧库未 patch 时降级为 danbooru tag_type 五类分组。

**不需要重训 GNN**：P8 wiki-first 训练图已以 wiki 官方关联为主边，语义分类与特征
投票属查表后处理，纯 SQLite 零 ML。

## 配置（.env）

| env | 默认 | 含义 |
|---|---|---|
| `TAG_SUGGEST_ENABLED` | `1` | 总开关；`0` 全关 |
| `DANBOORU_ASSETS` | 空 | GNN 资产目录（worker 侧 `vocab_sorted.npy`/`embed_gnn.npy`）；空或无效 → 预计算禁用 |
| `DANBOORU_DB_PATH` | 空 | 联想/查表库路径；空 → 自动探测 `<repo>/danbooru/danbooru.sqlite3`，文件缺失则查表端点禁用 |

**降级语义**：任一资产/依赖缺失 → 对应能力静默禁用（端点返回 `enabled:false`、ingest 挂钩跳过、
前端"空即隐藏"），不报错、不阻断既有功能。未配置时系统行为与接入前完全一致。

## 资产构建（一次性）

```bash
# 需 D:/gnn venv（numpy/pandas/pyarrow）；产出 danbooru/danbooru.sqlite3 + npy 资产
<dnndev>/python.exe utils/build_danbooru_db.py [--src D:/gnn/out] [--block 4096]

# 存量库补语义两表（P9，不重建 GNN 邻居表，幂等）：
#   前置 D:/gnn/scripts/p9_semantic.py 产出 tag_category/wiki_traits parquet
<dnndev>/python.exe utils/build_danbooru_db.py --patch-semantic [--src D:/gnn/out]

# 角色索引完整性扩展（2026-08-19）：词表(112,283)按 p0 规则只保留 count≥200
# 的角色，导致 rossi_(arknights) 等新角色不在词表。本命令从 posts-snapshot
# 的 typed 列(count≥3,镜像 p0 MIN_TAG_COUNT)全量补角色/作品 tag 进 tags 表
# (offset id 112283+，GNN 资产不变)，并补 name_pc 列(剥括号键)、wiki 别名
# (wiki_extra other_names)、tag_category、新标题的 wiki_traits。幂等可重跑。
<dnndev>/python.exe utils/build_danbooru_db.py --patch-characters \
    [--snapshot D:/gnn/out/posts-snapshot.parquet]
```

产出六表 + 两份 npy：

- `tags`(112,283；`--patch-characters` 后 430,347，词表外角色/作品补入，id 112283+) / `tag_alias`(220,369；补丁后 690,165) / `edges`(3,601,294) / `tag_gnn_nn`(112,283×50)
- `tag_category`(112,283；补丁后 430,347)：tag → 语义类别（角色/作品/构图/背景/环境/发色/...）
- `wiki_traits`(1,338,661；补丁后 2,277,020)：wiki 参考图 tag 投票（vote / vote_official 两列）
- `vocab_sorted.npy`（字典序 tag 名，unicode dtype）+ `embed_gnn.npy`（GNN 嵌入副本）——worker 侧纯 numpy 读取

**行序陷阱**（构建脚本已处理）：`edges`/`embed_gnn` 用**字典序** tag 下标；`tag_texts`（别名来源）
是 vocab 文件行序，别名按 tag 名 join，绝不按行号对齐。

## 存量回填

存量批次的组推荐预计算由开发者本地的回填工具完成（需 runtime/venv 的 numpy，幂等；不随发布包分发）。
增量部分由网关 `orchestration.backfillTagSuggestions` 在每轮 sync 后自动补齐（每轮 ≤50 批次）。

## 发布打包（可选组件）

`danbooru/` 资产被 gitignore、不进 git archive，**默认发布包不含该功能**。需要随发布包分发时，在 release.sh 显式开启：

```bash
# 前置:先构建资产(见上),再打包
WITH_DANBOORU=1 ./release.sh          # 或 ./release.sh --with-danbooru
```

- **进包内容**：`danbooru.sqlite3`(571MB) + `vocab_sorted.npy`(70MB) + `embed_gnn.npy`(55MB) ≈ 700MB；`-shm/-wal` 瞬态文件不进包（部署端打开时自动重建）。
- **零配置启用**：发布包布局 `<包根>/danbooru/` 与 worker/网关默认探测路径一致，部署后联想/单 tag 索引/补全参考自动启用，无需 .env 配置；`VERSION` 文件含 `DANBOORU_ASSETS=1` 标记。
- **Python 依赖**：numpy 已声明进 `requirements.txt`（必须）并内置 `runtime/wheels/`（setup 离线解包兜底），无需额外安装。
- **不选时的行为**：与未接入前完全一致——查表端点 `enabled:false`、ingest 挂钩跳过，不阻断任何既有功能。

## 归一化与转义规则

- **查表键归一**：`norm_key = 小写 + 空格→下划线`。vocab 全小写、0 空格、大小写冲突 0，归一零冲突；
  用户 prompt 空格写法占主导（实测 63:1），故查表用下划线规范形、展示/回填用空格形式。
- **SQL 转义**：前缀联想用**范围扫描**（`tag >= ? AND tag < ?`），天然免疫 `_`/`%`/`\` LIKE 通配符
  （tag 名 85.6% 含下划线）；子串兜底用 `LIKE ? ESCAPE '\'`。
- **URL/HTML**：查询参数走 `URLSearchParams`；渲染沿用现有 `escapeHtml`。

## 多语言别名层

`tag_alias` 表含 103,571 个去重小写别名（44.1% 的 tag 有 CJK/韩文别名）。查询优先级：
别名精确 → tag 名前缀 → CJK 别名前缀 → 子串兜底。中文输入（初音未来/雷姆/琪露诺/东方）
精确命中规范 tag，UI 标注"别名"。

## 主 tag 锁定链（残缺/自然语言形态）

`/api/tag-related` 的输入可能是完整 tag、自然语言句子（悬停窗口）、或残缺形态
（`hina (blue archive): long wavy...` / `hina (blue arch` / 错字变体）。锁定按档位
逐级降级，命中即止，`tag.source` 标注命中方式（前端据此显示"识别自/模糊匹配"徽标）：

1. **剥壳候选链**（`tagKeyCandidates`）：权重外壳 `(x:1.2)`、`{...}`/`[...]`、
   `copyright: x` 前缀、尾部残留标点（`hina (blue archive):`）、描述尾巴
   （`name (source): desc` 取 `):` 边界前）——剥出词表规范形。
2. **括号不敏感**（`name_pc` 列）：输入剥括号后与剥括号键相等（词表 tag 名带消歧
   括号，窗口/句子输入常丢括号）；112,283 tag 剥括号仅 5 对冲突，冲突时 character
   优先、count 决胜。
3. **截断前缀**（character 限定范围扫描）：`hina (blue arch` → `hina_(blue_archive)`；
   裸短名（无括号且 <6 字符）歧义大，不做。
4. **来源约束模糊**（`fuzzy`）：剥括号组作为来源锚点（必须是词表 copyright tag），
   同作品 character 候选按编辑距离 ≤2 评分，距离并列按帖数决胜
   （`rosi (arknights)` → rossi 1911 帖 > rosa 878 帖）；带括号输入时先于句子档
   （句子会抢跑命中版权词），裸名无来源不做。
5. **句子识别**（`sentence`）：子序列词表匹配（见前端窗口说明），自然语言句子兜底。
   子序列键同时查 `name` 与 `name_pc`（剥括号键）——句子词切分剥掉括号
   （`the girl is manhattan cafe (umamusume)` → `manhattan_cafe_umamusume`），
   name_pc 把键对齐到带消歧括号的词表规范形（`manhattan_cafe_(umamusume)`），
   长序列优先排序天然压过版权词（`umamusume`）。
6. **同作品兜底**（`franchise`）：词表外新角色无 LLR/GNN 邻居（无嵌入/共现），
   邻居为空时按主 tag 的 `(franchise)` 后缀取同作品角色（count 降序），
   浮层"相关推荐/角色"区块仍有内容。

前端（app.js `danbooruQueryFor`）：segment 匹配 `name (source)` 形态时**整段发送**
（窗口化会把括号组或名字切掉）；否则按鼠标位置 ±3 词窗口发送，由句子档识别。
面板头部提供**固定按钮**（钉住后点击外部/页面滚动/悬停其他 tag 均不再关闭或替换，
便于对照阅读、连续点 chip 收集；Escape 仍可显式关闭；固定态仅随面板存在，不持久化）。

## GNN 能力边界（实测结论）

- **支持**：vocab 内 112,283 个 tag 的嵌入查询；`embed_gnn.npy` 与 checkpoint 前向逐位一致。
- **不支持**：vocab 外新 tag（SVD 特征不可生成，实测零向量/噪声）；text 特征输入（in_dim=128≠768）。
  新 tag 支持需 text 特征重训（二期，D:/gnn 侧）。
- **质量定位**：GNN 在"同作品社区"召回极佳（IP→角色），LLR 在属性族更干净；单 tag 索引用
  LLR+GNN RRF 融合互补。GNN 单独做 tag 推荐弱于 LLR（r50 1.2% vs 22.4%），故不作为唯一排序依据。
- **裁剪**：模型 131k 参数无可裁；嵌入/边表裁剪在查表化后无实际收益，不做。

## 内存账本

- 网关：0（查表）
- worker：组推荐 58MB（ingest 时常驻）

## 二期候选

~~p7 高配角色特征索引~~（已由 P9 `wiki_traits` 落地，见"两部分设计"）、text 特征重训支持新 tag、
`nl_phrase` 蒸馏词典（纯 SQLite 近似语义查询，见开头移除说明）、P4 本地组合挖掘重跑（本地 boost）。
