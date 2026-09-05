"""NovelAI 图片元数据适配器(parse_worker 层零侵入后处理,非 parser.py 冻结核心)。

职责:对 parser.py 产出的 record 做 NovelAI 专属字段映射——检测门命中
(图片确为 NovelAI 生成)时,把 PNG tEXt `Comment` 块中的原生生成参数
映射进 record 既有字段(prompts / samplers / model / latent / batch_key),
并把 Comment 原文保留到 metadata.raw_novelai。

设计约束(详见 docs/parser/NOVELAI_SUPPORT.md):
- 零侵入:不修改 parser.py;仅从 workflow_db.parser 导入稳定函数
  (prompt_payload / build_prompt_search_text / batch_group_key),
  保证字段结构与核心语义一致。
- 检测门:ComfyUI / A1111 图片必然不命中,原样返回。
- 容错:任何字段缺失 / 类型异常 / 结构未知都跳过该字段,绝不抛错
  阻断入库(失败态与现状一致:NAI 图保持空 prompts 不可见)。
- V4 双格式:base 文本顶层平铺优先(prompt/uc),空则回退 v4 caption 的
  base_caption;v4 caption 的 char_captions(角色 prompt)仅存在于
  结构化对象中,无论 base 来自哪一层都必须补齐,防止语义丢失。
- 批次隔离:批次键加 "nai:" 前缀,防止与 ComfyUI 同 seed 同尺寸批次合并。
"""

from __future__ import annotations

import json
from typing import Any

from workflow_db.parser import (
    batch_group_key,
    build_prompt_search_text,
    prompt_payload,
)

_NAI_SOFTWARE = "novelai"
_SOURCE_HINTS = ("stable diffusion", "nai-diffusion", "nai_diffusion")
# Comment JSON 签名:scale+sampler 组合(V1-4 恒有)或 v4_prompt 结构化对象;
# A1111 comment 是 infotext 文本、ComfyUI prompt 是节点图结构,均不满足
_SIGNATURE_KEYS = ("scale", "sampler")
_V4_PROMPT_KEY = "v4_prompt"
_V4_NEGATIVE_KEY = "v4_negative_prompt"

SOURCE_NODE_TYPE = "NovelAI"
BATCH_PREFIX = "nai:"


