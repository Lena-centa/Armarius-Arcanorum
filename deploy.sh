#!/usr/bin/env bash
# ============================================================================
# Workflow DB 一键部署(Linux / WSL)— 空白机器 → 启动
#
# 流程:
#   [1/5] 环境预检:已存在的依赖直接复用,仅缺失项安装(零侵入)
#   [2/5] 代码获取:git clone(--repo) / 发布 zip(--zip 或同目录 *.zip)
#   [3/5] 部署预检汇总
#   [4/5] ./setup.sh 初始化(venv + npm + .env + 自检,幂等)
#   [5/5] ./start.sh start 前台启动
#
# 用法:
#   ./deploy.sh                          # 已在仓库内:引导缺失依赖 → 部署 → 启动
#   ./deploy.sh --repo <url>             # 空白机器:git clone 后部署
#   ./deploy.sh --zip <release.zip>      # 空白机器:解压发布包后部署(离线可用)
#   ./deploy.sh --target <dir>           # 部署目标目录(默认:脚本所在目录)
#   ./deploy.sh check                    # 仅预检(不安装 / 不部署)
#   ./deploy.sh -h
#
# 环境变量覆盖:
#   NODE_VERSION       便携 Node 版本(默认 v22.23.2,better-sqlite3 预编译覆盖)
#   NODE_DIST_MIRROR   Node 下载镜像(默认 npmmirror 国内镜像)
#   PIP_INDEX_URL      pip 源(默认清华镜像,透传 setup.sh)
#   NPM_REGISTRY       npm 源(默认 npmmirror,透传 setup.sh)
#   TARGET_DIR         部署目标目录(等价 --target)
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NODE_VERSION="${NODE_VERSION:-v22.23.2}"
NODE_DIST_MIRROR="${NODE_DIST_MIRROR:-https://registry.npmmirror.com/-/binary/node}"
NODE_PORTABLE_DIR="${HOME}/.local/node22"
NODE_PORTABLE_BIN="${NODE_PORTABLE_DIR}/bin"
NODE_PORTABLE_URL="${NODE_DIST_MIRROR}/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.gz"

REPO_URL=""
ZIP_PATH=""
TARGET_DIR="${TARGET_DIR:-${SCRIPT_DIR}}"
COMMAND="deploy"

declare -a SUMMARY=()
MISS_FLAG=0

usage() {
  cat <<'EOF'
用法:
  ./deploy.sh                          # 已在仓库内:引导缺失依赖 → 部署 → 启动
  ./deploy.sh --repo <url>             # 空白机器:git clone 后部署
  ./deploy.sh --zip <release.zip>      # 空白机器:解压发布包后部署(离线可用)
  ./deploy.sh --target <dir>           # 部署目标目录(默认:脚本所在目录)
  ./deploy.sh check                    # 仅预检(不安装 / 不部署)

环境变量覆盖:
  NODE_VERSION   便携 Node 版本(默认 v22.23.2)
EOF
  exit 0
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo)   REPO_URL="$2"; shift 2 ;;
      --zip)    ZIP_PATH="$2"; shift 2 ;;
      --target) TARGET_DIR="$2"; shift 2 ;;
      check)    COMMAND="check"; shift ;;
      -h|--help) usage ;;
      *) echo "未知参数: $1" >&2; usage ;;
    esac
  done
}

note() {
  [[ "$1" == "MISS" ]] && MISS_FLAG=1
  SUMMARY+=("$(printf '%-5s %-18s %s' "$1" "$2" "$3")")
}

SUDO=()
if [[ "$(id -u)" -ne 0 ]]; then SUDO=(sudo); fi

PKG_MGR=""
detect_pkg_mgr() {
  if   command -v apt-get >/dev/null 2>&1; then PKG_MGR="apt"
  elif command -v dnf     >/dev/null 2>&1; then PKG_MGR="dnf"
  elif command -v pacman  >/dev/null 2>&1; then PKG_MGR="pacman"
  elif command -v apk     >/dev/null 2>&1; then PKG_MGR="apk"
  fi
}

