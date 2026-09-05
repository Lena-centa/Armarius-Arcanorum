"""Entry point for generate_worker.

Run as:
    python -m workflow_db.generate_worker

Lifecycle mirrors parse_worker.__main__:
1. Emit ``ready`` message on stdout.
2. Enter stdin read loop: read JSON-RPC request, dispatch, loop.
3. Single-threaded. Crash safety is the supervisor's job (NestJS side).
"""
from __future__ import annotations

import sys
import traceback

from . import __version__
from .methods import METHODS
from workflow_db.parse_worker.protocol import (
    PARSE_ERROR,
    INVALID_REQUEST,
    dispatch,
    read_request,
    write_log,
    write_ready,
    write_rpc_error,
)


def _force_utf8_io() -> None:
    """Windows 下 Python 默认 stdout/stderr 为 GBK(cp936),JSON-RPC 输出含
    非 ASCII 字符时会 UnicodeEncodeError;强制 UTF-8(NestJS 侧按 UTF-8 解析)。
    """
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8")
            except (ValueError, OSError):
                pass


def main() -> int:
    _force_utf8_io()
    write_log("info", "generate_worker starting", version=__version__)

    method_names = sorted(METHODS.keys())
    write_ready(__version__, method_names)
    write_log("info", "ready emitted", methods=method_names)

    while True:
        try:
            request = read_request(sys.stdin)
        except (ValueError, OSError) as exc:
            write_rpc_error("", PARSE_ERROR, f"parse error: {exc}")
            continue
        except KeyboardInterrupt:
            write_log("info", "interrupted, exiting")
            return 0

        if request is None:
            write_log("info", "stdin EOF, exiting")
            return 0

        if not isinstance(request, dict):
            write_rpc_error("", INVALID_REQUEST, "request must be a JSON object")
            continue

        try:
            dispatch(request, METHODS)
        except Exception:  # noqa: BLE001
            write_log("error", "dispatcher raised unexpectedly",
                      traceback=traceback.format_exc())


if __name__ == "__main__":
    sys.exit(main())
