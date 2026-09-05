from __future__ import annotations

import hashlib
import json
import os
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath
from typing import Any

from PIL import Image, UnidentifiedImageError

from .workflow_ir import WorkflowIR, normalize_link as normalize_workflow_link

SUPPORTED_EXTENSIONS = {".png", ".webp", ".jpg", ".jpeg"}
PRIMITIVE_NODE_TYPES = {"PrimitiveInt", "PrimitiveFloat", "PrimitiveString", "Seed (rgthree)"}
TEXT_NODE_TYPES = {
    "CLIPTextEncode",
    "Text Multiline",
    "Text Concatenate",
    "Text to Conditioning",
    "CR Text",
    # JPS / CR 变体(见 docs/parser/KNOWN_GAPS.md §2)
    "Text Prompt (JPS)",
    "Text Concatenate (JPS)",
    "CR Text Concatenate",
}
SAMPLER_HINTS = ("ksampler", "sampler")
LATENT_HINTS = ("latent",)
LORA_STRENGTH_STEP = 0.05
LORA_STRENGTH_EPSILON = 1e-9


def normalize_lora_strength(value: Any) -> Any:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return value
    snapped = round(value / LORA_STRENGTH_STEP) * LORA_STRENGTH_STEP
    if abs(value - snapped) > LORA_STRENGTH_EPSILON:
        return value
    return round(snapped, 10)


class WorkflowGraph(WorkflowIR):
    """Frozen parser query facade backed by the canonical semantic graph IR."""


def iter_image_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for current_root, _, filenames in os.walk(root, followlinks=True):
        for filename in filenames:
            path = Path(current_root) / filename
            if path.suffix.lower() in SUPPORTED_EXTENSIONS:
                files.append(path)
    return sorted(files)


def parse_image(path: Path, scan_root: Path | None = None) -> dict[str, Any]:
    metadata, image_info = extract_image_metadata(path)
    prompt_graph = parse_json_field(metadata.get("prompt"))
    workflow_data = parse_json_field(metadata.get("workflow"))
    graph = WorkflowGraph(
        prompt_graph if isinstance(prompt_graph, dict) else {},
        workflow_data if isinstance(workflow_data, dict) else None,
    )

    file_stats = path.stat()
    captured_at = datetime.fromtimestamp(file_stats.st_mtime, tz=timezone.utc)
    relative_path = str(path.relative_to(scan_root)) if scan_root and path.is_relative_to(scan_root) else path.name
    resolved_path = path.resolve(strict=False)

    samplers = collect_sampler_settings(graph)
    prompt_summary = collect_prompt_groups(graph, samplers)
    latent = collect_latent_settings(graph, samplers)
    model = collect_model_settings(graph, samplers)
    loras = collect_lora_settings(graph, model)
    file_info = build_file_info(path, resolved_path, relative_path, file_stats, image_info)

    record = {
        "captured_at": captured_at,
        "batch_key": batch_group_key(
            samplers,
            sha256_fallback=file_info.get("sha256", ""),
            size=_batch_size_token(latent, file_info),
        ),
        "created_date": captured_at.strftime("%Y-%m-%d"),
        "created_hour": captured_at.hour,
        "created_weekday": captured_at.weekday(),
        "file": build_file_info(path, resolved_path, relative_path, file_stats, image_info),
        "metadata": {
            "raw_keys": sorted(metadata.keys()),
            "raw_prompt": metadata.get("prompt"),
            "raw_workflow": metadata.get("workflow"),
            "raw_parameters": metadata.get("parameters"),
            "extra": {key: value for key, value in metadata.items() if key not in {"prompt", "workflow", "parameters"}},
        },
        "workflow": {
            "has_embedded_workflow": bool(graph.prompt) or bool(workflow_data),
            "prompt_node_count": len(graph.prompt),
            "workflow_node_count": len(workflow_data.get("nodes", [])) if isinstance(workflow_data, dict) else None,
            "node_type_counts": dict(Counter(node.get("class_type", "Unknown") for node in graph.prompt.values())),
        },
        "model": model,
        "loras": loras,
        "prompts": {
            "positive": prompt_summary["positive"],
            "negative": prompt_summary["negative"],
            "by_sampler": prompt_summary["by_sampler"],
            "search_text": build_prompt_search_text(prompt_summary["positive"], prompt_summary["negative"]),
        },
        "samplers": samplers,
        "latent": latent,
    }
    return record


