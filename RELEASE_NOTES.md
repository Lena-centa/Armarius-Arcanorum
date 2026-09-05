# Release Notes / 发版说明

## v0.1.0-beta.1 (Pre-release)

> **Armarius Arcanorum (ComfyUI Workflow Archive)**  
> 扫描 ComfyUI 生成图片，提取并整理内嵌工作流信息，提供本地检索、统计与标注。  
> Scan ComfyUI generation folders, extract embedded workflow metadata, and index them locally for search, statistics, and labeling.

---

### 本版本内容 (v0.1.0-beta.1)

- **图片检索与批次归纳**:
  - 扫描 ComfyUI 生成图片，提取模型、LoRA 及强度、正负分层 Prompt、采样器参数、种子、分辨率；
  - 同一次生成的图片归为一批，支持按配方聚合仅种子不同的多批次。
- **统计**:
  - 按日期/时段统计生成量，分析常用模型、LoRA 搭配频率与正向 Prompt 关联词。
  - 热力图部分计划在后续版本重做，当前版本不提供。
- **手工标注库**:
  - 为常用 LoRA 与 Prompt 组合添加分类备注与标签。
- **纯本地运行**:
  - 默认采用内置 SQLite 单引擎，无需额外安装 MongoDB；解压后即可启动。
- **多生态元数据兼容**:
  - 支持 ComfyUI 完整节点图解析，并兼容 NovelAI 与部分 WebUI 图片元数据的解析与统一检索。
- **Danbooru Tag 联想 (可选独立资产)**:
  - 依托离线 GNN 嵌入模型与 SQLite 词库，在检索和打标时提供 Tag 联想补全。

---

### 已知限制与声明

1. **“再次生成”为实验性功能**:
   - 基于历史工作流回填 ComfyUI 的生成功能处于早期实验性阶段，可能不稳定，建议作为探索性辅助；检索、统计、标注等查阅与整理能力相对成熟，推荐优先使用。
2. **部分第三方自定义节点降级展示**:
   - ComfyUI 社区插件众多，若遇到生态中极罕见的自定义包装节点，可能回退为部分解析或显示为未识别节点。
3. **隐私与纯本地存储**:
   - 系统所有解析、存储与检索均在本地运行，除非主动配置远程图片库，不会上传任何数据至云端。

---

### Artifact Matrix & Downloads / 发布包下载指南

| 产物文件名 (Artifact) | 平台 (Platform) | Danbooru 资产 | 说明 |
|---|---|:---:|---|
| **`Armarius_v0.1.0-beta.1-windows.zip`** | Windows 10/11 | 否 | 内置便携 Node/Python 环境，解压即用 |
| **`Armarius_v0.1.0-beta.1-windows-d.zip`** | Windows 10/11 | 是 (约 860MB) | 包含离线 Danbooru Tag 联想与 GNN 推荐 |
| **`Armarius_v0.1.0-beta.1-linux.tar.gz`** | Linux / WSL | 否 | 适合在 Linux / WSL 环境部署 |
| **`Armarius_v0.1.0-beta.1-slim-source.zip`** | 跨平台 | 否 | 纯源码包（供已有 Node 22 / Python 3.10+ 环境的开发者） |
| **`sha256sums.txt`** | - | - | 所有发布文件的 SHA-256 完整性校验清单 |

---

### Quick Start / 快速上手

#### Windows 10/11:
1. 下载 `Armarius_v0.1.0-beta.1-windows.zip` 并解压到纯英文路径文件夹；
2. 双击运行 `start.exe`（或在 PowerShell 中运行 `.\start.ps1`）；
3. 启动后浏览器访问 `http://127.0.0.1:8009`；
4. 进入「设置」页面，填入你的 ComfyUI 输出文件夹（例如 `D:\ComfyUI\output`），点击保存即可开始使用！

#### Linux / WSL:
```bash
tar -xzf Armarius_v0.1.0-beta.1-linux.tar.gz
cd Armarius_v0.1.0-beta.1
./start.sh start
```

---

### Distribution & License / 许可证与声明

- 本项目自主研发源码遵循 [MIT License](LICENSE)。
- 发行包中包含的第三方开源组件保留其原生许可，详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
- Danbooru 派生资产（带 `-d` 后缀的安装包）包含遵循 CC BY-SA 4.0 许可的衍生词库，详细声明与署名见 [`danbooru/ASSET_LICENSES.md`](danbooru/ASSET_LICENSES.md)。
