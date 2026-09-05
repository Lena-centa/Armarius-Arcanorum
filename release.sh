#!/usr/bin/env bash
# ============================================================================
# 发布打包(去除开发环境痕迹与文档,保留提交版本标识)
#
# 产出:基于 git archive HEAD 的可复现 zip,剔除全部开发相关内容后,
#       写入 VERSION 标识文件 + manifest.json(文件 sha256 清单),
#       供发布物溯源与增量更新比对。
#
# 版本唯一识别串 BUILD_ID:<TAG>-b<提交数>-<短SHA>[-<平台>][-d][-pdeg]
#   <TAG>     人工语义版本(可省略);缺省回落短 SHA
#   b<提交数> git 提交数(单调递增),版本新旧排序依据
#   <短SHA>   提交哈希,唯一性
#   -<平台>   自动取自 runtime/RUNTIME.json(或 RUNTIME_PLATFORM 变量)
#   -d        WITH_DANBOORU=1 时后缀,区分同提交两种产物
#   -pdeg     显式允许 parser 回归失败的降级预发布包;不得标为稳定版
#   产物文件名 = <项目名>_<BUILD_ID>.zip,例:dev_1.2.0-b42-b578b3f-windows.zip
#
# 用法:
#   ./release.sh [版本标识]            # [版本标识]=语义版本段,默认 git describe --tags --always
#   OUT_DIR=/path ./release.sh v1.0    # 指定输出目录(默认:仓库父目录)
#   RUNTIME_PLATFORM=linux ./release.sh # runtime 平台校验(默认自动读 runtime/RUNTIME.json;
#                                       # 无 runtime 目录则跳过;Windows/Linux runtime 不互通,
#                                       # 分别用 tools/windows|linux/build_runtime.* 构建)
#   ./release.sh --with-danbooru      # 显式包含 GNN/SQLite 查表资产(约 860MB);
#                                      # 资产需先用 utils/build_danbooru_db.py 构建,
#                                      # 并遵守 danbooru/ASSET_LICENSES.md 的分发要求
#   ./release.sh --allow-parser-degraded v0.1.0-beta.1
#                                    # parser 回归失败时仍构建带 -pdeg 标记的预发布包
#
# 保留(运行时必需):
#   README.md(大众向)/ 快速上手.txt(大众向教程)/ GUIDE.md(部署与架构速览)
#   / DEVELOPER_GUIDE.md(开发者) / .env.example / requirements.txt / __init__.py
#   setup.* / start.* / deploy.*
#   nest_gateway/(package*.json、tsconfig*、nest-cli.json、eslint 配置、
#                 dist 预构建(已取消 git 跟踪,从工作树复制)、
#                 scripts/ 平台隔离挂钩)
#   workflow_db/(运行时 Python 包 + 静态前端)
#
# 剔除(开发相关内容,详见 EXCLUDES):
#   全部 docs/、AGENTS.md、API_DESIGN.md、开发日志/规划、benchmarks/、tools/、
#   tests/、workflow_automatic/、comfy_generator/、err_log/(调试探针归档)、
#   .vscode/、__pycache__/ 等
# ============================================================================
set -euo pipefail
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

# Python 解释器解析:回归门禁/自检的执行器,仅需 stdlib。
# 优先包内 runtime venv(与 deploy 的解析优先级一致),回退系统 python3;
# Git Bash(MSYS)下 WindowsApps 的 python3 是 Microsoft Store stub,
# 调用会打印 "Python was not found" 且 rc=1,导致门禁误报 FAIL。
PY_CMD="${PY_CMD:-}"
if [[ -z "${PY_CMD}" ]]; then
  for cand in "runtime/venv/Scripts/python.exe" "runtime/venv/bin/python"; do
    if [[ -x "${ROOT}/${cand}" ]]; then
      PY_CMD="${ROOT}/${cand}"
      break
    fi
  done
fi
PY_CMD="${PY_CMD:-python3}"

# ---------------------------------------------------------------------------
# 版本标识
# ---------------------------------------------------------------------------
# GNN/SQLite 查表资产含独立数据许可,默认不进包;发布者确认来源与署名后显式开启。
WITH_DANBOORU="${WITH_DANBOORU:-0}"
ALLOW_PARSER_DEGRADED="${ALLOW_PARSER_DEGRADED:-0}"
POSITIONAL=()
for arg in "$@"; do
  case "${arg}" in
    --with-danbooru) WITH_DANBOORU=1 ;;
    --allow-parser-degraded) ALLOW_PARSER_DEGRADED=1 ;;
    *) POSITIONAL+=("${arg}") ;;
  esac
done
TAG="${POSITIONAL[0]:-$(git describe --tags --always 2>/dev/null || git rev-parse --short HEAD)}"
SHORT_SHA="$(git rev-parse --short HEAD)"
FULL_SHA="$(git rev-parse HEAD)"
BUILD_DATE="$(date -Iseconds)"
# 构建序号:git 提交数,单调递增,作版本新旧排序依据(见头部 BUILD_ID 说明)
BUILD_SEQ="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
PROJECT="$(basename "${ROOT}")"
OUT_DIR="${OUT_DIR:-$(dirname "${ROOT}")}"

