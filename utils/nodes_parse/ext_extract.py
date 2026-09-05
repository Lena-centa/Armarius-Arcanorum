"""阶段2：扩展源码获取（codeload tarball）与接口 AST 提取。

只解包 *.py 做静态分析，绝不执行任何第三方代码。
支持 NODE_CLASS_MAPPINGS 的常见构造：字面量字典、`Xxx.NAME` 计算键、
`.update(变量)`（含跨模块 ImportFrom 展开）、下标追加（含嵌套作用域）。
产物 defs/{owner}__{repo}.json 与合并后的 node_defs.json。
"""
import ast
import io
import re
import tarfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from .common import ensure_dir, load_json, log, save_json

TIMEOUT = 45
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 150 * 1024 * 1024
DEFAULT_WORKERS = 6
_UA = {"User-Agent": "workflow-db-nodes-parse/0.1"}


def normalize_slug(ref: str):
    ref = (ref or "").strip()
    if not ref:
        return None
    if "://" not in ref:
        parts = [p for p in ref.split("/") if p]
        return f"{parts[0]}/{parts[1]}" if len(parts) >= 2 else None
    if "://github.com/" not in ref:
        return None
    tail = ref.split("://github.com/", 1)[1].split("#", 1)[0].split("?", 1)[0]
    parts = [p for p in tail.split("/") if p]
    if len(parts) < 2:
        return None
    name = parts[1][:-4] if parts[1].endswith(".git") else parts[1]
    return f"{parts[0]}/{name}"


def fetch_repo(slug: str, workdir: Path, refresh: bool = False):
    """下载并安全解包仓库的 *.py；返回本地目录，失败返回 None。"""
    dest = workdir / "repos" / slug.replace("/", "__")
    if dest.exists() and any(dest.iterdir()) and not refresh:
        return dest
    ensure_dir(dest)
    url = f"https://codeload.github.com/{slug}/tar.gz/HEAD"
    try:
        req = urllib.request.Request(url, headers=_UA)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            blob = resp.read(MAX_TOTAL_BYTES + 1)
        if len(blob) > MAX_TOTAL_BYTES:
            raise ValueError("tarball 超过总量上限")
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:*") as tar:
            total = 0
            for member in tar.getmembers():
                if member.isdir() or not member.name.endswith(".py"):
                    continue
                if member.issym() or member.islnk():
                    continue
                if member.size > MAX_FILE_BYTES:
                    continue
                total += member.size
                if total > MAX_TOTAL_BYTES:
                    log(f"[extract] {slug}: 超总量上限，截断")
                    break
                rel_parts = member.name.split("/")
                target = dest.joinpath(*rel_parts[1:] or rel_parts)
                if not target.resolve().is_relative_to(dest.resolve()):
                    continue
                src = tar.extractfile(member)
                if src is None:
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(src.read(MAX_FILE_BYTES))
        return dest
    except Exception as exc:  # noqa: BLE001 - 单仓失败不阻断整批
        log(f"[extract] {slug}: 获取失败 {exc}")
        return None


# ---------------------------------------------------------------------------
# AST 接口提取
# ---------------------------------------------------------------------------

def _class_chain(cls_name, classes_by_name, depth=0):
    hits = classes_by_name.get(cls_name) or []
    if not hits or depth > 8:
        return []
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


def _base_name(cls_node):
    for base in cls_node.bases:
        if isinstance(base, ast.Name):
            return base.id
        if isinstance(base, ast.Attribute):
            return base.attr
    return None


def _class_attr(chain, name):
    for cls in chain:
        for item in cls.body:
            if isinstance(item, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == name for t in item.targets
            ):
                value = item.value
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    return value.value
    return None


def _field_type(value_node):
    """INPUT_TYPES 字段值形如 ("TYPE", {...})；返回类型串或 None。"""
    container = value_node.elts if isinstance(value_node, (ast.Tuple, ast.List)) else None
    if not container:
        return None
    first = container[0]
    if isinstance(first, ast.Constant) and isinstance(first.value, str):
        return first.value
    return None


def _input_types_from(func):
    sections = {}
    level = "unresolvable"
    returns = [n for n in ast.walk(func) if isinstance(n, ast.Return)]
    if len(returns) != 1 or returns[0].value is None:
        return sections, level
    value = returns[0].value
    if not isinstance(value, ast.Dict):
        return sections, level
    dynamic_section = False
    for key_node, val_node in zip(value.keys, value.values):
        if not (isinstance(key_node, ast.Constant) and isinstance(key_node.value, str)):
            continue
        if not isinstance(val_node, ast.Dict):
            dynamic_section = True
            continue
        fields = {}
        all_typed = bool(val_node.keys)
        for f_key, f_val in zip(val_node.keys, val_node.values):
            if not (isinstance(f_key, ast.Constant) and isinstance(f_key.value, str)):
                all_typed = False
                continue
            ftype = _field_type(f_val)
            fields[f_key.value] = ftype
            if ftype is None:
                all_typed = False
        sections[key_node.value] = fields
        if not all_typed:
            dynamic_section = True
    if not sections:
        return {}, "unresolvable"
    fully_typed = all(ft for sec in sections.values() for ft in sec.values())
    level = "full" if (fully_typed and not dynamic_section) else "fields_only"
    return sections, level


