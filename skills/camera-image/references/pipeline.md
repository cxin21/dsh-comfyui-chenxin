# Camera Image — Pipeline (one run, end-to-end)

The exact sequence of steps `camera-image run` performs, each with its hard
contract. Source of truth: `camera_image/cli.py` + `camera_image/runtime/*`.
If this document and the code disagree, **the code is right**.

```
camera-anima.json  ──┐
manifest.json       ──┴─► load_fixed_ui()
                              │ sha256 + structure_fingerprint check
                              ▼
req.json ──► parse_request() ──► RunConfig
                              │
                              ├── apply_preset()           (camera + image_size only if user didn't set)
                              ├── resolve_enabled_groups() (validate titles against groups.json)
                              ├── confirm_group_plan()     (interactive; --yes skips)
                              ├── require_files()          (every image path exists)
                              ▼
                           patch_ui()
                              │ writes every request field into widget values
                              │ expands bypassed subgraphs (mode 4 → mode 0)
                              ▼
                           cache_workflow()  ──► .workflow_cache/*.json
                              ▼
                           ExecutionSession.strip_ui_workflow()  ──► API graph + strip_notes
                              ▼
                           patch_api_lora()       (re-attach node 26 / 66 widget values)
                              ▼
                           validate_api_graph()   (post-strip structural check)
                              ▼
                           ExecutionSession.execute()
                              ├── upload_image()         (controlnet_image, region refs, ref, sig)
                              ├── enqueue_workflow()     (ComfyUI validates atomically)
                              ├── wait_for_completion()  (history polling with status verification)
                              └── get_artifact() ×N  ──► <output-dir>/<file>.png
                              ▼
                           write_summary() ──► <output-dir>/summary.json
```

## Step-by-step hard contracts

### 1. `load_fixed_ui()` — asset invariant

