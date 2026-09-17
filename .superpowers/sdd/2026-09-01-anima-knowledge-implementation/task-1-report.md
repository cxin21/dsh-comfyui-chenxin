# Task 1 Report — G4 catalog handle refresh + manifest re-check

**Status:** ✅ Complete
**Commit:** `7b56511` (feat(prompt-master): G4 catalog handle refresh on mtime change + manifest re-check)
**Files changed:**
- `plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts` (modified)
- `plugins/prompt-master/tests/pe-framework/dialect/anima-catalog-refresh.test.ts` (new)

## What was implemented

In `anima-catalog.ts`, touching only `db()` and `verifyManifestOnce()` (plus new module-level state):

- `db()` now `statSync(path).mtimeMs` on every call; if a cached handle exists and mtime differs, it closes the stale handle, nulls `_db`, resets `_manifestChecked` (→ manifest re-check on reopen), then reopens read-only and records the new mtime. statSync failure → mtime 0 (missing-file error still surfaces from `DatabaseSync` open).
- New export `lastManifestCheck(): { ok: boolean; reason?: string } | undefined` — undefined = never reconciled; `verifyManifestOnce()` now records the `assertAnimaCatalog()` result into `_lastManifest` while keeping exact warn-not-crash semantics (same console.warn text).
- New export `_testOnlyState()` probe: `{ dbOpen, mtimeMs, dbGeneration, manifestChecks }`.

All existing exports/behavior preserved; no logging changes; no other files touched.

## Test approach (TDD)

1. Wrote `anima-catalog-refresh.test.ts` first → confirmed FAIL (`lastManifestCheck is not a function`, 2 failed).
2. Implemented → PASS.

mtime→reopen assertion: mocking `statSync` + `node:sqlite` together proved fragile (brief-anticipated), so used the **permitted `_testOnlyState()` probe** downgrade (documented in both test file and source comments). Probe assertions: `dbGeneration` 1→2 on mtime change (handle reopened), `manifestChecks` 1→2 (manifest re-checked), cached mtime tracks `utimesSync` bump, and no reopen when mtime unchanged (idempotent reuse). Fixture is a tiny hand-built sqlite in `mkdtemp` tmpdir; `afterEach` closes the handle, resets catalog path to default, and removes the tmpdir. A second test covers `lastManifestCheck` shape against the real catalog.

## Verification

- `npx vitest run tests/pe-framework/dialect/anima-catalog-refresh.test.ts` → 2/2 PASS
- `npm run build` (tsc) → exit 0
- Full suite `npx vitest run` → **52 files / 402 tests passed**, exit 0 (400 baseline + 2 new)

## Concerns

- Manifest re-check after reopen runs `assertAnimaCatalog()` which always hashes the *default* knowledge-path catalog (not the override path) — pre-existing semantics of `assertAnimaCatalog()` (no args), unchanged here; on the 783 MiB real asset a reopen-triggered re-check costs a sha256 pass (~seconds, within 30s testTimeout).
- `setCatalogPath()` intentionally does not reset `_manifestChecked` (out of scope per brief); tests handle isolation via probe counters and afterEach reset instead.
