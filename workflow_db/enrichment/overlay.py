"""Conflict-safe overlay for native and third-party enrichment candidates."""
from __future__ import annotations

from copy import deepcopy
from typing import Any


# Enrichment is display-only and cannot alter identity, grouping, files, raw
# metadata, or timestamps.  Third-party candidates are constrained to the same
# allowlist as the native sampler-view adapter.
SAFE_PATHS = frozenset({
    "samplers",
    "prompts.positive",
    "prompts.negative",
    "prompts.by_sampler",
    "prompts.search_text",
    "model.base_model",
    "model.checkpoint_node_id",
    "model.sampler_model_source_id",
    "model.nodes",
    "loras.items",
    "latent.node_id",
    "latent.node_type",
    "latent.width",
    "latent.height",
    "latent.batch_size",
    "latent.sources",
})

_MISSING = object()


def _is_empty(value: Any) -> bool:
    return value is _MISSING or value is None or value == "" or value == [] or value == {}


def _get_path(root: dict[str, Any], path: str) -> Any:
    current: Any = root
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return _MISSING
        current = current[part]
    return current


def _set_path(root: dict[str, Any], path: str, value: Any) -> None:
    parts = path.split(".")
    current = root
    for part in parts[:-1]:
        child = current.get(part)
        if not isinstance(child, dict):
            child = {}
            current[part] = child
        current = child
    current[parts[-1]] = deepcopy(value)


def _candidate_meta(candidate: dict[str, Any]) -> dict[str, Any]:
    meta = {
        "provider": str(candidate.get("provider") or "unknown"),
        "confidence": candidate.get("confidence"),
        "evidence": deepcopy(candidate.get("evidence") or {}),
    }
    return {key: value for key, value in meta.items() if value is not None}


def _diagnostic_value(value: Any) -> Any:
    """Bound conflict payloads so diagnostics cannot duplicate raw metadata."""
    if value is _MISSING:
        return {"type": "missing"}
    if isinstance(value, str):
        return value if len(value) <= 240 else value[:237] + "..."
    if isinstance(value, list):
        return {"type": "list", "count": len(value)}
    if isinstance(value, dict):
        return {"type": "object", "keys": sorted(str(key) for key in value)[:20]}
    return deepcopy(value)


def _selector(identity: tuple[Any, ...], identity_fields: list[str]) -> str:
    return ",".join(
        f"{field}={value}" for field, value in zip(identity_fields, identity)
    )


def _merge_dict_fill_only(
    target: dict[str, Any],
    incoming: dict[str, Any],
    base_path: str,
    provenance: dict[str, Any],
    conflicts: list[dict[str, Any]],
    meta: dict[str, Any],
) -> list[str]:
    filled: list[str] = []
    for key, value in incoming.items():
        path = f"{base_path}.{key}"
        existing = target.get(key, _MISSING)
        if _is_empty(existing) and not _is_empty(value):
            target[key] = deepcopy(value)
            provenance[path] = deepcopy(meta)
            filled.append(path)
        elif not _is_empty(value) and existing != value:
            conflicts.append({
                "path": path,
                "reason": "existing_value_preserved",
                "existing": _diagnostic_value(existing),
                "candidate": _diagnostic_value(value),
                "provider": meta.get("provider"),
            })
    return filled


def _merge_by_key(
    target: list[Any],
    incoming: list[Any],
    candidate: dict[str, Any],
    path: str,
    provenance: dict[str, Any],
    conflicts: list[dict[str, Any]],
) -> list[str]:
    identity_fields = candidate.get("identity")
    if not isinstance(identity_fields, list) or not identity_fields:
        conflicts.append({
            "path": path,
            "reason": "invalid_identity_contract",
            "provider": candidate.get("provider"),
        })
        return []

    identity_fields = [str(field) for field in identity_fields]
    require_identity = str(candidate.get("require_identity") or identity_fields[0])
    meta = _candidate_meta(candidate)
    filled: list[str] = []

    for item in incoming:
        if not isinstance(item, dict) or _is_empty(item.get(require_identity, _MISSING)):
            conflicts.append({
                "path": path,
                "reason": "missing_stable_identity",
                "provider": meta.get("provider"),
            })
            continue

        identity = tuple(item.get(field) for field in identity_fields)
        match = next(
            (
                existing for existing in target
                if isinstance(existing, dict)
                and tuple(existing.get(field) for field in identity_fields) == identity
            ),
            None,
        )
        selected_path = f"{path}[{_selector(identity, identity_fields)}]"
        if match is None:
            target.append(deepcopy(item))
            provenance[selected_path] = deepcopy(meta)
            filled.append(selected_path)
        else:
            filled.extend(
                _merge_dict_fill_only(
                    match, item, selected_path, provenance, conflicts, meta
                )
            )
    return filled


