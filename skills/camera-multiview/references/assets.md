# Bundled Assets

The skill ships with a fixed set of binary assets. Every asset is
SHA-256-pinned in `runtime/workflow_assets/manifest.json` and re-verified
on every `verify_assets()` call.

## File inventory

```
camera_multiview/runtime/
├── __init__.py
└── workflow_assets/
    ├── Flux2-Klein人物一键多视图工作流.json    (70 KB, 261 nodes, API graph)
    ├── manifest.json                              (~2 KB, SHA-256 + node count + pose list)
    └── pose/
        ├── 姿势骨架1.png                          (variable size, ~50-70 KB)
        ├── 姿势骨架2.png
        ├── ...
        └── 姿势骨架13.png
```

The 14 asset files plus the 1 manifest = 15 total files under
`runtime/workflow_assets/`. None of them are auto-generated; they
are committed source.

## `manifest.json` schema

```jsonc
{
  "asset_policy": "bundled-fixed-api-json",
  "workflow": {
    "filename": "Flux2-Klein人物一键多视图工作流.json",
    "sha256":   "33584a54b6587914fce078cdcddbab7915e7d834ca741ded06a44a3ba484252e",
    "node_count": 261
  },
  "poses": [
    {
      "index":    1,
      "filename": "姿势骨架1.png",
      "node_id":  "152",
      "sha256":   "a6e988caa54806beee608fb63350ff64039e7f12b37488323fcdc1a68d29b8ed"
    },
    {
      "index":    2,
      "filename": "姿势骨架2.png",
      "node_id":  "154",
      "sha256":   "9729498dfd83319303a42b0781027ad5c75995e421d1e856cc8a7d3153bd1d28"
    },
    ...
    {
      "index":    13,
      "filename": "姿势骨架13.png",
      "node_id":  "757",
      "sha256":   "6187a6746f1f7a28d01e90f15e74dd27528d9c4e2be089b508fbcaeb0bac366c"
    }
  ]
}
```

`poses[].node_id` must match the `node_id` in [`spec.POSES`](
../camera_multiview/spec.py). If you change the workflow and the node
IDs shift, both files must change together.

## Identity verification

`verify_assets()` is the single fail-closed check. It walks all
15 assets and raises `AssetError` on the first drift:

```python
from camera_multiview import verify_assets, AssetError
try:
    identity = verify_assets()
except AssetError as exc:
    # the message names the failing invariant
    print(f"asset drift: {exc}")
    raise
```

| Check | Failing message |
|---|---|
| workflow.json exists | `fixed workflow is missing: ...` |
| workflow.json SHA matches `spec.EXPECTED_WORKFLOW_SHA256` | `fixed workflow SHA-256 changed: expected ..., got ...` |
| manifest.workflow.sha256 matches file | `manifest.workflow.sha256 does not match the file` |
| manifest.workflow.node_count matches `spec.EXPECTED_WORKFLOW_NODE_COUNT` | `manifest.workflow.node_count changed: ...` |
| pose PNG exists | `fixed pose asset missing: ...` |
| pose PNG SHA matches manifest | `fixed pose SHA-256 changed: ...` |
| workflow node count matches spec | `workflow node count changed: ...` |
| every LoadImage node is `LoadImage` class | `pose node X is missing or not LoadImage` |
| every LoadImage node has the expected title | `pose node X title changed: ...` |
| every pose node's `image` input references the expected filename | `pose node X must reference ..., got ...` |
| every user image node's `image` input is a string | `user image node X has no image input` |

`AssetError` is a `ValueError` subclass, so any `except ValueError`
catches it.

## The `AssetIdentity` record

Successful verification returns an `AssetIdentity`:

```python
@dataclass(frozen=True)
class AssetIdentity:
    workflow_filename: str
    workflow_sha256:   str
    workflow_node_count: int
    pose_count: int
    poses: tuple[tuple[str, str], ...]   # (filename, sha256) in numeric order
```

`poses` is indexed 0..12 (not 1..13); `poses[0]` is pose 1.

## Asset replacement protocol

If the upstream workflow author publishes a new Flux2-Klein
multi-view asset:

1. **Update the workflow JSON** at `runtime/workflow_assets/Flux2-Klein人物一键多视图工作流.json`.
2. **Recompute the manifest**: `manifest.workflow.sha256` is the SHA-256
   of the new file; `manifest.workflow.node_count` is the new node count;
   `manifest.poses[]` must be regenerated if any pose PNG changed.
3. **Update `spec.py`**: `EXPECTED_WORKFLOW_SHA256`, `EXPECTED_WORKFLOW_NODE_COUNT`,
   `USER_IMAGES`, and `POSES` to match the new asset's node topology.
4. **Run `assets verify`**: must return `verified: true`.
5. **Run the offline tests** (`temp/camera-multiview/test_phases.py`): every invariant
   check must pass.
6. **Update `SKILL.md`**: if the node count or pose count changed,
   update the asset identity table.
7. **Run one end-to-end `run`**: confirm 12 SaveImage outputs and
   0 PreviewImage downloads.

Do not skip any step. Steps 1-3 must be atomic; an in-between
state where the manifest and `spec.py` disagree causes `verify_assets`
to raise.

## Why pose filenames are `姿势骨架{i}.png` (no zero-pad)

The workflow author wrote the title as `姿势骨架{i}` (no padding).
The manifest filenames match. If you add a new pose, follow the same
naming convention.

## Why the manifest is `manifest.json` and not a Python file

A JSON manifest is editable without running Python; the SHA-256
checks work on any platform. Python `setup.py` data tables would
require a Python interpreter to verify, which is exactly what the
skill is supposed to avoid during `assets verify`.

See [knowledge/README.md](../knowledge/README.md) for the
maintenance playbook (pre-flight, replacement, re-verification).