# runtime 平台校验:Windows/Linux runtime 互不兼容(node/python/venv/node_modules
# 均平台绑定,尤其 better-sqlite3 预编译 ABI),打包必须与 RUNTIME.json 匹配
#
# 平台读取用纯文本解析而非 python3:Git Bash(MSYS)下 Windows python 打不开
# MSYS 路径(/c/...),曾导致 RUNTIME_PLATFORM 读空 → .platform 标记漏写,
# 部署端 npm 平台隔离视发布包为"旧布局",报 ABI/架构错配。
read_runtime_platform() {
  local f="${1}"
  [[ -f "${f}" ]] || return 1
  grep -oE '"platform"[[:space:]]*:[[:space:]]*"[^"]*"' "${f}" \
    | head -1 | sed -E 's/.*"([^"]*)"$/\1/'
}
RUNTIME_PLATFORM="${RUNTIME_PLATFORM:-}"
if [[ -z "${RUNTIME_PLATFORM}" && -f "${ROOT}/runtime/RUNTIME.json" ]]; then
  RUNTIME_PLATFORM="$(read_runtime_platform "${ROOT}/runtime/RUNTIME.json")"
fi
if [[ -n "${RUNTIME_PLATFORM}" ]]; then
  echo "  runtime 平台: ${RUNTIME_PLATFORM}"
fi

# 版本唯一识别串:<TAG>-b<提交数>-<短SHA>[-<平台>][-d];平台自动后缀,
# TAG 缺省回落短 SHA 时省略该段避免重复(构成说明见头部)
BUILD_ID="${TAG}-b${BUILD_SEQ}-${SHORT_SHA}"
if [[ "${TAG}" == "${SHORT_SHA}" ]]; then
  BUILD_ID="b${BUILD_SEQ}-${SHORT_SHA}"
fi
if [[ -n "${RUNTIME_PLATFORM}" && "${RUNTIME_PLATFORM}" != "none" ]]; then
  BUILD_ID="${BUILD_ID}-${RUNTIME_PLATFORM}"
fi
if [[ "${WITH_DANBOORU}" == "1" ]]; then
  echo "  WARN: 将包含独立许可的 Danbooru 派生资产;请核对 danbooru/ASSET_LICENSES.md" >&2
  BUILD_ID="${BUILD_ID}-d"
fi
OUT="${OUT_DIR}/${PROJECT}_${BUILD_ID}.zip"

# ---------------------------------------------------------------------------
# 剔除清单:开发环境痕迹 / 开发文档 / 开发工具
# ---------------------------------------------------------------------------
EXCLUDES=(
  AGENTS.md
  API_DESIGN.md
  IMPLEMENTATION_LOG.md
  MIGRATION_CHANGELOG.md
  oc_prompting.md
  opencode.json
  todo.md
  UI_UPDATE_GUIDE.md
  release.sh
  test
  package.json
  package-lock.json
  docs/
  benchmarks/
  tools/
  tests/
  workflow_automatic/
  comfy_generator/
  err_log/
  .github/
  .superpowers/
  .vscode/
  .opencode/
  __pycache__/
  nest_gateway/src/
  nest_gateway/test/
  # npm 平台隔离挂钩(ensure-platform.mjs)必须保留;其余为开发工具
  nest_gateway/scripts/collect_fixtures.py
  nest_gateway/scripts/dedupe_batch_images.py
  nest_gateway/scripts/rebuild_recipe_groups_full.cjs
  nest_gateway/scripts/sampler_centric_probe.py
  nest_gateway/scripts/sampler_centric_probe_v2.py
)

if [[ -n "$(git status --porcelain)" ]]; then
  echo "WARN: 工作树有未提交改动,git 内容以 HEAD 为准(dist 等未跟踪产物从工作树复制)" >&2
fi
# 自动构建 dist:确保 node_modules 存在,然后执行 nest build(deleteOutDir 重建整个 dist)
if [[ ! -d "nest_gateway/node_modules" ]]; then
  echo "FAIL: nest_gateway/node_modules 不存在 — 先执行 'cd nest_gateway && npm install'" >&2
  exit 1
fi
echo "  BUILD: nest_gateway 自动构建 dist..."
(cd nest_gateway && npm run build) || {
  echo "FAIL: nest build 失败,中止打包" >&2
  exit 1
}
echo "  OK: dist 构建完成"

# ---------------------------------------------------------------------------
# 回归门禁:parser 冻结核心 fixtures 回归全绿才允许打包(见 AGENTS.md 修改门槛),
# 失败即中止(parser_regression 输出差异详情)。npm test 全量较慢,发布前按需
# 手动执行(cd nest_gateway && npm test),不内置门禁。
# ---------------------------------------------------------------------------
if [[ -f "tools/parser_regression.py" ]]; then
  echo "  回归门禁: parser fixtures 回归全绿校验..."
  if PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "${PY_CMD}" tools/parser_regression.py \
      --fixtures-dir nest_gateway/test/__fixtures__/records; then
    PARSER_REGRESSION_STATUS=pass
    echo "  OK: parser fixtures 回归全绿"
  elif [[ "${ALLOW_PARSER_DEGRADED}" == "1" ]]; then
    PARSER_REGRESSION_STATUS=degraded
    echo "  WARN: parser 回归失败;按显式授权继续构建降级预发布包" >&2
  else
    echo "FAIL: parser fixtures 回归未通过,中止打包(修复后重试;仅预发布可显式 --allow-parser-degraded)" >&2
    exit 1
  fi
else
  if [[ "${ALLOW_PARSER_DEGRADED}" == "1" ]]; then
    PARSER_REGRESSION_STATUS=degraded
    echo "  WARN: parser 回归脚本缺失;按显式授权继续构建降级预发布包" >&2
  else
    echo "FAIL: tools/parser_regression.py 缺失,无法执行 parser 发布门禁" >&2
    exit 1
  fi
