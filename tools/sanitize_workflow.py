#!/usr/bin/env python3
"""workflow 元数据脱敏工具 —— 无法解析/外发前的样本清理(issue 附件场景, 对应 DEVELOPER_GUIDE §5.6)。

三级匹配引擎(自动降级):
  L1 结构化    元数据为合法 JSON 时递归定位字段, 输出重序列化
  L2 字段正则  残缺 JSON 按 "<field>": <value> 文法定位值区域后原地替换
  L3 全文正则  无键值结构或规则未写字段时, 正则作用于全部字符串字面量;
               文本连字符串字面量都没有时退化为整段原文替换
带字段的规则全程未定位到字段且带有正则时, 自动降级为 L3 并在报告中标注"已降级"。

每条规则的 pattern 支持不定长列表: 合并为单个交替式一次遍历, 以同一 replace 统一脱敏。
括号扩展开开后, 命中范围扩展到所在最小完整括号单元(() 与 [] 均可、计嵌套深度),
随后清理残留的双逗号/悬空逗号, 使 "a, (hina_(blue_archive):1.2), b" 整单元消失。
整值脱敏传播: 字段规则整值替换过的字符串字面量(>=4 字符), 在同一输入的后续
处理中按原字面量自动清扫一次 —— UI 格式 widgets_values 的无名位置副本同样命中。
对照表(--report PATH, - 为 stdout): 按单元/规则/位置/脱敏前/脱敏后 列出每次替换
(完全相同的行聚合计数); 位置为字段点路径, <embed> 表示内嵌 JSON 字符串内部,
<全文> 为无键值上下文, <传播> 为字面量清扫命中; 支持 md(默认)/tsv。

用法:
  扫描疑似敏感字段(无法解析时先看里面有什么):
    python tools/sanitize_workflow.py <输入...> --scan [--format json] [--rules-from-scan OUT.json]
  快捷单规则(--regex 可重复追加构成多正则列表):
    python tools/sanitize_workflow.py <输入...> --field text --regex "foo" --regex "bar" --replace "<masked>" --expand-brackets
  规则文件 + 内置预设:
    python tools/sanitize_workflow.py <输入...> --rules rules.json --presets paths,users -o out/
  试运行(只打印命中报告, 不写文件):
    python tools/sanitize_workflow.py <输入...> --field ckpt_name --dry-run
  输出脱敏前后字段/值对照表(审计用):
    python tools/sanitize_workflow.py <输入...> --field text --report out.md [--report-format tsv]

规则文件格式(JSON 数组):
  [{"field": "...", "patterns": ["...", ...], "replace": "<masked>", "flags": "i", "expand": true}, ...]
  field 与 pattern/patterns 至少其一; "pattern" 是单元素 patterns 的简写;
  replace 支持 \\g<name> 反向引用(name 为命名组或编号, 编号在多正则合并后按合并顺序计);
  写回字符串前对替换文本转义 \\ 与 ", 保证 JSON 完整性; 未给 replace 默认 "<masked>"。

输入: PNG(tEXt/zTXt/iTXt 块级改写, 图像数据字节不变, 脱敏后仍复现原解析行为)
      与 .json/.txt 纯文本。目录输入自动递归收集这两类文件。
输出: 默认写 <name>.sanitized.<ext> 到原目录; -o 指定输出目录; --in-place 原地覆盖;
      --dry-run 不写任何文件。
退出码: 0 有命中成功 / 3 零命中 / 1 错误; 扫描模式正常完成即 0。
内置预设(默认关闭, --presets 启用): paths 盘符/UNC/POSIX 绝对路径 -> <path>;
      users 用户名段(user(s)/profile 目录后的首段)替换为 <user>。
局限: 不处理 webp/jpg 元数据; L2/L3 属启发式层, 极端残缺文本以报告为准。
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import sys
import zlib
from dataclasses import dataclass, field as dc_field
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="backslashreplace")

DEFAULT_REPLACE = "<masked>"
TEXT_EXTS = {".json", ".txt"}
SCAN_EXTS = {".png"} | TEXT_EXTS
FLAG_MAP = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}
TEMPLATE_REF_RE = re.compile(r"\\g<([^>]+)>")
FIELD_VALUE_TMPL = '"%s"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|[^,}\\]\\n]+)'
STRING_SPAN_RE = re.compile(r'"(?:[^"\\]|\\.)*"', re.DOTALL)
KEY_SCAN_RE = re.compile(r'"((?:[^"\\]|\\.)+)"\s*:\s*("(?:[^"\\]|\\.)*"|[^,}\]\n]+)?')
PROMPT_KEY_HINTS = ("text", "prompt", "title", "comment", "caption", "description", "uc")
MODEL_KEY_HINTS = (
    "ckpt_name", "unet_name", "vae_name", "clip_name", "lora_name",
    "control_net_name", "model_name", "model", "checkpoint",
)
NUMERIC_KEY_HINTS = ("seed", "noise_seed", "steps", "cfg", "denoise", "width", "height", "batch_size")
PATH_VALUE_RE = re.compile(r"([A-Za-z]:[/\\]|\\\\|/(?:home|Users|mnt|data)/|%USERPROFILE%|%APPDATA%)")
MODEL_SUFFIXES = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft")
TAG_RANK = {"疑似prompt文本": 0, "疑似路径": 1, "疑似模型名": 2, "数值参数": 3}
EMBED_JSON_DEPTH = 2


class ToolError(Exception):
    pass


@dataclass
class Rule:
    name: str
    field: str | None
    patterns: tuple[str, ...]
    replace: str = DEFAULT_REPLACE
    flags: str = ""
    expand: bool = False
    compiled: re.Pattern | None = None
    located: int = 0
    hits: int = 0
    degraded: bool = False
    masked_pairs: list = dc_field(default_factory=list)


@dataclass
class FieldStat:
    label: str
    count: int = 0
    kinds: set = dc_field(default_factory=set)
    max_len: int = 0
    preview: str = ""
    tags: set = dc_field(default_factory=set)


@dataclass
class MaskRecord:
    unit: str
    rule: str
    location: str
    before: str
    after: str


def brief(s: str, limit: int = 48) -> str:
    s = s.replace("\r", "").replace("\n", "\\n")
    return s if len(s) <= limit else s[: limit - 1] + "…"


def record_mask(ledger, unit: str, rule: str, location: str, before: str, after: str) -> None:
    if ledger is not None:
        ledger.append(MaskRecord(unit, rule, location, brief(before), brief(after)))


def aggregate_ledger(ledger: list[MaskRecord]) -> dict:
    order: dict = {}
    for r in ledger:
        key = (r.unit, r.rule, r.location, r.before, r.after)
        order[key] = order.get(key, 0) + 1
    return order


def md_cell(s: str) -> str:
    return s.replace("|", "\\|")


def render_ledger(ledger: list[MaskRecord], fmt: str) -> str:
    agg = aggregate_ledger(ledger)
    if fmt == "tsv":
        lines = ["unit\trule\tlocation\tbefore\tafter\tcount"]
        for (u, r, l, b, a), n in agg.items():
            lines.append(f"{u}\t{r}\t{l}\t{b}\t{a}\t{n}")
        return "\n".join(lines) + "\n"
    if not agg:
        return "(无脱敏记录)\n"
    head = "| 单元 | 规则 | 位置 | 脱敏前 | 脱敏后 | 次数 |\n|---|---|---|---|---|---|\n"
    rows = "".join(
        f"| {md_cell(u)} | {md_cell(r)} | {md_cell(l)} | {md_cell(b)} | {md_cell(a)} | {n} |\n"
        for (u, r, l, b, a), n in agg.items()
    )
    return head + rows


def log(msg: str) -> None:
    print(msg, flush=True)


def json_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def esc_domain(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)[1:-1]


def capture_pair(rule: Rule, before: str, after: str) -> None:
    if len(before) >= 4 and before != after and len(rule.masked_pairs) < 4000:
        rule.masked_pairs.append((before, after))


def kind_of(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, str):
        return "str"
    if isinstance(v, (int, float)):
        return "num"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def parse_flags(spec: str) -> int:
    out = 0
    for ch in spec:
        if ch not in FLAG_MAP:
            raise ToolError(f"未知正则标志 {ch!r}(支持 i/m/s)")
        out |= FLAG_MAP[ch]
    return out


def compile_rule(rule: Rule) -> Rule:
    if rule.patterns:
        src = "|".join(f"(?:{p})" for p in rule.patterns)
        try:
            rule.compiled = re.compile(src, parse_flags(rule.flags))
        except re.error as exc:
            raise ToolError(f"规则 {rule.name} 正则编译失败: {exc}") from exc
        for ref in TEMPLATE_REF_RE.findall(rule.replace):
            if ref.isdigit():
                if int(ref) > rule.compiled.groups:
                    raise ToolError(f"规则 {rule.name} 的 replace 引用了不存在的编号组 \\g<{ref}>")
            elif ref not in rule.compiled.groupindex:
                raise ToolError(f"规则 {rule.name} 的 replace 引用了未定义命名组 {ref!r}")
    return rule


def build_rules(entries: list[dict], source: str) -> list[Rule]:
    rules: list[Rule] = []
    known = {"field", "pattern", "patterns", "replace", "flags", "expand"}
    for i, raw in enumerate(entries):
        if not isinstance(raw, dict):
            raise ToolError(f"{source} 第 {i} 条规则不是对象")
        unknown = set(raw) - known
        if unknown:
            raise ToolError(f"{source} 第 {i} 条规则含未知键: {sorted(unknown)}")
        fld = raw.get("field")
        pats = raw.get("patterns")
        if pats is None and raw.get("pattern") is not None:
            pats = [raw["pattern"]]
        if pats is not None:
            if isinstance(pats, str):
                pats = [pats]
            if not isinstance(pats, list) or not all(isinstance(p, str) for p in pats):
                raise ToolError(f"{source} 第 {i} 条规则 patterns 须为字符串或字符串数组")
        if not fld and not pats:
            raise ToolError(f"{source} 第 {i} 条规则 field 与 pattern(s) 至少其一")
        if fld is not None and not isinstance(fld, str):
            raise ToolError(f"{source} 第 {i} 条规则 field 须为字符串")
        rules.append(
            compile_rule(
                Rule(
                    name=fld or f"#{i + 1}",
                    field=fld,
                    patterns=tuple(pats) if pats else (),
                    replace=raw.get("replace", DEFAULT_REPLACE),
                    flags=raw.get("flags", ""),
                    expand=bool(raw.get("expand", False)),
                )
            )
        )
    return rules


PRESET_DEFS: dict[str, dict] = {
    "paths": {
        "patterns": [
            r"[A-Za-z]:[/\\][^\",\n]*",
            r"\\\\[^\",\n]*",
            r"/(?:home|Users|mnt|data)/[^\",\n]*",
        ],
        "replace": "<path>",
        "flags": "",
    },
    "users": {
        "patterns": [r"((?:user|users|profile)[/\\]+)[^/\",\]]*"],
        "replace": "\\g<1><user>",
        "flags": "i",
    },
}


def preset_rules(spec: str) -> list[Rule]:
    rules: list[Rule] = []
    for name in [s.strip() for s in spec.split(",") if s.strip()]:
        if name not in PRESET_DEFS:
            raise ToolError(f"未知预设 {name!r}(可用: {', '.join(sorted(PRESET_DEFS))})")
        cfg = PRESET_DEFS[name]
        rules.append(
            compile_rule(
                Rule(
                    name=f"preset:{name}",
                    field=None,
                    patterns=tuple(cfg["patterns"]),
                    replace=cfg["replace"],
                    flags=cfg.get("flags", ""),
                )
            )
        )
    return rules


def render_replace(template: str, m: re.Match, escape_literal: bool = True) -> str:
    out: list[str] = []
    buf: list[str] = []

    def flush() -> None:
        if buf:
            piece = "".join(buf)
            out.append(json_escape(piece) if escape_literal else piece)
            buf.clear()

    i = 0
    while i < len(template):
        ref = TEMPLATE_REF_RE.match(template, i)
        if ref:
            flush()
            name = ref.group(1)
            val = m.group(int(name) if name.isdigit() else name)
            out.append(val if val is not None else "")
            i = ref.end()
        else:
            buf.append(template[i])
            i += 1
    flush()
    return "".join(out)


def balanced_end(s: str, open_pos: int) -> int | None:
    oc = s[open_pos]
    cc = ")" if oc == "(" else "]"
    depth = 0
    for j in range(open_pos, len(s)):
        ch = s[j]
        if ch == oc:
            depth += 1
        elif ch == cc:
            depth -= 1
            if depth == 0:
                return j + 1
    return None


def absorb_suffix_groups(s: str, pos: int) -> int:
    while pos < len(s):
        j = pos
        if s[j] == "_":
            j += 1
        if j < len(s) and s[j] in "([":
            end = balanced_end(s, j)
            if end is None:
                break
            pos = end
        else:
            break
    return pos


def expand_span(s: str, start: int, end: int) -> tuple[int, int]:
    depth = 0
    open_pos = -1
    i = start - 1
    while i >= 0:
        ch = s[i]
        if ch in ")]":
            depth += 1
        elif ch in "([":
            if depth == 0:
                open_pos = i
                break
            depth -= 1
        i -= 1
    if open_pos < 0:
        return start, end
    oc = s[open_pos]
    cc = ")" if oc == "(" else "]"
    depth = 0
    j = end
    while j < len(s):
        ch = s[j]
        if ch == oc:
            depth += 1
        elif ch == cc:
            if depth == 0:
                return open_pos, j + 1
            depth -= 1
        j += 1
    return start, end


def cleanup_separators(s: str) -> str:
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r"[ \t]*,[ \t]*,[ \t]*", ", ", s)
    s = re.sub(r"^[\s,]+", "", s)
    s = re.sub(r"[\s,]+$", "", s)
    return s


def sub_in_window(
    text: str, lo: int, hi: int, rule: Rule, escape: bool = True, on_hit=None
) -> tuple[str, int]:
    win = text[lo:hi]
    if not rule.compiled:
        return win, 0
    pieces: list[str] = []
    last = 0
    n = 0
    cleaned = False
    for m in rule.compiled.finditer(win):
        a, b = m.span()
        if a == b:
            continue
        ea, eb = (a, b)
        if escape:
            j = eb
            while j > ea and win[j - 1] == "\\":
                j -= 1
            if (eb - j) % 2 == 1:
                eb = j
                if eb <= ea:
                    continue
        if rule.expand:
            ea, eb = expand_span(win, a, b)
            eb = absorb_suffix_groups(win, eb)
            if (ea, eb) != (a, b):
                cleaned = True
        repl = render_replace(rule.replace, m, escape_literal=escape)
        pieces.append(win[last:ea])
        pieces.append(repl)
        last = eb
        n += 1
        if on_hit:
            on_hit(win[ea:eb], repl)
    if n == 0:
        return win, 0
    pieces.append(win[last:])
    new = "".join(pieces)
    if cleaned:
        new = cleanup_separators(new)
    rule.hits += n
    return new, n


def iter_string_spans(text: str) -> list[tuple[int, int]]:
    return [(m.start() + 1, m.end() - 1) for m in STRING_SPAN_RE.finditer(text)]


UNESCAPED_QUOTE_RE = re.compile(r'(?<!\\)"')
STRUCTURE_CHARS_RE = re.compile(r"[{}\[\]:]")


def _clean_fragment(out: str, lo: int, hi: int, rule: Rule, on_hit) -> str:
    return sub_in_window(out, lo, hi, rule, on_hit=on_hit)[0]


def apply_fulltext(text: str, rule: Rule, ledger=None, unit: str = "", location: str = "<全文>") -> str:
    on_hit = (lambda b, a: record_mask(ledger, unit, rule.name, location, b, a)) if ledger is not None else None
    if rule.compiled and not rule.compiled.search(text):
        return text
    spans = iter_string_spans(text)
    if not spans:
        return "\n".join(
            sub_in_window(line, 0, len(line), rule, on_hit=on_hit)[0] for line in text.split("\n")
        )
    segments: list[tuple[str, int, int]] = []
    prev_end = 0
    for lo, hi in spans:
        if lo > prev_end:
            segments.append(("gap", prev_end, lo))
        segments.append(("span", lo, hi))
        prev_end = hi
    segments.append(("tail", prev_end, len(text)))

    pieces: list[str] = []
    cursor = 0
    for kind, lo, hi in segments:
        win = text[lo:hi]
        if kind == "tail":
            quotes = list(UNESCAPED_QUOTE_RE.finditer(win))
            start = quotes[-1].end() if quotes else 0
            if start >= len(win):
                continue
            new_win = _clean_fragment(text, lo + start, hi, rule, on_hit)
            if new_win != win[start:]:
                if lo + start > cursor:
                    pieces.append(text[cursor:lo + start])
                pieces.append(new_win)
                cursor = hi
            continue
        if kind == "gap":
            if not win.strip() or STRUCTURE_CHARS_RE.search(win):
                continue
        new_win = _clean_fragment(text, lo, hi, rule, on_hit)
        if new_win != win:
            if lo > cursor:
                pieces.append(text[cursor:lo])
            pieces.append(new_win)
            cursor = hi
    pieces.append(text[cursor:])
    return "".join(pieces)


def mask_token(token: str, rule: Rule, ledger=None, unit: str = "", location: str | None = None) -> str:
    rule.located += 1
    loc = location or f"field:{rule.field}"
    stripped = token.strip()
    if not stripped.startswith('"'):
        rule.hits += 1
        record_mask(ledger, unit, rule.name, loc, stripped, rule.replace)
        return json.dumps(rule.replace, ensure_ascii=False)
    inner = stripped[1:-1]
    if rule.compiled:
        on_hit = (lambda b, a: record_mask(ledger, unit, rule.name, loc, b, a)) if ledger is not None else None
        new_inner, _ = sub_in_window(inner, 0, len(inner), rule, on_hit=on_hit)
        if new_inner != inner:
            capture_pair(rule, inner, new_inner)
        return '"' + new_inner + '"'
    capture_pair(rule, inner, esc_domain(rule.replace))
    rule.hits += 1
    record_mask(ledger, unit, rule.name, loc, inner, rule.replace)
    return json.dumps(rule.replace, ensure_ascii=False)


def make_field_regex(fname: str) -> re.Pattern:
    return re.compile(FIELD_VALUE_TMPL % re.escape(fname))


def l2_apply(text: str, rule: Rule, ledger=None, unit: str = "") -> str:
    rx = make_field_regex(rule.field)
    out = text
    delta = 0
    for m in rx.finditer(text):
        token_start = m.start(1) + delta
        token_end = m.end(1) + delta
        new_token = mask_token(m.group(1), rule, ledger, unit)
        out = out[:token_start] + new_token + out[token_end:]
        delta += len(new_token) - (token_end - token_start)
    return out


def l1_mask_string(s: str, rule: Rule, ledger=None, unit: str = "", location: str = "") -> str:
    if rule.compiled:
        new, _ = sub_in_window(s, 0, len(s), rule, escape=False)
        if new != s:
            capture_pair(rule, esc_domain(s), esc_domain(new))
            record_mask(ledger, unit, rule.name, location, s, new)
        return new
    capture_pair(rule, esc_domain(s), esc_domain(rule.replace))
    rule.hits += 1
    record_mask(ledger, unit, rule.name, location, s, rule.replace)
    return rule.replace


def maybe_embed_walk(
    s: str,
    field_rules: list[Rule],
    loose_rules: list[Rule],
    depth: int,
    path: str,
    ledger,
    unit: str,
) -> str | None:
    if depth >= EMBED_JSON_DEPTH or s.lstrip()[:1] not in "{[":
        return None
    try:
        parsed = json.loads(s)
    except (json.JSONDecodeError, ValueError):
        return None
    return json.dumps(
        l1_walk(parsed, field_rules, loose_rules, depth + 1, f"{path}<embed>", ledger, unit),
        ensure_ascii=False,
        separators=(",", ":"),
    )


def l1_walk(obj, field_rules: list[Rule], loose_rules: list[Rule], depth: int = 0, path: str = "", ledger=None, unit: str = ""):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            child = f"{path}.{k}" if path else str(k)
            targeted = next((r for r in field_rules if r.field == k), None)
            if targeted is not None:
                targeted.located += 1
                out[k] = l1_transform_value(v, targeted, field_rules, loose_rules, depth, child, ledger, unit)
            else:
                out[k] = l1_walk(v, field_rules, loose_rules, depth, child, ledger, unit)
        return out
    if isinstance(obj, list):
        return [l1_walk(item, field_rules, loose_rules, depth, f"{path}[{i}]", ledger, unit) for i, item in enumerate(obj)]
    if isinstance(obj, str):
        embedded = maybe_embed_walk(obj, field_rules, loose_rules, depth, path, ledger, unit)
        if embedded is not None:
            return embedded
        for r in loose_rules:
            obj = l1_mask_string(obj, r, ledger, unit, path)
        return obj
    return obj


def l1_transform_value(v, targeted: Rule, field_rules: list[Rule], loose_rules: list[Rule], depth: int, path: str, ledger, unit: str):
    if isinstance(v, str):
        embedded = maybe_embed_walk(v, field_rules, loose_rules, depth, path, ledger, unit)
        if embedded is not None:
            return embedded
        v = l1_mask_string(v, targeted, ledger, unit, path)
        for r in loose_rules:
            v = l1_mask_string(v, r, ledger, unit, path)
        return v
    if isinstance(v, list):
        return [
            l1_transform_value(item, targeted, field_rules, loose_rules, depth, f"{path}[{i}]", ledger, unit)
            if isinstance(item, (str, list))
            else item
            for i, item in enumerate(v)
        ]
    if v is None or isinstance(v, (bool, int, float)):
        targeted.hits += 1
        record_mask(ledger, unit, targeted.name, path, json.dumps(v), targeted.replace)
        return targeted.replace
    return l1_walk(v, [], loose_rules, depth, path, ledger, unit)


def sweep_literals(text: str, rules: list[Rule], ledger=None, unit: str = "") -> str:
    for r in rules:
        seen: dict[str, str] = {}
        for before, after in r.masked_pairs:
            if len(before) >= 4 and before != after:
                seen[before] = after
        if not seen:
            continue
        for before in sorted(seen, key=len, reverse=True):
            after = seen[before]
            cnt = text.count(before)
            if not cnt:
                continue
            if ledger is not None:
                record_mask(ledger, f"{unit}", f"{r.name}:sweep", "<传播>", before, after)
            r.hits += cnt
            text = text.replace(before, after)
    return text


def sanitize_text_unit(label: str, text: str, rules: list[Rule], results: list[dict], ledger=None) -> str:
    field_rules = [r for r in rules if r.field]
    loose_rules = [r for r in rules if not r.field]
    tier = "L3"
    before = text

    if not field_rules:
        for r in loose_rules:
            text = apply_fulltext(text, r, ledger, label)
    else:
        try:
            obj = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            for r in loose_rules:
                text = apply_fulltext(text, r, ledger, label)
            for r in field_rules:
                located_before = r.located
                text = l2_apply(text, r, ledger, label)
                if r.located == located_before and r.patterns:
                    r.degraded = True
                    text = apply_fulltext(text, r, ledger, label)
            tier = "L2"
        else:
            text = json.dumps(
                l1_walk(obj, field_rules, loose_rules, ledger=ledger, unit=label),
                ensure_ascii=False,
                separators=(",", ":"),
            )
            for r in field_rules:
                if r.located == 0 and r.patterns:
                    r.degraded = True
                    text = apply_fulltext(text, r, ledger, label)
            tier = "L1"

    text = sweep_literals(text, rules, ledger, label)
    changed = text != before
    results.append({"unit": label, "tier": tier, "changed": changed})
    return text


def read_png_chunks(data: bytes) -> list[tuple[str, bytes]]:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ToolError("不是 PNG 文件(签名不符)")
    chunks: list[tuple[str, bytes]] = []
    off = 8
    while off + 8 <= len(data):
        (length,) = struct.unpack(">I", data[off : off + 4])
        ctype = data[off + 4 : off + 8].decode("latin1")
        body = data[off + 8 : off + 8 + length]
        chunks.append((ctype, body))
        off += 12 + length
        if ctype == "IEND":
            break
    return chunks


def build_png(chunks: list[tuple[str, bytes]]) -> bytes:
    out = [b"\x89PNG\r\n\x1a\n"]
    for ctype, body in chunks:
        ct = ctype.encode("latin1")
        out.append(struct.pack(">I", len(body)))
        out.append(ct)
        out.append(body)
        out.append(struct.pack(">I", zlib.crc32(ct + body) & 0xFFFFFFFF))
    return b"".join(out)


def decode_text_chunk(ctype: str, body: bytes) -> tuple[str, str] | None:
    try:
        if ctype == "tEXt":
            k, _, v = body.partition(b"\x00")
            return k.decode("latin1"), v.decode("latin1")
        if ctype == "zTXt":
            k, _, rest = body.partition(b"\x00")
            return k.decode("latin1"), zlib.decompress(rest[1:]).decode("latin1")
        if ctype == "iTXt":
            k, rest = body.split(b"\x00", 1)
            flag = rest[0]
            _lang, rest3 = rest[2:].split(b"\x00", 1)
            _trans, data = rest3.split(b"\x00", 1)
            text = data.decode("utf-8") if flag == 0 else zlib.decompress(data).decode("utf-8")
            return k.decode("latin1"), text
    except (IndexError, struct.error, zlib.error, UnicodeDecodeError):
        return None
    return None


def encode_text_chunk(key: str, value: str, prefer_ctype: str) -> tuple[str, bytes]:
    kb = key.encode("latin1")
    if prefer_ctype == "iTXt":
        return "iTXt", kb + b"\x00\x00\x00\x00\x00" + value.encode("utf-8")
    try:
        vb = value.encode("latin1")
    except UnicodeEncodeError:
        return "iTXt", kb + b"\x00\x00\x00\x00\x00" + value.encode("utf-8")
    if prefer_ctype == "zTXt":
        return "zTXt", kb + b"\x00\x00" + zlib.compress(vb)
    return "tEXt", kb + b"\x00" + vb


def sanitize_text_unit_or_raise(path_kind: str, suffix: str) -> None:
    if suffix == ".png":
        return
    if suffix in TEXT_EXTS:
        return
    raise ToolError(f"不支持的{path_kind}类型 {suffix}(仅 .png/.json/.txt)")


def sanitize_png_file(path: Path, rules: list[Rule], results: list[dict], ledger=None) -> tuple[bytes, bool]:
    data = path.read_bytes()
    chunks = read_png_chunks(data)
    out_chunks: list[tuple[str, bytes]] = []
    changed_any = False
    for ctype, body in chunks:
        decoded = decode_text_chunk(ctype, body)
        if decoded is None or not decoded[1].strip():
            out_chunks.append((ctype, body))
            continue
        key, value = decoded
        new_value = sanitize_text_unit(f"{path.name}:{key}", value, rules, results, ledger)
        if new_value != value:
            out_chunks.append(encode_text_chunk(key, new_value, ctype))
            changed_any = True
        else:
            out_chunks.append((ctype, body))
    return build_png(out_chunks), changed_any


def sanitize_text_file(path: Path, rules: list[Rule], results: list[dict], ledger=None) -> tuple[str, bool]:
    text = path.read_text(encoding="utf-8", errors="replace")
    new_text = sanitize_text_unit(path.name, text, rules, results, ledger)
    return new_text, new_text != text


def decide_output_path(path: Path, args) -> Path:
    if args.in_place:
        return path
    dest = path.with_stem(path.stem + ".sanitized")
    if args.out_dir:
        dest = Path(args.out_dir) / dest.name
    return dest


def collect_inputs(inputs: list[str]) -> list[Path]:
    files: list[Path] = []
    for item in inputs:
        p = Path(item)
        if p.is_dir():
            files.extend(
                sorted(q for q in p.rglob("*") if q.is_file() and q.suffix.lower() in SCAN_EXTS)
            )
        elif p.is_file():
            files.append(p)
        else:
            raise ToolError(f"输入不存在: {item}")
    seen: set[Path] = set()
    unique: list[Path] = []
    for f in files:
        rp = f.resolve()
        if rp not in seen:
            seen.add(rp)
            unique.append(f)
    return unique


def record_field(agg: dict[str, FieldStat], label: str, value, extra_tag: str | None = None) -> None:
    st = agg.setdefault(label, FieldStat(label=label))
    st.count += 1
    st.kinds.add(kind_of(value))
    low = label.lower()
    if isinstance(value, str):
        st.max_len = max(st.max_len, len(value))
        if not st.preview:
            st.preview = value[:60].replace("\n", "\\n").replace("\r", "")
        if len(value) >= 40 or any(h in low for h in PROMPT_KEY_HINTS):
            st.tags.add("疑似prompt文本")
        if PATH_VALUE_RE.search(value):
            st.tags.add("疑似路径")
        if any(low == h or low.endswith(h) for h in MODEL_KEY_HINTS) or value.lower().endswith(MODEL_SUFFIXES):
            st.tags.add("疑似模型名")
        if any(h in low for h in NUMERIC_KEY_HINTS) and re.fullmatch(r"-?\d+(\.\d+)?", value.strip()):
            st.tags.add("数值参数")
    elif isinstance(value, (int, float)):
        st.max_len = max(st.max_len, len(str(value)))
        if not st.preview:
            st.preview = str(value)[:60]
        if any(h in low for h in NUMERIC_KEY_HINTS):
            st.tags.add("数值参数")
    if extra_tag:
        st.tags.add(extra_tag)


def scan_walk(obj, agg: dict[str, FieldStat], depth: int = 0) -> None:
    if isinstance(obj, dict):
        node_type = obj.get("type") if isinstance(obj.get("type"), str) else None
        for k, v in obj.items():
            if k == "widgets_values" and node_type and isinstance(v, list):
                for i, item in enumerate(v):
                    if isinstance(item, (str, int, float, bool)):
                        record_field(agg, f"{node_type}#widgets_values[{i}]", item)
                continue
            record_field(agg, k, v)
            if isinstance(v, str) and depth < EMBED_JSON_DEPTH and v.lstrip()[:1] in "{[":
                try:
                    scan_walk(json.loads(v), agg, depth + 1)
                except (json.JSONDecodeError, ValueError):
                    pass
            if isinstance(v, (dict, list)):
                scan_walk(v, agg, depth)
    elif isinstance(obj, list):
        for item in obj:
            scan_walk(item, agg, depth)


def scan_regex_keys(text: str, agg: dict[str, FieldStat]) -> None:
    for m in KEY_SCAN_RE.finditer(text):
        key = m.group(1)
        try:
            key_unesc = json.loads('"' + key + '"')
        except (json.JSONDecodeError, ValueError):
            key_unesc = key
        raw_val = (m.group(2) or "").strip()
        if raw_val.startswith('"') and raw_val.endswith('"') and len(raw_val) >= 2:
            value = raw_val[1:-1]
        else:
            value = raw_val
        record_field(agg, key_unesc, value)


def scan_text_unit(label: str, text: str, agg: dict[str, FieldStat]) -> str:
    stripped = text.strip()
    if stripped[:1] in "{[":
        try:
            scan_walk(json.loads(text), agg)
            return "L1"
        except (json.JSONDecodeError, ValueError):
            pass
    if KEY_SCAN_RE.search(text):
        scan_regex_keys(text, agg)
        return "L2"
    probe = stripped[:200].replace("\n", "\\n")
    if probe:
        st = agg.setdefault(f"<全文>{label}", FieldStat(label=f"<全文>{label}"))
        st.count += 1
        st.kinds.add("text")
        if not st.preview:
            st.preview = probe[:60]
        if PATH_VALUE_RE.search(text):
            st.tags.add("疑似路径")
        if len(stripped) >= 40:
            st.tags.add("疑似prompt文本")
    return "L3"


def scan_files(paths: list[Path]) -> dict[str, FieldStat]:
    agg: dict[str, FieldStat] = {}
    for p in paths:
        try:
            sanitize_text_unit_or_raise("输入", p.suffix.lower())
            if p.suffix.lower() == ".png":
                for ctype, body in read_png_chunks(p.read_bytes()):
                    decoded = decode_text_chunk(ctype, body)
                    if decoded and decoded[1].strip():
                        scan_text_unit(f"{p.name}:{decoded[0]}", decoded[1], agg)
            else:
                scan_text_unit(p.name, p.read_text(encoding="utf-8", errors="replace"), agg)
        except (OSError, ToolError) as exc:
            log(f"[跳过] {p}: {exc}")
    return agg


def rank_fields(stats: list[FieldStat]) -> list[FieldStat]:
    def sort_key(st: FieldStat):
        rank = min((TAG_RANK.get(t, 4) for t in st.tags), default=4)
        return (rank, -st.count, st.label)

    return sorted(stats, key=sort_key)


def emit_scan_report(agg: dict[str, FieldStat], fmt: str) -> None:
    ordered = rank_fields(list(agg.values()))
    if fmt == "json":
        payload = {
            "total_fields": len(ordered),
            "fields": [
                {
                    "field": st.label,
                    "count": st.count,
                    "kinds": sorted(st.kinds),
                    "tags": sorted(st.tags),
                    "max_len": st.max_len,
                    "preview": st.preview,
                }
                for st in ordered
            ],
        }
        log(json.dumps(payload, ensure_ascii=False, indent=1))
        return
    if not ordered:
        log("未发现任何疑似字段: 该元数据没有可识别的键值结构。")
        log("建议改用 pattern-only 全文正则规则(规则不带 field, 或快捷用法只传 --regex)。")
        return
    log(f"{'字段':<36} {'次数':>4}  {'类型':<10} {'标签':<16} 预览")
    for st in ordered:
        kinds = ",".join(sorted(st.kinds))
        tags = ",".join(sorted(st.tags, key=lambda t: TAG_RANK.get(t, 9)))
        log(f"{st.label:<36} {st.count:>4}  {kinds:<10} {tags:<16} {st.preview}")
    log("")
    log(f"共 {len(ordered)} 个候选字段。可用 --rules-from-scan OUT.json 生成规则骨架再删减。")


def emit_rules_skeleton(agg: dict[str, FieldStat], out_path: Path) -> None:
    entries = []
    for st in rank_fields(list(agg.values())):
        if "str" not in st.kinds and "text" not in st.kinds:
            continue
        if st.label.startswith("<全文>") or "#" in st.label:
            continue
        entries.append({"field": st.label, "replace": DEFAULT_REPLACE})
    if not entries:
        raise ToolError("扫描结果中没有可作为 field 的字符串字段, 无法生成骨架")
    out_path.write_text(
        json.dumps(entries, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8"
    )
    log(f"规则骨架已写入 {out_path} ({len(entries)} 条), 请编辑补充 patterns 后经 --rules 回喂")


def rule_snapshot(rules: list[Rule]) -> list[dict]:
    return [
        {
            "rule": r.name,
            "located": r.located,
            "hits": r.hits,
            "degraded": r.degraded,
        }
        for r in rules
    ]


def run_sanitize(paths: list[Path], rules: list[Rule], args, ledger: list[MaskRecord]) -> int:
    total_hits = 0
    for p in paths:
        results: list[dict] = []
        for r in rules:
            r.located = 0
            r.hits = 0
        try:
            sanitize_text_unit_or_raise("输入", p.suffix.lower())
            if p.suffix.lower() == ".png":
                blob, changed = sanitize_png_file(p, rules, results, ledger)
                dest = decide_output_path(p, args)
                if not args.dry_run:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(blob)
            else:
                text, changed = sanitize_text_file(p, rules, results, ledger)
                dest = decide_output_path(p, args)
                if not args.dry_run:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_text(text, encoding="utf-8")
        except (OSError, ToolError) as exc:
            log(f"[错误] {p}: {exc}")
            return 1
        snap = rule_snapshot(rules)
        file_hits = sum(s["hits"] for s in snap)
        total_hits += file_hits
        tiers = "+".join(dict.fromkeys(r["tier"] for r in results)) or "-"
        status = "试运行" if args.dry_run else ("已写入" if changed else "无变化")
        log(f"{p} [{tiers}] 替换 {file_hits} 处, {status} -> {dest}")
        for s in snap:
            note = ", 已降级->L3" if s["degraded"] else ""
            log(f"    规则 {s['rule']}: 定位 {s['located']}, 替换 {s['hits']}{note}")
    if total_hits == 0:
        log("所有输入均无命中(退出码 3)")
        return 3
    return 0


def load_quick_rule(args) -> list[Rule]:
    if not args.field and not args.regex:
        return []
    return [
        compile_rule(
            Rule(
                name=args.field or "quick",
                field=args.field,
                patterns=tuple(args.regex or ()),
                replace=args.replace,
                flags=args.flags,
                expand=args.expand_brackets,
            )
        )
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="workflow 元数据脱敏工具(详见模块 docstring)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("inputs", nargs="+", help="输入文件或目录(png/json/txt, 目录递归)")
    parser.add_argument("--scan", action="store_true", help="只做疑似字段发现, 不脱敏")
    parser.add_argument("--format", choices=("text", "json"), default="text", help="扫描结果输出格式")
    parser.add_argument("--rules-from-scan", metavar="OUT.json", help="由扫描结果生成规则骨架文件")
    parser.add_argument("--rules", metavar="FILE", help="规则文件(JSON 数组)")
    parser.add_argument("--field", help="快捷规则字段名")
    parser.add_argument("--regex", action="append", default=[], metavar="PAT", help="快捷规则正则, 可重复")
    parser.add_argument("--replace", default=DEFAULT_REPLACE, help="统一替换串(默认 %(default)s)")
    parser.add_argument("--flags", default="", help="快捷规则正则标志(i/m/s 组合)")
    parser.add_argument("--expand-brackets", action="store_true", help="命中扩展到所在最小完整括号单元")
    parser.add_argument("--presets", metavar="NAMES", help="内置预设(逗号分隔: paths,users), 默认关闭")
    parser.add_argument("-o", "--out-dir", help="输出目录(默认与源文件同目录 *.sanitized.*)")
    parser.add_argument("--dry-run", action="store_true", help="只报告, 不写任何文件")
    parser.add_argument("--in-place", action="store_true", help="允许原地覆盖源文件(默认绝不)")
    parser.add_argument("--report", metavar="PATH", help="脱敏前后字段/值对照表路径(- 为 stdout)")
    parser.add_argument("--report-format", choices=("md", "tsv"), default="md", help="对照表格式")
    args = parser.parse_args(argv)

    try:
        if args.in_place and args.out_dir:
            raise ToolError("--in-place 与 -o/--out-dir 互斥")
        paths = collect_inputs(args.inputs)
        if not paths:
            raise ToolError("没有可处理的输入文件")

        if args.scan:
            if args.report:
                raise ToolError("--scan 与 --report 互斥(对照表随脱敏产生)")
            agg = scan_files(paths)
            emit_scan_report(agg, args.format)
            if args.rules_from_scan:
                emit_rules_skeleton(agg, Path(args.rules_from_scan))
            return 0

        rules = load_quick_rule(args)
        if args.presets:
            rules.extend(preset_rules(args.presets))
        if args.rules:
            loaded = json.loads(Path(args.rules).read_text(encoding="utf-8"))
            if not isinstance(loaded, list):
                raise ToolError(f"{args.rules} 规则文件顶层须为数组")
            rules.extend(build_rules(loaded, args.rules))
        if not rules:
            raise ToolError("未提供任何规则: 需要 --field/--regex、--presets 或 --rules(扫描请加 --scan)")

        ledger: list[MaskRecord] = []
        rc = run_sanitize(paths, rules, args, ledger)
        if args.report:
            content = render_ledger(ledger, args.report_format)
            if args.report == "-":
                log(content.rstrip())
            else:
                Path(args.report).write_text(content, encoding="utf-8")
                log(f"脱敏对照表已写入 {args.report} ({len(ledger)} 条记录)")
        return rc
    except ToolError as exc:
        log(f"[错误] {exc}")
        return 1
    except (OSError, json.JSONDecodeError) as exc:
        log(f"[错误] {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
