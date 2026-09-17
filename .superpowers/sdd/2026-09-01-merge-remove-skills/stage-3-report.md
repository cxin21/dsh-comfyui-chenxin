# Stage 3 Report — Remove anima-prompt-v1 / minimax-h3-prompt skills (prompt-master takes over)

**Status:** ✅ complete
**Commits:**
- `9720db3` — chore(prompt-master): track assets/knowledge metadata before skill removal (prerequisite)
- `72ab56d` — feat(comfyui-chenxin): prompt-master takes over Anima/H3 authoring, remove skill CLIs & dirs (main)

**Constraints honored:** preset-level config/loader/AGENTS/scripts/venv/dirs only; `plugins/prompt-master` source NOT touched; camera-* skills fully intact; no other subagents.

---

## 1. Files changed (this stage)

| File | Change |
|---|---|
| `loader.js` | SKILLS: dropped `anima-prompt-v1` + `minimax-h3-prompt` entries (kept 3 camera-*). CONSOLE_SCRIPTS: dropped both entries (kept camera_image/camera_video/camera_multiview). Header/comment counts 5→3 (L2, L11, L23, L56, inject comment). Tool property descriptions updated: `stage` → "(camera-* describe/run)", `request_file` → "(camera-* run)". Camera-* entries untouched. |
| `agent.cordis.yml` | Header comments 5→3 skills/CLIs + note that Anima/H3 authoring is prompt-master-provided. Persona: "five Skills" → "three camera Skills"; removed the two skill bullets; CLI-tools paragraph rewritten — `(camera_image / camera_video / camera_multiview)` only, with explicit "Anima / MiniMax-H3 prompt authoring is handled by the prompt-master plugin (prompt_author / prompt_compile / prompt_audit) — there is no CLI wrapper". Skill-registry + compaction + loader comments 5→3. Also includes the pre-existing uncommitted prompt-master plugin row (needed for the merge; committed here as part of config). |
| `AGENTS.md` | Routing table rows 1-2 → `prompt_author (target=anima)` / `prompt_author (target=h3)` + prompt_compile/prompt_audit (prompt-master). §2: removed story.json/brief.json, "run / author" → "run", prompt result field → summary.json, `--json` note de-anima-ized + new bullet "写 Anima/H3 提示词不走 CLI". §3: temp 布局 list → camera-* only; catalog note → catalog_build tool rebuilds `assets/knowledge/anima-prompt-v1/tags.sqlite` → `tag-catalog.sqlite` + manifest; overlay stays `temp/anima-prompt-v1/relation-overlay.sqlite`. §4: "8 个本地包" → "6 个". §5 error table: removed dead CLI codes (brief_validation_failed / catalog_read_failed / h3_audit_failed / budget_exceeded / official_envelope_violated / tokenizer_integrity_failed) → prompt-master rows (`catalog_build_failed`/`input_file_missing` → "跑 catalog_build 工具重建"; audit critical gates → fix slots/shots, loop_exhausted → manual). §6: long-run monitor paren → `camera-video` multi-i2v render pipeline (keep — it IS the render pipeline). §7: `--list-actions` list → 3 camera exes. |
| `.gitignore` | Removed dead `skills/anima-prompt-v1/knowledge/*` + `skills/minimax-h3-prompt/knowledge/tokenizer.json` lines and the now-stale "skills/ removed in Stage 3" staging comment; kept the assets/knowledge big-DB ignores + GitHub Releases note. |
| `scripts/setup.ps1` | "8 local packages"→6, "5 CLI wrapper Host Tools"→3, `$Required` list → 3 camera exes, npx warning dropped "Prompt authoring works" (authoring is prompt-master now). |
| `scripts/setup.sh` | Install loop → 3 camera skills (+runtime trio); self-check loop → 3 camera exes; npx warning reworded. |
| `scripts/install_local.py` | `PACKAGES` table: removed anima-prompt-v1 + minimax-h3-prompt entries; doc comments 8→6. |
| `scripts/check_contracts.py` | Removed anima/h3 `sys.path` inserts, `check_anima()`, `check_h3()`, and their CHECKS entries (parsers deleted). Camera checks unchanged. |
| `skills/anima-prompt-v1/`, `skills/minimax-h3-prompt/` | **Deleted** (48 tracked files `git rm -r`; gitignored DB leftovers + `__pycache__` swept with Remove-Item). |
| `assets/knowledge/*` (7 metadata files) | Prerequisite commit `9720db3`: tracked the non-DB metadata (previously untracked; resolver only worked via skills/ copies). |

