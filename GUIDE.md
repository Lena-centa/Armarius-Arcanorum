# GUIDE — 部署与代码架构速览

> 面向部署 / 运维人员的入口文档:接手本包时先读本文,再按需查阅
> `README.md`(用户向)、`.env.example`(配置)、`VERSION`(构建标识)。

> **[警告] 生成功能状态声明(重要)**
>
> 生成链路(`/api/generate/*`、生成面板、基于历史工作流的"再次生成")目前
> **处于极其初步的开发阶段**:可能高度不稳定、存在大量已知/未知 bug,仅适合
> 试验性使用,**不应作为可依赖的功能**接入任何正式流程。检索 / 统计 / 标注
> 等只读能力相对成熟,可放心使用。

## 1. 这是什么

ComfyUI 图片档案库系统:

1. 扫描指定目录中的生成图片
2. 读取图片内嵌的 `prompt` / `workflow` 元数据,解析模型、LoRA、Prompt、
   采样器、分辨率等参数
3. 按"生成批次"写入本地数据引擎(SQLite 默认,可选 MongoDB)
4. 通过 Web 前端(默认 `http://127.0.0.1:8009`)检索、统计、标注与再次生成

## 2. 部署

### 2.1 系统要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10/11、Linux 或 WSL |
| Node.js | 22 LTS 或更新版本(24/25/26 亦可) |
| Python | 3.10 或更新版本 |
| 数据库 | 无需 MongoDB(SQLite 内置,开箱即用) |

### 2.2 部署方式(三选一)

```bash
# A. 一键部署(空白机器,自动预检/补依赖/初始化/启动)
./deploy.sh --repo <仓库地址>                  # Linux / WSL
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -RepoUrl <仓库地址>   # Windows

# B. 手动初始化(仓库已就位;setup 已并入 start 单入口)
./start.sh setup                        # Linux / WSL
.\start.ps1 setup                       # Windows

# C. 仅启停(环境已初始化;不带参数 = 检查→缺失自动初始化→启动)
./start.sh check | start | stop         # Linux / WSL
.\start.ps1 check | start | stop        # Windows
```

### 2.3 配置(用户数据目录 `.env`,缺失时自动生成)

配置统一存放在用户数据目录(Windows `%LOCALAPPDATA%\workflow_db`、
Linux `~/.local/share/workflow_db`;进程环境变量 `WORKFLOW_DATA_DIR` 可覆盖,
**不能写进 .env 本身**)。`.env` 缺失时网关首启从 `.env.example` 自动生成;
旧仓库根 `.env` 与 `data/` 主库会在首启时自动迁移(原文件改名 `*.migrated`)。
若同一工作区同时运行 Windows 与 WSL,将路径配置分别放在数据目录内的
`.env.windows` 与 `.env.wsl`(模板:`.env.windows.example`、`.env.wsl.example`)。
平台覆盖文件优先于共享 `.env`,但外部进程环境变量优先级最高。

**Node 依赖与 SQLite 平台隔离**:
- `nest_gateway/node_modules` 是平台激活链接(`node_modules.win` / `node_modules.linux`
  平台目录各含 `.platform` 标记,由对应平台的 `start.* setup` 安装并迁移旧布局)。
- **npm 命令可直接使用**:`package.json` 的 `preinstall`/`postinstall` 挂钩
  (`nest_gateway/scripts/ensure-platform.mjs`)会把任何 `npm install / ci / add`
  自动纳入方案——真实目录自动迁移为平台目录并重建链接,写 `.platform` 标记、
  安装戳(`.npm-stamp`)与 better-sqlite3 ABI 探测(ABI 错配时安装当场失败并
  给出指引)。`npm install` 在双平台任何状态下均安全(npm 只删链接不穿透)。
- **[警告] `npm ci` 有穿透风险**:npm ci 在 reify 前会跟随激活链接清空链接指向的
  目录。链接指向**本平台**时 = 正常重装;指向**他平台**时 = 清空他平台安装
  (任何钩子都拦不住)。规避:**切换平台后先运行对应平台 `start.* setup`
  或 `start.*`(自动改链),再执行 `npm ci`**;若已被清空,该平台
  启动守卫会 FAIL 并提示重跑 `setup` 重建,可恢复。
