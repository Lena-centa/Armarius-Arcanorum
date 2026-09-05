"""Top-level orchestration for display-only Record enrichment."""
from __future__ import annotations

from copy import deepcopy
import re
from typing import Any

from .coverage import evaluate_coverage
from .overlay import apply_candidates
from .sampler_view_adapter import PROVIDER, build_sampler_view_candidates


def enrich_record(
    record: dict[str, Any],
    *,
    raw_prompt: Any = None,
    raw_workflow: Any = None,
    extra_candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return an enriched copy, provenance, and structured diagnostics.

    Explicit graph arguments take precedence.  Otherwise raw graph values are
    read from ``record.metadata``.  ``extra_candidates`` lets isolated
    third-party adapters use the same allowlist and conflict rules.
    """
    if not isinstance(record, dict):
        raise TypeError("record must be a dict")
    metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
    if raw_prompt is None:
        raw_prompt = metadata.get("raw_prompt")
    if raw_workflow is None:
        raw_workflow = metadata.get("raw_workflow")

    adapter = build_sampler_view_candidates(raw_prompt, raw_workflow)
    before = evaluate_coverage(
        record, adapter["signals"], graph_available=adapter["graph_available"]
    )
    native_candidates = [
        candidate
        for candidate in adapter["candidates"]
        if _native_candidate_is_needed(record, candidate)
    ]
    candidates = [*native_candidates, *(extra_candidates or [])]
    display_record, repaired_fields = _repair_stale_native_values(
        record, native_candidates
    )
    overlay = apply_candidates(display_record, candidates)
    after = evaluate_coverage(
        overlay["effective_record"],
        adapter["signals"],
        graph_available=adapter["graph_available"],
    )

    providers = ["native"]
    if adapter["graph_available"]:
        providers.append(PROVIDER)
    for candidate in extra_candidates or []:
        provider = str(candidate.get("provider") or "unknown") if isinstance(candidate, dict) else "unknown"
        if provider not in providers:
            providers.append(provider)

    if overlay["filled_fields"]:
        outcome = "enriched"
    elif not adapter["graph_available"]:
        outcome = "unavailable"
    elif overlay["conflicts"]:
        outcome = "conflict_preserved"
    else:
        outcome = "unchanged"

    diagnostics = {
        "version": "1.0",
        "outcome": outcome,
        "semantic_parse": after["overall"],
        "input_formats": adapter["input_formats"],
        "sampler_graph": adapter.get("graph", {}),
        "providers": providers,
        "coverage_before": before,
        "coverage_after": after,
        "filled_fields": overlay["filled_fields"],
        "repaired_fields": repaired_fields,
        "conflicts": overlay["conflicts"],
        "unknown_nodes": adapter["unknown_nodes"],
        "warnings": [*adapter["warnings"], *overlay["warnings"]],
    }
    return {
        "effective_record": overlay["effective_record"],
        "provenance": overlay["provenance"],
        "diagnostics": diagnostics,
    }


def _native_candidate_is_needed(
    record: dict[str, Any], candidate: dict[str, Any]
) -> bool:
    """Avoid comparing aggregate parser prompts with upstream text fragments."""
    path = candidate.get("path")
    if path not in {"prompts.positive", "prompts.negative", "prompts.by_sampler"}:
        return True
    prompts = record.get("prompts")
    if not isinstance(prompts, dict):
        return True
    field = str(path).split(".", 1)[1]
    values = prompts.get(field)
    return not bool(values) or _contains_link_placeholder(values)


_LINK_PLACEHOLDER = re.compile(r"^\s*\[\s*['\"]?[^,\]]+['\"]?\s*,\s*\d+\s*\]\s*$")


def _contains_link_placeholder(value: Any) -> bool:
    """Detect parser output that leaked an API link instead of prompt text."""
    if isinstance(value, dict):
        return bool(_LINK_PLACEHOLDER.match(str(value.get("text", ""))))
    if isinstance(value, list):
        return any(_contains_link_placeholder(item) for item in value)
    return False


def _is_unresolved_node_value(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get("node_id") is not None
        and bool(value.get("class_type"))
        and isinstance(value.get("inputs"), dict)
    )


def _repair_stale_native_values(
    record: dict[str, Any], candidates: list[dict[str, Any]]
) -> tuple[dict[str, Any], list[str]]:
    """Clear only values proven to be parser placeholders/misclassified loaders.

    This is display-only repair. The authoritative Record passed by the caller
    remains untouched, while valid values (including direct negative prompts)
    continue to win over enrichment candidates.
    """
    display = deepcopy(record)
    repaired: list[str] = []
    candidate_paths = {str(item.get("path")) for item in candidates}
    prompts = display.get("prompts") if isinstance(display.get("prompts"), dict) else {}
    for path in ("positive", "negative", "by_sampler"):
        full_path = f"prompts.{path}"
        if full_path in candidate_paths and _contains_link_placeholder(prompts.get(path)):
            prompts[path] = []
            repaired.append(full_path)
    if "prompts.positive" in repaired or "prompts.negative" in repaired:
        if "search_text" in prompts:
            prompts["search_text"] = ""
            repaired.append("prompts.search_text")

    model = display.get("model") if isinstance(display.get("model"), dict) else {}
    model_nodes = model.get("nodes") if isinstance(model.get("nodes"), list) else []
    checkpoint_id = str(model.get("checkpoint_node_id") or "")
    checkpoint_node = next(
        (node for node in model_nodes if isinstance(node, dict) and str(node.get("node_id")) == checkpoint_id),
        None,
    )
    node_type = str((checkpoint_node or {}).get("node_type") or "").lower()
    if (
        "model.base_model" in candidate_paths
        and model.get("base_model")
        and any(token in node_type for token in ("upscale", "detector", "samloader", "vae", "clip"))
    ):
        model["base_model"] = None
        repaired.append("model.base_model")
        if "model.checkpoint_node_id" in candidate_paths:
            model["checkpoint_node_id"] = None
            repaired.append("model.checkpoint_node_id")

    # KSamplerSelect/Sampler Selector expose a sampler name but do not execute
    # a sampling step. Remove them from the display view when the graph adapter
    # has identified the actual sampler roots.
    samplers = display.get("samplers")
    root_ids = {
        str(item.get("node_id"))
        for item in candidates
        if item.get("path") == "samplers"
        for item in (item.get("value") or [])
        if isinstance(item, dict) and item.get("node_id") is not None
    }
    if isinstance(samplers, list) and root_ids:
        retained = []
        for sampler in samplers:
            node_type = str(sampler.get("node_type") or "") if isinstance(sampler, dict) else ""
            node_id = str(sampler.get("node_id")) if isinstance(sampler, dict) else ""
            lowered_type = node_type.lower()
            is_selector = "sampler" in lowered_type and "select" in lowered_type
            if is_selector and node_id not in root_ids:
                repaired.append(f"samplers[node_id={node_id}]")
                continue
            retained.append(sampler)
        display["samplers"] = retained

    sampler_candidates = next(
        (
            item.get("value") for item in candidates
            if item.get("path") == "samplers" and isinstance(item.get("value"), list)
        ),
        [],
    )
    for sampler in display.get("samplers", []) or []:
        if not isinstance(sampler, dict):
            continue
        node_id = str(sampler.get("node_id") or "")
        candidate = next(
            (
                item for item in sampler_candidates
                if isinstance(item, dict) and str(item.get("node_id") or "") == node_id
            ),
            None,
        )
        if not candidate:
            continue
        for field, candidate_value in candidate.items():
            if field in {"node_id", "node_type"}:
                continue
            if _is_unresolved_node_value(sampler.get(field)) and not isinstance(candidate_value, dict):
                sampler[field] = None
                repaired.append(f"samplers[node_id={node_id}].{field}")
    return display, repaired