def _return_types_from(chain):
    types_out, names_out = None, None
    for cls in chain:
        for item in cls.body:
            if not isinstance(item, ast.Assign):
                continue
            for target in item.targets:
                if not isinstance(target, ast.Name):
                    continue
                values = [
                    elt.value for elt in item.value.elts
                    if isinstance(elt, ast.Constant) and isinstance(elt.value, str)
                ] if isinstance(item.value, (ast.Tuple, ast.List)) else None
                if target.id == "RETURN_TYPES" and values is not None:
                    types_out = values
                elif target.id == "RETURN_NAMES" and values is not None:
                    names_out = values
    return types_out, names_out


def _v3_port_type(call):
    """Return the declared V3 IO owner from ``io.Image.Input(...)``.

    This intentionally does not evaluate calls or imports. Custom IO classes
    are retained as an upper-snake type so graph edges still have a stable,
    conservative type label.
    """
    if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Attribute):
        return None
    if call.func.attr not in {"Input", "Output"}:
        return None
    owner = call.func.value
    if isinstance(owner, ast.Attribute):
        name = owner.attr
    elif isinstance(owner, ast.Name):
        name = owner.id
    else:
        return None
    snake = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    snake = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", snake)
    return snake.upper()


def _static_string(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _schema_call_from(func):
    """Resolve a direct ``Schema(...)`` return or a local assigned schema."""
    assignments = {}
    for item in func.body:
        targets = item.targets if isinstance(item, ast.Assign) else (
            [item.target] if isinstance(item, ast.AnnAssign) and item.value else [])
        for target in targets:
            if isinstance(target, ast.Name):
                assignments[target.id] = item.value
        if not isinstance(item, ast.Return) or item.value is None:
            continue
        value = assignments.get(item.value.id) if isinstance(item.value, ast.Name) else item.value
        if (isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute)
                and value.func.attr == "Schema"):
            return value
    return None


def _v3_schema_record(cls_node, rel, slug, registration="get_node_list"):
    func = _find_method([cls_node], "define_schema")
    if func is None:
        return None, None, "no_schema"
    schema = _schema_call_from(func)
    if schema is None:
        return None, None, "dynamic_schema"
    keywords = {kw.arg: kw.value for kw in schema.keywords if kw.arg}
    node_id = _static_string(keywords.get("node_id"))
    if not node_id:
        return None, None, "dynamic_node_id"

    inputs = {"required": {}, "optional": {}}
    unresolved = 0
    input_nodes = keywords.get("inputs")
    if isinstance(input_nodes, (ast.List, ast.Tuple)):
        for item in input_nodes.elts:
            port_type = _v3_port_type(item)
            field_name = (
                _static_string(item.args[0])
                if isinstance(item, ast.Call) and item.args else None
            )
            if not port_type or not field_name:
                unresolved += 1
                continue
            optional = any(
                kw.arg == "optional"
                and isinstance(kw.value, ast.Constant)
                and kw.value.value is True
                for kw in item.keywords
            )
            inputs["optional" if optional else "required"][field_name] = port_type
    elif input_nodes is not None:
        unresolved += 1

    return_types, return_names = [], []
    output_nodes = keywords.get("outputs")
    if isinstance(output_nodes, (ast.List, ast.Tuple)):
        for item in output_nodes.elts:
            port_type = _v3_port_type(item)
            if not port_type:
                unresolved += 1
                continue
            return_types.append(port_type)
            display_name = next(
                (_static_string(kw.value) for kw in item.keywords
                 if kw.arg == "display_name"),
                None,
            )
            return_names.append(display_name)
    elif output_nodes is not None:
        unresolved += 1

    inputs = {section: fields for section, fields in inputs.items() if fields}
    level = "full" if unresolved == 0 else "fields_only"
    return node_id, {
        "repo": slug,
        "class": cls_node.name,
        "file": rel,
        "inputs": inputs,
        "input_level": level,
        "return_types": return_types,
        "return_names": return_names,
        "function": "execute" if _find_method([cls_node], "execute") else None,
        "resolved_level": level,
        "api_version": "v3",
        "registration": registration,
        "unresolved_schema_entries": unresolved,
    }, None


