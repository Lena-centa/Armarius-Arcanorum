"""nodes_parse CLI 入口。

用法（Git Bash，务必用 python 而非 python3）：
    python -m utils.nodes_parse.cli fetch-index [--refresh]
    python -m utils.nodes_parse.cli known
    python -m utils.nodes_parse.cli extract [--limit N] [--repos o/r,o/r] [--fetch-all] [--refresh]
    python -m utils.nodes_parse.cli fingerprint
    python -m utils.nodes_parse.cli rebuild-cache  # 仅用 defs/，不访问网络
    python -m utils.nodes_parse.cli reanalyze-cache  # 重跑本地源码静态分析，不访问网络
    python -m utils.nodes_parse.cli live-registry --url http://host:8188
    python -m utils.nodes_parse.cli report [--fixtures-dir DIR]
    python -m utils.nodes_parse.cli all          # 顺序执行以上全部

产物默认在 temp/coverage_audit/（gitignored）。
"""
import argparse
import sys
from pathlib import Path

from .common import DEFAULT_WORKDIR, REPO_ROOT, ensure_dir, log, save_json


def select_repos(ecosystem, limit: int, fetch_all: bool):
    """按仓库声明的关键档（生成链相关）class_type 数量降序选仓；
    清单无星标数据，数量即热度代理。"""
    if fetch_all:
        return sorted({
            slug
            for repos in ecosystem["class_types"].values() for slug in repos
        })
    score = {}
    for ct, repos in ecosystem["class_types"].items():
        lowered = ct.lower()
        if not any(kw in lowered for kw in (
            "loader", "sampler", "ksampler", "text", "prompt", "condition",
            "controlnet", "lora", "clip", "latent", "seed", "guider", "wildcard")):
            continue
        for slug in repos:
            score[slug] = score.get(slug, 0) + 1
    ranked = sorted(score, key=lambda s: (-score[s], s))
    return ranked[:limit]


def main(argv=None):
    parser = argparse.ArgumentParser(prog="nodes_parse", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--workdir", type=Path, default=DEFAULT_WORKDIR)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("fetch-index")
    p_known = sub.add_parser("known")
    p_extract = sub.add_parser("extract")
    p_extract.add_argument("--limit", type=int, default=120)
    p_extract.add_argument("--repos", type=str, default="",
                           help="逗号分隔 owner/name，覆盖自动选仓")
    p_extract.add_argument("--fetch-all", action="store_true")
    p_extract.add_argument("--refresh", action="store_true")
    p_fingerprint = sub.add_parser("fingerprint")
    p_fingerprint.add_argument(
        "--repos", type=str, default="",
        help="逗号分隔 owner/name；省略时重算全部定义",
    )
    sub.add_parser("rebuild-cache")
    p_reanalyze = sub.add_parser("reanalyze-cache")
    p_reanalyze.add_argument(
        "--repos", type=str, default="",
        help="逗号分隔 owner/name；省略时重跑全部本地源码",
    )
    p_live = sub.add_parser("live-registry")
    p_live.add_argument("--url", required=True, help="ComfyUI base URL")
    p_live.add_argument("--timeout", type=float, default=60.0)
    p_report = sub.add_parser("report")
    p_report.add_argument("--fixtures-dir", type=Path, default=None)
    sub.add_parser("all")

    args = parser.parse_args(argv)
    workdir = ensure_dir(args.workdir)

    from . import coverage, ext_extract, fingerprint, index_fetch, known_universe

    if args.cmd in ("fetch-index", "all"):
        index = index_fetch.fetch_index(workdir)
        ecosystem = index_fetch.build_ecosystem(index)
        save_json(workdir / "ecosystem.json", ecosystem)
        log(f"[index] 生态 {ecosystem['class_type_count']} class_type / "
            f"{ecosystem['repo_count']} 仓库（pattern 键 {len(ecosystem['pattern_keys'])}）")

    if args.cmd in ("known", "all"):
        universe = known_universe.build_known_universe(save_to=workdir / "known_universe.json")
        log(f"[known] 精确已知 {len(universe['exact'])}，lower 归一 "
            f"{universe['known_lower_count']}，hint 关键词 "
            f"{len(universe['hint_keywords'])}")
        if universe["missing_anchors"]:
            log(f"[known][warn] 未命中的验收锚点：{universe['missing_anchors']}")

    if args.cmd in ("extract", "all"):
        ecosystem = load_eco(workdir)
        if args.repos:
            slugs = [s for s in (x.strip() for x in args.repos.split(",")) if s]
        else:
            slugs = select_repos(ecosystem, args.limit, args.fetch_all)
        log(f"[extract] 目标仓库 {len(slugs)} 个")
        ext_extract.fetch_and_extract(slugs, workdir, refresh=args.refresh)

    if args.cmd in ("fingerprint", "all"):
        repos_arg = getattr(args, "repos", "")
        repos = {
            item for item in (part.strip() for part in repos_arg.split(",")) if item
        }
        fingerprint.attach_fingerprints(workdir, repos or None)

    if args.cmd == "rebuild-cache":
        ext_extract.rebuild_from_cache(workdir)

    if args.cmd == "reanalyze-cache":
        repos = {
            item for item in (part.strip() for part in args.repos.split(",")) if item
        }
        ext_extract.reanalyze_local_repos(workdir, repos or None)

    if args.cmd == "live-registry":
        from .live_registry import capture_runtime_registry
        from .common import load_json
        path = capture_runtime_registry(args.url, workdir, timeout=args.timeout)
        summary = load_json(path)["summary"]
        log(f"[live] 已生成 {path}")
        log(
            "[live] 运行时定义 "
            f"{summary['runtime_definition_total']} / "
            f"行为已解析 {summary['behavior_resolved']} "
            f"({summary['behavior_resolved_coverage']:.1%}) / "
            f"静态契约已附着 {summary['static_behavior_contracts']}"
        )

    if args.cmd in ("report", "all"):
        fixtures_dir = args.fixtures_dir or (
            REPO_ROOT / "nest_gateway" / "test" / "__fixtures__" / "records")
        path = coverage.build_report(workdir, fixtures_dir)
        log(f"[report] 已生成 {path}")

    if args.cmd == "fetch-index":
        ecosystem = load_eco(workdir)
        top = sorted(ecosystem["class_types"].items(),
                     key=lambda kv: -len(kv[1]))[:10]
        log("[index] 关联仓库最多的 class_type TOP10：")
        for ct, repos in top:
            log(f"  {ct}: {len(repos)}")
    return 0


def load_eco(workdir: Path):
    from .common import load_json
    eco_path = workdir / "ecosystem.json"
    if not eco_path.exists():
        log("[error] 缺少 ecosystem.json，请先运行 fetch-index")
        sys.exit(2)
    return load_json(eco_path)


if __name__ == "__main__":
    raise SystemExit(main())
