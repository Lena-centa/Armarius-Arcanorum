"""JSON-RPC 2.0 protocol layer for parse_worker.

Implements the wire format defined in docs/contracts/parse_worker_protocol.md:

- Transport: stdin/stdout, line-delimited
- Message types by stream: rpc/binary/ready→stdout; log→stderr
    {"type":"rpc",...}      JSON-RPC response (stdout)
    {"type":"binary",...}   binary frame header (stdout, followed by raw bytes)
    {"type":"log",...}      structured log (stderr)
    {"type":"ready",...}    worker ready handshake (stdout)

Binary frames are length-prefixed to avoid base64 bloat and to handle
bytes that contain 0x0A (newline) correctly. See protocol §2.3.

This module is pure I/O and serialization. Method dispatch is in
``methods.py``. The main loop is in ``__main__.py``.
"""

from __future__ import annotations

import base64
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path as _Path
from typing import Any, BinaryIO, Callable, TextIO


# ---------------------------------------------------------------------------
# JSON encoding
# ---------------------------------------------------------------------------

class _RecordEncoder(json.JSONEncoder):
    """JSON encoder for record payloads.

    parser.py emits Python-native types that aren't JSON-serializable:
    - datetime.datetime  → ISO 8601 with 'Z' suffix (UTC)
    - datetime.date      → ISO 8601 date
    - pathlib.Path       → str(path)
    - set / frozenset    → list
    - bytes-like values  → tagged Base64 object

    All other types fall back to the default encoder.

    This is the single source of truth for record serialization.
    DO NOT add ad-hoc conversions elsewhere — they will diverge.
    """

    def default(self, obj: Any) -> Any:  # noqa: D401
        if isinstance(obj, datetime):
            # parser.py uses tz-aware UTC datetimes (PARSER_SPEC §4.1).
            # Emit ISO 8601 with 'Z' per PARSER_SPEC §4.1 约定.
            if obj.tzinfo is None:
                # Treat naive datetime as UTC (legacy fallback)
                obj = obj.replace(tzinfo=timezone.utc)
            return obj.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        if isinstance(obj, date):
            return obj.isoformat()
        if isinstance(obj, _Path):
            return str(obj)
        if isinstance(obj, (set, frozenset)):
            return sorted(obj)
        if isinstance(obj, (bytes, bytearray, memoryview)):
            payload = bytes(obj)
            return {
                "__type__": "bytes",
                "encoding": "base64",
                "length": len(payload),
                "data": base64.b64encode(payload).decode("ascii"),
            }
        return super().default(obj)


def _dumps(payload: dict[str, Any]) -> str:
    """Serialize a message to a single JSON line."""
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        cls=_RecordEncoder,
    )


# ---------------------------------------------------------------------------
# Standard error codes (protocol §3.4)
# ---------------------------------------------------------------------------

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# Application-specific codes (protocol §3.4)
ERR_IMAGE_OPEN_FAILED = -32000
ERR_IMAGE_NOT_FOUND = -32001
ERR_THUMBNAIL_FAILED = -32002
ERR_WORKER_OVERLOADED = -32003


# ---------------------------------------------------------------------------
# stdout / stderr writers
# ---------------------------------------------------------------------------

def write_line(stream: TextIO, payload: dict[str, Any]) -> None:
    """Write a single JSON message followed by newline to stream.

    Used for rpc/log/ready messages. NOT for binary frames.
    """
    stream.write(_dumps(payload))
    stream.write("\n")
    stream.flush()


def write_log(level: str, msg: str, **extra: Any) -> None:
    """Emit a structured log line to stderr (protocol §7)."""
    payload: dict[str, Any] = {
        "type": "log",
        "level": level,
        "msg": msg,
    }
    payload.update(extra)
    write_line(sys.stderr, payload)


def write_ready(version: str, methods: list[str]) -> None:
    """Emit the ready handshake on stdout (protocol §5.1)."""
    write_line(sys.stdout, {
        "type": "ready",
        "version": version,
        "methods": methods,
    })


def write_rpc_response(req_id: str, result: Any) -> None:
    """Emit a successful JSON-RPC response."""
    write_line(sys.stdout, {
        "type": "rpc",
        "jsonrpc": "2.0",
        "id": req_id,
        "result": result,
    })


def write_rpc_error(req_id: str, code: int, message: str, data: Any = None) -> None:
    """Emit a JSON-RPC error response."""
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    write_line(sys.stdout, {
        "type": "rpc",
        "jsonrpc": "2.0",
        "id": req_id,
        "error": err,
    })


def write_binary_frame(frame_id: str, payload: bytes, mime: str = "image/webp") -> None:
    """Emit a binary frame (protocol §2.3).

    Layout:
        Line N:   {"type":"binary","frame_id":"<id>","length":N,"mime":"..."}
        Line N+1: <N raw bytes, NOT followed by newline within the frame>
        Line N+2: <newline separator>

    The raw bytes may contain 0x0A. The reader MUST consume exactly
    ``length`` bytes via os.read/raw read, then read and discard one
    trailing newline.
    """
    header = {
        "type": "binary",
        "frame_id": frame_id,
        "length": len(payload),
        "mime": mime,
    }
    # Write header + newline
    sys.stdout.write(_dumps(header))
    sys.stdout.write("\n")
    sys.stdout.flush()
    # Write raw bytes via the underlying buffer to avoid text-mode encoding
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()
    # Trailing newline separator (so the next line starts cleanly)
    sys.stdout.write("\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# stdin reader
# ---------------------------------------------------------------------------

def read_request(stream: TextIO) -> dict[str, Any] | None:
    """Read one JSON-RPC request line from stream.

    Returns None on EOF. Raises ValueError on JSON parse failure
    (caller should emit PARSE_ERROR).
    """
    line = stream.readline()
    if not line:
        return None
    line = line.strip()
    if not line:
        return None
    return json.loads(line)


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

class ProtocolError(Exception):
    """Raised by method handlers; mapped to JSON-RPC error."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


# Method handler signature: (params: dict) -> result (Any)
# Handlers may raise ProtocolError for typed errors, or any Exception
# for INTERNAL_ERROR fallback.
MethodHandler = Callable[[dict[str, Any]], Any]


def dispatch(
    request: dict[str, Any],
    handlers: dict[str, MethodHandler],
) -> None:
    """Dispatch a parsed JSON-RPC request to the appropriate handler.

    Emits the response on stdout. Does not raise.
    """
    req_id = request.get("id")
    if req_id is None:
        # JSON-RPC notification (no id): we still respond with an error
        # per our protocol (we don't support notifications in Phase 2).
        write_rpc_error("", INVALID_REQUEST, "notifications not supported")
        return

    if not isinstance(req_id, str):
        # Coerce to string for consistent correlation
        req_id = str(req_id)

    method = request.get("method")
    params = request.get("params", {})
    if not isinstance(params, dict):
        write_rpc_error(req_id, INVALID_PARAMS, "params must be an object")
        return

    if method not in handlers:
        write_rpc_error(req_id, METHOD_NOT_FOUND, f"method not found: {method}")
        return

    try:
        result = handlers[method](params)
        write_rpc_response(req_id, result)
    except ProtocolError as exc:
        write_rpc_error(req_id, exc.code, exc.message, exc.data)
    except Exception as exc:  # noqa: BLE001
        # Internal error: log exception to stderr, return INTERNAL_ERROR
        # to client (with str(exc))
        write_log("error", f"internal error in {method}: {exc!r}",
                  method=method, request_id=req_id)
        write_rpc_error(req_id, INTERNAL_ERROR, str(exc) or "internal error")
