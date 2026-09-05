"""A1111 infotext adapter for parse_worker post-processing.

This module deliberately stays outside ``parser.py``.  It recognizes the
plain-text ``parameters``/``comment`` format emitted by AUTOMATIC1111 and
maps the small, stable subset of fields that already exists in a Record.
Malformed or unfamiliar metadata is ignored rather than blocking ingestion.
"""

from __future__ import annotations

import re
from typing import Any

from workflow_db.parser import batch_group_key, build_prompt_search_text, prompt_payload

SOURCE_NODE_TYPE = "A1111"
BATCH_PREFIX = "a1111:"

# These are the labels commonly emitted by A1111.  The scanner only treats a
# comma as a field boundary when the text after it starts with one of these
# labels, so commas in model names and other values remain part of the value.
_KNOWN_KEYS = (
    "ADetailer inpaint padding",
    "ADetailer use separate clip skip",
    "ADetailer use separate sampler",
    "ADetailer denoising strength",
    "ADetailer negative prompt",
    "ADetailer confidence",
    "ADetailer dilate erode",
    "ADetailer mask blur",
    "ADetailer model",
    "ADetailer prompt",
    "ADetailer steps",
    "ADetailer CFG scale",
    "ADetailer sampler",
    "ADetailer scheduler",
    "Hires upscaler",
    "Hires upscale",
    "Hires steps",
    "Denoising strength",
    "Conditional mask weight",
    "Face restoration",
    "Schedule type",
    "Model hash",
    "Clip skip",
    "Lora hashes",
    "TI hashes",
    "Sampler",
    "CFG scale",
    "Seed",
    "Steps",
    "Size",
    "Model",
    "Version",
    "VAE",
    "ENSD",
    "Eta",
)
_KEY_PATTERN = "|".join(re.escape(key) for key in _KNOWN_KEYS)
_PARAM_LINE_RE = re.compile(
    rf"^\s*(?:{_KEY_PATTERN})\s*:\s*", re.IGNORECASE
)
# 尾部只吃同行空白:退化 infotext("Negative prompt: \nSteps: ...")中,
# \s* 会吞掉换行导致 end() 落到参数行之后,整段参数被误判为负面 prompt
_NEGATIVE_RE = re.compile(r"Negative prompt\s*:[ \t]*", re.IGNORECASE)
_LORA_TAG_RE = re.compile(
    r"<\s*lora\s*:\s*([^<>\r\n]+?)\s*:\s*"
    r"([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*>",
    re.IGNORECASE,
)


def _field_starts(segment: str) -> list[tuple[int, int, str]]:
    """Find reliable known/unknown field starts with quote-aware values.

    A quote only starts when it is the first non-space character after a
    field's colon.  Unknown comma-delimited keys are accepted only when their
    names look like parameter labels (contain whitespace); this avoids treating
    ``bar: baz`` inside an unquoted model value as a field boundary.
    """
    starts: list[tuple[int, int, str]] = []
    index = 0
    while index < len(segment):
        if index and segment[index - 1] not in ",\n":
            index += 1
            continue
        key_start = index
        while key_start < len(segment) and segment[key_start].isspace():
            key_start += 1
        cursor = key_start
        while cursor < len(segment) and segment[cursor] not in ",\n:":
            cursor += 1
        if cursor >= len(segment) or segment[cursor] != ":":
            index += 1
            continue
        key = segment[key_start:cursor].strip()
        canonical = _canonical_key(key)
        previous_char = segment[index - 1] if index else ""
        if (
            canonical not in _KNOWN_KEYS
            and " " not in key
            and previous_char not in "\n"
        ):
            index += 1
            continue
        if key.startswith(('"', "'")) and key.endswith(('"', "'")):
            index += 1
            continue
        value_start = cursor + 1
        while value_start < len(segment) and segment[value_start].isspace():
            value_start += 1
        starts.append((key_start, value_start, key))

        if value_start < len(segment) and segment[value_start] in "\"'":
            quote = segment[value_start]
            scan = value_start + 1
            while scan < len(segment):
                if segment[scan] == quote and segment[scan - 1] != "\\":
                    scan += 1
                    break
                scan += 1
            index = scan
        else:
            index = value_start
        while index < len(segment) and segment[index] not in ",\n":
            index += 1
        if index < len(segment):
            index += 1
    return starts


