# Danbooru Asset Provenance and Licenses

This document applies to generated files such as `danbooru.sqlite3`,
`vocab_sorted.npy`, and `embed_gnn.npy`. The build scripts are project code
under the root MIT License; generated data retains the conditions of its input
datasets. This notice must be shipped with any Release containing these files.

## Principle

This tool processes upstream datasets into a flattened SQLite lookup library
and a GNN embedding index. The derived assets are not the raw source text or
images. Nonetheless, this project **attributes and respects every upstream
contributor whose data is used**, and does not claim sole intellectual property
over data contributions that originate from others. The table-level provenance
below records exactly which data comes from which source and what the project
contributes itself. Attribution obligations (linking and indicating changes)
are treated as unconditional for any data used, regardless of whether the
share-alike clause is technically triggered by the derived form.

This provenance record describes the current build inputs and is not legal
advice.

---

## 1. Upstream sources

### 1.0 Sn0w123/booru-characters (character_profile)

- URL: https://huggingface.co/datasets/Sn0w123/booru-characters
- Input: `characters.jsonl` (~22k character profiles; MIT license)
- Use: `character_profile` table (structured character traits)
- Dataset-card license (HF metadata `cardData.license = mit`); MIT permits
  commercial use and redistribution with copyright notice preserved.
- Attribution: character rows -> Sn0w123/booru-characters (MIT); underlying
  tag data -> Danbooru (see 1.1/1.2).

### 1.1 nyanko-devs/danbooru2026

- URL: https://huggingface.co/datasets/nyanko-devs/danbooru2026
- Input: `metadata/posts-snapshot.parquet`
- Local input SHA-256:
  `5b6b2671dc0fa966de71af76dfd342f485f76581447cec9e26c313ba9fb1c2fd`
- Dataset-card license: MIT
- Audited repository revision shown by Hugging Face: `ebb02a6`
  (card re-audited via Hugging Face API on 2026-08-29: `cardData.license = mit`
  and tag `license:mit` agree; repo sha `ebb02a630201c7b51487e45fb90b3fcf4cbedc20`)
- Use: same-source tag counts, co-occurrence graph, edges, and GNN training
- Important upstream note: original images retain their respective copyrights.
  This project uses metadata, not the source images, in the generated lookup assets.

The Hugging Face card clearly declares `mit`, but the audited repository tree
did not contain a separate `LICENSE` file or a complete upstream copyright
notice. Preserve the dataset-card URL and Nyanko Devs attribution above, and
obtain or record the upstream copyright/permission notice before a public data
asset Release. Do not reuse the root project's copyright line as though it
were the dataset publisher's notice.

### 1.2 isek-ai/danbooru-wiki-2024

- URL: https://huggingface.co/datasets/isek-ai/danbooru-wiki-2024
- Input: `danbooru-wiki-2024.parquet`
- Local input SHA-256:
  `f73ae9c50ad75e52d49ba8e0abc34ff6d9ed06aa8aba5d11cbdf75c22fd09881`
- License: Creative Commons Attribution-ShareAlike 4.0 International
- License text: https://creativecommons.org/licenses/by-sa/4.0/legalcode
- Dataset-card license (audited via Hugging Face API, 2026-08-29): `cc-by-sa-4.0`
  (cardData.license and tag `license:cc-by-sa-4.0` agree; author `isek-ai`;
  repo revision `150ab9fe223322ce4e8ca2a1875c796ab7e0b371`)
- Use: aliases/other names, wiki presence, and wiki-reference-derived
  character traits
- Content: wiki pages about the Danbooru tags on `danbooru.donmai.us`
  (tag descriptions and matches to pixiv tags), as described by the dataset card.

Attribution: “danbooru-wiki-2024”, published by ISEKAI (`isek-ai`) on
Hugging Face, derived from community-maintained Danbooru wiki data. The build
normalizes, filters, joins, and aggregates the data into lookup tables. No
endorsement is implied.

Because the distributed SQLite contains adapted material derived from the
CC BY-SA 4.0 wiki dataset, recipients must receive attribution, a link to the
license, and an indication that changes were made. The project MIT License does
not override these terms.

---

## 2. Table-level provenance in the generated SQLite

The `--with-danbooru` asset set (`danbooru.sqlite3` + `vocab_sorted.npy` +
`embed_gnn.npy`) is not a raw copy of any upstream file. Each table is built
from a specific source; contributors are attributed per table.

