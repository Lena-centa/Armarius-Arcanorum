"""sampler_view.py — sampler 中心派生层(Phase 3 前置)。

从 raw_prompt(API prompt 图)构建以 sampler 为根的可编辑视图,
供 comfy_replay.build_replay_source 的 editable 复用,消解双套解析。

设计契约:docs/parser/KNOWN_GAPS.md §3.2
PoC 验证:nest_gateway/scripts/sampler_centric_probe*.py

核心策略(脱离 class_type/field 名字面量):
  1. 根识别 — 拓扑签名优先(input 含 model+positive+negative+latent/image),
     hint fallback(覆盖标准 KSampler 命名)
  2. 链追溯 — 全连通 BFS,角色由起始 input 的语义(field 名)决定,
     沿每个节点所有 link input 向上游追溯,确保 VAE/CLIP 等旁路不丢
  3. 未知节点降级 — 链上未知 class_type 按所在链角色展示,保留可编辑性

不动 parser.py,不改 record schema,不碰 Mongo。
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from workflow_db.comfyui_recovery import recover_text
from workflow_db.workflow_ir import normalize_link


LORA_STRENGTH_STEP = 0.05
LORA_STRENGTH_EPSILON = 1e-9


def normalize_lora_strength(value: Any) -> Any:
    """Normalize display strengths without depending on frozen parser.py."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return value
    snapped = round(value / LORA_STRENGTH_STEP) * LORA_STRENGTH_STEP
    if abs(value - snapped) > LORA_STRENGTH_EPSILON:
        return value
    return round(snapped, 10)

# 根识别:拓扑签名的输入名集合(覆盖标准 + 聚合节点命名)
MODEL_INPUTS = {"model", "model_bundle", "model_"}
POSITIVE_INPUTS = {"positive"}
NEGATIVE_INPUTS = {"negative"}
LATENT_INPUTS = {"latent_image", "source_image", "image", "latent", "latents"}

SAMPLER_HINTS = ("ksampler", "sampler")

# LoRA 节点类型(链上识别用,非硬编码遍历)
LORA_NODE_TYPES = {
    "LoraLoader",
    "LoraLoaderModelOnly",
    "CreateHookLora",
    "LoRA Stacker",
    "Lora Loader Stack (rgthree)",
    "Power Lora Loader (rgthree)",
    "Power Lora Loader",
}

# Model loader 节点类型
MODEL_LOADER_FIELDS = {"ckpt_name", "unet_name", "model_name"}
VAE_LOADER_FIELDS = {"vae_name"}
CLIP_LOADER_FIELDS = {"clip_name"}

# class_type → 角色(由节点产出语义定,稳定,不依赖路径)
# 印证"工作流是图":角色由节点本身是什么决定,不由从哪条边到达决定
CLASS_TYPE_ROLE = {
    "checkpointloadersimple": "model",
    "unetloader": "model",
    "loraloader": "model",
    "loraloadermodelonly": "model",
    "createhooklora": "model",
    "lora stacker": "model",
    "power lora loader (rgthree)": "model",
    "power lora loader": "model",
    "cliptextencode": "prompt",
    "text multiline": "prompt",
    "text concatenate": "prompt",
    "text to conditioning": "prompt",
    "text prompt (jps)": "prompt",
    "text concatenate (jps)": "prompt",
    "cr text concatenate": "prompt",
    "emptylatentimage": "latent",
    "loadimage": "latent",
    "vaeloader": "post",
    "vaedecode": "post",
    "vaeencode": "post",
}
# 透明中转节点:图遍历穿过,不归角色桶(guider/pipe/scheduler/reroute 等打包机制)
TRANSPARENT_HINTS = (
    "guider", "sigmas", "scheduler", "pipe", "tobasicpipe",
    "frombasicpipe", "basicpipe", "sampler", "reroute",
)

# ControlNet apply/loader 识别(宽容子串匹配,覆盖官方 + ACN 插件变体)
# 官方:ControlNetApply(DEPRECATED)/ControlNetApplyAdvanced/ControlNetApplySD3/
#   ControlNetInpaintingAliMamaApply/ControlNetLoader/DiffControlNetLoader
# ACN 插件:ACN_AdvancedControlNetApply*/ACN_ControlNetLoaderAdvanced 等
CONTROLNET_APPLY_LOADER_FIELDS = {
    "control_net_name": "control_net_name",
    "control_net": "control_net_name",
    "cn_name": "control_net_name",
}


def _is_controlnet_apply(ct: str) -> bool:
    c = ct.lower()
    return ("controlnet" in c or c.startswith("acn_")) and "apply" in c


def _is_controlnet_loader(ct: str) -> bool:
    c = ct.lower()
    return ("controlnet" in c or c.startswith("acn_")) and "loader" in c


def _role_from_class_type(ct: str) -> str | None:
    """节点角色由 class_type 产出语义定(精确优先,fallback 模糊)。"""
    c = ct.lower()
    # 新版 blueprints 模板外部端口(转换器生成的占位节点):透明穿过
    if c.startswith("__blueprint_") or c == "__external_node":
        return "transparent"
    if c in CLASS_TYPE_ROLE:
        return CLASS_TYPE_ROLE[c]
    if any(k in c for k in TRANSPARENT_HINTS):
        return "transparent"
    if ("checkpoint" in c or "unet" in c) and "loader" in c:
        return "model"
    if ("lora" in c and "loader" in c) or ("lora" in c and "stack" in c):
        return "model"
    if any(k in c for k in ("cliptext", "text ", "conditioning", "attention")):
        return "prompt"
    if "vae" in c:
        return "post"
    if "latent" in c or "loadimage" in c:
        return "latent"
    if "clip" in c and "loader" in c:
        return "clip"
    return None


