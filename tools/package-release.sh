#!/usr/bin/env bash
# ============================================================================
# 发布打包(全新部署分发)— 可复现
#
# 产出:git archive HEAD 树 → 校验 dist 预构建存在 → 按排除清单生成 zip
# 用法:
#   ./tools/package-release.sh [版本标签]          # 默认 tag=git 短哈希
#   ./tools/package-release.sh 20260803           # 指定版本号
# 输出:<repo 父目录>/<项目名>_<tag>.zip(默认 /mnt/d/ 可传 OUT_DIR 覆盖)
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "FAIL: 当前目录不是 git 仓库,无法 git archive(请先 git init + 提交基线)" >&2
  exit 1
fi

TAG="${1:-$(git rev-parse --short HEAD)}"
PROJECT="$(basename "${ROOT}")"
OUT_DIR="${OUT_DIR:-/mnt/d}"
OUT="${OUT_DIR}/${PROJECT}_${TAG}.zip"

# 1. dist 预构建校验(开箱即用依赖它)
if [[ ! -f "nest_gateway/dist/main.js" ]]; then
  echo "FAIL: nest_gateway/dist/main.js 不存在 — 先执行 'cd nest_gateway && npm run build'" >&2
  exit 1
fi

# 2. 工作树必须干净(保证 git archive 内容 = 工作树)
if [[ -n "$(git status --porcelain)" ]]; then
  echo "WARN: 工作树有未提交改动,打包内容以 HEAD 为准;建议先提交" >&2
fi

# 3. git archive 到临时目录
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
git archive --format=tar HEAD | tar -x -C "${TMP}"
echo "  archive HEAD → ${TMP}"

# 4. 排除清单(与发布约定一致)
rm -rf \
  "${TMP}/node_modules" \
  "${TMP}/venv" \
  "${TMP}/.git" \
  "${TMP}/__pycache__" \
  "${TMP}/workflow_db/__pycache__" \
  "${TMP}/backup_"* \
  "${TMP}/.env" \
  "${TMP}/gray_workflow.sqlite3" \
  "${TMP}/gray_workflow.sqlite3-wal" \
  "${TMP}/gray_workflow.sqlite3-shm" \
  "${TMP}"/win_run*.log
find "${TMP}" -name "*.pyc" -delete 2>/dev/null || true

# 5. 打包
if command -v zip >/dev/null 2>&1; then
  (cd "${TMP}" && zip -qr "${OUT}" .)
else
  venv/bin/python - <<PYEOF || python3 - <<PYEOF2
import shutil
shutil.make_archive("${OUT%.zip}", "zip", "${TMP}")
PYEOF
PYEOF2
fi

# 6. 自检
FILES="$(find "${TMP}" -type f | wc -l)"
SIZE="$(du -sh "${OUT}" 2>/dev/null | awk '{print $1}')"
echo "  打包完成: ${OUT}"
echo "  文件数:   ${FILES}"
echo "  体积:     ${SIZE}"
echo "  含:       dist 预构建 / fixtures / tools / 双平台脚本"
echo "  排除:     node_modules / venv / .env / .git / 镜像库 / 日志"
