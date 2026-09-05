"""Local-only diagnostics for image metadata availability.

This module intentionally inspects only the metadata fields already carried by
an image record.  It never opens files, contacts a service, or infers missing
business values.  Diagnostics are kept under ``metadata.extra`` so the
existing record fields retain their parser semantics.
"""
from __future__ import annotations

import json
from typing import Any


_METADATA_FIELDS = (
    "raw_keys",
    "raw_prompt",
    "raw_workflow",
    "raw_parameters",
    "raw_novelai",
    "extra",
)
_STRUCTURED_FIELDS = {"raw_prompt", "raw_workflow"}
_DIAGNOSTIC_KEY = "parse_diagnostics"


def _is_empty(value: Any, *, field: str) -> bool:
    if value is None:
        # raw_keys is missing only when the key is absent; an explicit None is
        # a malformed value and must reach the type validator.
        return field != "raw_keys"
    if isinstance(value, str):
        if field in _STRUCTURED_FIELDS:
            return False
        return not value.strip()
    if field == "raw_keys":
        return isinstance(value, list) and not value
    if field in _STRUCTURED_FIELDS:
        return False
    if field == "extra":
        # ``extra`` is the existing metadata container; an empty mapping is
        # not itself missing metadata.
        return False
    return False


def _source_value(value: Any, field: str) -> tuple[bool, str | None]:
    """Return ``(usable, issue_code)`` for one existing metadata value."""
    if field in _STRUCTURED_FIELDS and isinstance(value, str) and not value.strip():
        return False, "invalid_json"
    if _is_empty(value, field=field):
        return False, None

    if field == "raw_keys":
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            return False, "invalid_type"
        return True, None

    if field == "extra":
        if not isinstance(value, dict):
            return False, "invalid_type"
        return True, None

    if field in _STRUCTURED_FIELDS:
        parsed = value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except (TypeError, ValueError, json.JSONDecodeError):
                return False, "invalid_json"
        if not isinstance(parsed, dict):
            return False, "invalid_shape"
        if not parsed:
            return False, "empty_json"
        return True, None

    if not isinstance(value, str):
        return False, "invalid_type"
    return True, None


def diagnose(record: dict[str, object]) -> dict[str, object]:
    """Return local metadata diagnostics without changing ``record``.

    ``metadata.raw_prompt`` and ``metadata.raw_workflow`` must contain a
    mapping (directly or as JSON).  Infotext-like raw strings are accepted as
    available but are classified as partial because they do not carry a full
    workflow graph.  No offsets are invented: this worker has no chunk scanner,
    so ``chunk_offsets`` remains an empty mapping.
    """
    metadata = record.get("metadata")
    empty_fields: list[str] = []
    sources: list[str] = []
    issues: list[dict[str, str]] = []

    if not isinstance(metadata, dict):
        empty_fields = [f"metadata.{field}" for field in _METADATA_FIELDS]
        return {
            "status": "metadata_absent",
            "sources": sources,
            "empty_fields": empty_fields,
            "issues": issues,
            "chunk_offsets": {},
        }

    for field in _METADATA_FIELDS:
        value = metadata.get(field)
        if field == "extra":
            # ``extra`` is the diagnostics container, not a raw source. A
            # missing container remains an empty field; None/other malformed
            # values are present sources and must be reported as invalid.
            if field not in metadata:
                empty_fields.append("metadata.extra")
            elif value is None or not isinstance(value, dict):
                sources.append(field)
                issues.append({"field": "metadata.extra", "code": "invalid_type"})
            elif not value or set(value) == {_DIAGNOSTIC_KEY}:
                # Empty mappings and the diagnostics-only mapping represent
                # the same absent source across repeated apply() calls.
                empty_fields.append("metadata.extra")
            continue
        if field == "raw_keys" and field not in metadata:
            empty_fields.append("metadata.raw_keys")
            continue
        if field == "raw_keys" and value is None:
            sources.append(field)
            issues.append({"field": "metadata.raw_keys", "code": "invalid_type"})
            continue
        if _is_empty(value, field=field):
            empty_fields.append(f"metadata.{field}")
            continue
        # ``sources`` records fields that were present, even if malformed;
        # ``issues`` separately records why a present field was unusable.
        sources.append(field)
        usable, issue_code = _source_value(value, field)
        if not usable and issue_code:
            issues.append({"field": f"metadata.{field}", "code": issue_code})

    if issues:
        status = "metadata_invalid"
    elif not sources:
        status = "metadata_absent"
    elif any(field in sources for field in ("raw_prompt", "raw_workflow")):
        status = "ok"
    elif any(field in sources for field in ("raw_parameters", "raw_novelai")):
        status = "metadata_partial"
    else:
        status = "metadata_absent"

    return {
        "status": status,
        "sources": sources,
        "empty_fields": empty_fields,
        "issues": issues,
        "chunk_offsets": {},
    }


def apply(record: dict[str, object]) -> dict[str, object]:
    """Attach diagnostics without discarding malformed metadata values."""
    diagnostics = diagnose(record)
    metadata = record.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
        record["metadata"] = metadata

    extra = metadata.get("extra")
    if isinstance(extra, dict):
        extra[_DIAGNOSTIC_KEY] = diagnostics
    elif "extra" not in metadata:
        metadata["extra"] = {_DIAGNOSTIC_KEY: diagnostics}
    else:
        # Preserve the original malformed value verbatim. Merge diagnostics
        # into the existing sidecar so adapter-specific evidence survives.
        sidecar = metadata.get("extra_diagnostics")
        if not isinstance(sidecar, dict):
            sidecar = {}
            metadata["extra_diagnostics"] = sidecar
        sidecar[_DIAGNOSTIC_KEY] = diagnostics
    return record
