"""node_graph.py — workflow 逻辑链节点图抽象(按需派生,不落库)。

将可执行工作流(API prompt 图,有向无环)抽象为 {nodes, edges, groups},
供前端可视化与逻辑分析。纯派生层:不动 parser.py、不改 record schema。

设计契约:docs/parser/KNOWN_GAPS.md §3.2(派生层契约)+ 2026-08-03 对话决策
(按需派生不落库;UI workflow 存在时 links 提供权威 link type,纯 API 图用
字段名推断;workflow version==1 的 links 为对象数组,需双格式兼容)。

核心结构:
  nodes:  id(str, 与 source_node_id 同坐标系)/class_type/title/role/
          polarity/bypassed/params/origin
  edges:  from/from_slot/to/to_field/type/kind
  groups: 按 sampler 连通分量分组 + unattached 兜底(未被任何 sampler 触达)
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from .sampler_view import (
    SAMPLER_PARAM_FIELDS,
    _is_controlnet_apply,
    _is_controlnet_loader,
    _role_from_class_type,
    find_sampler_roots,
)
from .workflow_ir import NodeDefinitionRegistry, WorkflowIR, classify_edge_kind

# 白名单参数摘录(控制 node.params 体积)
PARAM_WHITELIST = (
    *SAMPLER_PARAM_FIELDS,
    "width", "height", "batch_size",
    "ckpt_name", "unet_name", "model_name", "vae_name", "clip_name",
    "lora_name", "control_net_name",
    "strength", "strength_model", "strength_clip", "weight",
    "start_percent", "end_percent", "expand", "blur_radius",
)

def workflow_links_index(workflow: dict[str, Any]) -> dict[tuple[str, str, int], dict]:
    """UI workflow links → {(to_id, from_id, from_slot): {type, ...}}。

    双格式兼容:
      - version != 1:links 为六元组 [id, origin_id, origin_slot, target_id, target_slot, type]
      - version == 1:links 为对象 {id, origin_id, origin_slot, target_id, target_slot, type}
    """
    index: dict[tuple[str, str, int], dict] = {}
    links = workflow.get("links", []) or []
    if not isinstance(links, list):
        return index
    for link in links:
        if isinstance(link, dict):
            item = {
                "type": link.get("type"),
                "origin_id": link.get("origin_id"),
                "origin_slot": link.get("origin_slot"),
                "target_id": link.get("target_id"),
            }
        elif isinstance(link, (list, tuple)) and len(link) >= 6:
            item = {
                "type": link[5],
                "origin_id": link[1],
                "origin_slot": link[2],
                "target_id": link[3],
            }
        else:
            continue
        try:
            key = (str(item["target_id"]), str(item["origin_id"]), int(item["origin_slot"]))
        except (TypeError, ValueError):
            continue
        index[key] = item
    return index


def build_node_graph(
    raw_prompt: Any,
    raw_workflow: Any = None,
    registry: NodeDefinitionRegistry | None = None,
) -> dict[str, Any]:
    """从 API prompt 图(可选 UI workflow)构建节点图。"""
    ir = WorkflowIR(
        raw_prompt if isinstance(raw_prompt, dict) else {},
        raw_workflow if isinstance(raw_workflow, dict) else None,
        registry=registry,
    )
    prompt = ir.prompt
    workflow = ir.workflow or {}
    workflow_nodes = {str(n.get("id")): n for n in workflow.get("nodes", []) or [] if isinstance(n, dict)}

    # ---- nodes ----
    nodes: list[dict[str, Any]] = []
    node_meta: dict[str, dict[str, Any]] = {}
    for nid, node in prompt.items():
        if not isinstance(node, dict):
            continue
        ct = str(node.get("class_type", ""))
        inputs = node.get("inputs", {}) or {}
        wfn = workflow_nodes.get(nid) or {}

        params: dict[str, Any] = {}
        for field in PARAM_WHITELIST:
            val = inputs.get(field)
            if val is not None and not isinstance(val, (list, tuple)):
                params[field] = val
        text = inputs.get("text")
        if isinstance(text, str) and text.strip():
            params["text_preview"] = text.strip()[:200]

        bypassed = None
        if wfn:
            mode = wfn.get("mode")
            flags = wfn.get("flags") or {}
            bypassed = bool(flags.get("bypassed") or flags.get("disabled") or mode in (2, 4))

        role = _role_from_class_type(ct) or "other"
        entry = {
            "id": nid,
            "class_type": ct,
            "title": ((node.get("_meta") or {}).get("title") or wfn.get("title") or wfn.get("type") or ct),
            "role": role,
            "polarity": None,
            "bypassed": bypassed,
            "params": params,
            "origin": "api_prompt",
        }
        behavior = ir.nodes[nid].behavior
        definition = ir.nodes[nid].definition
        entry["definition"] = {
            "status": definition.status,
            "definition_ids": list(definition.definition_ids),
            "input_types": dict(definition.input_types),
            "output_types": list(definition.output_types),
            "resolved_levels": list(definition.resolved_levels),
        }
        entry["behavior"] = {
            "operation": behavior.operation,
            "output_derivations": [
                {
                    "output_slot": item.output_slot,
                    "kind": item.kind,
                    "input_fields": list(item.input_fields),
                    "expression": item.expression,
                }
                for item in behavior.output_derivations
            ],
            "side_effects": list(behavior.side_effects),
            "determinism": behavior.determinism,
            "batch_behavior": behavior.batch_behavior,
            "transparent": behavior.transparent,
            "provenance": behavior.provenance,
            "confidence": behavior.confidence,
        }
        nodes.append(entry)
        node_meta[nid] = entry

    # ---- edges(canonical IR:原始槽位 + 目标端口 + UI/registry 语义) ----
    edges = [
        {
            "from": edge.source.node_id,
            "from_slot": edge.source.slot,
            "to": edge.target.node_id,
            "to_field": edge.target.field,
            "type": edge.declared_type,
            "kind": edge.kind,
            "source_operation": edge.source_operation,
            "path_effect": edge.path_effect,
            "behavior_provenance": edge.behavior_provenance,
            "behavior_confidence": edge.behavior_confidence,
        }
        for edge in ir.semantic_edges
    ]

    # ---- groups(sampler 连通分量 + unattached 兜底) ----
    roots = find_sampler_roots(prompt)
    groups: list[dict[str, Any]] = []
    covered: set[str] = set()
    for sid, stype in roots:
        # 从 sampler 出发全连通上游 BFS(与 sampler_view 同策略)
        component: set[str] = set()
        queue = [sid]
        while queue:
            cur = queue.pop(0)
            if cur in component:
                continue
            component.add(cur)
            for edge in ir.incoming_edges(cur):
                if edge.source.node_id not in component:
                    queue.append(edge.source.node_id)
        covered |= component
        role_counts: dict[str, int] = defaultdict(int)
        for nid in component:
            meta = node_meta.get(nid)
            if meta:
                role_counts[meta["role"]] += 1
        groups.append(
            {
                "sampler_id": sid,
                "sampler_type": stype,
                "node_ids": sorted(component),
                "role_counts": dict(role_counts),
            }
        )

    unattached = sorted(set(prompt) - covered)
    if unattached:
        groups.append(
            {
                "sampler_id": None,
                "sampler_type": "unattached",
                "node_ids": unattached,
                "role_counts": None,
            }
        )

    return {
        "node_count": len(nodes),
        "edge_count": len(edges),
        "group_count": len(groups),
        "nodes": nodes,
        "edges": edges,
        "groups": groups,
    }
