"""Build a runtime-authoritative node registry from a live ComfyUI instance.

``/object_info`` is authoritative for the node interface actually registered by
the server. Static source extraction only adds an implementation behavior
contract when the runtime module maps to exactly one cached repository.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
import re
from typing import Any, Mapping
from urllib.parse import urlsplit, urlunsplit
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from .common import ensure_dir, load_json, save_json


def normalize_base_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("ComfyUI URL must be an absolute http(s) URL")
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", "")).rstrip("/")


def fetch_live_snapshot(base_url: str, timeout: float = 60.0) -> dict[str, Any]:
    """Read public metadata endpoints; this function never submits a workflow."""
    base_url = normalize_base_url(base_url)

    def get_json(path: str) -> Any:
        with urlopen(f"{base_url}{path}", timeout=timeout) as response:
            import json
            return json.load(response)

    system_stats = get_json("/system_stats")
    object_info = get_json("/object_info")
    if not isinstance(object_info, dict):
        raise ValueError("ComfyUI /object_info response must be an object")
    snapshot = {
        "base_url": base_url,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "system_stats": system_stats,
        "object_info": object_info,
    }
    try:
        manager = get_json("/customnode/getlist?mode=local&skip_update=true")
        if isinstance(manager, Mapping):
            snapshot["manager_node_packs"] = manager.get("node_packs")
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        # ComfyUI-Manager is optional. Runtime definitions remain complete
        # without it; only repository provenance becomes less precise.
        snapshot["manager_error"] = f"{type(exc).__name__}: {exc}"
    return snapshot


def _key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def _module_install_name(module: str) -> str:
    if module.startswith("custom_nodes."):
        return module.split(".", 2)[1]
    return module.split(".", 1)[0]


def _repo_name(repo: str) -> str:
    return repo.rsplit("/", 1)[-1]


def _github_slug(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    parsed = urlsplit(value.strip())
    if parsed.hostname not in {"github.com", "www.github.com"}:
        return None
    parts = [part for part in parsed.path.strip("/").split("/") if part]
    if len(parts) < 2:
        return None
    return f"{parts[0]}/{parts[1].removesuffix('.git')}"


def _name_tokens(value: str) -> set[str]:
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", value)
    ignored = {"comfy", "comfyui", "custom", "node", "nodes", "pack"}
    return {
        token for token in re.findall(r"[a-z0-9]+", value.casefold())
        if len(token) >= 2 and token not in ignored
    }


def _overlap_name_is_plausible(module: str, repo: str) -> bool:
    if module == "nodes" or module.startswith(("comfy_extras.", "comfy_api_nodes.")):
        return _key(_repo_name(repo)) == "comfyui"
    module_name = _module_install_name(module)
    repo_name = _repo_name(repo)
    if _name_tokens(module_name) & _name_tokens(repo_name):
        return True
    module_core = _key(module_name).replace("comfyui", "").replace("nodes", "")
    repo_core = _key(repo_name).replace("comfyui", "").replace("nodes", "")
    return min(len(module_core), len(repo_core)) >= 3 and (
        module_core in repo_core or repo_core in module_core
    )


def _manager_enabled_repos(manager_node_packs: Any) -> set[str]:
    if not isinstance(manager_node_packs, Mapping):
        return set()
    return {
        slug
        for raw in manager_node_packs.values()
        if isinstance(raw, Mapping) and raw.get("state") == "enabled"
        if (slug := _github_slug(raw.get("repository") or raw.get("reference")))
    }


def _definitions_by_class_type(
    artifact: Mapping[str, Any],
) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = defaultdict(list)
    definitions = artifact.get("definitions")
    if not isinstance(definitions, Mapping):
        return result
    for definition_id, raw in definitions.items():
        if not isinstance(raw, Mapping):
            continue
        class_type = str(raw.get("class_type") or str(definition_id).split("::", 1)[-1])
        item = dict(raw)
        item.setdefault("definition_id", str(definition_id))
        item.setdefault("class_type", class_type)
        result[class_type].append(item)
    return result


def _build_module_repo_map(
    object_info: Mapping[str, Any],
    definitions_by_type: Mapping[str, list[dict[str, Any]]],
    manager_node_packs: Any = None,
) -> dict[str, dict[str, Any]]:
    """Infer install-folder -> repository only from strong aggregate evidence."""
    module_nodes: dict[str, list[str]] = defaultdict(list)
    repos: set[str] = set()
    for class_type, raw in object_info.items():
        if not isinstance(raw, Mapping):
            continue
        module_nodes[str(raw.get("python_module") or "<missing>")].append(str(class_type))
    for definitions in definitions_by_type.values():
        repos.update(str(item.get("repo")) for item in definitions if item.get("repo"))

    repo_keys: dict[str, list[str]] = defaultdict(list)
    for repo in repos:
        repo_keys[_key(_repo_name(repo))].append(repo)

    result: dict[str, dict[str, Any]] = {}
    for module, class_types in module_nodes.items():
        exact = sorted(repo_keys.get(_key(_module_install_name(module)), ()))
        if len(exact) == 1:
            result[module] = {
                "repo": exact[0],
                "method": "install_name_exact",
                "confidence": "high",
                "evidence_count": len(class_types),
            }
            continue

        votes: Counter[str] = Counter()
        for class_type in class_types:
            candidate_repos = {
                str(item.get("repo"))
                for item in definitions_by_type.get(class_type, ())
                if item.get("repo")
            }
            if len(candidate_repos) == 1:
                votes.update(candidate_repos)
        if not votes:
            continue
        ranked = votes.most_common(2)
        best_repo, best_count = ranked[0]
        second_count = ranked[1][1] if len(ranked) > 1 else 0
        total = sum(votes.values())
        if (
            best_count >= 3
            and best_count / total >= 0.8
            and best_count > second_count
            and _overlap_name_is_plausible(module, best_repo)
        ):
            result[module] = {
                "repo": best_repo,
                "method": "class_type_overlap",
                "confidence": "high",
                "evidence_count": best_count,
                "evidence_total": total,
            }

    if isinstance(manager_node_packs, Mapping):
        enabled_by_key: dict[str, set[str]] = defaultdict(set)
        for pack_key, raw in manager_node_packs.items():
            if not isinstance(raw, Mapping) or raw.get("state") != "enabled":
                continue
            slug = _github_slug(raw.get("repository") or raw.get("reference"))
            if not slug:
                continue
            keys = {
                _key(str(pack_key)),
                _key(str(raw.get("id") or "")),
                _key(_repo_name(slug)),
            }
            for key in keys - {""}:
                enabled_by_key[key].add(slug)
        for module in module_nodes:
            candidates = enabled_by_key.get(_key(_module_install_name(module)), set())
            if len(candidates) == 1:
                result[module] = {
                    "repo": next(iter(candidates)),
                    "method": "manager_exact",
                    "confidence": "runtime",
                    "evidence_count": len(module_nodes[module]),
                }
    return result


def _input_type(spec: Any) -> str | None:
    if isinstance(spec, (list, tuple)) and spec:
        head = spec[0]
        if isinstance(head, str):
            return head
        if isinstance(head, (list, tuple)):
            return "ENUM"
    if isinstance(spec, str):
        return spec
    return None


def _runtime_inputs(raw: Mapping[str, Any]) -> dict[str, dict[str, str | None]]:
    result: dict[str, dict[str, str | None]] = {}
    sections = raw.get("input")
    if not isinstance(sections, Mapping):
        return result
    for section_name, fields in sections.items():
        if not isinstance(fields, Mapping):
            continue
        result[str(section_name)] = {
            str(name): _input_type(spec) for name, spec in fields.items()
        }
    return result


def _select_static_definition(
    module: str,
    candidates: list[dict[str, Any]],
    module_map: Mapping[str, Mapping[str, Any]],
    manager_enabled_repos: set[str] | None = None,
) -> tuple[dict[str, Any] | None, str]:
    mapping = module_map.get(module)
    if mapping:
        repo = str(mapping["repo"])
        matches = [item for item in candidates if str(item.get("repo")) == repo]
        if len(matches) == 1:
            return matches[0], str(mapping["method"])
        if len(matches) > 1:
            return None, "ambiguous_definition"
        enabled_matches = [
            item for item in candidates
            if str(item.get("repo")) in (manager_enabled_repos or set())
        ]
        if len(enabled_matches) == 1:
            return enabled_matches[0], "manager_enabled_definition"
        if (
            len(candidates) == 1
            and _overlap_name_is_plausible(
                module, str(candidates[0].get("repo") or "")
            )
        ):
            return candidates[0], "module_name_definition"
        return None, "mapped_repo_definition_missing"
    if module == "<missing>" and len(candidates) == 1:
        return candidates[0], "unique_without_module"
    if not candidates:
        return None, "static_definition_missing"
    return None, "module_unmapped"


def build_runtime_registry(
    snapshot: Mapping[str, Any],
    definitions_artifact: Mapping[str, Any],
) -> dict[str, Any]:
    """Merge runtime interfaces with conservatively matched static behavior."""
    object_info = snapshot.get("object_info")
    if not isinstance(object_info, Mapping):
        raise ValueError("snapshot.object_info must be an object")
    definitions_by_type = _definitions_by_class_type(definitions_artifact)
    manager_enabled_repos = _manager_enabled_repos(snapshot.get("manager_node_packs"))
    module_map = _build_module_repo_map(
        object_info,
        definitions_by_type,
        snapshot.get("manager_node_packs"),
    )

    definitions: dict[str, dict[str, Any]] = {}
    matches: dict[str, dict[str, Any]] = {}
    statuses: Counter[str] = Counter()
    operations: Counter[str] = Counter()
    behavior_contracts = 0
    behavior_resolved = 0
    path_states: Counter[str] = Counter()

    for class_type in sorted(str(item) for item in object_info):
        raw = object_info[class_type]
        if not isinstance(raw, Mapping):
            raw = {}
        module = str(raw.get("python_module") or "<missing>")
        candidates = definitions_by_type.get(class_type, [])
        selected, method = _select_static_definition(
            module,
            candidates,
            module_map,
            manager_enabled_repos,
        )
        statuses[method] += 1
        selected_id = str(selected.get("definition_id")) if selected else None
        semantic = selected.get("semantic") if selected else None
        if isinstance(semantic, Mapping):
            semantic = dict(semantic)
            behavior_contracts += 1
            operation = str(semantic.get("operation") or "opaque")
            operations[operation] += 1
            if operation != "opaque":
                behavior_resolved += 1
        else:
            semantic = None

        output_count = len(raw.get("output") or ())
        if output_count == 0:
            path_states["terminal"] += 1
        elif semantic is None or semantic.get("operation") == "opaque":
            path_states["opaque"] += 1
        else:
            derivation_slots = {
                int(item.get("output_slot"))
                for item in semantic.get("output_derivations") or ()
                if isinstance(item, Mapping)
                and isinstance(item.get("output_slot"), int)
                and item.get("kind") != "opaque"
            }
            known_slots = len(derivation_slots & set(range(output_count)))
            if known_slots == output_count:
                path_states["known"] += 1
            elif known_slots:
                path_states["partial"] += 1
            else:
                path_states["opaque"] += 1

        runtime_id = f"runtime:{module}::{class_type}"
        outputs = raw.get("output")
        definitions[runtime_id] = {
            "definition_id": runtime_id,
            "class_type": class_type,
            "class": str(raw.get("name") or class_type),
            "repo": f"runtime:{module}",
            "python_module": module,
            "inputs": _runtime_inputs(raw),
            "return_types": list(outputs) if isinstance(outputs, (list, tuple)) else [],
            "return_names": (
                list(raw["output_name"])
                if isinstance(raw.get("output_name"), (list, tuple)) else None
            ),
            "resolved_level": "runtime_full",
            "output_node": bool(raw.get("output_node", False)),
            "static_definition_id": selected_id,
            "semantic": semantic,
        }
        matches[class_type] = {
            "runtime_definition_id": runtime_id,
            "python_module": module,
            "candidate_definition_ids": sorted(
                str(item.get("definition_id")) for item in candidates
            ),
            "selected_static_definition_id": selected_id,
            "selection_method": method,
            "behavior": "known" if semantic is not None else "opaque",
        }

    live_count = len(definitions)
    system_stats = snapshot.get("system_stats")
    system = system_stats.get("system", {}) if isinstance(system_stats, Mapping) else {}
    return {
        "schema_version": 1,
        "source": {
            "base_url": snapshot.get("base_url"),
            "fetched_at": snapshot.get("fetched_at"),
            "comfyui_version": system.get("comfyui_version"),
        },
        "summary": {
            "runtime_definition_total": live_count,
            "runtime_definition_coverage": 1.0 if live_count else 0.0,
            "static_behavior_contracts": behavior_contracts,
            "static_behavior_contract_coverage": (
                behavior_contracts / live_count if live_count else 0.0
            ),
            "behavior_resolved": behavior_resolved,
            "behavior_resolved_coverage": (
                behavior_resolved / live_count if live_count else 0.0
            ),
            "behavior_opaque": live_count - behavior_resolved,
            "path_states": dict(sorted(path_states.items())),
            "selection_statuses": dict(sorted(statuses.items())),
            "semantic_operations": dict(sorted(operations.items())),
            "module_total": len({item["python_module"] for item in matches.values()}),
            "module_mapped": len(module_map),
        },
        "module_mappings": dict(sorted(module_map.items())),
        "matches": matches,
        "definitions": definitions,
    }


def capture_runtime_registry(
    base_url: str,
    workdir: Path,
    timeout: float = 60.0,
) -> Path:
    definitions_path = workdir / "node_defs.json"
    if not definitions_path.exists():
        raise FileNotFoundError(f"missing {definitions_path}; run extract/rebuild-cache first")
    snapshot = fetch_live_snapshot(base_url, timeout=timeout)
    live_dir = ensure_dir(workdir / "live")
    save_json(live_dir / "system_stats.json", snapshot["system_stats"])
    save_json(live_dir / "object_info.json", snapshot["object_info"])
    if isinstance(snapshot.get("manager_node_packs"), Mapping):
        save_json(live_dir / "manager_node_packs.json", snapshot["manager_node_packs"])
    registry = build_runtime_registry(snapshot, load_json(definitions_path))
    output = live_dir / "runtime_registry.json"
    save_json(output, registry)
    return output


__all__ = [
    "build_runtime_registry",
    "capture_runtime_registry",
    "fetch_live_snapshot",
    "normalize_base_url",
]
