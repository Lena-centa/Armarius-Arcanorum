"""Field-level coverage checks for parser records.

Coverage is evidence based: ``expected_count`` comes from an enrichment
adapter's graph signals, while ``observed_count`` comes from the record.  An
empty field without graph evidence is ``unknown`` rather than incorrectly
reported as complete or missing.
"""
from __future__ import annotations

from typing import Any


COVERAGE_PATHS = (
    "samplers",
    "prompts.positive",
    "prompts.negative",
    "model.base_model",
    "loras.items",
    "latent",
)


def _get_path(value: dict[str, Any], path: str) -> Any:
    current: Any = value
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _observed_count(path: str, value: Any) -> int:
    if path == "latent":
        if not isinstance(value, dict):
            return 0
        sources = value.get("sources")
        if isinstance(sources, list) and sources:
            return len(sources)
        return int(any(value.get(key) not in (None, "", [], {}) for key in (
            "node_id", "width", "height", "batch_size",
        )))
    if isinstance(value, list):
        return len(value)
    return int(value not in (None, "", [], {}))


def evaluate_coverage(
    record: dict[str, Any],
    signals: dict[str, Any] | None = None,
    *,
    graph_available: bool = False,
) -> dict[str, Any]:
    """Return JSON-safe field coverage and an aggregate status.

    ``signals`` maps a coverage path to either an expected count or a mapping
    containing ``expected_count`` and optional ``source_node_ids``.  This loose
    input shape keeps third-party adapters independent from this module.
    """
    signals = signals or {}
    fields: dict[str, dict[str, Any]] = {}

    for path in COVERAGE_PATHS:
        raw_signal = signals.get(path)
        if isinstance(raw_signal, dict):
            expected = int(raw_signal.get("expected_count", 0) or 0)
            source_ids = [str(item) for item in raw_signal.get("source_node_ids", [])]
        else:
            expected = int(raw_signal or 0)
            source_ids = []

        observed = _observed_count(path, _get_path(record, path))
        if expected > 0:
            if observed == 0:
                status = "missing"
            elif observed < expected:
                status = "partial"
            else:
                status = "complete"
        elif observed > 0:
            status = "complete"
        elif graph_available:
            status = "not_applicable"
        else:
            status = "unknown"

        entry: dict[str, Any] = {
            "status": status,
            "expected_count": expected,
            "observed_count": observed,
        }
        if source_ids:
            entry["source_node_ids"] = source_ids
        fields[path] = entry

    relevant = [
        item["status"]
        for item in fields.values()
        if item["status"] not in {"not_applicable", "unknown"}
    ]
    if not graph_available and not relevant:
        overall = "unavailable"
    elif not relevant or all(status == "complete" for status in relevant):
        overall = "complete"
    elif all(status == "missing" for status in relevant):
        overall = "missing"
    else:
        overall = "partial"

    return {"overall": overall, "fields": fields}
