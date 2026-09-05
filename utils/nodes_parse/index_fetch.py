"""阶段0：ComfyUI-Manager 生态索引拉取与缓存。

数据源（Comfy-Org/ComfyUI-Manager 官方维护）：
- extension-node-map.json : 仓库 -> [class_type 列表, 元数据]
- custom-node-list.json   : 扩展清单（标题/引用/星标等）

缓存于 <workdir>/cache/，--refresh 强制重新下载。
"""
import json
import urllib.request
from pathlib import Path

from .common import ensure_dir, load_json, save_json

RAW_BASES = (
    "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main",
    "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/master",
)
INDEX_FILES = ("extension-node-map.json", "custom-node-list.json")
TIMEOUT = 30
_UA = {"User-Agent": "workflow-db-nodes-parse/0.1"}


def _fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers=_UA)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def _fetch_index_file(name: str, cache_dir: Path, refresh: bool):
    cache_path = cache_dir / name
    if cache_path.exists() and not refresh:
        return load_json(cache_path), False
    last_err = None
    for base in RAW_BASES:
        try:
            data = _fetch(f"{base}/{name}")
            parsed = json.loads(data.decode("utf-8"))
            save_json(cache_path, parsed)
            return parsed, True
        except Exception as exc:  # noqa: BLE001 - 逐源尝试，最终统一上报
            last_err = exc
    raise RuntimeError(f"拉取 {name} 失败（main/master 双路）：{last_err}")


def fetch_index(workdir: Path, refresh: bool = False) -> dict:
    cache_dir = ensure_dir(workdir / "cache")
    node_map, map_fresh = _fetch_index_file(INDEX_FILES[0], cache_dir, refresh)
    node_list, list_fresh = _fetch_index_file(INDEX_FILES[1], cache_dir, refresh)
    return {
        "extension_node_map": node_map,
        "custom_node_list": node_list,
        "meta": {
            "map_fetched_now": map_fresh,
            "list_fetched_now": list_fresh,
        },
    }


def _repo_key_from_entry(key: str):
    """extension-node-map 的键通常是 github 仓库 URL；返回 owner/name 或 None。"""
    if "://github.com/" not in key:
        return None
    tail = key.split("://github.com/", 1)[1]
    tail = tail.split("#", 1)[0].split("?", 1)[0]
    parts = [p for p in tail.split("/") if p]
    if len(parts) < 2:
        return None
    owner, name = parts[0], parts[1]
    if name.endswith(".git"):
        name = name[:-4]
    return f"{owner}/{name}"


def build_ecosystem(index: dict) -> dict:
    """归一化为 class_type -> [repo,...] 的生态全集。"""
    class_types = {}
    pattern_keys = []
    repo_count = set()

    raw_map = index["extension_node_map"]
    entries = raw_map.items() if isinstance(raw_map, dict) else []
    for key, value in entries:
        slug = _repo_key_from_entry(key)
        if slug is None:
            if isinstance(key, str) and not key.startswith("http"):
                pattern_keys.append(key)
            continue
        repo_count.add(slug)
        if not (isinstance(value, (list, tuple)) and value):
            continue
        names = value[0] if isinstance(value[0], (list, tuple)) else []
        for name in names:
            if isinstance(name, str) and name:
                class_types.setdefault(name, [])
                if slug not in class_types[name]:
                    class_types[name].append(slug)

    stars = {}
    raw_list = index["custom_node_list"]
    list_entries = raw_list if isinstance(raw_list, list) else []
    for entry in list_entries:
        if not isinstance(entry, dict):
            continue
        ref = entry.get("reference") or ""
        slug = _repo_key_from_entry(ref) if isinstance(ref, str) else None
        if slug and isinstance(entry.get("stars"), int):
            stars[slug] = entry["stars"]

    return {
        "class_types": dict(sorted(class_types.items())),
        "pattern_keys": sorted(pattern_keys),
        "repo_count": len(repo_count),
        "class_type_count": len(class_types),
        "stars": stars,
    }
