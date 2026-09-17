"""Extract image lineage candidates from embedded generation metadata.

This module is a parse-worker sidecar. It does not modify parser.py records and
does not access either MongoDB or SQLite.
"""

from __future__ import annotations

import json
import re
from collections import deque
from typing import Any

from .workflow_ir import WorkflowIR

RELATION_TYPES = {"i2i", "controlnet", "mask", "reference", "auxiliary"}
_CONTENT_HASH_RE = re.compile(r"^[0-9a-fA-F]{64}$")
# ComfyUI 在文件名后附加的来源标记(` [input]` / ` [temp]`,可多层叠加);
# 带尾注的引用与库内 filename/image_name 不是同一口径 → 必须剥净。
_REF_SUFFIX_RE = re.compile(r"\s+\[(?:input|temp)\]$", re.IGNORECASE)
# 容器内的 ComfyUI 根前缀(`/app/comfyui`、`/workspace/ComfyUI` 等)与
# input/temp 段本身:实测 raw_ref 混有 Docker 路径与宿主绝对路径,
# 只保留 input/ 下的相对位置才能与库内/探活同口径。
_CONTAINER_ROOT_RE = re.compile(
    r"^(?:[a-z]:)?(?:/(?:app|comfyui|workspace))*/(?:app|comfyui|workspace)(?=/)",
    re.IGNORECASE,
)
_TYPE_SEGMENT_RE = re.compile(r"^(?:input|temp)$", re.IGNORECASE)


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _raw_ref_field(inputs: dict[str, Any]) -> str:
    """返回持有引用值的输入字段名(按固定优先级),无则空串。

    与 _raw_ref 共用同一优先级:提取侧据此读值,改写侧据此写回,
    保证"提取认得的字段"一定改写得到。
    """
    for field in ("image", "filename", "path", "image_path"):
        if isinstance(inputs.get(field), str):
            return field
    return ""


def _clean_ref(text: str) -> str:
    """把引用归一到 ComfyUI input/ 下的相对位置。

    三步(与网关侧 splitRefLocation 同一套语义):
      1. 剥净 ` [input]` / ` [temp]` 尾注(可多层)
      2. 去掉容器根前缀(`/app/comfyui` 等)
      3. 去掉 `input` / `temp` 段本身;残留盘符段(别的机器的绝对路径)
         说明目录结构不是 ComfyUI 内的,只保留文件名

    不归一的后果:探活会去问 `input/app/comfyui/input/x`(必然 404),
    按文件名找父图也因 subfolder 错位而 miss。
    """
    stripped = _REF_SUFFIX_RE.sub("", text)
    while stripped != text:
        text = stripped
        stripped = _REF_SUFFIX_RE.sub("", text)
    text = text.replace("\\", "/")
    text = _CONTAINER_ROOT_RE.sub("", text)
    segments = [s for s in text.split("/") if s]
    rest = [s for s in segments if not _TYPE_SEGMENT_RE.match(s)]
    # 残留盘符段(`c:`)= 外部绝对路径,其目录不是 ComfyUI 内的合法子目录
    if any(re.fullmatch(r"[a-z]:", s, re.IGNORECASE) for s in rest):
        return rest[-1] if rest else ""
    return "/".join(rest)


def _raw_ref(node: dict[str, Any]) -> str:
    inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
    field = _raw_ref_field(inputs)
    if not field:
        return ""
    return _clean_ref(str(inputs[field]).strip())


def _content_hash(node: dict[str, Any]) -> str | None:
    changed = node.get("is_changed")
    values = changed if isinstance(changed, list) else [changed]
    for value in values:
        text = str(value or "").strip()
        if _CONTENT_HASH_RE.fullmatch(text):
            return text.lower()
    return None


def _edge_relation(target_type: str, target_field: str, kind: str) -> str | None:
    probe = f"{target_type} {target_field}".lower()
    if kind == "mask" or "mask" in target_field.lower():
        return "mask"
    if "controlnet" in probe or "control_net" in probe:
        return "controlnet"
    if any(token in probe for token in ("ipadapter", "reference", "instantid", "pulid", "stylemodel")):
        return "reference"
    return None


