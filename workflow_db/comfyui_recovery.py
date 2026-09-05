"""Offline recovery of prompts from ComfyUI custom-node graphs.

This module is deliberately a small parse-worker adapter.  It only reads the
already embedded ``metadata.raw_prompt`` graph and never performs I/O.
"""
from __future__ import annotations

import json
import re
from typing import Any

from workflow_db.parser import TEXT_NODE_TYPES, build_prompt_search_text, prompt_payload


_PLAIN_TEXT_TYPES = (set(TEXT_NODE_TYPES) - {
    "Text Concatenate",
    "Text Concatenate (JPS)",
    "CR Text Concatenate",
    "Text to Conditioning",
}) | {
    "BNK_CLIPTextEncodeAdvanced",
}
_CONCAT_TEXT_TYPES = {"Text Concatenate", "Text Concatenate (JPS)", "CR Text Concatenate"}
# 受控扩展:CR/ZML 变体拼接节点(字段名与分隔符键不同,行为与 concat 一致)
_CONCAT_FIELDS: dict[str, tuple[str, ...]] = {
    "Text Concatenate": ("text_a", "text_b"),
    "Text Concatenate (JPS)": tuple(f"text{i}" for i in range(1, 6)),
    "CR Text Concatenate": ("text1", "text2"),
    "CR Combine Prompt": ("part1", "part2", "part3", "part4"),
    "ZML_MultiTextInput3": ("文本1", "文本2", "文本3"),
    "ZML_MultiTextInput5": ("文本1", "文本2", "文本3", "文本4", "文本5"),
    # string_N 按声明上限静态枚举,实际不存在的序号无输入自然跳过
    "JoinStringMulti": tuple(f"string_{i}" for i in range(1, 33)),
}
_CONCAT_DELIMITER_KEYS: dict[str, str] = {
    "CR Combine Prompt": "separator",
    "ZML_MultiTextInput3": "分隔符",
    "ZML_MultiTextInput5": "分隔符",
}
# conditioning 清空型节点:语义为空条件,不沿 conditioning 继续追溯
_CONDITIONING_TERMINATORS = {"ConditioningZeroOut"}

# parser.py 索引层对 CLIPTextEncode/Text Multiline 等节点取 str(inputs["text"]) 时,
# 连线值 ["41", 0] 会被序列化成 "['41', 0]" 混入 prompt(节点 id 可含冒号,槽位为 int)。
# 此处仅在适配层识别并剔除该类污染,不改 parser 核心。
_LINK_LITERAL_RE = re.compile(
    r"^\s*\[\s*['\"]?[\w:.\-]+['\"]?\s*,\s*\d+\s*\]\s*$"
)
# 经 text 端口连入的未知节点,按"分支名 → 通用文本字段 → 组织器 widget_data"提取字面量
_GENERIC_TEXT_KEYS = (
    "text", "prompt", "positive_prompt", "negative_prompt", "string", "value", "String",
)


