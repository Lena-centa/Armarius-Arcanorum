"""阶段3：节点函数体行为指纹（静态，不执行代码）。

回答接口签名看不到的问题：是否真在内部采样、是否循环包裹采样（detailer 类）、
seed 是否被改写、声明的输入哪些真的被消费、输出是否原样直通。
"""
import ast
from pathlib import Path

from .common import load_json, log, save_json

CORE_SAMPLING_CALLS = {
    "comfy.sample.sample", "comfy.sample.sample_custom",
    "comfy.sample.common_ksampler", "common_ksampler",
    "comfy.samplers.sample", "comfy.samplers.sample_real",
    "comfy.sampling.prepare_noise",
}
CORE_NODE_CALLS = {
    "KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced",
    "VAEDecode", "CheckpointLoaderSimple", "UNETLoader", "ControlNetApplyAdvanced",
}
SAMPLING_NODE_CALLS = {
    "KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced",
}
SEED_ATTRS = {"manual_seed", "seed_everything", "fix_seed"}
MAX_FINGERPRINT_SOURCE_BYTES = 2 * 1024 * 1024
MAX_DEPENDENCY_STEPS = 50_000


def _dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _dotted(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    if isinstance(node, ast.Call):
        return _dotted(node.func)
    return ""


def _class_chain(cls_name, classes_by_name, depth=0, preferred_file=None):
    hits = classes_by_name.get(cls_name) or []
    if not hits or depth > 8:
        return []
    if preferred_file:
        preferred = str(preferred_file).replace("\\", "/")
        exact = [hit for hit in hits if str(hit[1]).replace("\\", "/").endswith(preferred)]
        if exact:
            hits = exact
    node, _ = hits[0]
    chain = [node]
    for base in node.bases:
        base_name = base.id if isinstance(base, ast.Name) else (
            base.attr if isinstance(base, ast.Attribute) else None)
        if base_name and base_name != cls_name:
            chain.extend(_class_chain(base_name, classes_by_name, depth + 1))
    return chain


def _find_method(chain, name):
    for cls in chain:
        for item in cls.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == name:
                return item
    return None


def _base_name(base):
    if isinstance(base, ast.Name):
        return base.id
    if isinstance(base, ast.Attribute):
        return base.attr
    return None


def _external_base_entrypoint(chain, contracts_by_class):
    """Resolve an overridden entrypoint from cached external base contracts.

    A result requires one direct external base, unanimous cached ``FUNCTION``
    evidence for that base class, and a same-named method implemented by the
    local subclass. Conflicts remain unresolved.
    """
    if not chain:
        return None
    options = []
    for base in chain[0].bases:
        base_class = _base_name(base)
        candidates = contracts_by_class.get(base_class) or []
        functions = {
            candidate.get("function") for _, candidate in candidates
            if isinstance(candidate.get("function"), str)
            and candidate.get("function")
        }
        if len(functions) != 1:
            continue
        function = next(iter(functions))
        if _find_method([chain[0]], function) is None:
            continue
        inputs = set()
        for _, candidate in candidates:
            if candidate.get("function") != function:
                continue
            for section in (candidate.get("inputs") or {}).values():
                if isinstance(section, dict):
                    inputs.update(section)
        options.append({
            "base_class": base_class,
            "function": function,
            "input_fields": sorted(inputs),
            "definition_ids": sorted(
                definition_id for definition_id, candidate in candidates
                if candidate.get("function") == function
            ),
        })
    return options[0] if len(options) == 1 else None


def _direct_scan(func):
    """单函数体内直接命中：核心采样调用/核心节点实例化/seed 操作/循环包裹。"""
    info = {"sampling": set(), "inst": set(), "seed": set(),
            "callees": {}, "loop_hit": False}
    loop_ids = set()
    for node in ast.walk(func):
        if isinstance(node, (ast.For, ast.While)):
            for sub in ast.walk(node):
                loop_ids.add(id(sub))
    for node in ast.walk(func):
        if isinstance(node, ast.Call):
            dotted = _dotted(node.func)
            if dotted:
                name = dotted.rsplit(".", 1)[-1]
                info["callees"][name] = max(info["callees"].get(name, 0),
                                            len(node.args))
            if dotted in CORE_SAMPLING_CALLS:
                info["sampling"].add(dotted)
                if id(node) in loop_ids:
                    info["loop_hit"] = True
            elif isinstance(node.func, ast.Name) and node.func.id in CORE_NODE_CALLS:
                info["inst"].add(node.func.id)
                if id(node) in loop_ids:
                    info["loop_hit"] = True
            if any(attr in dotted for attr in SEED_ATTRS):
                info["seed"].add(dotted)
        elif isinstance(node, ast.Attribute) and node.attr in SEED_ATTRS:
            info["seed"].add(_dotted(node))
        elif isinstance(node, ast.Name) and node.id in CORE_NODE_CALLS:
            info["inst"].add(node.id)
    return info


def _expr_text(node):
    try:
        value = ast.unparse(node)
    except Exception:  # noqa: BLE001 - diagnostic text is optional
        return None
    return value[:240]


def _return_outputs(value):
    """Normalize legacy tuples and V3 ``NodeOutput`` into output expressions."""
    if isinstance(value, (ast.Tuple, ast.List)):
        return list(value.elts)
    if (isinstance(value, ast.Call)
            and _dotted(value.func).rsplit(".", 1)[-1] == "NodeOutput"):
        return list(value.args)
    if isinstance(value, ast.Dict):
        for key, item in zip(value.keys, value.values):
            if isinstance(key, ast.Constant) and key.value == "result":
                return _return_outputs(item)
    return [value] if value is not None else []


def _target_names(target):
    if isinstance(target, ast.Name):
        return {target.id}
    if isinstance(target, (ast.Tuple, ast.List)):
        return {
            name for item in target.elts for name in _target_names(item)
        }
    return set()


def _simple_assignments(func, declared_inputs):
    values = {}
    rebound_inputs = set()
    for node in ast.walk(func):
        targets = node.targets if isinstance(node, ast.Assign) else (
            [node.target] if isinstance(node, ast.AnnAssign) and node.value else [])
        for target in targets:
            names = _target_names(target)
            rebound_inputs.update(names & declared_inputs)
            if isinstance(target, ast.Name):
                values.setdefault(target.id, []).append(node.value)
    return {
        name: tuple(expressions) for name, expressions in values.items()
    }, rebound_inputs


def _input_dependencies(
    node, declared_inputs, assignments, rebound_inputs, keyword_arg=None,
    seen=None, budget=None,
):
    budget = budget if budget is not None else [MAX_DEPENDENCY_STEPS]
    if budget[0] <= 0:
        return set(), None
    budget[0] -= 1
    seen = seen or set()
    if isinstance(node, ast.Name):
        if node.id in declared_inputs:
            return {node.id}, None if node.id in rebound_inputs else node.id
        if node.id in assignments and node.id not in seen:
            dependencies = set()
            direct_inputs = set()
            expressions = assignments[node.id]
            for expression in expressions:
                fields, direct = _input_dependencies(
                    expression, declared_inputs, assignments,
                    rebound_inputs, keyword_arg, seen | {node.id}, budget
                )
                dependencies.update(fields)
                if direct:
                    direct_inputs.add(direct)
            direct = (
                next(iter(direct_inputs))
                if len(expressions) == 1 and len(direct_inputs) == 1 else None
            )
            return dependencies, direct
        return set(), None
    if isinstance(node, ast.Subscript):
        slice_node = node.slice
        if isinstance(slice_node, ast.Index):  # pragma: no cover - Python < 3.9 AST
            slice_node = slice_node.value
        if (keyword_arg and isinstance(node.value, ast.Name)
                and node.value.id == keyword_arg
                and isinstance(slice_node, ast.Constant)
                and isinstance(slice_node.value, str)
                and slice_node.value in declared_inputs):
            return {slice_node.value}, slice_node.value
        fields, direct = _input_dependencies(
            node.value, declared_inputs, assignments, rebound_inputs,
            keyword_arg, seen, budget
        )
        slice_fields, _ = _input_dependencies(
            slice_node, declared_inputs, assignments, rebound_inputs,
            keyword_arg, seen, budget
        )
        return fields | slice_fields, None
    fields = set()
    for child in ast.iter_child_nodes(node):
        child_fields, _ = _input_dependencies(
            child, declared_inputs, assignments, rebound_inputs,
            keyword_arg, seen, budget
        )
        fields.update(child_fields)
    return fields, None


def _output_derivations(func, declared_inputs):
    assignments, rebound_inputs = _simple_assignments(func, declared_inputs)
    keyword_arg = func.args.kwarg.arg if func.args.kwarg is not None else None
    dependency_budget = [MAX_DEPENDENCY_STEPS]
    variants = [
        _return_outputs(node.value)
        for node in ast.walk(func)
        if isinstance(node, ast.Return) and node.value is not None
    ]
    if not variants:
        return []
    slots = max(len(outputs) for outputs in variants)
    derivations = []
    for slot in range(slots):
        expressions = [outputs[slot] for outputs in variants if slot < len(outputs)]
        if len(expressions) != len(variants):
            derivations.append({
                "output_slot": slot,
                "kind": "opaque",
                "input_fields": [],
                "expression": None,
            })
            continue
        dependencies, direct_inputs, literal_only = set(), set(), True
        texts = []
        for expression in expressions:
            fields, direct = _input_dependencies(
                expression, declared_inputs, assignments, rebound_inputs,
                keyword_arg, budget=dependency_budget
            )
            dependencies.update(fields)
            if direct:
                direct_inputs.add(direct)
            literal_only = literal_only and isinstance(expression, ast.Constant)
            text = _expr_text(expression)
            if text:
                texts.append(text)
        if len(direct_inputs) == 1 and all(
            _input_dependencies(
                expr, declared_inputs, assignments, rebound_inputs,
                keyword_arg, budget=dependency_budget
            )[1]
            in direct_inputs for expr in expressions
        ):
            kind = "input"
        elif literal_only:
            kind = "literal"
        elif dependencies:
            kind = "computed"
        else:
            kind = "opaque"
        unique_texts = sorted(set(texts))
        derivations.append({
            "output_slot": slot,
            "kind": kind,
            "input_fields": sorted(dependencies),
            "expression": (
                unique_texts[0] if len(unique_texts) == 1
                else " | ".join(unique_texts)[:240] if unique_texts else None
            ),
        })
    return derivations


def _semantic_contract(func, declared_inputs, direct_info, output_node):
    if func is None:
        return {
            "operation": "opaque", "output_derivations": [],
            "side_effects": [], "determinism": "unknown",
            "batch_behavior": "unknown", "transparent": False,
            "provenance": "static_ast", "confidence": "none",
        }
    derivations = _output_derivations(func, declared_inputs)
    calls = {
        _dotted(node.func).lower()
        for node in ast.walk(func) if isinstance(node, ast.Call)
    }
    side_effects = set()
    if output_node:
        side_effects.add("output_sink")
    if any(
        "save_image" in call
        or call == "open"
        or call.endswith((".open", ".save", ".write_text", ".write_bytes"))
        for call in calls
    ):
        side_effects.add("file_io")
    if any(
        token in call for call in calls
        for token in ("requests.", "urllib.", "httpx.", "aiohttp.", "download")
    ):
        side_effects.add("network_io")
    if any(call.endswith(("sleep", "wait")) for call in calls):
        side_effects.add("timing")
    if any(
        token in call for call in calls
        for token in (
            "unload", "empty_cache", "gc.collect", "free_memory",
            "cleanup", "clear_cache", "ipc_collect",
        )
    ):
        side_effects.add("resource_state")
    mutated_inputs = set()
    for node in ast.walk(func):
        if isinstance(node, (ast.Subscript, ast.Attribute)) and isinstance(node.ctx, ast.Store):
            root = node.value
            while isinstance(root, (ast.Subscript, ast.Attribute)):
                root = root.value
            if isinstance(root, ast.Name) and root.id in declared_inputs:
                mutated_inputs.add(root.id)
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id in declared_inputs
                and (
                    node.func.attr in {"append", "extend", "update", "pop", "clear"}
                    or node.func.attr.startswith(("set_", "add_", "patch"))
                )):
            mutated_inputs.add(node.func.value.id)
    if mutated_inputs:
        side_effects.add("input_mutation")

    internal_sampling = bool(
        direct_info["sampling"]
        or (direct_info["inst"] & SAMPLING_NODE_CALLS)
    )
    direct_identity = bool(derivations) and all(
        item["kind"] == "input" and len(item["input_fields"]) == 1
        for item in derivations
    )
    identity_fields = {
        field for item in derivations for field in item["input_fields"]
        if item["kind"] == "input"
    }
    pure_calls = {"len", "str", "bool", "int", "float", "list", "tuple", "dict", "type"}
    has_effectful_calls = False
    for node in ast.walk(func):
        if not isinstance(node, ast.Call):
            continue
        call_name = _dotted(node.func)
        if call_name in pure_calls or call_name.rsplit(".", 1)[-1] == "NodeOutput":
            continue
        has_effectful_calls = True
        argument_fields = {
            item.id
            for value in [*node.args, *(kw.value for kw in node.keywords)]
            for item in ast.walk(value)
            if isinstance(item, ast.Name) and item.id in identity_fields
        }
        if argument_fields:
            mutated_inputs.update(argument_fields)
    if mutated_inputs:
        side_effects.add("possible_input_mutation")
    if direct_identity and has_effectful_calls and not side_effects:
        side_effects.add("external_call")
    transparent = direct_identity and not mutated_inputs and not internal_sampling
    if internal_sampling:
        operation = "sample"
    elif output_node:
        operation = "sink"
    elif direct_identity and side_effects:
        operation = "side_effect"
    elif transparent:
        operation = "identity"
    elif derivations and all(item["kind"] == "literal" for item in derivations):
        operation = "constant"
    elif derivations and any(item["kind"] != "opaque" for item in derivations):
        operation = "transform"
    else:
        operation = "opaque"

    random_calls = any(
        token in call for call in calls
        for token in ("random", "randn", "randint", "prepare_noise", "manual_seed")
    )
    if internal_sampling or random_calls:
        determinism = "stochastic"
    elif operation in {"identity", "constant"}:
        determinism = "deterministic"
    else:
        determinism = "unknown"
    confidence = (
        "high" if operation in {"identity", "sample", "constant"}
        else "medium" if operation in {"sink", "side_effect", "transform"}
        else "none"
    )
    return {
        "operation": operation,
        "output_derivations": derivations,
        "side_effects": sorted(side_effects),
        "mutated_inputs": sorted(mutated_inputs),
        "determinism": determinism,
        "batch_behavior": "unknown",
        "transparent": transparent,
        "provenance": "static_ast",
        "confidence": confidence,
    }