def find_sampler_roots(prompt: dict[str, Any]) -> list[tuple[str, str]]:
    """识别 sampler 根节点(生成核心)。

    拓扑签名优先:input 含 model(+positive+negative+latent/image)。
    hint fallback:class_type 含 ksampler/sampler(排除 Sampler Selector /
    KSamplerSelect 纯选择器),并要求正/负 conditioning 输入——过滤名字含
    "sampler" 的非执行器(LTXVLatentUpsampler 等 latent 上采样)。

    覆盖聚合节点:KSampler (Efficient)(hint)与 UmeAiRT_VideoGenerator
    (拓扑签名,名字不含 sampler)都能识别。
    """
    roots: list[tuple[str, str]] = []
    for nid, node in prompt.items():
        if not isinstance(node, dict):
            continue
        ct = str(node.get("class_type", ""))
        inputs = node.get("inputs", {}) or {}
        in_names = set(inputs.keys())

        # hint 路径(标准命名);排除纯选择器与无 conditioning 输入的非执行器。
        # Flux 打包形态(SamplerCustomAdvanced 经 guider 包 positive/negative/model)
        # 以 guider+latent_image 判定(契约 §3.2:guider 透明穿过,不需特化解包)
        has_pos = bool(in_names & POSITIVE_INPUTS) or any(
            "positive" in n.lower() for n in in_names
        )
        has_neg = bool(in_names & NEGATIVE_INPUTS) or any(
            "negative" in n.lower() for n in in_names
        )
        has_flux_bundle = bool(
            {"guider", "noise"} & in_names
            and in_names & LATENT_INPUTS
        )
        if (
            any(h in ct.lower() for h in SAMPLER_HINTS)
            and ct != "Sampler Selector"
            and ct != "KSamplerSelect"
            and (has_pos or has_neg or has_flux_bundle)
        ):
            roots.append((str(nid), ct))
            continue

        # 拓扑签名路径(宏节点封装)
        has_model = bool(in_names & MODEL_INPUTS) or any(
            "model" in n.lower() for n in in_names
        )
        has_latent = bool(in_names & LATENT_INPUTS) or any(
            n.lower() in LATENT_INPUTS
            or "latent" in n.lower()
            or "image" in n.lower()
            for n in in_names
        )
        if has_model and has_pos and has_neg and has_latent:
            roots.append((str(nid), ct))
    return roots


def classify_input(field_name: str) -> str | None:
    """input field 名 → 语义角色(model/positive/negative/latent)。

    link type 优先级:API prompt 图无 link type,用 field 名推断。
    field 名含 model/positive/negative/latent/image 子串即归对应角色。
    """
    fn = field_name.lower()
    if "model" in fn:
        return "model"
    if "positive" in fn or fn == "pos":
        return "positive"
    if "negative" in fn or fn == "neg":
        return "negative"
    if "latent" in fn or "image" in fn and "images" not in fn:
        return "latent"
    return None


def trace_chain(
    prompt: dict[str, Any],
    start_id: str,
    role: str,
    visited: set[str] | None = None,
) -> list[dict[str, Any]]:
    """从 start_id 的所有 link input 全连通 BFS,角色标注。

    沿每个节点所有 link input 向上游追溯(不只单一 field),确保
    VAE/CLIP 等旁路节点被纳入。visited 跨角色共享,防环 + 防重复。
    """
    if visited is None:
        visited = set()

    chain: list[dict[str, Any]] = []
    node = prompt.get(start_id)
    if not isinstance(node, dict):
        return chain

    queue: list[tuple[str, str, str]] = []  # (node_id, role, via_field)
    for fname, val in (node.get("inputs", {}) or {}).items():
        link = normalize_link(val)
        if link and link[0] not in visited:
            queue.append((link[0], role, fname))

    while queue:
        nid, cur_role, via = queue.pop(0)
        if nid in visited:
            continue
        visited.add(nid)
        n = prompt.get(nid)
        if not isinstance(n, dict):
            continue
        ct = str(n.get("class_type", ""))
        chain.append(
            {"node_id": nid, "class_type": ct, "role": cur_role, "via_field": via}
        )
        for fname, val in (n.get("inputs", {}) or {}).items():
            link = normalize_link(val)
            if link and link[0] not in visited:
                queue.append((link[0], cur_role, fname))
    return chain


def _node_input_value(prompt: dict[str, Any], node_id: str, field: str) -> Any:
    """取节点 input field 的字面量值(非连线)。"""
    node = prompt.get(node_id)
    if not isinstance(node, dict):
        return None
    val = (node.get("inputs", {}) or {}).get(field)
    link = normalize_link(val)
    if link:
        # 连线,递归取上游字面量
        return _node_input_value(prompt, link[0], field)
    return val


