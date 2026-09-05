#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}" && pwd)"
NEST_GATEWAY_DIR="${PROJECT_ROOT}/nest_gateway"
VENV_ACTIVATE="${PROJECT_ROOT}/venv/bin/activate"
NEST_DIST="${NEST_GATEWAY_DIR}/dist/main.js"
# start.sh setup 自动安装的便携 node(用户级);存在则前置 PATH,保证 check/start 可用
PORTABLE_NODE_DIR="${PORTABLE_NODE_DIR:-$HOME/.local/share/wfdb-node22}"
# 便携 node 自动安装配置(PATH 无 node 时由 setup 下载;与 deploy.sh 镜像约定一致)
NODE_VERSION="${NODE_VERSION:-v22.23.2}"
NODE_DIST_MIRROR="${NODE_DIST_MIRROR:-https://registry.npmmirror.com/-/binary/node}"

usage() {
  cat <<'EOF'
Usage:
  ./start.sh [command]

Commands:
  (default)  Same as start: verify deps, auto-install missing ones, then launch.
  setup      Full initialization: precheck → venv → npm install → .env → self-check (idempotent).
  check      Run environment checks only (required deps must pass, optional deps warn).
  start      Check deps (auto-setup on failure), then start NestJS Gateway (default port 8009).
             Opens the tool page in the default browser once the gateway is ready
             (WORKFLOW_DB_AUTO_OPEN=0 to disable).
  stop       Stop running Workflow DB processes.

Optional environment overrides:
  COMFY_SCAN_ROOT
  MONGODB_URI
  MONGODB_DB
  MONGODB_COLLECTION
  NEST_GATEWAY_PORT        Port for NestJS (default 8009)

配置统一来源:用户数据目录 .env(缺失时网关首启自动生成;参见 .env.example)。
EOF
}

ensure_project_root() {
  if [[ ! -d "${PROJECT_ROOT}" ]]; then
    echo "Project root not found: ${PROJECT_ROOT}" >&2
    exit 1
  fi
}

enter_project_root() {
  cd "${PROJECT_ROOT}"
}

# 自动创建 venv(ensurepip 缺失时用 get-pip.py 引导);失败才退出。
ensure_venv() {
  if [[ -f "${VENV_ACTIVATE}" ]]; then
    return 0
  fi
  echo "[setup] venv 不存在,自动创建..."
  if ! python3 -m venv "${PROJECT_ROOT}/venv" 2>/dev/null; then
    # ensurepip 缺失(Debian 需 python3-venv):--without-pip + get-pip 引导
    rm -rf "${PROJECT_ROOT}/venv"
    if ! python3 -m venv --without-pip "${PROJECT_ROOT}/venv" 2>/dev/null; then
      echo "  FAIL: 无法创建 venv — 请安装 python3-venv 包(如: sudo apt install python3-venv)" >&2
      exit 1
    fi
    echo "  ensurepip 缺失,用 get-pip.py 引导..."
    if ! curl -sSL https://bootstrap.pypa.io/get-pip.py -o "${PROJECT_ROOT}/venv-get-pip.py" 2>/dev/null; then
      echo "  FAIL: 下载 get-pip.py 失败(需网络) — 请安装 python3-venv 包" >&2
      exit 1
    fi
    "${PROJECT_ROOT}/venv/bin/python" "${PROJECT_ROOT}/venv-get-pip.py" -q || {
      echo "  FAIL: get-pip 引导失败" >&2
      exit 1
    }
    rm -f "${PROJECT_ROOT}/venv-get-pip.py"
  fi
  echo "[setup] 安装 Python 依赖 (requirements.txt)..."
  "${PROJECT_ROOT}/venv/bin/pip" install -q -i "${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}" -r "${PROJECT_ROOT}/requirements.txt" || {
    echo "  FAIL: pip install 失败(检查网络)" >&2
    exit 1
  }
  echo "[setup] venv 就绪"
}

