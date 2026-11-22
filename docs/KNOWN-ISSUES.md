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

## 10. docs/architecture.md — skill count drift after the 5→3 refactor `[FIXED]`

- **Where**: `docs/architecture.md` ("What this preset does" tree, intro
  sentence, "Skill anatomy" closing line)
- **What**: the intro still said "Five DSH skills", the anatomy section
  said "5 skills × this layout", and the tree listed `camera-multiview`
  twice — leftovers from the 5→3 skill deletion refactor (see commits
  "docs: 全仓过时计数并移除死技能文档 (5→3)").
- **Impact**: the file self-describes as the single authoritative
  architecture description; a wrong count inside it undermines that claim.
- **Fix**: count corrected to three, duplicate tree line removed, tree now
  also lists `plugins/prompt-forge/` and `assets/knowledge/` so the
  five-part layout (skills / runtime / plugin / knowledge / docs) is
  stated once.

## 11. docs/troubleshooting.md — "5 个 CLI" heading over a 3-entry array `[FIXED]`

- **Where**: `docs/troubleshooting.md` §7 ("检查当前状态（一行命令）")
- **What**: heading said "5 个 CLI 都能跑吗？" while the PowerShell array
  under it correctly enumerates 3 CLIs.
- **Impact**: misleading health-check instructions during incident
  triage.
- **Fix**: heading corrected to "3 个 CLI". The array was already right.

## 12. Repo hygiene — pip temp dirs, HF tmp residue, one-off debug artifacts `[FIXED]`

- **Where**: repo root (`pip-build-tracker-*` ×1, `pip-ephem-wheel-cache-*`
  ×1, `pip-install-*` ×1, `pip-unpack-*` ×17 — all PyPI wheel unpack
  caches from an interrupted `tokenizers` install, already installed in
  `.venv`), `data/runtime/hf-cache/` (9 `model.onnx.tmp.*` partial
  downloads), `temp/` (one failed-test log `compositing-fail.txt` and
  one-off issue drafts `issue-15-body.md` / `issue-17-comment.md`).
- **What**: interrupted tooling leaves temp directories in the repo root;
  none were gitignored, so `git status` showed ~21 `??` entries that are
  pure noise. The hf tmp files are partial-download residue from the
  vector build.
- **Impact**: violates "repo is truth" — a fresh reader cannot tell
  residue from content; git status noise hides real changes.
- **Fix**: residue deleted; `.gitignore` now covers `pip-*` temp dir
  patterns so a future interrupted install cannot pollute status again.

## 13. cordis.patch.yml — dual-maintenance entry list, no sync statement in the source file `[MITIGATED]`

- **Where**: `agent.cordis.yml` ↔ `cordis.patch.yml`
- **What**: the patch restates every assembly entry verbatim as the
  deployed bundle form (with two intentional differences: absolute
  `file:///` paths and a pinned `presetRoot`). The patch header documents
  this, but the source file did not — nothing told an editor of
  `agent.cordis.yml` that a second file must change in lockstep.
- **Impact**: silent drift risk between the portable and deployed forms.
- **Disposition**: `[MITIGATED]` — a SYNC OBLIGATION comment block was
  added to the top of `agent.cordis.yml` naming the one allowed difference
  set; full de-duplication (generating the patch from the source list)
  would need a build step and is deferred as a separate work item.

## 14. prompt-forge test fixture — catalog checksum mismatch vs production assets `[OPEN]`

- **Where**: `plugins/prompt-forge` `compositing-wiring` test vs
  `assets/knowledge/anima-prompt-v1/` (observed in a preserved test log:
  `manifest=a2e3cdc5… actual=c5fd14b8…`, plus 2 wiring tests timing out
  at 30s).
- **What**: the test's golden catalog checksum does not match the
  production `tags.sqlite`/`tag-catalog.sqlite` present on disk. Likely
  the fixture expects a small golden sample while the machine holds the
  full ~1GB production snapshot (shipped via GitHub Releases).
- **Impact**: prompt-forge's test suite fails on a machine with
  production assets; does not affect preset-level contract checks
  (`check_contracts.py` passes all 6 gates).
- **Disposition**: `[OPEN]` — needs a deliberate fix (either the fixture
  should pin its own sample catalog and skip the checksum when only
  production assets exist, or fidelity capture must be re-run); touching
  the manifest to silence the mismatch would break the production
  integrity gate and was NOT done.

## 15. Plugin rename prompt-master → prompt-forge — settings namespace is a data contract `[FIXED]`

- **Where**: `plugins/prompt-forge` — three settings namespaces
  (`*-custom-profiles`, `*-profile-overrides`, `*-blueprints`) wired in
  `src/plugin/index.ts`, `src/pe-framework/profiles/storage-v2.ts`,
  `src/tools/prompt-author.ts` (blueprintSettingsScope).
- **What**: renaming the plugin directory/package is cheap, but the
  settings namespace keys are persisted user data (custom profiles,
  builtin override toggles, M5 blueprints). Renaming the keys bare would
  orphan every existing record on upgraded machines.
- **Impact**: silent data loss if renamed without migration; plugin name
  and stored keys drifting apart if renamed without keys.
- **Fix**: keys renamed to `prompt-forge-*` **plus** a one-shot lazy
  migration `migrateLegacySettingsSection` (storage-v2.ts, called at all
  three wiring points): after registering the new key, if the new section
  is empty and the legacy `prompt-master-*` section has data, the legacy
  section is copied over. Idempotent (short-circuits once the new section
  is non-empty); legacy data is copied, never deleted; any migration
  failure is swallowed so plugin load never blocks (same fail-open
  discipline as blueprint saves). Registry test updated to assert the new
  key names. Full rationale and layer-by-layer checklist:
  `plugins/prompt-forge/docs/RENAME-2026-11-22.md`.

---

## How to close an entry

1. Fix the code (separate approved work item).
2. Update the SKILL.md / docs if the behavior changed.
3. Mark the entry `[FIXED]` (or `[MITIGATED]`) with what changed.
4. Run `scripts/check_contracts.py` to confirm the contract still holds.
