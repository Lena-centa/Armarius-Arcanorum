"""generate_worker: long-running Python worker for NestJS gateway.

Protocol spec: docs/contracts/parse_worker_protocol.md (shared framework)
Method list: docs/archive/NEST_GATEWAY_MIGRATION_PLAN.md Phase 3 task 1

Run as:
    python -m workflow_db.generate_worker

Reads JSON-RPC 2.0 requests from stdin (line-delimited), writes
responses to stdout (line-delimited JSON).

Protocol layer is shared with parse_worker (import parse_worker.protocol).
This package is intentionally thin — it wires comfy_replay.py functions
to JSON-RPC methods. It does NOT touch Mongo (NestJS owns Mongo).
"""
from __future__ import annotations

__version__ = "1.0"

# main 定义于 __main__.py(python -m 入口),不在本包导出范围;
# 列入 __all__ 会使 `from generate_worker import *` 抛 AttributeError
__all__ = ["__version__"]
