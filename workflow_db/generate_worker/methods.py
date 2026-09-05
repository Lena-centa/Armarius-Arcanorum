"""Method handlers for generate_worker.

Each handler corresponds to a JSON-RPC method. Protocol framework is
shared with parse_worker (import from parse_worker.protocol).

Handlers:
    ping                — health check
    build_replay_source — wraps comfy_replay.build_replay_source
    apply_replay_edits  — wraps comfy_replay.apply_replay_edits
    fetch_object_info   — wraps comfy_replay.fetch_object_info
    push_workflow       — wraps comfy_replay.push_workflow_to_comfyui
    submit              — ComfyUI POST /prompt
    queue               — ComfyUI GET /queue (summarized)
    history             — ComfyUI GET /history (summarized)
    history_by_id       — ComfyUI GET /history/{id} (summarized)
    extract_derived_summary — single-record derived summary
    extract_derived_batch    — batch derived summary (list view)

These handlers are pure re: no Mongo, no FastAPI, no global state
beyond a cached ComfyClient. NestJS owns Mongo and orchestration.
"""
from __future__ import annotations

import time
from typing import Any
from urllib.parse import quote

from workflow_db.comfy_replay import (
    ComfyClient,
    ReplayUnsupportedError,
    apply_replay_edits,
    build_replay_source,
    fetch_object_info,
    parse_json_field,
    push_workflow_to_comfyui,
    summarize_history_entry,
    summarize_queue_entry,
)
from workflow_db.config import settings
from workflow_db.parse_worker.protocol import (
    INVALID_PARAMS,
    ProtocolError,
)

__version__ = "1.0"

# Application-specific error codes (offset from parse_worker's -32000 range)
ERR_COMFYUI_UNREACHABLE = -32010
ERR_COMFYUI_HTTP = -32011
ERR_SOURCE_NOT_FOUND = -32012
ERR_REPLAY_UNSUPPORTED = -32013

_START_TIME = time.monotonic()

# Cached ComfyClient (reused across requests, connection pool friendly)
_client: ComfyClient | None = None


def _get_client() -> ComfyClient:
    global _client
    if _client is None:
        _client = ComfyClient(settings.comfyui_base_url)
    return _client


def _comfyui_call(fn: str, *args: Any) -> Any:
    """Wrap a ComfyClient call, translating RuntimeError to ProtocolError."""
    client = _get_client()
    try:
        return getattr(client, fn)(*args)
    except RuntimeError as exc:
        msg = str(exc)
        if "HTTP" in msg:
            raise ProtocolError(ERR_COMFYUI_HTTP, f"ComfyUI HTTP error: {msg}") from exc
        raise ProtocolError(ERR_COMFYUI_UNREACHABLE, f"ComfyUI unreachable: {msg}") from exc


# ---------------------------------------------------------------------------
# ping (protocol §4.3 equivalent)
# ---------------------------------------------------------------------------

def _ping(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "version": __version__,
        "uptime_s": round(time.monotonic() - _START_TIME, 1),
    }


# ---------------------------------------------------------------------------
# build_replay_source — wraps comfy_replay.build_replay_source
# ---------------------------------------------------------------------------

def _build_replay_source(params: dict[str, Any]) -> dict[str, Any]:
    doc = params.get("doc")
    sha256 = params.get("sha256")
    if not isinstance(doc, dict):
        raise ProtocolError(INVALID_PARAMS, "doc must be an object")
    if not isinstance(sha256, str) or not sha256:
        raise ProtocolError(INVALID_PARAMS, "sha256 must be a non-empty string")
    try:
        return build_replay_source(doc, sha256, _get_client())
    except ReplayUnsupportedError as exc:
        raise ProtocolError(ERR_REPLAY_UNSUPPORTED, str(exc)) from exc
    except KeyError as exc:
        raise ProtocolError(ERR_SOURCE_NOT_FOUND, f"image not found: {exc}") from exc
    except ValueError as exc:
        raise ProtocolError(ERR_SOURCE_NOT_FOUND, str(exc)) from exc
    except RuntimeError as exc:
        msg = str(exc)
        if "HTTP" in msg:
            raise ProtocolError(ERR_COMFYUI_HTTP, f"ComfyUI object_info fetch failed: {msg}") from exc
        raise ProtocolError(ERR_COMFYUI_UNREACHABLE, f"ComfyUI unreachable: {msg}") from exc


