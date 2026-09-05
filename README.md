# Armarius Arcanorum


> 使用须知（叠甲）—— 以下为免责声明，请先阅读，如继续使用则视作认同当前免责声明：
>
> 1. 这个项目由个人工具更改方向而来，使用的解析器并不能够保证（实际上原理上就是不可能）可以精准解析所有所生成的图片
> 2. 目前主要集中在 t2i 方向，i2i 方向后续可能会开发
> 3. 解析功能在设计上是只读图片进行解析的，理论上不会造成图片损坏，但用户应当为自己的信息安全以及资料完整性负责；生成功能（高度实验性，不保证可用）是使用 ComfyUI 的 API 进行生成的，至于 A1111 以及 NovelAI 暂时不支持（短期也没有支持计划）
> 4. 在开发过程中大量使用了 AI 进行编码，因此大概率存在开发者自己没有察觉到的 bug
> 5. 工具在设计之初仅有的对外网访问就是拉取 npm 包（MongoDB 的远程访问目前也是在开发中的功能），我自己也没有心思去收集用户的个人信息，反正代码在这里可以进行审查
> 6. 数据安全一定要注意，记得勤加备份，数据库的结构可以在 doc 中进行查看

---

阅读上面前述注意事项后，以下是功能介绍。若想直接上手，跳到「快速开始」。

扫描你存放生成图片的文件夹，读取每张图内嵌的工作流信息，提取模型、LoRA、
Prompt、采样器、分辨率等参数，整理成带缩略图的检索库 —— 之后想找"某张图用了
什么 LoRA"或"哪些配方产出最多"，打开浏览器即可查询。

## 核心功能

- **图片检索库**:按关键词、文件名、模型、LoRA、日期快速过滤;同一次生成的多张
  图片自动归为一批，展开可看整批
- **参数详情**:每张图可查看它使用的模型、LoRA 及强度、正负 Prompt(按段落分层)、
  采样器参数、种子、分辨率，Prompt 一键复制
- **统计**:按日期/时段统计生成量，分析常用 LoRA 与 Prompt 组合
- **再次生成**(实验性):基于历史图片的完整工作流，修改参数后重新提交给
  ComfyUI 生成。该功能处于早期实验性阶段，可能不稳定，不建议作为正式流程依赖
- **标注库**:为 LoRA 与 Prompt 组合添加分类备注，方便日后检索
- **自动入库**:新增图片会自动进入档案库，无需手动导入

## 系统要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10/11、Linux 或 WSL |
| Node.js | 22 LTS 或更新版本(24/25/26 亦可) |
| Python | 3.10 或更新版本 |
| 数据库 | 不需要 —— 内置 SQLite，开箱即用 |
| 其他 | 无需 MongoDB、无需 C++ 编译工具 |

## 快速开始

**方式一:一键部署(推荐，适用于空白机器)**

```bash
# Linux / WSL
./deploy.sh --repo https://github.com/Lena-centa/Armarius-Arcanorum

# Windows(免管理员)
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -RepoUrl https://github.com/Lena-centa/Armarius-Arcanorum
```

脚本会自动检查并补齐依赖、下载代码、初始化环境，然后启动服务。

**方式二:手动初始化**

```bash
# 1. 初始化环境(创建 Python 虚拟环境、安装 Node 依赖、生成配置文件)
./start.sh setup                 # Linux / WSL
.\start.ps1 setup                # Windows

# 2. 启动
./start.sh start                 # Linux / WSL
.\start.ps1 start                # Windows
```

setup 已并入 start 单一入口:不带参数直接运行(或双击 start.exe)
即等价于"检查 → 缺失项自动初始化 → 启动"一条流水线。