def extract_image_metadata(path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        with Image.open(path) as image:
            metadata = dict(image.info)
            image_info = {
                "format": image.format,
                "mode": image.mode,
                "width": image.width,
                "height": image.height,
            }
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError(f"Unable to open image {path}: {exc}") from exc

    if "parameters" not in metadata and "comment" in metadata:
        metadata["parameters"] = metadata["comment"]
    return metadata, image_info


def parse_json_field(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def normalize_link(value: Any) -> tuple[str, int] | None:
    return normalize_workflow_link(value)


def _unwrap_single_scalar_reference(value: Any) -> Any:
    """条件分支选中"单 widget 直通"节点时的兜底解包。

    resolve_input_value 对未知节点返回 {node_id, class_type, inputs} 引用壳。
    经 ImpactConditionalBranch 选中的值若落在该壳上,且节点 inputs 恰有一个
    标量字面量(如 easy int/easy float 的 value、Sampler Selector 的
    sampler_name),则该 widget 即为分支输出值,直接解包;
    多输入/含连线/非标量形态一律保持引用壳不变。
    """
    if not isinstance(value, dict) or set(value) != {"node_id", "class_type", "inputs"}:
        return value
    node_inputs = value.get("inputs")
    if not isinstance(node_inputs, dict) or len(node_inputs) != 1:
        return value
    only = next(iter(node_inputs.values()))
    if isinstance(only, (str, int, float, bool)):
        return only
    return value


def resolve_input_value(graph: WorkflowGraph, value: Any, depth: int = 0) -> Any:
    if depth > 12:
        return value
    link = normalize_link(value)
    if not link:
        return value

    node_id, output_index = link
    node = graph.node(node_id)
    if not node:
        return value

    class_type = graph.node_type(node_id)
    inputs = node.get("inputs", {})

    if class_type in PRIMITIVE_NODE_TYPES:
        for key in ("value", "seed", "number", "float", "int"):
            if key in inputs:
                return resolve_input_value(graph, inputs[key], depth + 1)
        if output_index == 0 and inputs:
            first_key = next(iter(inputs))
            return resolve_input_value(graph, inputs[first_key], depth + 1)

    if class_type == "Text Multiline":
        return inputs.get("text", "")

    if class_type == "Text Concatenate":
        left = resolve_input_value(graph, inputs.get("text_a"), depth + 1)
        right = resolve_input_value(graph, inputs.get("text_b"), depth + 1)
        delimiter = inputs.get("delimiter", "")
        return f"{left}{delimiter}{right}".strip()

    if class_type == "Text to Conditioning":
        return resolve_input_value(graph, inputs.get("text"), depth + 1)

    if class_type == "CLIPTextEncode":
        return inputs.get("text", "")

    # 转换器注入的模板端口占位节点(tools/ui_workflow_to_prompt.py):
    # 无可解析值,原样返回连线值(不展开为 dict,避免污染 loader/base_model)
    if class_type in {"__blueprint_input", "__blueprint_output", "__external_node"}:
        return value

    if class_type == "AbsNode":
        nested = resolve_input_value(graph, inputs.get("input1"), depth + 1)
        if isinstance(nested, bool):
            return int(nested)
        if isinstance(nested, (int, float)):
            return abs(nested)
        if isinstance(nested, str):
            stripped = nested.strip()
            try:
                if any(token in stripped.lower() for token in (".", "e")):
                    return abs(float(stripped))
                return abs(int(stripped))
            except ValueError:
                return nested
        return nested

    if class_type == "ConditioningCombine":
        return {
            "conditioning_1": resolve_input_value(graph, inputs.get("conditioning_1"), depth + 1),
            "conditioning_2": resolve_input_value(graph, inputs.get("conditioning_2"), depth + 1),
        }

    if class_type == "ImpactConditionalBranch":
        # Impact Pack 条件分支:cond 为真输出 tt_value,为假输出 ff_value。
        # API prompt 里 cond 通常已物化为布尔字面量,也可能是指向条件节点的
        # 连线,两种情况都按解析后的 bool 判断;cond 非 bool(未解析/缺失)时
        # 不猜分支,保持引用壳原样返回(与 sampler_view 的宽松 truthy 不同,
        # parser 是权威层,取保守口径)。
        cond = resolve_input_value(graph, inputs.get("cond"), depth + 1)
        if isinstance(cond, bool):
            branch_key = "tt_value" if cond else "ff_value"
            return _unwrap_single_scalar_reference(
                resolve_input_value(graph, inputs.get(branch_key), depth + 1)
            )
        return value

    return {"node_id": node_id, "class_type": class_type, "inputs": inputs}


def flatten_text_chunks(value: Any) -> list[str]:
    chunks: list[str] = []
    if isinstance(value, str):
        if value.strip():
            chunks.append(value.strip())
        return chunks
    if isinstance(value, dict):
        for nested in value.values():
            chunks.extend(flatten_text_chunks(nested))
        return chunks
    if isinstance(value, list):
        for nested in value:
            chunks.extend(flatten_text_chunks(nested))
    return chunks


def split_prompt_layers(text: str) -> list[dict[str, Any]]:
    layers = []
    for index, block in enumerate(text.split("\n\n")):
        cleaned = block.strip()
        if not cleaned:
            continue
        lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
        tokens = [token.strip() for token in cleaned.replace("\n", ",").split(",") if token.strip()]
        layers.append(
            {
                "layer_index": index,
                "text": cleaned,
                "lines": lines,
                "tokens": tokens,
            }
        )
    return layers


def prompt_payload(
    text: str,
    source_node_id: str | None = None,
    source_node_type: str | None = None,
    branch_label: str | None = None,
) -> dict[str, Any]:
    return {
        "text": text,
        "layers": split_prompt_layers(text),
        "source_node_id": source_node_id,
        "source_node_type": source_node_type,
        "branch_label": branch_label,
    }


def collect_prompt_groups(graph: WorkflowGraph, samplers: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    positive: list[dict[str, Any]] = []
    negative: list[dict[str, Any]] = []
    by_sampler: list[dict[str, Any]] = []
    seen_positive: set[tuple[str, str]] = set()
    seen_negative: set[tuple[str, str]] = set()

    if samplers is None:
        samplers = collect_sampler_settings(graph)

    for sampler in samplers:
        node_id = sampler.get("node_id")
        node_type = sampler.get("node_type", "")
        inputs = graph.node_inputs(node_id)
        sampler_positive: list[dict[str, Any]] = []
        sampler_negative: list[dict[str, Any]] = []

        for field_name, sampler_bucket, overall_bucket, seen, use_model_fallback in (
            ("positive", sampler_positive, positive, seen_positive, True),
            ("negative", sampler_negative, negative, seen_negative, False),
        ):
            value = inputs.get(field_name)
            entries = collect_prompt_entries_from_value(graph, value, branch_label=field_name)
            if not entries and use_model_fallback:
                model_link = normalize_link(inputs.get("model"))
                if model_link:
                    entries = collect_prompt_entries_from_link(graph, model_link[0], branch_label=field_name)

            for entry in entries:
                text = entry["text"].strip()
                branch = entry.get("branch_label") or ""
                signature = (text, branch)
                if text:
                    sampler_bucket.append(entry)
                if text and signature not in seen:
                    overall_bucket.append(entry)
                    seen.add(signature)

        by_sampler.append(
            {
                "node_id": node_id,
                "node_type": node_type,
                "positive": dedupe_prompt_entries(sampler_positive),
                "negative": dedupe_prompt_entries(sampler_negative),
            }
        )

    if not positive:
        positive = collect_prompt_fallback(graph, exclude_texts=seen_negative)
    if not negative:
        negative = collect_negative_prompt_fallback(graph, exclude_texts=seen_positive)

    return {
        "positive": positive,
        "negative": negative,
        "by_sampler": by_sampler,
    }


def collect_prompt_entries_from_link(
    graph: WorkflowGraph,
    node_id: str | None,
    visited: set[str] | None = None,
    branch_label: str | None = None,
) -> list[dict[str, Any]]:
    if not node_id:
        return []
    if visited is None:
        visited = set()
    if node_id in visited:
        return []
    visited.add(node_id)

    node = graph.node(node_id)
    if not node:
        return []

    class_type = graph.node_type(node_id)
    inputs = node.get("inputs", {})

    if class_type == "CLIPTextEncode":
        text = str(inputs.get("text", "")).strip()
        return [prompt_payload(text, node_id, class_type, branch_label=branch_label)] if text else []

    if class_type == "Text to Conditioning":
        return collect_prompt_entries_from_value(graph, inputs.get("text"), visited, branch_label=branch_label)

    if class_type == "ConditioningCombine":
        return [
            *collect_prompt_entries_from_value(graph, inputs.get("conditioning_1"), visited, branch_label=f"{branch_label or class_type}:1"),
            *collect_prompt_entries_from_value(graph, inputs.get("conditioning_2"), visited, branch_label=f"{branch_label or class_type}:2"),
        ]

    # ConditioningConcat:与 ConditioningCombine 同语义,字段为 conditioning_to/from
    # 详见 docs/parser/KNOWN_GAPS.md §2.3
    if class_type == "ConditioningConcat":
        return [
            *collect_prompt_entries_from_value(graph, inputs.get("conditioning_to"), visited, branch_label=f"{branch_label or class_type}:to"),
            *collect_prompt_entries_from_value(graph, inputs.get("conditioning_from"), visited, branch_label=f"{branch_label or class_type}:from"),
        ]

    # ConditioningSetPropertiesAndCombine:区域 prompt 核心节点(详见 KNOWN_GAPS §1.2)
    # 输入: cond (主 conditioning) + cond_NEW (新 conditioning),合并并返回
    if class_type == "ConditioningSetPropertiesAndCombine":
        return [
            *collect_prompt_entries_from_value(graph, inputs.get("cond"), visited, branch_label=f"{branch_label or class_type}:cond"),
            *collect_prompt_entries_from_value(graph, inputs.get("cond_NEW"), visited, branch_label=f"{branch_label or class_type}:cond_NEW"),
        ]

    # ConditioningSetMask:设置 mask 到 conditioning,透传 conditioning
    if class_type == "ConditioningSetMask":
        return collect_prompt_entries_from_value(
            graph, inputs.get("conditioning"), visited,
            branch_label=f"{branch_label or class_type}")

    # ConditioningSetArea 三兄弟(官方区域节点,详见 KNOWN_GAPS §2.3):
    #   ConditioningSetArea:          {conditioning, width, height, x, y, strength}
    #   ConditioningSetAreaPercentage:{conditioning, width, height, x, y, strength}
    #   ConditioningSetAreaStrength:  {conditioning, strength}
    if class_type in {"ConditioningSetArea", "ConditioningSetAreaPercentage", "ConditioningSetAreaStrength"}:
        return collect_prompt_entries_from_value(
            graph, inputs.get("conditioning"), visited,
            branch_label=f"{branch_label or class_type}")

    # Inspire Pack 区域节点(外部核实存在,字段 mask/conditioning/prompt/strength):
    #   RegionalConditioningSimple //Inspire: conditioning 透传
    if class_type == "RegionalConditioningSimple //Inspire":
        return collect_prompt_entries_from_value(
            graph, inputs.get("conditioning"), visited,
            branch_label=f"{branch_label or class_type}")

    #   RegionalPromptSimple //Inspire: prompt 为直接文本输入
    if class_type == "RegionalPromptSimple //Inspire":
        text = str(inputs.get("prompt", "")).strip()
        return [prompt_payload(text, node_id, class_type, branch_label=branch_label)] if text else []

    if class_type == "AttentionCouple":
        return [
            *collect_prompt_entries_from_value(graph, inputs.get("base_prompt"), visited, branch_label="base_prompt"),
            *collect_prompt_entries_from_value(graph, inputs.get("regions"), visited, branch_label="region_prompt"),
        ]

    if class_type == "AttentionCoupleRegions":
        entries: list[dict[str, Any]] = []
        for key in sorted(inputs):
            if key.startswith("region_"):
                entries.extend(collect_prompt_entries_from_value(graph, inputs.get(key), visited, branch_label=key))
        return entries

    if class_type == "AttentionCoupleRegion":
        return collect_prompt_entries_from_value(graph, inputs.get("cond"), visited, branch_label=branch_label or "region")

    if class_type == "Text Multiline":
        text = str(inputs.get("text", "")).strip()
        return [prompt_payload(text, node_id, class_type, branch_label=branch_label)] if text else []

    if class_type == "Text Concatenate":
        resolved = resolve_input_value(graph, [node_id, 0])
        chunks = flatten_text_chunks(resolved)
        combined = "\n\n".join(chunk for chunk in chunks if chunk.strip())
        return [prompt_payload(combined, node_id, class_type, branch_label=branch_label)] if combined else []

    # Text Prompt (JPS): 单字段 text(详见 KNOWN_GAPS §2.1)
    if class_type == "Text Prompt (JPS)":
        text = str(inputs.get("text", "")).strip()
        return [prompt_payload(text, node_id, class_type, branch_label=branch_label)] if text else []

    # Text Concatenate (JPS): text1..text5 + delimiter
    # 语义同 Text Concatenate,但字段命名不同
    if class_type == "Text Concatenate (JPS)":
        resolved = resolve_input_value(graph, [node_id, 0])
        chunks = flatten_text_chunks(resolved)
        combined = "\n\n".join(chunk for chunk in chunks if chunk.strip())
        return [prompt_payload(combined, node_id, class_type, branch_label=branch_label)] if combined else []

    # CR Text Concatenate: text1 + text2(详见 KNOWN_GAPS §2.2)
    if class_type == "CR Text Concatenate":
        resolved = resolve_input_value(graph, [node_id, 0])
        chunks = flatten_text_chunks(resolved)
        combined = "\n\n".join(chunk for chunk in chunks if chunk.strip())
        return [prompt_payload(combined, node_id, class_type, branch_label=branch_label)] if combined else []

    if "controlnet" in class_type.lower() or "conditioning" in class_type.lower():
        entries: list[dict[str, Any]] = []
        for key in ("positive", "negative", "conditioning", "cond", "base_prompt", "regions"):
            if key in inputs:
                entries.extend(
                    collect_prompt_entries_from_value(
                        graph,
                        inputs.get(key),
                        visited,
                        branch_label=branch_label or key,
                    )
                )
        if entries:
            return entries

    return []


def collect_prompt_entries_from_value(
    graph: WorkflowGraph,
    value: Any,
    visited: set[str] | None = None,
    branch_label: str | None = None,
) -> list[dict[str, Any]]:
    link = normalize_link(value)
    if link:
        return collect_prompt_entries_from_link(graph, link[0], visited, branch_label=branch_label)

    if isinstance(value, str) and value.strip():
        return [prompt_payload(value.strip(), branch_label=branch_label)]

    resolved = resolve_input_value(graph, value)
    chunks = flatten_text_chunks(resolved)
    combined = "\n\n".join(chunk for chunk in chunks if chunk.strip())
    return [prompt_payload(combined, branch_label=branch_label)] if combined else []


def collect_prompt_fallback(graph: WorkflowGraph, exclude_texts: set[tuple[str, str]] | None = None) -> list[dict[str, Any]]:
    exclude_texts = exclude_texts or set()
    entries: list[dict[str, Any]] = []
    for node_id in graph.prompt:
        if graph.node_type(node_id) not in {"Text Multiline", "Text Concatenate", "Text to Conditioning"}:
            continue
        for entry in collect_prompt_entries_from_link(graph, node_id):
            signature = (entry["text"], entry.get("branch_label") or "")
            if entry["text"] and signature not in exclude_texts:
                entries.append(entry)
    return dedupe_prompt_entries(entries)


def collect_negative_prompt_fallback(graph: WorkflowGraph, exclude_texts: set[tuple[str, str]] | None = None) -> list[dict[str, Any]]:
    exclude_texts = exclude_texts or set()
    entries: list[dict[str, Any]] = []
    for node_id, node in graph.prompt.items():
        if graph.node_type(node_id) != "CLIPTextEncode":
            continue
        text = str(node.get("inputs", {}).get("text", "")).strip()
        signature = (text, "")
        if not text or signature in exclude_texts:
            continue
        lowered = text.lower()
        if any(token in lowered for token in ("worst quality", "bad anatomy", "watermark", "lowres", "blurry")):
            entries.append(prompt_payload(text, node_id, "CLIPTextEncode"))
    return dedupe_prompt_entries(entries)


def dedupe_prompt_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for entry in entries:
        text = entry.get("text", "").strip()
        branch = entry.get("branch_label") or ""
        signature = (text, branch)
        if not text or signature in seen:
            continue
        seen.add(signature)
        deduped.append(entry)
    return deduped


def _seed_token(seed: Any) -> str | None:
    """seed 值归一化为批次键 token;无法归一化时返回 None(不参与分组)。"""
    if isinstance(seed, (int, float)) and not isinstance(seed, bool):
        return str(int(seed))
    if isinstance(seed, str):
        try:
            return str(int(float(seed)))
        except (ValueError, OverflowError):
            return f"s:{seed}"
    return None


def _batch_size_token(latent: dict[str, Any], file_info: dict[str, Any]) -> tuple[int, int] | None:
    """尺寸 token:批次键的尺寸维度,latent 尺寸优先,缺失时回退 file 实测像素。"""
    for source in (latent, file_info):
        w = source.get("width")
        h = source.get("height")
        if (
            isinstance(w, int)
            and not isinstance(w, bool)
            and isinstance(h, int)
            and not isinstance(h, bool)
            and w > 0
            and h > 0
        ):
            return (w, h)
    return None


def batch_group_key(
    samplers: list[dict[str, Any]],
    sha256_fallback: str = "",
    size: tuple[int, int] | None = None,
) -> str:
    """生成确定性批次键。

    基于所有 sampler 的 seed 值生成键,同一批次的图片共享此键。
    seed 为列表(批量种子节点)时逐元素展平参与分组。
    size 可用时追加 @<w>x<h>(latent 优先,file 兜底),区分同 seed 不同
    分辨率的独立生成事件。
    当 seed 值不可用时,回退到文件 sha256。
    """
    seeds = []
    for sampler in samplers:
        seed = sampler.get("seed")
        if isinstance(seed, list):
            for sub in seed:
                token = _seed_token(sub)
                if token is not None:
                    seeds.append(token)
            continue
        token = _seed_token(seed)
        if token is not None:
            seeds.append(token)
    if seeds:
        key = "seed:" + "|".join(seeds)
        if size is not None:
            key += f"@{size[0]}x{size[1]}"
        return key
    if sha256_fallback:
        return "file:" + sha256_fallback
    return "batch:unknown"


def seed_source_info(graph: WorkflowGraph, seed_value: Any) -> dict[str, str] | None:
    """追溯 seed 输入的来源节点(provenance)。

    仅当 seed 通过连线传入时返回 {node_id, node_type}，供展示与重放溯源；
    直接 widget 值(无连线)返回 None。不改 resolve_input_value 语义。
    """
    link = normalize_link(seed_value)
    if not link:
        return None
    node_id, _ = link
    node_type = graph.node_type(node_id)
    if not node_type:
        return None
    return {"node_id": str(node_id), "node_type": node_type}


def collect_sampler_settings(graph: WorkflowGraph) -> list[dict[str, Any]]:
    samplers: list[dict[str, Any]] = []
    for node_id, node in graph.prompt.items():
        class_type = str(node.get("class_type", ""))
        if not any(hint in class_type.lower() for hint in SAMPLER_HINTS):
            continue
        # 排除误判:名称选择器无 seed/steps,仅作采样器名称下拉
        #   `Sampler Selector` 与 `KSamplerSelect` 同上(见 KNOWN_GAPS §1.3)
        if class_type in ("Sampler Selector", "KSamplerSelect"):
            continue
        inputs = node.get("inputs", {})
        sampler = {
            "node_id": node_id,
            "node_type": class_type,
            "seed": resolve_input_value(graph, inputs.get("seed")),
            "steps": resolve_input_value(graph, inputs.get("steps")),
            "cfg": resolve_input_value(graph, inputs.get("cfg")),
            "sampler_name": resolve_input_value(graph, inputs.get("sampler_name")),
            "scheduler": resolve_input_value(graph, inputs.get("scheduler")),
            "denoise": resolve_input_value(graph, inputs.get("denoise")),
            "noise_seed": resolve_input_value(graph, inputs.get("noise_seed")),
        }
        seed_source = seed_source_info(graph, inputs.get("seed"))
        if seed_source:
            sampler["seed_source"] = seed_source
        samplers.append({key: value for key, value in sampler.items() if value not in (None, "", {})})
    return samplers


def collect_latent_settings(graph: WorkflowGraph, samplers: list[dict[str, Any]]) -> dict[str, Any]:
    candidates: list[dict[str, Any]] = []
    for sampler in samplers:
        node_id = sampler.get("node_id")
        inputs = graph.node_inputs(node_id)
        link = normalize_link(inputs.get("latent_image"))
        if not link:
            continue
        source_id, _ = link
        latent_inputs = graph.node_inputs(source_id)
        class_type = graph.node_type(source_id)
        candidate = {
            "node_id": source_id,
            "node_type": class_type,
            "width": resolve_input_value(graph, latent_inputs.get("width")),
            "height": resolve_input_value(graph, latent_inputs.get("height")),
            "batch_size": resolve_input_value(graph, latent_inputs.get("batch_size")),
            "empty_latent_width": resolve_input_value(graph, latent_inputs.get("empty_latent_width")),
            "empty_latent_height": resolve_input_value(graph, latent_inputs.get("empty_latent_height")),
        }
        candidates.append({key: value for key, value in candidate.items() if value not in (None, "", {})})

    if candidates:
        primary = candidates[0].copy()
        primary["sources"] = candidates
        if "width" not in primary and "empty_latent_width" in primary:
            primary["width"] = primary["empty_latent_width"]
        if "height" not in primary and "empty_latent_height" in primary:
            primary["height"] = primary["empty_latent_height"]
        return primary

    return {}


def collect_model_settings(graph: WorkflowGraph, samplers: list[dict[str, Any]]) -> dict[str, Any]:
    base_model = None
    checkpoint_node_id = None
    model_nodes: list[dict[str, Any]] = []

    for node_id, node in graph.prompt.items():
        class_type = str(node.get("class_type", ""))
        inputs = node.get("inputs", {})
        record = {"node_id": node_id, "node_type": class_type}
        for field in ("ckpt_name", "unet_name", "model_name", "vae_name", "clip_name"):
            value = resolve_input_value(graph, inputs.get(field))
            # 仅收字符串字面量(连线值/未解析端口占位为 list/dict,不当作模型名)
            if isinstance(value, str) and value not in ("", "None"):
                record[field] = value
        if len(record) > 2:
            model_nodes.append(record)
        if not base_model and any(name in inputs for name in ("ckpt_name", "unet_name", "model_name")):
            checkpoint_node_id = node_id
            base_model = record.get("ckpt_name") or record.get("unet_name") or record.get("model_name")

    model_source_id = None
    for sampler in samplers:
        inputs = graph.node_inputs(sampler.get("node_id"))
        link = normalize_link(inputs.get("model"))
        if link:
            model_source_id = link[0]
            break

    return {
        "base_model": base_model,
        "checkpoint_node_id": checkpoint_node_id,
        "sampler_model_source_id": model_source_id,
        "nodes": model_nodes,
    }


def collect_lora_settings(graph: WorkflowGraph, model: dict[str, Any]) -> dict[str, Any]:
    items: list[dict[str, Any]] = []

    for node_id, node in graph.prompt.items():
        class_type = str(node.get("class_type", ""))
        inputs = node.get("inputs", {})

        if graph.node_is_bypassed(node_id):
            continue

        if class_type == "LoraLoader":
            lora_name = resolve_input_value(graph, inputs.get("lora_name"))
            if lora_name and lora_name != "None":
                items.append(
                    {
                        "node_id": node_id,
                        "source": class_type,
                        "name": lora_name,
                        "strength_model": resolve_input_value(graph, inputs.get("strength_model")),
                        "strength_clip": resolve_input_value(graph, inputs.get("strength_clip")),
                    }
                )

        # ComfyUI hook 机制 LoRA(详见 docs/parser/KNOWN_GAPS.md §1.1)
        # 字段与 LoraLoader 完全一致
        if class_type == "CreateHookLora":
            lora_name = resolve_input_value(graph, inputs.get("lora_name"))
            if lora_name and lora_name != "None":
                items.append(
                    {
                        "node_id": node_id,
                        "source": class_type,
                        "name": lora_name,
                        "strength_model": resolve_input_value(graph, inputs.get("strength_model")),
                        "strength_clip": resolve_input_value(graph, inputs.get("strength_clip")),
                    }
                )

        if class_type == "LoRA Stacker":
            lora_count = int(inputs.get("lora_count", 0) or 0)
            for index in range(1, max(lora_count, 1) + 1):
                lora_name = inputs.get(f"lora_name_{index}")
                if not lora_name or lora_name == "None":
                    continue
                items.append(
                    {
                        "node_id": node_id,
                        "source": class_type,
                        "slot": index,
                        "name": lora_name,
                        "strength": inputs.get(f"lora_wt_{index}"),
                        "strength_model": inputs.get(f"model_str_{index}"),
                        "strength_clip": inputs.get(f"clip_str_{index}"),
                    }
                )

        if class_type in {"Power Lora Loader (rgthree)", "Power Lora Loader"}:
            workflow_node = graph.workflow_node(node_id) or {}
            widgets_values = workflow_node.get("widgets_values", [])
            if not isinstance(widgets_values, list):
                widgets_values = []
            for index, widget in enumerate(widgets_values, start=1):
                if not isinstance(widget, dict):
                    continue
                lora_name = widget.get("lora")
                if not lora_name or lora_name == "None":
                    continue
                enabled = widget.get("on", True)
                if enabled in (False, 0, "0", "false", "False"):
                    continue
                strength = normalize_lora_strength(widget.get("strength"))
                strength_two = normalize_lora_strength(widget.get("strengthTwo"))
                items.append(
                    {
                        "node_id": node_id,
                        "source": class_type,
                        "slot": index,
                        "name": lora_name,
                        "strength": strength,
                        "strength_model": strength,
                        "strength_clip": strength if strength_two in (None, "") else strength_two,
                    }
                )

    deduped: list[dict[str, Any]] = []
    seen = set()
    for item in items:
        key = (
            item.get("source"),
            item.get("name"),
            item.get("strength"),
            item.get("strength_model"),
            item.get("strength_clip"),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)

    return {
        "count": len(deduped),
        "names": [item["name"] for item in deduped],
        "items": deduped,
        "model_source_hint": model.get("sampler_model_source_id"),
    }


def build_prompt_search_text(positive_prompts: list[dict[str, Any]], negative_prompts: list[dict[str, Any]]) -> str:
    chunks = [item["text"] for item in positive_prompts + negative_prompts if item.get("text")]
    return "\n\n".join(chunks)


def build_file_info(
    path: Path,
    resolved_path: Path,
    relative_path: str,
    file_stats: os.stat_result,
    image_info: dict[str, Any],
) -> dict[str, Any]:
    sha256 = hashlib.sha256(str(resolved_path).encode("utf-8")).hexdigest()
    return {
        "filename": path.name,
        "image_name": path.stem,
        "extension": path.suffix.lower(),
        "relative_path": relative_path,
        "source_path": str(path),
        "resolved_path": str(resolved_path),
        "windows_path": to_windows_path(resolved_path),
        "size_bytes": file_stats.st_size,
        "mtime": file_stats.st_mtime,
        "mtime_ns": file_stats.st_mtime_ns,
        "sha256": sha256,
        **image_info,
    }


def to_windows_path(path: Path) -> str | None:
    parts = path.parts
    if len(parts) >= 3 and parts[0] == "/" and parts[1] == "mnt":
        drive = parts[2].upper() + ":"
        suffix = PureWindowsPath(*parts[3:]) if len(parts) > 3 else PureWindowsPath()
        return str(PureWindowsPath(drive + "\\") / suffix)
    return None