- **切换平台零重装**:运行 `start.*` 时若激活链接指向他平台且目标
  平台目录存在,自动改链(瞬间完成);仅当目标平台目录缺失才提示先运行
  对应 `start.* setup`。切勿手动删除 `node_modules.win` / `node_modules.linux`。
- **Node 版本必须 22-26**(`engines` + `engine-strict`):better-sqlite3 预编译
  ABI 仅覆盖 22/24/25/26,其余版本 npm install 直接拒绝。安装与运行使用同一
  node 解析(Windows 优先便携 node22,Linux 系统 node 优先、便携 node22 兜底)。
- 启动脚本(`start.*`)会校验激活链接指向当前平台,并实际加载
  better-sqlite3 探测 ABI(Windows 侧由 Resolve-NodeBin 自动选择可加载的
  node),错配时拒绝启动。
- SQLite 主库默认共享一个文件;双平台同时使用建议在平台覆盖文件中分别配置
  `SQLITE_DB_PATH`(每平台独立库),避免 WAL 锁竞争。

| 变量 | 说明 |
|---|---|
| `COMFY_SCAN_ROOT` | 图片扫描目录(必须配置后才有数据入库) |
| `NEST_GATEWAY_PORT` | 网关端口,默认 `8009` |
| `MONGODB_URI` | 留空 = SQLite 单引擎(默认);填写后为 MongoDB 引擎 |
| `COMFYUI_BASE_URL` | ComfyUI 地址(可选;启用近实时入库与生成面板) |
| `WORKFLOW_DB_REMOTE` | `1` = 纯远程只读网关(仅连远端 MongoDB,不做本地扫描) |
| `WORKFLOW_DB_PROXY_ALLOW_HOSTS` | 图片代理私网白名单；精确主机/IP，逗号分隔，不支持通配符 |
| `SQLITE_DB_PATH` | SQLite 主库路径;平台覆盖文件内配置可实现每平台独立库 |

### 2.4 验证

```bash
./start.sh check                 # 依赖自检(缺失即失败,可选依赖仅警告)
curl http://127.0.0.1:8009/api/health   # 健康检查
# 浏览器:http://127.0.0.1:8009(设置页可编辑 .env,保存后重启生效)
# VERSION 文件:构建来源标识(commit / 时间)
```

## 3. 代码架构

### 3.1 进程拓扑

```
┌───────────────────────────┐    stdin/stdout JSON-RPC    ┌──────────────────────┐
│  NestJS Gateway  :8009     │ ───────────────────────────▶│ Python parse_worker   │
│  (唯一 API 持有方)          │ ◀───────────────────────────│ 解析 + 缩略图(PIL)    │
│                            │                             └──────────────────────┘
│  ├─ /api/images|stats|...  │    stdin/stdout JSON-RPC    ┌──────────────────────┐
│  ├─ 定时循环(sync/backup)  │ ───────────────────────────▶│ Python generate_worker│
│  ├─ 图片透传/缓冲合并       │ ◀───────────────────────────│ ComfyUI 交互 + 工作流 │
│  └─ ServeStatic 前端       │                             └──────────────────────┘
└───────────────────────────┘
```

- NestJS 是网关与数据引擎的唯一持有方;Python 退化为两个长驻 worker,
  JSON-RPC 2.0 经 stdin/stdout 通信,崩溃由 supervisor 自动重启

### 3.2 目录地图

```text
nest_gateway/
├── dist/                  # 预构建运行时(开箱即用,无需 npm run build)
├── package.json           # npm install 依赖清单
└── src/
    ├── main.ts / app.module.ts
    ├── config/            # .env 读取
    ├── schemas/           # mongoose schema(仅 Mongo 引擎)
    ├── modules/           # images/stats/labels/parse/generate/orchestration/settings/static/health
    ├── workers/           # Python worker supervisor(spawn/超时/重启)
    └── lib/               # ingest(扫描入库)/ stats_cache / recipe_groups / archive / passthrough
workflow_db/               # Python 运行时包
├── parser.py              # 元数据解析核心(只读基石)
├── comfy_replay.py        # 生成工作流复用
├── sampler_view.py        # 派生视图(editable: controlnets / regions)
├── node_graph.py          # 节点图派生(按需,不落库)
├── parse_worker/          # 解析 worker(JSON-RPC)
├── generate_worker/       # 生成 worker(JSON-RPC)
└── static/                # 前端页面(HTML/JS/CSS,由 NestJS 托管)
```