def extract_loras_from_chain(
    chain: list[dict[str, Any]], prompt: dict[str, Any], widgets_map: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    """从链上节点提取 LoRA(含 LoraLoader/CreateHookLora/LoRA Stacker/Power Lora Loader)。

    Power Lora Loader 的 LoRA 名/强度在 raw_workflow 的 widgets_values(不在 API prompt inputs),
    需上层传 widgets_map(从 raw_workflow.nodes 建 {node_id: widgets_values})。
    """
    loras: list[dict[str, Any]] = []
    for item in chain:
        nid = item["node_id"]
        ct = item["class_type"]
        if ct not in LORA_NODE_TYPES:
            continue
        node = prompt.get(nid)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {}) or {}

        if ct in {"LoraLoader", "LoraLoaderModelOnly", "CreateHookLora"}:
            name = _node_input_value(prompt, nid, "lora_name")
            if name and name != "None":
                loras.append(
                    {
                        "node_id": nid,
                        "source": ct,
                        "name": name,
                        "strength_model": _node_input_value(prompt, nid, "strength_model"),
                        "strength_clip": _node_input_value(prompt, nid, "strength_clip"),
                        "role": item["role"],
                    }
                )
        elif ct == "LoRA Stacker":
            count = int(inputs.get("lora_count", 0) or 0)
            for slot in range(1, max(count, 1) + 1):
                name = inputs.get(f"lora_name_{slot}")
                if name and name != "None":
                    loras.append(
                        {
                            "node_id": nid,
                            "source": ct,
                            "slot": slot,
                            "name": name,
                            "strength": inputs.get(f"lora_wt_{slot}"),
                            "strength_model": inputs.get(f"model_str_{slot}"),
                            "strength_clip": inputs.get(f"clip_str_{slot}"),
                            "role": item["role"],
                        }
                    )
        elif ct == "Lora Loader Stack (rgthree)":
            for slot in range(1, 100):
                suffix = f"{slot:02d}"
                name_field = f"lora_{suffix}"
                if name_field not in inputs:
                    break
                name = inputs.get(name_field)
                if name and name != "None":
                    strength = inputs.get(f"strength_{suffix}")
                    loras.append(
                        {
                            "node_id": nid,
                            "source": ct,
                            "slot": slot,
                            "name": name,
                            "strength": strength,
                            "strength_model": strength,
                            "strength_clip": strength,
                            "role": item["role"],
                        }
                    )
        elif ct in {"Power Lora Loader (rgthree)", "Power Lora Loader"}:
            widgets = (widgets_map or {}).get(nid, []) or []
            # Newer rgthree versions serialize each widget into API inputs;
            # older versions keep them only in workflow.widgets_values.
            if not any(isinstance(widget, dict) and widget.get("lora") for widget in widgets):
                widgets = [
                    value for key, value in inputs.items()
                    if str(key).startswith("lora_") and isinstance(value, dict)
                ]
            for slot, widget in enumerate(widgets, start=1):
                if not isinstance(widget, dict):
                    continue
                lora_name = widget.get("lora")
                if not lora_name or lora_name == "None":
                    continue
                enabled = widget.get("on", True)
                if enabled in (False, 0, "0", "false", "False"):
                    continue
                strength = widget.get("strength")
                strength_two = widget.get("strengthTwo")
                loras.append(
                    {
                        "node_id": nid,
                        "source": ct,
                        "slot": slot,
                        "enabled": True,
                        "name": lora_name,
                        "strength": normalize_lora_strength(strength),
                        "strength_model": normalize_lora_strength(strength),
                        "strength_clip": (
                            normalize_lora_strength(strength)
                            if strength_two in (None, "")
                            else normalize_lora_strength(strength_two)
                        ),
                        "role": item["role"],
                    }
                )
    return loras


def extract_loaders_from_chain(
    chain: list[dict[str, Any]], prompt: dict[str, Any]
) -> list[dict[str, Any]]:
    """从链上节点提取 model/vae/clip loader。"""
    loaders: list[dict[str, Any]] = []
    for item in chain:
        nid = item["node_id"]
        node = prompt.get(nid)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {}) or {}
        for field in MODEL_LOADER_FIELDS:
            val = _node_input_value(prompt, nid, field)
            if val and val != "None":
                loaders.append(
                    {"node_id": nid, "class_type": item["class_type"], "field": field, "value": val, "role": item["role"]}
                )
        for field in VAE_LOADER_FIELDS:
            val = _node_input_value(prompt, nid, field)
            if val and val != "None":
                loaders.append(
                    {"node_id": nid, "class_type": item["class_type"], "field": field, "value": val, "role": item["role"], "kind": "vae"}
                )
        for field in CLIP_LOADER_FIELDS:
            val = _node_input_value(prompt, nid, field)
            if val and val != "None":
                loaders.append(
                    {"node_id": nid, "class_type": item["class_type"], "field": field, "value": val, "role": item["role"], "kind": "clip"}
                )
    return loaders


def _reverse_reach(
    prompt: dict[str, Any], start_id: str, start_field: str
) -> dict[str, set[int]]:
    """从 (start_id, start_field) 沿输入边反向 BFS。

    返回 {node_id: {output_slot, ...}}:node_id 的哪些输出槽位于
    start_field 的上游链上。slot 即该节点被下游消费的输出编号,
    是"极性"判定的精确依据(不依赖 class_type 分支表)。
    """
    reach: dict[str, set[int]] = {}
    queue: list[tuple[str, str]] = [(start_id, start_field)]
    while queue:
        nid, field = queue.pop(0)
        node = prompt.get(nid)
        if not isinstance(node, dict):
            continue
        for fname, val in (node.get("inputs", {}) or {}).items():
            link = normalize_link(val)
            if not link:
                continue
            src, slot = link
            if src in reach and slot in reach[src]:
                continue
            reach.setdefault(src, set()).add(slot)
            queue.append((src, fname))
    return reach


def _controlnet_name_from_loader(
    prompt: dict[str, Any], loader_id: str
) -> str | None:
    """从 loader 节点读 control_net_name(宽容字段表,字面量非 None 才收录)。"""
    node = prompt.get(loader_id)
    if not isinstance(node, dict):
        return None
    inputs = node.get("inputs", {}) or {}
    for field in CONTROLNET_APPLY_LOADER_FIELDS:
        val = _node_input_value(prompt, loader_id, field)
        if val and str(val) != "None":
            return str(val)
    return None


