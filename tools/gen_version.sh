#!/usr/bin/env bash
# 版本号生成器:开发分支输出内部版本号,release/* 分支输出公开版本号。
#
#   内部号: <base>-YYYYMMDD-<branch-slug>-HHMMSS
#           例 0.1.0-20260907-feature-nest-gateway-143052
#           (slug 归一:/ _ . 一律转 -,保证是合法 semver prerelease 段;
#            下划线不被 semver 允许)
#   公开号: package.json 的 version 原样(如 0.1.0-beta.1)
#
# 用法:
#   tools/gen_version.sh                 输出版本号
#   tools/gen_version.sh --json          输出 JSON(version/kind/base/branch),
#                                        供 releng 的 release.py 打包命名消费
#   tools/gen_version.sh --apply-frontend  把当前版本号写入全部静态页 ?v=
#                                        (发布/部署动作的一部分,平时代码改动不需要跑)
#   tools/gen_version.sh --apply-package   把版本号写回 nest_gateway/package.json
#
# base 版本取 nest_gateway/package.json 的 version 剥 prerelease 段
# (0.1.0-beta.1 -> 0.1.0),所以升 base 只需改 package.json 一处。

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
PKG="nest_gateway/package.json"

pkg_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PKG" | head -1
}

base_version() {
  pkg_version | cut -d- -f1
}

branch_name() {
  # GEN_VERSION_BRANCH 仅测试/CI 用:覆盖分支名,避免为验证 release
  # 场景而真实切换分支(工作树含运行中的数据库文件,切换有损坏风险)
  if [ -n "${GEN_VERSION_BRANCH:-}" ]; then
    echo "$GEN_VERSION_BRANCH"
  else
    git rev-parse --abbrev-ref HEAD
  fi
}

branch_slug() {
  branch_name | tr '[:upper:]' '[:lower:]' | sed 's#[/_.]#-#g'
}

is_release_branch() {
  # main 是远程推送分支,与 release/* 同用公开号
  case "$(branch_name)" in release/*|main) return 0 ;; *) return 1 ;; esac
}

version_kind() {
  if is_release_branch; then echo public; else echo internal; fi
}

full_version() {
  if is_release_branch; then
    pkg_version
  else
    local ts slug
    ts="$(date +%Y%m%d-%H%M%S)"
    slug="$(branch_slug)"
    echo "$(base_version)-${ts%%-*}-${slug}-${ts##*-}"
  fi
}

# 前端缓存串统一替换:全部 ?v= 写为当前版本号(公开分支即公开号),
# 根治手写日期串漏 bump;产出的工作树改动随发布提交入库。
apply_frontend() {
  local v files
  v="$(full_version)"
  files="$(ls workflow_db/static/*.html)"
  for f in $files; do
    sed -i -E "s/(\?v=)[^\"']*/\1${v}/g" "$f"
  done
  echo "frontend ?v= -> ${v}"
  echo "${files}" | sed 's/^/  /'
}

apply_package() {
  local v
  v="$(full_version)"
  VERSION="$v" node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version=process.env.VERSION;fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');" "$PKG"
  echo "package.json version -> ${v}"
}

case "${1:-}" in
  --json)
    printf '{"version":"%s","kind":"%s","base":"%s","branch":"%s"}\n' \
      "$(full_version)" "$(version_kind)" "$(base_version)" "$(branch_name)"
    ;;
  --apply-frontend) apply_frontend ;;
  --apply-package) apply_package ;;
  "") full_version ;;
  *)
    echo "usage: tools/gen_version.sh [--json|--apply-frontend|--apply-package]" >&2
    exit 2
    ;;
esac
