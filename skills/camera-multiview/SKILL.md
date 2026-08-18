---
name: camera-multiview
description: "Run the locked Flux2-Klein multi-view workflow on ComfyUI from a full-body image and a face image; produce one multi-view sheet per pose slot of the bundled asset. Load this skill immediately on any character-sheet / three-view / reference-sheet request — do not improvise with generic image tools."
whenToUse: "User wants a character reference sheet, three-view, or multi-pose character set generated from existing full-body + face images. The output is a set of character images, not prose."
---

# Camera Multiview

A **fixed-asset black-box skill**: load the bundled Flux2-Klein workflow, upload the user's full-body + face reference images, upload the bundled pose skeletons, patch the 15 LoadImage inputs, hand the patched API graph to ComfyUI, download the saved outputs.

The skill does **not** plan creative direction, author prompts, choose samplers, expose controls, or invent alternative workflows. The workflow asset defines everything; the user's role is to supply two images.

## When to call

Call this skill when the user wants a character reference sheet, three-view, or multi-pose character set, and they have already provided (or you have access to) both a full-body reference image and a face reference image of the same character.

Do not call when:

- The user has no reference images yet — they need a generation step first (use `camera-image`).
- The user wants a single image, not a multi-view set — use `camera-image`.
- The user wants video — use `camera-video`.
- The user wants prose, prompts, or creative direction — those are different skills (e.g. `anima-prompt-v1`).

## First principle

**The workflow asset is invariant.** The bundled 261-node Flux2-Klein JSON is the only execution source. The skill verifies its SHA-256 and node topology on every run; if anything has drifted, the skill stops and reports — it does not repair, rewire, or fall back to an older version. To change the contract, republish the asset, manifest, `spec.py`, and SKILL.md together.

This skill owns two configurable values — the two image paths. Every other visual decision (prompt, sampler, seed, camera angle, LoRA, etc.) is fixed in the workflow.

## Quick start

```bash
cat > req.json <<'JSON'
{
  "full_body_image": "C:/path/to/full-body.png",
  "face_image":      "C:/path/to/face.png"
}
JSON

<preset>\.venv\Scripts\camera-multiview.exe describe --summary

<preset>\.venv\Scripts\camera-multiview.exe run \
    --request req.json \
    --output-dir temp/camera-multiview/multiview-1/
```

Typical wall-clock: **~8 minutes** end-to-end (5s uploads + 1–2s build/validate + ~470s ComfyUI execution + ~1s history poll).

## Request schema

```jsonc
{
  "full_body_image": "C:/path/to/full-body.png",   // required, local image
  "face_image":      "C:/path/to/face.png"         // required, local image
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `full_body_image` | local path | **yes** | Must exist on disk at run time |
| `face_image` | local path | **yes** | Must exist on disk at run time |

Both fields are non-empty strings that point to local image files existing on disk at the time of the run. Anything else in the request is rejected at parse time.

What this skill does **not** expose: prompts, samplers, LoRAs, ControlNet, dimensions, seeds, group switches, presets, region prompts, alternate workflows. The bundled asset defines all of those.

## Commands

| Action | Purpose |
|---|---|
| `describe` | Print the request contract + asset identity |
| `assets verify` | Verify SHA-256 of workflow + 13 poses against the manifest |
| `run` | Validate → upload → patch → enqueue → wait → download |

`--list-actions` returns this list verbatim.

### `describe`

```bash
<preset>\.venv\Scripts\camera-multiview.exe describe --summary
```

`--summary` adds the example block. Output:

```json
{
  "ok": true,
  "command": "describe",
  "stage": "multiview",
  "result": {
    "stage": "multiview",
    "request": {
      "full_body_image": "string, required (local image path)",
      "face_image":      "string, required (local image path)"
    },
    "example": {
      "full_body_image": "C:/path/to/full-body.png",
      "face_image":      "C:/path/to/face.png"
    },
    "output": "one multi-view image per pose slot of the bundled asset (13 total)",
    "asset_workflow_name": "Flux2-Klein人物一键多视图工作流.json",
    "asset_sha256": "33584a54b6587914fce078cdcddbab7915e7d834ca741ded06a44a3ba484252e",
    "workflow_node_count": 261,
    "pose_count": 13
  },
  "errors": [],
  "advisories": []
}
```

### `run`

```bash
# Standard run
<preset>\.venv\Scripts\camera-multiview.exe run \
    --request  temp/camera-multiview/request.json \
    --output-dir  temp/camera-multiview/run1/

# Non-default ComfyUI server
<preset>\.venv\Scripts\camera-multiview.exe run \
    --request  temp/camera-multiview/request.json \
    --output-dir  temp/camera-multiview/run1/ \
    --comfyui-url  http://192.168.1.42:8188

# Long-running with custom timeout
<preset>\.venv\Scripts\camera-multiview.exe run \
    --request  temp/camera-multiview/request.json \
    --output-dir  temp/camera-multiview/run1/ \
    --timeout 3600 --poll-interval 3