pkg_install() {
  local names=("$@")
  if [[ -z "${PKG_MGR}" ]]; then
    echo "  FAIL: 未识别包管理器(apt/dnf/pacman/apk),请手动安装: ${names[*]}" >&2
    exit 1
  fi
  case "${PKG_MGR}" in
    apt)
      "${SUDO[@]}" apt-get update -qq
      "${SUDO[@]}" apt-get install -y -qq --no-install-recommends "${names[@]}" >/dev/null
      ;;
    dnf)     "${SUDO[@]}" dnf install -y "${names[@]}" >/dev/null ;;
    pacman)  "${SUDO[@]}" pacman -S --noconfirm --needed "${names[@]}" >/dev/null ;;
    apk)     "${SUDO[@]}" apk add --no-cache "${names[@]}" >/dev/null ;;
  esac
  echo "  OK: 已安装 ${names[*]}"
}

net_ok() {
  (exec 3<>"/dev/tcp/$1/${2:-443}") 2>/dev/null
}

port_8009_busy() {
  (exec 3<>/dev/tcp/127.0.0.1/8009) 2>/dev/null
}

# ---------------------------------------------------------------------------
# [1/5] 环境预检
# ---------------------------------------------------------------------------
check_core_tools() {
  local missing=() pkg
  for pkg in git curl unzip python3; do
    if ! command -v "${pkg}" >/dev/null 2>&1; then missing+=("${pkg}"); fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "  INSTALL: 系统工具缺失: ${missing[*]}"
    if [[ "${COMMAND}" == "check" ]]; then
      note "MISS" "系统工具" "${missing[*]} 需系统包安装"
      return
    fi
    pkg_install "${missing[@]}"
    note "NEW" "系统工具" "${missing[*]}"
  else
    note "OK" "系统工具" "git/curl/unzip/python3 齐备"
  fi
}

check_node() {
  local bin ver major
  # 1) 便携 node 优先(与 Windows 便携机制对称)
  if [[ -x "${NODE_PORTABLE_BIN}/node" ]]; then
    export PATH="${NODE_PORTABLE_BIN}:${PATH}"
    ver="$("${NODE_PORTABLE_BIN}/node" --version)"
    echo "  OK: node ${ver}(便携 ${NODE_PORTABLE_DIR})"
    note "OK" "Node" "${ver}(便携,复用)"
    return 0
  fi
  # 2) PATH 已有
  if command -v node >/dev/null 2>&1; then
    ver="$(node --version)"
    major="${ver#v}"; major="${major%%.*}"
    case "${major}" in
      22|24|25|26)
        echo "  OK: node ${ver}(PATH,复用)"
        note "OK" "Node" "${ver}(PATH,复用)"
        return 0 ;;
      20|23)
        echo "  WARNING: node ${ver} 无 better-sqlite3 预编译,可能触发本地编译(需 C++ 工具链);建议 Node 22 LTS" >&2
        note "OK" "Node" "${ver}(PATH,复用,无预编译)"
        return 0 ;;
      *)
        echo "  WARNING: PATH node ${ver} 过旧,将改用便携 node ${NODE_VERSION}" >&2
        note "REPL" "Node" "${ver}(PATH)→便携"
        ;;
    esac
  fi
  # 3) 安装便携 node
  if [[ "${COMMAND}" == "check" ]]; then
    note "MISS" "Node" "便携 node ${NODE_VERSION}"
    return 0
  fi
  install_portable_node
  note "NEW" "Node" "便携 ${NODE_VERSION} → ${NODE_PORTABLE_DIR}"
}

