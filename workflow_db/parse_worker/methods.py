"""Method handlers for parse_worker.

Each handler corresponds to a JSON-RPC method defined in
docs/contracts/parse_worker_protocol.md §4.

Handlers:
    parse_image  — wraps parser.parse_image (see PARSER_SPEC §4)
    enrich_record — builds a display-only overlay over an existing Record
    make_thumb   — renders a WEBP thumbnail
    suggest_tags — suggests candidate tags for an image
    ping         — health check

These handlers are pure: no Mongo, no FastAPI, no global state.
"""

from __future__ import annotations

import io
import os
import time
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

from .protocol import (
    ERR_IMAGE_NOT_FOUND,
    ERR_IMAGE_OPEN_FAILED,
    ERR_THUMBNAIL_FAILED,
    ERR_WORKER_OVERLOADED,
    INVALID_PARAMS,
    ProtocolError,
    write_binary_frame,
    write_log,
)

# parser.py is the absolute foundation. Import lazily so that a missing
# dependency surfaces as a clear startup error rather than an import-time crash.
try:
    from workflow_db.parser import parse_image as _parser_parse_image
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "parser.py not found; ensure workflow_db package is on sys.path"
    ) from exc

try:
    from workflow_db.enrichment import enrich_record as _enrich_record
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "enrichment package not found; ensure workflow_db package is on sys.path"
    ) from exc

try:
    from workflow_db.novelai import apply as _novelai_apply
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "novelai adapter not found; ensure workflow_db package is on sys.path"
    ) from exc

try:
    from workflow_db.a1111 import apply as _a1111_apply
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "a1111 adapter not found; ensure workflow_db package is on sys.path"
    ) from exc

try:
    from workflow_db.comfyui_recovery import apply as _comfyui_recovery_apply
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "ComfyUI recovery adapter not found; ensure workflow_db package is on sys.path"
    ) from exc

try:
    from workflow_db.metadata_diagnostics import apply as _metadata_diagnostics_apply
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "metadata diagnostics module not found; ensure workflow_db package is on sys.path"
    ) from exc

try:
    from workflow_db.tag_suggest import suggest as _tag_suggest
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "tag_suggest module not found; ensure workflow_db package is on sys.path"
    ) from exc


# Image.Resampling was introduced in Pillow 9.1. For older Pillow
# (outside our pinned range), keep an Image.LANCZOS fallback.
# Both resolve to the same integer value (1 = LANCZOS).
try:
    _LANCZOS = Image.Resampling.LANCZOS  # type: ignore[attr-defined]
except AttributeError:  # pragma: no cover
    _LANCZOS = Image.LANCZOS  # type: ignore[attr-defined]


_START_TIME = time.monotonic()


# ---------------------------------------------------------------------------
# parse_image (protocol §4.1)
# ---------------------------------------------------------------------------

def parse_image(params: dict[str, Any]) -> dict[str, Any]:
    """Parse a single image and return a record dict.

    Behavior is fully delegated to parser.parse_image, then post-processed
    by the adapter chain (novelai/a1111/comfyui_recovery/
    metadata_diagnostics). See PARSER_SPEC §4 for the complete output
    contract (aligns with record.schema.json).
    """
    raw_path = params.get("path")
    if not isinstance(raw_path, str) or not raw_path:
        raise ProtocolError(INVALID_PARAMS, "path must be a non-empty string")

    path = Path(raw_path)
    if not path.exists() or not path.is_file():
        raise ProtocolError(ERR_IMAGE_NOT_FOUND, f"image not found: {raw_path}")

    scan_root_raw = params.get("scan_root")
    scan_root: Path | None = None
    if isinstance(scan_root_raw, str) and scan_root_raw:
        scan_root = Path(scan_root_raw)

    try:
        record = _parser_parse_image(path, scan_root)
        record = _novelai_apply(record)
        record = _a1111_apply(record)
        record = _comfyui_recovery_apply(record)
        record = _metadata_diagnostics_apply(record)
    except ValueError as exc:
        # parser.extract_image_metadata raises ValueError on PIL failure
        raise ProtocolError(ERR_IMAGE_OPEN_FAILED, str(exc)) from exc
    except Exception as exc:
        # Unexpected: surface as image open failure for client clarity
        raise ProtocolError(ERR_IMAGE_OPEN_FAILED, f"parse failed: {exc!r}") from exc

    return {"record": record, "warnings": []}


# ---------------------------------------------------------------------------
# enrich_record (protocol section 4.4)
# ---------------------------------------------------------------------------

def enrich_record(params: dict[str, Any]) -> dict[str, Any]:
    """Build a display-only enriched view without changing the source Record."""
    record = params.get("record")
    if not isinstance(record, dict):
        raise ProtocolError(INVALID_PARAMS, "record must be an object")

    return _enrich_record(
        record,
        raw_prompt=params.get("raw_prompt"),
        raw_workflow=params.get("raw_workflow"),
    )


# ---------------------------------------------------------------------------
# suggest_tags (Danbooru tag 补全参考,可选功能)
# ---------------------------------------------------------------------------

