# 从0与公开网络构建结构化数据及推荐数据库指南

> [活文档] 开发者技术指南 — 说明在远端 Git 仓库不含数据库实体的前提下，如何从 0、从测试样本或从公开网络构建结构化工作流数据库（`data/gray_workflow.sqlite3`）与推荐数据库（`danbooru/danbooru.sqlite3` + GNN 嵌入资产），并详述离线算法流水线与运维脚本。

---

## 1. 架构背景与数据分层

### 1.1 为什么远端代码库不包含数据库实体

项目在 [`.gitignore`](../.gitignore) 中对以下数据资产做了严格排除：
1. **主业务数据**（`data/gray_workflow.sqlite3*`）：用户本地生图记录与工作流资产，属用户私有数据。
2. **推荐库衍生数据**（`danbooru/*.sqlite3`, `danbooru/*.npy`, `danbooru/*.tsv`）：由公开数据集离线衍生的大体积二进制文件（约 860MB），避免污染代码仓库历史。
3. **备份数据**（`backups/mongodb/`）与发布包（`releases/`）。

源码发布包与日常开发默认保持“零数据依赖”，所有数据库均支持通过本地代码从 0 自动初始化、通过测试种子注入、或通过公开网络数据源离线构建。

### 1.2 系统三大数据系统矩阵

| 数据库 / 资产 | 存储形态 | 默认路径 | 核心能力 | 缺失时系统表现 |
|---|---|---|---|---|
| **主业务工作流库** | SQLite (WAL) | `data/gray_workflow.sqlite3` | 工作流解析记录、批次聚合（batches）、配方分组（recipe_groups）、图片元数据、FTS5 全文搜索 | 首次启动由代码自动从 0 建表，为空库 |
| **Danbooru 标签推荐库** | SQLite + NPY | `danbooru/danbooru.sqlite3`<br>`danbooru/vocab_sorted.npy`<br>`danbooru/embed_gnn.npy` | 标签联想（中英别名）、单 Tag 权威特征与分类推荐（LLR+GNN）、批次组推荐 | 静默降级（API 返回 `enabled:false`，前端隐藏推荐悬浮窗，不阻塞主流程） |
| **批次推荐预计算表** | SQLite 表 | 主库 `batch_tag_suggestions` | 批次级 GNN 组推荐快照（由 worker 在导入时或脚本离线回填） | 详情页补全参考区块为空，可通过脚本回填 |
| **节点生态知识库** | JSON 注册表 | `utils/nodes_parse/cache/` | ComfyUI 节点输入输出定义、行为指纹与契约分析 | 解析器回退至保守透明模式（`opaque`） |

---

## 2. 推荐数据库构建链路（Danbooru Tag & GNN）

Danbooru 标签推荐系统为工作流检索与打标提供三条能力线（搜索框联想、单 Tag 特征/分类推荐、批次级 GNN 组推荐）。运行时为**零 ML、零嵌入常驻的纯 SQLite 查表**形态（详见 [`docs/tag_suggest.md`](tag_suggest.md)）。

### 2.1 公开网络数据源（合规审计）

依据 [`danbooru/ASSET_LICENSES.md`](../danbooru/ASSET_LICENSES.md)，衍生推荐库严格仅采用以下两份公开授权数据集：

1. **`nyanko-devs/danbooru2026`**（Hugging Face / MIT 协议）
   - 文件：`metadata/posts-snapshot.parquet`（SHA-256: `5b6b...`）
   - 用途：标签频次（count）、共现矩阵计算、Top-50 LLR 边（`edges`）、GNN 模型训练与节点嵌入（`embed_gnn.npy`）。
2. **`isek-ai/danbooru-wiki-2024`**（Hugging Face / CC BY-SA 4.0 协议）
   - 文件：`danbooru-wiki-2024.parquet`（SHA-256: `f73a...`）
   - 用途：多语言别名提取（`tag_alias`，包含大量 CJK 中文别名）、Wiki 参考图打标（`wiki_traits`）。

### 2.2 离线算法与训练流水线（`D:/gnn`）

本地全套训练与处理脚本位于 `D:/gnn/scripts/`，流水线顺序如下：