def extract_controlnets_from_chain(
    prompt: dict[str, Any],
    sampler_id: str,
    sampler_params: dict[str, Any],
    chain_nodes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """从链上节点提取 ControlNet(apply + loader 溯源 + 极性 + steps 绑定)。

    依据 docs/parser/KNOWN_GAPS.md §3.1 与派生层契约:
      - apply 节点:class_type 宽容匹配(官方 + ACN 变体)
      - loader 溯源:沿 apply.control_net 连线定位 loader,读 control_net_name
      - 极性:反向 BFS 定"apply 输出槽是否在 sampler 正/负链上"
        (slot0→positive 链、slot1→negative 链;双链均在 → both)
      - steps 绑定:join sampler 参数,effective_start_step=round(steps*start_percent)
    """
    sampler_polarity: dict[str, str] = {}  # apply_id -> polarity 占位
    pos_reach = _reverse_reach(prompt, sampler_id, "positive")
    neg_reach = _reverse_reach(prompt, sampler_id, "negative")
    steps = sampler_params.get("steps")

    items: list[dict[str, Any]] = []
    for item in chain_nodes:
        if not _is_controlnet_apply(item["class_type"]):
            continue
        nid = item["node_id"]
        node = prompt.get(nid)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {}) or {}

        in_pos = nid in pos_reach
        in_neg = nid in neg_reach
        if not in_pos and not in_neg:
            continue  # apply 不在该 sampler 链上(可能服务于其他 sampler)

        # 极性:双输出槽分别判定(slot0=positive 输出,slot1=negative 输出)
        pos_slots = pos_reach.get(nid, set())
        neg_slots = neg_reach.get(nid, set())
        has_pos_link = bool(pos_slots & {0}) or (bool(pos_slots) and not neg_slots)
        has_neg_link = bool(neg_slots & {1}) or (bool(neg_slots) and not pos_slots)
        if has_pos_link and has_neg_link:
            polarity = "both"
        elif has_pos_link:
            polarity = "positive"
        elif has_neg_link:
            polarity = "negative"
        else:
            continue

        # loader 溯源
        loader_id: str | None = None
        loader_ct: str | None = None
        loader_model_source: str | None = None
        control_link = normalize_link(inputs.get("control_net"))
        if control_link:
            loader_node = prompt.get(control_link[0])
            if isinstance(loader_node, dict) and _is_controlnet_loader(
                str(loader_node.get("class_type", ""))
            ):
                loader_id = control_link[0]
                loader_ct = str(loader_node.get("class_type", ""))

        # DiffControlNetLoader 的 model 输入链溯源到具体 checkpoint
        # (解决"refiner 阶段换了模型 + 换 controlnet"的归属问题)
        if loader_id:
            loader_node = prompt.get(loader_id)
            if isinstance(loader_node, dict):
                model_link = normalize_link(
                    (loader_node.get("inputs", {}) or {}).get("model")
                )
                if model_link:
                    model_node = prompt.get(model_link[0])
                    if isinstance(model_node, dict):
                        mct = str(model_node.get("class_type", ""))
                        mname = _node_input_value(prompt, model_link[0], "ckpt_name")
                        if mname:
                            loader_model_source = str(mname)
                        elif mname is None:
                            # 经 LoRA 链中转时继续向上找 checkpoint
                            depth = 0
                            cur = model_link[0]
                            while depth < 6:
                                mn = prompt.get(cur)
                                if not isinstance(mn, dict):
                                    break
                                cand = _node_input_value(prompt, cur, "ckpt_name")
                                if cand:
                                    loader_model_source = str(cand)
                                    break
                                up = normalize_link(
                                    (mn.get("inputs", {}) or {}).get("model")
                                )
                                if not up:
                                    break
                                cur = up[0]
                                depth += 1

        name = ""
        if loader_id:
            name = _controlnet_name_from_loader(prompt, loader_id) or ""

        entry: dict[str, Any] = {
            "apply_node_id": nid,
            "apply_type": item["class_type"],
            "loader_node_id": loader_id,
            "loader_type": loader_ct,
            "control_net_name": name,
            "loader_model_source": loader_model_source,
            "strength": inputs.get("strength"),
            "start_percent": inputs.get("start_percent"),
            "end_percent": inputs.get("end_percent"),
            "bindings": [
                {
                    "sampler_id": sampler_id,
                    "polarity": polarity,
                    "steps": steps,
                    "effective_start_step": (
                        round(steps * float(inputs.get("start_percent", 0) or 0))
                        if steps is not None
                        and inputs.get("start_percent") is not None
                        else None
                    ),
                    "effective_end_step": (
                        round(steps * float(inputs.get("end_percent", 1) or 1))
                        if steps is not None and inputs.get("end_percent") is not None
                        else None
                    ),
                }
            ],
        }
        items.append(entry)
    return items


def extract_bypassed_controlnets_from_workflow(
    raw_workflow: dict[str, Any],
) -> list[dict[str, Any]]:
    """UI workflow 兜底:被 bypass(mode∈{2,4})的 ControlNet 节点。

    bypass 节点不注入 API prompt(不生效),但前端应灰显展示。名称从
    widgets_values 读取(loader 第一个 widget 即 control_net_name)。
    """
    items: list[dict[str, Any]] = []
    nodes = raw_workflow.get("nodes", []) or []
    for wn in nodes:
        if not isinstance(wn, dict):
            continue
        mode = wn.get("mode")
        if mode not in (2, 4):
            continue
        wtype = str(wn.get("type", ""))
        if not (_is_controlnet_apply(wtype) or _is_controlnet_loader(wtype)):
            continue
        widgets = wn.get("widgets_values") or []
        name = ""
        if isinstance(widgets, list) and widgets and isinstance(widgets[0], str):
            name = widgets[0]
        items.append(
            {
                "apply_node_id": None,
                "loader_node_id": str(wn.get("id")),
                "loader_type": wtype,
                "control_net_name": name,
                "strength": None,
                "start_percent": None,
                "end_percent": None,
                "bypassed": True,
                "bindings": [],
            }
        )
    return items


# ---------------------------------------------------------------------------
# 区域 prompt + 蒙版解析(派生层)
# ---------------------------------------------------------------------------

REGION_NODE_HINTS = (
    "attentioncoupleregion",          # A8R8 插件:单区域节点 {cond, mask, weight}
    "attentioncouple",                # 聚合节点 {base_prompt, regions}
    "conditioning_set_area",          # 官方 ConditioningSetArea 三兄弟
    "conditioningsetmask",            # 官方 {conditioning, mask, strength}
    "conditioningsetproperties",      # 区域属性节点 {conditioning, mask, ...}(0330 样本实证)
    "regionalconditioning",           # Inspire: RegionalConditioningSimple //Inspire
    "regionalprompt",                 # Inspire: RegionalPromptSimple //Inspire
)

