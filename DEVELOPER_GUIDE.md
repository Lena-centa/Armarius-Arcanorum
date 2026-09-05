# DEVELOPER_GUIDE — 开发者文档:问题定位与 Issue 提交

> 面向开发 / 贡献者:本文说明如何定位系统问题(bug)、如何提交 issue 以及
> 提交规范。读者建议先读 [`GUIDE.md`](GUIDE.md)(部署 + 架构)。
>
> 仓库地址:此处待维护者填写(git 链接暂留空,见 §6)。

## 1. 问题分层与定位入口

| 问题层 | 定位入口 | 排查要点 |
|---|---|---|
| 环境 / 启动 | `start.sh check` + 启动日志 | 依赖版本、端口、配置 |
| 网关 / API | `/api/health` + 状态端点 + 网关日志 | 响应码、错误详情 |
| 解析 / 入库 | 单图复现 + 回归工具 | 元数据、节点覆盖 |
| 生成 | generate_worker 日志 + ComfyUI 可达性 | 实验性功能,已知不稳定 |
| 数据引擎 | 库健康检查 + 引擎配置 | SQLite / Mongo 归属 |
| 前端 | 浏览器 DevTools | 静态资源 + 后端联动日志 |

## 2. 各层定位方法

### 2.1 环境与启动问题

```bash
./start.sh check           # 必须依赖缺失即失败,可选依赖仅警告
node --version                    # 需 ≥ 22
python3 --version                 # 需 ≥ 3.10
# 包内看 VERSION;源码仓库看 git log / git rev-parse HEAD
```

- 启动失败:前台运行观察 stderr 报错;检查 8009 端口占用;大图库首轮同步
  内存需求高(启动脚本已默认 8GB 堆上限)
- 配置问题:确认数据目录 `.env` 存在(缺失时网关首启从 `.env.example`
  自动生成;旧仓库根 `.env` 会自动迁入),扫描目录存在

### 2.2 API / 网关问题

```bash
curl http://127.0.0.1:8009/api/health        # 健康检查
curl http://127.0.0.1:8009/api/sync-status   # 同步/缓冲/轮询状态
curl http://127.0.0.1:8009/api/backup/status # 备份状态
```

- 4xx 响应通常带 `message`/`error` 详情;5xx 结合网关日志(worker 崩溃、
  超时重启等)
- 列表/详情类端点异常先区分"查询逻辑"与"数据本身"(见 2.3)

### 2.3 解析问题(图片未入库 / 字段缺失)

1. 确认图片确实是 ComfyUI 产出且带内嵌 `prompt` / `workflow` 元数据
   (PNG tEXt / WebP EXIF 区块)
2. 单图复现:直接调解析器看输出与异常:

```bash
venv/bin/python - <<'PY'
from pathlib import Path
from workflow_db.parser import parse_image
r = parse_image(Path("目标图片.png"), scan_root=None)
print(r)
PY
```

3. 字段契约:对照 `docs/contracts/record.schema.json`(发布契约,字段结构以它为准)
4. 常见原因:
   - 新节点类型未覆盖(扩展清单见源码仓库 `docs/parser/KNOWN_GAPS.md`)
   - 图片无内嵌元数据(截图/普通照片不会收录)
   - `COMFY_SCAN_ROOT` 未配置或路径在目标平台不可识别
   - `sha256` 为路径哈希:文件移动后定位键变化属预期

### 2.4 生成问题(实验性功能)

> [警告] 生成链路处于极其初步阶段,可能高度不稳定且存在大量缺陷,见
> `GUIDE.md` 状态声明。定位时:

```bash
curl http://127.0.0.1:8188/system_stats        # ComfyUI 是否可达
# 检查网关日志中 generate_worker 会话输出(JSON-RPC 交互)
```

- 失败分类:ComfyUI 连接失败 / workflow 校验失败 / 提交失败 / 归档失败
- 生成页图片直连 `127.0.0.1:8188`(前端硬编码,远程部署会失效——已知限制)

### 2.5 数据引擎问题

- SQLite:`check` 自检含 `PRAGMA quick_check`;库文件在用户数据目录
  `gray_workflow.sqlite3`(WAL,首启自动建库;旧仓库 `data/` 库会自动迁移,
  原文件改名 `*.migrated` 保留)
- 引擎归属:确认当前是 SQLite 单引擎(`MONGODB_URI` 留空 / `SQLITE_READ=1`)
  还是 MongoDB;切换只在设置页"检测连接并切换"通过后生效
- 数据异常(数量/统计不对):先同步一次(`POST /api/sync-now`)区分
  "未入库"与"查询错误"

### 2.6 前端问题

