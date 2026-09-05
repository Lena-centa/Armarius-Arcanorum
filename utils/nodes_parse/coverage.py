"""阶段5：三方比对与覆盖度报告。

数据源：ecosystem.json（索引）、known_universe.json（parser 已知宇宙）、
node_defs.json（深度提取）、fixtures 的 workflow.node_type_counts（本地实测）。
"""
import json
from collections import Counter, defaultdict
from pathlib import Path

from .common import REPO_ROOT, load_json, save_json
from .known_universe import known_lower_set

DEFAULT_FIXTURES = REPO_ROOT / "nest_gateway" / "test" / "__fixtures__" / "records"

CRITICAL_KW = ("loader", "sampler", "ksampler", "text", "prompt", "condition",
               "controlnet", "lora", "clip", "latent", "seed", "guider",
               "model", "noise", "sigma", "switch", "wildcard")
BYPASS_KW = ("pipe", "reroute", "image", "mask", "upscale", "preview",
             "display", "show", "debug", "video", "audio", "xyz", "plot",
             "layout", "ui", "dev", "utils")

GENERATION_PORT_TYPES = {
    "MODEL", "CONDITIONING", "LATENT", "CLIP", "VAE", "CONTROL_NET",
    "SAMPLER", "SIGMAS", "GUIDER", "NOISE", "LORA_STACK",
}


def tier_of(class_type: str) -> str:
    lowered = class_type.lower()
    if any(kw in lowered for kw in CRITICAL_KW):
        return "critical"
    if any(kw in lowered for kw in BYPASS_KW):
        return "bypass"
    return "ignore"


def fixture_counts(fixtures_dir: Path):
    totals = Counter()
    files_scanned = 0
    for path in sorted(Path(fixtures_dir).glob("*.json")):
        if path.name == "sample.json":
            continue
        try:
            record = load_json(path)
        except Exception:
            continue
        counts = ((record.get("workflow") or {}).get("node_type_counts")) or {}
        if not counts:
            continue
        files_scanned += 1
        for ct, count in counts.items():
            totals[ct] += int(count)
    return totals, files_scanned