from workflow_db.tag_suggest import split_tags as _split_tags


def _extract_prompt_tags(prompts: list) -> list[str]:
    """从 prompt 文本数组拆分 tag(共享分词器:语法剥除 + 词表验证 + 贪心)。"""
    tags: list[str] = []
    for text in prompts or []:
        tags.extend(_split_tags(text))
    return tags


def suggest_tags(params: dict[str, Any]) -> dict[str, Any]:
    """组推荐(需求 2):batch 的 prompt tag 组作为多输入 → GNN 组推荐。

    资产/依赖缺失时返回 {"enabled": false}(静默降级,不阻断 ingest)。
    """
    prompts = params.get("prompts")
    if not isinstance(prompts, list):
        raise ProtocolError(INVALID_PARAMS, "prompts must be a list of strings")
    top_k = params.get("top_k", 10)
    tags = _extract_prompt_tags(prompts)
    result = _tag_suggest(tags, top_k=int(top_k))
    if result is None:
        return {"enabled": False}
    return {"enabled": True, **result}


# ---------------------------------------------------------------------------
# make_thumb (protocol §4.2)
# ---------------------------------------------------------------------------

# Parameter bounds (mirrors the reader-query side constraints)
_THUMB_MIN = 64
_THUMB_MAX = 1024
_THUMB_DEFAULT = 360


def make_thumb(params: dict[str, Any]) -> dict[str, Any]:
    """Generate a thumbnail and stream its bytes as a binary frame.

    Replicates the steps below:
      1. PIL.Image.open(resolved_path)
      2. ImageOps.exif_transpose(image)
      3. image.thumbnail((w, h), Image.Resampling.LANCZOS)
      4. Mode normalization: convert to RGBA if 'A' in getbands() else RGB,
         only when mode not in {RGB, RGBA}
      5. Save WEBP quality=82 method=4 to BytesIO

    The binary frame is written to stdout immediately after the JSON
    response header (see protocol §2.3).

    Returns a small dict that becomes the JSON-RPC result; the actual
    bytes travel on the binary frame.
    """
    raw_path = params.get("resolved_path")
    if not isinstance(raw_path, str) or not raw_path:
        raise ProtocolError(INVALID_PARAMS,
                            "resolved_path must be a non-empty string")

    w = params.get("w", _THUMB_DEFAULT)
    h = params.get("h", _THUMB_DEFAULT)
    if not isinstance(w, int) or not (_THUMB_MIN <= w <= _THUMB_MAX):
        raise ProtocolError(INVALID_PARAMS,
                            f"w must be int in [{_THUMB_MIN},{_THUMB_MAX}]")
    if not isinstance(h, int) or not (_THUMB_MIN <= h <= _THUMB_MAX):
        raise ProtocolError(INVALID_PARAMS,
                            f"h must be int in [{_THUMB_MIN},{_THUMB_MAX}]")

    resolved = Path(raw_path)
    if not resolved.exists() or not resolved.is_file():
        raise ProtocolError(ERR_IMAGE_NOT_FOUND, f"source file missing: {raw_path}")

    try:
        payload = _render_thumbnail(resolved, w, h)
    except (OSError, ValueError) as exc:
        raise ProtocolError(ERR_THUMBNAIL_FAILED, str(exc)) from exc
    except Exception as exc:
        raise ProtocolError(ERR_THUMBNAIL_FAILED, f"thumbnail failed: {exc!r}") from exc

    # frame_id correlates the binary frame with this request.
    # Using the request id (passed via params by the supervisor) keeps
    # correlation simple; falls back to a synthesized id.
    frame_id = str(params.get("_request_id") or f"thumb_{int(time.time() * 1000)}")
    write_binary_frame(frame_id, payload, mime="image/webp")

    return {
        "frame_id": frame_id,
        "length": len(payload),
        "mime": "image/webp",
    }


def _render_thumbnail(path: Path, w: int, h: int) -> bytes:
    """Renders a WEBP thumbnail.

    DO NOT modify any parameter. Any change here breaks the byte-equal
    thumbnail output. Keep the WEBP q=82 method=4 parameters unchanged.
    """
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image)
        image.thumbnail((w, h), _LANCZOS)
        output = io.BytesIO()
        save_image = image
        if image.mode not in {"RGB", "RGBA"}:
            save_image = image.convert(
                "RGBA" if "A" in image.getbands() else "RGB"
            )
        save_image.save(output, format="WEBP", quality=82, method=4)
    return output.getvalue()


# ---------------------------------------------------------------------------
# ping (protocol §4.3)
# ---------------------------------------------------------------------------

def ping(_params: dict[str, Any]) -> dict[str, Any]:
    """Health check. No params required."""
    return {
        "pong": True,
        "version": "1.0",
        "uptime_sec": time.monotonic() - _START_TIME,
    }


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

# Exported for __main__.py to register with the dispatcher.
METHODS: dict[str, Any] = {
    "parse_image": parse_image,
    "enrich_record": enrich_record,
    "suggest_tags": suggest_tags,
    "make_thumb": make_thumb,
    "ping": ping,
}