# 蒙版链语义终点:LoadImage 槽1(MASK 输出)/SolidMask/ImageToMask
MASK_SOURCE_HINTS = ("loadimage", "solidmask", "imagetomask")

# 蒙版关键参数(值非 None 才收录)
MASK_PARAM_FIELDS = ("expand", "blur_radius", "strength", "set_cond_area", "incremental_expandrate")


def _is_region_node(ct: str) -> bool:
    return any(h in ct.lower() for h in REGION_NODE_HINTS)


def _is_mask_chain_node(ct: str) -> bool:
    c = ct.lower()
    return (
        "mask" in c and any(h in c for h in ("grow", "blur", "feather", "solid", "toimage", "invert"))
    ) or any(h in c for h in MASK_SOURCE_HINTS)


def extract_region_views(
    prompt: dict[str, Any],
    sampler_id: str,
    chain_nodes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """从链上节点提取区域 prompt 视图(区域节点 + cond 上游文本 + mask 链)。

    蒙版链:从区域节点 mask 输入出发沿输入边追溯,记录关键参数
    (expand/blur_radius/strength 等)与终点(LoadImage MASK 槽/SolidMask 等),
    不解析像素。文本取自 cond 上游 CLIPTextEncode 等。

    kind 分层:聚合节点(AttentionCouple/AttentionCoupleRegions/... )标 container,
    不收集 cond 全文(其文本与叶子节点重复);实际区域节点标 leaf,保留完整
    cond 文本 + mask 链。跨条目相同 cond 文本去重(同一上游链只展示一次)。
    """
    # 聚合/容器节点:不收集 cond 全文(文本与叶子重复,仅保留结构/参数)
    CONTAINER_REGION_TYPES = {
        "AttentionCouple",
        "AttentionCoupleRegions",
        "ConditioningSetPropertiesAndCombine",
    }
    regions: list[dict[str, Any]] = []
    region_node_ids: set[str] = set()
    seen_cond_texts: set[str] = set()
    for item in chain_nodes:
        if not _is_region_node(item["class_type"]):
            continue
        nid = item["node_id"]
        if nid in region_node_ids:
            continue
        region_node_ids.add(nid)
        node = prompt.get(nid)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {}) or {}
        ct = item["class_type"]
        kind = "container" if ct in CONTAINER_REGION_TYPES else "leaf"

        # cond 上游文本(仅叶子节点收集;容器仅结构展示)
        cond_values: list[str] = []
        if kind == "leaf":
            for field in ("cond", "conditioning", "base_prompt", "regions", "region_"):
                if field == "region_":
                    for key in sorted(inputs):
                        if key.startswith("region_"):
                            cond_values.append(_collect_region_text(prompt, inputs.get(key)))
                    continue
                if field in inputs:
                    cond_values.append(_collect_region_text(prompt, inputs.get(field)))
        # 跨条目去重:同一上游文本链只展示一次
        cond_texts: list[str] = []
        for t in cond_values:
            if t.strip() and t not in seen_cond_texts:
                seen_cond_texts.add(t)
                cond_texts.append(t)

        # 字面量参数
        params: dict[str, Any] = {}
        for field in ("weight", "strength", "width", "height", "x", "y", "global_prompt_weight", "set_cond_area"):
            val = inputs.get(field)
            if val is not None and not _is_link_value(val):
                params[field] = val

        # mask 链(仅叶子收集;容器无 mask 输入)
        mask_chain = _extract_mask_chain(prompt, inputs.get("mask")) if kind == "leaf" else None

        regions.append(
            {
                "node_id": nid,
                "node_type": ct,
                "kind": kind,
                "sampler_id": sampler_id,
                "cond_texts": cond_texts,
                "params": params,
                "mask": mask_chain,
            }
        )
    return regions


def _collect_region_text(prompt: dict[str, Any], value: Any, depth: int = 0) -> str:
    """沿区域 cond 链收集文本(CLIPTextEncode 等文本节点)。"""
    if depth > 10:
        return ""
    link = normalize_link(value)
    if not link:
        return str(value or "") if isinstance(value, str) else ""
    node = prompt.get(link[0])
    if not isinstance(node, dict):
        return ""
    inputs = node.get("inputs", {}) or {}
    ct = str(node.get("class_type", ""))
    if ct in {"CLIPTextEncode", "Text Multiline", "CR Text"}:
        return str(inputs.get("text", "") or "")
    if ct == "Text to Conditioning":
        return _collect_region_text(prompt, inputs.get("text"), depth + 1)
    if ct in {"Text Concatenate", "Text Concatenate (JPS)", "CR Text Concatenate"}:
        resolved = _resolve_value(prompt, [link[0], 0])
        return str(resolved or "") if isinstance(resolved, str) else ""
    if ct == "Reroute":
        if inputs:
            return _collect_region_text(prompt, inputs[next(iter(inputs))], depth + 1)
        return ""
    # 其他 conditioning 中继(Combine/SetMask/SetArea/Inspire 等)沿语义输入继续
    for field in ("conditioning_1", "conditioning_2", "conditioning_to", "conditioning_from",
                  "conditioning", "cond", "cond_NEW", "base_prompt", "positive", "negative"):
        if field in inputs:
            resolved = _collect_region_text(prompt, inputs.get(field), depth + 1)
            if resolved.strip():
                return resolved
    return ""