| SQLite table / npy | Content | Source(s) | License note |
|---|---|---|---|
| `tags` (`id, name, tag_type, count, has_wiki, name_pc`) | tag names, types, post counts, wiki-presence flag | names/types/counts from nyanko posts snapshot; `has_wiki` from isek-ai wiki title set | MIT (nyanko) + BY attribution for `has_wiki` |
| `tag_alias` (`alias, tag_id, freq, pos`) | canonical names + multi-language aliases | canonical names from nyanko vocab; `other_names` aliases from isek-ai wiki | MIT (nyanko) + CC BY-SA 4.0 for the alias strings drawn from wiki |
| `edges` (`src_id, dst_id, count, pmi, llr`) | top-50 LLR co-occurrence neighbors | nyanko posts snapshot | MIT (nyanko); numeric statistics, not source text |
| `tag_gnn_nn` (`tag_id, nn_id, cos`) | top-50 GNN cosine neighbors per tag | computed from `embed_gnn.npy` (trained on nyanko snapshot) | MIT (nyanko); numeric statistics |
| `tag_category` (`tag_id, category`) | semantic bucket per tag | derived by `tools/p9_semantic.py` keyword rules on tag names | project-authored rules; tag names are facts |
| `wiki_traits` (`tag_id, trait_id, vote, vote_official`) | wiki example-image (`!post #id`) tag votes per wiki page title | isek-ai wiki reference-image markers joined with nyanko post tags | CC BY-SA 4.0 (isek-ai) for the wiki-sourced trait relationships |
| `vocab_sorted.npy` | lexicographic tag-name array | nyanko vocab | MIT (nyanko) |
| `embed_gnn.npy` | GNN tag embeddings | trained on nyanko posts snapshot | MIT (nyanko) |

Scope of the CC BY-SA 4.0 contribution: the **wiki-sourced columns** —
`tag_alias` alias strings and the `wiki_traits` trait relationships — are the
adapted material from `isek-ai/danbooru-wiki-2024`. The GNN embeddings,
co-occurrence edges, and semantic-category rows derive from the MIT-licensed
posts snapshot or project-authored rules, and do not carry a share-alike
obligation.

---

## 3. Auxiliary sources status

All previous auxiliary dependencies (such as `ThetaCursed/danbooru-2026-clean-metadata` and `dataproc5/metrics-danbooru2025-alltime-tag-counts`) have been **completely eliminated** from the build pipeline. All tag category definitions and frequency counts are now computed directly from the MIT-licensed `nyanko-devs/danbooru2026` post snapshot typed columns.

---

## 4. Rebuilding the database yourself

Anyone may rebuild the assets locally from the upstream datasets. The build is
one-shot and offline; it requires the `D:/gnn` venv python (numpy, pandas,
pyarrow) and the two upstream parquet files fetched from the URLs above.

```bash
# Full build: produces danbooru/danbooru.sqlite3 + vocab_sorted.npy + embed_gnn.npy
python utils/build_danbooru_db.py [--src D:/gnn/out] [--block 4096]

# Add tag_category + wiki_traits to an existing db without rebuilding the
# expensive tag_gnn_nn table (idempotent). Requires p9 outputs:
#   D:/gnn/scripts/p9_semantic.py  ->  tag_category.parquet / wiki_traits.parquet
python utils/build_danbooru_db.py --patch-semantic [--src D:/gnn/out]

# Extend the tags table with ALL snapshot character/copyright tags missing
# from the GNN vocab (recent tags, offset ids 112283+), backfill name_pc,
# wiki aliases, tag_category, and wiki_traits for new titles (idempotent):
python utils/build_danbooru_db.py --patch-characters \
    [--snapshot D:/gnn/out/posts-snapshot.parquet]
```

The exact `D:/gnn/out/*.parquet` inputs referenced by `build_danbooru_db.py`
and `p9_semantic.py` are produced by the `D:/gnn` pipeline (vocab, tag_texts,
edges, embed_gnn, wiki_extra, wiki_post_tags). A rebuilt database must carry
this notice and the same per-table attribution when redistributed.

---

## 5. Release decision

1. Source-only and standard binary Releases do not package these assets and are
   licensed purely under the project's root MIT License.
2. A `--with-danbooru` Release contains the generated SQLite database and GNN
   embeddings, which are derived solely from:
   - `nyanko-devs/danbooru2026` (MIT License)
   - `isek-ai/danbooru-wiki-2024` (CC BY-SA 4.0)
3. Any distribution containing the generated Danbooru assets must retain this
   notice, attribute both upstream sources, and fulfill the CC BY-SA 4.0
   attribution and share-alike requirements for the adapted wiki-sourced
   columns (`tag_alias` aliases and `wiki_traits` trait relationships).
