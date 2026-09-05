"""parse_worker: long-running Python worker for NestJS gateway.

Protocol spec: docs/contracts/parse_worker_protocol.md

Run as:
    python -m workflow_db.parse_worker

Reads JSON-RPC 2.0 requests from stdin (line-delimited), writes
responses to stdout (line-delimited JSON + length-prefixed binary
frames for thumbnail bytes).

This package is intentionally thin. It only:
- wires parser.parse_image to the JSON-RPC method `parse_image`
- implements make_thumb (EXIF transpose + LANCZOS + WEBP q=82
  method=4 + mode normalization)
- implements enrich_record and suggest_tags
- implements ping for health checks

It does NOT touch Mongo, caches, or background loops. All such
concerns belong to NestJS.
"""

from __future__ import annotations

__version__ = "1.0"

# main 定义于 __main__.py(python -m 入口),不在本包导出范围;
# 列入 __all__ 会使 `from parse_worker import *` 抛 AttributeError
__all__ = ["__version__"]