# ---------------------------------------------------------------------------
# apply_replay_edits — wraps comfy_replay.apply_replay_edits
# ---------------------------------------------------------------------------

def _apply_replay_edits(params: dict[str, Any]) -> dict[str, Any]:
    source = params.get("source")
    edits = params.get("edits")
    object_info = params.get("object_info", {})
    if not isinstance(source, dict):
        raise ProtocolError(INVALID_PARAMS, "source must be an object")
    if not isinstance(edits, dict):
        raise ProtocolError(INVALID_PARAMS, "edits must be an object")
    return apply_replay_edits(source, edits, object_info)


# ---------------------------------------------------------------------------
# fetch_object_info — wraps comfy_replay.fetch_object_info
# ---------------------------------------------------------------------------

def _fetch_object_info(params: dict[str, Any]) -> dict[str, Any]:
    node_types_raw = params.get("node_types")
    if not isinstance(node_types_raw, list):
        raise ProtocolError(INVALID_PARAMS, "node_types must be an array")
    node_types = {str(t) for t in node_types_raw if t}
    if not node_types:
        return {}
    try:
        return fetch_object_info(_get_client(), node_types)
    except RuntimeError as exc:
        msg = str(exc)
        if "HTTP" in msg:
            raise ProtocolError(ERR_COMFYUI_HTTP, f"ComfyUI HTTP error: {msg}") from exc
        raise ProtocolError(ERR_COMFYUI_UNREACHABLE, f"ComfyUI unreachable: {msg}") from exc


# ---------------------------------------------------------------------------
# push_workflow — 把 UI workflow 写入 ComfyUI 用户目录(供 ?workflow= 打开)
# ---------------------------------------------------------------------------

def _push_workflow(params: dict[str, Any]) -> dict[str, Any]:
    workflow = params.get("workflow")
    filename = params.get("filename")
    if not isinstance(workflow, dict):
        raise ProtocolError(INVALID_PARAMS, "workflow must be an object")
    if not isinstance(filename, str) or not filename:
        raise ProtocolError(INVALID_PARAMS, "filename must be a non-empty string")
    try:
        return push_workflow_to_comfyui(_get_client(), workflow, filename)
    except ValueError as exc:
        raise ProtocolError(INVALID_PARAMS, str(exc)) from exc
    except RuntimeError as exc:
        msg = str(exc)
        if "HTTP" in msg:
            raise ProtocolError(ERR_COMFYUI_HTTP, f"ComfyUI HTTP error: {msg}") from exc
        raise ProtocolError(ERR_COMFYUI_UNREACHABLE, f"ComfyUI unreachable: {msg}") from exc


# ---------------------------------------------------------------------------
# extract_derived_summary — 详情单条摘要(不含 raw_prompt 全量)
#   复用 build_replay_source(含 node_graph),但摘要只读持久化元数据,
#   不应因为 ComfyUI 停止或地址不可达而失败。
# extract_derived_batch — 列表批量摘要(不含 raw_prompt 全量)
#   build_sampler_views 轻量提取(零 ComfyUI 依赖,失败静默)
# ---------------------------------------------------------------------------