```text
[posts-snapshot.parquet]       [danbooru-wiki-2024.parquet]
          │                                  │
          ▼                                  ▼
    p0_vocab.py ──────────────┬──────── fetch_wiki.py
          │                   │              │
          ▼                   ▼              ▼
    p1_cooccur.py       p3_textbridge.py   p8_wiki_graph.py
          │                   │              │
          ▼                   ▼              ▼
     p2_embed.py ────────▶ p6_gnn.py ────────┘
                              │
                              ▼
                     [D:/gnn/out/*.parquet]
```

- `fetch_wiki.py`：从公网拉取/处理 wiki 语料。
- `p0_vocab.py`：清洗生成基础词表 `vocab.parquet`。
- `p1_cooccur.py`：提取标签两两共现，计算 LLR 指标生成 `edges.parquet`。
- `p6_gnn.py`：在共现图上训练 Graph Neural Network，输出 `embed_gnn.npy`。
- `p9_semantic.py`：生成 `tag_category.parquet`（语义分类）与 `wiki_traits.parquet`（官方参考图投票）。

> 以上 `p0_*` ~ `p9_*` 管线脚本仅存在于**开发者本地仓库**（D:/gnn 训练工作区），不随发布包分发；产出资产（parquet/npy）由 `utils/build_danbooru_db.py` 构建为发布用 SQLite。

### 2.3 资产构建与落库脚本

在具备 `D:/gnn/out` 资产目录或直接下载好中间 Parquet 文件的环境下，运行以下脚本生成发布用 SQLite 推荐库：

#### (1) 全量从 0 构建推荐数据库
```bash
# 需具备 numpy, pandas, pyarrow 的 Python 环境
python utils/build_danbooru_db.py --src D:/gnn/out --out danbooru/danbooru.sqlite3 --block 4096
```
产出：
- `danbooru/danbooru.sqlite3`：包含 `tags`, `tag_alias`, `edges`, `tag_gnn_nn` 等核心表。
- `danbooru/vocab_sorted.npy`：按字典序严格排序的 Tag 名称数组。
- `danbooru/embed_gnn.npy`：与字典序词表逐行对应的 GNN 嵌入矩阵。

> **注意：字典序行序陷阱**
> `edges.parquet` 和 `embed_gnn.npy` 严格绑定字典序 Tag 索引（`tag2id = {t:i for i,t in enumerate(np.sort(vocab.tag))}`）；`vocab.parquet` 自身并非字典序。构建脚本 [`utils/build_danbooru_db.py`](../utils/build_danbooru_db.py) 内部已处理对齐，切勿绕过脚本手工插入。

#### (2) 语义分类与 Wiki 权威特征增量补丁（幂等）
```bash
# 为已有数据库注入 tag_category 与 wiki_traits 表，跳过耗时的 tag_gnn_nn 重算
python utils/build_danbooru_db.py --patch-semantic --src D:/gnn/out
```

#### (3) 角色索引扩充补丁（扩充至 43 万 Tag）
```bash
# 将 2025-2026 最新出现的角色/作品全量打入 tags 表（ID 112283+），补齐 name_pc 与 wiki 别名
python utils/build_danbooru_db.py --patch-characters --snapshot D:/gnn/posts-snapshot.parquet
```

#### (4) 重建别名与中英文权重索引

别名重建工具（重建 `tag_alias` 表，计算 pos 权重列，常见译名优先）仅开发者本地仓库存在，不随发布包分发。

#### (5) 存量批次推荐回填

对主库中尚未计算过 GNN 组推荐的批次执行预计算、写入主库 `batch_tag_suggestions` 表的回填工具仅开发者本地仓库存在，不随发布包分发；运行期增量回填由网关在每轮同步后自动补齐。

---

## 3. 主业务工作流结构化数据构建链路（`gray_workflow.sqlite3`）

主库保存解析后的工作流、Prompt、采样参数、模型信息及生图元数据。

### 3.1 纯代码级从 0 初始化（Zero-State Bootstrapping）