class _V3RegistrationResolver:
    """Resolve only class lists statically returned by V3 ``get_node_list``."""

    def __init__(self, trees, imports, classes_by_name):
        self.trees = trees
        self.imports = imports
        self.classes_by_name = classes_by_name
        self.unresolved = 0

    def _assignment(self, rel, name):
        tree = self.trees.get(rel)
        if tree is None:
            return None, rel
        for node in reversed(tree.body):
            targets = node.targets if isinstance(node, ast.Assign) else (
                [node.target] if isinstance(node, ast.AnnAssign) and node.value else [])
            if any(isinstance(target, ast.Name) and target.id == name for target in targets):
                return node.value, rel
        imported = self.imports.get(rel, {}).get(name)
        if imported:
            return self._assignment(imported[0], imported[1])
        # Star imports are common in V3 extension aggregators. Resolve a name
        # only when exactly one repository module defines it; ambiguity stays
        # unresolved instead of depending on filesystem order.
        hits = []
        for candidate_rel, candidate_tree in self.trees.items():
            for node in reversed(candidate_tree.body):
                targets = node.targets if isinstance(node, ast.Assign) else (
                    [node.target] if isinstance(node, ast.AnnAssign) and node.value else [])
                if any(isinstance(target, ast.Name) and target.id == name for target in targets):
                    hits.append((node.value, candidate_rel))
                    break
        if len(hits) == 1:
            return hits[0]
        return None, rel

    def resolve_expr(self, node, rel, seen=None):
        seen = seen or set()
        if node is None:
            return set()
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            out = set()
            for item in node.elts:
                out.update(self.resolve_expr(
                    item.value if isinstance(item, ast.Starred) else item, rel, seen
                ))
            return out
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return self.resolve_expr(node.left, rel, seen) | self.resolve_expr(
                node.right, rel, seen
            )
        if isinstance(node, ast.Name):
            if node.id in self.classes_by_name:
                return {node.id}
            key = (rel, node.id)
            if key in seen:
                self.unresolved += 1
                return set()
            value, target_rel = self._assignment(rel, node.id)
            if value is None:
                self.unresolved += 1
                return set()
            return self.resolve_expr(value, target_rel, seen | {key})
        if isinstance(node, ast.Attribute) and node.attr in self.classes_by_name:
            return {node.attr}
        self.unresolved += 1
        return set()

    def registered_classes(self):
        out = set()
        for rel, tree in self.trees.items():
            for node in ast.walk(tree):
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                if node.name != "get_node_list":
                    continue
                returns = [item for item in ast.walk(node) if isinstance(item, ast.Return)]
                for item in returns:
                    if isinstance(item.value, ast.Name):
                        out.update(self._resolve_local_collection(
                            node, item.value.id, rel
                        ))
                        out.update(self.resolve_expr(item.value, rel))
                    else:
                        out.update(self.resolve_expr(item.value, rel))
        return out

    def _resolve_local_collection(self, function, name, rel):
        """Resolve a get_node_list local list plus append/extend operations."""
        out = set()
        for item in ast.walk(function):
            if isinstance(item, (ast.Assign, ast.AnnAssign)):
                targets = item.targets if isinstance(item, ast.Assign) else [item.target]
                if any(isinstance(target, ast.Name) and target.id == name for target in targets):
                    out.update(self.resolve_expr(item.value, rel))
            if not (
                isinstance(item, ast.Call)
                and isinstance(item.func, ast.Attribute)
                and isinstance(item.func.value, ast.Name)
                and item.func.value.id == name
                and item.args
            ):
                continue
            if item.func.attr == "append":
                out.update(self.resolve_expr(item.args[0], rel))
            elif item.func.attr == "extend":
                out.update(self.resolve_expr(item.args[0], rel))
        return out