def _cn_summary(cn: dict[str, Any]) -> dict[str, Any]:
    return {
        "node_id": cn.get("node_id"),
        "node_type": cn.get("node_type") or cn.get("apply_type") or cn.get("loader_type"),
        "loader_node_id": cn.get("loader_node_id"),
        "name": cn.get("control_net_name") or cn.get("name", ""),
        "strength": cn.get("strength"),
        "start_percent": cn.get("start_percent"),
        "end_percent": cn.get("end_percent"),
        "enabled": cn.get("enabled"),
        "bypassed": cn.get("bypassed"),
        "bindings": [
            {
                "sampler_id": b.get("sampler_id"),
                "polarity": b.get("polarity"),
                "steps": b.get("steps"),
                "effective_start_step": b.get("effective_start_step"),
                "effective_end_step": b.get("effective_end_step"),
            }
            for b in (cn.get("bindings") or [])
        ],
    }


class _OfflineObjectInfoClient:
    """为纯元数据摘要提供空的 object_info。"""

    def get_json(self, _path: str) -> dict[str, Any]:
        return {}


def _extract_derived_summary(params: dict[str, Any]) -> dict[str, Any]:
    doc = params.get("doc")
    sha256 = params.get("sha256")
    if not isinstance(doc, dict):
        raise ProtocolError(INVALID_PARAMS, "doc must be an object")
    if not isinstance(sha256, str) or not sha256:
        raise ProtocolError(INVALID_PARAMS, "sha256 must be a non-empty string")
    try:
        source = build_replay_source(doc, sha256, _OfflineObjectInfoClient())
    except (KeyError, ValueError) as exc:
        raise ProtocolError(ERR_SOURCE_NOT_FOUND, str(exc)) from exc
    except RuntimeError as exc:
        msg = str(exc)
        if "HTTP" in msg:
            raise ProtocolError(ERR_COMFYUI_HTTP, f"ComfyUI HTTP error: {msg}") from exc
        raise ProtocolError(ERR_COMFYUI_UNREACHABLE, f"ComfyUI unreachable: {msg}") from exc
    editable = source.get("editable", {}) or {}
    return {
        "controlnets": [_cn_summary(c) for c in editable.get("controlnets", [])],
        "regions": editable.get("regions", []),
        "node_graph": source.get("node_graph", {}),
    }


def _extract_derived_batch(params: dict[str, Any]) -> dict[str, Any]:
    docs = params.get("docs")
    if not isinstance(docs, list):
        raise ProtocolError(INVALID_PARAMS, "docs must be an array")
    items: list[dict[str, Any]] = []
    for entry in docs:
        if not isinstance(entry, dict):
            continue
        sha = entry.get("sha256")
        doc = entry.get("doc")
        if not isinstance(sha, str) or not isinstance(doc, dict):
            continue
        try:
            prompt = parse_json_field(
                ((doc.get("images") or [{}])[0].get("metadata") or {}).get("raw_prompt")
                or (doc.get("metadata") or {}).get("raw_prompt")
            )
            workflow = parse_json_field(
                ((doc.get("images") or [{}])[0].get("metadata") or {}).get("raw_workflow")
                or (doc.get("metadata") or {}).get("raw_workflow")
            )
            from workflow_db.sampler_view import build_sampler_views

            views = build_sampler_views(
                prompt if isinstance(prompt, dict) else {},
                workflow if isinstance(workflow, dict) else None,
            )
            # 激活项按 apply_node_id、bypassed 项按 loader_node_id 去重;
            # 同一 apply 跨 sampler 视图的 bindings 累积合并
            # (双 sampler 共享 ControlNet 时各自 binding 独立)
            merged: dict[tuple[str, str], dict[str, Any]] = {}
            for v in views:
                for cn in (
                    v.get("controlnets", []) + v.get("bypassed_controlnets", [])
                ):
                    key = (
                        cn.get("apply_node_id") or "",
                        cn.get("loader_node_id") or "",
                    )
                    if key not in merged:
                        merged[key] = dict(cn)
                        merged[key]["bindings"] = list(cn.get("bindings") or [])
                    else:
                        for b in cn.get("bindings") or []:
                            if b.get("sampler_id") not in {
                                x.get("sampler_id") for x in merged[key]["bindings"]
                            }:
                                merged[key]["bindings"].append(b)
            cns = list(merged.values())
            regions = [r for v in views for r in v.get("regions", [])]
            items.append(
                {
                    "sha256": sha,
                    "ok": True,
                    "controlnets": [_cn_summary(c) for c in cns],
                    "region_count": len(regions),
                }
            )
        except Exception as exc:  # noqa: BLE001 — 列表页失败静默,不阻塞整页
            items.append({"sha256": sha, "ok": False, "error": str(exc)[:200]})
    return {"items": items}


