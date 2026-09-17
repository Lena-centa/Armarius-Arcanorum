from __future__ import annotations

import copy
import json
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any


TEXT_NODE_TYPES = {
    "CLIPTextEncode",
    "Text Multiline",
    "Text Concatenate",
    "Text to Conditioning",
    "CR Text",
}
CHECKPOINT_FIELDS = ("ckpt_name", "unet_name", "model_name", "clip_name", "vae_name")
SAMPLER_FIELDS = ("seed", "noise_seed", "steps", "cfg", "sampler_name", "scheduler", "denoise", "preview_method", "vae_decode")
LATENT_FIELDS = ("width", "height", "batch_size")
LORA_NAME_FIELDS = ("lora_name", "lora")

# 文件字段 → 远端模型文件夹类型候选。远端词表以 /api/models 为准(动态),
# 版本迁移容错:unet_name 旧版在 "unet" 目录,新版在 "diffusion_models"。
MODEL_FIELD_FOLDER_CANDIDATES = {
    "ckpt_name": ("checkpoints",),
    "unet_name": ("diffusion_models", "unet"),
    "model_name": ("checkpoints", "diffusion_models", "unet"),
}

# 节点类型 → 模型文件夹(比字段名精确)。field 会把不同节点混在一起:
# UltralyticsDetectorProvider / SAMLoader / UpscaleModelLoader 都用 model_name,
# 只按字段名找会去 checkpoints/diffusion_models/unet 里翻检测与放大模型 ——
# 候选列表给错、存在性判定也会假缺失。未知节点类型回退 MODEL_FIELD_* 表。
NODE_TYPE_FOLDER_CANDIDATES = {
    "CheckpointLoaderSimple": ("checkpoints",),
    "CheckpointLoader": ("checkpoints",),
    "CheckpointLoader|pysssss": ("checkpoints",),
    "ECHOCheckpointLoaderSimple": ("checkpoints",),
    "UNETLoader": ("diffusion_models", "unet"),
    "UnetLoaderGGUF": ("diffusion_models", "unet"),
    "UpscaleModelLoader": ("upscale_models",),
    "easy hiresFix": ("upscale_models",),
    "SAMLoader": ("sams",),
    "UltralyticsDetectorProvider": ("ultralytics", "ultralytics_bbox", "ultralytics_segm"),
    "YoloDetectorProvider": ("ultralytics", "ultralytics_bbox", "ultralytics_segm"),
}


def model_folder_candidates(node_type: str | None, field: str | None) -> tuple[str, ...]:
    """该 loader 用到的模型文件夹:先按节点类型定,未知类型再按字段名兜底。"""
    by_type = NODE_TYPE_FOLDER_CANDIDATES.get(str(node_type or ""))
    if by_type:
        return by_type
    return MODEL_FIELD_FOLDER_CANDIDATES.get(str(field or ""), ())


LORA_FOLDER_CANDIDATES = ("loras",)
CONTROLNET_FOLDER_CANDIDATES = ("controlnet",)

# 远端模型清单的进程内缓存 TTL(秒)。抓一次要 /api/models + 每个 folder 一次,
# 而 build_replay_source 在详情页、列表批量摘要、重放编辑器三条路径上都会经过,
# TTL 内复用可把重复往返压成一次。失败同样缓存但用更短的 TTL:
# 对端不可达时不必每个请求都等 15s 超时,对端恢复后也能较快重试。
REMOTE_MODEL_INDEX_TTL_SECONDS = 60.0
REMOTE_MODEL_INDEX_FAILURE_TTL_SECONDS = 10.0
# key = (client.base_url, 排序后的 folder 元组)。folder 集合取自固定的
# MODEL/LORA/CONTROLNET_FOLDER_CANDIDATES,取值有限,不会无限增长。
_remote_model_index_cache: dict[
    tuple[str, tuple[str, ...]], tuple[float, dict[str, list[str]] | None]
] = {}


def clear_remote_model_index_cache() -> None:
    """清空远端模型清单缓存(测试与手动刷新用)。"""
    _remote_model_index_cache.clear()


class ReplayUnsupportedError(ValueError):
    """Metadata is parseable but cannot be converted to an executable prompt."""


class ComfyClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def get_json(self, path: str) -> Any:
        try:
            with urllib.request.urlopen(f"{self.base_url}{path}", timeout=15) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            # 连接失败(ComfyUI 未启动/网络不可达):统一转 RuntimeError,
            # 由上层映射为 ERR_COMFYUI_UNREACHABLE,避免原始错误穿透 RPC
            raise RuntimeError(f"ComfyUI connection failed: {exc.reason}") from exc

    def post_json(self, path: str, payload: dict[str, Any]) -> Any:
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"ComfyUI connection failed: {exc.reason}") from exc

    def post_json_tolerant(self, path: str, payload: dict[str, Any]) -> Any:
        """POST JSON,容错空/非 JSON 响应体(/userdata 等端点可能返回 204)。"""
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read()
                if not body:
                    return {"ok": True, "status": response.status}
                try:
                    return json.loads(body)
                except json.JSONDecodeError:
                    return {
                        "ok": True,
                        "status": response.status,
                        "body": body.decode("utf-8", errors="replace"),
                    }
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"ComfyUI connection failed: {exc.reason}") from exc