def fingerprint_class(
    classes_by_name,
    cls_name,
    declared_inputs,
    helpers=None,
    preferred_file=None,
    function_name=None,
):
    chain = _class_chain(cls_name, classes_by_name, preferred_file=preferred_file)
    func = None
    for cls in chain:
        for item in cls.body:
            if isinstance(item, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "FUNCTION" for t in item.targets
            ):
                value = item.value
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    func = _find_method(chain, value.value)
    if func is None and isinstance(function_name, str) and function_name:
        func = _find_method(chain, function_name)
    output_node = False
    for cls in chain:
        for item in cls.body:
            if isinstance(item, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "OUTPUT_NODE" for t in item.targets
            ):
                if isinstance(item.value, ast.Constant) and item.value.value is True:
                    output_node = True

    result = {
        "internal_sampling": False,
        "loop_wrapped_sampling": False,
        "sampling_calls": [],
        "core_nodes_instantiated": [],
        "seed_ops": [],
        "consumed_inputs": [],
        "passthrough_outputs": [],
        "output_node": output_node,
        "analyzed": func is not None,
        "semantic": _semantic_contract(
            None, declared_inputs,
            {"sampling": set(), "inst": set()}, output_node,
        ),
    }
    if func is None:
        return result

    agg_sampling, agg_inst, agg_seed = set(), set(), set()
    loop_wrapped = False
    via_helpers = set()
    seen_ids = {id(func)}
    queue = [(func, 0)]
    while queue:
        current, depth = queue.pop(0)
        info = _direct_scan(current)
        if (info["sampling"] or info["inst"]) and depth > 0:
            via_helpers.add(getattr(current, "name", "?"))
        agg_sampling |= info["sampling"]
        agg_inst |= info["inst"]
        agg_seed |= info["seed"]
        loop_wrapped = loop_wrapped or info["loop_hit"]
        if depth < 6 and len(seen_ids) < 500:
            for callee, argc in sorted(info["callees"].items()):
                for helper_func in (helpers or {}).get(callee, []):
                    if id(helper_func) in seen_ids:
                        continue
                    pos = [a.arg for a in helper_func.args.args
                           if a.arg != "self"]
                    n_defaults = len(helper_func.args.defaults)
                    lo = max(len(pos) - n_defaults, 0)
                    flexible = helper_func.args.vararg is not None
                    if flexible or lo <= argc <= len(pos):
                        seen_ids.add(id(helper_func))
                        queue.append((helper_func, depth + 1))

    param_names = {a.arg for a in func.args.args} | {
        a.arg for a in getattr(func.args, "kwonlyargs", [])}
    consumed = set()
    passthrough = []
    for node in ast.walk(func):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            if node.id in declared_inputs:
                consumed.add(node.id)
        elif (isinstance(node, ast.Subscript) and func.args.kwarg is not None
              and isinstance(node.value, ast.Name)
              and node.value.id == func.args.kwarg.arg):
            slice_node = node.slice
            if isinstance(slice_node, ast.Index):  # pragma: no cover - Python < 3.9 AST
                slice_node = slice_node.value
            if (isinstance(slice_node, ast.Constant)
                    and isinstance(slice_node.value, str)
                    and slice_node.value in declared_inputs):
                consumed.add(slice_node.value)
    for node in ast.walk(func):
        if isinstance(node, ast.Return) and isinstance(node.value, (ast.Tuple, ast.List)):
            for elt in node.value.elts:
                if isinstance(elt, ast.Name) and elt.id in param_names:
                    passthrough.append(elt.id)

    result.update({
        "internal_sampling": bool(
            agg_sampling or (agg_inst & SAMPLING_NODE_CALLS)
        ),
        "loop_wrapped_sampling": loop_wrapped,
        "sampling_calls": sorted(agg_sampling),
        "core_nodes_instantiated": sorted(agg_inst),
        "seed_ops": sorted(agg_seed),
        "sampling_via_helpers": sorted(via_helpers),
        "consumed_inputs": sorted(consumed),
        "passthrough_outputs": sorted(set(passthrough)),
        "semantic": _semantic_contract(
            func,
            declared_inputs,
            {"sampling": agg_sampling, "inst": agg_inst},
            output_node,
        ),
    })
    return result