# ---------------------------------------------------------------------------
# submit — ComfyUI POST /prompt
# ---------------------------------------------------------------------------

def _submit(params: dict[str, Any]) -> dict[str, Any]:
    payload = params.get("payload")
    if not isinstance(payload, dict):
        raise ProtocolError(INVALID_PARAMS, "payload must be an object")
    result = _comfyui_call("post_json", "/prompt", payload)
    return result


# ---------------------------------------------------------------------------
# queue — ComfyUI GET /queue (summarized)
# ---------------------------------------------------------------------------

def _queue(params: dict[str, Any]) -> dict[str, Any]:
    raw = _comfyui_call("get_json", "/queue")
    running_raw = raw.get("queue_running", []) or []
    pending_raw = raw.get("queue_pending", []) or []
    running = [summarize_queue_entry(e) for e in running_raw if isinstance(e, list)]
    pending = [summarize_queue_entry(e) for e in pending_raw if isinstance(e, list)]
    return {
        "running": running,
        "pending": pending,
        "queue_remaining": (raw.get("exec_info") or {}).get(
            "queue_remaining", len(running) + len(pending)
        ),
    }


# ---------------------------------------------------------------------------
# history — ComfyUI GET /history (summarized)
# ---------------------------------------------------------------------------

def _history(params: dict[str, Any]) -> dict[str, Any]:
    limit = int(params.get("limit", 0) or 0)
    raw = _comfyui_call("get_json", "/history")
    items = []
    for prompt_id, entry in raw.items():
        if not isinstance(entry, dict):
            continue
        summary = summarize_history_entry(str(prompt_id), entry)
        # 只保留 workflow-db-generate-* 客户端提交的条目
        client_id = str(summary.get("client_id") or "")
        if not client_id.startswith("workflow-db-generate-"):
            continue
        items.append(summary)
    # Sort by number descending (most recent first), apply limit
    items.sort(key=lambda x: x.get("number") or 0, reverse=True)
    if limit > 0:
        items = items[:limit]
    return {"items": items, "count": len(items)}


# ---------------------------------------------------------------------------
# history_by_id — ComfyUI GET /history/{id} (summarized)
# ---------------------------------------------------------------------------

def _history_by_id(params: dict[str, Any]) -> dict[str, Any]:
    prompt_id = params.get("prompt_id")
    if not isinstance(prompt_id, str) or not prompt_id:
        raise ProtocolError(INVALID_PARAMS, "prompt_id must be a non-empty string")
    # prompt_id 需 URL 编码后拼入路径(WORK-03):防 ../../ 类构造穿越本地
    # ComfyUI 的 /history 路由(与 comfy_replay.py 的 quote 用法对齐)
    raw = _comfyui_call("get_json", f"/history/{quote(prompt_id, safe='')}")
    entry = raw.get(prompt_id)
    if not isinstance(entry, dict):
        return {"found": False, "item": None}
    return {"found": True, "item": summarize_history_entry(prompt_id, entry)}


# ---------------------------------------------------------------------------
# Method registry
# ---------------------------------------------------------------------------

METHODS = {
    "ping": _ping,
    "build_replay_source": _build_replay_source,
    "apply_replay_edits": _apply_replay_edits,
    "fetch_object_info": _fetch_object_info,
    "push_workflow": _push_workflow,
    "extract_derived_summary": _extract_derived_summary,
    "extract_derived_batch": _extract_derived_batch,
    "submit": _submit,
    "queue": _queue,
    "history": _history,
    "history_by_id": _history_by_id,
}
