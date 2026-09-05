"""阶段1：parser 已知宇宙提取。

两个来源：
1. import 内省 workflow_db 三模块的表驱动常量；
2. AST 提取 parser.py / comfyui_recovery.py 中内联的精确匹配字面量
   （`class_type == "X"` / `in {...}`）与子串启发关键词。

验收锚点见 PARSER_SPEC §6.2 / §8.1 / §14.2；结果自带 missing_anchors 自检。
"""
import ast

from .common import REPO_ROOT, log

PARSER_PATH = REPO_ROOT / "workflow_db" / "parser.py"
RECOVERY_PATH = REPO_ROOT / "workflow_db" / "comfyui_recovery.py"

SUBJECT_NAMES = {"class_type", "ct", "node_type"}

CONST_NAMES = {
    "PRIMITIVE_NODE_TYPES", "TEXT_NODE_TYPES", "SAMPLER_HINTS", "LATENT_HINTS",
    "_PLAIN_TEXT_TYPES", "_CONCAT_TEXT_TYPES", "_CONDITIONING_TERMINATORS",
    "_CONCAT_FIELDS", "_GENERIC_TEXT_KEYS",
}

ANCHORS_EXACT = (
    "CLIPTextEncode", "Text Multiline", "Text Concatenate", "Text to Conditioning",
    "ConditioningCombine", "ConditioningConcat", "ConditioningSetMask",
    "ConditioningSetArea", "ConditioningSetAreaPercentage", "ConditioningSetAreaStrength",
    "ConditioningSetPropertiesAndCombine", "RegionalConditioningSimple //Inspire",
    "RegionalPromptSimple //Inspire", "AttentionCouple", "AttentionCoupleRegions",
    "AttentionCoupleRegion", "Text Prompt (JPS)", "Text Concatenate (JPS)",
    "CR Text", "CR Text Concatenate", "LoraLoader", "CreateHookLora", "LoRA Stacker",
    "Power Lora Loader (rgthree)", "Power Lora Loader", "Sampler Selector",
    "KSamplerSelect", "AbsNode", "__blueprint_input", "__external_node",
    "PrimitiveInt", "PrimitiveString", "Seed (rgthree)",
    "BNK_CLIPTextEncodeAdvanced", "BNK_CLIPTextEncodeSDXLAdvanced",
    "ImpactSwitch", "ImpactWildcardEncode", "WeiLinPromptUI", "ReferenceLatent",
)


def _eval_str_set(node, tables):
    if isinstance(node, ast.Constant):
        return {node.value} if isinstance(node.value, str) else set()
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        out = set()
        for elt in node.elts:
            out |= _eval_str_set(elt, tables)
        return out
    if isinstance(node, ast.Starred):
        return _eval_str_set(node.value, tables)
    if isinstance(node, ast.Name):
        return set(tables.get(node.id, ()))
    if isinstance(node, ast.BinOp):
        left = _eval_str_set(node.left, tables)
        right = _eval_str_set(node.right, tables)
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, (ast.Add, ast.BitOr)):
            return left | right
    return set()


def _scan_const_tables(tree):
    tables = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            value_sets = None
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in CONST_NAMES:
                    value_sets = _eval_str_set(node.value, tables)
                    if value_sets:
                        tables[target.id] = frozenset(value_sets)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.target.id in CONST_NAMES and node.value is not None:
                value_sets = _eval_str_set(node.value, tables)
                if value_sets:
                    tables[node.target.id] = frozenset(value_sets)
    return tables


def _contains_subject(node):
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name) and sub.id in SUBJECT_NAMES:
            return True
        if isinstance(sub, ast.Attribute) and sub.attr in SUBJECT_NAMES:
            return True
    return False


def _is_lower_call(node):
    return (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == "lower")