# 用户数据目录解析(与 nest_gateway/src/config/data-dir.ts 对齐):
# WORKFLOW_DATA_DIR(绝对路径)优先;Git Bash/Windows 取 %LOCALAPPDATA%\workflow_db,
# WSL/Linux 取 $XDG_DATA_HOME/workflow_db,回退 ~/.local/share/workflow_db。
# 注意:该变量只能来自进程环境,不能写入 .env(.env 本身就在数据目录内)。
resolve_data_dir() {
  local configured="${ARMARIUS_DATA_DIR:-${WORKFLOW_DATA_DIR:-}}"
  if [[ -n "${configured}" ]]; then
    printf '%s' "${configured}"
    return 0
  fi
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*)
      local base="${LOCALAPPDATA:-${USERPROFILE:-$HOME}/AppData/Local}"
      while [[ "$base" == *[\\/] ]]; do base="${base%?}"; done
      local new_dir="${base}\\armarius_arcanorum"
      local legacy_dir="${base}\\workflow_db"
      if [[ -d "${new_dir}" ]]; then
        printf '%s' "${new_dir}"
      elif [[ -d "${legacy_dir}" ]]; then
        printf '%s' "${legacy_dir}"
      else
        printf '%s' "${new_dir}"
      fi
      ;;
    *)
      local base_dir=""
      if [[ -n "${XDG_DATA_HOME:-}" && "${XDG_DATA_HOME}" = /* ]]; then
        base_dir="${XDG_DATA_HOME%/}"
      else
        base_dir="${HOME%/}/.local/share"
      fi
      local new_dir="${base_dir}/armarius_arcanorum"
      local legacy_dir="${base_dir}/workflow_db"
      if [[ -d "${new_dir}" ]]; then
        printf '%s' "${new_dir}"
      elif [[ -d "${legacy_dir}" ]]; then
        printf '%s' "${legacy_dir}"
      else
        printf '%s' "${new_dir}"
      fi
      ;;
  esac
}

# 从数据目录 .env 读取 KEY=VALUE(不覆盖已存在的环境变量)。
load_env_file() {
  local env_file="${1:-${PROJECT_ROOT}/.env}"
  [[ -f "${env_file}" ]] || return 0
  local line key value
  while IFS= read -r line; do
    line="${line%"${line##*[![:space:]]}"}" # trim trailing
    case "${line}" in
      '' | '#'*) continue ;;
    esac
    case "${line}" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    if [[ ${#value} -ge 2 &&
      ( ( "${value:0:1}" == '"' && "${value: -1}" == '"' ) ||
        ( "${value:0:1}" == "'" && "${value: -1}" == "'" ) ) ]]; then
      value="${value:1:${#value}-2}"
    fi
    case "${key}" in
      [A-Za-z_]*[A-Za-z0-9_]) ;;
      *) continue ;;
    esac
    if [[ -z "${!key+x}" ]]; then
      export "${key}=${value}"
    fi
  done < "${env_file}"
}

load_defaults() {
  # 数据目录内平台覆盖先加载,共享 .env 仅补充未定义的键。
  local data_dir
  data_dir="$(resolve_data_dir)"
  load_env_file "${data_dir}/.env.wsl"
  load_env_file "${data_dir}/.env"
  export NEST_GATEWAY_PORT="${NEST_GATEWAY_PORT:-8009}"
}

print_context() {
  cat <<EOF
Workflow DB context:
  project root: ${PROJECT_ROOT}
  venv: ${PROJECT_ROOT}/venv
  scan root: ${COMFY_SCAN_ROOT:-}
  mongodb uri: ${MONGODB_URI:-}
  mongodb db: ${MONGODB_DB:-}
  nest gateway dir: ${NEST_GATEWAY_DIR}
  nest gateway port: ${NEST_GATEWAY_PORT}
EOF
}

check_node() {
  # 便携 node 前置(PATH 无 node 时;已有系统 node 则不动)
  if ! command -v node >/dev/null 2>&1 && [[ -x "${PORTABLE_NODE_DIR}/bin/node" ]]; then
    export PATH="${PORTABLE_NODE_DIR}/bin:${PATH}"
  fi
  if command -v node >/dev/null 2>&1; then
    local ver major
    ver="$(node --version 2>/dev/null || true)"
    major="$(echo "${ver#v}" | cut -d. -f1)"
    case "${major}" in
      22|24|25|26)
        echo "  OK: node ${ver}"
        return 0
        ;;
      *)
        # 系统 node 超出 22-26(better-sqlite3 预编译 ABI 覆盖范围):便携
        # node22 可用则自动前置,保证运行 ABI 与安装一致
        if [[ -x "${PORTABLE_NODE_DIR}/bin/node" ]]; then
          export PATH="${PORTABLE_NODE_DIR}/bin:${PATH}"
          ver="$(node --version 2>/dev/null || true)"
          echo "  OK: node ${ver} (便携 node22 前置,替代系统 node)"
          return 0
        fi
        echo "  WARNING: node ${ver} 超出 better-sqlite3 预编译覆盖(22-26),ABI 探测可能失败 — 建议安装 Node 22 LTS" >&2
        return 0
        ;;
    esac
  fi
  echo "  FAIL: node not found in PATH (install Node.js >= 20)" >&2
  return 1
}

# TCP 可达性检查(TCP connect 成功即视为可用,不做鉴权验证)
check_mongodb() {
  local uri="${MONGODB_URI:-mongodb://127.0.0.1:27017}"
  if node -e '
    const net = require("net");
    const uri = process.argv[1];
    const m = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@]*@)?([^/:\s]+)(?::(\d+))?/);
    const host = m ? m[1] : "127.0.0.1";
    const port = m && m[2] ? parseInt(m[2], 10) : 27017;
    const sock = net.connect({ host, port });
    sock.setTimeout(3000);
    sock.on("connect", () => { sock.destroy(); process.exit(0); });
    sock.on("timeout", () => { sock.destroy(); process.exit(1); });
    sock.on("error", () => process.exit(1));
  ' "${uri}" 2>/dev/null; then
    echo "  OK: MongoDB reachable at ${uri}"
    return 0
  fi
  echo "  FAIL: MongoDB not reachable at ${uri} (check mongod service and MONGODB_URI)" >&2
  return 1
}

# 跨平台路径归一化:Windows 盘符路径(X:/... 或 X:\...)→ /mnt/x/...(POSIX 侧)
# 共享 .env 常以 Windows 形式配置(SQLITE_DB_PATH/COMFY_SCAN_ROOT),WSL check 需转换
fs_path() {
  local p="$1"
  if [[ "$p" =~ ^([A-Za-z]):[/\\](.*)$ ]]; then
    printf '/mnt/%s/%s' "${BASH_REMATCH[1],,}" "${BASH_REMATCH[2]//\\//}"
  else
    printf '%s' "$p"
  fi
}

# POSIX 路径 → Windows 盘符路径(/mnt/d/... → D:\...),供 mklink /J 使用;非 /mnt 前缀返回非 0
win_path() {
  if [[ "$1" =~ ^/mnt/([A-Za-z])/(.*)$ ]]; then
    printf '%s:\\%s' "${BASH_REMATCH[1]^^}" "${BASH_REMATCH[2]//\//\\}"
    return 0
  fi
  return 1
}

# SQLite 主库检查:打开 + PRAGMA quick_check(SQLITE_READ=1 时替代 Mongo 为必须依赖)
check_sqlite() {
  local db_path="$(fs_path "${SQLITE_DB_PATH:-$(resolve_data_dir)/gray_workflow.sqlite3}")"
  if [[ ! -f "${db_path}" ]]; then
    echo "  FAIL: SQLite db not found: ${db_path} (run sqlite-backfill or enable dual-write first)" >&2
    return 1
  fi
  if node -e '
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2], { readonly: true });
    // 大库(>1GB)完整 quick_check 可能耗时数分钟阻塞启动,降为 quick_check(1)
    // (仅顶层页面,秒级);小库仍做完整校验
    const big = db.pragma("page_count", { simple: true }) * db.pragma("page_size", { simple: true }) > 1e9;
    const row = db.prepare(big ? "PRAGMA quick_check(1)" : "PRAGMA quick_check").get();
    db.close();
    process.exit(row && row.quick_check === "ok" ? 0 : 1);
  ' "${NEST_GATEWAY_DIR}/node_modules/better-sqlite3" "${db_path}" 2>/dev/null; then
    echo "  OK: SQLite db healthy: ${db_path}"
    return 0
  fi
  echo "  FAIL: SQLite db check failed: ${db_path}" >&2
  return 1
}

# 任意 HTTP 响应(含 4xx/5xx)即视为服务可达
check_url() {
  local url="$1"
  node -e '
    const http = require("http");
    const https = require("https");
    const url = new URL(process.argv[1]);
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, { timeout: 3000 }, () => process.exit(0));
    req.on("timeout", () => { req.destroy(); process.exit(1); });
    req.on("error", () => process.exit(1));
    req.end();
  ' "${url}" 2>/dev/null
}

# 必须依赖:任一失败返回非 0
check_required_deps() {
  local failed=0
  echo "Checking required dependencies..."
  check_node || failed=1
  if [[ -d "${NEST_GATEWAY_DIR}/node_modules" ]]; then
    echo "  OK: nest_gateway/node_modules present"
  else
    echo "  FAIL: node_modules missing, run 'cd nest_gateway && npm install'" >&2
    failed=1
  fi
  if [[ -f "${NEST_DIST}" ]]; then
    echo "  OK: NestJS dist present"
  else
    echo "  FAIL: dist missing, run 'cd nest_gateway && npm run build'" >&2
    failed=1
  fi
  if [[ -x "${PROJECT_ROOT}/venv/bin/python" ]] && "${PROJECT_ROOT}/venv/bin/python" -c "import workflow_db.parser, workflow_db.comfy_replay, workflow_db.parse_worker, workflow_db.generate_worker" 2>/dev/null; then
    echo "  OK: venv python + worker assets importable"
  else
    echo "  FAIL: venv or worker assets missing — create with 'python3 -m venv venv && venv/bin/pip install -r requirements.txt'" >&2
    failed=1
  fi
  # SQLite 单引擎(显式 SQLITE_READ=1 或 MONGODB_URI 留空自动启用)时
  # SQLite 为必须依赖,Mongo 退化为可选;fresh 部署缺库仅警告(首启自动建库)
  if [[ "${SQLITE_READ:-0}" == "1" || -z "${MONGODB_URI:-}" ]]; then
    if [[ -f "$(fs_path "${SQLITE_DB_PATH:-$(resolve_data_dir)/gray_workflow.sqlite3}")" ]]; then
      check_sqlite || failed=1
    else
      db_path="$(fs_path "${SQLITE_DB_PATH:-$(resolve_data_dir)/gray_workflow.sqlite3}")"
      db_parent="$(dirname "${db_path}")"
      if [[ ! -d "${db_parent}" ]]; then
        # 数据目录被外置且全新部署通常不存在;网关 openSqlite 会自动建目录建库,
        # 此处仅预建目录并向用户说明,不算失败
        mkdir -p "${db_parent}" 2>/dev/null && echo "  OK: SQLite db parent created: ${db_parent}" >&2 \
          || { echo "  FAIL: cannot create SQLite db parent: ${db_parent}" >&2; failed=1; }
      else
        echo "  WARNING: SQLite 主库尚未创建 — 首次启动会自动建库或从旧仓库 data/ 迁移,无需手工干预" >&2
      fi
    fi
  else
    check_mongodb || failed=1
  fi
  if [[ -n "${COMFY_SCAN_ROOT:-}" ]]; then
    if [[ -d "$(fs_path "${COMFY_SCAN_ROOT}")" ]]; then
      echo "  OK: scan root exists: ${COMFY_SCAN_ROOT}"
      # WSL/Linux 下 Windows 盘符形式路径仅本脚本可转换,应用层(NestJS)不会转换,
      # 会报"不存在"并空转 sync —— 显式提示,避免 check 通过但启动后无效
      if [[ "${COMFY_SCAN_ROOT}" =~ ^[A-Za-z]:[/\\] ]]; then
        echo "  WARNING: COMFY_SCAN_ROOT 为 Windows 盘符形式(${COMFY_SCAN_ROOT}),当前平台非 Windows,应用层无法识别,请在设置页配置 POSIX 形式(如 /mnt/d/erxx)后重启" >&2
      fi
    else
      echo "  FAIL: COMFY_SCAN_ROOT 已配置但不存在: ${COMFY_SCAN_ROOT}" >&2
      failed=1
    fi
  else
    echo "  WARNING: COMFY_SCAN_ROOT 未配置 — 空库可启动,在设置页配置图片目录后重启即可摄入" >&2
  fi
  return ${failed}
}

# 可选依赖:仅提示 warning,不阻断启动
check_optional_deps() {
  echo "Checking optional dependencies..."
  local comfy="${COMFYUI_BASE_URL:-http://127.0.0.1:8188}"
  if check_url "${comfy}"; then
    echo "  OK: ComfyUI reachable at ${comfy}"
  else
    echo "  WARNING: ComfyUI not reachable at ${comfy} — near-realtime ingest (history poll) and the generate panel will be unavailable; start ComfyUI to enable" >&2
  fi
  if [[ -n "${WORKFLOW_DB_BACKUP_DIR:-}" ]]; then
    if [[ "${SQLITE_READ:-0}" == "1" ]]; then
      echo "  OK: SQLite backup engine (backup API, WORKFLOW_DB_BACKUP_DIR set)"
    elif command -v mongodump >/dev/null 2>&1; then
      echo "  OK: mongodump available (backup loop)"
    else
      echo "  WARNING: WORKFLOW_DB_BACKUP_DIR is set but mongodump not found in PATH — backup loop will be disabled (install MongoDB Database Tools)" >&2
    fi
  fi
}

# 平台 node_modules 激活守卫:node_modules → node_modules.linux(链接)。
# 平台目录(带 .platform 标记)由 start.sh setup 安装;发布包旧布局(无标记真实目录)
# 视为当前平台放行并提示迁移;链接指向他平台时自动改链(目标目录存在则免重装,
# 缺失才拒绝启动,避免 ABI 错配);npm install/ci 的链接自愈见
# nest_gateway/scripts/ensure-platform.mjs(preinstall/postinstall 挂钩)。
# 安全移除激活链接(仅删链接,junction 在 WSL 下 unlink 不可靠,回退 cmd rmdir)
remove_link() {
  local nm="$1"
  if unlink "${nm}" 2>/dev/null; then
    return 0
  fi
  if [[ "${nm}" =~ ^/mnt/([A-Za-z])/(.*)$ ]] && command -v cmd.exe >/dev/null 2>&1; then
    local nm_win
    nm_win=$(win_path "${nm}")
    if cmd.exe /c "rmdir \"${nm_win}\"" >/dev/null 2>&1; then
      return 0
    fi
  fi
  echo "  FAIL: 移除链接 ${nm} 失败" >&2
  return 1
}
# 创建激活链接(WSL:Windows junction 优先,双平台可读;纯 Linux:symlink)
activate_link() {
  local nm="$1" plat_dir="$2"
  if [[ "${nm}" =~ ^/mnt/([A-Za-z])/(.*)$ ]] && command -v cmd.exe >/dev/null 2>&1; then
    local nm_win ln_win
    nm_win=$(win_path "${nm}")
    ln_win=$(win_path "${plat_dir}")
    if cmd.exe /c "mklink /J \"${nm_win}\" \"${ln_win}\"" >/dev/null 2>&1; then
      return 0
    fi
    echo "  WARN: mklink /J 失败,回退符号链接" >&2
  fi
  if ln -s "$(basename "${plat_dir}")" "${nm}" 2>/dev/null; then
    return 0
  fi
  echo "  FAIL: 创建符号链接失败(WSL 需启用 drvfs metadata: /etc/wsl.conf [automount] options=metadata)" >&2
  return 1
}

ensure_platform_node_modules() {
  local nm="${NEST_GATEWAY_DIR}/node_modules"
  local plat_dir="${NEST_GATEWAY_DIR}/node_modules.linux"
  local plat
  if [[ -e "${nm}" ]]; then
    # 标记优先:junction(Windows 创建,drvfs 下 -L 检测不可靠)与 symlink 均穿透可读
    if [[ -f "${nm}/.platform" ]]; then
      plat="$(cat "${nm}/.platform")"
      if [[ "${plat}" != "linux" ]]; then
        # 链接指向他平台:目标平台目录存在则自动改链(免重装),不存在才 FAIL
        if [[ -d "${plat_dir}" ]]; then
          if ! remove_link "${nm}"; then
            return 1
          fi
          if ! activate_link "${nm}" "${plat_dir}"; then
            echo "  FAIL: 自动改链失败 — 请运行 ./start.sh setup 重建" >&2
            return 1
          fi
          echo "  OK: 自动切换激活链接 node_modules → node_modules.linux(原指向 ${plat})" >&2
        else
          echo "  FAIL: nest_gateway/node_modules 指向 ${plat} 平台,且 node_modules.linux 不存在 — 请先运行 ./start.sh setup 初始化" >&2
          return 1
        fi
      fi
    elif [[ -L "${nm}" ]]; then
      # 链接目标无平台标记(损坏):目标平台目录存在则重建链接
      if [[ -d "${plat_dir}" ]]; then
        if ! remove_link "${nm}"; then
          return 1
        fi
        if ! activate_link "${nm}" "${plat_dir}"; then
          echo "  FAIL: 重建激活链接失败 — 请运行 ./start.sh setup 重建" >&2
          return 1
        fi
        echo "  OK: 修复损坏激活链接 node_modules → node_modules.linux" >&2
      else
        echo "  FAIL: nest_gateway/node_modules 链接目标无平台标记(损坏)— 删除链接后重跑 start.sh setup" >&2
        return 1
      fi
    else
      echo "  WARNING: nest_gateway/node_modules 为旧布局(无平台标记)— 建议运行 start.sh setup 迁移为 node_modules.linux" >&2
    fi
  elif [[ ! -d "${plat_dir}" ]]; then
    echo "  FAIL: node_modules.linux 不存在 — 请先运行 ./start.sh setup 初始化" >&2
    return 1
  else
    if ! activate_link "${nm}" "${plat_dir}"; then
      return 1
    fi
    echo "  OK: 激活 node_modules → node_modules.linux" >&2
  fi
  # ABI 探测:用启动所用的 node 实际加载 better-sqlite3(链接穿透到平台目录),
  # 错配给出清晰报错而非运行期裸奔(ERR_DLOPEN_FAILED)
  if ! node -e "new (require('${NEST_GATEWAY_DIR}/node_modules/better-sqlite3'))(':memory:')" >/dev/null 2>&1; then
    echo "  FAIL: better-sqlite3 与当前 node ($(node --version 2>/dev/null || echo '?')) 不匹配(ABI)— 在该平台运行 start.sh setup 重装依赖" >&2
    return 1
  fi
  return 0
}

# 启动前置门槛(check / start 共用):仅必须依赖,缺失即失败。
# 可选依赖检查由调用方决定执行时机:check 同步,start 后台化(不阻塞启动)
ensure_deps() {
  if ! ensure_platform_node_modules; then
    return 1
  fi
  if ! check_required_deps; then
    echo "Environment check FAILED - fix the FAIL items above." >&2
    return 1
  fi
  echo
  return 0
}

run_check() {
  ensure_project_root
  enter_project_root
  ensure_venv
  load_defaults
  print_context

  echo
  if ! ensure_deps; then
    exit 1
  fi
  echo
  check_optional_deps
  echo
  echo "Environment check passed."
}

# ---------------------------------------------------------------------------
# 全量初始化(setup 子命令 / start 自动补齐共用):环境预检 → venv → npm install
# → .env → 自检。各步幂等,已装好即跳过;硬性失败直接 exit 1。
# 用法: invoke_setup [skip_check] — skip_check=1 供 start 补齐路径跳过尾部自检
# ---------------------------------------------------------------------------
install_portable_node() {
  # 下载便携 node(npmmirror linux-x64)到用户目录,免 root/免系统包管理器
  local ver="$1"
  local url="${NODE_DIST_MIRROR}/${ver}/node-${ver}-linux-x64.tar.xz"
  local tmp
  tmp="$(mktemp -d)"
  echo "  INSTALL: 未找到 node,下载便携 node ${ver} → ${PORTABLE_NODE_DIR}"
  if ! curl -fsSL --connect-timeout 10 -o "${tmp}/node.tar.xz" "${url}"; then
    echo "  FAIL: 下载便携 node 失败(${url})— 请手动安装 Node.js 22 LTS 或更高" >&2
    rm -rf "${tmp}"
    return 1
  fi
  if ! mkdir -p "${tmp}/x" || ! tar -xJf "${tmp}/node.tar.xz" -C "${tmp}/x"; then
    echo "  FAIL: 解压便携 node 失败(需要 tar/xz 支持)" >&2
    rm -rf "${tmp}"
    return 1
  fi
  rm -rf "${PORTABLE_NODE_DIR}"
  mkdir -p "$(dirname "${PORTABLE_NODE_DIR}")"
  cp -a "${tmp}/x/node-${ver}-linux-x64" "${PORTABLE_NODE_DIR}"
  rm -rf "${tmp}"
  export PATH="${PORTABLE_NODE_DIR}/bin:${PATH}"
  echo "  OK: 便携 node ${ver} 已安装到 ${PORTABLE_NODE_DIR}"
}

# 安装戳 = sha256(package.json) + sha256(package-lock.json)(与 ensure-platform.mjs
# 一致);戳缺失/不匹配时执行增量安装,避免静默跑旧依赖
npm_stamp() {
  sha256sum "${NEST_GATEWAY_DIR}/package.json" "${NEST_GATEWAY_DIR}/package-lock.json" 2>/dev/null \
    | awk '{print $1}' | tr -d '\n'
}

invoke_setup() {
  local skip_check="${1:-0}"
  echo "================================================"
  echo " Workflow DB — 初始化(WSL / Linux)"
  echo "================================================"

  echo "[1/5] 环境预检"
  # node:PATH 无 node 且无便携 node 时先下载(check_node 仅前置已有便携)
  if ! command -v node >/dev/null 2>&1 && [[ ! -x "${PORTABLE_NODE_DIR}/bin/node" ]]; then
    install_portable_node "${NODE_VERSION}" || exit 1
  fi
  check_node || exit 1
  if ! command -v python3 >/dev/null 2>&1; then
    echo "  FAIL: 未找到 python3 — 请安装 Python 3.10+ (https://www.python.org)" >&2
    exit 1
  fi
  if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    echo "  FAIL: python3 版本过旧(需 3.10+) — 请升级 Python" >&2
    exit 1
  fi
  echo "  OK: python3 $(python3 --version 2>&1 | awk '{print $2}')"
  echo

  echo "[2/5] Python 虚拟环境"
  ensure_venv
  echo

  echo "[3/5] Node 依赖 (nest_gateway/node_modules.linux)"
  local need_install=0
  local plat_dir="${NEST_GATEWAY_DIR}/node_modules.linux"
  if [[ ! -d "${plat_dir}" ]]; then
    need_install=1
  else
    local stamp_file="${plat_dir}/.npm-stamp"
    if [[ ! -f "${stamp_file}" ]] || [[ "$(cat "${stamp_file}")" != "$(npm_stamp)" ]]; then
      need_install=1
    fi
  fi
  if [[ "${need_install}" -eq 1 ]]; then
    # 链接指向他平台/损坏时由 preinstall 守卫改链或移除(防止写穿链接污染);
    # 真实目录/缺失目录由 npm 增量安装 + postinstall 迁移为平台目录,无需预操作
    if ! (cd "${NEST_GATEWAY_DIR}" && npm install --no-audit --no-fund --registry "${NPM_REGISTRY:-https://registry.npmmirror.com}"); then
      echo "  FAIL: npm install 失败 — better-sqlite3 预编译从 GitHub 下载,检查网络" >&2
      exit 1
    fi
    if [[ ! -d "${NEST_GATEWAY_DIR}/node_modules" && ! -d "${plat_dir}" ]]; then
      echo "  FAIL: npm install 未产出 node_modules 且平台目录不存在" >&2
      exit 1
    fi
    # postinstall 已把全新安装迁移为平台目录并写标记/安装戳;此处兜底
    if [[ -d "${NEST_GATEWAY_DIR}/node_modules" && ! -d "${plat_dir}" ]]; then
      mv "${NEST_GATEWAY_DIR}/node_modules" "${plat_dir}"
      echo "  已安装到 node_modules.linux"
    fi
    echo -n 'linux' > "${plat_dir}/.platform"
    echo -n "$(npm_stamp)" > "${plat_dir}/.npm-stamp"
  else
    echo "  OK: node_modules.linux 已存在且依赖无变更,跳过 npm install"
  fi
  # 激活链接守卫 + ABI 探测复用启动路径同一实现(含 better-sqlite3 加载硬校验)
  ensure_platform_node_modules || exit 1
  echo

  echo "[4/5] 环境配置 (.env)"
  local data_dir
  data_dir="$(resolve_data_dir)"
  mkdir -p "${data_dir}" 2>/dev/null || true
  # 与网关冷迁移同规则:旧仓库根 .env 优先迁入;都没有才从模板生成
  if [[ -f ".env" ]]; then
    if [[ ! -f "${data_dir}/.env" ]]; then
      cp .env "${data_dir}/.env"
      echo "  已迁移旧仓库根 .env → ${data_dir}/.env"
    else
      echo "  .env 已存在(${data_dir}),跳过(旧仓库根 .env 不再使用)"
    fi
  elif [[ ! -f "${data_dir}/.env" ]]; then
    cp .env.example "${data_dir}/.env"
    echo "  已从 .env.example 生成 ${data_dir}/.env(默认 SQLite 单引擎,零配置)"
  else
    echo "  .env 已存在(${data_dir}),跳过"
  fi
  echo "  (.env 存放于用户数据目录,外置代码树;更新/重装不丢失)"
  echo "  提示:可复制 .env.wsl.example 为数据目录内 .env.wsl,配置 WSL/Linux 路径"
  echo "        也可在设置页配置 COMFY_SCAN_ROOT(图片目录)与 MongoDB(可选引擎)"
  echo

  if [[ "${skip_check}" != "1" ]]; then
    echo "[5/5] 环境自检"
    if ! ensure_deps; then
      echo ""
      echo "  自检未完全通过 — 按上方 FAIL 项修复后重跑 ./start.sh setup" >&2
      exit 1
    fi
    check_optional_deps
    echo ""
    echo "初始化完成。"
  else
    echo "初始化补齐完成。"
  fi
  echo "  启动:   ./start.sh start"
  echo "  停止:   ./start.sh stop"
  echo "  状态:   http://127.0.0.1:${NEST_GATEWAY_PORT:-8009}"
  echo
}

run_nest_start() {
  if [[ ! -f "${NEST_DIST}" ]]; then
    echo "[nest] dist/main.js not found — run 'cd nest_gateway && npm run build' first" >&2
    exit 1
  fi
  # 大图库首轮全量摄入 + stats 汇总重建需较大堆(实测 98K 图默认 4GB 堆 OOM);
  # 用户可通过环境变量 NODE_OPTIONS 覆盖
  if [[ -z "${NODE_OPTIONS:-}" ]]; then
    export NODE_OPTIONS="--max-old-space-size=8192"
  fi
  echo "[nest] Starting NestJS Gateway on :${NEST_GATEWAY_PORT}..."
  cd "${PROJECT_ROOT}"
  node "${NEST_DIST}"
}

stop_existing_workflow_db() {
  local pids
  pids="$(pgrep -f 'nest_gateway/dist/main' 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "[stop] Stopping NestJS Gateway process(es): ${pids}"
    for pid in ${pids}; do
      kill "${pid}" 2>/dev/null || true
    done
    sleep 1
    pids="$(pgrep -f 'nest_gateway/dist/main' 2>/dev/null || true)"
    if [[ -n "${pids}" ]]; then
      for pid in ${pids}; do
        kill -9 "${pid}" 2>/dev/null || true
      done
    fi
  else
    echo "[stop] No running NestJS Gateway process found."
  fi
}

run_stop() {
  stop_existing_workflow_db
}

main() {
  local cmd="${1:-start}"
  if [[ $# -lt 1 ]]; then
    echo "未指定命令,默认执行 start(检查 → 缺失自动初始化 → 启动;帮助: ./start.sh help)" >&2
  fi

  case "${cmd}" in
    setup)
      ensure_project_root
      enter_project_root
      load_defaults
      invoke_setup 0
      ;;
    check)
      run_check
      ;;
    start)
      ensure_project_root
      enter_project_root
      load_defaults
      print_context
      echo
      if ! ensure_deps; then
        # 门禁失败自动补齐:node/venv/npm 依赖类问题由 setup 幂等修复后重试;
        # Mongo 不可达、扫描根不存在等无法修复的问题重跑门禁仍失败即退出
        echo ""
        echo "依赖检查未通过,自动执行初始化补齐(setup)..."
        echo ""
        invoke_setup 1
        echo ""
        if ! ensure_deps; then
          echo "Start aborted - fix the FAIL items above and re-run." >&2
          exit 1
        fi
      fi
      # 可选依赖检查(ComfyUI 可达性等)后台执行:输出直接进终端,与网关日志交错,不阻塞启动
      check_optional_deps &
      # 网关就绪后自动用默认浏览器打开工具页:后台轮询,不阻塞日志流;
      # WORKFLOW_DB_AUTO_OPEN=0 关闭;绑定地址为通配时按回环访问
      if [[ "${WORKFLOW_DB_AUTO_OPEN:-1}" == "1" ]]; then
        (
          open_host="${WORKFLOW_DB_BIND_HOST:-127.0.0.1}"
          case "${open_host}" in
            "" | "0.0.0.0" | "::") open_host="127.0.0.1" ;;
          esac
          url="http://${open_host}:${NEST_GATEWAY_PORT}/"
          for _ in $(seq 1 180); do
            if check_url "${url}"; then
              if command -v xdg-open >/dev/null 2>&1; then
                xdg-open "${url}" >/dev/null 2>&1 || true
                echo "[open] 已在默认浏览器打开 ${url}"
              else
                echo "[open] 未找到 xdg-open,请手动访问 ${url}"
              fi
              exit 0
            fi
            sleep 0.5
          done
          echo "[open] 等待网关就绪超时(90s),未自动打开浏览器 - 手动访问 ${url}" >&2
        ) &
      fi
      run_nest_start
      ;;
    stop)
      run_stop
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      echo "Unknown command: ${cmd}" >&2
      echo >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