```

| Flag | Required | Type | Default | Effect |
|---|---|---|---|---|
| `--request` | yes | path | — | Path to a JSON file with `full_body_image` + `face_image` |
| `--output-dir` | no | path | `temp/camera-multiview/` | Where the 12 character sheets + `summary.json` land. Created if missing. |
| `--comfyui-url` | no | URL | `http://127.0.0.1:8188` | ComfyUI server base URL |
| `--timeout` | no | float (sec) | `1800` | Total wall-clock budget for `wait_for_outputs` |
| `--poll-interval` | no | float (sec) | `2.0` | History poll interval |
| `--mcp-timeout` | no | float (sec) | `60` | Per-MCP-call timeout |
| `--json` | no | flag | `false` | Universal flag; wire format is always P1 |

Console output during a successful run:

```text
[camera-multiview] stage: multiview
[camera-multiview] comfyui: http://127.0.0.1:8188
[camera-multiview] output: .../temp/camera-multiview/run1
[camera-multiview] full_body: .../temp/camera-multiview/full_body_input.png
[camera-multiview] face:      .../temp/camera-multiview/face_input.png
[camera-multiview] prompt_id:   82527df3-28f1-4783-820e-e9f494465e76
[camera-multiview] graph_sha256: 33584a54b6587914...
[camera-multiview] status:      success
[camera-multiview] elapsed:     473.9s
[camera-multiview] uploads:     15
[camera-multiview] artifacts:   12
  - zove_00020_.png  4965064 bytes  (node 201)
  - face_00005_.png  1126995 bytes  (node 524)
  - z_00005_.png     1346012 bytes  (node 498)
  - ...
[camera-multiview] summary: .../temp/camera-multiview/run1/summary.json
```

### `assets verify`

```bash
<preset>\.venv\Scripts\camera-multiview.exe assets verify
```

Hashes the workflow JSON, all 13 pose PNGs, and the manifest. Aborts with exit 4 if anything has drifted.

```json
{
  "ok": true,
  "command": "assets verify",
  "stage": "multiview",
  "result": {
    "verified": true,
    "stage": "multiview",
    "asset_workflow_name": "Flux2-Klein人物一键多视图工作流.json",
    "asset_sha256": "33584a54...",
    "workflow_node_count": 261,
    "pose_count": 13,
    "poses": [
      {"filename": "姿势骨架1.png",  "sha256": "a6e988ca..."},
      {"filename": "姿势骨架2.png",  "sha256": "9729498d..."},
      ...
    ]
  }
}
```

Run this after editing the workflow asset, before bumping the manifest, or before any production run.

## Output: `summary.json`

```json
{
  "prompt_id":        "82527df3-28f1-4783-820e-e9f494465e76",
  "api_graph_sha256": "33584a54...",
  "status":           "success",
  "uploads": [
    {"config_key": "full_body_image", "filename": "full_body_input.png", "subfolder": ""},
    {"config_key": "face_image",      "filename": "face_input.png",      "subfolder": ""},
    {"pose": "姿势骨架1.png",  "filename": "姿势骨架1.png",  "subfolder": ""},
    ...
  ],
  "artifacts": [
    {"node_id": "201", "filename": "zove_00020_.png", "remote_filename": "zove_00020_.png",
     "subfolder": "", "bytes": 4965064},
    {"node_id": "524", "filename": "face_00005_.png", "remote_filename": "face_00005_.png",
     "subfolder": "", "bytes": 1126995},
    ...
  ],
  "error_messages": [],
  "elapsed_seconds": 473.9
}
```

| Field | Meaning |
|---|---|
| `prompt_id` | ComfyUI prompt_id for this run |
| `api_graph_sha256` | SHA-256 of the exact API graph that was enqueued (audit) |
| `status` | `success` or `error` |
| `uploads` | One entry per image uploaded (2 user + 13 pose) |
| `artifacts` | One entry per SaveImage output downloaded (12 typical) |
| `error_messages` | Non-empty only when `status="error"` |
| `elapsed_seconds` | Wall-clock from `prepare_graph` start to result |

Only `SaveImage` outputs are downloaded. `PreviewImage` outputs (temp files ComfyUI cleans up after the run) are intentionally excluded.

## Failure modes