def _extract_mask_chain(
    prompt: dict[str, Any], mask_value: Any, depth: int = 0
) -> dict[str, Any] | None:
    """追溯 mask 来源链:节点列表 + 关键参数 + 终点(MASK 源)。

    返回 {nodes: [{node_id, class_type, params}], source: 终点节点, slot: 输出槽}
    不解析像素,仅拓扑 + 参数。
    """
    if depth > 10:
        return None
    link = normalize_link(mask_value)
    if not link:
        return None
    nid, slot = link
    node = prompt.get(nid)
    if not isinstance(node, dict):
        return None
    inputs = node.get("inputs", {}) or {}
    ct = str(node.get("class_type", ""))

    params: dict[str, Any] = {}
    for field in MASK_PARAM_FIELDS:
        val = inputs.get(field)
        if val is not None and not _is_link_value(val):
            params[field] = val

    if _is_mask_chain_node(ct):
        entry = {"node_id": nid, "class_type": ct, "params": params}
        # 继续追溯该节点的 mask/图像输入
        sub = None
        for field in ("mask", "image", "images", "input_image"):
            if field in inputs:
                sub = _extract_mask_chain(prompt, inputs.get(field), depth + 1)
                if sub:
                    break
        if sub:
            return {"nodes": [entry, *sub["nodes"]], "source": sub["source"], "slot": sub["slot"]}
        return {"nodes": [entry], "source": nid, "slot": slot}

    # 终点:非 mask 链节点(如 LoadImage 的 MASK 槽或未知节点)
    return {"nodes": [], "source": nid, "slot": slot}


# editable 派生:参数字段(与 comfy_replay 的 SAMPLER_FIELDS/LATENT_FIELDS 对齐)
SAMPLER_PARAM_FIELDS = (
    "seed", "noise_seed", "steps", "cfg", "sampler_name", "scheduler",
    "denoise", "preview_method", "vae_decode",
)
LATENT_PARAM_FIELDS = ("width", "height", "batch_size")

# prompt 文本字段(class_type → text field 名)
PROMPT_TEXT_FIELDS: dict[str, str] = {
    "CLIPTextEncode": "text",
    "Text Multiline": "text",
    "Text to Conditioning": "text",
    "CR Text": "text",
    "Text Concatenate": "text_a",
}


def _is_link_value(value: Any) -> bool:
    """未解析的连线 [node_id, slot] 仍为 list/tuple,不得作为可编辑字面量。"""
    return isinstance(value, (list, tuple))


def _resolve_value(prompt: dict[str, Any], value: Any, depth: int = 0) -> Any:
    """递归解析连线取字面量(与 comfy_replay.resolve_input_value 同构)。

    独立实现,不依赖 comfy_replay — sampler_view 是纯派生层。
    """
    if depth > 12:
        return value
    link = normalize_link(value)
    if not link:
        return value
    node_id, output_index = link
    node = prompt.get(str(node_id))
    if not isinstance(node, dict):
        return value
    ct = str(node.get("class_type", ""))
    inputs = node.get("inputs", {}) or {}

    # Semantic multi-output text nodes commonly expose positive on slot 0 and
    # negative on slot 1. Resolve by output slot rather than class name.
    polarity_fields = ("positive", "negative")
    if 0 <= output_index < len(polarity_fields):
        field = polarity_fields[output_index]
        if isinstance(inputs.get(field), str):
            return inputs[field]

    if ct == "ImpactConditionalBranch":
        condition = _resolve_value(prompt, inputs.get("cond"), depth + 1)
        selected = "tt_value" if bool(condition) else "ff_value"
        return _resolve_value(prompt, inputs.get(selected), depth + 1)

    if "sampler" in ct.lower() and "select" in ct.lower() and "sampler_name" in inputs:
        return _resolve_value(prompt, inputs.get("sampler_name"), depth + 1)

    if ct in {
        "PrimitiveInt",
        "PrimitiveFloat",
        "PrimitiveString",
        "PrimitiveStringMultiline",
        "PrimitiveNode",
        "Seed (rgthree)",
    }:
        if "value" in inputs:
            return _resolve_value(prompt, inputs.get("value"), depth + 1)
        if inputs:
            first_key = next(iter(inputs))
            return _resolve_value(prompt, inputs.get(first_key), depth + 1)

    # Primitive-like custom nodes (for example easy int/easy float) retain a
    # literal `value` input even when their class type is unknown.
    if "value" in inputs and not normalize_link(inputs.get("value")):
        return inputs.get("value")

    if ct == "Reroute":
        if inputs:
            first_key = next(iter(inputs))
            return _resolve_value(prompt, inputs.get(first_key), depth + 1)
        return value

    if ct == "AbsNode":
        nested = _resolve_value(prompt, inputs.get("input1"), depth + 1)
        if isinstance(nested, (int, float)) and not isinstance(nested, bool):
            return abs(nested)
        return nested

    if ct in {"CLIPTextEncode", "Text Multiline", "CR Text"}:
        return _resolve_value(prompt, inputs.get("text", ""), depth + 1)

    if ct == "Text Concatenate":
        delimiter = str(inputs.get("delimiter") or "")
        parts: list[str] = []
        for field in ("text_a", "text_b", "text_c", "text_d"):
            resolved = _resolve_value(prompt, inputs.get(field), depth + 1)
            if _is_link_value(resolved):
                continue
            if isinstance(resolved, str):
                if resolved.strip():
                    parts.append(resolved)
            elif resolved not in (None, "", {}):
                parts.append(str(resolved))
        return delimiter.join(parts)

    if ct == "Text to Conditioning":
        return _resolve_value(prompt, inputs.get("text"), depth + 1)

    return value