def _canonical_key(key: str) -> str:
    for known in _KNOWN_KEYS:
        if known.lower() == key.lower():
            return known
    return key.strip()


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _scan_fields(segment: str) -> dict[str, str]:
    """Scan known and unknown A1111 keys while respecting quoted values."""
    starts = _field_starts(segment)
    fields: dict[str, str] = {}
    for index, (_, value_start, key) in enumerate(starts):
        end = starts[index + 1][0] if index + 1 < len(starts) else len(segment)
        value = _unquote(segment[value_start:end].strip().rstrip(",").strip())
        if value:
            fields[_canonical_key(key)] = value
    return fields


def _int_value(value: str | None) -> int | None:
    if value is None or not re.fullmatch(r"[+-]?\d+", value.strip()):
        return None
    try:
        return int(value.strip())
    except (ValueError, OverflowError):
        return None


def _float_value(value: str | None) -> float | None:
    if value is None or not re.fullmatch(
        r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", value.strip()
    ):
        return None
    try:
        return float(value.strip())
    except (ValueError, OverflowError):
        return None


def _positive_lora_items(value: object) -> list[dict[str, Any]]:
    """Extract canonical A1111 ``<lora:name:weight>`` tags in prompt order."""
    if not isinstance(value, str):
        return []
    items: list[dict[str, Any]] = []
    seen: set[tuple[str, float]] = set()
    for match in _LORA_TAG_RE.finditer(value):
        name = match.group(1).strip()
        if not name:
            continue
        try:
            strength = float(match.group(2))
        except (ValueError, OverflowError):
            continue
        key = (name, strength)
        if key in seen:
            continue
        seen.add(key)
        items.append(
            {
                "source": SOURCE_NODE_TYPE,
                "name": name,
                "strength": strength,
                "strength_model": strength,
                "strength_clip": strength,
            }
        )
    return items


def _apply_positive_loras(record: dict[str, Any], positive: object) -> None:
    """Fill an empty Record LoRA collection without overriding graph results."""
    items = _positive_lora_items(positive)
    if not items:
        return
    loras = record.get("loras")
    if not isinstance(loras, dict):
        loras = {"count": 0, "names": [], "items": [], "model_source_hint": None}
        record["loras"] = loras
    existing_items = loras.get("items")
    if existing_items is not None and not isinstance(existing_items, list):
        return
    if existing_items:
        return
    loras["items"] = items
    loras["count"] = len(items)
    loras["names"] = list(dict.fromkeys(item["name"] for item in items))


def _parameter_block_start(text: str, start: int) -> int:
    """Expand a candidate across a validated newline parameter suffix.

    Repeated known keys are treated as a boundary: a later typed-valid field
    wins, while an earlier prompt-like ``Steps:``/``Sampler:``/``Model:`` line
    remains prompt content.
    """
    line_start = text.rfind("\n", 0, start) + 1
    current_block = text[start:]
    current_keys = set(_scan_fields(current_block))
    while line_start > 0:
        previous_end = line_start - 1
        previous_start = text.rfind("\n", 0, previous_end) + 1
        previous_line = text[previous_start:previous_end]
        if not _line_looks_like_parameter(previous_line):
            break
        previous_key = previous_line.strip().split(":", 1)[0].strip()
        previous_canonical = _canonical_key(previous_key)
        if previous_canonical in current_keys:
            break
        if previous_canonical == "Model":
            value = previous_line.split(":", 1)[1].strip().rstrip(",").strip()
            quoted = len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'"
            if not quoted and (
                not value
                or value.lower().startswith(("prompt", "avoid"))
                or " " in value
            ):
                break
        line_start = previous_start
        current_block = text[line_start:]
        current_keys = set(_scan_fields(current_block))
    return line_start