class _MappingResolver:
    """NODE_CLASS_MAPPINGS 的跨模块静态解析。"""

    def __init__(self, trees, classes_by_name):
        self.trees = trees
        self.classes_by_name = classes_by_name
        self.name_consts = {}
        self._const_cache = {}
        self.imports = {rel: self._import_map(tree, rel) for rel, tree in trees.items()}
        self.func_defs = {}
        for rel, tree in trees.items():
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    self.func_defs.setdefault(node.name, []).append((node, rel))
        self.unresolved = 0
        self._seen = set()

    def _import_map(self, tree, rel):
        out = {}
        base_dir = Path(rel).parent.as_posix()
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or not node.module:
                continue
            mod = node.module
            prefix = "" if base_dir == "." else base_dir
            mod_path = (prefix + "/" + mod.replace(".", "/")).strip("/")
            target_rel = None
            for cand in (f"{mod_path}.py", f"{mod_path}/__init__.py"):
                if cand in self.trees:
                    target_rel = cand
                    break
            if target_rel is None:
                continue
            for alias in node.names:
                if alias.name == "*":
                    continue
                out[alias.asname or alias.name] = (target_rel, alias.name)
        return out

    def _module_str_const(self, rel, name, depth=0):
        key = (rel, name)
        if key in self._const_cache:
            return self._const_cache[key]
        self._const_cache[key] = None
        value = None
        tree = self.trees.get(rel)
        if tree:
            for node in tree.body:
                targets = node.targets if isinstance(node, ast.Assign) else (
                    [node.target] if isinstance(node, ast.AnnAssign) and node.value else [])
                if any(isinstance(t, ast.Name) and t.id == name for t in targets):
                    value = self._eval_str(node.value, rel, depth=depth + 1)
                    break
        self._const_cache[key] = value
        return value

    def _eval_str(self, node, rel, env=None, depth=0):
        """小型常量折叠：字面量 / 常量名 / 加法拼接 / f-string / str.format /
        单返回值的仓内辅助函数（如 get_name）。解不出返回 None。"""
        if depth > 4 or node is None:
            return None
        env = env or {}
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.Name):
            if node.id in env:
                return env[node.id]
            return self._module_str_const(rel, node.id, depth)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left = self._eval_str(node.left, rel, env, depth + 1)
            right = self._eval_str(node.right, rel, env, depth + 1)
            if left is not None and right is not None:
                return left + right
            return None
        if isinstance(node, ast.JoinedStr):
            parts = []
            for piece in node.values:
                if isinstance(piece, ast.Constant):
                    parts.append(piece.value)
                elif isinstance(piece, ast.FormattedValue):
                    inner = self._eval_str(piece.value, rel, env, depth + 1)
                    if inner is None:
                        return None
                    parts.append(inner)
                else:
                    return None
            return "".join(parts)
        if isinstance(node, ast.Call):
            if (isinstance(node.func, ast.Attribute) and node.func.attr == "format"
                    and isinstance(node.func.value, ast.Constant)
                    and isinstance(node.func.value.value, str)):
                args = [self._eval_str(a, rel, env, depth + 1) for a in node.args]
                kwargs = {k.arg: self._eval_str(k.value, rel, env, depth + 1)
                          for k in node.keywords}
                if all(a is not None for a in args) and all(
                    v is not None for v in kwargs.values()
                ):
                    try:
                        return node.func.value.value.format(*args, **kwargs)
                    except (IndexError, KeyError):
                        return None
            func_name = node.func.id if isinstance(node.func, ast.Name) else None
            if func_name:
                hit, target_rel = None, rel
                for cand_node, cand_rel in self.func_defs.get(func_name, []):
                    if cand_rel == rel:
                        hit, target_rel = cand_node, rel
                        break
                if hit is None:
                    imp = self.imports.get(rel, {}).get(func_name)
                    if imp:
                        for cand_node, cand_rel in self.func_defs.get(func_name, []):
                            if cand_rel == imp[0]:
                                hit, target_rel = cand_node, imp[0]
                                break
                if (hit is not None and not hit.args.kwonlyargs
                        and hit.args.kwarg is None and not hit.args.defaults):
                    params = [a.arg for a in hit.args.args if a.arg != "self"]
                    call_args = [self._eval_str(a, rel, env, depth + 1) for a in node.args]
                    if len(call_args) == len(params) and all(
                        a is not None for a in call_args
                    ):
                        returns = [n for n in ast.walk(hit) if isinstance(n, ast.Return)]
                        if len(returns) == 1 and returns[0].value is not None:
                            return self._eval_str(
                                returns[0].value, target_rel,
                                dict(zip(params, call_args)), depth + 1)
        return None

    def _class_name_const(self, cls_name):
        if cls_name in self.name_consts:
            return self.name_consts[cls_name]
        value = None
        seen = set()
        current = cls_name
        while current and current not in seen:
            seen.add(current)
            hits = self.classes_by_name.get(current) or []
            if not hits:
                break
            node, rel = hits[0]
            for item in node.body:
                if isinstance(item, ast.Assign) and any(
                    isinstance(t, ast.Name) and t.id == "NAME" for t in item.targets
                ):
                    value = self._eval_str(item.value, rel)
                    break
            if value is None:
                current = _base_name(node)
            else:
                break
        self.name_consts[cls_name] = value
        return value

    def _class_attr_str(self, cls_name, attr_name):
        hits = self.classes_by_name.get(cls_name) or []
        values = []
        for node, rel in hits:
            for item in node.body:
                targets = item.targets if isinstance(item, ast.Assign) else (
                    [item.target] if isinstance(item, ast.AnnAssign) and item.value else []
                )
                if any(
                    isinstance(target, ast.Name) and target.id == attr_name
                    for target in targets
                ):
                    value = self._eval_str(item.value, rel)
                    if value is not None:
                        values.append(value)
        return values[0] if len(set(values)) == 1 else None

    def _key_str(self, node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if (isinstance(node, ast.Attribute) and node.attr == "NAME"
                and isinstance(node.value, ast.Name)):
            return self._class_name_const(node.value.id)
        if (
            isinstance(node, ast.Attribute)
            and node.attr == "value"
            and isinstance(node.value, ast.Attribute)
            and isinstance(node.value.value, ast.Name)
        ):
            return self._class_attr_str(node.value.value.id, node.value.attr)
        return None

    @staticmethod
    def _cls_name(node):
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return node.attr
        return None

    def _expand_var(self, rel, var, depth=0):
        """变量 -> Dict 节点（或 None）；沿同模块赋值与 import 链展开。"""
        if depth > 6 or (rel, var) in self._seen:
            return None
        self._seen.add((rel, var))
        tree = self.trees.get(rel)
        if tree is None:
            return None
        generated = self._generated_mapping_value(tree, var)
        if generated is not None:
            return generated
        for node in tree.body:
            targets = node.targets if isinstance(node, ast.Assign) else (
                [node.target] if isinstance(node, ast.AnnAssign) and node.value else [])
            for target in targets:
                if isinstance(target, ast.Name) and target.id == var:
                    return node.value
        target = self.imports.get(rel, {}).get(var)
        if target:
            return self._expand_var(target[0], target[1], depth + 1)
        return None

    @staticmethod
    def _generated_mapping_value(tree, var):
        """Resolve decorator-collected classes projected by a mapping helper."""
        container = None
        for node in tree.body:
            if not isinstance(node, (ast.Assign, ast.AnnAssign)):
                continue
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if not any(
                isinstance(target, (ast.Tuple, ast.List))
                and any(
                    isinstance(item, ast.Name) and item.id == var
                    for item in target.elts
                )
                for target in targets
            ):
                continue
            value = node.value
            func_name = value.func.id if isinstance(value, ast.Call) and isinstance(
                value.func, ast.Name
            ) else None
            if (
                func_name
                and "mapping" in func_name.casefold()
                and value.args
                and isinstance(value.args[0], ast.Name)
            ):
                container = value.args[0].id
                break
        if not container:
            return None

        wrappers = set()
        for node in tree.body:
            if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Call):
                continue
            if not (
                isinstance(node.value.func, ast.Name)
                and node.value.func.id in {"node_wrapper", "register_wrapper"}
                and node.value.args
                and isinstance(node.value.args[0], ast.Name)
                and node.value.args[0].id == container
            ):
                continue
            wrappers.update(
                target.id for target in node.targets if isinstance(target, ast.Name)
            )

        classes = []
        for node in tree.body:
            if not isinstance(node, ast.ClassDef):
                continue
            decorated = any(
                isinstance(decorator, ast.Name) and decorator.id in wrappers
                for decorator in node.decorator_list
            )
            has_custom_name = any(
                isinstance(item, (ast.Assign, ast.AnnAssign))
                and any(
                    isinstance(target, ast.Name) and target.id == "custom_name"
                    for target in (
                        item.targets if isinstance(item, ast.Assign) else [item.target]
                    )
                )
                for item in node.body
            )
            if decorated and has_custom_name:
                classes.append(node.name)
        return ast.Dict(
            keys=[ast.Constant(name) for name in classes],
            values=[ast.Name(id=name) for name in classes],
        )

    def _absorb_dict(self, dict_node, out):
        for k, v in zip(dict_node.keys, dict_node.values):
            if k is None:
                expanded = self._expand_value(v)
                if isinstance(expanded, ast.Dict):
                    self._absorb_dict(expanded, out)
                else:
                    self.unresolved += 1
                continue
            key = self._key_str(k)
            cls = self._cls_name(v)
            if key and cls:
                out[key] = cls
            else:
                self.unresolved += 1

    def _absorb_config_dict(self, dict_node, out):
        """Read ``class_type -> {"class": Class}`` registration tables.

        Some extensions build NODE_CLASS_MAPPINGS through a small helper that
        projects a richer config dictionary. We recognize only literal outer
        and inner dictionaries; no extension code is executed.
        """
        for key_node, config_node in zip(dict_node.keys, dict_node.values):
            key = self._key_str(key_node)
            if not key or not isinstance(config_node, ast.Dict):
                self.unresolved += 1
                continue
            cls = None
            for field_node, value_node in zip(config_node.keys, config_node.values):
                if self._key_str(field_node) == "class":
                    cls = self._cls_name(value_node)
                    break
            if cls:
                out[key] = cls
            else:
                self.unresolved += 1

    def _absorb_config_var(self, var, out):
        expanded = self._expand_var_current(var, 0)
        if isinstance(expanded, ast.Dict):
            self._absorb_config_dict(expanded, out)
        else:
            self.unresolved += 1
        for item in ast.walk(self._current_tree):
            if not (
                isinstance(item, ast.Call)
                and isinstance(item.func, ast.Attribute)
                and item.func.attr == "update"
                and isinstance(item.func.value, ast.Name)
                and item.func.value.id == var
            ):
                continue
            for arg in item.args:
                update = self._expand_value(arg)
                if isinstance(update, ast.Dict):
                    self._absorb_config_dict(update, out)
                else:
                    self.unresolved += 1

    def _expand_value(self, node, depth=0):
        if isinstance(node, ast.Dict):
            return node
        if isinstance(node, ast.Name) and depth <= 6:
            return self._expand_var_current(node.id, depth)
        return None

    def _expand_var_current(self, var, depth):
        generated = self._generated_mapping_value(self._current_tree, var)
        if generated is not None:
            return generated
        for node in self._current_tree.body:
            targets = node.targets if isinstance(node, ast.Assign) else (
                [node.target] if isinstance(node, ast.AnnAssign) and node.value else [])
            for target in targets:
                if isinstance(target, ast.Name) and target.id == var:
                    return self._expand_value(node.value, depth + 1)
        target = self._current_imports.get(var)
        if target and target[0] in self.trees:
            saved_tree, saved_imports = self._current_tree, self._current_imports
            self._current_tree = self.trees[target[0]]
            self._current_imports = self.imports.get(target[0], {})
            try:
                return self._expand_var_current(target[1], depth + 1)
            finally:
                self._current_tree, self._current_imports = saved_tree, saved_imports
        return None

    def resolve_module(self, rel, tree):
        self._current_tree = tree
        self._current_imports = self.imports.get(rel, {})
        out = {}
        for node in tree.body:
            targets = node.targets if isinstance(node, ast.Assign) else (
                [node.target] if isinstance(node, ast.AnnAssign) and node.value else [])
            for target in targets:
                if isinstance(target, ast.Name) and target.id == "NODE_CLASS_MAPPINGS":
                    expanded = self._expand_value(node.value)
                    if isinstance(expanded, ast.Dict):
                        self._absorb_dict(expanded, out)
                    else:
                        self.unresolved += 1
                if (
                    isinstance(target, (ast.Tuple, ast.List))
                    and any(
                        isinstance(item, ast.Name)
                        and item.id == "NODE_CLASS_MAPPINGS"
                        for item in target.elts
                    )
                    and isinstance(node.value, ast.Call)
                    and isinstance(node.value.func, ast.Name)
                    and "mapping" in node.value.func.id.casefold()
                    and node.value.args
                    and isinstance(node.value.args[0], ast.Name)
                ):
                    self._absorb_config_var(node.value.args[0].id, out)
        for node in ast.walk(tree):
            if (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                    and isinstance(node.value.func, ast.Attribute)
                    and node.value.func.attr == "update"
                    and isinstance(node.value.func.value, ast.Name)
                    and node.value.func.value.id == "NODE_CLASS_MAPPINGS"):
                for arg in node.value.args:
                    expanded = self._expand_value(arg)
                    if isinstance(expanded, ast.Dict):
                        self._absorb_dict(expanded, out)
                    else:
                        self.unresolved += 1
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if (isinstance(target, ast.Subscript)
                            and isinstance(target.value, ast.Name)
                            and target.value.id == "NODE_CLASS_MAPPINGS"):
                        key = self._key_str(target.slice)
                        cls = self._cls_name(node.value)
                        if key and cls:
                            out[key] = cls
                        else:
                            self.unresolved += 1
        return out