def parse_json_field(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def normalize_link(value: Any) -> tuple[str, int] | None:
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return str(value[0]), int(value[1])
    return None


def input_specs(schema: dict[str, Any]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    input_section = schema.get("input", {})
    for group in ("required", "optional"):
        merged.update(input_section.get(group, {}))
    return merged


def flatten_input_order(schema: dict[str, Any]) -> list[str]:
    order = schema.get("input_order", {})
    names: list[str] = []
    for group in ("required", "optional"):
        names.extend(order.get(group, []))
    return names


def has_control_after_generate(spec: Any) -> bool:
    if not isinstance(spec, list) or len(spec) < 2 or not isinstance(spec[1], dict):
        return False
    return bool(spec[1].get("control_after_generate"))


def looks_like_control_after_generate_marker(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str) and value.lower() in {"fixed", "randomize", "increment", "decrement"}:
        return True
    return False


def extract_widget_positions(node: dict[str, Any], schema: dict[str, Any]) -> dict[str, int]:
    values = list(node.get("widgets_values", []) or [])
    cursor = 0
    positions: dict[str, int] = {}
    specs = input_specs(schema)
    input_entries = node.get("inputs", [])

    if isinstance(input_entries, list) and input_entries:
        widget_names = [entry.get("name") for entry in input_entries if isinstance(entry, dict) and "widget" in entry and entry.get("name")]
        seen = 0
        for entry in input_entries:
            if not isinstance(entry, dict) or "widget" not in entry:
                continue
            input_name = entry.get("name")
            if not input_name or cursor >= len(values):
                break
            positions[input_name] = cursor
            cursor += 1
            seen += 1
            spec = specs.get(input_name)
            remaining_widget_count = max(0, len(widget_names) - seen)
            remaining_value_count = max(0, len(values) - cursor)
            next_value = values[cursor] if cursor < len(values) else None
            if has_control_after_generate(spec):
                cursor += 1
            elif (
                input_name == "seed"
                and remaining_value_count > remaining_widget_count
                and looks_like_control_after_generate_marker(next_value)
            ):
                cursor += 1
        return positions

    for input_name in flatten_input_order(schema):
        if cursor >= len(values):
            break
        spec = input_specs(schema).get(input_name)
        first = spec[0] if isinstance(spec, list) and spec else None
        if isinstance(first, str) and first.upper() in {"MODEL", "CLIP", "VAE", "LATENT", "CONDITIONING", "IMAGE", "MASK", "SCRIPT"}:
            continue
        positions[input_name] = cursor
        cursor += 1
        if has_control_after_generate(spec):
            cursor += 1
    return positions


def mutate_widget_value(node: dict[str, Any], schema: dict[str, Any], input_name: str, new_value: Any) -> bool:
    widgets = node.get("widgets_values")
    if not isinstance(widgets, list):
        return False
    positions = extract_widget_positions(node, schema)
    position = positions.get(input_name)
    if position is None or position >= len(widgets):
        return False
    widgets[position] = new_value
    return True


def widget_control_marker(node: dict[str, Any], schema: dict[str, Any], input_name: str) -> Any:
    widgets = node.get("widgets_values")
    if not isinstance(widgets, list):
        return None
    positions = extract_widget_positions(node, schema)
    position = positions.get(input_name)
    if position is None:
        return None
    marker_index = position + 1
    if marker_index >= len(widgets):
        return None
    marker = widgets[marker_index]
    return marker if looks_like_control_after_generate_marker(marker) else None


def mutate_widget_control_marker(node: dict[str, Any], schema: dict[str, Any], input_name: str, marker: Any) -> bool:
    widgets = node.get("widgets_values")
    if not isinstance(widgets, list):
        return False
    positions = extract_widget_positions(node, schema)
    position = positions.get(input_name)
    if position is None:
        return False
    marker_index = position + 1
    while len(widgets) <= marker_index:
        widgets.append(None)
    widgets[marker_index] = marker
    return True


def build_link_lookup(workflow: dict[str, Any]) -> dict[int, tuple[str, int]]:
    lookup: dict[int, tuple[str, int]] = {}
    for link in workflow.get("links", []) or []:
        if not isinstance(link, list) or len(link) < 6:
            continue
        lookup[int(link[0])] = (str(link[1]), int(link[2]))
    return lookup


def build_prompt_from_workflow(workflow: dict[str, Any], schema_map: dict[str, Any]) -> dict[str, Any]:
    prompt: dict[str, Any] = {}
    link_lookup = build_link_lookup(workflow)
    for node in sorted(workflow.get("nodes", []), key=lambda item: int(item.get("order", 0))):
        node_id = str(node["id"])
        node_type = str(node["type"])
        schema = schema_map.get(node_type, {})
        inputs: dict[str, Any] = {}

        for index, entry in enumerate(node.get("inputs", []) or []):
            if not isinstance(entry, dict):
                continue
            input_name = entry.get("name") or f"__input_{index}"
            link_id = entry.get("link")
            if link_id is not None and int(link_id) in link_lookup:
                source_node, source_slot = link_lookup[int(link_id)]
                inputs[input_name] = [source_node, source_slot]

        positions = extract_widget_positions(node, schema)
        widgets = list(node.get("widgets_values", []) or [])
        for input_name, position in positions.items():
            if position < len(widgets) and input_name not in inputs:
                inputs[input_name] = widgets[position]

        prompt[node_id] = {
            "inputs": inputs,
            "class_type": node_type,
            "_meta": {"title": node.get("title") or node_type},
        }
    return prompt


def resolve_input_value(prompt: dict[str, Any], value: Any, depth: int = 0) -> Any:
    if depth > 12:
        return value
    link = normalize_link(value)
    if not link:
        return value

    node_id, output_index = link
    node = prompt.get(str(node_id))
    if not isinstance(node, dict):
        return value

    class_type = str(node.get("class_type", ""))
    inputs = node.get("inputs", {}) or {}

    if class_type in {"PrimitiveInt", "PrimitiveFloat", "PrimitiveString", "Seed (rgthree)"}:
        if "value" in inputs:
            return resolve_input_value(prompt, inputs.get("value"), depth + 1)
        if output_index == 0 and inputs:
            first_key = next(iter(inputs))
            return resolve_input_value(prompt, inputs.get(first_key), depth + 1)

    if class_type == "PrimitiveNode":
        if "value" in inputs:
            return resolve_input_value(prompt, inputs.get("value"), depth + 1)
        if output_index == 0 and inputs:
            first_key = next(iter(inputs))
            return resolve_input_value(prompt, inputs.get(first_key), depth + 1)

    if class_type == "Reroute":
        if inputs:
            first_key = next(iter(inputs))
            return resolve_input_value(prompt, inputs.get(first_key), depth + 1)
        return value

    if class_type == "AbsNode":
        nested = resolve_input_value(prompt, inputs.get("input1"), depth + 1)
        if isinstance(nested, (int, float)):
            return abs(nested)
        return nested

    if class_type in {"CLIPTextEncode", "Text Multiline", "CR Text"}:
        return inputs.get("text", "")

    if class_type == "Text Concatenate":
        delimiter = str(inputs.get("delimiter") or "")
        parts = []
        for field in ("text_a", "text_b", "text_c", "text_d"):
            resolved = resolve_input_value(prompt, inputs.get(field), depth + 1)
            if isinstance(resolved, str):
                if resolved.strip():
                    parts.append(resolved)
            elif resolved not in (None, "", {}):
                parts.append(str(resolved))
        if not parts:
            return ""
        return delimiter.join(parts)

    if class_type == "Text to Conditioning":
        return resolve_input_value(prompt, inputs.get("text"), depth + 1)

    return value


def coerce_non_negative_seed(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return abs(value)
    if isinstance(value, float):
        return abs(int(value))
    parsed = int(str(value).strip())
    return abs(parsed)


def _safe_scalar(value: Any) -> Any:
    """把前端提交的字面量收窄为可写回 prompt 的标量。

    拒绝未解析连线(list/tuple)与纯空白字符串;数字字符串不做隐式转换,
    由调用方按字段语义决定(见 _coerce_numeric_field)。
    """
    if isinstance(value, (list, tuple)):
        return None
    if isinstance(value, str) and not value.strip():
        return None
    return value


def _coerce_numeric_field(field: str, value: Any) -> Any:
    """numeric 字段(seed/steps/cfg/denoise)收窄:非数字一律丢弃。

    返回 (收窄后值, 是否合法);不合法时返回 (None, False),
    调用方跳过该字段,保留原始 prompt 值(含连线)。
    """
    if value is None:
        return None, False
    if isinstance(value, bool):
        return int(value), True
    if isinstance(value, (int, float)):
        return value, True
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None, False
        try:
            if field in ("seed", "steps", "noise_seed"):
                return int(float(stripped)), True
            return float(stripped), True
        except (ValueError, TypeError, OverflowError):
            return None, False
    return None, False


NUMERIC_SAMPLER_FIELDS = {"seed", "noise_seed", "steps", "cfg", "denoise"}


def find_mutable_seed_target(prompt: dict[str, Any], value: Any, depth: int = 0) -> tuple[str, str] | None:
    if depth > 12:
        return None
    link = normalize_link(value)
    if not link:
        return None

    node_id, _ = link
    node = prompt.get(str(node_id))
    if not isinstance(node, dict):
        return None

    class_type = str(node.get("class_type", ""))
    inputs = node.get("inputs", {}) or {}
    if class_type in {"PrimitiveInt", "Seed (rgthree)"} and "value" in inputs:
        return str(node_id), "value"
    if class_type == "AbsNode":
        return find_mutable_seed_target(prompt, inputs.get("input1"), depth + 1)
    return None


def fetch_object_info(client: ComfyClient, node_types: set[str]) -> dict[str, Any]:
    info: dict[str, Any] = {}
    for node_type in sorted(node_types):
        encoded = urllib.parse.quote(node_type, safe="")
        payload = client.get_json(f"/object_info/{encoded}")
        if node_type in payload:
            info[node_type] = payload[node_type]
    return info


def _fetch_remote_model_index_uncached(
    client: ComfyClient, folders: set[str]
) -> dict[str, list[str]] | None:
    try:
        vocabulary = client.get_json("/api/models")
    except Exception:
        return None
    if not isinstance(vocabulary, list):
        return None
    index: dict[str, list[str]] = {}
    for folder in sorted(set(folders)):
        if folder not in vocabulary:
            continue
        try:
            encoded = urllib.parse.quote(folder, safe="")
            files = client.get_json(f"/api/models/{encoded}")
        except Exception:
            continue
        if isinstance(files, list):
            index[folder] = [str(name) for name in files if isinstance(name, str)]
    return index


def fetch_remote_model_index(
    client: ComfyClient, folders: set[str], *, ttl: float | None = None
) -> dict[str, list[str]] | None:
    """从远端 /api/models 抓取所需文件夹类型的模型名单(尽力而为,带 TTL 缓存)。

    返回 {folder: [name...]};/api/models 不可达或响应异常时返回 None,
    调用方回退到 object_info 选项并把存在性标记置为未知,不阻断重放编辑器。

    ttl 覆盖默认 TTL(秒);传 0 可强制本次直读远端(测试/手动刷新用)。
    """
    key = (str(getattr(client, "base_url", "")), tuple(sorted(set(folders))))
    limit = REMOTE_MODEL_INDEX_TTL_SECONDS if ttl is None else ttl
    cached = _remote_model_index_cache.get(key)
    if cached is not None:
        cached_at, cached_value = cached
        age = time.monotonic() - cached_at
        if cached_value is None:
            # 失败结果用更短 TTL:不可达时避免每请求等超时,恢复后能较快重试
            limit = min(limit, REMOTE_MODEL_INDEX_FAILURE_TTL_SECONDS)
        if age < limit:
            return cached_value
    value = _fetch_remote_model_index_uncached(client, folders)
    _remote_model_index_cache[key] = (time.monotonic(), value)
    return value


def _normalize_model_ref(value: str) -> str:
    """模型引用归一:子目录分隔符统一为 "/"。

    实测(本机 ComfyUI 0.35,/models/loras)返回的是 ``os.sep`` 拼出的路径 ——
    Windows 上给的是反斜杠 ``sub\\x.safetensors``;而工作流/存档记录里两种写法
    并存(同一运行时库里既有 ``Anima\\x.safetensors`` 也有 ``bbox/y.pt``)。
    不归一就会把远端确实存在的文件判成"缺失"。

    只在**比较**两侧归一:options 仍是远端原样字符串,避免改写后与远端自身的
    校验词表对不上。
    """
    return str(value).strip().replace("\\", "/")


def exists_on_remote(
    index: dict[str, list[str]] | None,
    candidates: tuple[str, ...] | list[str],
    value: Any,
) -> bool | None:
    """value 是否存在于远端任一候选文件夹。index=None 或值缺失时返回 None(未知)。"""
    if index is None or not isinstance(value, str) or not value:
        return None
    known = [folder for folder in candidates if folder in index]
    if not known:
        return None
    probe = _normalize_model_ref(value)
    return any(
        probe in {_normalize_model_ref(name) for name in index[folder]}
        for folder in known
    )


def present_model_names(
    index: dict[str, list[str]] | None,
    candidates: tuple[str, ...] | list[str],
) -> list[str] | None:
    """远端该类模型的全部存在名(已归一),供前端对**候选列表**着色。

    与 exists_on_remote 的区别:后者判定**单个值**,本函数回传**基准集合**本身。
    为什么不能只回传逐项布尔:网关在 worker 返回空 options 时会用归档库兜底填充
    (generate.controller.getSource),那条路径上网关手里没有远端清单,无法自行
    判定"这个归档里的名字远端有没有"。回传基准即让任一层都能算。

    @returns 归一化后的名字(排序去重);**不可判定时 None**(而非 [])——
             空列表会被前端理解成"一个都不存在",在远端离线或未安装该类型模型时
             把整列误涂成缺失。三态语义与 exists_on_remote 保持一致。
    """
    if index is None:
        return None
    known = [folder for folder in candidates if folder in index]
    if not known:
        return None
    return sorted(
        {_normalize_model_ref(name) for folder in known for name in index[folder]}
    )


def push_workflow_to_comfyui(
    client: ComfyClient, workflow: dict[str, Any], filename: str
) -> dict[str, Any]:
    """把 UI workflow 写入 ComfyUI 用户目录 user/default/workflows/<filename>。

    前端随后可用 ``?workflow=<filename>`` 打开该工作流(由 ComfyUI 自身解析渲染)。
    文件名仅允许小写字母/数字/-/_,统一以 .json 结尾,防止路径穿越。
    """
    filename = filename.strip()
    if not filename:
        raise ValueError("filename must be a non-empty string")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*\.json", filename):
        raise ValueError(f"invalid workflow filename: {filename}")
    # ComfyUI 路由 POST /userdata/{file} 的 {file} 为单个路径段(aiohttp 不跨段匹配),
    # 官方前端以 workflows%2F<name>.json 形式写入;字面斜杠会得到 405 Method Not Allowed
    encoded = urllib.parse.quote(f"workflows/{filename}", safe="")
    path = f"/userdata/{encoded}?overwrite=true"
    response = client.post_json_tolerant(path, workflow)
    return {"ok": True, "filename": filename, "path": f"workflows/{filename}", "response": response}


def workflow_node_map(workflow: dict[str, Any]) -> dict[str, dict[str, Any]]:
    mapping: dict[str, dict[str, Any]] = {}
    for node in workflow.get("nodes", []) or []:
        if isinstance(node, dict) and node.get("id") is not None:
            mapping[str(node.get("id"))] = node
    return mapping


def prompt_branch_map(doc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    mapping: dict[str, dict[str, Any]] = {}
    prompts = doc.get("prompts", {}) or {}
    for polarity in ("positive", "negative"):
        for entry in prompts.get(polarity, []) or []:
            node_id = str(entry.get("source_node_id") or "").strip()
            if not node_id:
                continue
            mapping[node_id] = {
                "branch_label": entry.get("branch_label") or polarity,
                "polarity": polarity,
            }
    return mapping


def prompt_edit_field(node_type: str) -> str | None:
    if node_type in {"CLIPTextEncode", "Text Multiline", "Text to Conditioning", "CR Text"}:
        return "text"
    if node_type == "Text Concatenate":
        return "text_a"
    return None


def prompt_node_text(prompt: dict[str, Any], node_id: str, node_type: str, fallback: str = "") -> str:
    node = prompt.get(str(node_id)) or {}
    inputs = node.get("inputs", {}) or {}
    field = prompt_edit_field(node_type)
    if field == "text_a":
        resolved = resolve_input_value(prompt, [str(node_id), 0])
    elif field:
        resolved = resolve_input_value(prompt, inputs.get(field))
    else:
        resolved = fallback
    if isinstance(resolved, str) and resolved.strip():
        return resolved
    return fallback


def node_display_label(
    workflow_node: dict[str, Any] | None,
    prompt_node: dict[str, Any] | None,
    fallback: str,
) -> str:
    """节点显示名:一律取原始类型名(UI 节点 type / API class_type)。

    不取 `_meta.title` 与 UI 节点的 `title`:那是 ComfyUI 前端按**当前界面语言**
    写进工作流的本地化名(中文界面下即「Checkpoint加载器(简易)」这类文本),
    不是节点真实类型。节点名保持原样展示,不做翻译。

    参数顺序沿用原回退链:UI 节点 type → API 节点 class_type → 调用方兜底
    (如 loader/source 描述)。API-only 来源没有 UI 节点时自然落到 class_type。
    """
    return (
        (workflow_node or {}).get("type")
        or (prompt_node or {}).get("class_type")
        or fallback
    )


def build_replay_source(doc: dict[str, Any], image_sha256: str, client: ComfyClient) -> dict[str, Any]:
    target_image = None
    for image in doc.get("images", []) or []:
        file_info = (image or {}).get("file", {}) or {}
        if file_info.get("sha256") == image_sha256:
            target_image = image
            break
    if target_image is None:
        raise KeyError("image not found in batch")

    metadata = (target_image.get("metadata") or {})
    raw_prompt = parse_json_field(metadata.get("raw_prompt"))
    raw_workflow = parse_json_field(metadata.get("raw_workflow"))
    if not isinstance(raw_workflow, dict):
        raw_workflow = {}

    prompt = raw_prompt if isinstance(raw_prompt, dict) else None
    replay_mode = "exact_api_prompt" if prompt is not None else "reconstructed_ui"
    workflow_node_types = {
        str(node.get("type"))
        for node in raw_workflow.get("nodes", []) or []
        if isinstance(node, dict) and node.get("type")
    }
    if prompt is None and raw_workflow:
        definitions = raw_workflow.get("definitions")
        if (
            isinstance(definitions, dict)
            and isinstance(definitions.get("subgraphs"), list)
            and definitions.get("subgraphs")
        ):
            raise ReplayUnsupportedError(
                "UI-only blueprint workflow is parseable but has no embedded "
                "executable API prompt; subgraph input binding is not supported"
            )
        schema_map = fetch_object_info(client, workflow_node_types)
        prompt = build_prompt_from_workflow(raw_workflow, schema_map)
    if prompt is None:
        raise ValueError("embedded prompt/workflow is unavailable")

    # API prompt is the executable truth source.  UI workflow may additionally
    # contain bypassed, muted, note, or frontend-only nodes; requiring schemas
    # for those nodes makes an otherwise exact replay depend on irrelevant
    # extensions being installed.
    node_types = {
        str(node.get("class_type"))
        for node in prompt.values()
        if isinstance(node, dict) and node.get("class_type")
    }
    object_info = fetch_object_info(client, node_types)

    workflow_nodes = workflow_node_map(raw_workflow)
    checkpoints: list[dict[str, Any]] = []
    loras: list[dict[str, Any]] = []
    prompts: list[dict[str, Any]] = []
    samplers: list[dict[str, Any]] = []
    latents: list[dict[str, Any]] = []
    controlnets: dict[str, dict[str, Any]] = {}
    bypassed_controlnets: dict[str, dict[str, Any]] = {}
    regions: dict[str, dict[str, Any]] = {}

    # editable 全字段改用 sampler_view 派生层(消解 comfy_replay 第三套解析)
    # checkpoints/samplers/latents/prompts/loras 统一从 sampler 中心图遍历得来
    # parser 索引层冻结,editable 不再依赖 doc.prompts 等 parser 产物
    from .sampler_view import build_sampler_views

    seen_lora_keys: set[tuple[str, Any]] = set()
    seen_prompt_keys: set[str] = set()
    seen_checkpoint_ids: set[str] = set()
    seen_latent_ids: set[str] = set()

    for _sv in build_sampler_views(prompt, raw_workflow):
        # checkpoints: 从 loaders 取(model loader,排除 vae/clip 旁路)
        for _ld in _sv["loaders"]:
            if _ld.get("kind") in ("vae", "clip"):
                continue
            _nid = _ld["node_id"]
            if _nid in seen_checkpoint_ids:
                continue  # 共享 loader 跨 sampler 只出 1 条(双 sampler 去重)
            seen_checkpoint_ids.add(_nid)
            _wfn = workflow_nodes.get(_nid) or {}
            _label = node_display_label(_wfn, prompt.get(_nid), _ld["class_type"])
            checkpoints.append(
                {
                    "node_id": _nid,
                    "label": _label,
                    "field": _ld["field"],
                    "value": _ld["value"],
                    "node_type": _ld["class_type"],
                }
            )

        # loras: 从 sampler_view.loras 取(覆盖 CreateHookLora/Power Lora Loader/LoRA Stacker)
        for _l in _sv["loras"]:
            _nid = _l["node_id"]
            _slot = _l.get("slot")
            _key = (_nid, _slot)
            if _key in seen_lora_keys:
                continue
            seen_lora_keys.add(_key)
            _wfn = workflow_nodes.get(_nid) or {}
            _label = node_display_label(_wfn, prompt.get(_nid), _l.get("source", ""))
            loras.append(
                {
                    "node_id": _nid,
                    "label": f"{_label} #{_slot}" if _slot else _label,
                    "node_type": _l.get("source", ""),
                    "source": _l.get("source", ""),
                    "slot": _slot,
                    "enabled": _l.get("enabled", True),
                    "name": _l.get("name", ""),
                    "strength_model": _l.get("strength_model"),
                    "strength_clip": _l.get("strength_clip"),
                    "strength": _l.get("strength", _l.get("strength_model")),
                }
            )

        # samplers: 从 sampler_params 取(标准/Flux分散/UmeAiRT封装)
        _sid = _sv["sampler_id"]
        _stype = _sv["sampler_type"]
        _swfn = workflow_nodes.get(_sid) or {}
        _slabel = node_display_label(_swfn, prompt.get(_sid), _stype)
        _sentry: dict[str, Any] = {"node_id": _sid, "label": _slabel, "node_type": _stype}
        _sentry.update(_sv["sampler_params"])
        _schema = object_info.get(_stype, {})
        _seed_marker = widget_control_marker(_swfn, _schema, "seed") if _swfn else None
        _sentry["seed_randomize"] = bool(isinstance(_seed_marker, str) and _seed_marker.lower() == "randomize")
        _sentry["seed_mode"] = _seed_marker or "fixed"
        if len(_sentry) > 3:
            samplers.append(_sentry)

        # latents: 从 latent_params 取(覆盖非标准 latent 节点 EmptySD3LatentImage 等)
        for _lp in _sv["latent_params"]:
            _nid = _lp["node_id"]
            if _nid in seen_latent_ids:
                continue  # 共享 latent 源跨 sampler 只出 1 条(双 sampler 去重)
            seen_latent_ids.add(_nid)
            _wfn = workflow_nodes.get(_nid) or {}
            _label = node_display_label(_wfn, prompt.get(_nid), _lp["class_type"])
            _lentry: dict[str, Any] = {"node_id": _nid, "label": _label, "node_type": _lp["class_type"]}
            for _field in LATENT_FIELDS:
                if _field in _lp:
                    _lentry[_field] = _lp[_field]
            latents.append(_lentry)

        # prompts: 从 prompt_texts 取(图遍历得来,不依赖 parser 的 doc.prompts)
        for _pt in _sv["prompt_texts"]:
            _nid = _pt["node_id"]
            if _nid in seen_prompt_keys:
                continue
            seen_prompt_keys.add(_nid)
            _wfn = workflow_nodes.get(_nid) or {}
            _label = node_display_label(_wfn, prompt.get(_nid), _pt["class_type"])
            prompts.append(
                {
                    "node_id": _nid,
                    "label": _label,
                    "branch_label": _pt["polarity"],
                    "polarity": _pt["polarity"],
                    "text": _pt["text"],
                    "field": _pt["field"],
                    "node_type": _pt["class_type"],
                }
            )

        # controlnets: 从 sampler_view.controlnets 取(激活 apply,按 apply_node_id 去重)
        for _cn in _sv["controlnets"]:
            _aid = _cn["apply_node_id"]
            _lnid = _cn.get("loader_node_id")
            _key = _aid if _lnid else f"apply-{_aid}"
            _wfn = workflow_nodes.get(_aid) or {}
            _lwfn = workflow_nodes.get(_lnid) if _lnid else None
            _label = node_display_label(
                _wfn,
                prompt.get(_aid),
                (_lwfn or {}).get("type") or _cn["apply_type"],
            )
            entry = controlnets.setdefault(
                _key,
                {
                    "node_id": _aid,
                    "label": _label,
                    "node_type": _cn["apply_type"],
                    "loader_node_id": _lnid,
                    "loader_type": _cn.get("loader_type"),
                    "name": _cn.get("control_net_name", ""),
                    "loader_model_source": _cn.get("loader_model_source"),
                    "source_chain": _cn.get("source_chain"),
                    "strength": _cn.get("strength"),
                    "start_percent": _cn.get("start_percent"),
                    "end_percent": _cn.get("end_percent"),
                    "enabled": True,
                    "bypassed": False,
                    "bindings": [],
                },
            )
            for _b in _cn.get("bindings", []) or []:
                entry["bindings"].append(_b)

        # controlnets: UI workflow 兜底(被 bypass 的 apply/loader,按 loader_node_id 去重)
        for _bc in _sv["bypassed_controlnets"]:
            _lnid = _bc["loader_node_id"]
            _wfn = workflow_nodes.get(_lnid) or {}
            _label = _wfn.get("type") or _bc["loader_type"]
            bypassed_controlnets.setdefault(
                _lnid,
                {
                    "node_id": _bc.get("apply_node_id"),
                    "label": _label,
                    "node_type": _bc["loader_type"],
                    "loader_node_id": _lnid,
                    "loader_type": _bc["loader_type"],
                    "name": _bc.get("control_net_name", ""),
                    "strength": None,
                    "start_percent": None,
                    "end_percent": None,
                    "enabled": False,
                    "bypassed": True,
                    "bindings": [],
                },
            )

        # regions: 从 sampler_view.regions 取(区域节点 + cond 文本 + mask 链)
        for _rg in _sv["regions"]:
            _nid = _rg["node_id"]
            _sid = _rg["sampler_id"]
            _wfn = workflow_nodes.get(_nid) or {}
            _label = node_display_label(_wfn, prompt.get(_nid), _rg["node_type"])
            mask = _rg.get("mask") or {}
            mask_nodes = [
                {
                    "node_id": m["node_id"],
                    "node_type": m["class_type"],
                    "params": m.get("params", {}),
                }
                for m in mask.get("nodes", []) or []
            ]
            entry = regions.setdefault(
                _nid,
                {
                    "node_id": _nid,
                    "label": _label,
                    "node_type": _rg["node_type"],
                    "sampler_ids": [],
                    "kind": _rg.get("kind"),
                    "cond_texts": _rg.get("cond_texts", []),
                    "params": _rg.get("params", {}),
                    "mask_source": mask.get("source"),
                    "mask_slot": mask.get("slot"),
                    "mask_nodes": mask_nodes,
                },
            )
            if _sid not in entry["sampler_ids"]:
                entry["sampler_ids"].append(_sid)

    # mask_scopes:独立遮罩范围(条件/inpaint/区域 mask 链),按 scope 溯源去重
    mask_scopes: dict[tuple[str, str], dict[str, Any]] = {}
    for _sv in build_sampler_views(prompt, raw_workflow):
        _sv_sid = _sv.get("sampler_id", "")
        for _ms in _sv.get("mask_scopes", []) or []:
            _consumer = _ms.get("consumer_node_id", "")
            _field = _ms.get("input_field", "")
            _scope = _ms.get("scope") or {}
            _source = _scope.get("source")
            _key = (str(_consumer), str(_field))
            entry = mask_scopes.setdefault(
                _key,
                {
                    "consumer_node_id": _consumer,
                    "consumer_type": _ms.get("consumer_type", ""),
                    "input_field": _field,
                    "consumer_params": _ms.get("consumer_params", {}) or {},
                    "scope": _scope,
                    "sampler_ids": [],
                },
            )
            if _sv_sid not in entry["sampler_ids"]:
                entry["sampler_ids"].append(_sv_sid)

    # 远端模型清单(尽力而为):options 全量候选 + 行级存在性标记。
    # 只抓工作流实际引用的文件夹类型,避免按 /api/models 全部类型轮询。
    _model_folders_needed: list[str] = []
    for _c in checkpoints:
        for _folder in model_folder_candidates(_c.get("node_type"), _c.get("field")):
            if _folder not in _model_folders_needed:
                _model_folders_needed.append(_folder)
    _folder_needs: set[str] = set(_model_folders_needed)
    if loras:
        _folder_needs.add(LORA_FOLDER_CANDIDATES[0])
    if controlnets or bypassed_controlnets:
        _folder_needs.add(CONTROLNET_FOLDER_CANDIDATES[0])
    remote_index = fetch_remote_model_index(client, _folder_needs)
    for _c in checkpoints:
        _c["exists_on_remote"] = exists_on_remote(
            remote_index,
            model_folder_candidates(_c.get("node_type"), _c.get("field")),
            _c.get("value"),
        )
    for _l in loras:
        _l["exists_on_remote"] = exists_on_remote(remote_index, LORA_FOLDER_CANDIDATES, _l.get("name"))
    for _e in list(controlnets.values()) + list(bypassed_controlnets.values()):
        _e["exists_on_remote"] = exists_on_remote(remote_index, CONTROLNET_FOLDER_CANDIDATES, _e.get("name"))

    # 候选:每张卡片自带按自身文件夹的清单(远端清单优先,其次 object_info 枚举)。
    # 字段**缺省**表示"这张卡没有自己的候选"(远端与枚举都拿不到或该文件夹为空),
    # 前端据此回退整表并集 options.checkpoints(网关用归档库兜底填充的正是它)。
    # candidates 与其基准 candidates_baseline **成对使用**:卡自带清单非空时用
    # 卡自己的清单+基准,否则清单与基准一起回退并集,避免拿 A 卡的基准给 B 卡的
    # 候选着色(None = 不可判定,前端不着色)。
    for item in checkpoints:
        schema = object_info.get(item["node_type"], {})
        spec = input_specs(schema).get(item["field"])
        enum = list(spec[0]) if (isinstance(spec, list) and spec and isinstance(spec[0], list)) else []
        if enum:
            item["candidates"] = enum
            item["candidates_baseline"] = None  # 无远端清单 → 未知,不着色
    checkpoint_options: list[str] = [name for item in checkpoints for name in item.get("candidates", [])]
    lora_options: list[str] = []
    for item in loras:
        schema = object_info.get(item["node_type"], {})
        if item["source"] == "LoRA Stacker":
            slot = item.get("slot")
            spec = input_specs(schema).get(f"lora_name_{slot}")
        else:
            spec = input_specs(schema).get("lora_name")
        if isinstance(spec, list) and spec and isinstance(spec[0], list):
            lora_options.extend(spec[0])
    if remote_index is not None:
        # 直接抓取的清单不受"工作流里恰好有什么 loader 节点"影响,
        # 且不含 LoRA Stacker 的 "None" 哨兵;缺失时回退 object_info 选项。
        # 每张卡只取自己文件夹的名字,不再把各类型清单并成一份给所有卡。
        for item in checkpoints:
            folders = model_folder_candidates(item.get("node_type"), item.get("field"))
            candidates = sorted({name for folder in folders for name in remote_index.get(folder, [])})
            if candidates:
                item["candidates"] = candidates
                item["candidates_baseline"] = present_model_names(remote_index, folders)
        lora_options = remote_index.get("loras", [])
    # 并集(整表候选)最后统一取一次:远端文件夹为空/未列出时卡片可能**没有**
    # candidates 键(字段缺省 = 该卡没有自己的候选,前端回退并集),这里必须
    # 用 .get —— 直接下标会 KeyError,而 worker 把任何 KeyError 映射成
    # ERR_SOURCE_NOT_FOUND,表现为"来源载入失败 404"(实测事故)。
    checkpoint_options = [
        name for item in checkpoints for name in item.get("candidates", [])
    ]


    target_file = (target_image.get("file") or {})
    from .node_graph import build_node_graph

    # 输入图 loader 暴露为可编辑对象:换图即"把库内图片当作 i2i 源"的入口,
    # 是血缘回路闭合的前置(源图在库内 → 提交前回填进 ComfyUI input/ →
    # 生成图写入侧留下内容哈希 → 血缘边解析为 resolved)。
    # 清单与血缘候选共用 image_lineage.image_loader_refs 的 loader 定义。
    from .image_lineage import image_loader_refs as _image_loader_refs

    image_loaders: list[dict[str, Any]] = []
    for _ref in _image_loader_refs(prompt):
        _nid = _ref["node_id"]
        _wfn = workflow_nodes.get(_nid) or {}
        image_loaders.append(
            {
                "node_id": _nid,
                "label": node_display_label(_wfn, prompt.get(_nid), _ref["node_type"]),
                "node_type": _ref["node_type"],
                "field": _ref["raw_ref_field"],
                "value": _ref["raw_ref"],
            }
        )

    return {
        "source_image": {
            "sha256": target_file.get("sha256"),
            "filename": target_file.get("filename"),
            "resolved_path": target_file.get("resolved_path"),
            "windows_path": target_file.get("windows_path"),
            "width": target_file.get("width"),
            "height": target_file.get("height"),
            "captured_at": target_image.get("captured_at"),
            "created_date": target_image.get("created_date"),
            "created_hour": target_image.get("created_hour"),
        },
        "batch": {
            "key": doc.get("batch_key"),
            "count": len(doc.get("images", []) or []),
        },
        "replay": {
            "mode": replay_mode,
            "executable": True,
            # 来源门禁(嵌入方案 §3.1):仅当 UI 节点图存在时才可进内嵌 ComfyUI
            # 画布。仅 API 格式可重放执行但无法进画布;A1111/NovelAI/无元数据
            # 连执行都不可用(走到这里之前已抛错)。前端只认这个布尔,不做
            # 元数据嗅探。
            "embedded_supported": bool(
                isinstance(raw_workflow, dict)
                and (raw_workflow.get("nodes") or [])
            ),
            "warnings": (
                []
                if replay_mode == "exact_api_prompt"
                else [
                    "API prompt was reconstructed from UI workflow metadata; "
                    "exact graph equivalence is not guaranteed"
                ]
            ),
        },
        "workflow": {
            "id": raw_workflow.get("id"),
            "node_count": len(prompt),
            "workflow_node_count": len(raw_workflow.get("nodes", []) or []),
            "raw_prompt": prompt,
            "raw_workflow": raw_workflow,
        },
        "node_graph": build_node_graph(prompt, raw_workflow),
        "editable": {
            "checkpoints": checkpoints,
            "loras": loras,
            "prompts": prompts,
            "samplers": samplers,
            "latents": latents,
            "controlnets": list(controlnets.values()) + list(bypassed_controlnets.values()),
            "regions": list(regions.values()),
            "mask_scopes": list(mask_scopes.values()),
            "image_loaders": image_loaders,
        },
        "options": {
            "checkpoints": sorted(set(filter(None, checkpoint_options))),
            "loras": sorted(set(filter(None, lora_options))),
            # 远端存在基准(供前端对候选着色,三态:列表/None=未知)。
            # checkpoint 侧取候选文件夹的**并集**——网关兜底填充的列表只有名字、
            # 没有来源字段,无法按 field 精确到具体文件夹;粗粒度提示已足够。
            "remote_present": {
                # 整表并集:仅供"卡片没带 candidates_baseline"的兜底路径
                # (网关用归档库填充 options 时没有来源字段)。卡片级着色的基准
                # 见 editable.checkpoints[].candidates_baseline(按各自文件夹)。
                "checkpoints": present_model_names(remote_index, tuple(_model_folders_needed)),
                "loras": present_model_names(remote_index, LORA_FOLDER_CANDIDATES),
            },
        },
    }


_MISSING = object()


def _editable_baseline(
    source: dict[str, Any],
    section: str,
    node_id: str,
    *,
    field: str | None = None,
    slot: Any = _MISSING,
) -> dict[str, Any] | None:
    """Return the editor row that produced a submitted edit.

    The browser posts every visible control.  Comparing against this immutable
    source view lets the replay layer distinguish a real user edit from a
    display-only resolved value (for example a sampler scalar resolved through
    a Primitive node).  Callers without an ``editable`` section retain the old
    behavior and are treated as explicit edits.
    """
    editable = source.get("editable")
    if not isinstance(editable, dict):
        return None
    rows = editable.get(section)
    if not isinstance(rows, list):
        return None
    for row in rows:
        if not isinstance(row, dict) or str(row.get("node_id") or "") != node_id:
            continue
        if field is not None and str(row.get("field") or "") != field:
            continue
        if slot is not _MISSING and row.get("slot") != slot:
            continue
        return row
    return None


def _numeric_value(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value.strip())
        except (TypeError, ValueError, OverflowError):
            return None
    return None


def _same_edit_value(left: Any, right: Any) -> bool:
    if left == right:
        return True
    left_number = _numeric_value(left)
    right_number = _numeric_value(right)
    return (
        left_number is not None
        and right_number is not None
        and abs(left_number - right_number) <= 1e-12
    )


def _field_changed(item: dict[str, Any], baseline: dict[str, Any] | None, field: str) -> bool:
    if field not in item:
        return False
    if baseline is None or field not in baseline:
        return True
    return not _same_edit_value(item.get(field), baseline.get(field))


def _mutable_link_target(
    prompt: dict[str, Any], value: Any, depth: int = 0
) -> tuple[str, str] | None:
    """Find a safe literal source behind a replay-editable link.

    Only identity-like routing and primitive value holders are rewritten.  A
    computed node such as SimpleMath is intentionally not inverted; callers may
    replace the consumer link only when the user explicitly changed the value.
    """
    if depth > 12:
        return None
    link = normalize_link(value)
    if not link:
        return None
    node_id, _ = link
    node = prompt.get(node_id)
    if not isinstance(node, dict):
        return None
    class_type = str(node.get("class_type", ""))
    inputs = node.get("inputs", {}) or {}
    lowered = class_type.casefold()
    if "value" in inputs and (
        class_type
        in {
            "PrimitiveInt",
            "PrimitiveFloat",
            "PrimitiveString",
            "PrimitiveStringMultiline",
            "PrimitiveNode",
            "Seed (rgthree)",
        }
        or "primitive" in lowered
        or lowered.startswith("easy int")
        or lowered.startswith("easy float")
    ):
        return node_id, "value"
    if class_type == "AbsNode":
        return _mutable_link_target(prompt, inputs.get("input1"), depth + 1)
    if class_type == "Reroute" and inputs:
        return _mutable_link_target(prompt, next(iter(inputs.values())), depth + 1)
    return None


def _upstream_node_ids(prompt: dict[str, Any], start_id: str) -> list[str]:
    queue = [start_id]
    seen = {start_id}
    ordered: list[str] = []
    while queue:
        current = queue.pop(0)
        node = prompt.get(current)
        if not isinstance(node, dict):
            continue
        for value in (node.get("inputs", {}) or {}).values():
            link = normalize_link(value)
            if not link or link[0] in seen:
                continue
            seen.add(link[0])
            queue.append(link[0])
            ordered.append(link[0])
    return ordered


def _sampler_field_target(
    prompt: dict[str, Any],
    sampler_id: str,
    field: str,
    baseline_value: Any,
) -> tuple[str, str] | None:
    """Locate the real owner of a sampler parameter.

    Standard samplers own their fields directly.  SamplerCustomAdvanced stores
    seed/cfg/steps/sampler_name on upstream noise, guider, scheduler, and select
    nodes; a bounded upstream search prevents adding invalid inputs to the root.
    """
    node = prompt.get(sampler_id)
    if not isinstance(node, dict):
        return None
    inputs = node.get("inputs", {}) or {}
    if field in inputs:
        linked_target = _mutable_link_target(prompt, inputs.get(field))
        return linked_target or (sampler_id, field)

    aliases = {
        "seed": ("seed", "noise_seed"),
        "noise_seed": ("noise_seed", "seed"),
    }.get(field, (field,))
    candidates: list[tuple[str, str]] = []
    for node_id in _upstream_node_ids(prompt, sampler_id):
        upstream = prompt.get(node_id)
        if not isinstance(upstream, dict):
            continue
        upstream_inputs = upstream.get("inputs", {}) or {}
        for alias in aliases:
            if alias not in upstream_inputs:
                continue
            resolved = resolve_input_value(prompt, upstream_inputs.get(alias))
            if not _same_edit_value(resolved, baseline_value):
                continue
            candidates.append(
                _mutable_link_target(prompt, upstream_inputs.get(alias))
                or (node_id, alias)
            )
    unique = list(dict.fromkeys(candidates))
    return unique[0] if len(unique) == 1 else None


def _write_prompt_value(
    prompt: dict[str, Any],
    workflow_nodes: dict[str, dict[str, Any]],
    object_info: dict[str, Any],
    target: tuple[str, str],
    value: Any,
) -> None:
    node_id, field = target
    node = prompt.get(node_id)
    if not isinstance(node, dict):
        return
    node.setdefault("inputs", {})[field] = value
    workflow_node = workflow_nodes.get(node_id)
    if workflow_node:
        mutate_widget_value(
            workflow_node,
            object_info.get(str(node.get("class_type", "")), {}),
            field,
            value,
        )


def _power_lora_prompt_widget(
    inputs: dict[str, Any], baseline: dict[str, Any] | None
) -> dict[str, Any] | None:
    widgets = [
        value
        for key, value in inputs.items()
        if str(key).startswith("lora_") and isinstance(value, dict)
    ]
    if not widgets:
        return None
    old_name = str((baseline or {}).get("name") or "")
    matches = [widget for widget in widgets if str(widget.get("lora") or "") == old_name]
    return matches[0] if len(matches) == 1 else None


def apply_replay_edits(
    source: dict[str, Any],
    edits: dict[str, Any],
    object_info: dict[str, Any],
    client_id_prefix: str = "workflow-db-generate",
) -> dict[str, Any]:
    prompt = copy.deepcopy(source["workflow"]["raw_prompt"])
    workflow = copy.deepcopy(source["workflow"]["raw_workflow"])
    workflow_nodes = workflow_node_map(workflow)

    for item in edits.get("checkpoints", []) or []:
        node_id = str(item.get("node_id") or "")
        field = str(item.get("field") or "")
        value = item.get("value")
        if not node_id or not field or node_id not in prompt or value in (None, ""):
            continue
        baseline = _editable_baseline(source, "checkpoints", node_id, field=field)
        if not _field_changed(item, baseline, "value"):
            continue
        prompt[node_id].setdefault("inputs", {})[field] = value
        workflow_node = workflow_nodes.get(node_id)
        if workflow_node:
            mutate_widget_value(workflow_node, object_info.get(prompt[node_id]["class_type"], {}), field, value)

    for item in edits.get("prompts", []) or []:
        node_id = str(item.get("node_id") or "")
        if not node_id or node_id not in prompt:
            continue
        text = str(item.get("text") or "")
        field = str(item.get("field") or "text")
        baseline = _editable_baseline(source, "prompts", node_id, field=field)
        if not _field_changed(item, baseline, "text"):
            continue
        prompt[node_id].setdefault("inputs", {})[field] = text
        if prompt[node_id].get("class_type") == "Text Concatenate" and field == "text_a":
            for extra_field in ("text_b", "text_c", "text_d"):
                if extra_field in prompt[node_id].setdefault("inputs", {}):
                    prompt[node_id]["inputs"][extra_field] = ""
        workflow_node = workflow_nodes.get(node_id)
        if workflow_node:
            schema = object_info.get(prompt[node_id]["class_type"], {})
            mutate_widget_value(workflow_node, schema, field, text)
            if prompt[node_id].get("class_type") == "Text Concatenate" and field == "text_a":
                for extra_field in ("text_b", "text_c", "text_d"):
                    mutate_widget_value(workflow_node, schema, extra_field, "")

    for item in edits.get("samplers", []) or []:
        node_id = str(item.get("node_id") or "")
        if not node_id or node_id not in prompt:
            continue
        workflow_node = workflow_nodes.get(node_id)
        schema = object_info.get(prompt[node_id]["class_type"], {})
        baseline = _editable_baseline(source, "samplers", node_id)
        seed_randomize = bool(item.get("seed_randomize"))
        item = dict(item)
        seed_mode_changed = _field_changed(item, baseline, "seed_randomize")
        seed_value_changed = _field_changed(item, baseline, "seed")
        if seed_randomize and (seed_mode_changed or seed_value_changed):
            random_seed = random.SystemRandom().randrange(0, 2**63 - 1)
            item["seed"] = random_seed
            seed_value_changed = True
        elif seed_value_changed and "seed" in item and item.get("seed") not in (None, ""):
            try:
                item["seed"] = coerce_non_negative_seed(item.get("seed"))
            except (ValueError, TypeError):
                item["seed"] = None

        for field in SAMPLER_FIELDS:
            changed = seed_value_changed if field == "seed" else _field_changed(item, baseline, field)
            if not changed:
                continue
            value = _safe_scalar(item.get(field))
            if value is None:
                continue
            if field in NUMERIC_SAMPLER_FIELDS:
                value, ok = _coerce_numeric_field(field, value)
                if not ok:
                    continue
            baseline_value = (baseline or {}).get(field)
            target = _sampler_field_target(prompt, node_id, field, baseline_value)
            if target:
                _write_prompt_value(prompt, workflow_nodes, object_info, target, value)
        if workflow_node and seed_mode_changed:
            mutate_widget_control_marker(
                workflow_node,
                schema,
                "seed",
                "randomize" if seed_randomize else "fixed",
            )

    for item in edits.get("latents", []) or []:
        node_id = str(item.get("node_id") or "")
        if not node_id or node_id not in prompt:
            continue
        baseline = _editable_baseline(source, "latents", node_id)
        for field in LATENT_FIELDS:
            if not _field_changed(item, baseline, field):
                continue
            value = _safe_scalar(item.get(field))
            if value is None:
                continue
            value, ok = _coerce_numeric_field(field, value)
            if not ok:
                continue
            original = prompt[node_id].setdefault("inputs", {}).get(field)
            target = _mutable_link_target(prompt, original) or (node_id, field)
            _write_prompt_value(prompt, workflow_nodes, object_info, target, value)

    for item in edits.get("loras", []) or []:
        node_id = str(item.get("node_id") or "")
        if not node_id or node_id not in prompt:
            continue
        node = prompt[node_id]
        inputs = node.setdefault("inputs", {})
        workflow_node = workflow_nodes.get(node_id)
        schema = object_info.get(node.get("class_type", ""), {})
        slot = item.get("slot")
        baseline = _editable_baseline(source, "loras", node_id, slot=slot)
        if baseline is not None and not any(
            _field_changed(item, baseline, field)
            for field in (
                "enabled",
                "name",
                "strength",
                "strength_model",
                "strength_clip",
            )
        ):
            continue
        enabled = bool(item.get("enabled", True))
        name = str(item.get("name") or "").strip()

        if item.get("source") == "LoRA Stacker":
            slot = int(slot or 0)
            if slot <= 0:
                continue
            values = {
                f"lora_name_{slot}": name if enabled and name else "None",
                f"lora_wt_{slot}": item.get("strength"),
                f"model_str_{slot}": item.get("strength_model"),
                f"clip_str_{slot}": item.get("strength_clip"),
            }
        elif item.get("source") == "Lora Loader Stack (rgthree)":
            slot = int(slot or 0)
            if slot <= 0:
                continue
            suffix = f"{slot:02d}"
            values = {
                f"lora_{suffix}": name if enabled and name else "None",
                f"strength_{suffix}": item.get("strength"),
            }
        elif item.get("source") in {"Power Lora Loader (rgthree)", "Power Lora Loader"}:
            # New rgthree versions serialize LoRA widget dictionaries into the
            # executable API prompt.  Update both prompt and UI workflow so the
            # submitted graph and embedded metadata stay consistent.
            prompt_widget = _power_lora_prompt_widget(inputs, baseline)
            workflow_widget = None
            slot = int(slot or 0)
            if workflow_node and slot > 0:
                widgets = workflow_node.get("widgets_values", [])
                if isinstance(widgets, list) and slot <= len(widgets):
                    candidate = widgets[slot - 1]
                    if isinstance(candidate, dict):
                        workflow_widget = candidate
            for widget in (prompt_widget, workflow_widget):
                if widget is None:
                    continue
                widget["lora"] = name if enabled and name else "None"
                widget["on"] = bool(enabled)
                if item.get("strength") is not None:
                    widget["strength"] = item.get("strength")
                if item.get("strength_clip") is not None:
                    widget["strengthTwo"] = item.get("strength_clip")
            continue
        else:
            values = {
                "lora_name": name if enabled and name else "None",
                "strength_model": item.get("strength_model", item.get("strength")),
            }
            if "strength_clip" in inputs or item.get("strength_clip") is not None:
                values["strength_clip"] = item.get("strength_clip")

        for field, value in values.items():
            if value is None:
                continue
            inputs[field] = value
            if workflow_node:
                mutate_widget_value(workflow_node, schema, field, value)

    # controlnets: 参数编辑(强度/生效范围/模型名),enabled=false 时强度置 0 等效禁用
    for item in edits.get("controlnets", []) or []:
        node_id = str(item.get("node_id") or "")
        if not node_id or node_id not in prompt:
            continue
        node = prompt[node_id]
        class_type = str(node.get("class_type", ""))
        inputs = node.setdefault("inputs", {})
        workflow_node = workflow_nodes.get(node_id)
        schema = object_info.get(class_type, {})
        baseline = _editable_baseline(source, "controlnets", node_id)
        enabled = bool(item.get("enabled", True))
        strength = item.get("strength")
        enabled_changed = _field_changed(item, baseline, "enabled")
        if enabled_changed and not enabled:
            strength = 0
        for field, value in (
            ("strength", strength),
            ("start_percent", item.get("start_percent")),
            ("end_percent", item.get("end_percent")),
        ):
            if value is None or (field != "strength" and not _field_changed(item, baseline, field)):
                continue
            if field == "strength" and not (
                _field_changed(item, baseline, "strength") or enabled_changed
            ):
                continue
            inputs[field] = value
            if workflow_node:
                mutate_widget_value(workflow_node, schema, field, value)
        name = str(item.get("name") or "").strip()
        loader_id = str(item.get("loader_node_id") or "")
        if _field_changed(item, baseline, "name") and name and loader_id and loader_id in prompt:
            prompt[loader_id].setdefault("inputs", {})["control_net_name"] = name
            loader_node = workflow_nodes.get(loader_id)
            if loader_node:
                mutate_widget_value(
                    loader_node,
                    object_info.get(prompt[loader_id].get("class_type", ""), {}),
                    "control_net_name",
                    name,
                )

    for item in edits.get("image_loaders", []) or []:
        node_id = str(item.get("node_id") or "")
        field = str(item.get("field") or "")
        value = item.get("value")
        if not node_id or not field or node_id not in prompt or value in (None, ""):
            continue
        baseline = _editable_baseline(source, "image_loaders", node_id, field=field)
        if not _field_changed(item, baseline, "value"):
            continue
        prompt[node_id].setdefault("inputs", {})[field] = value
        workflow_node = workflow_nodes.get(node_id)
        if workflow_node:
            # UI workflow 侧同一引用存在 widgets_values 数组里(LoadImage 首槽为
            # 文件名),widgets_values 结构随节点各异,故走通用 widget 写入。
            mutate_widget_value(
                workflow_node,
                object_info.get(prompt[node_id].get("class_type", ""), {}),
                field,
                value,
            )

    filename_prefix = str(edits.get("filename_prefix") or "").strip()
    if filename_prefix:
        for node_id, node in prompt.items():
            class_type = str(node.get("class_type", ""))
            if class_type == "SaveImage":
                node.setdefault("inputs", {})["filename_prefix"] = filename_prefix
                workflow_node = workflow_nodes.get(node_id)
                if workflow_node:
                    mutate_widget_value(workflow_node, object_info.get(class_type, {}), "filename_prefix", filename_prefix)

    client_id = f"{client_id_prefix}-{uuid.uuid4().hex}"
    return {
        "prompt": prompt,
        "workflow": workflow,
        "extra_data": {"extra_pnginfo": {"workflow": workflow}},
        "client_id": client_id,
    }


def summarize_queue_entry(entry: list[Any]) -> dict[str, Any]:
    number = entry[0] if len(entry) > 0 else None
    prompt_id = entry[1] if len(entry) > 1 else None
    prompt = entry[2] if len(entry) > 2 and isinstance(entry[2], dict) else {}
    client_id = ""
    if len(entry) > 3 and isinstance(entry[3], dict):
        client_id = str(entry[3].get("client_id") or "")
    class_types = [str(node.get("class_type", "")) for node in prompt.values() if isinstance(node, dict)]
    return {
        "number": number,
        "prompt_id": prompt_id,
        "client_id": client_id,
        "node_count": len(prompt),
        "node_types": sorted(set(filter(None, class_types))),
    }


def summarize_history_entry(prompt_id: str, entry: dict[str, Any]) -> dict[str, Any]:
    prompt_section = entry.get("prompt", [])
    number = prompt_section[0] if len(prompt_section) > 0 else None
    client_id = ""
    workflow_id = None
    if len(prompt_section) > 3 and isinstance(prompt_section[3], dict):
        client_id = str(prompt_section[3].get("client_id") or "")
        workflow = ((prompt_section[3].get("extra_pnginfo") or {}).get("workflow") or {})
        workflow_id = workflow.get("id")
    outputs = entry.get("outputs", {}) or {}
    images: list[dict[str, Any]] = []
    output_images: list[dict[str, Any]] = []
    temp_images: list[dict[str, Any]] = []
    for node_id, output in outputs.items():
        for image in output.get("images", []) or []:
            item = {
                "node_id": node_id,
                "filename": image.get("filename"),
                "subfolder": image.get("subfolder"),
                "type": image.get("type"),
            }
            images.append(item)
            if str(image.get("type") or "") == "output":
                output_images.append(item)
            else:
                temp_images.append(item)
    preferred_images = output_images or temp_images
    status = entry.get("status") or {}
    execution_error: dict[str, Any] | None = None
    for message in status.get("messages", []) or []:
        if not isinstance(message, (list, tuple)) or len(message) < 2:
            continue
        if message[0] != "execution_error" or not isinstance(message[1], dict):
            continue
        detail = message[1]
        execution_error = {
            "node_id": detail.get("node_id"),
            "node_type": detail.get("node_type"),
            "exception_type": detail.get("exception_type"),
            "message": detail.get("exception_message") or "ComfyUI execution failed",
        }
    return {
        "prompt_id": prompt_id,
        "number": number,
        "client_id": client_id,
        "workflow_id": workflow_id,
        "status": status.get("status_str"),
        "completed": status.get("completed"),
        "error": execution_error,
        "images": preferred_images,
        "output_count": len(output_images),
        "temp_count": len(temp_images),
    }