def attach_fingerprints(
    workdir: Path,
    selected_repos: set[str] | None = None,
) -> dict:
    """对 node_defs.json 逐仓计算指纹并回写。"""
    defs_path = workdir / "node_defs.json"
    data = load_json(defs_path)
    records = data.get("definitions") or data["records"]
    contracts_by_class = {}
    for definition_id, rec in records.items():
        cls_name = rec.get("class")
        if cls_name and rec.get("function"):
            contracts_by_class.setdefault(cls_name, []).append((definition_id, rec))
    by_repo = {}
    for record_id, rec in records.items():
        by_repo.setdefault(rec.get("repo"), {})[record_id] = rec

    done = {}
    skipped_source_files = []
    for slug, record_map in sorted(by_repo.items()):
        if not slug:
            continue
        if selected_repos is not None and slug not in selected_repos:
            continue
        repo_dir = workdir / "repos" / slug.replace("/", "__")
        if not repo_dir.exists():
            continue
        repo_root = repo_dir.resolve()
        records_by_path = {}
        for record_id, rec in record_map.items():
            preferred_file = rec.get("file")
            if not preferred_file:
                continue
            path = (repo_dir / Path(str(preferred_file))).resolve()
            if path.is_relative_to(repo_root) and path.is_file():
                records_by_path.setdefault(path, []).append((record_id, rec))
        # Parse and release one definition file at a time. This makes the AST
        # peak proportional to a single bounded file instead of the repository.
        for path, path_records in sorted(records_by_path.items()):
            if path.stat().st_size > MAX_FINGERPRINT_SOURCE_BYTES:
                skipped_source_files.append(path.relative_to(repo_root).as_posix())
                continue
            try:
                tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
            except SyntaxError:
                continue
            classes_by_name = {}
            helper_funcs = {}
            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef):
                    classes_by_name.setdefault(node.name, []).append((node, path))
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    helper_funcs.setdefault(node.name, []).append(node)
            scoped_helpers = {
                name: funcs for name, funcs in helper_funcs.items()
                if len(funcs) == 1
            }
            for record_id, rec in path_records:
                cls_name = rec["class"]
                declared = set()
                for section in (rec.get("inputs") or {}).values():
                    declared |= set(section.keys())
                preferred_file = rec.get("file")
                chain = _class_chain(
                    cls_name, classes_by_name, preferred_file=preferred_file
                )
                external_entrypoint = None
                function_name = rec.get("function")
                if not function_name:
                    external_entrypoint = _external_base_entrypoint(
                        chain, contracts_by_class
                    )
                    if external_entrypoint:
                        function_name = external_entrypoint["function"]
                        declared.update(external_entrypoint["input_fields"])
                result = fingerprint_class(
                    classes_by_name,
                    cls_name,
                    declared,
                    helpers=scoped_helpers,
                    preferred_file=preferred_file,
                    function_name=function_name,
                )
                if external_entrypoint and result["analyzed"]:
                    result["entrypoint_resolution"] = {
                        "strategy": "external_base_consensus",
                        "base_class": external_entrypoint["base_class"],
                        "function": external_entrypoint["function"],
                        "definition_ids": external_entrypoint["definition_ids"],
                    }
                done[record_id] = result

    effective_fingerprints = {
        record_id: done.get(record_id) or rec.get("fingerprint")
        for record_id, rec in records.items()
    }
    hidden_definition_ids = []
    hidden_class_types = set()
    for record_id, rec in records.items():
        fp = effective_fingerprints[record_id]
        if not isinstance(fp, dict):
            continue
        class_type = str(rec.get("class_type") or record_id)
        if fp["internal_sampling"] and not any(
            keyword in class_type.lower() for keyword in ("sampler", "ksampler")
        ):
            hidden_definition_ids.append(record_id)
            hidden_class_types.add(class_type)
    summary = {
        "analyzed": sum(
            1 for fp in effective_fingerprints.values()
            if isinstance(fp, dict) and fp.get("analyzed")
        ),
        "internal_sampling_count": sum(
            1 for fp in effective_fingerprints.values()
            if isinstance(fp, dict) and fp.get("internal_sampling")
        ),
        "hidden_sampler_candidates": sorted(hidden_class_types),
        "hidden_sampler_definitions": sorted(hidden_definition_ids),
        "skipped_oversize_source_files": sorted(set(skipped_source_files)),
    }
    for record_id, fp in done.items():
        if record_id in records:
            records[record_id]["fingerprint"] = fp
            records[record_id]["semantic"] = fp["semantic"]
    if data.get("definitions") and isinstance(data.get("class_type_index"), dict):
        data["records"] = {
            class_type: dict(records[definition_ids[0]])
            for class_type, definition_ids in sorted(data["class_type_index"].items())
            if definition_ids and definition_ids[0] in records
        }
    save_json(defs_path, data)
    save_json(workdir / "fingerprint_summary.json", summary)
    log(f"[fingerprint] 分析 {summary['analyzed']} 个类，"
        f"内部采样 {summary['internal_sampling_count']} 个，"
        f"隐藏采样候选 {len(summary['hidden_sampler_candidates'])} 个")
    return summary