def extract_repo(repo_dir: Path, slug: str) -> dict:
    trees, classes_by_name = {}, {}
    py_files = sorted(repo_dir.rglob("*.py"))
    for path in py_files:
        rel = path.relative_to(repo_dir).as_posix()
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError:
            continue
        trees[rel] = tree
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                classes_by_name.setdefault(node.name, []).append((node, rel))

    resolver = _MappingResolver(trees, classes_by_name)
    mappings, v3_modules = {}, []
    for rel, tree in trees.items():
        found = resolver.resolve_module(rel, tree)
        for ct, cls in found.items():
            mappings.setdefault(ct, cls)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                mod = getattr(node, "module", "") or ""
                names = [a.name for a in node.names]
                if mod.startswith("comfy_api") or any(n.startswith("comfy_api") for n in names):
                    v3_modules.append(rel)
                    break

    records = {}
    v3_mapped_schema_records = 0
    v3_mapped_execute_records = 0
    for ct, cls_name in sorted(mappings.items()):
        chain = _class_chain(cls_name, classes_by_name)
        if not chain:
            records[ct] = {"repo": slug, "class": cls_name, "resolved_level": "class_not_found"}
            continue
        inputs, input_level = {}, "no_input_types"
        func = _find_method(chain, "INPUT_TYPES")
        if func is not None:
            inputs, input_level = _input_types_from(func)
        r_types, r_names = _return_types_from(chain)
        record = {
            "repo": slug,
            "class": cls_name,
            "file": next((r for n, r in classes_by_name.get(cls_name, [])), None),
            "inputs": inputs,
            "input_level": input_level if func is not None else "no_input_types",
            "return_types": r_types,
            "return_names": r_names,
            "function": _class_attr(chain, "FUNCTION"),
            "resolved_level": input_level if func is not None else "interface_unavailable",
        }
        # ComfyUI V3 nodes may still be exported through NODE_CLASS_MAPPINGS.
        # Prefer their declarative schema when its node_id confirms the same
        # registration key. This preserves strict class_type provenance while
        # recovering the explicit ``execute`` entry point and typed ports.
        cls_file = record["file"]
        node_id, v3_record, _ = _v3_schema_record(
            chain[0], cls_file, slug, registration="NODE_CLASS_MAPPINGS"
        )
        if v3_record is not None and node_id == ct:
            record = v3_record
            v3_mapped_schema_records += 1
        elif (_find_method(chain, "define_schema") is not None
              and _find_method(chain, "execute") is not None):
            # A dynamic schema cannot supply ports without executing extension
            # code, but the V3 execution method itself remains direct evidence.
            record["function"] = "execute"
            record["api_version"] = "v3"
            record["registration"] = "NODE_CLASS_MAPPINGS"
            v3_mapped_execute_records += 1
        records[ct] = record

    v3_resolver = _V3RegistrationResolver(trees, resolver.imports, classes_by_name)
    v3_registered = v3_resolver.registered_classes()
    v3_schema_records = v3_mapped_schema_records
    v3_schema_unresolved = 0
    for cls_name in sorted(v3_registered):
        hits = classes_by_name.get(cls_name) or []
        if not hits:
            v3_schema_unresolved += 1
            continue
        candidates = []
        for cls_node, rel in hits:
            node_id, record, error = _v3_schema_record(cls_node, rel, slug)
            if record is not None:
                candidates.append((node_id, record))
            elif error != "no_schema":
                v3_schema_unresolved += 1
        # The same Python class name in multiple modules is ambiguous. Keep it
        # unresolved instead of selecting one by traversal order.
        if len(candidates) != 1:
            if candidates:
                v3_schema_unresolved += 1
            continue
        node_id, record = candidates[0]
        if node_id not in records:
            records[node_id] = record
            v3_schema_records += 1
    return {
        "repo": slug,
        "py_files": len(py_files),
        "parsed_modules": len(trees),
        "mapped_class_types": len(records),
        "legacy_mapped_class_types": len(mappings),
        "unresolved_mapping_entries": resolver.unresolved,
        "v3_modules": sorted(set(v3_modules)),
        "v3_registered_classes": len(v3_registered),
        "v3_schema_records": v3_schema_records,
        "v3_mapped_schema_records": v3_mapped_schema_records,
        "v3_mapped_execute_records": v3_mapped_execute_records,
        "v3_unresolved_entries": v3_resolver.unresolved + v3_schema_unresolved,
        "records": records,
    }


