---
name: camera-image
description: "Execute the bundled Anima camera workflow on a local ComfyUI server and save one PNG per run. Two stages — text→image (`t2i`) and image→image (`i2i`, requires `reference_image`). Fixed UI asset (`camera-anima.json`) is sha256-pinned and structurally fingerprinted against `manifest.json`; the user supplies a flat JSON request that writes the request-only widget values. Use this skill for any Anima still-image request that needs the bundled camera / lens / DOF / LoRA / sampling / preset surface. Load this skill immediately on any 'Anima 生图' / '跑一个 camera-image' / '跑 t2i' / '跑 i2i' / '把图改成俯视' / '换相机视角' request; do not improvise with generic image tools."
whenToUse: "User wants one Anima still image generated on the bundled camera workflow. Use after prompt is authored (e.g. by `prompt_author (target=anima)`, prompt-master plugin) and before any post-processing."
---

# Camera Image

Execute the pinned Anima camera workflow (`camera-anima.json`) on your ComfyUI server. Two stages:

- `t2i` (text → image)
- `i2i` (image → image; requires `reference_image`)

Every run validates → patches → strips → enqueues → waits → downloads exactly one PNG.

If you need to author prompts first, use the prompt-master plugin's `prompt_author (target=anima)` and feed the emitted `positive` into `prompt.positive`. If you need a video, use `camera-video`. If you need a multi-view character sheet, use `camera-multiview`.

## When to call

Call this skill when:

1. The user wants one Anima still image (not video, not character sheet).
2. The user wants the bundled camera / lens / DOF / LoRA / sampling / preset surface exposed in [`camera-anima.json`](camera_image/runtime/workflow_assets/).
3. ComfyUI is running locally (default `http://127.0.0.1:8188`) or at a reachable URL.

Do not call this skill when:

- The user wants video → `camera-video`.
- The user wants a multi-view character sheet → `camera-multiview`.
- The user wants prose, prompts, or creative direction → `prompt_author (target=anima)` (prompt-master plugin; or send the request back to the host).

## First principle

**The workflow asset is invariant.** `camera-anima.json` is the only workflow source. Every run loads it, verifies `sha256` and a structural fingerprint against `manifest.json`, then writes only the request surface (`prompt`, `camera`, `camera_extra`, `sampling`, `lora`, `groups`, image paths) into widget values. The skill does not discover, repair, rewire, or fall back. If the asset doesn't match the manifest, an unknown group title is supplied, a requested LoRA is missing on the server, or `i2i` is requested without a `reference_image` — stop, surface the invariant that failed, ask the human.

## Quick start

```jsonc
// contract-stage: t2i
{
  "prompt": {
    "positive": "score_9, score_8_up, 1girl, anime portrait, cinematic lighting",
    "negative": "low quality, bad anatomy"
  },
  "profile_id": "camera-anima-v1",
  "preset": "portrait_full_body",
  "seed": 42
}
```

```bash
# Save the JSON above into req.json, then run:
<preset>\.venv\Scripts\camera-image.exe run \
    --stage t2i --request req.json --output-dir temp/camera-image/ --yes
```

Output:

```
temp/camera-image/2026-08-17-140511_miaomiaoHarem_anima15_42.png
temp/camera-image/summary.json
```

`camera-image describe --stage t2i --summary` returns the live request contract (including the preset table) — prefer it over memorizing field rules.

## Request schema