| Envelope `code` | Exit | Cause | Recovery |
|---|---|---|---|
| `invalid_request` | 2 | `--request` missing/malformed; unknown field | Only `full_body_image` + `face_image` are accepted |
| `input_file_missing` | 2 | `full_body_image` or `face_image` doesn't exist on disk | Verify the path; the skill does not auto-create |
| `AssetError` | 4 | Fixed asset drifted: workflow SHA-256 changed, pose node renamed, manifest mismatch | Revert the asset, or run `assets verify`; the file or `spec.py` is out of sync |
| `comfyui_mcp_error` | 4 | npx / comfyui-mcp install path broken, MCP subprocess failed | Check `npx` + `comfyui-mcp` |
| `McpError` (Method not found) | 5 | ComfyUI server doesn't have a needed custom node | Install the missing node |
| `McpError` (timed out) | 5 | ComfyUI execution exceeded `--timeout` | Increase `--timeout` (default 1800s) or check the queue |
| `McpError` (`status="error"`) | 5 | ComfyUI ran the graph but reported an error | Read `error_messages[]` in `summary.json` (usually a missing model file or LoRA on the server) |
| `McpError` (stdout closed) | 5 | `comfyui-mcp` subprocess crashed mid-run | Re-run; the subprocess is spawned fresh per `McpSession` |
| `unexpected_error` | 70 | Anything else | Surface the traceback |

## Examples

### Example 1 — Standard run

```bash
cat > req.json <<'JSON'
{
  "full_body_image": "C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/temp/camera-multiview/full_body_input.png",
  "face_image":      "C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/temp/camera-multiview/face_input.png"
}
JSON

<preset>\.venv\Scripts\camera-multiview.exe run \
    --request  req.json \
    --output-dir  temp/camera-multiview/run1/
```

After ~8 minutes:

```
temp/camera-multiview/run1/
├── zove_00020_.png        ← 12 character sheets
├── face_00005_.png
├── z_00005_.png
├── ...
└── summary.json
```

### Example 2 — Remote ComfyUI server

```bash
<preset>\.venv\Scripts\camera-multiview.exe run \
    --request  req.json \
    --output-dir  temp/camera-multiview/run1/ \
    --comfyui-url  http://192.168.1.42:8188 \
    --timeout  3600 \
    --poll-interval  3
```

### Example 3 — Verify assets before a production run

```bash
<preset>\.venv\Scripts\camera-multiview.exe assets verify

# Expect: "verified": true + 13 pose sha256s
# If false: the workflow JSON or one of the poses was edited; revert or republish
```

## Asset identity

| File | Role |
|---|---|
| `runtime/workflow_assets/Flux2-Klein人物一键多视图工作流.json` | Fixed API graph (261 nodes) |
| `runtime/workflow_assets/manifest.json` | SHA-256 hashes + node count |
| `runtime/workflow_assets/pose/姿势骨架{1..13}.png` | 13 fixed pose skeleton assets |

Drift on any of these raises `AssetError` and stops the skill.

### Node mapping (immutable)

The 15 LoadImage inputs the skill writes to:

| Config key | Node ID | Node title (`_meta.title`) |
|---|---|---|
| `full_body_image` | `111` | `加载图像（人物全身）` |
| `face_image` | `667` | `加载图像（人物面部）` |
| pose 1..13 | `152, 154, 360, 364, 148, 149, 147, 373, 150, 367, 368, 151, 757` | `姿势骨架1`..`姿势骨架13` |

Encoded once in [`camera_multiview/spec.py`](camera_multiview/spec.py); never duplicated in call sites.

## Pipeline (8 phases)

```
verify_assets → upload user images → upload poses → build_graph → validate_graph → validate_bindings → enqueue → wait → download
     ↓                  ↓                ↓             ↓              ↓                ↓            ↓        ↓        ↓
  pure local        mcp I/O          mcp I/O      pure transform   pure local     pure local   mcp I/O   http     http
```

Each phase is independently callable. See [`references/pipeline.md`](references/pipeline.md) for the per-phase contract.

## Delivery gate

Before shipping a run:

```
[ ] full_body_image and face_image are non-empty paths that exist on disk
[ ] camera-multiview assets verify  ->  verified: true
[ ] the bundled workflow has the expected SHA-256
[ ] both images are the same character (full body shows the face)
[ ] --timeout >= 600 (typical run takes ~470s)
[ ] --output-dir is writable
```

## See also

- [`references/pipeline.md`](references/pipeline.md) — 8-phase execution in detail
- [`references/assets.md`](references/assets.md) — bundled asset identity + maintenance
- [`references/graph.md`](references/graph.md) — node mapping + `build_graph` internals
- [`references/contracts.md`](references/contracts.md) — `validate_graph` / `validate_bindings`
- [`references/mcp-session.md`](references/mcp-session.md) — JSON-RPC over comfyui-mcp stdio
- [`references/cli.md`](references/cli.md) — CLI subcommands in detail
- [`references/examples.md`](references/examples.md) — worked end-to-end examples
- [`../../docs/cli-cookbook.md`](../../docs/cli-cookbook.md) — every CLI invocation form
- [`../../docs/troubleshooting.md`](../../docs/troubleshooting.md) — error recovery
- [`../camera-image/SKILL.md`](../camera-image/SKILL.md) — single-image generation (the upstream skill)
- [`../camera-video/SKILL.md`](../camera-video/SKILL.md) — animated video via MiniMax H3
