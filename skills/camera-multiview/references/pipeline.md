# Pipeline (8 phases)

End-to-end execution in 8 ordered phases. Each phase is independently
callable; the orchestrator (`executor.run`) calls them in this order.
Wall-clock budget for a typical run: **~8 minutes** (5s uploads + 1-2s
build/validate + ~470s ComfyUI execution + 1s polls).

## Phase 1 — `assets.verify_assets()`

**What**: SHA-256 of the workflow JSON + manifest + 13 pose PNGs.
**Reads**: local files only.
**Writes**: nothing.
**Failure**: `AssetError` if any of these drift from the manifest:
- `workflow.json` SHA-256 != `spec.EXPECTED_WORKFLOW_SHA256`
- `manifest.workflow.sha256` != actual file SHA-256
- `manifest.workflow.node_count` != 261
- Any pose PNG missing or its SHA-256 != manifest entry
- Workflow has the wrong node count
- Any of the 15 LoadImage nodes is missing, has the wrong class, or
  has the wrong title

```python
from camera_multiview import verify_assets
identity = verify_assets()
# identity.workflow_sha256  == "33584a54..."
# identity.pose_count      == 13
```

## Phase 2 — `hydrate.upload_user_images(mcp, *, full_body_path, face_path)`

**What**: Push the 2 user image files to ComfyUI's input/ directory.
**Reads**: the 2 local image paths from `config`.
**Writes**: nothing to disk; uploads via MCP `tools/call upload_image`.
**Returns**: `dict[str, UploadResult]` — `{config_key: UploadResult}`.
**Failure**: `McpError` if the upload response can't be parsed; `FileNotFoundError` if a path doesn't exist on disk (caught earlier in `prepare_graph`).

```python
from camera_multiview import McpSession, upload_user_images
from pathlib import Path
with McpSession() as session:
    names = upload_user_images(
        session,
        full_body_path=Path("C:/refs/full.png"),
        face_path=Path("C:/refs/face.png"),
    )
# names == {
#     "full_body_image": UploadResult(name="full.png", subfolder=""),
#     "face_image":      UploadResult(name="face.png",  subfolder=""),
# }
```

## Phase 3 — `hydrate.upload_poses(mcp, pose_paths)`

**What**: Push the 13 bundled pose PNGs to ComfyUI.
**Reads**: `spec.all_pose_paths()` (in numeric order 1..13).
**Writes**: nothing to disk.
**Returns**: `dict[str, UploadResult]` — `{pose_filename: UploadResult}`.
**Failure**: same as Phase 2.

The 13 poses are unconditional — every run uploads all of them.
~650 KB total, ~50ms per upload. No HTTP probe for "already cached";
uploading the same filename again is a no-op on the ComfyUI side.

## Phase 4 — `graph.build_graph(workflow, *, user_image_names, pose_names)`

**What**: Deep-copy the 261-node workflow and write 15 image inputs.
**Reads**: the loaded workflow dict + the upload records.
**Writes**: a new dict (deep copy) with 15 patched slots.
**Returns**: the new API graph dict.
**Failure**: `ValueError` if any pose is missing or any user image is missing.

```python
from camera_multiview import load_workflow, build_graph
workflow = load_workflow()
graph = build_graph(
    workflow=workflow,
    user_image_names={"full_body_image": "x.png", "face_image": "y.png"},
    pose_names={f"姿势骨架{i}.png": f"u_{i}.png" for i in range(1, 14)},
)
# graph["111"]["inputs"]["image"] == "x.png"
# graph["667"]["inputs"]["image"] == "y.png"
# graph["152"]["inputs"]["image"] == "u_1.png"
# graph["757"]["inputs"]["image"] == "u_13.png"
```

See [graph.md](graph.md) for the patch mechanics.

## Phase 5 — `contracts.validate_graph(graph)`

**What**: Structural well-formedness check on the patched API graph.
**Reads**: the graph dict.
**Writes**: nothing.
**Failure**: `ValueError` with a structural reason (no output node,
dangling link, frontend-only class, etc.).

This is the only check that knows the ComfyUI API graph format. The
contract: non-empty dict, every node has `class_type`+`inputs`, no
frontend-only classes (`easy getNode`, `easy setNode`, `Reroute`), every
`[node_id, slot]` link resolves, every `SaveImage`/`PreviewImage` has
an `images` link, at least one image output.