def extract_sampler_parameters(
    prompt: dict[str, Any],
    sampler_id: str,
    sampler_type: str,
    chain_nodes: list[dict[str, Any]],
) -> dict[str, Any]:
    """从 API prompt 提取 sampler 参数(seed/steps/cfg/sampler_name/scheduler/denoise)。

    3 种模式:
      1. 标准 KSampler: 参数在自身 inputs(字面量)
      2. Flux SamplerCustomAdvanced: 分散在 noise/guider/sampler/sigmas 上游节点
      3. UmeAiRT 封装: 分散在 settings 节点

    chain_nodes 是 sampler_view 图遍历已到达的上游节点(含 transparent)。
    """
    params: dict[str, Any] = {}
    node = prompt.get(sampler_id, {})
    inputs = node.get("inputs", {}) or {}

    # 模式 1:标准 — 参数在自身 inputs
    for field in SAMPLER_PARAM_FIELDS:
        if field in inputs:
            val = _resolve_value(prompt, inputs.get(field))
            if val is not None and not _is_link_value(val):
                params[field] = val

    # 模式 2:Flux SamplerCustomAdvanced — 分散参数载体
    if sampler_type == "SamplerCustomAdvanced":
        for cn in chain_nodes:
            ct = cn["class_type"]
            cnode = prompt.get(cn["node_id"], {})
            cinputs = cnode.get("inputs", {}) or {}
            ctl = ct.lower()
            if "noise" in ctl and "seed" not in params:
                for k in ("noise_seed", "seed"):
                    if k in cinputs:
                        val = _resolve_value(prompt, cinputs[k])
                        if not _is_link_value(val):
                            params["seed"] = val
                        break
            elif "guider" in ctl:
                if "cfg" in cinputs and "cfg" not in params:
                    val = _resolve_value(prompt, cinputs["cfg"])
                    if not _is_link_value(val):
                        params["cfg"] = val
                if "steps" in cinputs and "steps" not in params:
                    val = _resolve_value(prompt, cinputs["steps"])
                    if not _is_link_value(val):
                        params["steps"] = val
            elif "samplerselect" in ctl or ct == "KSamplerSelect":
                if "sampler_name" in cinputs and "sampler_name" not in params:
                    val = _resolve_value(prompt, cinputs["sampler_name"])
                    if not _is_link_value(val):
                        params["sampler_name"] = val
            elif "sigma" in ctl or "scheduler" in ctl:
                for k in ("steps", "denoise", "scheduler"):
                    if k in cinputs and k not in params:
                        val = _resolve_value(prompt, cinputs[k])
                        if not _is_link_value(val):
                            params[k] = val

    return params


def extract_latent_parameters(
    prompt: dict[str, Any], chain_nodes: list[dict[str, Any]], sampler_id: str | None = None
) -> list[dict[str, Any]]:
    """从 latent 链节点提取 width/height/batch_size。

    覆盖 EmptyLatentImage / EmptySD3LatentImage / EmptyHunyuanLatentVideo 等
    (非标准 latent 节点只要 inputs 含 width/height/batch_size 即可提取)。
    """
    results: list[dict[str, Any]] = []
    candidates = [cn for cn in chain_nodes if cn["role"] == "latent"]
    if sampler_id:
        latent_reach = _reverse_reach(prompt, sampler_id, "latent_image")
        known_ids = {str(item["node_id"]) for item in candidates}
        for node_id in latent_reach:
            if node_id in known_ids:
                continue
            node = prompt.get(node_id) or {}
            candidates.append({
                "node_id": node_id,
                "class_type": str(node.get("class_type") or ""),
                "role": "latent_upstream",
            })
    for cn in candidates:
        node = prompt.get(cn["node_id"], {})
        inputs = node.get("inputs", {}) or {}
        entry: dict[str, Any] = {
            "node_id": cn["node_id"],
            "class_type": cn["class_type"],
        }
        for field in LATENT_PARAM_FIELDS:
            if field in inputs:
                val = _resolve_value(prompt, inputs[field])
                if not _is_link_value(val):
                    entry[field] = val
        if inputs.get("output_resize_to_target_size") is True:
            width = _resolve_value(prompt, inputs.get("output_target_width"))
            height = _resolve_value(prompt, inputs.get("output_target_height"))
            if not _is_link_value(width) and width not in (None, ""):
                entry["width"] = width
            if not _is_link_value(height) and height not in (None, ""):
                entry["height"] = height
        if any(k in entry for k in LATENT_PARAM_FIELDS):
            results.append(entry)
    return results