def _extract_one(slug: str, defs_dir: Path, workdir: Path, refresh: bool):
    cache_path = defs_dir / (slug.replace("/", "__") + ".json")
    if cache_path.exists() and not refresh:
        return slug, load_json(cache_path), None
    repo_dir = fetch_repo(slug, workdir, refresh)
    if repo_dir is None:
        return slug, None, "fetch_failed"
    data = extract_repo(repo_dir, slug)
    save_json(cache_path, data)
    return slug, data, None


def definition_id(slug: str, class_type: str) -> str:
    """Stable identity for definitions whose class_type collides across repos."""
    return f"{slug}::{class_type}"


def merge_repo_definitions(repo_data: dict[str, dict]) -> dict:
    """Deterministically merge per-repository extraction results.

    ``definitions`` is lossless and keyed by ``(repo, class_type)``.  The
    legacy ``records`` view remains for existing report consumers, but its
    canonical definition is selected by sorted repository name rather than
    thread completion order.
    """
    definitions = {}
    class_type_index = {}
    for slug in sorted(repo_data):
        data = repo_data[slug]
        records = data.get("records", {}) if isinstance(data, dict) else {}
        if not isinstance(records, dict):
            continue
        for class_type in sorted(records):
            raw = records[class_type]
            if not isinstance(raw, dict):
                continue
            did = definition_id(slug, str(class_type))
            record = dict(raw)
            record["repo"] = slug
            record["class_type"] = str(class_type)
            record["definition_id"] = did
            definitions[did] = record
            class_type_index.setdefault(str(class_type), []).append(did)

    records = {
        class_type: dict(definitions[definition_ids[0]])
        for class_type, definition_ids in sorted(class_type_index.items())
    }
    collisions = {
        class_type: definition_ids
        for class_type, definition_ids in class_type_index.items()
        if len(definition_ids) > 1
    }
    return {
        "schema_version": 2,
        "definitions": definitions,
        "class_type_index": dict(sorted(class_type_index.items())),
        "records": records,
        "collisions": dict(sorted(collisions.items())),
    }