The block below shows every field the parser accepts. It is documentation, not a runnable example — `scripts/check_contracts.py` does not parse this block. For runnable examples see [Examples](#examples).

```text
{
  "prompt": {
    "positive": "<required, string>",
    "negative": "<optional, string, default \"\">"
  },
  "evidence":            "<optional, object, passed through verbatim>",
  "profile_id":          "<optional, default 'camera-anima-v1' (manifest-pinned)>",
  "preset":              "<optional, one of the preset table>",
  "seed":                "<optional, integer>",
  "image_size":          "<optional, {width, height}, multiples of 8>",
  "camera":              "<optional, {direction, elevation, distance[, roll]}>",
  "camera_extra":        "<optional, 13-field object>",
  "lora":                "<optional, {selections: [{name, strength_model?, strength_clip?, active?, trigger_words?}]}>",
  "sampling":            "<optional, {steps_first, cfg, sampler, scheduler, denoise_first, steps_refine, denoise_refine}>",
  "groups":              "<optional, {g1: [title, ...], g2: [title, ...]}>",
  "reference_image":     "<stage i2i only, required>",
  "controlnet_image":    "<optional, local path>",
  "red_prompt":          "<optional, string>",
  "green_prompt":        "<optional, string>",
  "blue_prompt":         "<optional, string>",
  "red_image":           "<optional, local path>",
  "green_image":         "<optional, local path>",
  "blue_image":          "<optional, local path>",
  "signature_image":     "<optional, local path>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt.positive` | string | **yes** | Non-empty; maps to node 24 (wildcard + populated text). Emitted by `prompt_author (target=anima)` (prompt-master plugin). |
| `prompt.negative` | string | no | Default `""`; maps to node 25. |
| `evidence` | object | no | Free-form journal; passed through verbatim to `summary.json`. Never read by the skill. |
| `profile_id` | string | no | Default `"camera-anima-v1"` (manifest-pinned). Any other value → reject. |
| `preset` | enum | no | One of the preset table below; fills `camera` + `image_size` only if you didn't set them. User values always win. |
| `seed` | int | no | Maps to node 65 → linked into node 50/51. |
| `image_size` | `{width, height}` | no | Multiples of 8. Defaults to preset / `832×1216`. |
| `camera` | object | no | Requires all three of `direction`, `elevation`, `distance` if present. `roll` is `[0.0, 1.0]`. |
| `camera_extra` | object | no | 13 fields; see [`references/field-reference.md`](references/field-reference.md) |
| `lora` | object | no | `selections[]`; default 3-LoRA plan runs if absent. |
| `sampling` | object | no | `sampler` / `scheduler` enums in [`references/field-reference.md`](references/field-reference.md) |
| `groups` | `{g1: [...], g2: [...]}` | no | Titles must match `workflow/<stage>/groups.json` exactly |
| `reference_image` | path | **i2i only** | Required for i2i; rejected for t2i |
| `controlnet_image` | path | no | Auto-enables `ControlNet LLLite（G1）` |
| `red_prompt` / `green_prompt` / `blue_prompt` | string | no | Auto-enable `区域提示词（G1）` |
| `red_image` / `green_image` / `blue_image` | path | no | Auto-enable `区域提示词（G1）` |
| `signature_image` | path | no | Auto-enables `添加签名（G1）` |

### Preset table

| Preset | Size | Camera (direction / elevation / distance) |
|---|---|---|
| `portrait_full_body` | 832 × 1216 | front / eye-level / full_body |
| `portrait_closeup` | 832 × 1216 | front / eye-level / close_up |
| `squarish_cowboy` | 1024 × 1024 | front / eye-level / cowboy_shot |
| `landscape_wide` | 1280 × 720 | front / eye-level / wide |

`describe --summary` returns the same table under `result.presets`.

### Camera coords

The widget space is `[-1, 1]` floats. Translation table (verbatim from `camera_image/runtime/camera_map.py`):

| Semantic | Float | Notes |
|---|---|---|
| `direction: front` | `pos_x = 0.0` | facing viewer |
| `direction: right_45` | `pos_x = 0.25` | 45° camera-right |
| `direction: right` | `pos_x = 0.5` | profile, camera-right |
| `direction: rear_45` / `right_135` | `pos_x = 0.75` | aliases |
| `direction: rear` | `pos_x = 1.0` | directly behind |
| `direction: left_45` | `pos_x = -0.25` | 45° camera-left |
| `direction: left` | `pos_x = -0.5` | profile, camera-left |
| `direction: left_135` | `pos_x = -0.75` | mirror of `rear_45` |
| `elevation: high` | `pos_y = 0.5` | looking down |
| `elevation: eye-level` | `pos_y = 0.0` | horizon |
| `elevation: low` | `pos_y = -0.5` | looking up |
| `distance: extreme_close_up` | `pos_z = 0.9` | face fills frame |
| `distance: close_up` | `pos_z = 0.5` | head-and-shoulders |
| `distance: medium` | `pos_z = 0.1` | 3/4 body |
| `distance: cowboy_shot` | `pos_z = -0.2` | mid-thigh up |
| `distance: full_body` | `pos_z = -0.5` | head-to-toes |
| `distance: wide` | `pos_z = -0.9` | environmental |
| `roll: 0.0 .. 1.0` | `roll` | 0 = no tilt, 1 = full tilt |

## Commands

| Action | Purpose |
|---|---|
| `describe` | Print the request contract + asset identity |
| `run` | Validate → patch → strip → enqueue → wait → download |
| `assets verify` | Re-check the bundled workflow asset against the manifest |

`--list-actions` returns this list verbatim.

### `describe`

```bash
camera-image describe --stage t2i --summary     # full contract + presets + example
camera-image describe --stage i2i               # minimal: identifiers only
camera-image describe --stage t2i               # also minimal
```

| Flag | Required | Choices | Effect |
|---|---|---|---|
| `--stage` | yes | `t2i`, `i2i` | Which stage's contract to describe |
| `--summary` | no | — | Add the full `request_fields`, `presets`, and `example` block |

`result.example` is the canonical request shape. Copy it into a file and feed it to `run`.

### `run`

```bash
# Standard interactive run
camera-image run --stage t2i --request req.json --output-dir temp/camera-image/

# Non-interactive (loader tool wrapper, automated pipeline)
camera-image run --stage i2i --request req.json --output-dir temp/camera-image/ --yes

# Point at a non-default ComfyUI server
camera-image run --stage t2i --request req.json --output-dir temp/camera-image/ \
    --comfyui-url http://192.168.1.42:8188 --yes

# Long-running session with custom timeout
camera-image run --stage t2i --request req.json --output-dir temp/camera-image/ \
    --timeout 3600 --poll-interval 5 --yes
```

| Flag | Required | Type | Default | Effect |
|---|---|---|---|---|
| `--stage` | yes | enum | — | `t2i` or `i2i` |
| `--request` | yes | path | — | Path to the request JSON file. UTF-8 (BOM tolerated). |
| `--output-dir` | no | path | `temp/camera-image/` | Where `summary.json` and the produced PNG land. Created if missing. |
| `--comfyui-url` | no | URL | `http://127.0.0.1:8188` | ComfyUI server base URL |
| `--timeout` | no | float (sec) | `1800` | Total wait-for-completion timeout |
| `--poll-interval` | no | float (sec) | `2.0` | History poll interval |
| `--yes` | no | flag | `false` | Skip the group-plan confirmation prompt |
| `--json` | no | flag | `false` | Universal flag; wire format is always P1 |

**Output**:

- One PNG in `<output-dir>` (ComfyUI picks the filename; the skill does not rename)
- `summary.json` in `<output-dir>` with `prompt_id`, `api_graph_sha256`, `uploads`, per-artifact `filename` + `sha256`, optional `strip_notes`, optional `queue_status`, and run-stage extras

Side effects: `temp/runtime/.workflow_cache/<timestamp>_camera-image-t2i_<hash>.json` (10-deep LRU, safe to delete).

### `assets verify`

```bash
camera-image assets verify --stage t2i
camera-image assets verify --stage i2i
```

Hashes the bundled UI workflow and re-runs the structural fingerprint against `manifest.json`. Run after editing `workflow/<stage>/groups.json`, or before bumping the manifest deliberately.

## Failure modes

| Envelope `code` | Exit | Cause | Recovery |
|---|---|---|---|
| `invalid_request` | 2 | `--request` path missing, JSON malformed, not UTF-8 | Fix the JSON file |
| `input_file_missing` | 2 | Any image path (`reference_image`, `controlnet_image`, region images, `signature_image`) does not exist on disk | Verify the path, then rerun |
| `group_confirmation_aborted` | 2 | Operator answered `N`, or stdin EOF without `--yes` | Edit the request to drop unwanted groups or set `--yes` |
| `validation_failed` | 3 | Unknown group title, unsupported request key, shape error, LoRA not in inventory, `profile_id` mismatch, `i2i` without `reference_image`, `t2i` with `reference_image`, `camera` missing a required field | Fix the request — error names the field |
| `validation_failed` (post-strip) | 3 | `validate_api_graph` rejects the API graph | Asset has changed; run `assets verify` |
| `fixed_workflow_invalid` | 4 | `camera-anima.json` sha256 mismatch, structural fingerprint mismatch, manifest unreadable | Revert the asset, or rotate the manifest deliberately |
| `node_id_format_mismatch` | 4 | Workflow node has non-integer `id` or duplicate ids | Asset is corrupt; revert |
| `comfyui_mcp_error` | 4 | npx or comfyui-mcp install path broken, MCP subprocess failed, MCP returned invalid response | Check `npx` + `comfyui-mcp` installation. Note: a custom LoRA request needs the MCP server reachable **at parse time** (name resolution calls `list_local_models`); if the server is down, the failure surfaces as `comfyui_mcp_error` rather than a clean `validation_failed`. |
| `comfyui_runtime_error` | 5 | ComfyUI rejected enqueue, HTTP error during polling, artifact download failed | Surface verbatim; ComfyUI's error code is the lead |
| `unexpected_error` | 70 | Anything else | Surface the traceback; this is a skill bug |

Failures are **fail-closed**: no automatic retry, no automatic fallback to an older asset, no graph rewriting to "make it work".

## Examples

All examples assume `<preset>` expands to your local install root. Each one is runnable end-to-end.

### 1. Minimal `t2i` — baked defaults

```bash
cat > req.json <<'JSON'
{
  "prompt": {
    "positive": "score_9, score_8_up, 1girl, anime portrait, cinematic lighting",
    "negative": "low quality, bad anatomy"
  },
  "profile_id": "camera-anima-v1",
  "preset": "portrait_full_body",
  "seed": 42
}
JSON

<preset>\.venv\Scripts\camera-image.exe run \
    --stage t2i --request req.json --output-dir temp/camera-image/ --yes
```

### 2. Minimal `i2i` — single reference

```bash
cat > req.json <<'JSON'
{
  "prompt": {"positive": "score_9, score_8_up, 1girl, anime portrait, cinematic lighting",
             "negative": "low quality, bad anatomy"},
  "profile_id": "camera-anima-v1",
  "reference_image": "C:/path/to/reference.png"
}
JSON

<preset>\.venv\Scripts\camera-image.exe run \
    --stage i2i --request req.json --output-dir temp/camera-image/ --yes
```

i2i auto-enables `加载图片（G1）` and forces node 58 = 2. `denoise_first` defaults to `0.6`.

### 3. Explicit camera + lens, preset's image_size

```bash
cat > req.json <<'JSON'
{
  "prompt": {"positive": "...", "negative": "..."},
  "profile_id": "camera-anima-v1",
  "preset": "portrait_full_body",
  "camera": {"direction": "rear_45", "elevation": "low", "distance": "medium", "roll": 0.05},
  "camera_extra": {
    "lens_enabled": true, "lens_value": "50mm lens",
    "dof_enabled":  true, "dof_weight":  1.5, "dof_value": "shallow depth of field"
  }
}
JSON

<preset>\.venv\Scripts\camera-image.exe run \
    --stage t2i --request req.json --output-dir temp/camera-image/ --yes
```

### 4. Custom sampling — Karras + higher denoise

```bash
cat > req.json <<'JSON'
{
  "prompt": {"positive": "...", "negative": "..."},
  "profile_id": "camera-anima-v1",
  "sampling": {"steps_first": 28, "cfg": 7.5,
               "sampler": "euler_ancestral", "scheduler": "karras",
               "denoise_first": 0.92}
}
JSON

<preset>\.venv\Scripts\camera-image.exe run \
    --stage t2i --request req.json --output-dir temp/camera-image/ --yes
```

### 5. Replace the default LoRA stack

```bash
cat > req.json <<'JSON'
{
  "prompt": {"positive": "...", "negative": "..."},
  "profile_id": "camera-anima-v1",
  "lora": {"selections": [{"name": "Anima风格-哥特霓虹", "strength_model": 1.0,
                            "strength_clip": 1.0, "active": true, "trigger_words": []}]}
}
JSON

<preset>\.venv\Scripts\camera-image.exe run \
    --stage t2i --request req.json --output-dir temp/camera-image/ --yes
```

The `name` is resolved against the live Anima-folder LoRA inventory via `comfyui-mcp list_local_models`. If not installed, the run aborts at parse time with `validation_failed`.

### 6. Add the Pre/PostDetailer chain

```bash
cat > req.json <<'JSON'
{
  "prompt": {"positive": "...", "negative": "..."},
  "profile_id": "camera-anima-v1",
  "groups": {"g1": ["高清 PreDetailer（G1）", "高清 PostDetailer（G1）"], "g2": []}
}
JSON

<preset>\.venv\Scripts\camera-image.exe run \
    --stage t2i --request req.json --output-dir temp/camera-image/ --yes
```

The user list is unioned with the default group set, so you don't need to repeat `保存图片`, `第二轮采样器（G1）`, `相机视角生图（G1）`, etc.

### 7. `i2i` with `denoise_first: 0.9`

```bash
cat > req.json <<'JSON'
{
  "prompt": {"positive": "...", "negative": "..."},
  "profile_id": "camera-anima-v1",
  "reference_image": "C:/path/ref.png",
  "camera": {"direction": "rear_45", "elevation": "low", "distance": "medium", "roll": 0.05},
  "camera_extra": {"lens_enabled": true, "lens_value": "50mm lens",
                   "dof_enabled": true, "dof_weight": 1.5, "dof_value": "shallow depth of field"},
  "sampling": {"denoise_first": 0.9}
}
JSON

<preset>\.venv\Scripts\camera-image.exe run \
    --stage i2i --request req.json --output-dir temp/camera-image/ --yes
```

### 8. `i2i` plate — controlnet pose + region prompts + signature

```bash
cat > req.json <<'JSON'
{
  "prompt": {"positive": "...", "negative": "..."},
  "profile_id":       "camera-anima-v1",
  "reference_image":  "C:/path/ref.png",
  "controlnet_image": "C:/path/pose.png",
  "red_prompt":       "red armor with battle damage",
  "green_prompt":     "emerald energy field",
  "blue_prompt":      "arctic wind aura",
  "red_image":        "C:/path/red_ref.png",
  "green_image":      "C:/path/green_ref.png",
  "blue_image":       "C:/path/blue_ref.png",
  "signature_image":  "C:/path/signature.png"
}
JSON

<preset>\.venv\Scripts\camera-image.exe run \
    --stage i2i --request req.json --output-dir temp/camera-image/ --yes
```

Setting `controlnet_image` enables `ControlNet LLLite（G1）`; setting any region prompt enables `区域提示词（G1）`; setting `signature_image` enables `添加签名（G1）`. These are in addition to the i2i-mandatory `加载图片（G1）`.

## Pipeline (one run, end-to-end)

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
                           cache_workflow()  ──► temp/runtime/.workflow_cache/*.json
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

## Delivery gate

Before shipping a run, check:

```
[ ] profile_id == "camera-anima-v1" (or omitted — auto-filled)
[ ] prompt.positive is a non-empty string
[ ] stage == "i2i" implies reference_image is a path that exists on disk
[ ] stage == "t2i" implies reference_image is absent
[ ] every groups.g1 / groups.g2 title matches workflow/<stage>/groups.json exactly
[ ] every custom LoRA name resolves against mcp.list_local_models
[ ] camera_extra.extreme_weight ∈ [0.0, 10.0], dof_weight ∈ [0.0, 5.0]
[ ] camera.roll ∈ [0.0, 1.0]
[ ] image_size.{width, height} are positive multiples of 8
[ ] sampling.sampler and sampling.scheduler are in the allowed enums
[ ] evidence carries enough journal for the human reviewer to understand intent
```

If a box fails, fix the request — never patch a running graph.

## See also

- [`references/field-reference.md`](references/field-reference.md) — full per-field rules (camera_extra 13 fields, LoRA resolution, sampling enums, group titles)
- [`references/pipeline.md`](references/pipeline.md) — per-step hard contracts
- [`camera_image/runtime/workflow_assets/README.md`](camera_image/runtime/workflow_assets/README.md) — bundled asset contract
- [`../../docs/cli-cookbook.md`](../../docs/cli-cookbook.md) — every CLI invocation form
- [`../../docs/troubleshooting.md`](../../docs/troubleshooting.md) — error recovery
- [`../../docs/development.md`](../../docs/development.md) — asset / manifest maintenance