def extract_prompt_texts(
    prompt: dict[str, Any],
    sampler_id: str,
    chain_nodes: list[dict[str, Any]],
    raw_workflow: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """从 prompt 链节点提取文本,保留极性(从 sampler 的 positive/negative 连线定)。

    覆盖 CLIPTextEncode / Text Multiline / CR Text / Text Concatenate(聚合) /
    Text to Conditioning。极性由 sampler.inputs["positive"/"negative"] 连线定位。
    """
    # Prefer the bounded sampler-branch traversal used by the parse-worker
    # recovery adapter. It carries positive/negative through named Bus ports
    # and supports custom CLIPTextEncode variants without guessing slot roles.
    sampler_node = prompt.get(sampler_id, {})
    sampler_inputs = sampler_node.get("inputs", {}) or {}
    traced: list[dict[str, Any]] = []
    for polarity in ("positive", "negative"):
        link = normalize_link(sampler_inputs.get(polarity))
        if not link:
            continue
        for item in recover_text(
            prompt,
            link[0],
            branch=polarity,
            output_slot=link[1],
            workflow=raw_workflow,
        ):
            text = item.get("text")
            if not isinstance(text, str) or not text.strip():
                continue
            traced.append({
                "node_id": str(item.get("source_node_id") or link[0]),
                "class_type": str(item.get("source_node_type") or ""),
                "field": "text",
                "text": text,
                "polarity": polarity,
            })
    if traced:
        return traced

    # Compatibility fallback for older graphs whose conditioning route is
    # recognized by the full connected-component traversal below.
    polarity_map: dict[str, str] = {}
    for field in ("positive", "negative"):
        link = normalize_link(sampler_inputs.get(field))
        if link:
            polarity_map[link[0]] = field
            # 追溯一层(transparent 节点中转):如 positive→ConditioningCombine→CLIPTextEncode
            upstream_node = prompt.get(link[0], {})
            if isinstance(upstream_node, dict):
                up_inputs = upstream_node.get("inputs", {}) or {}
                for _fname, _fval in up_inputs.items():
                    sub_link = normalize_link(_fval)
                    if sub_link and sub_link[0] not in polarity_map:
                        polarity_map[sub_link[0]] = field

    results: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for cn in chain_nodes:
        if cn["role"] not in ("prompt", "positive", "negative"):
            continue
        nid = cn["node_id"]
        if nid in seen_ids:
            continue
        ct = cn["class_type"]
        node = prompt.get(nid, {})
        inputs = node.get("inputs", {}) or {}

        text_field = PROMPT_TEXT_FIELDS.get(ct)
        if not text_field:
            if "text" in inputs:
                text_field = "text"
            elif "text_a" in inputs:
                text_field = "text_a"
            else:
                continue

        text = _resolve_value(prompt, inputs.get(text_field))
        polarity = polarity_map.get(nid, "")
        if polarity not in ("positive", "negative"):
            polarity = "positive"

        seen_ids.add(nid)
        results.append(
            {
                "node_id": nid,
                "class_type": ct,
                "field": text_field,
                "text": text or "",
                "polarity": polarity,
            }
        )
    return results


def build_sampler_views(raw_prompt: Any, raw_workflow: Any = None) -> list[dict[str, Any]]:
    """主入口:从 raw_prompt(API prompt 图)构建 sampler 中心视图。

    raw_workflow 可选,用于 Power Lora Loader 的 widgets_values(LoRA 名/强度
    在 UI workflow 的 widgets_values,不在 API prompt inputs)。

    图遍历第一性:从 sampler 出发,沿所有 input 边全连通 BFS(不过滤),
    得到完整上游连通分量。guider/pipe/scheduler 标 transparent 自动穿过,
    不需为每种打包机制特化解包。角色由节点 class_type 产出语义定。

    返回每个 sampler 的:
      - sampler_id / sampler_type
      - chains: {model/prompt/latent/post/...: [节点]}
      - loras: 链上 LoRA(含 node_id 供编辑)
      - loaders: 链上 model/vae/clip loader
      - unknown_nodes: 链上未知 class_type 节点(降级展示)
    """
    if not isinstance(raw_prompt, dict):
        return []

    # widgets_map:Power Lora Loader 的 LoRA 名/强度在 raw_workflow widgets_values
    widgets_map: dict[str, Any] = {}
    if isinstance(raw_workflow, dict):
        for wn in raw_workflow.get("nodes", []) or []:
            if isinstance(wn, dict):
                widgets_map[str(wn.get("id"))] = wn.get("widgets_values", [])

    roots = find_sampler_roots(raw_prompt)
    views: list[dict[str, Any]] = []

    for sid, stype in roots:
        node = raw_prompt.get(sid, {})
        inputs = node.get("inputs", {}) or {}

        # 图遍历第一性:从 sampler 所有 input 连线出发,全连通 BFS
        chains: dict[str, list[dict[str, Any]]] = defaultdict(list)
        all_chain_nodes: list[dict[str, Any]] = []
        visited: set[str] = set()
        queue: list[tuple[str, str | None]] = []

        for fname, val in inputs.items():
            link = normalize_link(val)
            if link:
                queue.append((link[0], classify_input(fname)))

        while queue:
            nid, inherited_role = queue.pop(0)
            if nid in visited:
                continue
            visited.add(nid)
            n = raw_prompt.get(nid)
            if not isinstance(n, dict):
                continue
            ct = str(n.get("class_type", ""))
            role = _role_from_class_type(ct) or inherited_role or "other"
            entry = {"node_id": nid, "class_type": ct, "role": role}
            if role != "transparent":
                chains[role].append(entry)
                all_chain_nodes.append(entry)
            # 子节点继承角色(transparent 时透传 inherited)
            child_role = role if role != "transparent" else inherited_role
            for fname, val in (n.get("inputs", {}) or {}).items():
                link = normalize_link(val)
                if link and link[0] not in visited:
                    queue.append((link[0], child_role))

        loras = extract_loras_from_chain(all_chain_nodes, raw_prompt, widgets_map)
        loaders = extract_loaders_from_chain(all_chain_nodes, raw_prompt)
        sampler_params = extract_sampler_parameters(raw_prompt, sid, stype, all_chain_nodes)
        latent_params = extract_latent_parameters(raw_prompt, all_chain_nodes, sid)
        prompt_texts = extract_prompt_texts(raw_prompt, sid, all_chain_nodes, raw_workflow)
        controlnets = extract_controlnets_from_chain(
            raw_prompt, sid, sampler_params, all_chain_nodes
        )
        regions = extract_region_views(raw_prompt, sid, all_chain_nodes)
        if isinstance(raw_workflow, dict):
            bypassed_cns = extract_bypassed_controlnets_from_workflow(raw_workflow)
        else:
            bypassed_cns = []

        # 未知节点降级:链上且无语义角色(role=="other")且非已知白名单的节点
        # (有语义角色的 CLIPLoader/VAELoader/transparent 等不列,减少噪音;
        #  role=="other" 的 ComfySwitchNode/数学表达式等真正未分类的才展示)
        known_conditioning = {
            "CLIPTextEncode",
            "ConditioningCombine",
            "ConditioningConcat",
            "ConditioningSetPropertiesAndCombine",
            "ConditioningSetMask",
            "AttentionCouple",
            "AttentionCoupleRegions",
            "AttentionCoupleRegion",
            "Text Multiline",
            "Text Concatenate",
            "Text to Conditioning",
        }
        known = LORA_NODE_TYPES | known_conditioning
        loader_node_ids = {l["node_id"] for l in loaders}
        unknown = [
            {"node_id": n["node_id"], "class_type": n["class_type"], "role": n["role"]}
            for n in all_chain_nodes
            if n["class_type"] not in known
            and n["node_id"] not in loader_node_ids
            and n["role"] in ("other", None)
        ]

        views.append(
            {
                "sampler_id": sid,
                "sampler_type": stype,
                "chains": dict(chains),
                "chain_lengths": {k: len(v) for k, v in chains.items()},
                "loras": loras,
                "loaders": loaders,
                "sampler_params": sampler_params,
                "latent_params": latent_params,
                "prompt_texts": prompt_texts,
                "controlnets": controlnets,
                "bypassed_controlnets": bypassed_cns,
                "regions": regions,
                "unknown_nodes": unknown,
            }
        )

    return views