当系统克隆到一台空白机器且 `data/` 目录为空时：
1. **自动建表**：NestJS 网关启动时调用 [`openSqlite(dbPath)`](../nest_gateway/src/sqlite/db.ts)，内部自动执行 [`SCHEMA_SQL`](../nest_gateway/src/sqlite/schema.ts) 全量建表语句（`CREATE TABLE IF NOT EXISTS`）。
2. **增量版本对齐**：调用 `migrateSchema(db)` 按 `PRAGMA user_version` 补全字段迁移。
3. **FTS5 检索对齐**：调用 `ensureFtsAligned(db)` 确保虚拟检索表（`fts_batches`）与主表 rowid 严格一致。

无需任何 SQL 导入脚本，应用启动即自愈建库。

### 3.2 离线测试种子数据快速注入

开发者无需等待耗时的大图库扫描，可基于内置的代表性测试工作流离线注入种子数据
（**种子构建工具仅开发者本地仓库存在，不随发布包分发**）：由测试 fixtures 经
`WorkflowGraph` 生成标准化 records，再走生产入库路径写入 SQLite 主库。

- 产出覆盖：包含双 Sampler、ControlNet、ConditioningMask、LTX-Video 等典型场景的最小有效验证集。

### 3.3 从公开网络采集真实大样本

如需从零构建真实的多模型生成大样本库，可使用开发者本地的公网采集与解析工具
（**仅开发者本地仓库存在，不随发布包分发**），覆盖三个环节：批量采样公开作品池原图、
对样本运行全链路解析与覆盖率诊断、验证解析公开网络蓝图工作流。

### 3.4 生产数据接入（本地文件扫描与近实时同步）

针对用户本地实际生图目录：
1. 配置 `data/.env` 中的 `COMFY_SCAN_ROOT=D:/your/image/dir`。
2. 网关启动后，`orchestration.service.ts` 的 `syncLoop` 会调用 [`lib/ingest.ts`](../nest_gateway/src/lib/ingest.ts) 递归扫描 PNG/WebP，读取 tEXt/EXIF 元数据并调用 `parse_worker` 解析为规范的 `record`，落库至 SQLite。

---

## 4. 节点生态注册表构建链路（`utils/nodes_parse`）

用于解析 ComfyUI 生态中第三方自定义节点的输入输出契约。

### 4.1 数据流与抓取命令
```bash
# 1. 从 GitHub (Comfy-Org/ComfyUI-Manager) 拉取公开生态索引 (extension-node-map.json)
python -m utils.nodes_parse.cli fetch-index --workdir temp/nodes_parse

# 2. 从本地运行中的 ComfyUI 实例实时探测端口定义与映射
python -m utils.nodes_parse.cli live-registry --url http://127.0.0.1:8188
```
- 涉及脚本：[`utils/nodes_parse/index_fetch.py`](../utils/nodes_parse/index_fetch.py)、[`utils/nodes_parse/live_registry.py`](../utils/nodes_parse/live_registry.py)。
- 契约约束：红线只读源码进行 AST 静态分析，严禁动态执行任何第三方未受信任代码。

---

## 5. 从 0 搭建完整本地数据库实操 SOP

在全新拉取源码后，若需复现完整的“主库 + 推荐库”，执行以下步骤：

```powershell
# 步骤 1: 准备 Python 虚拟环境与依赖
python -m venv runtime/venv
runtime/venv/Scripts/pip.exe install -r requirements.txt
# 若需运行 GNN/Parquet 构建，还需安装:
runtime/venv/Scripts/pip.exe install pandas pyarrow

# 步骤 2: 启动一次网关，自动建立空主库 (data/gray_workflow.sqlite3)
cd nest_gateway
npm install
npm run build
node dist/main.js # 启动片刻完成 DDL 建表后可 Ctrl+C

# 步骤 3: 注入测试种子数据 (保证基础界面可测; 种子工具仅开发者本地仓库存在,此处从略)
cd ..

# 步骤 4: 构建推荐数据库 (需挂载或下载 D:/gnn/out 资产)
python utils/build_danbooru_db.py --src D:/gnn/out --out danbooru/danbooru.sqlite3

# 步骤 5: 存量批次推荐计算回填 (工具仅开发者本地仓库存在,此处从略; 运行期由网关自动补齐)

# 步骤 6: 检查构建结果
# 确认 danbooru.sqlite3 约 570MB~680MB, vocab_sorted.npy 约 70MB, embed_gnn.npy 约 55MB
```
