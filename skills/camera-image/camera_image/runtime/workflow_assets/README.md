# camera-image workflow asset

The single source of truth for `camera-image`'s UI workflow. If any file
in this directory changes, the manifest must change with it, and the SKILL.md
must be reviewed.

## Layout

```
workflow_assets/
├── camera-anima.json         # the pinned UI workflow (complete graph)
├── manifest.json             # sha256 + structural fingerprint + profile_id
└── README.md                 # this file
```

`camera-anima.json` is **a complete ComfyUI UI graph**: every feature
group (G1 + G2 in `workflow/<stage>/groups.json`) is in the graph
already. Inactive groups are toggled via `mode: 4` (bypass) at patch
time — the skill does not call `load_groups` to mutate the asset, only
to decide which nodes to flip on/off before strip.

## Asset policy

Three guarantees enforced at every load (see
`camera_image/runtime/assets.py::load_fixed_ui`):

1. **SHA256 match.** The on-disk file's sha256 must equal
   `manifest.asset_sha256`. Mismatch → `fixed_workflow_invalid`.
2. **Structural fingerprint match.** A content hash over node ids /
   types / titles / input slots / output slots / link endpoints
   (excluding widget values) must equal `manifest.workflow_fingerprint`.
   This catches accidental structural edits even when individual
   widget values change.
3. **`asset_policy == "bundled-fixed-ui-json"`** on the manifest.
   Future asset shapes (API-only, multi-asset) will use a different
   policy and require a new runtime.

## Identity reporting

`camera-image describe --stage <t2i|i2i>` always emits the asset's
identity under `result.*`, and `assets verify` re-runs the checks on
demand.

```bash
camera-image assets verify --stage t2i
# {"ok": true, "command": "assets verify", "stage": "t2i",
#  "result": {"verified": true, "node_count": N,
#             "asset_workflow_name": "camera-anima.json",
#             "asset_sha256": "...", "workflow_fingerprint": "...",
#             "profile_id": "camera-anima-v1"}}
```

If `verified: false`, the asset has been modified or the manifest is
out of date. Do not ship until either the file is reverted or the
manifest is recomputed deliberately via `docs/recompute_manifest.py`.

## Per-run contract

Every `camera-image run`:

1. Loads `camera-anima.json` and verifies the manifest.
2. Writes only the request surface into widget values (prompts, camera,
   image size, seed, i2i wiring). No rewiring of nodes or links.
3. Applies group enable/bypass modes from `workflow/<stage>/groups.json`.
4. Expands bypassed subgraph wrappers (`mode: 4 → mode: 0`) so the MCP
   `strip_workflow` can resolve them — exact behavior of the ComfyUI
   frontend at runtime.
5. Calls MCP `strip_workflow` once (UI → API conversion).
6. Re-attaches node 26 (LoraManager) and node 66 (TriggerWord Toggle)
   widget values that the strip drops — otherwise output nodes 35, 490,
   550 cascade as "Output will be ignored".
7. Validates the API graph (`validate_api_graph`).
8. Executes through `ExecutionSession` and writes `summary.json`.

The runtime does not discover, repair, rewire, or fall back. Any asset
change requires a new sha256 + fingerprint in `manifest.json` and a
corresponding SKILL.md update.

## Group contract

Group membership lives outside the UI JSON:

- `skills/camera-image/workflow/t2i/groups.json`
- `skills/camera-image/workflow/i2i/groups.json`

Every title from either file is also listed verbatim in
`skills/camera-image/SKILL.md`. Membership changes require updating
all three locations (asset groups.json + SKILL.md G1/G2 tables +
groups.json). The title is the contract surface; node IDs may be added
or removed as long as the title stays stable.