def _relations_for_loader(ir: WorkflowIR, loader_id: str) -> tuple[set[str], list[dict[str, Any]]]:
    """返回 (relations, downstream_cns)。

    relations:同 loader 的下游语义关系集。
    downstream_cns:该 loader 喂到的 ControlNet 应用(每 apply 一条,含 loader
    溯源/模型名/strength)——多 CN 各引不同参考图时,信息用于区分「这张图
    喂给了哪个 CN 模型」。
    """
    relations: set[str] = set()
    downstream_cns: list[dict[str, Any]] = []
    queue: deque[tuple[str, bool]] = deque([(loader_id, False)])
    seen: set[tuple[str, bool]] = set()
    seen_apply: set[str] = set()
    while queue:
        node_id, encoded = queue.popleft()
        state = (node_id, encoded)
        if state in seen:
            continue
        seen.add(state)
        for edge in ir.outgoing_edges(node_id):
            target_id = edge.target.node_id
            target_type = ir.node_type(target_id)
            target_field = edge.target.field
            direct = _edge_relation(target_type, target_field, edge.kind)
            if direct:
                relations.add(direct)
            # ControlNet 下游:apply 节点 + 其 loader/模型名/强度
            target_lower = target_type.lower()
            if "controlnet" in target_lower and "apply" in target_lower:
                if target_id not in seen_apply:
                    seen_apply.add(target_id)
                    apply_inputs = ir.node_inputs(target_id) or {}
                    cn_link = apply_inputs.get("control_net")
                    cn_loader_id = (
                        cn_link[0] if isinstance(cn_link, list) and cn_link else None
                    )
                    cn_name: str | None = None
                    if cn_loader_id:
                        loader = ir.node_inputs(cn_loader_id) or {}
                        val = (
                            loader.get("control_net_name")
                            or loader.get("control_net")
                            or loader.get("cn_name")
                        )
                        cn_name = str(val) if val and str(val) != "None" else None
                    strength = apply_inputs.get("strength")
                    downstream_cns.append(
                        {
                            "apply_node_id": target_id,
                            "apply_type": target_type,
                            "loader_node_id": cn_loader_id,
                            "control_net_name": cn_name,
                            "strength": strength,
                        }
                    )
            next_encoded = encoded or "vaeencode" in target_lower or (
                "encode" in target_lower and edge.kind == "image"
            )
            if (
                "sampler" in target_lower
                and target_field in {"latent_image", "latent", "samples"}
                and encoded
            ):
                relations.add("i2i")
            if len(seen) < 256:
                queue.append((target_id, next_encoded))
    return (relations or {"auxiliary"}), downstream_cns


def _num(value: Any) -> str:
    try:
        return f"{float(value):.3g}"
    except (TypeError, ValueError):
        return "?"


def _novelai_ref_candidates(novelai: dict[str, Any]) -> list[dict[str, Any]]:
    """NovelAI 图像输入特性均不在元数据中保留源图,一律以 source_unavailable 如实标记。"""
    out: list[dict[str, Any]] = []

    def add(source_node_id: str, relation_type: str, raw_ref: str) -> None:
        out.append(
            {
                "relation_type": relation_type,
                "raw_ref": raw_ref,
                "source_node_id": source_node_id,
                "source_node_type": "NovelAI",
                "source_content_sha256": None,
                "active": True,
                "source_unavailable": True,
            }
        )

    strengths = novelai.get("reference_strength_multiple")
    if isinstance(strengths, list):
        extracted = novelai.get("reference_information_extracted_multiple")
        for idx, value in enumerate(strengths):
            label = f"vibe-transfer #{idx + 1} (strength {_num(value)}"
            if isinstance(extracted, list) and idx < len(extracted):
                label += f", information_extracted {_num(extracted[idx])}"
            add(f"novelai:vibe:{idx}", "reference", label + ")")

    descriptions = novelai.get("director_reference_descriptions")
    if isinstance(descriptions, list):
        ref_strengths = novelai.get("director_reference_strengths")
        ref_fidelity = novelai.get("director_reference_secondary_strengths")
        for idx, item in enumerate(descriptions):
            kind = "unknown"
            if isinstance(item, dict):
                caption = item.get("caption")
                if isinstance(caption, dict):
                    base = caption.get("base_caption")
                    if isinstance(base, str) and base.strip():
                        kind = base.strip()
            label = f"precise-reference {kind}"
            if isinstance(ref_strengths, list) and idx < len(ref_strengths):
                label += f" (strength {_num(ref_strengths[idx])}"
                if isinstance(ref_fidelity, list) and idx < len(ref_fidelity):
                    label += f", fidelity {_num(ref_fidelity[idx])}"
                label += ")"
            add(f"novelai:precise:{idx}", "reference", label)

    if "strength" in novelai or "noise" in novelai:
        add(
            "novelai",
            "i2i",
            f"strength {_num(novelai.get('strength'))}, noise {_num(novelai.get('noise'))}",
        )
    elif "img2img" in novelai:
        add("novelai:infill", "i2i", "inpainting source")
    return out