def apply_candidates(
    record: dict[str, Any], candidates: list[dict[str, Any]]
) -> dict[str, Any]:
    """Apply candidates to a deep copy, preserving every non-empty value.

    List candidates may opt into ``merge_by_key``.  A stable node identity is
    required before appending to a non-empty list; this prevents weak external
    extractors from creating duplicates.  The input ``record`` is never mutated.
    """
    effective = deepcopy(record)
    provenance: dict[str, Any] = {}
    filled_fields: list[str] = []
    conflicts: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    for candidate in candidates:
        if not isinstance(candidate, dict):
            warnings.append({"code": "invalid_candidate", "message": "candidate must be an object"})
            continue
        path = candidate.get("path")
        if path not in SAFE_PATHS:
            warnings.append({
                "code": "unsafe_path",
                "message": f"candidate path is not allowed: {path!r}",
                "provider": candidate.get("provider"),
            })
            continue

        value = candidate.get("value")
        if _is_empty(value):
            continue
        existing = _get_path(effective, path)
        mode = candidate.get("merge", "fill")

        if mode == "merge_by_key":
            if not isinstance(value, list):
                warnings.append({
                    "code": "invalid_candidate_value",
                    "message": f"merge_by_key requires a list at {path}",
                    "provider": candidate.get("provider"),
                })
                continue
            if _is_empty(existing):
                _set_path(effective, path, value)
                provenance[path] = _candidate_meta(candidate)
                filled_fields.append(path)
            elif isinstance(existing, list):
                filled_fields.extend(
                    _merge_by_key(
                        existing, value, candidate, path, provenance, conflicts
                    )
                )
            else:
                conflicts.append({
                    "path": path,
                    "reason": "incompatible_existing_type",
                    "provider": candidate.get("provider"),
                })
            continue

        if mode != "fill":
            warnings.append({
                "code": "invalid_merge_mode",
                "message": f"unsupported merge mode: {mode!r}",
                "provider": candidate.get("provider"),
            })
            continue

        if _is_empty(existing):
            _set_path(effective, path, value)
            provenance[path] = _candidate_meta(candidate)
            filled_fields.append(path)
        elif existing != value:
            conflicts.append({
                "path": path,
                "reason": "existing_value_preserved",
                "existing": _diagnostic_value(existing),
                "candidate": _diagnostic_value(value),
                "provider": candidate.get("provider"),
            })

    _fill_lora_summaries(record, effective, provenance, filled_fields)
    _fill_prompt_search_text(record, effective, provenance, filled_fields)
    return {
        "effective_record": effective,
        "provenance": provenance,
        "filled_fields": filled_fields,
        "conflicts": conflicts,
        "warnings": warnings,
    }


def _fill_lora_summaries(
    original: dict[str, Any],
    effective: dict[str, Any],
    provenance: dict[str, Any],
    filled_fields: list[str],
) -> None:
    """Repair empty derived LoRA summaries after an items overlay.

    ``count == 0`` is treated as empty only when the authoritative record had no
    LoRA items.  Existing non-empty names/counts are never replaced.
    """
    original_loras = original.get("loras") if isinstance(original.get("loras"), dict) else {}
    effective_loras = effective.get("loras") if isinstance(effective.get("loras"), dict) else None
    if not effective_loras or original_loras.get("items"):
        return
    items = effective_loras.get("items")
    if not isinstance(items, list) or not items:
        return

    item_provenance = provenance.get("loras.items")
    if item_provenance is None and not any(key.startswith("loras.items[") for key in provenance):
        return
    summary_meta = deepcopy(item_provenance or {"provider": "derived_overlay"})
    summary_meta["derived_from"] = "loras.items"

    names = [str(item.get("name")) for item in items if isinstance(item, dict) and item.get("name")]
    if effective_loras.get("count") in (None, 0):
        effective_loras["count"] = len(items)
        provenance["loras.count"] = deepcopy(summary_meta)
        filled_fields.append("loras.count")
    if not effective_loras.get("names"):
        effective_loras["names"] = list(dict.fromkeys(names))
        provenance["loras.names"] = deepcopy(summary_meta)
        filled_fields.append("loras.names")


def _fill_prompt_search_text(
    original: dict[str, Any],
    effective: dict[str, Any],
    provenance: dict[str, Any],
    filled_fields: list[str],
) -> None:
    """Fill empty search text from the final effective prompt lists."""
    original_prompts = (
        original.get("prompts") if isinstance(original.get("prompts"), dict) else {}
    )
    effective_prompts = (
        effective.get("prompts") if isinstance(effective.get("prompts"), dict) else None
    )
    if not effective_prompts or original_prompts.get("search_text"):
        return
    if not any(path.startswith("prompts.") for path in filled_fields):
        return

    texts = [
        item.get("text")
        for polarity in ("positive", "negative")
        for item in effective_prompts.get(polarity, []) or []
        if isinstance(item, dict) and item.get("text")
    ]
    if not texts:
        return
    effective_prompts["search_text"] = "\n\n".join(texts)
    provenance["prompts.search_text"] = {
        "provider": "derived_overlay",
        "derived_from": ["prompts.positive", "prompts.negative"],
    }
    filled_fields.append("prompts.search_text")