配置统一存放在**用户数据目录**(Windows `%LOCALAPPDATA%\armarius_arcanorum`、
Linux `~/.local/share/armarius_arcanorum`，旧目录 `workflow_db` 自动平滑继承；可用进程环境变量 `ARMARIUS_DATA_DIR` / `WORKFLOW_DATA_DIR`
覆盖，注意不能写进 .env 本身)。首次启动自动从 `.env.example` 模板生成;
若同一工作区同时被 Windows 与 WSL 使用，路径配置分别放在数据目录内的
`.env.windows` 与 `.env.wsl`(模板为 `.env.windows.example`、`.env.wsl.example`)。
对应启动脚本会优先加载平台覆盖文件;已有进程环境变量优先级最高。
旧版本仓库根的 `.env` 会在首次启动时自动迁移到数据目录。

> **注**：扫描目录可以自行更改，但建议**不要手动修改 `.env`** 文件的目录——该文件只有几十 K，项目后续可能有更新，届时再手动挪动会比较麻烦。

**双平台 Node 依赖**:`nest_gateway/node_modules` 是平台激活链接(`node_modules.win` /
`node_modules.linux` 平台目录各持完整安装),`npm install / ci` 会被
`preinstall`/`postinstall` 挂钩自动纳入方案(自愈改链、ABI 探测)，切换平台
启动时自动改链、无需重装。Node 版本必须为 22-26(详见 `GUIDE.md` §2.3)。

启动后打开浏览器访问 **http://127.0.0.1:8009** 即可开始使用。

## 首次使用

1. 打开浏览器进入 **设置页面**(`http://127.0.0.1:8009/settings`)
2. 在「扫描根目录」填入存放 ComfyUI 生成图片的文件夹(如 `D:\ComfyUI\output`)
3. 保存后重启服务，系统会自动扫描并建立档案库
4. 若配置了 ComfyUI(默认地址 `http://127.0.0.1:8188`)，还可以在生成页面
   直接基于历史工作流再次生成

## 常见问题

**需要安装 MongoDB 吗?**
不需要。系统内置 SQLite，开箱即用。MongoDB 仅在需要多台设备共享同一档案库时
才作为可选项配置。

**图片会上传到别处吗?**
不会。所有数据都保存在本机，系统只读取你指定的扫描目录。
只有当管理员主动配置共享 MongoDB/远端图片库时，才会访问对应服务。

**可以只使用远端图片库，本机不保存图片吗?**
可以。MongoDB 中的 image entry 可按 `wfdb-image-library-v1` 契约引用
独立 HTTP 图片库，不要求本地 `resolved_path`。构建协议、JSON Schema
和完整示例见 [`docs/remote_image_library.md`](docs/remote_image_library.md)。

> **注**：该功能当前仍在开发中、不够稳定，但文档中有可参考的设计规范。

**修改扫描目录后旧数据会丢失吗?**
不会。新增目录的图片会增量入库，原有档案保持不变。

> **注**：多目录支持仍在早期计划中，实际以当前版本为准。

**为什么有些图没有显示?**
只有带有完整 ComfyUI 工作流信息的图片才会被收录;手机截图、普通照片等不在此列。

**生成功能稳定吗?**
不。生成功能目前处于极其初步的试验阶段，可能高度不稳定且存在较多缺陷;
检索、统计、标注等查阅与整理能力相对成熟，推荐优先使用。

## 更多文档

面向部署 / 运维的部署与架构速览:[`GUIDE.md`](GUIDE.md)。
面向开发者的问题定位与 Issue 提交规范:[`DEVELOPER_GUIDE.md`](DEVELOPER_GUIDE.md)。
源码仓库内的数据契约与规范见 `docs/`(契约/解析规范随发布包)。

## 许可证与分发

本项目自有源码采用 [MIT License](LICENSE)。发行包必须保留 `LICENSE` 和
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。第三方库、数据集、模型及其
派生资产仍受各自许可证约束，不会因为随 MIT 项目打包而自动改为 MIT。

标准 Release 默认不包含 `danbooru/` 下的数据库与嵌入资产。如需发布完整包，必须显式运行 `./release.sh --with-danbooru`，并先核对
[`danbooru/ASSET_LICENSES.md`](danbooru/ASSET_LICENSES.md) 的来源、哈希、署名与
CC BY-SA 要求。详细发布检查项见 [`RELEASE_NOTES.md`](RELEASE_NOTES.md)。