- Reads `manifest.json`; policy must be `bundled-fixed-ui-json`, else `fixed_workflow_invalid`.
- Reads `camera-anima.json`; sha256 must equal `manifest.asset_sha256`, else fail-closed.
- Runs `structure_fingerprint()`: stable hash of nodes + links + groups, **excluding widget state** (so widget edits by the skill don't invalidate the fingerprint).
- Enforces: `nodes` is a list, every node has an integer unique `id`.
- Returns the deep-copied UI graph.

### 2. `parse_request(stage, payload, profile_id)` — shape gate

- Unknown top-level key → `unsupported request field(s)`.
- `profile_id` must equal the manifest-pinned `profile_id` (default `"camera-anima-v1"`), else reject.
- `prompt.positive` must be non-empty.
- Stage rules enforced: `t2i` rejects `reference_image`; `i2i` requires it.
- Returns a typed `RunConfig` frozen dataclass.

### 3. `apply_preset()` — shortcut expansion

- Only fills `camera` + `image_size` when the request didn't set them.
- Unknown preset name → `validation_failed`.

### 4. `resolve_enabled_groups()` + `confirm_group_plan()` — group state

- Every user-supplied `groups.g1` / `groups.g2` title is validated against `workflow/<stage>/groups.json`; unknown title → `validation_failed` before confirmation.
- `confirm_group_plan` prints the full enablement plan (`[G1 ENABLED]` / `[G2 ENABLED]` / `[G2 AVAILABLE]`) and reads y/N from stdin.
- `--yes` skips the prompt; stdin EOF without `--yes` → `group_confirmation_aborted`.

### 5. `require_files()` — input existence gate

- Every image path the user supplied (`reference_image`, `controlnet_image`, region refs, `signature_image`) must be an existing file.
- Missing → `input_file_missing` (exit 2).

### 6. `patch_ui()` — write the request surface

- Writes every request field into widget values at the documented widget indices (see `graph.py` header comment for the full node → index map):
  - node 24/25 `wildcard_text` + `populated_text` (positive / negative)
  - node 3/4/5 + 17/18/19 (region prompts)
  - node 583 `pos_x/pos_y/pos_z/roll` (camera)
  - node 585 13 widgets (camera_extra)
  - node 50 / 51 (sampling)
  - node 68 / 71 (image_size)
  - node 65 (seed)
  - node 26 / 66 (LoRA stack + trigger words)
  - node 21 / 129 / 0 / 1 / 2 / 116 (image inputs)
- Expands bypassed subgraphs (`mode: 4 → mode: 0`) so `strip` can resolve them.
- Forces node 58 to `1` (t2i) / `2` (i2i).

### 7. `cache_workflow()` — diagnostic artifact

- Saves a timestamped copy of the patched UI graph under `temp/runtime/.workflow_cache/`.
- 10-deep LRU eviction across all camera skills.
- Safe to delete; purely for post-mortem.

### 8. `strip_ui_workflow()` — one-shot MCP call

- Asks comfyui-mcp to convert the UI graph to an API graph.
- One-shot: the skill does **not** retry on failure.
- `strip_notes` are surfaced verbatim in the summary.

### 9. `patch_api_lora()` — post-strip re-attach

- The strip drops the LoraManager's three `__lm_widget_ids`-driven widget values from node 26, leaving `text` missing (required) → cascades as "Output will be ignored" for nodes 35/490/550.
- Re-writes the dropped inputs directly: node 26 (`__lm_autocomplete_meta_text`, `text`, `loras`) and node 66 (`trigger_words` link + `orinalMessage`).

### 10. `validate_api_graph()` — post-strip structural check

- Enforces: non-empty graph, integer-valued links, every node whose `class_type` is in `{Image Saver Simple, PreviewImage}` has an `images` link.
- Rejects before enqueue → `validation_failed` + strip_notes.

### 11. `execute()` — upload + enqueue + wait + download

- Uploads each image (`controlnet_image`, region refs, `reference_image`, `signature_image`) via MCP `upload_image`.
- Enqueues via MCP `enqueue_workflow` — **ComfyUI's atomic server-side validation** rejects invalid graphs without queueing.
- Polls `/history` with status verification.
- Downloads artifacts via HTTP `GET /view`; only `SaveImage` outputs are downloaded.

### 12. `write_summary()` — run journal

- Emits `<output-dir>/summary.json` with `prompt_id`, `api_graph_sha256`, `uploads`, per-artifact `filename` + `sha256`, optional `strip_notes`, optional `queue_status`, and run-stage extras (`stage`, `preset`, `seed`).

## Confirmation flow (interactive)

```
[G1 ENABLED] 5 group(s):
  - 保存图片 (on by default) -> nodes [35]
  - 第二轮采样器（G1） (on by default) -> nodes [51]
  - 相机视角生图（G1） (on by default) -> nodes [583, 585]
  - 高清 PreDetailer（G1） (user-requested) -> nodes [94]
  - 高清 PostDetailer（G1） (user-requested) -> nodes [95]
[G2 ENABLED] 2 group(s):
  - 图像锐化（G2） (on by default) -> nodes [111]
  - 对比度（G2） (on by default) -> nodes [96]
[groups] total: 8 node(s) will be activated
[G2 AVAILABLE] 13 not-enabled group(s) (cancel & rerun if you want any):
  - 图像色阶（G2） -> nodes [97]
  - ...
[groups] enable these? [y/N] y
[groups] confirmed.
```

Non-interactive pipelines (the loader's CLI Tool wrapper, agent automation)
pass `--yes` to skip the prompt. If stdin returns EOF without `--yes`, the
run aborts with `group_confirmation_aborted`.

## Failure boundaries

Every step is a hard gate — the skill stops at the first failure:

| Step | Failure code | Exit |
|---|---|---|
| 1 | `fixed_workflow_invalid` / `node_id_format_mismatch` | 4 |
| 2 | `validation_failed` | 3 |
| 3 | `validation_failed` | 3 |
| 4 | `validation_failed` / `group_confirmation_aborted` | 3 / 2 |
| 5 | `input_file_missing` | 2 |
| 8 | `comfyui_mcp_error` | 4 |
| 9 | `comfyui_mcp_error` | 4 |
| 10 | `validation_failed` | 3 |
| 11 | `comfyui_runtime_error` / `comfyui_mcp_error` | 5 / 4 |