- 浏览器 F12 → Console / Network:记录失败的请求 URL 与响应状态码
- 前端是静态资源,绝大多数异常根源在后端,定位结论需联动后端日志

## 3. 诊断信息收集清单(提交 issue 前必填)

1. **环境**:操作系统 / 运行方式(Windows 原生 | Linux | WSL)/ Node 版本 /
   Python 版本
2. **版本标识**:包内 `VERSION` 文件全文,或源码仓库 commit 号
3. **复现步骤**:最小化、可执行的步骤序列
4. **预期行为** 与 **实际行为**
5. **日志 / 报错**:完整报错文本,注意脱敏(见 §5.3)
6. **样例文件**:解析类问题尽量附带目标图片或 workflow JSON
7. **影响范围**:单张图 / 批量;只读功能 / 生成功能

## 4. Issue 提交流程

1. 确认仓库地址(待填写,见 §6)
2. **自查**:先跑 `check` 排除环境问题;搜索既有 issue 与文档
   (`GUIDE.md`、`README.md`)避免重复提交
3. 创建 issue,按 §5 规范填写
4. 提交后维护者会打标签并评估严重度;如需补充信息在原 issue 下追加

## 5. Issue 提交规范

### 5.1 标题格式

```text
[bug] 模块: 一句话概述
[feature] 模块: 需求概述
[question] 模块: 使用疑问
```

示例:`[bug] parse: 含 ConditioningSetPropertiesAndCombine 的工作流正负 Prompt 缺失`

### 5.2 模板(必填项)

- 环境 / 版本
- 复现步骤
- 预期行为
- 实际行为
- 日志与诊断(§3 清单)
- 备注(可选)

### 5.3 约束

- **一个 issue 只报一个问题**(按模块 + 现象维度拆分),不混报
- **日志必须脱敏**:本机路径、用户名、IP 一律替换为 `<user>` / `<path>`
- **不贴完整 `.env`**(尤其 MONGODB_URI、token 等凭据)
- 生成功能问题:请注明"已知实验性声明",并优先附 ComfyUI 侧报错
- 解析缺失问题:尽量附样例图片或 workflow JSON,便于本地复现
- 语言中英文均可,信息完整性优先于格式

### 5.4 严重度定义

| 级别 | 定义 | 示例 |
|---|---|---|
| P0 | 阻断:服务无法启动 / 核心只读功能完全不可用 | check 失败、首页 500 |
| P1 | 高:主要功能异常,但有替代路径 | 列表筛选错误、统计缺失 |
| P2 | 中:边缘场景缺陷 / 体验问题 | 特定工作流解析缺失、文案错误 |
| P3 | 低:建议 / 优化 | 性能优化、格式改进 |

### 5.5 提交后

- 补充信息在原 issue 下追加,不另开新 issue
- 修复会以 commit 引用形式回复;可在对应版本验证

### 5.6 附件上传风险提示(重要)

> [警告] 提交 issue 如需上传图片(样例图、截图)或 workflow JSON 等附件,**必须先知悉**:
> 公开的 git 平台(如 GitHub)内容可被搜索引擎爬取、被第三方抓取与复用。上传后的
> prompt 文本、模型 / LoRA 组合、参数与工作流结构都可能被他人直接取用,包括用于
> 商业用途,且**难以撤回**(即使后续删除,缓存与转发副本仍可能存续)。

**建议自行脱敏后再上传**,例如:

- **图片**:裁剪 / 模糊敏感区域,去除 EXIF 等元数据;避免上传含个人内容或未脱敏
  的原始出图;可以用"仅裁剪局部 + 文字描述"代替整图
- **workflow JSON**:删除个人标识性字段与敏感 prompt 文本;模型 / LoRA 名称
  按需保留或替换为占位符;本地路径、用户名、文件名一律替换为 `<user>` / `<path>`
- **不确定时**:宁可不上传,用可复现的文字步骤代替;脱敏后自检一遍再提交
- **工具辅助**:可用仓库自带的 [`tools/sanitize_workflow.py`](tools/sanitize_workflow.py) 自动化上述
  workflow JSON / PNG 元数据脱敏 —— 先 `--scan` 列出疑似敏感字段,再按字段 + 正则统一替换;
  PNG 仅改写元数据块(图像数据字节不变)。用法见该文件 docstring。

## 6. 仓库地址

- 源码仓库:https://github.com/Lena-centa/Armarius-Arcanorum
- Issue 提交地址:https://github.com/Lena-centa/Armarius-Arcanorum/issues
- 安全漏洞请勿公开提交 Issue,按 [`SECURITY.md`](SECURITY.md) 使用私密报告渠道
- 源码契约与设计文档:随发布包不分发,以源码仓库 `docs/` 为准