def _line_looks_like_parameter(line: str) -> bool:
    stripped = line.strip()
    if not stripped or ":" not in stripped:
        return False
    key, value = stripped.split(":", 1)
    key = key.strip()
    value = value.strip().rstrip(",").strip()
    canonical = _canonical_key(key)
    if canonical == "Negative prompt":
        return False
    if canonical in {"Steps", "Seed"}:
        return _int_value(value) is not None
    if canonical == "CFG scale":
        return _float_value(value) is not None
    if canonical == "Size":
        return re.fullmatch(r"\d+\s*x\s*\d+", value) is not None
    if canonical in {"Sampler", "Model"}:
        return bool(value)
    if key.startswith(('"', "'")):
        return False
    return bool(value) and (" " in key or key[:1].isupper())


def _parameter_block(text: str, start: int) -> str:
    block_start = _parameter_block_start(text, start)
    lines = text[block_start:].splitlines(keepends=True)
    block: list[str] = []
    for line in lines:
        if block and not _PARAM_LINE_RE.match(line):
            break
        block.append(line)
    return "".join(block)


def _valid_parameter_block(block: str) -> bool:
    fields = _scan_fields(block)
    if not fields:
        return False
    numeric_valid = any(
        (
            key in fields
            and (
                (_int_value(fields.get(key)) is not None if key in {"Steps", "Seed"} else False)
                or (_float_value(fields.get(key)) is not None if key == "CFG scale" else False)
                or (re.fullmatch(r"\s*\d+\s*x\s*\d+\s*", fields.get(key, "")) is not None if key == "Size" else False)
            )
        )
        for key in ("Steps", "Seed", "CFG scale", "Size")
    )
    string_valid = any(
        fields.get(key, "").strip() for key in ("Sampler", "Model") if key in fields
    )
    return numeric_valid or string_valid


def _parameter_start(text: str) -> int | None:
    """Find the last candidate that forms a valid A1111 parameter block."""
    candidates = list(
        re.finditer(rf"(?im)^[ \t]*(?:{_KEY_PATTERN})\s*:\s*", text)
    )
    for match in reversed(candidates):
        block_start = _parameter_block_start(text, match.start())
        block = _parameter_block(text, match.start())
        if _valid_parameter_block(block):
            return block_start
    return None


