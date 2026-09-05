"""Danbooru tag 补全参考 —— worker 侧计算核心。

能力(惰性加载,资产缺失/依赖缺失时返回 None → RPC 转 enabled:false):

  suggest(tag_list)  组推荐(需求 2,扫描入库时预计算):
      batch 的 prompt tag 组作为多输入 → GNN 嵌入均值查询 → 候选池 120 →
      单 tag 得分 + 两两组一致性(rel + 0.5*coh)。逻辑照搬 D:/gnn 的
      p6_suggest_group.py(本地 FP-growth boost 留二期)。
      资产:vocab_sorted.npy + embed_gnn.npy(tools/build_danbooru_db.py 产出,
      纯 numpy,免 pandas/pyarrow 依赖)。

设计原则:网关运行时零 ML —— 联想/单 tag 索引走 SQLite 查表(见
nest_gateway/src/sqlite/danbooru.ts);本模块只承担"导入时批量预计算"
这一无法查表化的计算。(NL 整句语义搜索已移除:查询空间开放、依赖
e5+FAISS ~1.7GB 常驻,性价比不足;语义查询由 tag_alias 多语言别名层兜底。)
"""
from __future__ import annotations

import itertools
import os
import re
from pathlib import Path
from typing import Any

# 资产目录:env DANBOORU_ASSETS 优先,默认 <repo_root>/danbooru
# (tools/build_danbooru_db.py 的产出目录)。
_REPO_ROOT = Path(__file__).resolve().parent.parent

# 组推荐候选池与组一致性权重(与 p6_suggest_group.py 对齐)。
_CANDIDATES = 120
_GROUP_W_COHERENCE = 0.5

_STATE: dict[str, Any] = {"loaded": False, "data": None}

# L1 语法清洗:A1111/ComfyUI 引用块(`<lora:x:1>` / `<embedding:x>`)、
# 权重 `(x:1.2)`、强调 `{x}`/`{{x}}`、降权 `[x]` —— 剥壳后才是词表规范形。
_ANGLE_BLOCK = re.compile(r"<[^<>]{1,120}>")
_WEIGHT_PARENS = re.compile(r"^\((.+):[\d.,\s]+\)$")
_SQUARE = re.compile(r"^\[(.+)\]$")
_PARENS = re.compile(r"^\((.+)\)$")


def norm_key(value: Any) -> str:
    """查表键归一化:小写 + 剥转义反斜杠 + 空格→下划线(词表规范形)。"""
    return str(value or "").strip().lower().replace("\\", "").replace(" ", "_")


def split_tags(value: Any, tag2id: dict[str, int] | None = None) -> list[str]:
    """分词:把一段 prompt 文本拆成 tag 列表(可同时接受整句与已拆分数组)。

    L1 语法清洗:剥 `<...>` 引用块、按逗号/换行切段;
    L2 词表分词:每段先整体验证(消歧括号 `(fate)` 是 tag 名一部分,保留),
    未命中沿剥壳候选链(权重/强调/降权语法)验证,再未命中做词表贪心
    最长匹配(空格连接的多 tag,如 `blonde hair blue eyes`)。
    无词表(资产缺失)时降级为 L1-only:保留段原样,不拆括号、不贪心。
    """
    out: list[str] = []
    for segment in re.split(r"[\n,]+", _ANGLE_BLOCK.sub(" ", str(value or ""))):
        segment = segment.strip()
        if not segment:
            continue
        tokens = _segment_tokens(segment, tag2id)
        out.extend(tokens or [segment])
    return out


def _segment_tokens(segment: str, tag2id: dict[str, int] | None) -> list[str]:
    """单段 → token 列表(词表规范形,下划线);降级时返回原段。"""
    if tag2id is None:
        return [segment]
    for cand in _strip_candidates(segment):
        key = norm_key(cand)
        if key in tag2id:
            return [key]
    return _greedy_split(segment, tag2id)


def _strip_candidates(segment: str) -> list[str]:
    """候选变体链:原形 → 逐层剥壳,与网关侧 tagKeyCandidates 语义对齐。
    原形优先 —— 消歧括号 `(fate)` 只有在整段剥壳后词表命中才被替换,
    不会误伤 `hassan of serenity (fate)` 这类带消歧的完整 tag 名。"""
    out = [segment]
    cur = segment
    for _ in range(4):
        m = _WEIGHT_PARENS.match(cur)
        if m:
            nxt = m.group(1)
        elif cur.startswith("{") and cur.endswith("}"):
            inner = cur
            while inner.startswith("{") and inner.endswith("}") and len(inner) >= 2:
                inner = inner[1:-1]
            nxt = inner
        else:
            b = _SQUARE.match(cur)
            p = None if b else _PARENS.match(cur)
            nxt = b.group(1) if b else (p.group(1) if p else cur)
        if nxt == cur or not nxt:
            break
        cur = nxt
        out.append(cur)
    return out