install_portable_node() {
  [[ -x "${NODE_PORTABLE_BIN}/node" ]] && return 0
  local mirror_host
  mirror_host="$(printf '%s' "${NODE_DIST_MIRROR}" | sed -E 's|^https?://([^/]+).*|\1|')"
  if ! net_ok "${mirror_host}"; then
    echo "  FAIL: 无法访问 ${mirror_host} — 离线机器请预装 Node,或改用 --zip 流程" >&2
    exit 1
  fi
  local tmp tarball
  tmp="$(mktemp -d)"
  tarball="${tmp}/node.tar.gz"
  echo "  下载 ${NODE_PORTABLE_URL} ..."
  curl -fsSL -o "${tarball}" "${NODE_PORTABLE_URL}"
  mkdir -p "${NODE_PORTABLE_DIR}"
  rm -rf "${NODE_PORTABLE_DIR}"/* 2>/dev/null || true
  tar -xzf "${tarball}" -C "${tmp}"
  mv "${tmp}"/node-${NODE_VERSION}-linux-x64/* "${NODE_PORTABLE_DIR}"/
  rm -rf "${tmp}"
  export PATH="${NODE_PORTABLE_BIN}:${PATH}"
  echo "  OK: node $("${NODE_PORTABLE_BIN}/node" --version) 已安装"
  # 持久化 PATH(新终端生效),保证后续 start.sh 可用
  if ! grep -qF "${NODE_PORTABLE_BIN}" "${HOME}/.bashrc" 2>/dev/null; then
    printf '\n# Workflow DB portable node\nexport PATH="%s:$PATH"\n' "${NODE_PORTABLE_BIN}" >> "${HOME}/.bashrc"
    echo "  INFO: 已写入 ~/.bashrc(PATH 对新终端永久生效)"
  fi
}

check_python() {
  if command -v python3 >/dev/null 2>&1 \
    && python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    echo "  OK: python3 $(python3 --version 2>&1 | awk '{print $2}')"
    note "OK" "Python" "python3 $(python3 --version 2>&1 | awk '{print $2}')(复用)"
  else
    echo "  INSTALL: Python 3.10+"
    if [[ "${COMMAND}" == "check" ]]; then
      note "MISS" "Python" "python3 ≥3.10"
      return
    fi
    pkg_install python3
    if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      echo "  FAIL: 系统包 python3 仍 <3.10 — 请升级发行版或用 deadsnakes PPA 安装 python3.10+" >&2
      exit 1
    fi
    note "NEW" "Python" "系统包 python3"
  fi
  if python3 -c 'import venv' >/dev/null 2>&1; then
    note "OK" "venv 模块" "python3 -m venv 可用"
  else
    echo "  INSTALL: venv 模块(python3-venv)"
    if [[ "${COMMAND}" == "check" ]]; then
      note "MISS" "venv 模块" "python3-venv"
      return
    fi
    case "${PKG_MGR}" in
      apt)    pkg_install python3-venv ;;
      dnf)    pkg_install python3-pip ;;
      pacman) echo "  OK: 无需单独安装(python 自带 venv)" ;;
      apk)    pkg_install py3-pip ;;
    esac
    python3 -c 'import venv' >/dev/null 2>&1 || { echo "  FAIL: venv 模块安装失败" >&2; exit 1; }
    note "NEW" "venv 模块" "python3-venv"
  fi
}

# ---------------------------------------------------------------------------
# [2/5] 代码获取
# ---------------------------------------------------------------------------
acquire_code() {
  local repo="${REPO_URL}" zip_file="" zips=()
  # 已有部署 → 复用(start.sh 为发布包唯一入口脚本,存在即视为已获取)。
  # 旧入口名 run_workflow_db.sh 已移除,不再识别。
  if [[ -f "${TARGET_DIR}/start.sh" ]]; then
    echo "  OK: ${TARGET_DIR} 已有部署(start.sh 存在),跳过代码获取"
    note "OK" "代码" "已存在,复用"
    return 0
  fi
  # 来源解析:--repo > --zip > 同目录 *.zip;无来源则报错
  if [[ -z "${REPO_URL}" && -z "${ZIP_PATH}" ]]; then
    mapfile -t zips < <(ls "${SCRIPT_DIR}"/*.zip 2>/dev/null || true)
    if [[ ${#zips[@]} -eq 1 ]]; then
      zip_file="${zips[0]}"
    elif [[ ${#zips[@]} -gt 1 ]]; then
      echo "  FAIL: 本目录发现多个发布包,请用 --zip 指定: ${zips[*]}" >&2
      exit 1
    fi
  fi
  [[ -n "${ZIP_PATH}" ]] && zip_file="${ZIP_PATH}"
  if [[ -z "${repo}" && -z "${zip_file}" ]]; then
    echo "  FAIL: 未指定代码来源 — 请用 --repo <url> 或 --zip <发布包>;或在仓库目录内直接运行本脚本" >&2
    exit 1
  fi

  if [[ -n "${repo}" ]]; then
    if ! command -v git >/dev/null 2>&1; then
      echo "  INSTALL: git"
      if [[ "${COMMAND}" == "check" ]]; then
        note "MISS" "git" "git clone 需要"
        return 0
      fi
      pkg_install git
      note "NEW" "git" "系统包"
    else
      note "OK" "git" "$(git --version 2>/dev/null || true)"
    fi
    if ! net_ok github.com; then
      echo "  FAIL: 无法访问 github.com — 离线机器请改用 --zip 或预装依赖" >&2
      exit 1
    fi
    if [[ -d "${TARGET_DIR}" && -n "$(ls -A "${TARGET_DIR}" 2>/dev/null || true)" ]]; then
      echo "  FAIL: 目标目录非空: ${TARGET_DIR}" >&2
      echo "        请用 --target 指定空目录,或在仓库内直接运行本脚本" >&2
      exit 1
    fi
    echo "  INSTALL: git clone ${repo} → ${TARGET_DIR}"
    git clone "${repo}" "${TARGET_DIR}"
    note "NEW" "代码" "git clone ${repo}"
  else
    if ! command -v unzip >/dev/null 2>&1; then
      echo "  INSTALL: unzip"
      if [[ "${COMMAND}" == "check" ]]; then
        note "MISS" "unzip" "解压发布包需要"
        return 0
      fi
      pkg_install unzip
    fi
    mkdir -p "${TARGET_DIR}"
    # zip-slip 防护(OPS-02):解压前枚举条目,拒绝 .. 穿越(含反斜杠形式)/
    # 绝对路径 / 盘符条目。采用拒绝式校验(fail-closed),与 deploy.ps1 的逐条
    # 校验对齐:发布包由 release.sh 自产,合法条目不会命中;一旦命中即视为
    # 包被篡改,中止部署,避免覆盖部署机任意文件
    local slip
    slip="$(unzip -Z1 "${zip_file}" 2>/dev/null | grep -E '(^|[\\/])\.\.([\\/]|$)|^/|^[A-Za-z]:' || true)"
    if [[ -n "${slip}" ]]; then
      echo "  FAIL: 发布包含越界条目(zip-slip),已拒绝解压:" >&2
      printf '%s\n' "${slip}" | head -20 >&2
      exit 1
    fi
    echo "  INSTALL: 解压 ${zip_file} → ${TARGET_DIR}"
    unzip -qo "${zip_file}" -d "${TARGET_DIR}"
    note "NEW" "代码" "解压发布包 ${zip_file}"
  fi
  [[ -f "${TARGET_DIR}/start.sh" ]] || { echo "  FAIL: 代码获取后未找到 start.sh" >&2; exit 1; }
}

print_summary() {
  echo
  echo "================================================"
  echo " 部署预检汇总(OK 复用 / NEW 新装 / REPL 替换 / MISS 缺失)"
  echo "================================================"
  printf '  %-5s %-18s %s\n' "状态" "项目" "说明"
  for line in "${SUMMARY[@]}"; do
    printf '  %s\n' "${line}"
  done
  echo "================================================"
}

main() {
  parse_args "$@"
  detect_pkg_mgr

  echo "================================================"
  echo " Workflow DB 一键部署(Linux / WSL)"
  echo " 目标目录: ${TARGET_DIR}"
  echo "================================================"

  echo
  echo "[1/5] 环境预检(存在即复用,仅装缺失)"
  check_core_tools
  check_node
  check_python
  if port_8009_busy; then
    echo "  WARNING: 8009 端口已被占用 — 启动前请改 NEST_GATEWAY_PORT" >&2
    note "WARN" "端口 8009" "已被占用"
  else
    note "OK" "端口 8009" "空闲"
  fi

  echo
  echo "[2/5] 代码获取"
  acquire_code

  print_summary
  if [[ "${COMMAND}" == "check" ]]; then
    echo "预检完成(check 模式,未安装 / 未部署)"
    [[ "${MISS_FLAG}" -eq 1 ]] && exit 1 || exit 0
  fi

  echo
  echo "[4/5] 初始化 (cd ${TARGET_DIR} && ./start.sh setup)"
  (cd "${TARGET_DIR}" && ./start.sh setup)

  echo
  echo "[5/5] 启动 (cd ${TARGET_DIR} && ./start.sh start)"
  (cd "${TARGET_DIR}" && ./start.sh start)
}

main "$@"
