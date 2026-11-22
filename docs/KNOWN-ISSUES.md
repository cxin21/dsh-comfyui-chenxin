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

## 13. cordis.patch.yml — dual-maintenance entry list, no sync statement in the source file `[FIXED]`

- **Where**: `agent.cordis.yml` ↔ `cordis.patch.yml`
- **What**: the patch restates every assembly entry verbatim as the
  deployed bundle form. The patch header documented this, but the source
  file did not — nothing told an editor of `agent.cordis.yml` that a
  second file must change in lockstep.
- **Impact**: silent drift risk between the portable and deployed forms.
  The patch is the copy DSH actually loads, so a drift means the edit a
  human reviewed is not the edit that runs.
- **Fix**: two layers, because a comment cannot fail.
  1. A SYNC OBLIGATION comment block at the top of `agent.cordis.yml`
     names the lockstep rule, so an editor is told before they edit.
  2. `scripts/check_lockstep.py` makes it testable. It originally
     tolerated three "deployment rewrites" (absolute `file:///` names and
     a pinned `presetRoot`); those are now gone (#26), so the gate asserts
     the entry lists are **identical with no allowed difference at all**,
     that neither file carries a machine-specific path, that every `./`
     entry point exists on disk, and that `preset.yml`'s name/description
     match the patch's preset entry (the description had already drifted
     once — #18).
  Wired into `CONTRIBUTING.md`'s quality gates and `docs/development.md`'s
  task table. Full de-duplication (generating the patch from the source
  list) would still need a build step and remains a separate work item;
  the gate covers the risk in the meantime.

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

## 16. `loader.js` — one bad preset path took down skills *and* tools `[FIXED]`

- **Where**: `loader.js` — `verifyPresetRoot` / `module.exports.apply`.
- **What**: `apply()` called `verifyPresetRoot(presetRoot)` first, and that
  function `throw`-ed on the first missing `SKILL.md`. A throw inside a Cordis
  plugin's `apply` aborts the whole plugin, so a single wrong
  `DSH_COMFYUI_PRESET_ROOT` (or a half-copied install) cost the session the
  skill provider **and** the three CLI wrapper tools — three failure domains
  collapsing into one, with the CLI half failing for a reason that has nothing
  to do with the venv.
- **Impact**: worst-case silent disappearance of the entire preset surface,
  with a stack trace naming only a missing markdown file.
- **Fix**: `verifyPresetRoot` → `inspectPresetRoot`, which returns
  `{present, missing}` instead of throwing. `apply()` now:
  1. warns per missing `SKILL.md` (`skill "<name>" will not load`), and warns
     loudly when *nothing* is found (wrong root, with the reinstall hint);
  2. registers a provider over the **present** subset only, so 1 of 3 broken
     still yields 1 working skill;
  3. wraps provider registration and tool registration in separate
     `try/catch` — a skills-side failure (duplicate provider name, disposed
     scope) no longer prevents CLI tool registration, and vice versa;
  4. `registerCliTools` warns and returns `0` when `subprocess`/`tools` are
     absent instead of throwing.
  `scripts/check_contracts.py` does not cover this (it validates request
  schemas, not loader wiring), so a dedicated check lives at
  `scripts/check_loader.mjs`: it builds a mock Cordis context and asserts
  (a) good root → 3 skills + 3 tools, (b) 1-of-3 root → no throw, 1 skill,
  still 3 tools, (c) missing skills service → tools still register. Run it with
  `node scripts/check_loader.mjs`.

---

## 17. prompt-forge registers 14 tools, the docs described 7 `[FIXED]`

- **Where**: `AGENTS.md` §1 task routing table; `skills/*/SKILL.md`.
- **What**: the plugin registers 14 tools
  (`prompt_author`, `prompt_compile`, `prompt_audit`, `prompt_feedback`,
  `style_list`, `style_save`, `prompt_expand`, `prompt_reverse`,
  `minimax_scenario`, `profile_list`, `catalog_search`, `catalog_relations`,
  `catalog_build`, `catalog_artist_add`). `AGENTS.md` routed 7 of them;
  `catalog_search`, `catalog_artist_add`, `prompt_expand`, `prompt_reverse`,
  `minimax_scenario`, `profile_list`, `style_save` had zero agent-facing
  guidance. Worse, `AGENTS.md` only reaches sessions whose `cwd` is inside
  this repo (see #23), so a preset session started anywhere else got no tool
  guidance at all.
- **Impact**: an agent either ignored seven working tools or guessed their
  schemas. `style_save` in particular has a non-obvious post-write behaviour
  (invisible to the running process) that guessing gets wrong.
- **Fix**: two layers, deliberately redundant for different cwd situations:
  1. `AGENTS.md` §1 gained 7 rows (one per undocumented tool) with the
     decision rule, not just the parameter list.
  2. Each `SKILL.md` gained a "Getting the prompt (prompt-forge)" section
     ahead of `## See also` — `camera-image` and `camera-video` get a
     situation→tool table plus the "these are Host Tools, not CLI
     subcommands; if they are absent the plugin is not mounted, do not
     hand-roll authoring" warning; `camera-multiview` gets a shorter "no
     prompt input" note (it takes only `full_body_image` + `face_image`) so
     an agent does not invent a `prompt` field for it.
  SKILL.md is delivered by the skill provider regardless of `cwd`, which is
  what closes the gap `AGENTS.md` structurally cannot.

---

## 18. `preset.yml` description misdescribed what the preset registers `[FIXED]`

- **Where**: `preset.yml` — the `description` shown in the preset picker.
- **What**: it read "注册 3 个 SKILL.md prompt sections 与 3 个
  console-script wrapper Host Tools". Both halves were wrong: the loader
  registers a **skill catalog provider** (three `skills` entries), not prompt
  sections; and the three Host Tools are conditional on a complete `.venv`
  (missing venv prints a setup hint and registers no tools — the skills still
  load).
- **Impact**: a user reading the picker expects three tools, gets zero on a
  fresh clone, and has no way to know from the UI that `scripts/setup.ps1` is
  the missing step.
- **Fix**: description now names the three skills, states the tool
  registration condition explicitly (`.venv` with all three console scripts),
  and says venv-missing degrades to "skills only, plus a setup hint".

---

## 19. `plugins/prompt-forge/config.yaml.example` was a dead MCP-era relic `[FIXED]`

- **Where**: `plugins/prompt-forge/config.yaml.example`.
- **What**: the file documented the pre-rename **standalone MCP server**:
  `~/.prompt-master-mcp/config.yaml`, `db_path`, `transport: stdio`,
  `port: 3100`, a `defaults.provider/model/temperature` block and a
  `providers[]` array with `baseUrl` / `envKey` / `apiKey` / `models`. Since
  the DSH-native rewrite, provider and model routing follow the **session**
  (`agent.cordis.yml` carries zero provider config), and the plugin's real
  schema is exactly two keys — `temperature` (default `0.7`) and `presetRoot`
  (optional, see `src/plugin/config.ts:4-8`).
- **Impact**: worst kind of stale doc — plausible enough to follow. A user who
  wrote `db_path` or a `providers[]` block got either a schema rejection or,
  worse, believed they had configured a provider that the plugin never reads.
- **Fix**: rewritten against the real schema, with the reasoning inline: no
  provider / apiKey / model fields because routing follows the session; both
  keys optional; `presetRoot`'s resolution chain documented (config →
  `DSH_COMFYUI_PRESET_ROOT` → `__dirname` back-walk) so the reader knows when
  they do *not* need to set it.

---

## 20. No dependency lock — six packages, no upper bounds, silent drift `[FIXED]`

- **Where**: `requirements.lock` (new), `scripts/setup.ps1` step 3,
  `scripts/setup.sh` step 3.
- **What**: the six local packages declare their PyPI dependencies with no
  upper bounds (`camera-image` / `camera-video` depend on `chenxin-runtime`
  unpinned; `chenxin-runtime` pulls `comfyui-http-runtime` /
  `comfyui-mcp-runtime`; the real third-party surface is
  `httpx`/`huggingface_hub`/`tokenizers`/… installed implicitly).
  `setup.ps1` hard-pinned exactly one of them (`tokenizers==0.22.2`);
  `setup.sh` pinned none.
- **Impact**: two machines set up a week apart resolve different transitive
  versions. The bundled workflow assets are hash-pinned (see `assets verify`),
  so drift does not fail loudly at install time — it surfaces later as
  tokenizer/HTTP behaviour differences, or as a `fixed_workflow_invalid` that
  looks like corruption.
- **Fix**: `requirements.lock` pins all 17 third-party packages with the
  reference environment recorded in its header (Python 3.12.10 / Windows,
  captured from a venv that passes `--list-actions` on all three CLIs). Both
  setup scripts now `pip install -r requirements.lock`; both keep a loud
  fallback for checkouts predating the lock. Scope is documented: the six
  local packages are intentionally absent — they track the checkout, not the
  lock. Verified by cross-checking every lock entry against the installed venv
  via `importlib.metadata` (17/17 match, 0 missing, 0 mismatched).

---

## 21. Skill override precedence — the loader comment described it backwards `[FIXED]`

- **Where**: `loader.js` — the `PROVIDER_NAME` / `PROVIDER_RANK` comment.
- **What**: the comment claimed `rank` mirrors `BUNDLED_SKILL_RANK` "so a
  workspace's project-dsh / user-dsh skills (lower rank) outrank the preset's
  bundled copies when the same name is registered twice". Reading
  `@deepseek-ai/dsh-skill` says the opposite. Its registry is **layered**, and
  its class doc is explicit: a registration files into the layer of its
  calling context's scope; host rows land in the global layer, a plugin
  mounted by a preset's standing composition lands in that preset's layer; a
  read merges global + the scope chain, and "the nearest layer's entry wins a
  duplicate name outright, and the rank order decides duplicates only within
  one layer". These skills are registered from the preset's composition, so
  they live in the preset layer and the filesystem provider's
  `project-dsh`/`user-dsh` roots (global layer) are always the *farther*
  layer. `rank: 600` therefore never arbitrates against them.
- **Impact**: no user-visible breakage, but the documented mental model was
  wrong in the reassuring direction — it promised an escape hatch
  (`<project>/.dsh/skills/camera-image/` overrides the bundled copy) that does
  not exist. An agent or maintainer relying on it would debug a shadowed edit
  that was never applied.
- **Fix**: comment replaced with the actual mechanism and its consequence:
  duplicate names inside a preset session resolve to the **bundled** copy, and
  `PROVIDER_RANK` only orders this provider against other preset-layer
  providers. Overriding a bundled skill requires a different preset or a
  source edit, not a workspace drop-in.

---

## 22. `subprocess` `graceMs` — audited, not a timeout, no change needed `[CLOSED]`

- **Where**: `loader.js` CLI tool `execute` → `sub.spawn({… graceMs: 120000})`.
- **What**: recorded here because it looked like a landmine and is not.
  `graceMs` is 120 s while an H3 multi-i2v render runs 25–35 min, which reads
  like "the tool kills every real render". Reading
  `@deepseek-ai/dsh-subprocess-local` says otherwise: `graceMs` is the
  SIGTERM→SIGKILL escalation window after an **abort** (host shutdown,
  cancellation), plus the pipe-drain wait after exit. The source comment on
  the timeout path is explicit — "The caller owns timeout classification;
  this layer only reacts to abort." There is no hard timeout at this layer.
- **Impact**: none. Long renders are not truncated by the loader.
- **Status**: no code change. Timeout classification genuinely belongs to the
  CLI (`camera-video --timeout`, default 1800 s), which already returns a
  non-error envelope with `queue_status` when the wait ends before the render
  does.

---

## 23. `agent-instructions` cannot be pointed at this repo `[CLOSED]`

- **Where**: `agent.cordis.yml` → `agent-instructions` row.
- **What**: the row loads the user-global instruction file (under the harness
  home) plus the project chain (from `cwd` upward, `.git`-marked). The repo's
  `AGENTS.md` reaches a session only when `cwd` is inside the repo.
- **Impact**: a preset session started elsewhere sees no repo `AGENTS.md`.
  This is the structural reason #17 needed a SKILL.md-side fix rather than an
  `AGENTS.md`-side one.
- **Status**: not a config defect and not fixable by config. The plugin's own
  doc comment says so: the harness home comes from the process environment,
  and "the row cannot point instruction loading at a second root". Adding a
  second `agent-instructions` row would double-load the global file, not
  reach the repo. Closed as designed behaviour; the cwd-independence problem
  is handled by putting routing guidance in `SKILL.md` (see #17).

---

## 24. Stale lockfiles — `bun.lock` pinned the MCP-era dependency set `[FIXED]`

- **Where**: `plugins/prompt-forge/bun.lock` (tracked in git).
- **What**: the plugin began life as a standalone MCP server with
  `@modelcontextprotocol/sdk` / `dotenv` / `sql.js` / `yaml`. It is now a native
  DSH plugin whose real dependencies are `@huggingface/transformers` and
  `sqlite-vec`. `bun.lock` was never regenerated: its root dependency set and
  `package.json`'s had **zero overlap**, and it contained neither
  `transformers` nor `sqlite-vec`.
- **Impact**: worse than dead weight. Anyone who ran `bun install` — which
  `CONTRIBUTING.md` used to instruct — installed a completely different
  dependency tree, got no embedding runtime and no vector store, and hit an
  import failure on plugin load. The lockfile actively pointed away from a
  working install.
- **Fix**: deleted `bun.lock` (tracked) and an untracked `pnpm-lock.yaml` that
  was missing 7 of 17 dependency specifiers. `package-lock.json` is the one
  kept: it matches `package.json` exactly on both `dependencies` and
  `devDependencies` (302 packages, lockfileVersion 3). `CONTRIBUTING.md` now
  says `npm ci` + `npm test`. The vitest run cache `.vitest-last.json` is
  gitignored (621 KB, per-machine, no diagnostic value once read).
- **Why one lock and not three**: three lockfiles for one package means at most
  one is verified. npm is what `package.json` scripts, `plugins/prompt-forge/AGENTS.md`
  and every doc already assume; nothing in the repo references bun or pnpm.

---

## 25. `preset.yml` is read by nothing — the legacy directory form is gone `[FIXED]`

- **Where**: `preset.yml` (repo root), `agent.cordis.yml`, `README.md` §5 分钟跑起来.
- **What**: this repo originated as a legacy directory preset
  (`$DSH_HOME/.agent-presets/<id>/` holding `preset.yml` + `agent.cordis.yml`).
  Current DSH no longer reads that directory at all — `dsh-doc`'s own
  `references/compositions.md` states it plainly: *"Before declaration rows, a
  user preset was a directory `$DSH_HOME/.agent-presets/<id>/` … **Nothing reads
  that directory any more.**"* The registry README agrees: *"the registry neither
  scans directories nor accepts preset paths."* `loader.js` never opens
  `preset.yml` either (it is a Cordis plugin; it receives `config`, not a
  manifest file). So `preset.yml` was a manifest for a loader that no longer
  exists, and the README told users to install by copying a directory that
  nothing would pick up.
- **Impact**: a user following the old README would install the preset and see
  nothing happen. Worse for maintainers: #18 ("preset.yml description
  misdescribed what the preset registers") was fixed in a file that no code
  reads, so the actual deployment surface (`cordis.patch.yml`) kept the wrong
  text until it was separately corrected.
- **Fix**:
  1. `README.md` now documents **one** install path — the bundle
     (`package.json` → `cordis.patch.yml`, installed through `plugin_manager` /
     **Plugins → Add plugin** / `dsh plugin … add link:<abs>`) — and states the
     legacy directory is dead rather than offering it as an alternative.
  2. The role of each assembly file is stated explicitly: `cordis.patch.yml` is
     what DSH loads; `agent.cordis.yml` is the human-readable portable twin
     kept in lockstep by `scripts/check_lockstep.py`; `preset.yml` is **only** a
     name/description source that the lockstep gate cross-checks against the
     patch's preset entry. It has no runtime consumer.
  3. `scripts/check_lockstep.py` keeps asserting `preset.yml`'s name and
     description equal the patch's, so the two cannot drift even though only one
     of them executes.
  Deleting `preset.yml` outright was considered and rejected: it still costs
  nothing, and the gate uses it as the human-facing statement of what the preset
  is — but the README no longer implies anything loads it.

---

## 26. `cordis.patch.yml` pinned this machine's absolute paths — published broken `[FIXED]`

- **Where**: `cordis.patch.yml` (`comfyui-loader.name`, `comfyui-loader.config.presetRoot`, `prompt-forge.name`), `scripts/check_lockstep.py`.
- **What**: the deployed bundle form carried three machine couplings —
  `name: 'file:///D:/DSH/projects/dsh-comfyui-chenxin/loader.js'`,
  `presetRoot: 'D:/DSH/projects/dsh-comfyui-chenxin'`, and
  `name: 'file:///D:/DSH/projects/dsh-comfyui-chenxin/plugins/prompt-forge/dist/src/plugin/index.js'`.
  They were introduced when the preset was migrated off the legacy directory
  form, on the assumption that the patch had to name its entry points by
  absolute URL. It does not.
- **Why the absolute paths were unnecessary**: `loader.js`'s
  `resolvePresetRoot` ends with `if (!presetRoot) presetRoot = PRESET_DIR` where
  `PRESET_DIR = __dirname` — and Node resolves a symlinked module to its
  realpath, so the profile's `link:` symlink still yields the checkout
  directory. Verified directly:
  `require.resolve('<profile>/node_modules/@local/dsh-comfyui-chenxin-preset/loader.js')`
  returns `D:\DSH\projects\dsh-comfyui-chenxin\loader.js`. The entry points
  themselves only need a specifier Node can resolve — see #28 for why that
  turned out **not** to be `./`.
- **Impact**: the patch was already pushed to
  `github.com/cxin21/dsh-comfyui-chenxin`, so every clone outside this machine
  either failed to load the preset or — worse, if that path happened to exist —
  loaded a different copy of the code. The failure is silent:
  `dsh-app-boot` wraps bundle loading in try/catch and files failures into
  `skippedBundles` without printing anything, so the symptom is "the preset is
  there but nothing works".
- **Fix**: both files now name their entry points with this package's subpaths —
  `@local/dsh-comfyui-chenxin-preset/loader.js` and
  `@local/dsh-comfyui-chenxin-preset/plugins/prompt-forge/dist/src/plugin/index.js`
  — with `presetRoot: null`.
  `check_lockstep.py` dropped its `ABSOLUTE_PATH_ENTRIES` / `PINNED_ROOT_KEYS`
  allowance (now empty sets, so the two files must be identical) and gained a
  `check_portable()` assertion that fails on any `file:`-prefixed, absolute, or
  `./`-relative plugin name or config value. Per-machine overrides belong in the
  profile's own user-layer `cordis.patch.yml`, documented in `README.md`.
  The three published values were also the only reason the two files differed
  at all; with them gone, #13's "allowed difference set" is now empty.
  The intermediate fix (rewriting the names to `./loader.js`) was itself broken
  and shipped as `2afcf09`; see #28.

## 27. `plugins/prompt-forge/dist/` is gitignored — a fresh clone booted with no tools `[FIXED]`

- **Where**: `plugins/prompt-forge/.gitignore` (`dist/`), `cordis.patch.yml` (`prompt-forge.name`), `scripts/setup.ps1`, `scripts/setup.sh`.
- **What**: the patch points `prompt-forge` at
  `@local/dsh-comfyui-chenxin-preset/plugins/prompt-forge/dist/src/plugin/index.js`,
  which is TypeScript build output and is not committed
  (`git ls-tree -r HEAD | grep -c 'prompt-forge/dist/'` = 0; the directory is
  ~7.6 MB / 1252 files on a built machine). Neither setup script built it —
  `grep -n npm scripts/setup.ps1 scripts/setup.sh` returned nothing before this
  fix.
- **Impact**: on a fresh clone, `scripts/setup.ps1` installed all six Python
  packages, reported success, and the preset then loaded with **no
  prompt-forge tools at all and no error message** (see #26 for why it is
  silent). The 14-tool surface documented in `AGENTS.md` §1 simply was not
  there, with nothing pointing at the cause.
- **Fix**:
  1. Both setup scripts gained a **build step** (`scripts/setup.ps1` step 5,
     `scripts/setup.sh` step 5): skip if `dist/src/plugin/index.js` already
     exists, otherwise `npm ci` (falling back to `npm install`) then
     `npm run build`, with an explicit warning listing the manual command when
     `npm` is not on `PATH` or the build fails. Later steps renumbered.
  2. `check_lockstep.py` gained `check_entry_points()`: every plugin `name` in
     the patch must resolve to something that actually exists in this checkout
     (package subpaths and `./`-relative names alike), and a missing
     `plugins/prompt-forge/dist/…` entry is reported together with the exact
     command that builds it. This turns the silent `skippedBundles` failure into
     a red gate.
  3. `README.md` documents the situation in a callout under the install
     section.

---

## 28. `./`-relative plugin names don't work inside a preset — the fix for #26 broke boot `[FIXED]`

- **Where**: `cordis.patch.yml` / `agent.cordis.yml` (the `preset-comfyui-chenxin`
  row's nested `plugins` list), `scripts/check_lockstep.py`
  (`check_portable`, `check_entry_points`).
- **What**: the first fix for #26 rewrote the three absolute values to
  `./loader.js`, `./plugins/prompt-forge/dist/src/plugin/index.js` and
  `presetRoot: null`, shipped as `2afcf09`. After a restart the preset was
  **gone from the menu entirely**.
- **Why**: `dsh-app-boot`'s `anchorInsertedPluginNames`
  (`src/index.ts:570-581`) does rewrite `./`-prefixed insert names into file
  URLs — but it only descends into an entry's `config` when
  `entry.group && Array.isArray(entry.config)`. The one insert in this patch is
  the preset row, whose `config` is a plain object, so the two nested `./` names
  were handed to the Loader **verbatim**. The preset registry then mounts them
  against the profile's `baseUrl` (`dsh-app-boot/src/index.ts:1245` sets
  `ctx.baseUrl = pathToFileURL(dirname(configPath))`), i.e. the profile
  directory — where those files do not exist. Verified: with
  `createRequire('<profile>/cordis.yml')`,
  `require.resolve('./loader.js')` fails `MODULE_NOT_FOUND` while
  `require.resolve('@local/dsh-comfyui-chenxin-preset/loader.js')` succeeds.
  Mount failure lands in `record.broken` and the roster row carries it; the UI
  treats a broken preset as absent.
- **Impact**: the preset never mounted, so the 3 skills and 3 CLI tools were
  also unavailable. Published in `2afcf09` before the symptom appeared.
- **Fix**: both entry points are now **this package's subpath specifiers** —
  `@local/dsh-comfyui-chenxin-preset/loader.js` and
  `@local/dsh-comfyui-chenxin-preset/plugins/prompt-forge/dist/src/plugin/index.js`.
  Node resolves them through the profile's `node_modules` entry (a `link:` to
  the checkout), so they are machine-independent *and* do not rely on the
  anchoring recursion that does not apply here. Verified with a real ESM
  `import()` from the profile directory: loader exports
  `default`/`module.exports`, prompt-forge exports
  `Config`/`apply`/`inject`/`name`.
  `check_lockstep.py` now rejects `./`-relative plugin names outright
  (`check_portable`) with a message naming the anchoring limitation, and
  `check_entry_points` maps package subpaths back onto the checkout instead of
  concatenating `ROOT / name`. Both directions are covered by the gate:
  `./` names and absolute names each fail.

---

## Environment note — `billion-context` overrides compaction rows

Not a preset defect, recorded so it is not re-discovered as one. In this
profile the `billion-context` plugin overrides `compaction-basic`,
`preset-standard`, `preset-ptc`, `preset-minimal`, `preset-cordis`,
`llm-deepseek` and `llm-deepseek-account`. The preset's own
compaction group (`isolate` + `tool-result-pruner` with `thresholdChars:
4096`) may therefore be superseded by the gate in profiles where that plugin
is installed. Two consequences worth knowing:

- Tool output over 4096 chars gets trimmed by whichever pruner actually wins,
  which is in tension with "copy the schema from `describe`" when a schema
  description itself is longer than that. `describe --summary` stays under the
  limit by design; the full `describe` may not.
- If compaction behaviour looks unexpected in a preset session, check the
  billion-context override list before editing `agent.cordis.yml`.

---

## How to close an entry

1. Fix the code (separate approved work item).
2. Update the SKILL.md / docs if the behavior changed.
3. Mark the entry `[FIXED]` (or `[MITIGATED]`) with what changed.
4. Run `scripts/check_contracts.py`, `scripts/check_loader.mjs` and
   `scripts/check_lockstep.py` to confirm the contracts still hold.