def _greedy_split(segment: str, tag2id: dict[str, int]) -> list[str]:
    """词表贪心最长匹配:空格连接的多 tag(无逗号)拆成规范形列表;
    无法匹配的残片(如 `hassan of serenity` 整体不在 GNN 词表)丢弃,
    由调用方降级保留原段。"""
    key = norm_key(segment)
    if not key:
        return []
    data = _STATE.get("data")
    maxlen = data["max_tag_len"] if data else 64
    tokens: list[str] = []
    pos = 0
    n = len(key)
    while pos < n:
        hit = None
        upper = min(n, pos + maxlen)
        for end in range(upper, pos, -1):
            if key[pos:end] in tag2id:
                hit = end
                break
        if hit is None:
            pos += 1
            continue
        tokens.append(key[pos:hit])
        pos = hit
    return tokens


def _assets_dir() -> Path:
    configured = os.environ.get("DANBOORU_ASSETS", "").strip()
    return Path(configured) if configured else _REPO_ROOT / "danbooru"


def _load() -> dict[str, Any] | None:
    """惰性加载 GNN 资产(numpy);失败标记后不再重试。"""
    if _STATE["loaded"]:
        return _STATE["data"]
    _STATE["loaded"] = True
    try:
        import numpy as np

        directory = _assets_dir()
        vocab = np.load(directory / "vocab_sorted.npy", allow_pickle=False)
        emb = np.load(directory / "embed_gnn.npy").astype(np.float32)
        emb /= np.linalg.norm(emb, axis=1, keepdims=True) + 1e-9
        if emb.shape[0] != len(vocab):
            _STATE["data"] = None
            return None
        id2tag = [str(t) for t in vocab.tolist()]
        tag2id = {t: i for i, t in enumerate(id2tag)}
        _STATE["data"] = {
            "np": np,
            "tag2id": tag2id,
            "id2tag": id2tag,
            "emb": emb,
            "max_tag_len": max((len(t) for t in id2tag), default=0),
        }
        return _STATE["data"]
    except Exception:
        _STATE["data"] = None
        return None


def suggest(tag_list: list[str], top_k: int = 10) -> dict[str, Any] | None:
    """组推荐:tag 组 → GNN 均值查询 → 单 tag + 二元组推荐。

    命中 vocab 的 tag <2 个时返回空结果(防噪,与方案一致)。
    """
    assets = _load()
    if assets is None:
        return None
    np = assets["np"]
    tag2id, id2tag, emb = assets["tag2id"], assets["id2tag"], assets["emb"]

    qids: list[int] = []
    seen: set[int] = set()
    for raw in tag_list or []:
        for tag in split_tags(raw, tag2id):
            key = norm_key(tag)
            if key in tag2id:
                tid = tag2id[key]
                if tid not in seen:
                    seen.add(tid)
                    qids.append(tid)
    sources = [id2tag[i] for i in qids]
    if len(qids) < 2:
        return {"tags": [], "groups": [], "sources": sources}

    query = emb[qids].mean(axis=0)
    sim = emb @ query
    for tid in qids:
        sim[tid] = -1.0
    cand = np.argsort(-sim)[:_CANDIDATES]
    cand_score = sim[cand]

    singles = [
        {"name": id2tag[int(c)], "score": round(float(cand_score[i]), 4)}
        for i, c in enumerate(cand[:top_k])
    ]

    groups: list[tuple[float, list[str]]] = []
    for (i, x), (j, y) in itertools.combinations(enumerate(cand.tolist()), 2):
        ta, tb = id2tag[int(x)], id2tag[int(y)]
        coherence = float(emb[int(x)] @ emb[int(y)])
        relevance = (float(cand_score[i]) + float(cand_score[j])) / 2.0
        groups.append((relevance + _GROUP_W_COHERENCE * coherence, [ta, tb]))
    groups.sort(key=lambda item: -item[0])
    top_groups = [
        {"tags": tags, "score": round(score, 4)} for score, tags in groups[:top_k]
    ]
    return {"tags": singles, "groups": top_groups, "sources": sources}