def parse_infotext(value: object) -> dict[str, object] | None:
    """Parse an A1111 infotext, returning ``None`` for non-infotext input."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    negative_match = _NEGATIVE_RE.search(text)

    parameter_start = _parameter_start(text)
    if parameter_start is None:
        # A prompt-only comment is not an A1111 infotext.  This detection gate
        # prevents arbitrary captions and JSON comments from being rewritten.
        return None

    parameter_segment = text[parameter_start:]
    fields = _scan_fields(parameter_segment)
    if not fields:
        return None

    prompt_end = negative_match.start() if negative_match else parameter_start
    positive = text[:prompt_end].strip()
    negative: str | None = None
    if negative_match:
        negative_end = parameter_start if parameter_start > negative_match.end() else len(text)
        negative = text[negative_match.end() : negative_end].strip()

    parsed: dict[str, object] = {"params": fields}
    if positive:
        parsed["positive"] = positive
    if negative:
        parsed["negative"] = negative

    if (steps := _int_value(fields.get("Steps"))) is not None:
        parsed["steps"] = steps
    if sampler_name := fields.get("Sampler"):
        parsed["sampler_name"] = sampler_name
    if (cfg := _float_value(fields.get("CFG scale"))) is not None:
        parsed["cfg"] = cfg
    if (seed := _int_value(fields.get("Seed"))) is not None:
        parsed["seed"] = seed

    size = fields.get("Size", "")
    size_match = re.fullmatch(r"\s*(\d+)\s*x\s*(\d+)\s*", size)
    if size_match:
        parsed["width"] = int(size_match.group(1))
        parsed["height"] = int(size_match.group(2))

    if model := fields.get("Model"):
        parsed["model"] = model
    if model_hash := fields.get("Model hash"):
        parsed["model_hash"] = model_hash
    return parsed


def _has_value(value: Any) -> bool:
    return value not in (None, "", {}, [])


def _valid_dimension(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _size_token(record: dict[str, Any]) -> tuple[int, int] | None:
    for source in (record.get("latent"), record.get("file")):
        if not isinstance(source, dict):
            continue
        width, height = source.get("width"), source.get("height")
        if (
            isinstance(width, int)
            and not isinstance(width, bool)
            and isinstance(height, int)
            and not isinstance(height, bool)
            and width > 0
            and height > 0
        ):
            return width, height
    return None


def _apply_inner(record: dict[str, Any]) -> dict[str, Any]:
    metadata = record.get("metadata")
    if not isinstance(metadata, dict):
        return record
    raw = metadata.get("raw_parameters")
    if not isinstance(raw, str) or not raw.strip():
        extra = metadata.get("extra")
        raw = extra.get("comment") if isinstance(extra, dict) else None
    parsed = parse_infotext(raw)
    if not parsed:
        return record

    # A1111 embeds LoRA use in positive prompt tags rather than graph nodes.
    # This independent fill runs before the complete-record fast path so an
    # otherwise populated parser record can still recover its empty LoRA list.
    _apply_positive_loras(record, parsed.get("positive"))

    # A record that already has every relevant source populated is not an
    # A1111 fallback target.  Return before touching metadata or derived keys.
    prompts_existing = record.get("prompts")
    samplers_existing = record.get("samplers")
    latent_existing = record.get("latent")
    model_existing = record.get("model")
    batch_existing = record.get("batch_key")
    if (
        isinstance(prompts_existing, dict)
        and isinstance(prompts_existing.get("positive"), list)
        and prompts_existing.get("positive")
        and isinstance(prompts_existing.get("negative"), list)
        and prompts_existing.get("negative")
        and isinstance(samplers_existing, list)
        and samplers_existing
        and isinstance(latent_existing, dict)
        and latent_existing
        and isinstance(model_existing, dict)
        and model_existing
        and isinstance(batch_existing, str)
        and batch_existing
        and not batch_existing.startswith("file:")
    ):
        return record

    extra = metadata.get("extra")
    a1111_extra = {
        key: value
        for key, value in parsed.get("params", {}).items()
        if key not in {"Steps", "Sampler", "CFG scale", "Seed", "Size", "Model"}
        and isinstance(value, str)
    }
    if isinstance(extra, dict):
        if a1111_extra:
            existing = extra.get("a1111")
            if not isinstance(existing, dict):
                existing = {}
            existing.update(a1111_extra)
            extra["a1111"] = existing
    elif a1111_extra:
        # Preserve malformed existing metadata. Unknown A1111 params are
        # optional enrichment; keep them in a sidecar rather than erasing the
        # original value before metadata diagnostics runs.
        extra_diagnostics = metadata.get("extra_diagnostics")
        if not isinstance(extra_diagnostics, dict):
            extra_diagnostics = {}
            metadata["extra_diagnostics"] = extra_diagnostics
        existing = extra_diagnostics.get("a1111")
        if not isinstance(existing, dict):
            existing = {}
        existing.update(a1111_extra)
        extra_diagnostics["a1111"] = existing

    prompts = record.get("prompts")
    if not isinstance(prompts, dict):
        prompts = {}
        record["prompts"] = prompts
    positive = prompts.get("positive")
    negative = prompts.get("negative")
    if not isinstance(positive, list):
        positive = []
        prompts["positive"] = positive
    if not isinstance(negative, list):
        negative = []
        prompts["negative"] = negative
    if not positive and isinstance(parsed.get("positive"), str):
        positive.append(
            prompt_payload(
                parsed["positive"],
                source_node_type=SOURCE_NODE_TYPE,
                branch_label="a1111-positive",
            )
        )
    if not negative and isinstance(parsed.get("negative"), str):
        negative.append(
            prompt_payload(
                parsed["negative"],
                source_node_type=SOURCE_NODE_TYPE,
                branch_label="a1111-negative",
            )
        )
    if not prompts.get("search_text"):
        prompts["search_text"] = build_prompt_search_text(positive, negative)
    if "by_sampler" not in prompts or not isinstance(prompts.get("by_sampler"), list):
        prompts["by_sampler"] = []

    samplers = record.get("samplers")
    if not isinstance(samplers, list):
        samplers = []
        record["samplers"] = samplers
    sampler: dict[str, Any] | None = None
    if samplers and isinstance(samplers[0], dict):
        sampler = samplers[0]
        for parsed_key, sampler_key in (
            ("steps", "steps"),
            ("sampler_name", "sampler_name"),
            ("cfg", "cfg"),
        ):
            if parsed_key in parsed and not _has_value(sampler.get(sampler_key)):
                sampler[sampler_key] = parsed[parsed_key]
        seed = parsed.get("seed")
        if (
            isinstance(seed, int)
            and not isinstance(seed, bool)
            and seed != 0
            and not _has_value(sampler.get("seed"))
        ):
            sampler["seed"] = seed
    else:
        sampler = {"node_type": SOURCE_NODE_TYPE}
        for parsed_key, sampler_key in (
            ("steps", "steps"),
            ("sampler_name", "sampler_name"),
            ("cfg", "cfg"),
        ):
            if parsed_key in parsed:
                sampler[sampler_key] = parsed[parsed_key]
        seed = parsed.get("seed")
        if isinstance(seed, int) and not isinstance(seed, bool) and seed != 0:
            sampler["seed"] = seed
        if len(sampler) > 1:
            samplers.append(sampler)

    file_info = record.get("file")
    latent = record.get("latent")
    if not isinstance(latent, dict):
        latent = {}
        record["latent"] = latent
    parsed_width, parsed_height = parsed.get("width"), parsed.get("height")
    file_width = file_info.get("width") if isinstance(file_info, dict) else None
    file_height = file_info.get("height") if isinstance(file_info, dict) else None
    if not _valid_dimension(latent.get("width")):
        if _valid_dimension(parsed_width):
            latent["width"] = parsed_width
        elif _valid_dimension(file_width):
            latent["width"] = file_width
    if not _valid_dimension(latent.get("height")):
        if _valid_dimension(parsed_height):
            latent["height"] = parsed_height
        elif _valid_dimension(file_height):
            latent["height"] = file_height

    model_name = parsed.get("model")
    model = record.get("model")
    if not isinstance(model, dict):
        model = {}
        record["model"] = model
    if isinstance(model_name, str) and model_name:
        if not _has_value(model.get("base_model")):
            model["base_model"] = model_name
        nodes = model.get("nodes")
        if not isinstance(nodes, list):
            nodes = []
            model["nodes"] = nodes
        if not nodes:
            nodes.append(
                {"node_type": SOURCE_NODE_TYPE, "model_name": model_name}
            )

    seed = parsed.get("seed")
    batch_key = record.get("batch_key")
    if isinstance(seed, int) and not isinstance(seed, bool) and seed != 0:
        if (
            not isinstance(batch_key, str)
            or not batch_key
            or batch_key.startswith(("file:", "seed:0@"))
        ):
            sha256 = file_info.get("sha256", "") if isinstance(file_info, dict) else ""
            record["batch_key"] = BATCH_PREFIX + batch_group_key(
                [{"seed": seed}],
                sha256_fallback=sha256 if isinstance(sha256, str) else "",
                size=_size_token(record),
            )
    return record


def apply(record: dict[str, object]) -> dict[str, object]:
    """Apply A1111 mappings in place; malformed records are returned unchanged."""
    try:
        if not isinstance(record, dict):
            return record
        return _apply_inner(record)
    except Exception:
        return record
