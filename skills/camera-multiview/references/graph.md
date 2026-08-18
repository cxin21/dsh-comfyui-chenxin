# Graph Build

The skill patches a 261-node Flux2-Klein workflow by writing exactly
**15 image inputs** — 2 user images and 13 pose skeletons — and nothing
else. This file documents the patch contract and the `build_graph`
mechanics.

## The 15 LoadImage nodes

The bundled workflow has 15 `LoadImage` nodes that the skill must write
to. These are the **only** workflow inputs the skill touches.

### 2 user image nodes

| Config key | Node ID | `_meta.title` |
|---|---|---|
| `full_body_image` | `111` | `加载图像（人物全身）` |
| `face_image` | `667` | `加载图像（人物面部）` |

These are direct user uploads. The skill substitutes each one with
the filename returned by `McpSession.upload_image`.

### 13 pose nodes

The 13 pose skeletons are bundled in
`runtime/workflow_assets/pose/姿势骨架{1..13}.png`. The skill uploads
each one and substitutes the corresponding `LoadImage` node's `image`
input.

| Index | Filename | Node ID | `_meta.title` |
|---|---|---|---|
| 1  | `姿势骨架1.png`  | `152` | `姿势骨架1`  |
| 2  | `姿势骨架2.png`  | `154` | `姿势骨架2`  |
| 3  | `姿势骨架3.png`  | `360` | `姿势骨架3`  |
| 4  | `姿势骨架4.png`  | `364` | `姿势骨架4`  |
| 5  | `姿势骨架5.png`  | `148` | `姿势骨架5`  |
| 6  | `姿势骨架6.png`  | `149` | `姿势骨架6`  |
| 7  | `姿势骨架7.png`  | `147` | `姿势骨架7`  |
| 8  | `姿势骨架8.png`  | `373` | `姿势骨架8`  |
| 9  | `姿势骨架9.png`  | `150` | `姿势骨架9`  |
| 10 | `姿势骨架10.png` | `367` | `姿势骨架10` |
| 11 | `姿势骨架11.png` | `368` | `姿势骨架11` |
| 12 | `姿势骨架12.png` | `151` | `姿势骨架12` |
| 13 | `姿势骨架13.png` | `757` | `姿势骨架13` |

`PoseSpec.index` and `PoseSpec.node_id` are encoded once in
[`spec.POSES`](../camera_multiview/spec.py). The `filename` is derived
(`f"姿势骨架{index}.png"`); the `title` is also derived
(`f"姿势骨架{index}"`, no `.png` extension — that's how the bundled
workflow's `_meta.title` is set).

## The `build_graph` contract

```python
def build_graph(
    *,
    workflow: dict[str, Any],
    user_image_names: dict[str, str],   # config_key -> composite name
    pose_names: dict[str, str],          # pose filename -> composite name
) -> dict[str, Any]:
    """Deep-copy the workflow and write 15 image inputs.

    `user_image_names` and `pose_names` must cover every spec entry.
    """
```

Both dict arguments carry **composite names** — i.e. the strings
that will go verbatim into `node[...]["inputs"]["image"]`. If a
`UploadResult.subfolder` is non-empty, the caller is responsible for
combining them into `"<subfolder>/<name>"` (via `UploadResult.composite`)
before passing to `build_graph`.

```python
from camera_multiview import UploadResult, spec
# UploadResult is what the mcp_session returns. .composite gives the
# fully-qualified filename ("subfolder/name" or "name").
result_dict = {"full_body_image": UploadResult(name="full.png", subfolder="")}
graph = build_graph(
    workflow=workflow,
    user_image_names={k: v.composite for k, v in result_dict.items()},
    pose_names={p.filename: UploadResult(name=p.filename).composite for p in spec.POSES},
)
```

### Failure modes

- `ValueError: missing user image uploads: [...]` — at least one of
  `full_body_image` or `face_image` is missing from the dict.
- `ValueError: missing pose uploads: ['姿势骨架1.png', ...]` — at least
  one pose filename is missing.

These checks fire **before** the deep copy, so partial graphs never
escape the function.

## What `build_graph` does NOT touch

By design, the skill leaves the other 246 nodes untouched. The
following would be a contract violation:

- Modifying any `class_type`
- Rewriting any prompt
- Changing any sampler / seed / cfg / steps
- Adding or removing nodes
- Toggling group bypass modes (this is camera-image's job, not ours)
- Modifying LoRA references
- Resizing images

If a future Flux2-Klein multi-view asset needs any of these
adjustable, the workflow asset is republished, not patched at runtime.

## What the patched graph looks like

Before patching:

```jsonc
{
  "111": {"class_type": "LoadImage", "inputs": {"image": "PLACEHOLDER.png"}, ...},
  "667": {"class_type": "LoadImage", "inputs": {"image": "PLACEHOLDER.png"}, ...},
  "152": {"class_type": "LoadImage", "inputs": {"image": "姿势骨架1.png"}, ...},
  ...
}
```

After patching:

```jsonc
{
  "111": {"class_type": "LoadImage", "inputs": {"image": "uploaded_full.png"}, ...},
  "667": {"class_type": "LoadImage", "inputs": {"image": "uploaded_face.png"}, ...},
  "152": {"class_type": "LoadImage", "inputs": {"image": "uploaded_pose_1.png"}, ...},
  ...
}
```

Other 246 nodes: byte-identical to the bundled workflow.

## Why the build is a deep copy, not an in-place edit

`copy.deepcopy(workflow)` ensures the caller can re-`build_graph` from
the same source dict without contamination. The workflow JSON file on
disk is never modified. The asset remains the single source of truth.