"""Entry point for parse_worker.

Run as:
    python -m workflow_db.parse_worker

Lifecycle (protocol §5 & §6):

1. Load parser.py and other deps (failures abort with non-zero exit).
2. Emit ``ready`` message on stdout.
3. Enter stdin read loop:
   - Read one JSON-RPC request line.
   - Dispatch to handler (handlers write their own responses).
   - On JSON parse error: emit PARSE_ERROR, continue.
   - On EOF: exit 0.
4. Single-threaded (protocol §6.1). No concurrency in Phase 2.

Crash safety is the supervisor's responsibility (NestJS side).
This process is allowed to die on unrecoverable errors; the
supervisor will restart it.
"""

from __future__ import annotations

import sys
import traceback

from . import __version__
from .methods import METHODS
from .protocol import (
    PARSE_ERROR,
    dispatch,
    read_request,
    write_log,
    write_ready,
)


def _force_utf8_io() -> None:
    """Windows 下 Python 默认 stdout/stderr 为 GBK(cp936),JSON-RPC 输出含
    非 ASCII 字符(中文 prompt)时会 UnicodeEncodeError,导致整个响应失败。
    这里强制 stdin/stdout/stderr 使用 UTF-8(NestJS 侧按 UTF-8 解析)。
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
    # Phase 2: single-threaded, no signal handling. The supervisor
    # owns the lifecycle; we just read, dispatch, write.
    write_log("info", "parse_worker starting", version=__version__)

    # Pre-warm parser.py import (already done in methods.py at import
    # time). If parser.py is missing, methods.py would have failed to
    # import, and this file would not have loaded.
    method_names = sorted(METHODS.keys())
    write_ready(__version__, method_names)
    write_log("info", "ready emitted", methods=method_names)

    # Main loop. Each iteration reads one line, dispatches, loops.
    while True:
        try:
            request = read_request(sys.stdin)
        except (ValueError, OSError) as exc:
            # JSON parse error on stdin line.
            # Per protocol §3.4, emit PARSE_ERROR and continue.
            # We don't have a request id here; use empty string.
            from .protocol import write_rpc_error
            write_rpc_error("", PARSE_ERROR, f"parse error: {exc}")
            continue
        except KeyboardInterrupt:
            write_log("info", "interrupted, exiting")
            return 0

        if request is None:
            # EOF on stdin. Clean exit.
            write_log("info", "stdin EOF, exiting")
            return 0

        if not isinstance(request, dict):
            from .protocol import write_rpc_error, INVALID_REQUEST
            write_rpc_error("", INVALID_REQUEST, "request must be a JSON object")
            continue

        try:
            dispatch(request, METHODS)
        except Exception:  # noqa: BLE001
            # Should never happen — dispatch catches its own exceptions.
            # If it does, log and continue rather than crash.
            write_log("error", "dispatcher raised unexpectedly",
                      traceback=traceback.format_exc())


if __name__ == "__main__":
    sys.exit(main())