def _literal_side(node, tables):
    """比较的另一侧是否为纯字面量集合；返回 (字符串集, 全部为字面量)。"""
    values = _eval_str_set(node, tables)
    if not values:
        return set(), False
    complete = not any(
        isinstance(sub, ast.Name) and sub.id not in tables
        for sub in ast.walk(node)
        if isinstance(sub, (ast.Name, ast.Call))
        and not (isinstance(sub, ast.Name) and sub.id in tables)
    )
    return values, complete


def extract_file_literals(path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    tables = _scan_const_tables(tree)
    exact, exact_lower, hints = set(), set(), set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Compare):
            continue
        sides = [node.left] + list(node.comparators)
        for i, op in enumerate(node.ops):
            left, right = sides[i], sides[i + 1]
            left_sub, right_sub = _contains_subject(left), _contains_subject(right)
            if not (left_sub or right_sub):
                continue
            left_lit, _ = _literal_side(left, tables)
            right_lit, _ = _literal_side(right, tables)
            lowered = (_is_lower_call(left) and left_sub) or (_is_lower_call(right) and right_sub)

            if isinstance(op, (ast.Eq, ast.NotEq)):
                lit = right_lit if left_sub else left_lit
                if lit:
                    (exact_lower if lowered else exact).update(lit)
            elif isinstance(op, ast.In):
                if left_sub and right_lit and not _is_lower_call(left):
                    exact.update(right_lit)
                elif right_sub and left_lit:
                    if _is_lower_call(right):
                        hints.update(left_lit)
                    else:
                        exact.update(left_lit)
    return exact, exact_lower, hints


def _module_families():
    import workflow_db.parser as parser_mod
    import workflow_db.sampler_view as sv_mod

    families = {
        "primitive": sorted(parser_mod.PRIMITIVE_NODE_TYPES),
        "text": sorted(parser_mod.TEXT_NODE_TYPES),
        "sampler_hints": list(parser_mod.SAMPLER_HINTS),
        "latent_hints": list(getattr(parser_mod, "LATENT_HINTS", ())),
        "lora_types": sorted(sv_mod.LORA_NODE_TYPES),
        "transparent_hints": list(sv_mod.TRANSPARENT_HINTS),
        "role_table": sorted(sv_mod.CLASS_TYPE_ROLE.keys()),
    }
    try:
        import workflow_db.comfyui_recovery as rec_mod
        for attr in ("_PLAIN_TEXT_TYPES", "_CONCAT_TEXT_TYPES", "_CONDITIONING_TERMINATORS"):
            value = getattr(rec_mod, attr, None)
            if value:
                families[attr.lstrip("_")] = sorted(value)
    except Exception as exc:  # noqa: BLE001 - recovery 缺失不阻断主流程
        log(f"[known] comfyui_recovery 导入失败，跳过其表驱动集合：{exc}")
    return families


def build_known_universe(save_to=None):
    families = _module_families()
    exact = set()
    exact_lower = set()
    hints = set()
    for path in (PARSER_PATH, RECOVERY_PATH):
        f_exact, f_lower, f_hints = extract_file_literals(path)
        exact |= f_exact
        exact_lower |= f_lower
        hints |= f_hints
    for member in families["text"] + families["primitive"] + families["lora_types"]:
        exact.add(member)

    known_lower = {name.lower() for name in exact}
    known_lower |= {name.lower() for name in exact_lower}
    known_lower |= set(families["role_table"])

    missing = [anchor for anchor in ANCHORS_EXACT if anchor not in exact]
    universe = {
        "families": families,
        "exact": sorted(exact),
        "exact_lower": sorted(exact_lower),
        "hint_keywords": sorted(hints),
        "known_lower_count": len(known_lower),
        "missing_anchors": missing,
    }
    if save_to:
        from .common import save_json
        save_json(save_to, universe)
    return universe


def known_lower_set(universe) -> set:
    base = {name.lower() for name in universe["exact"]}
    base |= {name.lower() for name in universe["exact_lower"]}
    base |= set(universe["families"]["role_table"])
    return base
