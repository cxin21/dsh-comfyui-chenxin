# Bundled Asset Maintenance

The skill ships a fixed set of binary assets under
`runtime/workflow_assets/`. This document is the maintenance playbook:
how to verify, how to refresh, and what to update when the bundled
workflow changes.

## File inventory

```
camera_multiview/runtime/
├── __init__.py                    (docstring only)
└── workflow_assets/
    ├── Flux2-Klein人物一键多视图工作流.json    ~70 KB, 261 nodes
    ├── manifest.json                              ~2 KB
    └── pose/
        ├── 姿势骨架1.png
        ├── 姿势骨架2.png
        ├── 姿势骨架3.png
        ├── 姿势骨架4.png
        ├── 姿势骨架5.png
        ├── 姿势骨架6.png
        ├── 姿势骨架7.png
        ├── 姿势骨架8.png
        ├── 姿势骨架9.png
        ├── 姿势骨架10.png
        ├── 姿势骨架11.png
        ├── 姿势骨架12.png
        └── 姿势骨架13.png
```

15 asset files + 1 manifest = 16 total. None of them are
auto-generated. They are committed source.

## Maintenance workflow

### 1. Pre-flight verification (always run first)

```bash
$ python -m camera_multiview.cli assets verify
{
  "verified": true,
  ...
}
# exit code: 0
```

If anything has drifted (e.g. someone edited a file accidentally),
`assets verify` fails with exit code 4 and names the failing
invariant. Fix or roll back before continuing.

### 2. Smoke-test before any production run

```bash
$ python -m camera_multiview.cli run \
    --request  temp/camera-multiview/request.json \
    --output-dir  temp/camera-multiview/smoke \
    --timeout  1200

# Check:
# - exit code is 0
# - temp/camera-multiview/smoke/summary.json reports status: "success"
# - temp/camera-multiview/smoke/ has 13 PNG files (12 character views + 1 composition)
```

The character views should be visually consistent across the 12
poses (same face, same outfit, same weapon). If they're not, the
issue is usually one of:
- `full_body_image` and `face_image` are different characters
- ComfyUI's models are missing or wrong (check ComfyUI logs)

### 3. Asset replacement protocol

If the upstream workflow author publishes a new Flux2-Klein
multi-view asset (new pose skeletons, new layout, new node IDs):

1. **Back up the current assets**:
   ```bash
   cp -r camera_multiview/runtime/workflow_assets \
         camera_multiview/runtime/workflow_assets.bak.$(date +%Y%m%d)
   ```

2. **Replace the workflow JSON**:
   ```bash
   cp /path/to/new/Flux2-Klein人物一键多视图工作流.json \
      camera_multiview/runtime/workflow_assets/
   ```

3. **Replace any pose PNGs that changed** (compare SHA-256s against
   the upstream release notes).

4. **Recompute the manifest**:
   ```bash
   $ python -c "
   import hashlib, json
   from pathlib import Path
   
   ROOT = Path('camera_multiview/runtime/workflow_assets')
   wf_path = ROOT / 'Flux2-Klein人物一键多视图工作流.json'
   manifest = {
       'asset_policy': 'bundled-fixed-api-json',
       'workflow': {
           'filename': wf_path.name,
           'sha256':   hashlib.sha256(wf_path.read_bytes()).hexdigest(),
           'node_count': len(json.loads(wf_path.read_text(encoding='utf-8'))),
       },
       'poses': [],
   }
   for pose_path in sorted((ROOT / 'pose').iterdir()):
       manifest['poses'].append({
           'index':    int(pose_path.stem.replace('姿势骨架', '')),
           'filename': pose_path.name,
           'node_id':  '???',  # update from spec.POSES
           'sha256':   hashlib.sha256(pose_path.read_bytes()).hexdigest(),
       })
   print(json.dumps(manifest, ensure_ascii=False, indent=2))
   "
   ```

   Then fill in the `node_id` field by cross-referencing
   [`spec.POSES`](../camera_multiview/spec.py).

5. **Update `spec.py`** if any node IDs shifted:
   - `EXPECTED_WORKFLOW_SHA256`
   - `EXPECTED_WORKFLOW_NODE_COUNT`
   - `USER_IMAGES` (the 2 user image nodes)
   - `POSES` (the 13 pose nodes, in numeric order)

6. **Run `assets verify`** — must report `verified: true`. If not,
   diff the old vs new node topology and find what changed.

7. **Run the offline tests**:
   ```bash
   $ python camera_multiview/temp/camera-multiview/test_phases.py
   ```
   All 30 invariant checks must pass.

8. **Run one end-to-end `run`** to confirm 12 SaveImage outputs.

Do not skip any step. Steps 4-5 (manifest + spec.py) must be atomic;
an in-between state where the manifest and `spec.py` disagree causes
`verify_assets` to raise.

## End-to-end example

Replacing the workflow asset from upstream:

```bash
# Step 1: back up
$ cp -r camera_multiview/runtime/workflow_assets \
      camera_multiview/runtime/workflow_assets.bak.20260817

# Step 2-3: replace assets
$ cp /tmp/new/Flux2-Klein人物一键多视图工作流.json \
     camera_multiview/runtime/workflow_assets/
$ cp /tmp/new/pose/*.png camera_multiview/runtime/workflow_assets/pose/

# Step 4: regenerate manifest (script above)
$ python -c "..." > camera_multiview/runtime/workflow_assets/manifest.json
# (then edit to add node_id from spec.POSES)

# Step 5: update spec.py
$ $EDITOR camera_multiview/spec.py
# update: STAGE, WORKFLOW_FILENAME, EXPECTED_WORKFLOW_SHA256,
#          EXPECTED_WORKFLOW_NODE_COUNT, USER_IMAGES, POSES

# Step 6: verify
$ python -m camera_multiview.cli assets verify
{
  "verified": true,
  ...
}
# exit code: 0

# Step 7: offline tests
$ python camera_multiview/temp/camera-multiview/test_phases.py
... all 30 tests pass

# Step 8: e2e
$ python -m camera_multiview.cli run \
    --request temp/camera-multiview/request.json \
    --output-dir temp/camera-multiview/smoke --timeout 1200
# ... wait 8 minutes ...
# exit code: 0, 12 PNGs in temp/camera-multiview/smoke/
```

If any step fails, stop. The skill is fail-closed by design — there
is no fallback path that "makes it work somehow."

## What is NOT maintained here

- The `comfyui-mcp` Node.js server (external package, maintained
  upstream; we just consume its MCP tools).
- The ComfyUI server itself, its models, its custom nodes (operator
  concerns, not skill concerns).
- The `camera_multiview/` Python code (lives in source control;
  changes follow the same code review process as any other file).

## See also

- [SKILL.md](../SKILL.md) — the public contract
- [references/assets.md](../references/assets.md) — manifest schema
  and identity verification