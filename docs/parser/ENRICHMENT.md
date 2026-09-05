# Additive Enrichment Contract

`workflow_db.enrichment` is a display-only layer over the authoritative
`parser.py` Record. It is exposed through the explicit `parse_worker`
`enrich_record` RPC method, but is not part of the default `parse_image` or
ingest path. It does not change persistence, `batch_key`, `recipe_key`, search
indexes, or parser fixtures.

## Result

`enrich_record(record)` returns:

- `effective_record`: a deep copy with safe missing fields filled;
- `provenance`: field path to provider, confidence, and graph evidence;
- `diagnostics`: input formats, before/after coverage, unknown nodes, conflicts,
  warnings, applied fields, `repaired_fields`, and `sampler_graph` traversal
  evidence.

The input Record is never mutated. Existing non-empty scalar values always win,
except for the explicitly proven display-only repairs described below.
Lists are merged only by a declared stable node identity. A candidate without a
node identity may fill an empty list, but cannot append to a non-empty list.
Native prompt candidates are stricter: parser prompts are aggregate semantic
records while sampler-view prompts are upstream fragments, so they only fill an
entirely empty polarity/by-sampler list.

There are two display-only repair cases for known parser placeholders:

- a prompt entry whose text is only an API link such as `['123', 0]` is cleared
  before native candidates are applied;
- a base model selected from a non-generation loader (for example
  `UpscaleModelLoader`) may be replaced by a connected `CheckpointLoader` or
  `UNETLoader` candidate.

These repairs are reported in `diagnostics.repaired_fields`; the persisted
Record and its raw metadata are unchanged. A direct negative `CLIPTextEncode`
value is not replaced merely because an enrichment candidate exists.

`diagnostics.sampler_graph` records the sampler-centric traversal contract:
root node IDs, traversed node/edge counts, unknown node count,
`direction: sampler_to_upstream`, and `traversal: bfs_with_visited`. Selector
nodes such as `KSamplerSelect` are excluded from the display sampler list when
they are not one of the detected execution roots.

Every detail view exposes its source evidence in collapsed, copyable JSON
inspectors. `raw_prompt` and `raw_workflow` are shown whenever present,
including complete parses; sources without either graph show their complete
raw metadata object instead. Objects and valid JSON strings are pretty printed;
malformed strings remain byte-for-byte text after HTML escaping. Raw values are
not duplicated into the enrichment diagnostics payload.

The frontend may collapse a long prompt fragment only when the API prompt graph
proves it is upstream of a displayed `Text Concatenate` source and it is a
comma/newline-bounded part of that aggregate. Without graph evidence it only
removes exact duplicates. This is a display-and-copy convenience only: the
stored Record and raw JSON evidence are unchanged. For this read-only graph
check, ComfyUI's bare `NaN`/`Infinity` metadata values are normalized in memory
only; strings, including Prompt text, are not rewritten.

## Candidate Adapter Contract

```json
{
  "provider": "third-party.tool-name",
  "path": "samplers",
  "value": [{"node_id": "12", "steps": 20}],
  "merge": "merge_by_key",
  "identity": ["node_id"],
  "confidence": 0.8,
  "evidence": {"source": "raw_prompt", "node_ids": ["12"]}
}
```

Only paths in `workflow_db.enrichment.SAFE_PATHS` are accepted. Identity,
grouping, raw metadata, file, and timestamp fields are intentionally excluded.
External tools should run outside the worker process with pinned versions,
timeouts, and resource limits; their output should be converted to candidates
before calling the overlay.

The native adapter reuses `sampler_view.py` to produce candidates for samplers,
prompts, model loaders, LoRAs, and latent settings. It understands
`PrimitiveStringMultiline` links and rgthree `Lora Loader Stack` inputs, and
prefers terminal `CLIPTextEncode` values over intermediate text-concatenation
nodes. It consumes an API prompt graph. A UI workflow alone is reported in
`input_formats` but is not guessed into API inputs by this package.

Additional graph semantics supported by the native adapter:

- multi-output text nodes with literal `positive`/`negative` inputs are
  resolved from their named semantic input, independent of class name;
- sampler prompt recovery carries its polarity through named Bus-node ports.
  UI workflow output-port names are used when available; API-only graphs may
  use an exact `positive`/`negative` Bus input name. No global Bus slot mapping
  is assumed, and an unlabelled Bus branch remains unresolved;
- custom node types containing `CLIPTextEncode` are accepted when they expose
  a literal `text` input (for example `smZ CLIPTextEncode`);
- Power Lora Loader entries may come from API prompt `lora_*` objects when a
  UI workflow is absent, with disabled entries excluded;
- primitive-like custom nodes with a literal `value`, sampler selectors, and
  `ImpactConditionalBranch` nodes are resolved while following sampler
  parameter links;
- inpaint latent dimensions can be traced through the sampler latent branch to
  an enabled `output_target_width`/`output_target_height` resize transform;
- non-executing class variants containing both `sampler` and `select` are
  removed from the display sampler list when they are not detected roots.
