"""Build the danbooru tag lookup database (danbooru/danbooru.sqlite3).

The build inputs have independent licenses. Before redistributing generated
assets, update and retain danbooru/ASSET_LICENSES.md; the repository MIT
license does not replace dataset licenses.

One-shot offline build from D:/gnn assets. Produces six tables:

  tags(id, name, tag_type, count, has_wiki)   -- 112,283 rows; id = lexicographic
                                                tag index (matches edges/embed ids)
  tag_alias(alias, tag_id, freq)              -- tag names + other_names (CJK),
                                                lowercased, pure lookup
  edges(src_id, dst_id, count, pmi, llr)      -- 3,601,294 top-50 LLR neighbors
  tag_gnn_nn(tag_id, nn_id, cos)              -- top-50 GNN cosine neighbors per tag
                                                (computed from embed_gnn.npy in
                                                row-chunks to bound peak memory)
  tag_category(tag_id, category)              -- semantic bucket per tag
                                                (character/copyright/artist/meta
                                                or composition/background/
                                                environment/hair_color/hair_style/
                                                eyes/clothing/accessories/
                                                expression/body/action/other),
                                                from D:/gnn p9_semantic.py
  wiki_traits(tag_id, trait_id, vote,         -- wiki example-image (!post #id)
              vote_official)                     tag votes per wiki page title;
                                                vote_official counts images with
                                                an official_art* meta tag (the
                                                reliability signal for the
                                                authoritative character-traits
                                                part of the tag UI)

Row-order traps (verified against D:/gnn sources):
  * edges.parquet / embed_gnn.npy use the LEXICOGRAPHIC tag index
    (tag2id = {t:i for i,t in enumerate(np.sort(vocab.tag))}).
  * vocab.parquet itself is NOT lexicographic and tag_texts.parquet follows
    the vocab FILE order. All alias rows are joined by tag name, never by
    row number.

Usage (run with the D:/gnn venv python, which has numpy/pandas/pyarrow):
  python utils/build_danbooru_db.py [--src D:/gnn/out] [--out danbooru/danbooru.sqlite3]
                                    [--skip-gnn] [--block 4096]
  python utils/build_danbooru_db.py --patch-semantic   # add tag_category +
                                                       # wiki_traits to an
                                                       # existing db without
                                                       # rebuilding (skips the
                                                       # expensive tag_gnn_nn
                                                       # recomputation)
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
import pandas as pd


def t0(label: str, start: float) -> float:
    print(f"[{time.time() - start:7.1f}s] {label}", flush=True)
    return time.time()


SEMANTIC_DDL = """
CREATE TABLE IF NOT EXISTS tag_category (
  tag_id   INTEGER PRIMARY KEY,
  category TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wiki_traits (
  tag_id         INTEGER NOT NULL,
  trait_id       INTEGER NOT NULL,
  vote           INTEGER,
  vote_official  INTEGER,
  PRIMARY KEY (tag_id, trait_id)
);
CREATE INDEX IF NOT EXISTS idx_wiki_traits_trait ON wiki_traits(trait_id);
"""


def insert_semantic(
    db: sqlite3.Connection,
    name2id: dict[str, int],
    src: Path,
    start: float,
) -> float:
    """Insert tag_category + wiki_traits from D:/gnn p9 parquets.

    Rows whose tag names are missing from name2id are skipped (p9 reads the
    same vocab, so drops should be zero; parquet columns use tag NAMES to
    avoid any row-order trap).
    """
    cat = pd.read_parquet(src / "tag_category.parquet")
    cat_rows = [
        (name2id[t], c)
        for t, c in zip(cat["tag"].tolist(), cat["category"].tolist())
        if t in name2id
    ]
    db.executemany(
        "INSERT OR REPLACE INTO tag_category (tag_id, category) VALUES (?,?)",
        cat_rows,
    )
    db.commit()
    start = t0(f"tag_category: {len(cat_rows)} rows", start)

    traits = pd.read_parquet(
        src / "wiki_traits.parquet",
        columns=["title_tag", "trait_tag", "vote", "vote_official"],
    )
    tr_rows = [
        (name2id[a], name2id[b], int(v), int(o))
        for a, b, v, o in zip(
            traits["title_tag"].tolist(),
            traits["trait_tag"].tolist(),
            traits["vote"].tolist(),
            traits["vote_official"].tolist(),
        )
        if a in name2id and b in name2id
    ]
    db.executemany(
        "INSERT OR REPLACE INTO wiki_traits "
        "(tag_id, trait_id, vote, vote_official) VALUES (?,?,?,?)",
        tr_rows,
    )
    db.commit()
    return t0(f"wiki_traits: {len(tr_rows)} rows", start)


CHAR_PATCH_RE = re.compile(r"!post #(\d+)")


def patch_characters(out: Path, src: Path, snapshot: Path) -> None:
    """Extend an existing db with ALL danbooru character/copyright tags.

    The GNN vocab (p0_vocab.py) dropped tags whose type was missing from the
    2026 dictionary / 2025 counts — recent tags such as rossi_(arknights)
    (created 2025-11-29) fall into that bucket. The posts-snapshot itself
    contains them (typed columns), so re-stream it and append every
    character/copyright tag not already in tags, with ids offset above the
    vocab range. Also backfills:

      * name_pc (paren-stripped key) for the WHOLE tags table — the tolerant
        lookup tier (hina blue archive → hina_(blue_archive));
      * tag_alias from wiki_extra other_names for the new tags (CJK zh);
      * tag_category rows (character / copyright);
      * wiki_traits for new titles from the SAME wiki_extra reference-post
        data p9 used (no new fetches).

    Idempotent: reruns skip names already present. No GNN assets change
    (embed/vocab npy stay vocab-only — new tags have no embeddings).
    """
    import pandas as pd
    import pyarrow.parquet as pq

    start = time.time()
    if not out.exists():
        raise SystemExit(f"db not found: {out} (patch needs an existing build)")
    db = sqlite3.connect(out)
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA synchronous = NORMAL")

    # ---- name_pc column (paren-stripped), idempotent --------------------
    cols = {r[1] for r in db.execute("PRAGMA table_info(tags)")}
    if "name_pc" not in cols:
        db.execute("ALTER TABLE tags ADD COLUMN name_pc TEXT")
        db.execute(
            "UPDATE tags SET name_pc = REPLACE(REPLACE(name, '(', ''), ')', '')"
        )
        print(f"backfilled name_pc for existing tags", flush=True)
    db.execute("CREATE INDEX IF NOT EXISTS idx_tags_name_pc ON tags(name_pc)")
    db.commit()

    existing = {str(r[0]) for r in db.execute("SELECT name FROM tags")}
    max_id = db.execute("SELECT MAX(id) FROM tags").fetchone()[0] or -1
    print(f"existing tags: {len(existing):,} (max id {max_id})", flush=True)

    # ---- re-stream snapshot typed columns (p0 count semantics) ----------
    pf = pq.ParquetFile(snapshot)
    char_counts: Counter = Counter()
    copy_counts: Counter = Counter()
    for batch in pf.iter_batches(
        columns=["tag_string_character", "tag_string_copyright"],
        batch_size=500_000,
    ):
        for s in batch["tag_string_character"].to_pylist():
            if s:
                char_counts.update(s.split())
        for s in batch["tag_string_copyright"].to_pylist():
            if s:
                copy_counts.update(s.split())
    print(f"snapshot chars: {len(char_counts):,} / copyrights: "
          f"{len(copy_counts):,} ({time.time()-start:.0f}s)", flush=True)

    seen = set(existing)
    new_tags: list[tuple[str, str, int]] = []
    for t, c in char_counts.items():
        if t not in seen:
            seen.add(t)
            new_tags.append((t, "character", int(c)))
    for t, c in copy_counts.items():
        if t not in seen and c >= 3:  # mirror p0 MIN_TAG_COUNT
            seen.add(t)
            new_tags.append((t, "copyright", int(c)))
    new_tags.sort(key=lambda x: x[0])
    print(f"new tags to add: {len(new_tags):,} "
          f"({time.time()-start:.0f}s)", flush=True)

    # ---- wiki data (titles / other_names / reference posts) -------------
    wiki = pd.read_parquet(src / "wiki_extra.parquet",
                           columns=["title", "body", "other_names"])
    wiki_titles = {str(t) for t in wiki["title"].dropna().tolist()}
    other_names: dict[str, list[str]] = {}
    for t, lst in zip(wiki["title"].tolist(), wiki["other_names"].tolist()):
        if not isinstance(t, str) or not isinstance(lst, (list, np.ndarray)):
            continue
        names = [a.strip() for a in lst if isinstance(a, str) and a.strip()]
        if names:
            other_names[t] = names
    print(f"wiki titles: {len(wiki_titles):,} / with other_names: "
          f"{len(other_names):,} ({time.time()-start:.0f}s)", flush=True)

    if not new_tags:
        print("nothing to add (index already extended)", flush=True)
    else:
        base = max_id + 1
        rows = []
        for i, (name, typ, cnt) in enumerate(new_tags):
            rows.append((base + i, name, typ, cnt,
                         1 if name in wiki_titles else 0,
                         name.replace("(", "").replace(")", "")))
        db.executemany(
            "INSERT INTO tags (id, name, tag_type, count, has_wiki, name_pc) "
            "VALUES (?,?,?,?,?,?)",
            rows,
        )
        db.commit()
        start = t0(f"tags: +{len(rows)} rows (ids {base}+)", start)

        alias_rows: list[tuple[str, int, float, int]] = []
        for i, (name, typ, cnt) in enumerate(new_tags):
            tid = base + i
            freq = float(cnt)
            alias_rows.append((name, tid, freq, 0))
            for pos, a in enumerate(other_names.get(name, [])):
                if a != name:
                    alias_rows.append((a.lower(), tid, freq, pos + 1))
        db.executemany(
            "INSERT OR IGNORE INTO tag_alias (alias, tag_id, freq, pos) "
            "VALUES (?,?,?,?)",
            alias_rows,
        )
        db.commit()
        start = t0(f"tag_alias: +{len(alias_rows)} rows", start)

        db.executemany(
            "INSERT OR REPLACE INTO tag_category (tag_id, category) VALUES (?,?)",
            [(base + i, typ) for i, (_, typ, _) in enumerate(new_tags)],
        )
        db.commit()
        start = t0(f"tag_category: +{len(new_tags)} rows", start)

    # ---- wiki_traits for NEW titles (p9 aggregation, new titles only) ----
    # 幂等基准 = 词表外 tag:按"本次新增"判定在中断重跑时会算空,
    # 以"不在 vocab.parquet 中"判定 new 才稳定(已落库的 318k 也能补上)
    vocab_names = set(
        pd.read_parquet(src / "vocab.parquet", columns=["tag"])["tag"].astype(str)
    )
    new_name2id = {
        str(name): int(tid)
        for name, tid in db.execute("SELECT name, id FROM tags").fetchall()
        if str(name) not in vocab_names
    }
    # 特征 tag 可能落在已有词表(如 1girl/long_hair),须用全量 name→id
    full_name2id = {
        str(name): int(tid) for name, tid in db.execute(
            "SELECT name, id FROM tags"
        ).fetchall()
    }
    refs: list[tuple[str, int]] = []
    for t, b in zip(wiki["title"].tolist(), wiki["body"].tolist()):
        if t in new_name2id and isinstance(b, str):
            for pid in CHAR_PATCH_RE.findall(b):
                refs.append((t, int(pid)))
    print(f"new-title reference posts: {len(refs):,}", flush=True)

    all_names = existing | set(new_name2id)
    wpt = pd.read_parquet(src / "wiki_post_tags.parquet",
                          columns=["post_id", "tag", "tag_type"])
    meta = wpt[wpt["tag_type"] == "meta"]
    official_posts = set(
        meta.loc[meta["tag"].str.startswith("official_art"), "post_id"].tolist()
    )
    wpt = wpt[wpt["tag"].isin(all_names)][["post_id", "tag"]]
    if refs:
        ref_df = pd.DataFrame(refs, columns=["title", "post_id"]).drop_duplicates()
        pairs = ref_df.merge(wpt, on="post_id")
        pairs = pairs[pairs["title"] != pairs["tag"]]
        pairs["official"] = pairs["post_id"].isin(official_posts)
        g = pairs.groupby(["title", "tag"], sort=False)
        agg = g.agg(vote=("post_id", "size"),
                    vote_official=("official", "sum")).reset_index()
        tr_rows = [
            (full_name2id[a], full_name2id[b], int(v), int(o))
            for a, b, v, o in zip(agg["title"].tolist(),
                                  agg["tag"].tolist(),
                                  agg["vote"].tolist(),
                                  agg["vote_official"].tolist())
        ]
        db.executemany(
            "INSERT OR REPLACE INTO wiki_traits "
            "(tag_id, trait_id, vote, vote_official) VALUES (?,?,?,?)",
            tr_rows,
        )
        db.commit()
        start = t0(f"wiki_traits: +{len(tr_rows)} rows", start)
    else:
        print("no new-title wiki refs (wiki_traits unchanged)", flush=True)

    # ---- spot checks ----------------------------------------------------
    for probe in ["rossi_(arknights)"]:
        row = db.execute(
            "SELECT id, name, tag_type, count, has_wiki, name_pc "
            "FROM tags WHERE name = ?",
            (probe,),
        ).fetchone()
        print(f"check tags[{probe}] -> {row}", flush=True)
        if row:
            tid = row[0]
            aliases = db.execute(
                "SELECT alias FROM tag_alias WHERE tag_id = ? ORDER BY pos LIMIT 6",
                (tid,),
            ).fetchall()
            print(f"  aliases -> {[a[0] for a in aliases]}", flush=True)
            traits = db.execute(
                "SELECT t.name, w.vote, w.vote_official FROM wiki_traits w "
                "JOIN tags t ON t.id = w.trait_id WHERE w.tag_id = ? "
                "ORDER BY w.vote_official DESC, w.vote DESC LIMIT 6",
                (tid,),
            ).fetchall()
            print(f"  wiki_traits -> {traits}", flush=True)
    nt = db.execute("SELECT COUNT(*) FROM tags").fetchone()[0]
    na = db.execute("SELECT COUNT(*) FROM tag_alias").fetchone()[0]
    nw = db.execute("SELECT COUNT(*) FROM wiki_traits").fetchone()[0]
    db.commit()
    db.close()
    print(f"patched: {out} (tags={nt:,} alias={na:,} wiki_traits={nw:,}, "
          f"{time.time()-start:.0f}s)", flush=True)


def patch_semantic(out: Path, src: Path) -> None:
    """Add tag_category + wiki_traits to an EXISTING danbooru sqlite db.

    Avoids the expensive tag_gnn_nn recomputation of a full rebuild; the
    name→id mapping is read from the db's own tags table so ids always
    match whatever the db already contains.
    """
    start = time.time()
    if not out.exists():
        raise SystemExit(f"db not found: {out} (patch needs an existing build)")
    db = sqlite3.connect(out)
    db.execute("PRAGMA journal_mode = WAL")
    db.executescript(SEMANTIC_DDL)
    name2id = {
        str(name): int(tid)
        for name, tid in db.execute("SELECT name, id FROM tags").fetchall()
    }
    print(f"existing tags: {len(name2id):,}", flush=True)
    insert_semantic(db, name2id, src, start)

    # spot check: the user's reference example
    tid = name2id.get("hataya_misuzu")
    if tid is not None:
        rows = db.execute(
            "SELECT t.name, w.vote, w.vote_official FROM wiki_traits w "
            "JOIN tags t ON t.id = w.trait_id WHERE w.tag_id = ? "
            "ORDER BY w.vote_official DESC, w.vote DESC LIMIT 8",
            (tid,),
        ).fetchall()
        print(f"  check wiki_traits[hataya_misuzu] -> {rows}", flush=True)
    nc = db.execute("SELECT COUNT(*) FROM tag_category").fetchone()[0]
    nt = db.execute("SELECT COUNT(*) FROM wiki_traits").fetchone()[0]
    db.commit()
    db.close()
    print(f"patched: {out} (tag_category={nc:,}, wiki_traits={nt:,})", flush=True)


def build(src: Path, out: Path, skip_gnn: bool, block: int) -> None:
    start = time.time()
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    # ------------------------------------------------------------------ vocab
    vocab = pd.read_parquet(src / "vocab.parquet")
    # unicode dtype(非 object)——供 worker 侧 np.load(allow_pickle=False) 读取
    tags_sorted = np.array(sorted(vocab["tag"].tolist()), dtype=np.str_)
    assert len(tags_sorted) == len(vocab)
    vocab = vocab.set_index("tag").reindex(tags_sorted).reset_index().rename(columns={"tag": "name"})
    n = len(vocab)
    print(f"vocab: {n} tags", flush=True)

    db = sqlite3.connect(out)
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA synchronous = NORMAL")

    db.executescript(
        """
        CREATE TABLE tags (
          id        INTEGER PRIMARY KEY,
          name      TEXT NOT NULL UNIQUE,
          tag_type  TEXT,
          count     INTEGER,
          has_wiki  INTEGER,
          name_pc   TEXT
        );
        CREATE INDEX idx_tags_name_pc ON tags(name_pc);
        CREATE TABLE tag_alias (
          alias  TEXT NOT NULL COLLATE NOCASE,
          tag_id INTEGER NOT NULL,
          freq   REAL,
          pos    INTEGER,
          PRIMARY KEY (alias, tag_id)
        );
        CREATE INDEX idx_tag_alias_tag_id ON tag_alias(tag_id);
        CREATE TABLE edges (
          src_id INTEGER NOT NULL,
          dst_id INTEGER NOT NULL,
          count  INTEGER,
          pmi    REAL,
          llr    REAL,
          PRIMARY KEY (src_id, dst_id)
        );
        CREATE INDEX idx_edges_dst ON edges(dst_id);
        CREATE TABLE tag_gnn_nn (
          tag_id INTEGER NOT NULL,
          nn_id  INTEGER NOT NULL,
          cos    REAL,
          PRIMARY KEY (tag_id, nn_id)
        );
        CREATE INDEX idx_gnn_nn_nn ON tag_gnn_nn(nn_id);
        CREATE TABLE tag_category (
          tag_id   INTEGER PRIMARY KEY,
          category TEXT NOT NULL
        );
        CREATE TABLE wiki_traits (
          tag_id         INTEGER NOT NULL,
          trait_id       INTEGER NOT NULL,
          vote           INTEGER,
          vote_official  INTEGER,
          PRIMARY KEY (tag_id, trait_id)
        );
        CREATE INDEX idx_wiki_traits_trait ON wiki_traits(trait_id);
        """
    )

    # ---------------------------------------------------------------- tags
    rows = list(
        zip(
            range(n),
            vocab["name"].tolist(),
            vocab["tag_type"].tolist(),
            vocab["count"].tolist(),
            vocab["has_wiki"].astype(int).tolist(),
        )
    )
    db.executemany(
        "INSERT INTO tags (id, name, tag_type, count, has_wiki) VALUES (?,?,?,?,?)",
        rows,
    )
    db.execute(
        "UPDATE tags SET name_pc = REPLACE(REPLACE(name, '(', ''), ')', '')"
    )
    db.commit()
    start = t0(f"tags: {len(rows)} rows", start)

    # -------------------------------------------------------------- aliases
    # tag_texts.parquet rows follow the vocab FILE order; join by tag name.
    texts = pd.read_parquet(src / "tag_texts.parquet", columns=["tag", "aliases"])
    merged = vocab[["name"]].merge(texts, left_on="name", right_on="tag", how="left")
    merged = merged[["name", "aliases"]]
    name2id = {name: i for i, name in enumerate(vocab["name"].tolist())}

    count_by_name = {
        name: float(c) for name, c in zip(vocab["name"].tolist(), vocab["count"].tolist())
    }
    alias_rows = []
    for name, aliases in zip(merged["name"].tolist(), merged["aliases"].tolist()):
        tid = name2id[name]
        freq = count_by_name[name]
        alias_rows.append((name, tid, freq, 0))
        if not isinstance(aliases, (list, np.ndarray)):
            continue
        # pos = 别名在 other_names 列表中的位置(常见译名靠前),
        # 供中文翻译(zh)按常见度选取;freq 同 tag 内无区分度(恒为 tag count)
        for pos, a in enumerate(aliases):
            if not isinstance(a, str):
                continue
            a = a.strip()
            if not a or a == name:
                continue
            alias_rows.append((a.lower(), tid, freq, pos))
    # set 去重会打乱顺序,改为 dict 按 (alias, tag_id) 保留最小 pos
    alias_dedup: dict[tuple[str, int], tuple] = {}
    for row in alias_rows:
        key = (row[0], row[1])
        if key not in alias_dedup or row[3] < alias_dedup[key][3]:
            alias_dedup[key] = row
    alias_rows = list(alias_dedup.values())
    db.executemany(
        "INSERT INTO tag_alias (alias, tag_id, freq, pos) VALUES (?,?,?,?)", alias_rows
    )
    db.commit()
    start = t0(f"tag_alias: {len(alias_rows)} rows", start)

    # ---------------------------------------------------------------- edges
    edges = pd.read_parquet(src / "edges.parquet")
    db.executemany(
        "INSERT INTO edges (src_id, dst_id, count, pmi, llr) VALUES (?,?,?,?,?)",
        edges[["src_id", "dst_id", "count", "pmi", "llr"]].itertuples(index=False),
    )
    db.commit()
    start = t0(f"edges: {len(edges)} rows", start)

    # ---------------------------------------------------------- gnn neighbors
    if not skip_gnn:
        emb = np.load(src / "embed_gnn.npy").astype(np.float32)
        assert emb.shape[0] == n, (emb.shape, n)
        norms = np.linalg.norm(emb, axis=1, keepdims=True)
        emb = emb / (norms + 1e-9)
        K = 50
        nn_rows = []
        for b in range(0, n, block):
            e = min(b + block, n)
            sim = emb[b:e] @ emb.T  # (e-b, n) float32
            # 排除自身:块内第 i 行对应全局节点 (b+i)
            sim[np.arange(e - b), np.arange(b, e)] = -1.0
            idx = np.argpartition(-sim, K, axis=1)[:, :K]
            vals = np.take_along_axis(sim, idx, axis=1)
            order = np.argsort(-vals, axis=1)
            idx = np.take_along_axis(idx, order, axis=1)
            vals = np.take_along_axis(vals, order, axis=1)
            for i in range(e - b):
                row = b + i
                nn_rows.extend(
                    (int(row), int(idx[i, j]), float(vals[i, j])) for j in range(K)
                )
            if b % (block * 8) == 0:
                print(f"  gnn chunk {b}/{n} ({time.time()-start:.0f}s)", flush=True)
            if len(nn_rows) >= 500_000:
                db.executemany(
                    "INSERT INTO tag_gnn_nn (tag_id, nn_id, cos) VALUES (?,?,?)",
                    nn_rows,
                )
                db.commit()
                nn_rows = []
        if nn_rows:
            db.executemany(
                "INSERT INTO tag_gnn_nn (tag_id, nn_id, cos) VALUES (?,?,?)", nn_rows
            )
            db.commit()
        start = t0(f"tag_gnn_nn: top-{K} per tag", start)

    # ------------------------------------------------------------ semantic
    start = insert_semantic(db, name2id, src, start)

    # ------------------------------------------------------------ validation
    # worker 侧 npy 资产(纯 numpy,免 pandas/pyarrow 依赖):
    #   vocab_sorted.npy —— 字典序 tag 名(tag2id 映射源)
    #   embed_gnn.npy    —— GNN 嵌入副本(组推荐均值查询用)
    import shutil

    np.save(out.parent / "vocab_sorted.npy", tags_sorted)
    emb_src = src / "embed_gnn.npy"
    if emb_src.exists():
        shutil.copy(emb_src, out.parent / "embed_gnn.npy")
    start = t0("worker npy assets (vocab_sorted + embed_gnn)", start)

    def count(tbl: str) -> int:
        return db.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]

    nt, na, ne, ng = count("tags"), count("tag_alias"), count("edges"), count("tag_gnn_nn")
    nc, nw = count("tag_category"), count("wiki_traits")
    print(f"rows: tags={nt} alias={na} edges={ne} gnn_nn={ng} "
          f"category={nc} wiki_traits={nw}", flush=True)
    assert nt == n
    assert ne > 0, ne
    assert nc == n, nc
    if not skip_gnn:
        assert ng == n * 50, ng

    def lookup(name: str) -> int:
        row = db.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
        assert row is not None, f"missing {name}"
        return row[0]

    for q, expect in [("1girl", "solo"), ("blonde_hair", "blue_eyes")]:
        tid = lookup(q)
        nbrs = db.execute(
            "SELECT t.name FROM edges e JOIN tags t ON t.id = e.dst_id "
            "WHERE e.src_id = ? ORDER BY e.llr DESC LIMIT 20",
            (tid,),
        ).fetchall()
        names = [r[0] for r in nbrs]
        assert expect in names, (q, expect, names[:10])
        print(f"  check edges[{q}] -> {names[:8]}", flush=True)

    for q in ["初音ミク", "初音未来", "雷姆", "琪露诺", "东方"]:
        row = db.execute(
            "SELECT t.name FROM tag_alias a JOIN tags t ON t.id = a.tag_id "
            "WHERE a.alias = ? ORDER BY a.freq DESC LIMIT 3",
            (q,),
        ).fetchall()
        assert row, f"alias missing: {q}"
        print(f"  check alias[{q}] -> {[r[0] for r in row]}", flush=True)

    if not skip_gnn:
        tid = lookup("saber_(fate)")
        nbrs = db.execute(
            "SELECT t.name FROM tag_gnn_nn g JOIN tags t ON t.id = g.nn_id "
            "WHERE g.tag_id = ? ORDER BY g.cos DESC LIMIT 10",
            (tid,),
        ).fetchall()
        print(f"  check gnn[saber_(fate)] -> {[r[0] for r in nbrs]}", flush=True)

    tid = lookup("hataya_misuzu")
    trs = db.execute(
        "SELECT t.name FROM wiki_traits w JOIN tags t ON t.id = w.trait_id "
        "WHERE w.tag_id = ? ORDER BY w.vote_official DESC, w.vote DESC LIMIT 6",
        (tid,),
    ).fetchall()
    print(f"  check wiki_traits[hataya_misuzu] -> {[r[0] for r in trs]}", flush=True)

    db.commit()
    db.close()
    print(f"done: {out} ({time.time()-start:.0f}s total)", flush=True)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--src", default="D:/gnn/out", help="D:/gnn asset directory")
    p.add_argument(
        "--out", default=str(Path(__file__).resolve().parent.parent / "danbooru" / "danbooru.sqlite3")
    )
    p.add_argument("--skip-gnn", action="store_true", help="skip tag_gnn_nn (debug)")
    p.add_argument("--block", type=int, default=4096, help="cosine chunk size")
    p.add_argument(
        "--patch-semantic",
        action="store_true",
        help="add tag_category + wiki_traits to an existing db (no rebuild)",
    )
    p.add_argument(
        "--patch-characters",
        action="store_true",
        help="extend an existing db with ALL snapshot character/copyright "
             "tags (recent tags missing from the GNN vocab) + name_pc",
    )
    p.add_argument(
        "--snapshot",
        default="D:/gnn/posts-snapshot.parquet",
        help="danbooru posts snapshot (typed tag columns)",
    )
    args = p.parse_args()
    if args.patch_semantic:
        patch_semantic(Path(args.out), Path(args.src))
        return
    if args.patch_characters:
        patch_characters(Path(args.out), Path(args.src), Path(args.snapshot))
        return
    build(Path(args.src), Path(args.out), args.skip_gnn, args.block)


if __name__ == "__main__":
    main()