def _is_image_loader(node_type: str) -> bool:
    """匹配 LoadImage 及其空格/连字符变体(D2 Load Image、Image Load、ImageLoader 等)。"""
    compact = re.sub(r"[\s_-]+", "", node_type.lower())
    return "loadimage" in compact or "imageload" in compact


def image_loader_refs(raw_prompt: Any) -> list[dict[str, Any]]:
    """列出提交负载里的图像 loader 引用(供生成前探活/回填)。

    与 extract_image_lineage 共用 _is_image_loader 与 _raw_ref:两处口径若
    分叉,"探活过的图"与"记进血缘的图"就会错位(探活通过却无血缘,或血缘
    有记录却从未探活,提交即被 ComfyUI 拒掉)。

    raw_ref 已剥净 ` [temp]` / ` [input]` 尾注,与库内 filename/image_name
    同口径;content_sha256 取 is_changed 中的二进制内容哈希(有则为
    ComfyUI 运行时真哈希,可按内容而非文件名找回源图)。

    @param raw_prompt API 格式负载(节点 id → {class_type, inputs})
    @returns 引用列表(按 prompt 迭代顺序,仅含真有引用值的 loader)
    """
    prompt = _json_object(raw_prompt)
    refs: list[dict[str, Any]] = []
    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        node_type = str(node.get("class_type") or "")
        if not _is_image_loader(node_type):
            continue
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        raw_ref = _raw_ref(node)
        if not raw_ref:
            continue
        refs.append(
            {
                "node_id": str(node_id),
                "node_type": node_type,
                "raw_ref": raw_ref,
                # 回填时按此字段写回新落盘名(与读取字段同源)
                "raw_ref_field": _raw_ref_field(inputs),
                "content_sha256": _content_hash(node),
            }
        )
    return refs


def extract_image_lineage(
    raw_prompt: Any,
    raw_workflow: Any = None,
    raw_novelai: Any = None,
) -> dict[str, Any]:
    """Return classified source-image candidates without resolving parents."""
    prompt = _json_object(raw_prompt)
    workflow = _json_object(raw_workflow)
    ir = WorkflowIR(prompt, workflow or None)
    candidates: list[dict[str, Any]] = []
    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        node_type = str(node.get("class_type") or "")
        if not _is_image_loader(node_type):
            continue
        raw_ref = _raw_ref(node)
        if not raw_ref:
            continue
        active = not ir.node_is_bypassed(str(node_id))
        relations, downstream_cns = _relations_for_loader(ir, str(node_id))
        for relation_type in sorted(relations):
            candidate: dict[str, Any] = {
                "relation_type": relation_type,
                "raw_ref": raw_ref,
                "source_node_id": str(node_id),
                "source_node_type": node_type,
                "source_content_sha256": _content_hash(node),
                "active": active,
            }
            # 多 CN 各引不同参考图:仅 controlnet 关系携带下游 CN 信息
            if relation_type == "controlnet" and downstream_cns:
                candidate["downstream"] = downstream_cns
            candidates.append(candidate)

    novelai = _json_object(raw_novelai)
    if not candidates and novelai:
        candidates.extend(_novelai_ref_candidates(novelai))
    return {"candidates": candidates}


__all__ = ["RELATION_TYPES", "extract_image_lineage", "image_loader_refs"]
