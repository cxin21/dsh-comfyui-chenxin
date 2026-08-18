# Known Issues & Audit Trail

This file records **code-level problems found during documentation review**
and their disposition. The project rule: documentation is rewritten from
first principles; code changes are a separate, approved work item. Once a
fix lands, this file is updated to reflect the new state.

Every entry has: **Where**, **What**, **Impact**, **Disposition** (fixed /
mitigated / open). Entries marked `[FIXED]` are closed; `[MITIGATED]`
means documented behavior with no code change required.

---

## 1. `scripts/check_contracts.py` — camera-multiview import path bug `[FIXED]`

- **Where**: `scripts/check_contracts.py` (`check_camera_multiview`)
- **What**: imported `camera_multiview.runtime.request` (does not exist)
  and called `parse_request(payload)` with one argument.
- **Impact**: multiview contract was never actually validated.
- **Fix**: now imports `camera_multiview.config_schema.RunConfig` and calls
  `RunConfig.from_envelope({}, **payload)`. Verified by `check_contracts.py`
  reporting `OK camera-multiview`.

## 2. `camera-multiview/cli.py` — `--list-actions` not handled `[FIXED]`

- **Where**: `skills/camera-multiview/camera_multiview/cli.py` (`main`)
- **What**: bare argparse with `add_subparsers(required=True)` and no
  `--list-actions` special case — `camera-multiview --list-actions` printed
  usage instead of actions.
- **Impact**: `loader.js introspectActions()` got an empty list → Host Tool
  registered with `actions: []` → unusable. Root cause of the "CLI tools
  not registered" symptom.
- **Fix**: added an argv probe at the top of `main()` that prints
  `describe`, `assets`, `run` and returns 0. Verified:
  `camera-multiview.exe --list-actions` → 3 actions.

## 3. `scripts/check_contracts.py` — stage inference for camera-image `[FIXED]`

- **Where**: `scripts/check_contracts.py` (`check_camera_image`)
- **What**: hard-coded `parse_request("t2i", ...)` against the first jsonc
  block; fragile if the first jsonc were ever an i2i example.
- **Fix**: introduced the `// contract-stage: <stage>` marker convention.
  `first_example_stage()` reads the marker; the check uses the declared
  stage (falling back to `t2i` when absent) and synthesizes the other
  stage's shape. camera-image SKILL.md now declares `// contract-stage: t2i`
  on its Quick Start example.

## 4. `scripts/check_contracts.py` — camera-video reference-count coupling `[FIXED]`

- **Where**: `scripts/check_contracts.py` (`check_camera_video`)
- **What**: parsed the first jsonc as i2v, stripped `references` to test
  t2v; fragile to example reordering.
- **Fix**: same stage-marker convention. camera-video SKILL.md declares
  `// contract-stage: t2v` on its Quick Start; the check parses the declared
  stage as-is and synthesizes the reference list for the other two stages.

## 5. `scripts/install_local.py` — duplicate / stale `.pth` sweep `[FIXED]`

- **Where**: `scripts/install_local.py` (`remove_legacy_artifacts`)
- **What**: only swept the literal `minimax_h3_v5.pth`; future stale
  version-named `.pth` files would survive.
- **Fix**: generalized to `f"{import_name}_v*.pth"`. Verified idempotent:
  re-running `install_local.py` reports `done — venv in sync` with no
  leftover artifacts.

## 6. `docs/recompute_manifest.py` — undocumented helper `[FIXED]`

- **Where**: `docs/recompute_manifest.py`
- **What**: had a one-line docstring and no usage; unreferenced from docs.
- **Fix**: expanded the module docstring with a full usage block (run from
  preset root, what it does, post-run verification), and it is now the
  canonical reference for the camera-image asset-replacement protocol.

## 7. `README.md` — stale exit-code table `[FIXED]`

- **Where**: `README.md` "输出格式" section
- **What**: table implied a single authoritative mapping; individual skills
  map some codes differently (e.g. camera-multiview `McpError` → 5,
  `AssetError` → 4).
- **Fix**: added a callout: "此表是汇总；每个 skill 的 SKILL.md 里的
  failure-modes 表是权威".

## 8. `camera-image` — LoRA resolution is server-dependent at parse time `[MITIGATED]`

- **Where**: `skills/camera-image/camera_image/runtime/lora.py`
  (`build_lora_patch`)
- **What**: LoRA name resolution calls `mcp.list_local_models` (network)
  inside `run`; if the server is down, a valid request fails with
  `comfyui_mcp_error` instead of a clean `validation_failed`.
- **Disposition**: documented (SKILL.md failure modes now explain the
  parse-time MCP dependency). No code change — fail-closed is intentional
  (stale LoRA names must surface before enqueue).

## 9. `camera-video` — `describe --summary` example shape `[FIXED]`

- **Where**: `skills/camera-video/camera_video/runtime/request.py`
  (`EXAMPLE_REQUEST`) + `cli.py` (`cmd_describe`)
- **What**: the canned example was i2v-shaped (1 reference); `multi-i2v`
  (3 references) copying it verbatim failed the reference-count gate.
- **Fix**: added `example_for_stage(stage)` returning a runnable example
  whose reference count matches the stage (t2v omits `references`; multi-i2v
  pads to 3). `cmd_describe` now uses it. Verified:
  `describe --stage multi-i2v --summary` → 3 references; all 3 stages parse.

---

## How to close an entry

1. Fix the code (separate approved work item).
2. Update the SKILL.md / docs if the behavior changed.
3. Mark the entry `[FIXED]` (or `[MITIGATED]`) with what changed.
4. Run `scripts/check_contracts.py` to confirm the contract still holds.
