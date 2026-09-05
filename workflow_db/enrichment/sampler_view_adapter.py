"""Adapter from ``sampler_view`` output to safe Record candidates."""
from __future__ import annotations

import json
from typing import Any

from workflow_db.sampler_view import build_sampler_views, find_sampler_roots


PROVIDER = "native.sampler_view"
MODEL_FIELDS = ("ckpt_name", "unet_name", "model_name")
LOADER_FIELDS = (*MODEL_FIELDS, "vae_name", "clip_name")
SAMPLER_FIELDS = (
    "seed", "noise_seed", "steps", "cfg", "sampler_name", "scheduler", "denoise",
)
LORA_FIELDS = (
    "node_id", "source", "slot", "name", "strength", "strength_model", "strength_clip",
)


def parse_graph_value(value: Any) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Parse a raw metadata value without raising.

    The second tuple item is a structured warning, if parsing failed.
    """
    if isinstance(value, dict):
        return value, None
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            return {}, {
                "code": "invalid_json",
                "message": str(exc),
            }
        if isinstance(parsed, dict):
            return parsed, None
        return {}, {
            "code": "invalid_graph_type",
            "message": f"expected object, got {type(parsed).__name__}",
        }
    return {}, None


def _candidate(
    path: str,
    value: Any,
    *,
    evidence: dict[str, Any],
    confidence: float,
    merge: str = "fill",
    identity: list[str] | None = None,
    require_identity: str | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "provider": PROVIDER,
        "path": path,
        "value": value,
        "confidence": confidence,
        "evidence": evidence,
        "merge": merge,
    }
    if identity:
        item["identity"] = identity
    if require_identity:
        item["require_identity"] = require_identity
    return item


def _unique_dicts(items: list[dict[str, Any]], fields: tuple[str, ...]) -> list[dict[str, Any]]:
    seen: set[tuple[Any, ...]] = set()
    result: list[dict[str, Any]] = []
    for item in items:
        key = tuple(item.get(field) for field in fields)
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def _workflow_node_is_bypassed(node: dict[str, Any]) -> bool:
    flags = node.get("flags")
    return (
        node.get("mode") in (2, 4)
        or bool(isinstance(flags, dict) and flags.get("bypassed"))
        or bool(isinstance(flags, dict) and flags.get("disabled"))
    )


def build_sampler_view_candidates(
    raw_prompt: Any, raw_workflow: Any = None
) -> dict[str, Any]:
    """Build candidates, graph signals, and diagnostics from existing graph code."""
    prompt, prompt_warning = parse_graph_value(raw_prompt)
    workflow, workflow_warning = parse_graph_value(raw_workflow)
    warnings: list[dict[str, Any]] = []
    if prompt_warning:
        warnings.append({**prompt_warning, "source": "raw_prompt"})
    if workflow_warning:
        warnings.append({**workflow_warning, "source": "raw_workflow"})

    input_formats: list[str] = []
    if prompt:
        input_formats.append("api-prompt")
    if workflow:
        input_formats.append("ui-workflow")
    if not prompt:
        return {
            "provider": PROVIDER,
            "candidates": [],
            "signals": {},
            "unknown_nodes": [],
            "warnings": warnings,
            "input_formats": input_formats,
            "graph_available": False,
        }

    try:
        views = build_sampler_views(prompt, workflow or None)
        roots = find_sampler_roots(prompt)
    except Exception as exc:  # enrichment must never break the native record
        warnings.append({
            "code": "adapter_failed",
            "message": f"sampler view extraction failed: {exc!r}",
            "source": "raw_prompt",
        })
        views = []
        roots = []
    candidates: list[dict[str, Any]] = []
    sampler_items: list[dict[str, Any]] = []
    model_nodes: dict[str, dict[str, Any]] = {}
    lora_items: list[dict[str, Any]] = []
    prompt_items: dict[str, list[dict[str, Any]]] = {"positive": [], "negative": []}
    by_sampler: list[dict[str, Any]] = []
    latent_items: list[dict[str, Any]] = []
    unknown_nodes: list[dict[str, Any]] = []
    bypassed_node_ids = {
        str(node.get("id"))
        for node in workflow.get("nodes", []) or []
        if isinstance(node, dict)
        and _workflow_node_is_bypassed(node)
    }

    for view in views:
        sampler_id = str(view.get("sampler_id"))
        sampler = {
            "node_id": sampler_id,
            "node_type": str(view.get("sampler_type") or ""),
        }
        for field in SAMPLER_FIELDS:
            value = (view.get("sampler_params") or {}).get(field)
            if value not in (None, "", [], {}):
                sampler[field] = value
        sampler_items.append(sampler)

        for loader in view.get("loaders", []) or []:
            node_id = str(loader.get("node_id"))
            field = loader.get("field")
            value = loader.get("value")
            if field not in LOADER_FIELDS or value in (None, "", "None", [], {}):
                continue
            node = model_nodes.setdefault(node_id, {
                "node_id": node_id,
                "node_type": str(loader.get("class_type") or ""),
            })
            node[str(field)] = value

        for lora in view.get("loras", []) or []:
            if str(lora.get("node_id")) in bypassed_node_ids:
                continue
            item = {
                field: lora.get(field)
                for field in LORA_FIELDS
                if lora.get(field) not in (None, "", [], {})
            }
            if item.get("node_id") is not None:
                item["node_id"] = str(item["node_id"])
            if item.get("name"):
                lora_items.append(item)

        sampler_prompts = {
            "node_id": sampler_id,
            "node_type": str(view.get("sampler_type") or ""),
            "positive": [],
            "negative": [],
        }
        for prompt_item in view.get("prompt_texts", []) or []:
            polarity = prompt_item.get("polarity")
            text = prompt_item.get("text")
            if polarity not in prompt_items or not isinstance(text, str) or not text.strip():
                continue
            entry = {
                "text": text,
                "source_node_id": str(prompt_item.get("node_id")),
                "source_node_type": str(prompt_item.get("class_type") or ""),
                "branch_label": polarity,
            }
            prompt_items[polarity].append(entry)
            sampler_prompts[polarity].append(entry)
        if sampler_prompts["positive"] or sampler_prompts["negative"]:
            by_sampler.append(sampler_prompts)

        for latent in view.get("latent_params", []) or []:
            entry = {
                "node_id": str(latent.get("node_id")),
                "node_type": str(latent.get("class_type") or ""),
            }
            for field in ("width", "height", "batch_size"):
                if latent.get(field) not in (None, "", [], {}):
                    entry[field] = latent[field]
            latent_items.append(entry)

        unknown_nodes.extend(view.get("unknown_nodes", []) or [])

    sampler_items = _unique_dicts(sampler_items, ("node_id",))
    lora_items = _unique_dicts(lora_items, ("node_id", "slot", "name"))
    latent_items = _unique_dicts(latent_items, ("node_id",))
    for polarity in prompt_items:
        prompt_items[polarity] = _unique_dicts(
            prompt_items[polarity], ("source_node_id", "branch_label", "text")
        )
        # A Text Concatenate node is an implementation detail of the same
        # conditioning branch. Prefer its terminal CLIPTextEncode value when
        # available, otherwise custom text nodes remain valid candidates.
        clip_items = [
            item for item in prompt_items[polarity]
            if item.get("source_node_type") == "CLIPTextEncode"
        ]
        if clip_items:
            prompt_items[polarity] = clip_items
    unknown_nodes = _unique_dicts(
        [
            {
                "node_id": str(item.get("node_id")),
                "class_type": str(item.get("class_type") or ""),
                "role": item.get("role"),
            }
            for item in unknown_nodes if isinstance(item, dict)
        ],
        ("node_id", "class_type"),
    )

    if sampler_items:
        candidates.append(_candidate(
            "samplers", sampler_items,
            evidence={"source": "raw_prompt", "node_ids": [item["node_id"] for item in sampler_items]},
            confidence=0.95, merge="merge_by_key", identity=["node_id"],
        ))

    nodes = list(model_nodes.values())
    if nodes:
        candidates.append(_candidate(
            "model.nodes", nodes,
            evidence={"source": "raw_prompt", "node_ids": list(model_nodes)},
            confidence=0.95, merge="merge_by_key", identity=["node_id"],
        ))
        base = next(
            ((node_id, field, node[field]) for node_id, node in model_nodes.items()
             for field in MODEL_FIELDS if node.get(field) not in (None, "", "None")),
            None,
        )
        if base:
            node_id, field, value = base
            evidence = {"source": "raw_prompt", "node_id": node_id, "field": field}
            candidates.extend([
                _candidate("model.base_model", value, evidence=evidence, confidence=0.95),
                _candidate("model.checkpoint_node_id", node_id, evidence=evidence, confidence=0.95),
            ])

    if roots:
        sampler_id = str(roots[0][0])
        sampler_node = prompt.get(sampler_id) or {}
        model_link = (sampler_node.get("inputs") or {}).get("model")
        if isinstance(model_link, (list, tuple)) and model_link:
            candidates.append(_candidate(
                "model.sampler_model_source_id", str(model_link[0]),
                evidence={"source": "raw_prompt", "node_id": sampler_id, "field": "model"},
                confidence=0.95,
            ))

    if lora_items:
        candidates.append(_candidate(
            "loras.items", lora_items,
            evidence={"source": "raw_prompt+raw_workflow", "node_ids": sorted({item["node_id"] for item in lora_items})},
            confidence=0.95, merge="merge_by_key",
            identity=["node_id", "slot", "name"], require_identity="node_id",
        ))

    for polarity in ("positive", "negative"):
        items = prompt_items[polarity]
        if items:
            candidates.append(_candidate(
                f"prompts.{polarity}", items,
                evidence={"source": "raw_prompt", "node_ids": [item["source_node_id"] for item in items]},
                confidence=0.8,
            ))
    if by_sampler:
        candidates.append(_candidate(
            "prompts.by_sampler", by_sampler,
            evidence={"source": "raw_prompt", "node_ids": [item["node_id"] for item in by_sampler]},
            confidence=0.8,
        ))
    if latent_items:
        primary = latent_items[0]
        for field in ("node_id", "node_type", "width", "height", "batch_size"):
            if primary.get(field) not in (None, "", [], {}):
                candidates.append(_candidate(
                    f"latent.{field}", primary[field],
                    evidence={"source": "raw_prompt", "node_id": primary["node_id"], "field": field},
                    confidence=0.9,
                ))
        candidates.append(_candidate(
            "latent.sources", latent_items,
            evidence={"source": "raw_prompt", "node_ids": [item["node_id"] for item in latent_items]},
            confidence=0.9, merge="merge_by_key", identity=["node_id"],
        ))

    # A graph can signal a missing semantic even when no safe candidate was
    # extracted (for example, an unknown LoRA node).  Coverage must retain it.
    lora_signal_ids = [
        str(node_id) for node_id, node in prompt.items()
        if isinstance(node, dict) and "lora" in str(node.get("class_type", "")).lower()
    ]
    model_signal_ids = [
        str(node_id) for node_id, node in prompt.items()
        if isinstance(node, dict)
        and isinstance(node.get("inputs"), dict)
        and any(
            node["inputs"].get(field) not in (None, "", "None", [], {})
            for field in MODEL_FIELDS
        )
    ]
    latent_signal_ids = [
        str(node_id) for node_id, node in prompt.items()
        if isinstance(node, dict)
        and isinstance(node.get("inputs"), dict)
        and "latent" in str(node.get("class_type", "")).lower()
        and any(field in node["inputs"] for field in ("width", "height", "batch_size"))
    ]
    signals = {
        "samplers": {"expected_count": len(roots), "source_node_ids": [str(item[0]) for item in roots]},
        "prompts.positive": {"expected_count": int(bool(prompt_items["positive"])), "source_node_ids": [item["source_node_id"] for item in prompt_items["positive"]]},
        "prompts.negative": {"expected_count": int(bool(prompt_items["negative"])), "source_node_ids": [item["source_node_id"] for item in prompt_items["negative"]]},
        "model.base_model": {"expected_count": int(bool(model_signal_ids)), "source_node_ids": model_signal_ids},
        "loras.items": {"expected_count": max(len(lora_items), len(lora_signal_ids)), "source_node_ids": lora_signal_ids},
        "latent": {"expected_count": max(len(latent_items), len(latent_signal_ids)), "source_node_ids": latent_signal_ids},
    }
    traversed_node_ids = sorted({
        str(node.get("node_id"))
        for view in views
        for chain in (view.get("chains") or {}).values()
        for node in chain
        if isinstance(node, dict)
    })
    traversed_set = set(traversed_node_ids)
    traversed_edges = 0
    for node_id in traversed_node_ids:
        node = prompt.get(node_id) or {}
        for value in (node.get("inputs") or {}).values():
            link = parse_link(value)
            if link and link[0] in traversed_set:
                traversed_edges += 1
    return {
        "provider": PROVIDER,
        "candidates": candidates,
        "signals": signals,
        "unknown_nodes": unknown_nodes,
        "warnings": warnings,
        "input_formats": input_formats,
        "graph_available": True,
        "graph": {
            "root_node_ids": [str(item[0]) for item in roots],
            "root_count": len(roots),
            "traversed_node_count": len(traversed_node_ids),
            "traversed_edge_count": traversed_edges,
            "unknown_node_count": len(unknown_nodes),
            "direction": "sampler_to_upstream",
            "traversal": "bfs_with_visited",
        },
    }


def parse_link(value: Any) -> tuple[str, int] | None:
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        try:
            return str(value[0]), int(value[1])
        except (TypeError, ValueError):
            return None
    return None
