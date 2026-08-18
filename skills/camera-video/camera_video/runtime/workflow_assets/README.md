# camera-video — Bundled Workflow Assets

This directory holds the three fixed MiniMax H3 API graphs this skill
executes. **They are the only execution source** — the skill verifies each
graph's identity on every run and refuses to run on drift.

## Files

| File | Stage | Role |
|---|---|---|
| `minimax-h3-t2v.json` | `t2v` | Text-to-video API graph |
| `minimax-h3-i2v-single.json` | `i2v` | Single-reference API graph |
| `minimax-h3-i2v-multi.json` | `multi-i2v` | Multi-reference (3 images) API graph |
| `manifest.json` | — | SHA-256 hashes + node counts + node topology per stage |

## Manifest schema

`manifest.json` has one `scenes` object keyed by stage (`t2v` / `i2v` /
`multi-i2v`). Each scene spec:

```jsonc
{
  "workflow":     "minimax-h3-t2v.json",   // filename in this directory
  "sha256":       "<64-hex digest>",
  "node_count":   42,                       // exact number of top-level graph nodes
  "prompt_node":  "3",                      // node id: PrimitiveStringMultiline "Input Text (Prompt)"
  "duration_node": "5",                     // node id: PrimitiveFloat "Float (Duration)"
  "image_nodes":  ["7"]                     // node ids: LoadImage "加载图像" (empty for t2v)
}
```

## Identity verification (`runtime/assets.py`)

`load_fixed_workflow(stage)` enforces, in order (any failure → `AssetError`,
fail-closed, exit 4):

1. `stage` is one of `t2v` / `i2v` / `multi-i2v` and exists in the manifest.
2. The workflow file exists in this directory.
3. `sha256(path) == spec.sha256`.
4. The JSON parses and is a flat dict of `{node_id: {class_type, inputs, _meta}}`
   with exactly `spec.node_count` entries.
5. The prompt node is `PrimitiveStringMultiline` with title `Input Text (Prompt)`
   and a string `inputs.value`.
6. The duration node is `PrimitiveFloat` with title `Float (Duration)`
   and a numeric `inputs.value`.
7. Every `spec.image_nodes[i]` is `LoadImage` with title `加载图像`
   and a string `inputs.image`.

The skill then patches only three kinds of widget values per run:
`inputs.value` on the prompt node (H3 prompt string), `inputs.value` on the
duration node, and `inputs.image` on each image node (uploaded reference name).

## Replacement protocol

To change a workflow, publish **all three** together — never one alone:

1. Edit the API graph JSON (new node count / topology / node titles).
2. Recompute `sha256` for every changed file.
3. Update the matching `scenes[stage]` entry in `manifest.json`
   (`sha256`, `node_count`, and any changed `prompt_node` / `duration_node`
   / `image_nodes` ids).
4. Run the self-check: `camera-video assets verify --stage <stage>`.
5. Update `SKILL.md` if the request contract changed (e.g. reference count).

Run `camera-video assets verify --stage <t2v|i2v|multi-i2v>` after any edit
in this directory, before any production run.