def fixture_semantic_evidence(fixtures_dir: Path, registry_artifact=None):
    """Map observed nodes to record fields directly or through their input edges."""
    try:
        from workflow_db.workflow_ir import NodeDefinitionRegistry
        registry = NodeDefinitionRegistry.from_artifact(registry_artifact)
    except Exception:  # noqa: BLE001 - evidence remains available without registry
        registry = None
    evidence = defaultdict(lambda: {
        "fixtures": set(), "direct_record_paths": set(),
        "upstream_record_paths": set(), "derived_paths": set(),
        "topology": set(), "definition_states": set(),
        "operations": set(), "outgoing_path_effects": set(),
    })
    for path in sorted(Path(fixtures_dir).glob("*.json")):
        if path.name == "sample.json":
            continue
        try:
            record = load_json(path)
        except Exception:
            continue
        raw_prompt = ((record.get("metadata") or {}).get("raw_prompt"))
        if isinstance(raw_prompt, str):
            try:
                prompt = json.loads(raw_prompt)
            except (TypeError, ValueError):
                continue
        else:
            prompt = raw_prompt
        if not isinstance(prompt, dict):
            continue

        record_paths = defaultdict(set)
        for item in (record.get("model") or {}).get("nodes") or []:
            if isinstance(item, dict) and item.get("node_id") is not None:
                record_paths[str(item["node_id"])].add("model.nodes")
        for item in (record.get("loras") or {}).get("items") or []:
            if isinstance(item, dict) and item.get("node_id") is not None:
                record_paths[str(item["node_id"])].add("loras.items")
        for item in record.get("samplers") or []:
            if isinstance(item, dict) and item.get("node_id") is not None:
                record_paths[str(item["node_id"])].add("samplers")
        latent = record.get("latent") or {}
        if latent.get("node_id") is not None:
            record_paths[str(latent["node_id"])].add("latent")
        for item in latent.get("sources") or []:
            if isinstance(item, dict) and item.get("node_id") is not None:
                record_paths[str(item["node_id"])].add("latent.sources")
        for branch in ("positive", "negative"):
            for item in (record.get("prompts") or {}).get(branch) or []:
                if isinstance(item, dict) and item.get("source_node_id") is not None:
                    record_paths[str(item["source_node_id"])].add(f"prompts.{branch}")

        def collect_business_ids(value, business_path):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key in {"node_id", "source_node_id"} and item is not None:
                        record_paths[str(item)].add(business_path)
                    collect_business_ids(item, f"{business_path}.{key}")
            elif isinstance(value, list):
                for index, item in enumerate(value):
                    collect_business_ids(item, f"{business_path}[{index}]")

        for business_field in ("model", "loras", "prompts", "samplers", "latent"):
            collect_business_ids(record.get(business_field), business_field)

        raw_workflow = ((record.get("metadata") or {}).get("raw_workflow"))
        if isinstance(raw_workflow, str):
            try:
                workflow = json.loads(raw_workflow)
            except (TypeError, ValueError):
                workflow = None
        else:
            workflow = raw_workflow
        try:
            from workflow_db.sampler_view import build_sampler_views
            from workflow_db.workflow_ir import WorkflowIR

            ir = WorkflowIR(
                prompt,
                workflow if isinstance(workflow, dict) else None,
                registry=registry,
            )
            views = build_sampler_views(
                prompt, workflow if isinstance(workflow, dict) else None
            )
        except Exception:  # noqa: BLE001 - evidence is additive, report must degrade
            ir = None
            views = []

        derived_ids = set()

        def collect_derived_ids(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if (key == "node_id" or key.endswith("_node_id")) and item is not None:
                        derived_ids.add(str(item))
                    collect_derived_ids(item)
            elif isinstance(value, list):
                for item in value:
                    collect_derived_ids(item)

        collect_derived_ids(views)

        for node_id, node in prompt.items():
            if not isinstance(node, dict):
                continue
            class_type = str(node.get("class_type") or "Unknown")
            row = evidence[class_type]
            row["fixtures"].add(path.name)
            row["direct_record_paths"].update(record_paths.get(str(node_id), ()))
            if str(node_id) in derived_ids:
                row["derived_paths"].add("sampler_view")
            if ir is not None:
                ast_node = ir.nodes.get(str(node_id))
                if ast_node is not None:
                    row["definition_states"].add(ast_node.definition.status)
                    row["operations"].add(ast_node.behavior.operation)
                row["outgoing_path_effects"].update(
                    edge.path_effect for edge in ir.outgoing_edges(str(node_id))
                )
                incoming = ir.incoming_edges(str(node_id))
                outgoing = ir.outgoing_edges(str(node_id))
                if not incoming and not outgoing:
                    row["topology"].add("isolated")
            inputs = node.get("inputs") or {}
            if not isinstance(inputs, dict):
                continue
            for field_name, value in inputs.items():
                if not isinstance(value, (list, tuple)) or len(value) < 2:
                    continue
                for record_path in record_paths.get(str(value[0]), ()):
                    row["upstream_record_paths"].add(f"{field_name}->{record_path}")

    return {
        class_type: {
            "fixture_count": len(row["fixtures"]),
            "direct_record_paths": sorted(row["direct_record_paths"]),
            "upstream_record_paths": sorted(row["upstream_record_paths"]),
            "derived_paths": sorted(row["derived_paths"]),
            "topology": sorted(row["topology"]),
            "definition_states": sorted(row["definition_states"]),
            "operations": sorted(row["operations"]),
            "outgoing_path_effects": sorted(row["outgoing_path_effects"]),
        }
        for class_type, row in sorted(evidence.items())
    }


def _derived_role_check(records):
    try:
        import workflow_db.sampler_view as sv
    except Exception:
        return None
    rows = []
    for record_id, rec in sorted(records.items()):
        ct = str(rec.get("class_type") or record_id)
        role = sv._role_from_class_type(ct.lower())
        fields = set()
        for section in (rec.get("inputs") or {}).values():
            fields |= set(section.keys())
        field_roles = {name: sv.classify_input(name) for name in sorted(fields)}
        suspicious = None
        if role == "model" and not (fields & sv.MODEL_LOADER_FIELDS):
            suspicious = "role=model 但无 loader 字段"
        if role is None and any(v for v in field_roles.values()):
            suspicious = suspicious or "未识别但字段名带角色语义"
        if suspicious or role:
            rows.append({
                "definition_id": record_id,
                "repo": rec.get("repo"),
                "class_type": ct,
                "role": role,
                "suspicious": suspicious,
            })
    return rows


def _derived_role_of(class_type: str):
    try:
        import workflow_db.sampler_view as sv
        return sv._role_from_class_type(class_type.lower())
    except Exception:
        return None


def _definition_port_types(definitions):
    values = set()
    for rec in definitions:
        for value in rec.get("return_types") or []:
            if isinstance(value, str) and value:
                values.add(value)
        for section in (rec.get("inputs") or {}).values():
            if not isinstance(section, dict):
                continue
            for value in section.values():
                if isinstance(value, str) and value:
                    values.add(value)
    return sorted(values)


def _semantic_dimensions(definitions, evidence, observed_count):
    if not definitions:
        definition_state = behavior_state = path_state = "missing"
    else:
        levels = [str(item.get("resolved_level") or "unknown") for item in definitions]
        if all(level == "full" for level in levels):
            definition_state = "full"
        elif any(level in {"full", "fields_only"} for level in levels):
            definition_state = "partial"
        else:
            definition_state = "unresolved"

        semantics = [
            item.get("semantic") for item in definitions
            if isinstance(item.get("semantic"), dict)
        ]
        known = [
            item for item in semantics if str(item.get("operation") or "opaque") != "opaque"
        ]
        signatures = {
            json.dumps(item, sort_keys=True, ensure_ascii=False)
            for item in known
        }
        if len(known) == len(definitions) and len(signatures) == 1:
            behavior_state = "known"
        elif len(known) == len(definitions) and len(signatures) > 1:
            behavior_state = "conflict"
        elif known:
            behavior_state = "partial"
        else:
            behavior_state = "opaque"

        path_states = []
        for definition in definitions:
            semantic = definition.get("semantic")
            if not isinstance(semantic, dict) or semantic.get("operation") == "opaque":
                path_states.append("opaque")
                continue
            output_count = len(definition.get("return_types") or [])
            if output_count == 0 and semantic.get("operation") == "sink":
                path_states.append("terminal")
                continue
            derivations = {
                int(item.get("output_slot")): item
                for item in semantic.get("output_derivations") or []
                if isinstance(item, dict)
                and str(item.get("output_slot", "")).lstrip("-").isdigit()
            }
            if output_count and all(
                slot in derivations and derivations[slot].get("kind") != "opaque"
                for slot in range(output_count)
            ):
                path_states.append("known")
            elif any(item.get("kind") != "opaque" for item in derivations.values()):
                path_states.append("partial")
            else:
                path_states.append("opaque")
        if len(set(path_states)) == 1:
            path_state = path_states[0]
        elif all(item in {"known", "terminal"} for item in path_states):
            path_state = "conflict"
        elif any(item in {"known", "terminal", "partial"} for item in path_states):
            path_state = "partial"
        else:
            path_state = "opaque"

    if evidence.get("direct_record_paths"):
        record_projection = "direct"
    elif evidence.get("upstream_record_paths"):
        record_projection = "topology"
    elif evidence.get("derived_paths"):
        record_projection = "derived"
    elif evidence.get("topology") == ["isolated"]:
        record_projection = "isolated"
    elif observed_count:
        record_projection = "needs_probe"
    else:
        record_projection = "unobserved"
    return {
        "definition": definition_state,
        "behavior": behavior_state,
        "path": path_state,
        "record_projection": record_projection,
    }


def build_class_type_states(ecosystem, defs, recognized, observed, fixture_evidence):
    """Classify every indexed class_type without claiming unsupported semantics.

    This inventory is intentionally separate from parser output parity.  Static
    extraction can identify a generic generation-chain candidate, but only a
    synthetic probe or real workflow can promote it to parser support.
    """
    all_definitions = defs.get("definitions") or {}
    class_type_index = defs.get("class_type_index") or {
        str(rec.get("class_type") or class_type): [class_type]
        for class_type, rec in (defs.get("records") or {}).items()
        if isinstance(rec, dict)
    }
    failed = set(defs.get("repos_failed") or [])
    zero_mapped = set(defs.get("repos_zero_mapped") or [])
    states = {}
    for class_type, repos in ecosystem["class_types"].items():
        definition_ids = class_type_index.get(class_type, [])
        definitions = [
            all_definitions[definition_id]
            for definition_id in definition_ids
            if definition_id in all_definitions
        ]
        if not definitions and class_type in (defs.get("records") or {}):
            definitions = [defs["records"][class_type]]
        levels = sorted({
            str(rec.get("resolved_level") or "unknown") for rec in definitions
        })
        port_types = _definition_port_types(definitions)
        evidence = fixture_evidence.get(class_type, {})
        dimensions = _semantic_dimensions(
            definitions, evidence, int(observed.get(class_type, 0))
        )
        semantic_operations = sorted({
            str((definition.get("semantic") or {}).get("operation") or "opaque")
            for definition in definitions
        })
        semantic_side_effects = sorted({
            str(effect)
            for definition in definitions
            for effect in (definition.get("semantic") or {}).get("side_effects") or []
        })
        if recognized(class_type):
            status = "parser_known"
        elif evidence.get("direct_record_paths"):
            status = "observed_direct_coverage"
        elif evidence.get("upstream_record_paths"):
            status = "observed_topology_coverage"
        elif evidence.get("derived_paths"):
            status = "observed_derived_coverage"
        elif evidence.get("topology") == ["isolated"]:
            status = "observed_isolated"
        elif class_type in observed:
            status = "observed_needs_probe"
        elif definitions and GENERATION_PORT_TYPES.intersection(port_types):
            status = "generic_generation_candidate"
        elif definitions and any(level in {"full", "fields_only"} for level in levels):
            status = "extracted_non_generation"
        elif definitions:
            status = "extracted_unresolved"
        elif any(repo in zero_mapped for repo in repos):
            status = "dynamic_mapping_unresolved"
        elif any(repo in failed for repo in repos):
            status = "fetch_failed"
        else:
            status = "index_only"
        states[class_type] = {
            "status": status,
            "tier": tier_of(class_type),
            "repos": repos,
            "definition_ids": definition_ids,
            "definition_levels": levels,
            "port_types": port_types,
            "local_instances": int(observed.get(class_type, 0)),
            "fixture_evidence": evidence,
            "derived_role": _derived_role_of(class_type),
            "semantic_dimensions": dimensions,
            "semantic_operations": semantic_operations,
            "semantic_side_effects": semantic_side_effects,
        }
    return states


def build_report(workdir: Path, fixtures_dir: Path = DEFAULT_FIXTURES) -> Path:
    ecosystem = load_json(workdir / "ecosystem.json")
    universe = load_json(workdir / "known_universe.json")
    defs = load_json(workdir / "node_defs.json")
    known_lower = known_lower_set(universe)
    hint_kws = [kw.lower() for kw in universe.get("hint_keywords", [])]
    sampler_hints = tuple(universe["families"].get("sampler_hints", ()))

    observed, fixture_n = fixture_counts(fixtures_dir)
    fixture_evidence = fixture_semantic_evidence(fixtures_dir, defs)

    def recognized(ct: str) -> bool:
        lowered = ct.lower()
        return (lowered in known_lower
                or any(hint in lowered for hint in hint_kws))

    class_type_states = build_class_type_states(
        ecosystem, defs, recognized, observed, fixture_evidence
    )
    state_counts = Counter(
        state["status"] for state in class_type_states.values()
    )
    semantic_dimension_counts = {
        dimension: dict(sorted(Counter(
            state["semantic_dimensions"][dimension]
            for state in class_type_states.values()
        ).items()))
        for dimension in ("definition", "behavior", "path", "record_projection")
    }

    local_gaps = sorted(
        ((ct, count) for ct, count in observed.items() if not recognized(ct)),
        key=lambda item: -item[1])
    eco_unknown = [ct for ct in ecosystem["class_types"] if not recognized(ct)]
    tiers = {"critical": [], "bypass": [], "ignore": []}
    for ct in eco_unknown:
        tiers[tier_of(ct)].append(ct)
    for bucket in tiers.values():
        bucket.sort(key=lambda ct: -len(ecosystem["class_types"][ct]))

    records = defs.get("definitions") or defs.get("records", {})
    unique_class_types = defs.get("class_type_index") or {
        str(rec.get("class_type") or key): [key]
        for key, rec in records.items()
        if isinstance(rec, dict)
    }
    semantic_operation_counts = Counter(
        str((record.get("semantic") or {}).get("operation") or "opaque")
        for record in records.values()
    )
    semantic_side_effect_counts = Counter(
        str(effect)
        for record in records.values()
        for effect in (record.get("semantic") or {}).get("side_effects") or []
    )
    vocab = Counter()
    for rec in records.values():
        for rt in rec.get("return_types") or []:
            vocab[rt] += 1
        for section in (rec.get("inputs") or {}).values():
            for ftype in section.values():
                if ftype:
                    vocab[ftype] += 1
    derived_rows = _derived_role_check(records)
    try:
        hidden = load_json(workdir / "fingerprint_summary.json").get(
            "hidden_sampler_candidates", [])
    except Exception:
        hidden = []

    lines = [
        "# 节点覆盖度审计报告",
        "",
        "> 由 utils/nodes_parse 生成；快照数据见同目录 coverage_snapshot.json。",
        "",
        "## 1. 总量",
        f"- 生态索引：{ecosystem['class_type_count']} class_type / {ecosystem['repo_count']} 仓库",
        f"- parser 已知（lower 归一）：{universe['known_lower_count']}",
        f"- 深度提取：{len(records)} 定义 / {len(unique_class_types)} class_type（请求仓库 "
        f"{defs.get('repos_requested')}，失败 {len(defs.get('repos_failed', []))}）",
        f"- 本地实测：{fixture_n} 个 fixture，{sum(observed.values())} 节点实例",
        "",
        "### 四维语义覆盖",
        "",
        "| 维度 | 状态分布 |",
        "|---|---|",
    ]
    lines += [
        f"| `{dimension}` | "
        + " / ".join(f"{status}={count}" for status, count in counts.items())
        + " |"
        for dimension, counts in semantic_dimension_counts.items()
    ]
    lines += [
        "",
        "节点操作分布（按 definition）："
        + " / ".join(
            f"{operation}={count}"
            for operation, count in sorted(semantic_operation_counts.items())
        ),
        "副作用证据（可重叠）："
        + (" / ".join(
            f"{effect}={count}"
            for effect, count in sorted(semantic_side_effect_counts.items())
        ) or "无"),
    ]
    lines += [
        "",
        "### 全生态分析状态（每个索引 class_type 均有状态）",
        "",
    ]
    lines += [
        f"- `{status}`：{count}"
        for status, count in sorted(state_counts.items())
    ]
    lines.append("")
    zero = defs.get("repos_zero_mapped") or []
    if zero:
        lines.append(
            f"⚠ 尚未解析的动态/配置驱动注册模式，"
            f"{len(zero)} 个仓库贡献为 0：{', '.join(zero[:10])}"
            + ("…" if len(zero) > 10 else ""))
        lines.append("")
    collisions = defs.get("collisions") or {}
    if collisions:
        lines.append(
            f"- 同名定义冲突：{len(collisions)} 个 class_type；报告保留全部 "
            "`(repo, class_type)` 定义，canonical 视图按仓库名稳定选择"
        )
        lines.append("")
    lines += [
        "## 2. 本地实测盲区 TOP（fixtures 观测但 parser 精确表未识别）",
        "",
        "注：\"派生层\"列是 sampler_view 模糊规则给出的角色；model/latent 等字段驱动收集器"
        "对未识别节点同样生效，本表为**候选**清单，实际字段损失需逐项确认。",
        "",
    ]
    if local_gaps:
        lines += [
            "| class_type | 实例数 | fixture 语义证据 | 派生层角色 |",
            "|---|---|---|---|",
        ]
        lines += [
            f"| `{ct}` | {count} | "
            f"{', '.join(fixture_evidence.get(ct, {}).get('direct_record_paths', [])) or ', '.join(fixture_evidence.get(ct, {}).get('upstream_record_paths', [])) or ', '.join(fixture_evidence.get(ct, {}).get('derived_paths', [])) or ', '.join(fixture_evidence.get(ct, {}).get('topology', [])) or '待探针'} | "
            f"{_derived_role_of(ct) or '—'} |"
            for ct, count in local_gaps[:40]
        ]
    else:
        lines.append("（无）")
    lines += ["", "## 3. 生态未识别分层", ""]
    for name, label in (("critical", "关键档（生成链相关）"), ("bypass", "旁路档"),
                        ("ignore", "无关档")):
        bucket = tiers[name]
        lines.append(f"### {label}：{len(bucket)} 个")
        if name == "critical" and bucket:
            lines += ["", "| class_type | 关联仓库数 | 示例仓库 |", "|---|---|---|"]
            for ct in bucket[:60]:
                repos = ecosystem["class_types"][ct]
                lines.append(f"| `{ct}` | {len(repos)} | {', '.join(repos[:2])} |")
        lines.append("")

    lines += ["## 4. 连线类型词汇表（深度提取样本内）", ""]
    if vocab:
        lines += ["| 类型 | 出现次数 |", "|---|---|"]
        lines += [f"| `{name}` | {count} |" for name, count in vocab.most_common(30)]
    else:
        lines.append("（无提取数据）")

    if derived_rows:
        flagged = [row for row in derived_rows if row["suspicious"]]
        lines += ["", f"## 5. 派生层角色仿真：{len(flagged)} 条可疑", ""]
        for row in flagged[:20]:
            source = f" ({row['repo']})" if row.get("repo") else ""
            lines.append(
                f"- `{row['class_type']}`{source}：role={row['role']}，"
                f"{row['suspicious']}"
            )

    lines += ["", "## 6. 隐藏采样候选（名字不带 sampler 却内部采样）", ""]
    lines += [f"- `{ct}`" for ct in hidden[:30]] or ["（无）"]

    p0 = [
        ct for ct in tiers["critical"]
        if class_type_states.get(ct, {}).get("status") == "observed_needs_probe"
    ]
    lines += [
        "", "## 7. 扩展优先级建议",
        "",
        f"- **P0 候选**（关键档 ∩ 本地实测盲区，共 {len(p0)}；"
        "实际字段损失需探针/人工逐项确认）："
        + (", ".join(f"`{ct}`" for ct in p0[:15]) or "无"),
        f"- **P1**：关键档其余 {max(len(tiers['critical']) - len(p0), 0)} 个（按关联仓库数排序取前 60 见 §3）",
        f"- **P2**：旁路档 {len(tiers['bypass'])} / 无关档 {len(tiers['ignore'])}，仅计数不扩展",
        "",
        "## 附：已知盲区类别自检",
        f"- 隐藏采样候选含 Detailer 类特征：{'是' if any('detail' in ct.lower() for ct in hidden) else '本轮样本未见'}",
    ]
    report_path = workdir / "out" / "COVERAGE_REPORT.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines), encoding="utf-8")

    snapshot = {
        "totals": {
            "ecosystem_class_types": ecosystem["class_type_count"],
            "known_lower": universe["known_lower_count"],
            "extracted_definitions": len(records),
            "extracted_class_types": len(unique_class_types),
            "colliding_class_types": len(collisions),
            "fixtures": fixture_n,
        },
        "local_gaps": [[ct, c] for ct, c in local_gaps],
        "eco_unknown_tier_counts": {k: len(v) for k, v in tiers.items()},
        "eco_unknown_tiers": {k: v[:200] for k, v in tiers.items()},
        "link_vocab_top50": vocab.most_common(50),
        "hidden_sampler_candidates": hidden,
        "p0": p0,
        "class_type_state_counts": dict(sorted(state_counts.items())),
        "class_type_states": class_type_states,
        "semantic_dimension_counts": semantic_dimension_counts,
        "semantic_operation_counts": dict(sorted(semantic_operation_counts.items())),
        "semantic_side_effect_counts": dict(sorted(semantic_side_effect_counts.items())),
    }
    save_json(report_path.parent / "coverage_snapshot.json", snapshot)
    return report_path
