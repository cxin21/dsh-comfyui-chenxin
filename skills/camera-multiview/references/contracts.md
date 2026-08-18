# Validation Contracts

Two checks run on every end-to-end execution. Both are pure local
operations — no I/O, no network, no dependencies on the rest of the
pipeline.

## `validate_graph(graph)` — structural well-formedness

Catches anything wrong with the **shape** of the API graph that would
make ComfyUI reject the enqueue.

| Check | What it catches | Failure message format |
|---|---|---|
| `isinstance(graph, dict) and graph` | None, empty | `multiview API graph must be a non-empty mapping` |
| every node `isinstance(node, Mapping)` | graph was packed with a non-dict | `node {id} is not an object` |
| every node has `class_type: str` | partial strip result | `node {id} has no class_type` |
| every node has `inputs: Mapping` | partial strip result | `node {id} has no inputs object` |
| no `class_type in {"easy getNode", "easy setNode", "Reroute"}` | UI-only node leaked through strip | `frontend-only node {id} ({class}) reached API graph` |
| every `SaveImage`/`PreviewImage` has `images` link | missing image output | `output node {id} has no images input` / `output node {id} images input is not a link` |
| every link `[node_id, slot]` resolves to an existing node | dangling reference | `node {id} input '{input}' references missing node {target}` |
| at least one image output node exists | workflow has no outputs | `multiview API graph has no image output node` |

This is the only check that knows the ComfyUI API graph format. Every
other check is application-specific to camera-multiview.

## `validate_bindings(graph, *, user_image_names, pose_names)` — patched inputs

Catches the specific failure mode of "I patched the graph with one
set of names but the upload records say something different." This
is the contract that prevents the API graph from being enqueued with
references to filenames ComfyUI doesn't have.

```python
def validate_bindings(
    graph: Mapping[str, Any],
    *,
    user_image_names: dict[str, str],   # config_key -> uploaded name
    pose_names: dict[str, str],          # pose filename -> uploaded name
) -> None:
```

For each `USER_IMAGES` entry (2 of them), check that
`graph[node_id]["inputs"]["image"] == user_image_names[config_key]`.
For each `POSES` entry (13 of them), check that
`graph[node_id]["inputs"]["image"] == pose_names[pose_filename]`.

### Failure message format

```
ValueError: user image node 111 image 'wrong.png' does not match uploaded name 'full.png'
ValueError: pose node 152 image 'u_pose_1.png' does not match uploaded name '姿势骨架1.png'
```

The error names:
- the node ID (so you can find it in the workflow)
- the actual value in the graph (what you wrote)
- the expected value (what the upload returned)

If the failure is "user image node 111 image '' does not match
uploaded name 'full.png'", the issue is usually a missing `image`
input on the node — check that the workflow still has the expected
node topology (`verify_assets` will catch this earlier, but the
contract here is a fast post-patch check).

## Why two checks, not one

`validate_graph` and `validate_bindings` answer different questions:

- `validate_graph`: "Is this a syntactically valid ComfyUI API graph?"
- `validate_bindings`: "Did I correctly wire the upload records to
  the right LoadImage slots?"

The first is application-agnostic — any skill that submits to
ComfyUI should run it. The second is specific to this skill's
two-image-input contract. They are independent invariants; either
can fail without the other.

## When each runs

| Phase | Check |
|---|---|
| After `build_graph` (Phase 4) | `validate_graph` |
| After `validate_graph` (Phase 5) | `validate_bindings` |
| Before `enqueue` (Phase 7) | (no further check — both passed) |
| During `assets verify` | (a different check on disk files; see [assets.md](assets.md)) |

If either check fails, the executor returns a `RunResult(status="error")`
or raises `ValueError` before the run reaches `enqueue`. ComfyUI never
sees a malformed graph.