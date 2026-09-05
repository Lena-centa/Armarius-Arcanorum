#!/usr/bin/env bash
# ============================================================================
# 构建 Linux 发布运行时(runtime/ 目录)— 与 tools/windows/build_runtime.ps1 对应
#
# 目标:在 Linux/WSL 构建机打包已验证环境(便携 node22 + 便携 python + venv
#       + nest_gateway node_modules),供 Linux 目标机/容器离线部署。
# 注意:Windows 与 Linux runtime 互不兼容(node/python/venv/node_modules 均
# 平台绑定,尤其 better-sqlite3 预编译 ABI 不同),必须分别构建、分别打包
# (release.sh 按 RUNTIME.json 的 platform 字段校验)。
#
# 产物(仓库根 runtime/,已 gitignore):
#   runtime/node22/        便携 node(官方 tar.xz:bin/node + lib/node_modules/npm)
#   runtime/python312/     python-build-standalone(install_only,可搬迁)
#   runtime/venv/          python312 创建的 venv(已装 requirements.txt)
#   runtime/node_modules/  nest_gateway 生产依赖(ABI 匹配 linux node22)
#   runtime/RUNTIME.json   清单:版本/组件/构建时间/platform=linux
#
# 用法(在仓库根执行):
#   tools/linux/build_runtime.sh
# 可选环境变量:
#   NODE_VERSION=v22.23.2       node 版本(默认 v22.23.2)
#   PY_VERSION=3.12.13          python 版本(默认自动取最新 3.12.x)
#   PY_TARBALL_PATH=/path/x.tar.gz  预下载的 python-build-standalone 包
#   NPM_REGISTRY=...            npm 源(默认 npmmirror)
#   PIP_INDEX_URL=...           pip 源(默认清华)
# ============================================================================
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"

NODE_VERSION="${NODE_VERSION:-v22.23.2}"
PY_VERSION="${PY_VERSION:-}"
PY_TARBALL_PATH="${PY_TARBALL_PATH:-}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
RUNTIME_DIR="${ROOT}/runtime"
NODE_DIR="${RUNTIME_DIR}/node22"
NODE_BIN="${NODE_DIR}/bin/node"
PY_DIR="${RUNTIME_DIR}/python312"
VENV_DIR="${RUNTIME_DIR}/venv"
NM_DIR="${RUNTIME_DIR}/node_modules"

echo "================================================"
echo " 构建 Linux 发布运行时 → ${RUNTIME_DIR}"
echo " node: ${NODE_VERSION} | python: ${PY_VERSION:-<auto 3.12.x>}"
echo "================================================"
mkdir -p "${RUNTIME_DIR}"

# ---------------------------------------------------------------------------
# 1. 便携 node(linux-x64,npmmirror)
# ---------------------------------------------------------------------------
echo "[1/4] 便携 node"
if [[ -x "${NODE_BIN}" ]]; then
    echo "  复用已有 ${NODE_DIR}"
else
    URL="https://registry.npmmirror.com/-/binary/node/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz"
    TMP="$(mktemp -d)"
    trap 'rm -rf "${TMP}"' EXIT
    echo "  下载 ${URL}"
    curl -fSL --retry 3 -o "${TMP}/node.tar.xz" "${URL}"
    tar -xJf "${TMP}/node.tar.xz" -C "${TMP}"
    mv "${TMP}/node-${NODE_VERSION}-linux-x64" "${NODE_DIR}"
    echo "  解压 → ${NODE_DIR}"
fi
echo "  OK: $("${NODE_BIN}" --version)"

# ---------------------------------------------------------------------------
# 2. 便携 python(python-build-standalone install_only,可搬迁)
# ---------------------------------------------------------------------------
echo "[2/4] 便携 python"
if [[ -x "${PY_DIR}/bin/python3" ]]; then
    echo "  复用已有 ${PY_DIR}"
else
    if [[ -z "${PY_TARBALL_PATH}" ]]; then
        echo "  查询 python-build-standalone 最新 release..."
        LATEST="$(curl -fsSL --retry 3 https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest)"
        if [[ -z "${PY_VERSION}" ]]; then
            PY_VERSION="$(echo "${LATEST}" | python3 -c '
import json, sys, re
d = json.load(sys.stdin)
names = [a["name"] for a in d.get("assets", [])
         if "x86_64-unknown-linux-gnu-install_only.tar.gz" in a["name"]
         and re.match(r"cpython-3\.12\.\d+\+", a["name"])]
if not names:
    sys.exit("未找到 3.12.x install_only 资产,请用 PY_VERSION 指定或手动下载 PY_TARBALL_PATH")