def _normalise_graph(graph: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(graph, dict):
        return {}
    return {
        str(node_id): node
        for node_id, node in graph.items()
        if isinstance(node, dict) and isinstance(node.get("inputs", {}), dict)
    }


def _link(value: Any) -> str | None:
    if not isinstance(value, (list, tuple)) or len(value) < 1:
        return None
    node_id = value[0]
    if isinstance(node_id, (str, int)) and not isinstance(node_id, bool):
        return str(node_id)
    return None


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _is_clip_text_encoder(class_type: str) -> bool:
    """Return whether a node emits conditioning from its literal ``text`` input.

    Custom nodes commonly retain the CLIPTextEncode contract but prefix it
    (for example ``smZ CLIPTextEncode``).  The input contract is what matters
    here, not an exact frontend display name.
    """
    return "cliptextencode" in class_type.lower()


def _widget_data_texts(raw: Any) -> list[str]:
    """Extract category values from a prompt-organizer ``widget_data`` JSON blob."""
    if not isinstance(raw, str) or not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    categories = data.get("categories")
    if not isinstance(categories, dict):
        return []
    order = data.get("categoryOrder")
    names = (
        [name for name in order if isinstance(name, str) and name in categories]
        if isinstance(order, list)
        else list(categories)
    )
    texts: list[str] = []
    for name in names:
        entry = categories[name]
        if isinstance(entry, dict):
            value = entry.get("value")
            if isinstance(value, str) and value.strip():
                texts.append(value.strip())
    return texts


def _literal_texts(inputs: dict[str, Any], branch: str) -> list[str]:
    """Collect literal prompt strings from an unknown node reached via a text port.

    Lookup order: the sampler branch name (multi-output custom nodes commonly
    expose separate ``positive`` / ``negative`` fields), then generic text-ish
    field names, then prompt-organizer ``widget_data`` category values.
    Only string literals are considered; links and numeric widgets are ignored.
    """
    texts: list[str] = []
    for key in (branch, *_GENERIC_TEXT_KEYS):
        value = inputs.get(key)
        if isinstance(value, str) and value.strip():
            texts.append(value.strip())
    for key in ("widget_data", "widget"):
        texts.extend(_widget_data_texts(inputs.get(key)))
    seen: set[str] = set()
    unique: list[str] = []
    for text in texts:
        if text not in seen:
            seen.add(text)
            unique.append(text)
    return unique


def _workflow_output_name(workflow: Any, node_id: str, output_slot: int | None) -> str:
    """Read a UI workflow output port name without assigning meaning to slots."""
    if not isinstance(workflow, dict) or output_slot is None:
        return ""
    for node in workflow.get("nodes", []) or []:
        if not isinstance(node, dict) or str(node.get("id")) != node_id:
            continue
        outputs = node.get("outputs", []) or []
        if not isinstance(outputs, list) or not 0 <= output_slot < len(outputs):
            return ""
        output = outputs[output_slot]
        return str(output.get("name") or "") if isinstance(output, dict) else ""
    return ""


def _bus_branch_value(
    inputs: dict[str, Any],
    branch: str,
    output_name: str,
) -> Any:
    """Select a Bus input by branch/port name, never by positional slot.

    API prompt graphs only carry an upstream node/output pair.  When UI port
    metadata is present, the actual output name is used as extra evidence; the
    sampler branch name remains the canonical fallback for API-only images.
    A Bus with no matching named input is deliberately left unresolved.
    """
    desired = {branch.casefold()}
    if output_name:
        desired.add(output_name.casefold())
    for name, value in inputs.items():
        normalized = str(name).casefold()
        if normalized in desired:
            return value
    return None


def _payload(text: str, node_id: str, class_type: str, branch: str) -> dict[str, object] | None:
    text = _text(text)
    if not text:
        return None
    return prompt_payload(
        text,
        source_node_id=node_id,
        source_node_type=class_type,
        branch_label=branch,
    )


def _component_values(
    nodes: dict[str, dict[str, Any]],
    value: Any,
    *,
    depth: int,
    max_depth: int,
    visited: set[tuple[str, str]],
    branch: str,
) -> list[str]:
    if depth > max_depth:
        return []
    linked_id = _link(value)
    if linked_id is None:
        text = _text(value)
        return [text] if text else []
    state = (linked_id, branch)
    if state in visited:
        return []
    node = nodes.get(linked_id)
    if not node:
        return []
    return _resolve_node_text(
        nodes,
        linked_id,
        depth=depth,
        max_depth=max_depth,
        visited=set(visited),
        branch=branch,
    )


def _resolve_node_text(
    nodes: dict[str, dict[str, Any]],
    node_id: str,
    *,
    depth: int,
    max_depth: int,
    visited: set[tuple[str, str]],
    branch: str,
) -> list[str]:
    if depth > max_depth:
        return []
    state = (node_id, branch)
    if state in visited:
        return []
    visited.add(state)
    node = nodes.get(node_id)
    if not node:
        return []
    class_type = node.get("class_type")
    inputs = node.get("inputs")
    if not isinstance(class_type, str) or not isinstance(inputs, dict):
        return []
    if class_type == "BNK_CLIPTextEncodeSDXLAdvanced":
        left = _component_values(nodes, inputs.get("text_l"), depth=depth + 1, max_depth=max_depth, visited=set(visited), branch=branch)
        right = _component_values(nodes, inputs.get("text_g"), depth=depth + 1, max_depth=max_depth, visited=set(visited), branch=branch)
        return ["\n\n".join(left + right)] if left + right else []
    if class_type in _PLAIN_TEXT_TYPES:
        text = _text(inputs.get("text"))
        return [text] if text else []
    if class_type in _CONCAT_FIELDS:
        chunks: list[str] = []
        for field in _CONCAT_FIELDS[class_type]:
            chunks.extend(_component_values(nodes, inputs.get(field), depth=depth + 1, max_depth=max_depth, visited=set(visited), branch=branch))
        delimiter = inputs.get(_CONCAT_DELIMITER_KEYS.get(class_type, "delimiter"))
        delimiter = delimiter if isinstance(delimiter, str) else ""
        return [delimiter.join(chunks)] if chunks else []
    if class_type == "Text to Conditioning":
        return _component_values(nodes, inputs.get("text"), depth=depth + 1, max_depth=max_depth, visited=set(visited), branch=branch)
    # 未知节点作为 text 组件连入时,按分支名/通用文本字段/组织器 widget_data 提取字面量
    texts = _literal_texts(inputs, branch)
    if texts:
        return [", ".join(texts)]
    return []


def recover_text(
    graph: dict[str, object],
    node_id: str,
    *,
    branch: str,
    max_depth: int = 16,
    output_slot: int | None = None,
    workflow: dict[str, object] | None = None,
) -> list[dict[str, object]]:
    """Recover prompt text by safely traversing a ComfyUI prompt graph.

    Traversal follows known text/conditioning passthrough ports and named Bus
    ports.  A Bus output is matched to its named input (or the sampler branch),
    never to a globally assumed slot.  A visited ``(node_id, branch)`` set
    prevents cycles, and ``max_depth`` keeps malformed graphs bounded.
    Non-string and empty text values are ignored.
    """
    nodes = _normalise_graph(graph)
    if not nodes or not isinstance(node_id, (str, int)) or isinstance(node_id, bool):
        return []
    if not isinstance(max_depth, int) or isinstance(max_depth, bool) or max_depth < 0:
        return []
    branch = str(branch)
    results: list[dict[str, object]] = []
    visited: set[tuple[str, str]] = set()

    def visit(current_id: str, depth: int, via_text_link: bool = False) -> None:
        if depth > max_depth:
            return
        state = (current_id, branch)
        if state in visited:
            return
        visited.add(state)
        node = nodes.get(current_id)
        if not node:
            return
        class_type = node.get("class_type")
        if not isinstance(class_type, str):
            return
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            return

        candidates: list[tuple[str, Any]] = []
        if class_type == "BNK_CLIPTextEncodeAdvanced":
            candidates.append(("text", inputs.get("text")))
        elif class_type in {"BNK_CLIPTextEncodeSDXLAdvanced", *_CONCAT_FIELDS}:
            resolved = _resolve_node_text(
                nodes,
                current_id,
                depth=depth,
                max_depth=max_depth,
                visited=set(visited) - {(current_id, branch)},
                branch=branch,
            )
            if resolved:
                candidates.append(("resolved", resolved[0]))
        elif class_type in _PLAIN_TEXT_TYPES or _is_clip_text_encoder(class_type):
            candidates.append(("text", inputs.get("text")))

        for _, value in candidates:
            item = _payload(value, current_id, class_type, branch)
            if item is not None:
                results.append(item)
                return

        # 经 text 端口连入的未知节点:按分支名/通用文本字段/组织器 widget_data 提取字面量
        if via_text_link:
            texts = _literal_texts(inputs, branch)
            if texts:
                item = _payload(", ".join(texts), current_id, class_type, branch)
                if item is not None:
                    results.append(item)
                    return

        next_values: list[tuple[Any, bool]] = []
        if "bus" in class_type.lower():
            selected = _bus_branch_value(
                inputs,
                branch,
                _workflow_output_name(workflow, current_id, output_slot if depth == 0 else None),
            )
            if selected is not None:
                next_values.append((selected, False))
        elif branch in inputs and "sampler" in class_type.lower():
            next_values.append((inputs.get(branch), False))
        elif class_type == "ImpactSwitch":
            selected = inputs.get("select")
            if isinstance(selected, int) and not isinstance(selected, bool):
                next_values.append((inputs.get(f"input{selected}"), False))
            elif isinstance(selected, str):
                try:
                    next_values.append((inputs.get(f"input{int(selected)}"), False))
                except ValueError:
                    pass
        elif class_type == "ImpactWildcardEncode":
            populated = _text(inputs.get("populated_text"))
            wildcard = _text(inputs.get("wildcard_text"))
            selected_text = populated or wildcard
            if selected_text:
                item = _payload(selected_text, current_id, class_type, branch)
                if item is not None:
                    results.append(item)
                    return
            next_values.append((inputs.get("conditioning"), False))
        elif class_type == "WeiLinPromptUI":
            next_values.append((inputs.get("opt_text"), False))
        elif class_type == "ReferenceLatent":
            next_values.append((inputs.get("conditioning"), False))
        elif class_type.lower().startswith("context big"):
            next_values.append((inputs.get("base_ctx"), False))
        elif "guider" in inputs:
            # SamplerCustomAdvanced 等经 guider 携带 conditioning 分支
            next_values.append((inputs.get("guider"), False))
        elif branch in inputs and _link(inputs.get(branch)) is not None:
            # CFGGuider 等分支持有节点:按分支名沿连线追溯(仅连线值,避免误吞字面量控件)
            next_values.append((inputs.get(branch), False))
        elif class_type == "Text to Conditioning":
            next_values.append((inputs.get("text"), True))
        elif class_type in {"ConditioningCombine", "ConditioningConcat"}:
            # A single sampler branch may be assembled from several prompt
            # encoders.  Follow every conditioning input so replay editing and
            # safety filtering can see all contributing text nodes.
            for input_name, input_value in inputs.items():
                if input_name.startswith("conditioning") and _link(input_value) is not None:
                    next_values.append((input_value, False))
        elif class_type in _PLAIN_TEXT_TYPES or _is_clip_text_encoder(class_type):
            # text 为连线(非字面量)时,继续沿 text 端口向上游追溯
            text_value = inputs.get("text")
            if _link(text_value) is not None:
                next_values.append((text_value, True))
        elif "conditioning" in inputs and class_type not in _CONDITIONING_TERMINATORS:
            # 未知节点的 conditioning 透传;ZeroOut 等清空型节点视为空条件终止
            conditioning = inputs.get("conditioning")
            if _link(conditioning) is not None:
                next_values.append((conditioning, False))

        route_link_only = class_type in {
            "ImpactWildcardEncode",
            "ReferenceLatent",
        } or class_type.lower().startswith("context big")
        for value, via_text in next_values:
            linked_id = _link(value)
            if linked_id is not None:
                visit(linked_id, depth + 1, via_text_link=via_text)
            elif not route_link_only:
                item = _payload(value, current_id, class_type, branch)
                if item is not None:
                    results.append(item)

    visit(str(node_id), 0)

    deduped: list[dict[str, object]] = []
    seen: set[tuple[str, str]] = set()
    for item in results:
        signature = (str(item.get("source_node_id", "")), str(item.get("text", "")))
        if signature not in seen:
            seen.add(signature)
            deduped.append(item)
    return deduped


def _sampler_nodes(graph: dict[str, dict[str, Any]]) -> list[tuple[str, dict[str, Any]]]:
    samplers: list[tuple[str, dict[str, Any]]] = []
    for node_id, node in graph.items():
        class_type = node.get("class_type")
        inputs = node.get("inputs")
        if not isinstance(class_type, str) or not isinstance(inputs, dict):
            continue
        lowered = class_type.lower()
        # guider(CFGGuider 等)同样持 positive/negative conditioning,作为恢复起点
        if ("sampler" in lowered or "guider" in lowered) and (
            "positive" in inputs or "negative" in inputs
        ):
            samplers.append((node_id, node))
    return samplers


def _is_link_literal_entry(entry: object) -> bool:
    if not isinstance(entry, dict):
        return False
    return _LINK_LITERAL_RE.match(str(entry.get("text") or "")) is not None


def _strip_link_literal_prompts(prompts: dict[str, Any]) -> bool:
    """Remove prompt entries polluted by stringified link values (e.g. ``"['41', 0]"``).

    parser.py serialises linked ``text`` inputs of CLIPTextEncode-like nodes
    into their ``str()`` form; such entries carry no prompt text.  Stripping
    happens in-place across positive/negative and by_sampler groups.
    """
    removed = False
    for key in ("positive", "negative"):
        entries = prompts.get(key)
        if not isinstance(entries, list):
            continue
        kept = [entry for entry in entries if not _is_link_literal_entry(entry)]
        if len(kept) != len(entries):
            prompts[key] = kept
            removed = True
    by_sampler = prompts.get("by_sampler")
    if isinstance(by_sampler, list):
        for group in by_sampler:
            if not isinstance(group, dict):
                continue
            for key in ("positive", "negative"):
                entries = group.get(key)
                if not isinstance(entries, list):
                    continue
                kept = [entry for entry in entries if not _is_link_literal_entry(entry)]
                if len(kept) != len(entries):
                    group[key] = kept
                    removed = True
    return removed


def apply(record: dict[str, object]) -> dict[str, object]:
    """Fill missing prompt lists from a local parsed ComfyUI graph only."""
    try:
        metadata = record.get("metadata")
        if not isinstance(metadata, dict):
            return record
        prompts = record.get("prompts")
        if not isinstance(prompts, dict):
            return record
        sanitized = _strip_link_literal_prompts(prompts)
        raw_prompt = metadata.get("raw_prompt")
        if isinstance(raw_prompt, str):
            try:
                raw_prompt = json.loads(raw_prompt)
            except (TypeError, ValueError, json.JSONDecodeError):
                raw_prompt = None
        graph = _normalise_graph(raw_prompt)
        if not graph:
            if sanitized:
                prompts["search_text"] = build_prompt_search_text(
                    prompts.get("positive") or [], prompts.get("negative") or []
                )
            return record
        positive = prompts.get("positive")
        negative = prompts.get("negative")
        if not isinstance(positive, list):
            positive = []
            prompts["positive"] = positive
        if not isinstance(negative, list):
            negative = []
            prompts["negative"] = negative

        missing = {"positive": not positive, "negative": not negative}
        if not any(missing.values()):
            if sanitized:
                prompts["search_text"] = build_prompt_search_text(positive, negative)
            return record
        recovered: dict[str, list[dict[str, object]]] = {"positive": [], "negative": []}
        seen: set[tuple[str, str, str]] = set()
        for _, sampler in _sampler_nodes(graph):
            sampler_inputs = sampler.get("inputs", {})
            for branch in ("positive", "negative"):
                if not missing[branch]:
                    continue
                linked_id = _link(sampler_inputs.get(branch))
                if linked_id is None:
                    continue
                link_value = sampler_inputs.get(branch)
                output_slot = None
                if isinstance(link_value, (list, tuple)) and len(link_value) >= 2:
                    try:
                        output_slot = int(link_value[1])
                    except (TypeError, ValueError):
                        pass
                raw_workflow = metadata.get("raw_workflow")
                if isinstance(raw_workflow, str):
                    try:
                        raw_workflow = json.loads(raw_workflow)
                    except (TypeError, ValueError, json.JSONDecodeError):
                        raw_workflow = None
                for item in recover_text(
                    graph,
                    linked_id,
                    branch=branch,
                    output_slot=output_slot,
                    workflow=raw_workflow if isinstance(raw_workflow, dict) else None,
                ):
                    signature = (
                        str(item.get("text", "")),
                        str(item.get("source_node_id", "")),
                        branch,
                    )
                    if signature not in seen:
                        seen.add(signature)
                        recovered[branch].append(item)

        for branch in ("positive", "negative"):
            if missing[branch] and recovered[branch]:
                prompts[branch].extend(recovered[branch])
        if sanitized or recovered["positive"] or recovered["negative"]:
            prompts["search_text"] = build_prompt_search_text(
                prompts["positive"], prompts["negative"]
            )
        return record
    except Exception:
        return record
