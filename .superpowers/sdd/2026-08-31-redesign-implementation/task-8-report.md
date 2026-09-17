# Task 8 — Final-Review Fix Report (MF-1 / MF-2 / MF-3)

Date: 2026-08-31 · Commit: `110ae88` (main, comfyui-chenxin) · Plugin: plugins/prompt-master

## MF-1 — anima-catalog lazy path (Important)

**Files:** `src/pe-framework/dialect/anima-catalog.ts`, `tests/pe-framework/resources/resolve.test.ts`

- `_dbPath` (import-eval `process.env.ANIMA_CATALOG_PATH ?? defaultCatalogPath()`) → `_dbPathOverride: string | null = env ?? null`; `catalogPath()` = `_dbPathOverride ?? defaultCatalogPath()` resolved at call time.
- `setCatalogPath(path)`: same signature; closes db on change; empty string resets override to env priority (level 0) then lazy default.
- `db()`: opens with `catalogPath()`; `verifyManifestOnce()` moved from module eval into first `db()` call (once-flag preserved).
- `catalogMeta()` now stats `catalogPath()`; `knowledgeDir()` / `overlayStatus()` were already call-time lazy (unchanged).
- New tests (3) in `tests/pe-framework/resources/resolve.test.ts`: setPresetRoot after import → `catalogPath()` follows (twice); `setCatalogPath` override wins + clearing restores; `ANIMA_CATALOG_PATH` env priority over presetRoot.

**Verification:** `npx vitest run tests/plugin/anima-catalog.test.ts tests/fidelity/anima-catalog-golden.test.ts tests/pe-framework/resources/resolve.test.ts` → 30 passed (10 catalog + 13 golden + 7 resolve). Import no longer touches fs or throws.

## MF-2 — assumptions reach Envelope (Important)

**Files:** `src/pe-framework/render/envelope.ts`, `tests/pe-framework/pipeline/runStage.test.ts`

- `assembleEnvelope` now emits top-level `assumptions: stage.assumptions` (alongside `advisories`); audit object untouched (`{passed, gates, budget?}`).
- Test: assembleEnvelope ok:true case extended — input `assumptions: ['assumed:1']` → `expect(s.assumptions).toEqual(['assumed:1'])`.

**Verification:** `npx vitest run tests/pe-framework/pipeline/runStage.test.ts` → 8 passed.

## MF-3 — compile result preserved on critical gates (Important)

**Files:** `src/tools/prompt-compile.ts`, `tests/plugin/compile-h3.test.ts`

- `stageToEnvelope`: result-omission now applies ONLY when `omitResult` (audit_only). For non-audit-only calls where `assembleEnvelope` dropped `result` due to `ok:false`, the stage result is re-attached — deterministic compile returns visible text with `audit.passed:false`, matching legacy behavior. `assembleEnvelope`/prompt-author semantics untouched.
- Pinning test: ref2va with 2 references (critical `ref_count`) → `parsed.ok === false` AND `parsed.result.text` is a non-empty string.

**Verification:** `npx vitest run tests/plugin/compile-h3.test.ts` → 8 passed.

## Full suite + build

- `npx vitest run` → **Test Files 43 passed (43), Tests 313 passed (313)**, exit 0 (baseline ~309 + 4 new tests). First full run had 10 one-off failures (catalog sha256 timeout flakiness under cold parallel IO); two consecutive clean runs confirm stability.
- `npm run build` (tsc) → exit 0.

## Commit

`110ae88` — `fix(prompt-master): lazy catalog path (config priority + no import throw), emit assumptions in envelope, preserve compile result on critical gates` (6 files: 3 src, 3 tests).