fi
if [[ "${PARSER_REGRESSION_STATUS}" == "degraded" ]]; then
  if [[ "${TAG}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "FAIL: parser 降级包不能使用稳定 SemVer 标签 ${TAG};请改用 beta/rc/pre 标签" >&2
    exit 1
  fi
  BUILD_ID="${BUILD_ID}-pdeg"
  OUT="${OUT_DIR}/${PROJECT}_${BUILD_ID}.zip"
fi

# ---------------------------------------------------------------------------
# 大目录快照缓存:runtime/danbooru 等体积大、打包时全量 tar 复制的目录,
# 源未变化时用硬链接复用上次快照,省去每发几十秒~分钟级的 1GB+ 复制 I/O。
#
# 实现:指纹(文件数+总字节+relpath|size|mtime 排序级联哈希)比对 + cp -al 硬链接。
# - 指纹用 bash + find/sort/sha256sum(纯 GNU 工具),不依赖 Windows python:
#   Git Bash(MSYS)下 Windows python 打不开 MSYS 路径(/c/...),与
#   read_runtime_platform 用 grep 而非 python3 同理。仅读元数据不读内容,
#   对几万文件亚秒级。
# - cp -al 硬链接复用 inode,符号链接原样保留,不触发 node_modules/.bin
#   原生符号链接的 ENOENT(那是 cp -a 重建目标才会出的问题,已实测安全)。
# - 对 TMP 内硬链接文件的后续修改(sed -i 净化、find -delete 清理)均为
#   copy-on-write 或解链接,不回写污染 cache 快照。
# - 硬链接要求源/目标同文件系统:本脚本的 TMP 与 cache 均置于
#   ${ROOT}/.release_staging/ 下(同盘),故 cp -al 可行;切勿把 TMP 放
#   mktemp 的 /tmp(与工作区跨盘会 Invalid cross-device link)。
# - cache 存 ${ROOT}/.release_staging/(已 gitignore),不随 TMP 的 trap 删除。
# - 删除 ${ROOT}/.release_staging 即可强制全量重建缓存。
STAGING_CACHE="${ROOT}/.release_staging"

# dir_fingerprint <src_dir> [path...]  → 输出 "文件数<TAB>总字节<TAB>树哈希"
#   path 列表为空 = 递归统计整个目录;非空 = 仅统计列出的顶层文件(如 danbooru
#   主库四件套,排除 -shm/-wal 瞬态文件)。文件名假定不含 '|'。
dir_fingerprint() {
  local src="$1"; shift
  local paths=("$@")
  local listing=""
  if [[ ${#paths[@]} -eq 0 ]]; then
    listing="$(cd "${src}" && find . -type f -printf '%P|%s|%T@\n' 2>/dev/null | sort)"
  else
    local cond=() p
    for p in "${paths[@]}"; do
      cond+=( -name "${p}" -o )
    done
    # 去掉末尾 -o
    cond=("${cond[@]:0:${#cond[@]}-1}")
    listing="$(cd "${src}" && find . -maxdepth 1 -type f \( "${cond[@]}" \) \
      -printf '%P|%s|%T@\n' 2>/dev/null | sort)"
  fi
  local n total hash
  n="$(printf '%s\n' "${listing}" | grep -c . || true)"
  total="$(printf '%s\n' "${listing}" | awk -F'|' '{s+=$2} END{print s+0}')"
  hash="$(printf '%s' "${listing}" | sha256sum | cut -d' ' -f1)"
  printf '%s\t%s\t%s\n' "${n:-0}" "${total:-0}" "${hash}"
}

# stage_cached <name> <src_dir> <dst_tmp_dir> [path...]
#   把 src_dir(或其内 path 列表)复制到 dst_tmp_dir;源指纹与缓存一致时
#   改用硬链接复用,否则 tar 复制并更新缓存快照与指纹。
stage_cached() {
  local name="$1" src="$2" dst="$3"; shift 3
  local paths=("$@")
  local sig prev cache_dir sigfile
  # 空 paths 不能传 "${paths[@]:-}":空数组会被展开成单个空串参数,误触发
  # 文件列表分支导致指纹恒为空。显式分支。
  if [[ ${#paths[@]} -eq 0 ]]; then
    sig="$(dir_fingerprint "${src}" 2>/dev/null || true)"
  else
    sig="$(dir_fingerprint "${src}" "${paths[@]}" 2>/dev/null || true)"
  fi
  cache_dir="${STAGING_CACHE}/tree/${name}"
  sigfile="${STAGING_CACHE}/sig/${name}"
  prev=""
  if [[ -f "${sigfile}" ]]; then
    prev="$(cat "${sigfile}" 2>/dev/null || true)"
  fi
  mkdir -p "$(dirname "${dst}")"
  if [[ -n "${sig}" && "${prev}" == "${sig}" && -d "${cache_dir}" ]]; then
    # 清除 git archive 预置的陈旧目标(如已跟踪的 danbooru/ASSET_LICENSES.md):
    # cp -al 硬链接遇已存在目标会 EEXIST 中止(set -e),rm -rf 后重链等价于
    # 用缓存快照整目录覆盖(runtime 未跟踪时目标不存在,rm -rf 为无操作)。
    rm -rf "${dst}"
    mkdir -p "${dst}"
    cp -al "${cache_dir}/." "${dst}/"
    echo "  复用缓存 ${name}/: $(du -sh "${src}" | cut -f1),硬链接命中(源未变化)"
    return 0
  fi
  # 未命中:全量 tar 复制
  mkdir -p "${dst}"
  if [[ ${#paths[@]} -eq 0 ]]; then
    tar -C "${src}" -cf - . | tar -C "${dst}" -xpf -
  else
    tar -C "${src}" -cf - "${paths[@]}" | tar -C "${dst}" -xpf -
  fi
  echo "  已复制 ${name}/: $(du -sh "${src}" | cut -f1)(源已变化,更新快照)"
  # 更新缓存快照(硬链接自 dst)与指纹
  if [[ -n "${sig}" ]]; then
    rm -rf "${cache_dir}"
    mkdir -p "$(dirname "${cache_dir}")"
    cp -al "${dst}" "${cache_dir}"
    mkdir -p "$(dirname "${sigfile}")"
    printf '%s' "${sig}" > "${sigfile}"
  fi
}

# ---------------------------------------------------------------------------
# 组装临时目录
# ---------------------------------------------------------------------------
# TMP 与 cache 同置 .release_staging/ 下(同盘),保证大目录快照的 cp -al
# 硬链接可行;每进程独立子目录(干净无残留),trap 时清理。
TMP="${STAGING_CACHE}/tmp.$$"
mkdir -p "${TMP}"
trap 'rm -rf "${TMP}"' EXIT
git archive --format=tar HEAD | tar -x -C "${TMP}"

# 已验证环境运行时(runtime/ 由 tools/windows|linux/build_runtime.* 构建,
# 被 gitignore 不随 archive 进入,需从工作树显式复制;
# RUNTIME_PLATFORM 与 RUNTIME.json 不符时拒绝打包,避免混入异平台二进制)。
# 复制用 tar 管道而非 cp -a:Windows MSYS 的 cp 重建 node_modules/.bin 的
# 原生符号链接时会 ENOENT 中止;tar 两侧都可靠——MSYS tar 会把 .bin 符号
# 链接解引用为普通文件,功能等价(npm shim 是相对 require 的 JS 脚本,运行时
# 不执行 .bin),Linux 下 GNU tar 保持符号链接不变。
if [[ -d "${ROOT}/runtime" ]]; then
  if [[ -n "${RUNTIME_PLATFORM}" && -f "${ROOT}/runtime/RUNTIME.json" ]]; then
    PKG_PLATFORM="$(read_runtime_platform "${ROOT}/runtime/RUNTIME.json")"
    if [[ -n "${PKG_PLATFORM}" && "${PKG_PLATFORM}" != "${RUNTIME_PLATFORM}" ]]; then
      echo "FAIL: runtime 平台不匹配 — RUNTIME.json=${PKG_PLATFORM},要求 ${RUNTIME_PLATFORM}(需先用对应平台构建器重建 runtime)" >&2
      exit 1
    fi
  fi
  # 大目录快照缓存:源未变化时硬链接复用上次快照(省 400MB+ 复制)。
  # 复制/复用本身仍经 tar 管道(MSYS cp -a 对 node_modules/.bin 原生符号
  # 链接会 ENOENT;cp -al 硬链接复用则安全,见 stage_cached 注释)。
  stage_cached runtime "${ROOT}/runtime" "${TMP}/runtime"
fi

# 可选组件:GNN/SQLite 查表资产(danbooru/ 由 utils/build_danbooru_db.py 构建,
# 被 gitignore 不随 archive 进入,需从工作树显式复制;WITH_DANBOORU=1 或
# --with-danbooru 时进包,默认不含)。发布包布局 <包根>/danbooru/ 与 worker/
# 网关的默认探测路径一致,部署零配置即启用联想/查表/补全参考。
# 仅复制主库文件,排除 -shm/-wal 瞬态文件(部署端打开时自动重建);
# wal 非空说明构建机有未 checkpoint 写入,警告但不阻断。
if [[ "${WITH_DANBOORU}" == "1" ]]; then
  DANB_DIR="${ROOT}/danbooru"
  for need in ASSET_LICENSES.md danbooru.sqlite3 vocab_sorted.npy embed_gnn.npy; do
    if [[ ! -f "${DANB_DIR}/${need}" ]]; then
      echo "FAIL: ${DANB_DIR}/${need} 缺失 — 先执行 'utils/build_danbooru_db.py' 构建资产" >&2
      exit 1
    fi
  done
  if [[ -s "${DANB_DIR}/danbooru.sqlite3-wal" ]]; then
    echo "  WARN: danbooru.sqlite3-wal 非空(有未 checkpoint 写入),建议执行 checkpoint 后再打包" >&2
  fi
  # 大目录快照缓存:仅 4 个主库/嵌入资产,排除 -shm/-wal 瞬态文件;
  # 源未变化时硬链接复用上次快照(省 800MB 复制)。
  stage_cached danbooru "${DANB_DIR}" "${TMP}/danbooru" \
    ASSET_LICENSES.md danbooru.sqlite3 vocab_sorted.npy embed_gnn.npy
  echo "  可选组件 danbooru/: 查表库+GNN 嵌入(缓存/复制)"
fi

for item in "${EXCLUDES[@]}"; do
  rm -rf "${TMP}/${item}"
done

# 这些生成资产可能仍存在于历史提交中;gitignore 不影响 git archive。
# 默认包必须主动剔除,只有上方显式 WITH_DANBOORU=1 时才保留复制件。
rm -f "${TMP}/danbooru/character_features_debug.tsv"
if [[ "${WITH_DANBOORU}" != "1" ]]; then
  rm -f "${TMP}/danbooru/danbooru.sqlite3" \
        "${TMP}/danbooru/vocab_sorted.npy" \
        "${TMP}/danbooru/embed_gnn.npy"
fi

# nest_gateway/dist/ 已取消 git 跟踪并加入 .gitignore(构建产物不同步,
# 由 npm run build 现场生成),git archive 不含未跟踪文件,需从工作树显式
# 复制;发布包已剔除 src/,dist 是包内唯一运行形态,缺失/滞后由上方门禁
# (存在性 + 新鲜度)拦截。复制用 tar 管道(与 runtime/danbooru 同模式)。
mkdir -p "${TMP}/nest_gateway/dist"
tar -C "${ROOT}/nest_gateway/dist" -cf - . | tar -C "${TMP}/nest_gateway/dist" -xpf -
echo "  dist 预构建: $(du -sh "${ROOT}/nest_gateway/dist" | cut -f1)(未跟踪,已从工作树复制)"

# Windows 平台:现场编译双击启动器(零基础用户免 PowerShell 交互;
# deploy.exe = 一键部署, start.exe = 双击启动,参数透传)。
# 编译用本机 PowerShell Add-Type(Windows 自带 .NET Framework,离线),
# 生成脚本在 tools/(已被剔除不进包);非 Windows 或编译失败仅警告,
# 启动器为体验增强非必需,可直接用 .ps1 部署
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* ]] \
   && command -v powershell >/dev/null 2>&1 \
   && [[ -f "${ROOT}/tools/windows/build_launcher.ps1" ]]; then
  if powershell -NoProfile -ExecutionPolicy Bypass -File \
       "${ROOT}/tools/windows/build_launcher.ps1" -OutDir "${TMP}" >/dev/null 2>&1; then
    echo "  OK: 已编译双击启动器 deploy.exe / start.exe"
  else
    echo "  WARN: 启动器编译失败,发布包不含 exe(可直接用 .ps1 部署)" >&2
  fi
fi

# 已验证环境运行时(runtime/,由 tools/windows|linux/build_runtime.* 构建):
# node_modules 移入 nest_gateway/ 供运行时解析;若不存在则跳过(纯联网部署模式)
if [[ -d "${TMP}/runtime" ]]; then
  echo "  内置运行时 runtime/: $(du -sh "${TMP}/runtime" | cut -f1) platform=${RUNTIME_PLATFORM:-<unknown>}"
  if [[ -d "${TMP}/runtime/node_modules" ]]; then
    mkdir -p "${TMP}/nest_gateway"
    mv "${TMP}/runtime/node_modules" "${TMP}/nest_gateway/node_modules"
    # 写入平台标记:部署端 setup/start 据此激活平台链接,
    # 避免"旧布局无标记"警告(与 nest_gateway/node_modules.<platform> 标记同格式)
    if [[ -n "${RUNTIME_PLATFORM}" && "${RUNTIME_PLATFORM}" != "none" ]]; then
      printf '%s' "${RUNTIME_PLATFORM}" > "${TMP}/nest_gateway/node_modules/.platform"
    fi
    # 真 ABI/平台门禁:用包内 node 实际加载 better-sqlite3(网关启动唯一硬原生
    # 依赖)。b12 实测 runtime 快照曾混入 Linux ELF(better_sqlite3.node 为
    # \x7fELF 头),原处仅打印"ABI 已验证"文案、无任何校验,ELF 直达发布包
    # 致部署端 better-sqlite3 探测必挂。
    NODE_BIN="${TMP}/runtime/node22/node.exe"
    if [[ -f "${NODE_BIN}" ]]; then
      BS3_DIR="$(cygpath -w "${TMP}/nest_gateway/node_modules/better-sqlite3" 2>/dev/null \
        || echo "${TMP}/nest_gateway/node_modules/better-sqlite3")"
      if ! "${NODE_BIN}" -e "require(process.argv[1])" "${BS3_DIR}" >/dev/null 2>&1; then
        echo "FAIL: 包内 node 无法加载 better-sqlite3 — runtime/node_modules 混入异平台/异 ABI" >&2
        echo "      二进制。修复:以包内 node 版本为目标重拉预编译后重打包,例如" >&2
        echo "      cd runtime/node_modules/better-sqlite3 && prebuild-install --runtime node --target <node22 版本>" >&2
        exit 1
      fi
      echo "  OK: 包内 node 实测加载 better-sqlite3 通过(platform=${RUNTIME_PLATFORM:-<unknown>})"
    fi
  fi
else
  echo "  WARN: 无 runtime/ 目录 — 发布包不含已验证环境,部署需联网下载/安装" >&2
fi

# 递归清理 git 历史遗留的开发产物(已被跟踪的文件不受 .gitignore 约束):
# __pycache__/pyc 编译缓存(内含 co_filename 本机路径)、增量构建缓存、
# sourcemap(内嵌编译前源码)
find "${TMP}" -type d -name "__pycache__" -prune -exec rm -rf {} +
find "${TMP}" -type f \( -name "*.pyc" -o -name "*.tsbuildinfo" -o -name "*.js.map" \) -delete

# 打包期净化:替换开发机痕迹(erxx 为开发者本机目录名示例),
# 出现于 .env.example、设置页文案、路径注释、check 提示等处。
# dist 必须一并净化:运行时加载的是 dist,设置页文案(字符串字面量)若保留
# erxx 会展示开发机路径,且与净化后的 src 行为不一致(tsc removeComments
# 已剥离注释,dist 内 erxx 均为文案字符串,替换安全)。
# 排除第三方/产物目录(node_modules/runtime/venv/.git/coverage):
# 体积大扫描慢(每发 1-2min),且其内容非开发痕迹,误改写有破坏风险
grep -rlI "erxx" "${TMP}" \
  --exclude-dir=node_modules --exclude-dir=runtime --exclude-dir=venv \
  --exclude-dir=.git --exclude-dir=coverage \
  2>/dev/null | while read -r f; do
  sed -i 's/erxx/comfy_output/g' "${f}"
done

# runtime venv 的 pyvenv.cfg 含构建机绝对路径(Windows 用户名/目录结构,
# 隐私泄露点);痕迹扫描排除 runtime/ 且不查 .cfg 后缀,必须此处定点脱敏。
# home 失效后 venv python 无法启动(No Python at ...),由部署端启动脚本
# 用包内 python312 现场重建(见 start.ps1 Repair-PkgVenv)。
PYVENV="${TMP}/runtime/venv/pyvenv.cfg"
if [[ -f "${PYVENV}" ]]; then
  sed -i -E 's#^(home|executable|command) = .*#\1 = __RELOCATED__#' "${PYVENV}"
fi

# 剥离代码注释中的开发过程痕迹(如"2026-08-03 对话决策"等 AI 协作记录);
# 排除目录同上,避免扫描 node_modules 全树
grep -rlI "对话决策" "${TMP}" \
  --exclude-dir=node_modules --exclude-dir=runtime --exclude-dir=venv \
  --exclude-dir=.git --exclude-dir=dist --exclude-dir=coverage \
  2>/dev/null | while read -r f; do
  sed -i -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]]+对话决策//g; s/对话决策//g' "${f}"
done

# 版本标识文件(唯一识别串 BUILD_ID + 溯源字段;增量更新按 BUILD_ID/BUILD_SEQ 判新旧)
DIRTY=""
if [[ -n "$(git status --porcelain)" ]]; then
  DIRTY=1
fi
cat > "${TMP}/VERSION" <<EOF
WORKFLOW_DB_VERSION=${BUILD_ID}
BUILD_SEQ=${BUILD_SEQ}
VERSION_TAG=${TAG}
COMMIT=${FULL_SHA}
COMMIT_SHORT=${SHORT_SHA}
BUILD_DATE=${BUILD_DATE}
RUNTIME_PLATFORM=${RUNTIME_PLATFORM:-none}
DANBOORU_ASSETS=${WITH_DANBOORU}
PARSER_REGRESSION=${PARSER_REGRESSION_STATUS}
DIRTY=${DIRTY:-0}
EOF

# 文件级哈希清单:增量更新做文件差异比对的基础(sha256+size,按路径排序,
# 排除自身);VERSION 先于 manifest 生成故同被覆盖,自检段校验 build_id 一致性。
# 多线程并行哈希:hashlib.sha256 底层 C 实现会释放 GIL,线程池对多文件/大文件
# 有真实并行收益(运行时几万文件,单线程易成耗时点)。
"${PY_CMD}" - "${TMP}" "${BUILD_ID}" "${BUILD_DATE}" "${RUNTIME_PLATFORM:-none}" "${WITH_DANBOORU}" "${PARSER_REGRESSION_STATUS}" <<'PY'
import sys, os, hashlib, json
from concurrent.futures import ThreadPoolExecutor, as_completed
root, build_id, built_at, platform, danbooru, parser_status = sys.argv[1:7]

def sha256_of(path):
    h = hashlib.sha256()
    size = 0
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size

targets = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d != '.git']
    for fn in filenames:
        p = os.path.join(dirpath, fn)
        rel = os.path.relpath(p, root).replace('\\', '/')
        if rel == 'manifest.json':
            continue
        targets.append((rel, p))

files = {}
# 线程数:CPU 核心数上限 8,避免小机器 I/O 争抢过猛
workers = min(os.cpu_count() or 1, 8)
with ThreadPoolExecutor(max_workers=workers) as ex:
    futs = {ex.submit(sha256_of, p): rel for rel, p in targets}
    for fut in as_completed(futs):
        rel = futs[fut]
        digest, size = fut.result()
        files[rel] = {'sha256': digest, 'size': size}

manifest = {
    'build_id': build_id,
    'built_at': built_at,
    'platform': platform,
    'danbooru': danbooru,
    'parser_regression': parser_status,
    'files': dict(sorted(files.items())),
}
with open(os.path.join(root, 'manifest.json'), 'w', encoding='utf-8') as f:
    json.dump(manifest, f, ensure_ascii=False, separators=(',', ':'))
print('  manifest.json: %d 个文件哈希已生成(%d 线程)' % (len(files), workers))
PY

# ---------------------------------------------------------------------------
# 打包
# ---------------------------------------------------------------------------
mkdir -p "${OUT_DIR}"
if command -v zip >/dev/null 2>&1; then
  (cd "${TMP}" && zip -qr "${OUT}" .)
else
  "${PY_CMD}" - "${OUT}" "${TMP}" <<'PY'
import sys, shutil
shutil.make_archive(sys.argv[1][:-4], 'zip', sys.argv[2])
PY
fi

# ---------------------------------------------------------------------------
# 自检:版本标识存在 + 无开发内容残留 + 运行时资产齐备
# ---------------------------------------------------------------------------
"${PY_CMD}" - "${OUT}" "${BUILD_ID}" "${ROOT}" <<'PY'
import sys, zipfile, os, json, hashlib, ast
z = zipfile.ZipFile(sys.argv[1])
build_id = sys.argv[2]
root = sys.argv[3]
names = z.namelist()
# 已验证环境(nest_gateway/node_modules 与 runtime/)内的第三方文件
# 不参与残留检查(其内部包含大量 .js.map/任意字符串,非开发痕迹)
checked = [n for n in names if not n.startswith(
    ('nest_gateway/node_modules/', 'runtime/'))]
forbidden = [
    'docs/', 'AGENTS.md', 'API_DESIGN.md', 'IMPLEMENTATION_LOG.md',
    'MIGRATION_CHANGELOG.md', 'oc_prompting.md', 'opencode.json',
    'todo.md', 'UI_UPDATE_GUIDE.md', 'benchmarks/', 'tools/', 'tests/',
    'workflow_automatic/', 'comfy_generator/', 'err_log/',
    '.superpowers/', '.vscode/', '.opencode/',
    'nest_gateway/src/', 'nest_gateway/test/',
    'nest_gateway/scripts/collect_fixtures.py',
    'nest_gateway/scripts/dedupe_batch_images.py',
    'nest_gateway/scripts/rebuild_recipe_groups_full.cjs',
    'nest_gateway/scripts/sampler_centric_probe.py',
    'nest_gateway/scripts/sampler_centric_probe_v2.py',
    '__pycache__/',
]
bad = [n for n in checked if any(n.startswith(f) for f in forbidden)]
if bad:
    print('FAIL: 发布包残留开发内容:', bad[:10]); sys.exit(1)
for absent in ['test', 'package.json', 'package-lock.json']:
    if absent in names:
        print('FAIL: 发布包残留开发文件:', absent); sys.exit(1)
for suffix in ('.pyc', '.tsbuildinfo', '.js.map'):
    hit = [n for n in checked if n.endswith(suffix)]
    if hit:
        print(f'FAIL: 发布包残留 {suffix}:', hit[:5]); sys.exit(1)
# 含非 ASCII 字节的 .ps1 必须带 UTF-8 BOM:PS 5.1 对无 BOM 文件按 ANSI(GBK)
# 解析,中文字节被误读为引号等 → ParserError 直接崩溃(2026-08-28 用户实测)。
# archive 源若为 HEAD 而非工作树快照,会漏掉未提交的 BOM 修复,此处 fail-closed。
for n in checked:
    if not n.endswith('.ps1'):
        continue
    _ps1 = z.read(n)
    if any(b > 127 for b in _ps1) and _ps1[:3] != b'\xef\xbb\xbf':
        print('FAIL: 含中文的 .ps1 缺少 UTF-8 BOM(PS 5.1 解析必崩):', n); sys.exit(1)
traces = [b'Lena-centa', b'Armarius-Arcanorum', '对话决策'.encode()]
# 开发者本机痕迹(旧身份/本机用户名/家目录等)不写入本脚本,由未分发的本地清单并入扫描:
# <ROOT>/temp/identity_traces.local,每行一个 bytes 字面量(空行与 # 开头行忽略)。
_trace_file = os.environ.get('RELEASE_TRACES') or os.path.join(root, 'temp', 'identity_traces.local')
if os.path.exists(_trace_file):
    with open(_trace_file, 'r', encoding='utf-8') as _tf:
        for _line in _tf:
            _line = _line.strip()
            if _line and not _line.startswith('#'):
                traces.append(ast.literal_eval(_line))
hit = []
for n in checked:
    if not n.endswith(('.py', '.ts', '.js', '.md', '.sh', '.ps1', '.json',
                       '.example', '.mjs', '.txt')):
        continue
    try:
        data = z.read(n)
    except Exception:
        continue
    for t in traces:
        # 新仓库官方地址(Lena-centa/Armarius-Arcanorum)属合法发布内容;
        # 仅豁免含官方地址的文档(README/GUIDE/DEVELOPER_GUIDE/QUICK_START/SECURITY/RELEASE_NOTES),
        # 其余文件出现这些串视为开发/私密痕迹。
        if t in (b'Lena-centa', b'Armarius-Arcanorum') and n in (
                'README.md', 'GUIDE.md', 'DEVELOPER_GUIDE.md', 'QUICK_START.md',
                'SECURITY.md', 'RELEASE_NOTES.md'):
            continue
        if t in data:
            hit.append(f'{n} -> {t.decode()}')
if hit:
    print('FAIL: 发布包残留开发痕迹:'); [print('   ', h) for h in hit[:10]]
    sys.exit(1)
for need in ['VERSION', 'README.md', '快速上手.txt', 'GUIDE.md', 'DEVELOPER_GUIDE.md',
             'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'RELEASE_NOTES.md', '.env.example', 'requirements.txt',
             'nest_gateway/dist/main.js', 'start.sh', 'deploy.sh',
             'workflow_db/enrichment/__init__.py', 'workflow_db/static/enrichment_view.js',
             'workflow_db/static/transient_preview.js']:
    if need not in names:
        print('FAIL: 缺少必需文件:', need); sys.exit(1)
# 可选组件:GNN/SQLite 查表资产(danbooru/)。含则三资产齐备、无瞬态文件、
# 查表库五表齐全(含 character_profile)、npy 魔数正确;否则与"未打包"一致,不报错
danb = [n for n in names if n in {
    'danbooru/danbooru.sqlite3', 'danbooru/vocab_sorted.npy',
    'danbooru/embed_gnn.npy'
}]
if danb:
    import shutil, tempfile, sqlite3 as _sqlite3
    for need in ['danbooru/ASSET_LICENSES.md', 'danbooru/danbooru.sqlite3', 'danbooru/vocab_sorted.npy',
                 'danbooru/embed_gnn.npy']:
        if need not in names:
            print('FAIL: danbooru 资产不完整,缺少:', need); sys.exit(1)
    stray = [n for n in danb if n.endswith(('-shm', '-wal'))]
    if stray:
        print('FAIL: danbooru 残留瞬态文件:', stray); sys.exit(1)
    fd, tmpdb = tempfile.mkstemp(suffix='.sqlite3')
    os.close(fd)
    try:
        with z.open('danbooru/danbooru.sqlite3') as src, open(tmpdb, 'wb') as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
        con = _sqlite3.connect(tmpdb)
        tables = {r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        con.close()
        for t in ('tags', 'tag_alias', 'edges', 'tag_gnn_nn', 'character_profile'):
            if t not in tables:
                print('FAIL: danbooru 查表库缺表:', t); sys.exit(1)
    finally:
        os.unlink(tmpdb)
    for npy in ('danbooru/vocab_sorted.npy', 'danbooru/embed_gnn.npy'):
        if z.read(npy)[:6] != b'\x93NUMPY':
            print('FAIL: npy 魔数异常:', npy); sys.exit(1)
    print('  OK: danbooru 可选组件齐备(五表查表库 + 2 份 npy)')
# pyvenv.cfg 脱敏兜底:净化阶段已替换构建机路径,此处防未来回归
try:
    cfg = z.read('runtime/venv/pyvenv.cfg').decode()
    if 'C:\\Users\\' in cfg:
        print('FAIL: runtime/venv/pyvenv.cfg 残留本机路径'); sys.exit(1)
except KeyError:
    pass
# 运行时完整性:若含 runtime/ 则关键组件必须齐备。
# 组件路径随平台不同(Windows:node22/node.exe + python312/python.exe +
# venv/Scripts;Linux:node22/bin/node + python312/bin/python3 + venv/bin),
# 以发布包内 RUNTIME.json 的 platform 为准,环境变量 RUNTIME_PLATFORM 兜底
platform = os.environ.get('RUNTIME_PLATFORM', '').strip().lower()
try:
    rt = json.loads(z.read('runtime/RUNTIME.json'))
    platform = platform or str(rt.get('platform', '')).lower()
except Exception:
    pass
if platform == 'linux':
    runtime_needed = ['runtime/node22/bin/node', 'runtime/python312/bin/python3',
                      'runtime/venv/bin/python', 'runtime/RUNTIME.json']
else:
    # windows(含未识别平台时的旧布局默认)
    runtime_needed = ['runtime/node22/node.exe', 'runtime/python312/python.exe',
                      'runtime/venv/Scripts/python.exe', 'runtime/RUNTIME.json']
if any(n.startswith('runtime/') for n in names):
    for rn in runtime_needed:
        if rn not in names:
            print('FAIL: runtime 不完整,缺少:', rn); sys.exit(1)
    print('  OK: runtime 组件齐备(node22/python312/venv/RUNTIME.json, platform=' +
          (platform or '<unknown>') + ')')
# node_modules/.platform 标记断言:缺失(旧布局)会让部署端 npm 平台隔离
# 误判架构错配;无 runtime 的纯联网包由部署端自行安装,跳过
try:
    marker = z.read('nest_gateway/node_modules/.platform').decode().strip()
except KeyError:
    marker = ''
if platform and marker != platform:
    print('FAIL: nest_gateway/node_modules/.platform 缺失或不匹配(=' +
          (marker or '<missing>') + ', 要求 ' + platform + ')'); sys.exit(1)
print('  OK: 无开发内容残留,必需文件齐备')
print('  VERSION:')
print('    ' + z.read('VERSION').decode().replace('\n', '\n    ').rstrip())
# manifest.json:可解析、build_id 一致、文件数对齐 zip、抽查小文件哈希
try:
    mf = json.loads(z.read('manifest.json'))
except KeyError:
    print('FAIL: manifest.json 缺失'); sys.exit(1)
except ValueError:
    print('FAIL: manifest.json 解析失败'); sys.exit(1)
if mf.get('build_id') != build_id:
    print('FAIL: manifest.json build_id 不一致: ' +
          (mf.get('build_id') or '<missing>') + ' != ' + build_id); sys.exit(1)
zip_files = [n for n in names if not n.endswith('/') and n != 'manifest.json']
if len(zip_files) != len(mf['files']):
    print('FAIL: manifest.json 文件数不一致: ' + str(len(mf['files'])) +
          ' != zip ' + str(len(zip_files))); sys.exit(1)
probed = 0
for rel, info in mf['files'].items():
    if info['size'] > 1000000:
        continue
    if hashlib.sha256(z.read(rel)).hexdigest() != info['sha256']:
        print('FAIL: manifest.json 哈希不匹配: ' + rel); sys.exit(1)
    probed += 1
    if probed >= 3:
        break
if probed == 0:
    print('FAIL: manifest.json 无小文件可抽查'); sys.exit(1)
print('  OK: manifest.json 合法, build_id 一致, ' +
      str(len(mf['files'])) + ' 个文件哈希齐备')
PY
rc=$?
if [[ ${rc} -ne 0 ]]; then
  # 自检失败时删除脏产物,避免"失败但留下旧包"的误用
  rm -f "${OUT}"
  exit ${rc}
fi

FILES="$(find "${TMP}" -type f | wc -l)"
echo "  打包完成: ${OUT}"
echo "  版本:     ${BUILD_ID}"
echo "  文件数:   ${FILES}"
echo "  含:       dist 预构建 / 运行时 Python 包 / 双平台脚本 / VERSION 标识"
[[ "${WITH_DANBOORU}" == "1" ]] && echo "  含:       GNN/SQLite 查表可选组件(danbooru/ 资产)"
echo "  剔除:     全部 docs 与开发工具、日志、配置、测试、基准"