def fetch_and_extract(slugs, workdir: Path, refresh: bool = False,
                      workers: int = DEFAULT_WORKERS) -> dict:
    defs_dir = ensure_dir(workdir / "defs")
    failures = []
    repo_data = {}
    done = 0

    def report_progress(slug, data, err):
        nonlocal done
        done += 1
        if err:
            log(f"[extract] ({done}/{len(slugs)}) {slug}: {err}")
        else:
            log(f"[extract] ({done}/{len(slugs)}) {slug}: "
                f"{data['mapped_class_types']} class_types")

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_extract_one, slug, defs_dir, workdir, refresh): slug
            for slug in sorted(slugs)
        }
        for fut in as_completed(futures):
            requested_slug = futures[fut]
            try:
                slug, data, err = fut.result()
            except Exception as exc:  # noqa: BLE001 - 单仓异常不阻断整批
                done += 1
                failures.append(requested_slug)
                log(f"[extract] {requested_slug}: 异常: {exc}")
                continue
            report_progress(slug, data, err)
            if err:
                failures.append(slug)
                continue
            repo_data[slug] = data

    # Rebuild from every per-repository cache. A targeted extraction must add
    # to the audit universe rather than replace the aggregate with only the
    # repositories named in this invocation.
    result = rebuild_from_cache(workdir, invalidated_repos=set(repo_data))
    previous_failures = set(result.get("repos_failed") or ())
    successful = set(repo_data)
    result.update({
        "repos_requested": max(
            int(result.get("repos_requested") or 0),
            len(list((workdir / "defs").glob("*.json"))) + len(failures),
        ),
        "repos_failed": sorted((previous_failures - successful) | set(failures)),
    })
    save_json(workdir / "node_defs.json", result)
    log(
        f"[extract] 合计 {len(result['definitions'])} 个定义 / "
        f"{len(result['records'])} 个 class_type / "
        f"{len(result['collisions'])} 个同名冲突，失败仓库 {len(failures)}"
    )
    return result