def _parse_comment(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, str):
        return None
    try:
        data = json.loads(value)
    except (json.JSONDecodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def extract_comment(metadata: dict[str, Any]) -> dict[str, Any] | None:
    """检测门:命中返回 Comment JSON,否则 None。

    双条件:Software / Source 强信号 + Comment JSON 签名组合。
    """
    extra = metadata.get("extra")
    if not isinstance(extra, dict):
        return None
    software = str(extra.get("Software", "")).lower()
    source = str(extra.get("Source", "")).lower()
    strong_signal = _NAI_SOFTWARE in software or any(
        hint in source for hint in _SOURCE_HINTS
    )
    if not strong_signal:
        return None
    data = _parse_comment(extra.get("Comment"))
    if data is None:
        return None
    if not (
        all(key in data for key in _SIGNATURE_KEYS) or _V4_PROMPT_KEY in data
    ):
        return None
    return data


def _v4_base_caption(v4: Any) -> str:
    if not isinstance(v4, dict):
        return ""
    caption = v4.get("caption")
    if not isinstance(caption, dict):
        return ""
    base = caption.get("base_caption")
    return base.strip() if isinstance(base, str) else ""


def _v4_char_captions(v4: Any) -> list[str]:
    if not isinstance(v4, dict):
        return []
    caption = v4.get("caption")
    if not isinstance(caption, dict):
        return []
    char_captions = caption.get("char_captions")
    texts: list[str] = []
    if isinstance(char_captions, list):
        for entry in char_captions:
            if not isinstance(entry, dict):
                continue
            char = entry.get("char_caption")
            if isinstance(char, str) and char.strip():
                texts.append(char.strip())
    return texts


def _extract_prompt(
    data: dict[str, Any], negative: bool = False, description: str = ""
) -> str:
    v4 = data.get(_V4_NEGATIVE_KEY if negative else _V4_PROMPT_KEY)
    if not isinstance(v4, dict):
        v4 = None
    char_texts = _v4_char_captions(v4)

    # base 文本:顶层平铺(prompt/uc)优先,v4 base_caption 次之,
    # Description chunk 兜底(真实 V1/V2 样本 Comment 无 prompt 键)。
    # V4 双格式下顶层平铺只含 base_caption,角色 prompt 仅存在于
    # v4 caption.char_captions,须在 base 之后补齐(146643178 样本)。
    top = data.get("uc" if negative else "prompt")
    if isinstance(top, str) and top.strip():
        base = top.strip()
    else:
        base = _v4_base_caption(v4)
        if not base and not negative:
            desc = description if isinstance(description, str) else ""
            if desc.strip():
                base = desc.strip()

    parts = [base] if base else []
    for char_text in char_texts:
        # 防御:若顶层平铺已内联角色文本(未观测到的写法),不重复追加
        if not base or char_text not in base:
            parts.append(char_text)
    return ", ".join(parts)


def _int_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else None
    if isinstance(value, str):
        try:
            return int(float(value))
        except (ValueError, OverflowError):
            return None
    return None


def _build_sampler(data: dict[str, Any]) -> dict[str, Any]:
    sampler: dict[str, Any] = {"node_type": SOURCE_NODE_TYPE}
    seed = _int_value(data.get("seed"))
    if seed is not None and seed != 0:
        sampler["seed"] = seed
    steps = _int_value(data.get("steps"))
    if steps is not None:
        sampler["steps"] = steps
    scale = data.get("scale")
    if isinstance(scale, (int, float)) and not isinstance(scale, bool):
        sampler["cfg"] = scale
    sampler_name = data.get("sampler")
    if isinstance(sampler_name, str) and sampler_name:
        sampler["sampler_name"] = sampler_name
    noise_schedule = data.get("noise_schedule")
    if isinstance(noise_schedule, str) and noise_schedule:
        sampler["scheduler"] = noise_schedule
    return sampler


def _size_token(record: dict[str, Any]) -> tuple[int, int] | None:
    for source in (record.get("latent"), record.get("file")):
        if not isinstance(source, dict):
            continue
        width = source.get("width")
        height = source.get("height")
        if (
            isinstance(width, int)
            and isinstance(height, int)
            and width > 0
            and height > 0
        ):
            return (width, height)
    return None


def apply(record: dict[str, Any]) -> dict[str, Any]:
    """NovelAI 后处理映射;非 NovelAI 记录原样返回,任何异常均不阻断入库。"""
    try:
        return _apply_inner(record)
    except Exception:
        return record


def _apply_inner(record: dict[str, Any]) -> dict[str, Any]:
    metadata = record.get("metadata")
    if not isinstance(metadata, dict):
        return record
    data = extract_comment(metadata)
    if data is None:
        return record

    extra = metadata.get("extra")
    if not isinstance(extra, dict):
        extra = {}
    description = extra.get("Description")
    if not isinstance(description, str):
        description = ""
    positive_text = _extract_prompt(data, negative=False, description=description)
    negative_text = _extract_prompt(data, negative=True)
    positive: list[dict[str, Any]] = []
    negative: list[dict[str, Any]] = []
    if positive_text:
        positive.append(
            prompt_payload(
                positive_text,
                source_node_type=SOURCE_NODE_TYPE,
                branch_label="novelai-positive",
            )
        )
    if negative_text:
        negative.append(
            prompt_payload(
                negative_text,
                source_node_type=SOURCE_NODE_TYPE,
                branch_label="novelai-negative",
            )
        )
    if positive or negative:
        record["prompts"] = {
            "positive": positive,
            "negative": negative,
            "by_sampler": [],
            "search_text": build_prompt_search_text(positive, negative),
        }

    sampler = _build_sampler(data)
    if len(sampler) > 1:
        record["samplers"] = [sampler]

    file_info = record.get("file")
    if isinstance(file_info, dict):
        width = file_info.get("width")
        height = file_info.get("height")
        if (
            isinstance(width, int)
            and isinstance(height, int)
            and width > 0
            and height > 0
        ):
            record["latent"] = {"width": width, "height": height}

    if isinstance(sampler.get("seed"), int):
        sha256 = ""
        if isinstance(file_info, dict):
            sha256 = file_info.get("sha256") or ""
        record["batch_key"] = BATCH_PREFIX + batch_group_key(
            [sampler],
            sha256_fallback=sha256,
            size=_size_token(record),
        )

    model_name = data.get("model")
    if not isinstance(model_name, str) or not model_name:
        source_chunk = extra.get("Source")
        if isinstance(source_chunk, str) and source_chunk.strip():
            model_name = source_chunk.strip()
    if isinstance(model_name, str) and model_name:
        record["model"] = {
            "base_model": model_name,
            "nodes": [{"node_type": SOURCE_NODE_TYPE, "model_name": model_name}],
        }

    if isinstance(extra.get("Comment"), str):
        metadata["raw_novelai"] = extra["Comment"]
    return record