## Phase 6 — `contracts.validate_bindings(graph, *, user_image_names, pose_names)`

**What**: Every patched image input references a name from the upload
records. This is the contract that catches "I forgot to thread an
upload result into the graph".
**Reads**: the graph + the upload records.
**Writes**: nothing.
**Failure**: `ValueError` naming the offending node and the expected vs
actual string.

```python
from camera_multiview import validate_bindings
# Pass: graph["111"]["inputs"]["image"] == user_image_names["full_body_image"]
validate_bindings(
    graph,
    user_image_names=user_image_names,
    pose_names=pose_names,
)
# Fail (after bad patch):
# graph["111"]["inputs"]["image"] = "wrong.png"
# ValueError: user image node 111 image 'wrong.png' does not match
#             uploaded name 'full.png'
```

## Phase 7 — `McpSession.enqueue(graph)` + `wait_for_outputs(prompt_id)`

**What**: Submit the patched API graph to ComfyUI's queue, then poll
`/history/<prompt_id>` until the run reaches a terminal status
(`success`, `error`, or `failed`).
**Reads**: the API graph; the ComfyUI history endpoint.
**Writes**: nothing.
**Returns**: `RunOutputs(status, outputs, error_messages)`.

`enqueue` is fire-and-forget from ComfyUI's perspective: the workflow
runs in the background. The skill then polls `/history/<prompt_id>`
every `--poll-interval` seconds (default 2s).

**Failure modes**:
- `McpError: Method not found` — the workflow references a class
  ComfyUI doesn't have. Install the missing custom node.
- `McpError: timed out` — execution exceeded `--timeout`. Increase
  or check ComfyUI's queue.
- `RunOutputs(status="error")` — execution finished but failed.
  Read `error_messages[]`; usually a missing model file on the server.

```python
enqueue = session.enqueue(graph)
# EnqueueResult(prompt_id="82527df3-...")

outputs = session.wait_for_outputs(
    enqueue.prompt_id,
    poll_interval=2.0,
    total_timeout=1800.0,
)
# RunOutputs(status="success", outputs=(NodeOutput(...), ...), error_messages=())
```

## Phase 8 — Download SaveImage outputs

**What**: Walk the `RunOutputs.outputs`, skip anything that isn't a
`SaveImage` (or whose top-level prefix isn't), and download each image
to `<output-dir>/`.
**Reads**: the outputs from Phase 7; the workflow dict (for the
`SaveImage` class check); the ComfyUI `/view` endpoint.
**Writes**: one PNG per `SaveImage` output to `<output-dir>/`, plus
`summary.json`.

```python
for node in outputs.outputs:
    if not _node_is_save_image(workflow, node.node_id):
        continue  # skip PreviewImage (temp files, 404)
    for img in node.images:
        data = session.get_image(img["filename"], subfolder=img.get("subfolder", ""))
        Path(out_dir / _artifact_name(img["filename"], idx)).write_bytes(data)
```

**Why filter**: ComfyUI's 20 output nodes split into 9 SaveImage
(persistent) and 11 PreviewImage (temp). The 11 PreviewImage nodes
write to `type=temp`; ComfyUI cleans them up before the next history
poll. Attempting to download them produces 404 noise. Filtering at
the source is provably exact: against the live run1 history, the
filter identifies the same 12 images the old code eventually
downloaded, and skips the 15 PreviewImage outputs that 404'd.

## What `executor.run` does in one call

```python
from pathlib import Path
from camera_multiview import McpSession, RunConfig, run

config = RunConfig.from_envelope(
    envelope={},
    full_body_image="C:/refs/full.png",
    face_image="C:/refs/face.png",
)
with McpSession() as session:
    result = run(
        session,
        config,
        output_dir=Path("temp/camera-multiview/run1"),
        poll_interval=3.0,
        total_timeout=1800.0,
    )
# result.prompt_id         == "82527df3-..."
# result.api_graph_sha256  == "33584a54..."
# result.status            == "success"
# result.artifacts         == (12 dicts)
# summary.json written to temp/camera-multiview/run1/
```

`run` is the only public function that touches all 8 phases. If you
need to test or instrument a single phase, call the per-phase
functions directly.