### 3.3 数据流

```text
扫描(定时 300s / 文件事件) → parse_worker 解析单图 → 批次文档入库(SQLite/Mongo)
→ 查询 API(/api/images、/api/stats/*、/api/options) → 前端渲染

生成: /api/generate/* → generate_worker → ComfyUI /prompt → 输出图
      → ComfyUI /history 轮询 → 内存缓冲 → 批量 flush 入库(异步归档)
```

> [警告] 生成链路(上方第二段)为**实验性功能**:工作流复用解析、参数编辑、
> 异步归档等环节尚不成熟,失败/异常属于预期内,排查时优先检查
> generate_worker 日志与 ComfyUI 可达性。

### 3.4 数据模型要点

- **批次文档模型**:数据按 `batch_key`(seed 序列)归批,一批含多张图(`images[]`);
  列表接口返回批次级结果,单图以 `sha256`(路径哈希)定位
- **SQLite 单引擎**:库文件在用户数据目录 `gray_workflow.sqlite3`(WAL 模式,
  首次启动自动建库;旧 `data/` 库自动迁移);全文检索经 FTS5 镜像
- **契约字段**:record 结构定义在源码仓库 `docs/contracts/record.schema.json`
  (不随发布包分发);worker 通信协议见 `docs/contracts/parse_worker_protocol.md`

### 3.5 关键约定

- 引擎切换(Mongo ↔ SQLite)只在设置页"检测连接并切换"校验通过后写入生效
- 近实时入库:`WORKFLOW_DB_COMFY_POLL_SECONDS`(默认 3s)轮询 ComfyUI 历史 +
  内存缓冲 + `WORKFLOW_DB_FLUSH_SECONDS`(默认 15s)批量 diff 写入
- 远程模式(`WORKFLOW_DB_REMOTE=1`)不建本地库、不扫描,图片经
  `source.base_url` 从持有网关透传
- 首轮全量同步对内存要求较高,启动脚本已默认 `NODE_OPTIONS=--max-old-space-size=8192`

## 4. Bug 定位与 Issue 提交

> 完整规范见 [`DEVELOPER_GUIDE.md`](DEVELOPER_GUIDE.md)。本节为快速入口。

### 4.1 问题定位速查

| 现象 | 第一动作 |
|---|---|
| 启动 / 环境异常 | `./start.sh check`;核对 `VERSION`、node ≥22、python ≥3.10 |
| API 异常 | `curl http://127.0.0.1:8009/api/health`;`/api/sync-status`;网关 stderr 日志 |
| 图片未入库 / 字段缺失 | 确认图片带内嵌 prompt/workflow 元数据;单图调 `parse_image` 复现;对照 `docs/contracts/record.schema.json`(字段契约) |
| 生成失败(实验性) | 检查 generate_worker 日志;`curl http://127.0.0.1:8188/system_stats`;按"连接/校验/提交/归档"分类 |
| 数据引擎异常 | SQLite `check` 含 `PRAGMA quick_check`;确认当前引擎(SQLite 默认 / Mongo) |
| 前端异常 | 浏览器 F12 Console/Network,联动后端日志定位 |

诊断信息必收:环境(OS / Node / Python / 运行方式)+ 版本标识(`VERSION` 全文或
commit 号)+ 复现步骤 + 预期/实际行为 + 完整报错(脱敏)+ 影响范围。

### 4.2 Issue 提交要点

- 仓库地址:`DEVELOPER_GUIDE.md` §6(发布后由维护者填写)
- 提交前自查:跑 `check` 排除环境问题;搜索既有 issue 避免重复
- 标题:`[bug] 模块: 一句话概述`;一个 issue 一个问题
- 必填模板:环境/版本、复现步骤、预期行为、实际行为、日志与诊断
- 脱敏约束:本机路径/用户名/IP 替换为 `<user>`/`<path>`;不贴完整 `.env`;
  上传图片/workflow 附件需知悉公开平台可被爬取复用的风险,建议自行脱敏
  (详见 `DEVELOPER_GUIDE.md` §5.6)
- 严重度:P0 阻断 / P1 高 / P2 中 / P3 低(定义见 `DEVELOPER_GUIDE.md` §5.4)
- 生成功能问题:注明已知实验性声明,优先附 ComfyUI 侧报错