names.sort(key=lambda n: tuple(map(int, re.findall(r"\d+", re.search(r"cpython-3\.12\.\d+", n).group(0)))))
print(re.search(r"cpython-3\.12\.\d+", names[-1]).group(0).replace("cpython-", ""))
')"
        fi
        ASSET="$(echo "${LATEST}" | python3 -c "
import json, sys, re
d = json.load(sys.stdin)
ver = '${PY_VERSION}'
for a in d.get('assets', []):
    if a['name'].endswith('x86_64-unknown-linux-gnu-install_only.tar.gz') and a['name'].startswith('cpython-' + ver + '+'):
        print(a['browser_download_url'])
        break
else:
    sys.exit('未找到资产: cpython-${PY_VERSION}+* install_only')
")"
        echo "  下载 ${ASSET}"
        curl -fSL --retry 3 -o "${RUNTIME_DIR}/python.tgz" "${ASSET}"
        PY_TARBALL_PATH="${RUNTIME_DIR}/python.tgz"
    fi
    mkdir -p "${PY_DIR}"
    tar -xzf "${PY_TARBALL_PATH}" -C "${PY_DIR}" --strip-components=1
    rm -f "${RUNTIME_DIR}/python.tgz"
fi
PYTHON_BIN="$(ls "${PY_DIR}"/bin/python3.* | head -1)"
echo "  OK: $("${PYTHON_BIN}" --version)"

# ---------------------------------------------------------------------------
# 3. venv + Python 依赖
# ---------------------------------------------------------------------------
echo "[3/4] venv + Python 依赖"
if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
    "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi
"${VENV_DIR}/bin/pip" install -q -i "${PIP_INDEX_URL}" -r "${ROOT}/requirements.txt"
echo "  OK: venv 就绪"

# ---------------------------------------------------------------------------
# 3.5 runtime/wheels(离线安装兜底:setup 在无 runtime venv 时直接解包 *.whl
#     进 site-packages,免 pip;与 venv 同版本平台 wheel 齐备)
# ---------------------------------------------------------------------------
echo "[3.5/4] 离线 wheel 目录"
WHEEL_DIR="${RUNTIME_DIR}/wheels"
mkdir -p "${WHEEL_DIR}"
if ls "${WHEEL_DIR}"/numpy-*.whl >/dev/null 2>&1; then
    echo "  OK: numpy wheel 已存在,跳过"
else
    "${VENV_DIR}/bin/pip" download 'numpy>=2,<3' -d "${WHEEL_DIR}" --only-binary=:all: --no-deps -i "${PIP_INDEX_URL}"
    echo "  OK: numpy wheel 就绪"
fi

# ---------------------------------------------------------------------------
# 4. nest_gateway node_modules(在临时目录用 runtime node22 安装,ABI 匹配
#    linux;不触碰构建机自身的 node_modules,避免与 Windows runtime 互踩)
# ---------------------------------------------------------------------------
echo "[4/4] nest_gateway node_modules(linux ABI)"
if [[ -d "${NM_DIR}/better-sqlite3" ]]; then
    echo "  复用已有 ${NM_DIR}"
else
    TMP_NG="$(mktemp -d)"
    trap 'rm -rf "${TMP_NG}"' EXIT
    cp nest_gateway/package.json nest_gateway/package-lock.json "${TMP_NG}/"
    cd "${TMP_NG}"
    export PATH="${NODE_DIR}/bin:${PATH}"
    "${NODE_BIN}" "${NODE_DIR}/lib/node_modules/npm/bin/npm-cli.js" install \
        --omit=dev --no-audit --no-fund --registry "${NPM_REGISTRY}"
    mv "${TMP_NG}/node_modules" "${NM_DIR}"
    cd "${ROOT}"
fi
echo "  OK: node_modules 就绪"

# ---------------------------------------------------------------------------
# 5. 清单
# ---------------------------------------------------------------------------
MANIFEST='{
  "node":        "'"$("${NODE_BIN}" --version)"'",
  "python":      "'"$("${PYTHON_BIN}" --version)"'",
  "venv":        true,
  "node_modules": "'"$(test -d "${NM_DIR}/better-sqlite3" && echo true || echo false)"'",
  "platform":    "linux",
  "built_at":    "'"$(date -Iseconds)"'",
  "source":      "构建机已验证环境"
}'
echo "${MANIFEST}" | python3 -m json.tool > "${RUNTIME_DIR}/RUNTIME.json"
echo "  清单: ${RUNTIME_DIR}/RUNTIME.json"
echo "================================================"
echo " 构建完成。发布前确认 release.sh 会纳入 runtime/ 目录,"
echo " 且与 RUNTIME.json 的 platform 匹配(RUNTIME_PLATFORM=linux ./release.sh)。"
echo "================================================"