Camera-* files: **untouched** (the pre-existing unstaged modification to `skills/camera-image/camera_image/runtime/confirm.py` was intentionally left out of this stage's commits).

## 2. venv uninstall evidence

```
[comfyui-chenxin] pip uninstall -y anima-prompt-v1 minimax-h3-prompt  → exit 0
    Found existing installation: anima-prompt-v1 3.0.0
    Found existing installation: minimax-h3-prompt 6.0.0
    "Can't uninstall … No files were found to uninstall."   (editable install — RECORD empty)
python.exe -m pip uninstall → same, exit 0
```

Manual sweep of the editable-install leftovers pip could not remove:

```
removed: .\.venv\Scripts\anima-prompt-v1.exe
removed: .\.venv\Scripts\minimax-h3-prompt.exe
removed: .\.venv\Scripts\minimax-h3-prompt.cmd
removed: .\.venv\Lib\site-packages\anima_prompt_v1-3.0.0.dist-info
removed: .\.venv\Lib\site-packages\minimax_h3_prompt-6.0.0.dist-info
removed: .\.venv\Lib\site-packages\anima_prompt_v1.pth        (pointed at deleted skills/anima-prompt-v1)
removed: .\.venv\Lib\site-packages\minimax_h3_prompt.pth      (pointed at deleted skills/minimax-h3-prompt)
```

After: `CLEAN: no anima/minimax artifacts left in venv`. Remaining exes: `camera-image.exe, camera-video.exe, camera-multiview.exe`. Remaining local dist-infos: camera_image / camera_video / camera_multiview / chenxin_runtime / comfyui_http_runtime / comfyui_mcp_runtime (6 total). `tokenizers` third-party dep left installed (setup.ps1 still installs it; harmless, matches install_local.py "deps: ['tokenizers==0.22.2']" removal — tokenizer is now read from assets/knowledge by the plugin).

## 3. Residual-reference scan results

Scanned preset-wide (excl. .git/.venv/node_modules/temp/dist/.superpowers).

- **Fixed (live config):** `agent.cordis.yml`, `AGENTS.md`, `loader.js`, `scripts/*` (see §1). Only remaining anima-mention in AGENTS.md is the real knowledge path `assets/knowledge/anima-prompt-v1/…` used by `catalog_build` — correct.
- **Plugin source / historical docs (out of scope, allowed):** `plugins/prompt-master/dist/*` (provenance comments + `resolveKnowledgePath({skillDir:'anima-prompt-v1'|'minimax-h3-prompt'})` logical identifiers — resolve to assets/knowledge, which exists); `plugins/prompt-master/docs/*`; tests/fidelity/contracts.md.
- **NOTED — opt-in smoke test:** `plugins/prompt-master/dist/tests/pe-framework/anima-knowledge/catalog-build.test.js:315` uses `join(realPresetRoot(), 'skills', 'anima-prompt-v1', 'knowledge', 'tags.sqlite')` but is gated behind `describe.skipIf(process.env.PM_RUN_REAL !== '1')` — skipped in CI/dev runs (the 539-suite run skipped it). If anyone runs `PM_RUN_REAL=1`, the source path must be updated to `assets/knowledge/anima-prompt-v1/tags.sqlite` (plugin change → defer to a plugin-stage).
- **NOTED — camera-* SKILL.md live references (deliberately NOT modified per "Keep camera-* fully intact"):** `skills/camera-image/SKILL.md` (whenToUse, L16/30/100 "run `anima-prompt-v1 author`"), `skills/camera-video/SKILL.md` (L3/4/23/30/74/214 + Example 4 shows `minimax-h3-prompt.exe author --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge`), `skills/camera-multiview/SKILL.md` L22, `skills/camera-image/references/field-reference.md`. These are model-facing and now point at deleted CLIs — recommend a follow-up docs pass rerouting them to `prompt_author (target=anima|h3)`.
- **NOTED — preset root docs/ + README.md** (`docs/architecture.md`, `docs/cli-cookbook.md`, `docs/development.md`, `docs/troubleshooting.md`, `README.md`): extensive references to the removed CLIs incl. `pip install -e skills/anima-prompt-v1` install instructions (README L27-29) and cli-cookbook sections. Documentation (same status as plugins/prompt-master/docs) — kept as historical; recommend a follow-up docs pass (README install/route table and cli-cookbook are the most user-facing).

## 4. Verification outputs

- `node --check loader.js` → **SYNTAX OK**.
- Watcher/guards: `fs.watch(skillsDir)` watches the dir, not files — `skills/` exists with 3 camera subdirs, so watch + `verifyPresetRoot` (3 SKILL.md present) + `resolveVenvScripts` (3 exes present) all pass.
- Checklist: loader.js has no anima/minimax ✓ (L73/78 = camera blurbs naming the *workflows* they execute — kept); cordis persona 3 camera skills + prompt-master note ✓; AGENTS routing → prompt-master ✓; venv exes gone ✓; skills/ = 3 camera dirs ✓; assets/knowledge has both full copies ✓ (sizes byte-identical to pre-deletion listing: anima manifest 307 / README 5289 / tag-catalog 820846592 / tags 213778432; minimax chat_template 5499 / LICENSE 17604 / manifest 1184 / NOTICE 121 / tokenizer 7032403 / tokenizer_config 11003).
- Manifest JSON validity: both `assets/knowledge/*/manifest.json` parse OK.
- **Plugin suite (untouched):** `Push-Location plugins/prompt-master; npx vitest run` →
  ```
  Test Files  63 passed (63)
       Tests  539 passed | 1 skipped (540)
  ```
  Matches the 539 baseline. ✅ (The 1 skipped = PM_RUN_REAL opt-in smoke, see §3.)

## 5. Commit

- `72ab56d feat(comfyui-chenxin): prompt-master takes over Anima/H3 authoring, remove skill CLIs & dirs` — 56 files changed, 61 insertions(+), 7855 deletions(-); includes `git rm -r skills/anima-prompt-v1 skills/minimax-h3-prompt` (48 tracked files deleted, recorded).
- `9720db3 chore(prompt-master): track assets/knowledge metadata before skill removal` — 7 metadata files.

Left intentionally uncommitted: `skills/camera-image/camera_image/runtime/confirm.py` (pre-existing unrelated change) and untracked `.superpowers/*` sdd artifacts.

## 6. Notes / concerns

1. **Camera SKILL.md + root docs still reference deleted authoring CLIs** — live model-facing text (camera SKILL.md) and distributable docs (README, cli-cookbook). Follow-up recommended; excluded here by the "keep camera-* fully intact" + docs-are-reference constraint.
2. **PM_RUN_REAL smoke test path** — stale `skills/` path behind an opt-in env var; only matters if someone enables it.
3. loader.js / cordis / AGENTS changes take effect on the **next session** — current session unaffected (as expected).
4. `scripts/setup.ps1` still installs third-party `tokenizers` even though no local package depends on it now (`tokenizers==0.22.2` was minimax-h3-prompt's dep). Kept for safety (H3 tokenization is now handled by the plugin via node:sqlite/JSON); could be trimmed in a later stage.