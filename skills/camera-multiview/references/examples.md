# Worked Examples

Six end-to-end examples, each showing the exact invocation and the
expected output. The first four use real data from a successful run
against a live ComfyUI server. The last two are offline-only.

## Example 1 — Minimal end-to-end run

The simplest possible invocation: a previously ComfyUI-generated
character image used for both `full_body_image` and (cropped for)
`face_image`.

**Inputs**:
- `full_body_input.png` — 1216×832 character shot, ~1.7 MB
- `face_input.png` — 500×320 face crop, ~260 KB

**Request file** (`temp/camera-multiview/request.json`):

```json
{
  "full_body_image": "C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/temp/camera-multiview/full_body_input.png",
  "face_image":      "C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/temp/camera-multiview/face_input.png"
}
```

**Command**:

```bash
python -m camera_multiview.cli run \
    --request temp/camera-multiview/request.json \
    --output-dir temp/camera-multiview/run1 \
    --timeout 1200 --poll-interval 3
```

**Wall clock**: ~474s. **Output**: 13 character images (one full
composition + 12 multi-view sheets) in `temp/camera-multiview/run1/`, plus
`summary.json` recording the prompt_id and graph hash.

See [SKILL.md § `run`](../SKILL.md#run) for the full console output
and the exit-code table.

## Example 2 — The `summary.json` shape

After the run in Example 1, `temp/camera-multiview/run1/summary.json` contains:

```jsonc
{
  "prompt_id":        "82527df3-28f1-4783-820e-e9f494465e76",
  "api_graph_sha256": "33584a54...",
  "status":           "success",
  "uploads": [
    {"config_key": "full_body_image", "filename": "full_body_input.png", "subfolder": ""},
    {"config_key": "face_image",      "filename": "face_input.png",      "subfolder": ""},
    {"pose": "姿势骨架1.png",  "filename": "姿势骨架1.png",  "subfolder": ""},
    ...   // 11 more
  ],
  "artifacts": [
    {"node_id": "201", "filename": "zove_00020_.png",  "remote_filename": "zove_00020_.png",  "subfolder": "", "bytes": 4965064},
    {"node_id": "524", "filename": "face_00005_.png", "remote_filename": "face_00005_.png", "subfolder": "", "bytes": 1126995},
    ...   // 10 more
  ],
  "error_messages": [],
  "elapsed_seconds": 473.9
}
```

- `uploads[]` — 15 entries: 2 user + 13 pose
- `artifacts[]` — 12 entries: 9 SaveImage nodes producing 12 images
- `error_messages[]` — empty on success
- `elapsed_seconds` — wall clock from `prepare_graph` start to result

`api_graph_sha256` is the SHA-256 of the exact API graph that was
enqueued. Two runs with the same `api_graph_sha256` produced
identical images.

## Example 3 — What the 12 character views look like

The 12 SaveImage outputs from a single run, grouped by character
view (each view name comes from the corresponding `SaveImage`'s
`widgets_values[0]`, which is the user's title in the workflow JSON):

| Group | Views | Notes |
|---|---|---|
| Face | `face_00005_.png` (720×1024) | Head-and-shoulders close-up |
| Front body | `z_00005_.png`, `zhen up_00005_.png` | Full body + upper body |
| Sides (upper) | `side up2_00013_.png`, `side up2_00014_.png` | 45° left upper body |
| Back (upper) | `side up2_00015_.png` | Back upper body |
| Sides (full) | `zove _00009_.png`, `zove _00010_.png` | Left + right full body |
| 45° sides | `zove_00017_.png`, `zove_00018_.png`, `zove_00019_.png` | Front-left, left, right 45° |
| Corner | `45_00005_.png` | Single small frame (corner overlay) |
| Composition | `zove_00020_.png` (3178×1414, ~5 MB) | All-views sheet with input image on the left |

The 12 views share the same character identity (hair, face, outfit,
sword) because the workflow uses `IP-Adapter`-style reference locking
on the full-body input and face input.

## Example 4 — Run with a face image that doesn't match the body

If the user supplies a `face_image` of a different person than the
`full_body_image`, the workflow still runs to completion (ComfyUI
doesn't validate identity), but the multi-view sheets will show
inconsistent faces — the body pose comes from the pose skeleton +
full-body input, the face from the face input. The skill won't catch
this; the artifact will look wrong but `summary.json` reports
`status: "success"`.

This is by design: visual content validation is out of scope. A
downstream vision skill can compare the artifacts against the inputs
and flag the inconsistency.

## Example 5 — Offline: prepare_graph without ComfyUI

To test the graph-build + validation logic without spinning up an
MCP session, use a stub:

```python
from pathlib import Path
from camera_multiview import (
    build_graph, load_workflow, prepare_graph, RunConfig,
    UploadResult, validate_bindings, validate_graph,
)

workflow = load_workflow()

# Stub the upload — what hydrate.upload_user_images would return.
stub_user = {
    "full_body_image": UploadResult(name="uploaded_full.png"),
    "face_image":      UploadResult(name="uploaded_face.png"),
}
# Stub the pose uploads — what hydrate.upload_poses would return.
stub_pose = {
    f"姿势骨架{i}.png": UploadResult(name=f"u_pose_{i}.png")
    for i in range(1, 14)
}

# Build the graph manually (skip the mcp session).
user_image_composites = {k: v.composite for k, v in stub_user.items()}
pose_composites = {k: v.composite for k, v in stub_pose.items()}
graph = build_graph(
    workflow=workflow,
    user_image_names=user_image_composites,
    pose_names=pose_composites,
)
validate_graph(graph)
validate_bindings(
    graph,
    user_image_names=user_image_composites,
    pose_names=pose_composites,
)
assert graph["111"]["inputs"]["image"] == "uploaded_full.png"
assert graph["667"]["inputs"]["image"] == "uploaded_face.png"
assert graph["152"]["inputs"]["image"] == "u_pose_1.png"
assert graph["757"]["inputs"]["image"] == "u_pose_13.png"
print("graph built and validated")
```

For the actual `prepare_graph` end-to-end without a ComfyUI server,
see `temp/camera-multiview/test_phases.py` — it exercises the same paths with a real
`McpSession` against `comfyui-mcp`, or with stubbed mcp clients
where the live server isn't available.

## Example 6 — Drift detection

To confirm the bundled asset's identity is intact:

```bash
$ python -m camera_multiview.cli assets verify
{
  "verified": true,
  ...
  "asset_sha256": "33584a54b6587914fce078cdcddbab7915e7d834ca741ded06a44a3ba484252e",
  "poses": [
    {"filename": "姿势骨架1.png", "sha256": "a6e988ca..."},
    ...
  ]
}
# exit code: 0
```

If you edit any file under `runtime/workflow_assets/`, the next
`assets verify` fails:

```bash
# After editing the workflow JSON to add a node:
$ python -m camera_multiview.cli assets verify
ERROR: ValueError: workflow node count changed: expected 261, got 262
# exit code: 4
```

To fix: re-extract the asset from its source, OR update `spec.py`'s
`EXPECTED_WORKFLOW_SHA256` and `manifest.json` if the change is
intentional (see [assets.md](assets.md) for the asset replacement
protocol).