def rebuild_from_cache(
    workdir: Path,
    invalidated_repos: set[str] | None = None,
) -> dict:
    """Rebuild the v2 aggregate from per-repository JSON without network IO."""
    defs_dir = ensure_dir(workdir / "defs")
    repo_data = {}
    for path in sorted(defs_dir.glob("*.json")):
        try:
            data = load_json(path)
        except Exception as exc:  # noqa: BLE001 - one bad cache must not hide the rest
            log(f"[extract][cache] {path.name}: {exc}")
            continue
        slug = data.get("repo") if isinstance(data, dict) else None
        if isinstance(slug, str) and slug:
            repo_data[slug] = data

    previous = {}
    aggregate_path = workdir / "node_defs.json"
    if aggregate_path.exists():
        try:
            previous = load_json(aggregate_path)
        except Exception:  # noqa: BLE001 - cache rebuild remains possible
            previous = {}
    result = merge_repo_definitions(repo_data)
    previous_definitions = previous.get("definitions")
    if isinstance(previous_definitions, dict):
        invalidated_repos = invalidated_repos or set()
        for definition_id, definition in result["definitions"].items():
            if definition.get("repo") in invalidated_repos:
                continue
            old = previous_definitions.get(definition_id)
            if not isinstance(old, dict):
                continue
            if isinstance(old.get("fingerprint"), dict):
                definition["fingerprint"] = old["fingerprint"]
            if isinstance(old.get("semantic"), dict):
                definition["semantic"] = old["semantic"]
        result["records"] = {
            class_type: dict(result["definitions"][definition_ids[0]])
            for class_type, definition_ids in sorted(
                result["class_type_index"].items()
            )
            if definition_ids
        }
    result.update({
        "repos_requested": max(
            int(previous.get("repos_requested") or 0),
            len(repo_data) + len(previous.get("repos_failed") or []),
        ),
        "repos_failed": sorted(previous.get("repos_failed") or []),
        "repos_zero_mapped": sorted(
            slug
            for slug, data in repo_data.items()
            if int(data.get("mapped_class_types") or 0) == 0
        ),
    })
    save_json(aggregate_path, result)
    log(
        f"[extract][cache] {len(repo_data)} 仓库 -> "
        f"{len(result['definitions'])} 定义 / {len(result['records'])} class_type / "
        f"{len(result['collisions'])} 冲突"
    )
    return result


def reanalyze_local_repos(
    workdir: Path,
    selected_repos: set[str] | None = None,
) -> dict:
    """Re-run static extraction for already downloaded repositories only."""
    defs_dir = ensure_dir(workdir / "defs")
    repos_dir = workdir / "repos"
    analyzed, missing, available = 0, [], set()
    for cache_path in sorted(defs_dir.glob("*.json")):
        try:
            cached = load_json(cache_path)
        except Exception as exc:  # noqa: BLE001 - report and continue
            log(f"[extract][reanalyze] {cache_path.name}: {exc}")
            continue
        slug = cached.get("repo") if isinstance(cached, dict) else None
        if not isinstance(slug, str) or not slug:
            continue
        available.add(slug)
        if selected_repos is not None and slug not in selected_repos:
            continue
        repo_dir = repos_dir / slug.replace("/", "__")
        if not repo_dir.is_dir():
            missing.append(slug)
            continue
        data = extract_repo(repo_dir, slug)
        save_json(cache_path, data)
        analyzed += 1
        log(
            f"[extract][reanalyze] ({analyzed}) {slug}: "
            f"{data['mapped_class_types']} class_types "
            f"(v3 {data['v3_schema_records']})"
        )
    result = rebuild_from_cache(
        workdir,
        invalidated_repos={
            slug for slug in available
            if selected_repos is None or slug in selected_repos
        } - set(missing),
    )
    result["repos_reanalyzed"] = analyzed
    result["repos_missing_source"] = sorted(missing)
    if selected_repos is not None:
        result["repos_reanalyze_not_cached"] = sorted(selected_repos - available)
    save_json(workdir / "node_defs.json", result)
    return result
