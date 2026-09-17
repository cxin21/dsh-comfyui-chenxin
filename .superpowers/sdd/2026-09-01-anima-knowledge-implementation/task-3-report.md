# Task 3 Report — G5 candidate/threshold advisory + G4 manifest visibility

## Status
COMPLETE. Commit `47a26be` on main.

## Changes (only the two whitelisted files)
- `plugins/prompt-master/src/tools/catalog-search.ts`
  - Import `lastManifestCheck()` from anima-catalog (T1 interface).
  - `hits` now projected via `hits.map(h => ({...h, candidate: h.match_type === 'fuzzy'}))`.
  - New top-level `advisories?: string[]`: one entry per fuzzy hit with `usage_count < 1000`,
    exact string `'fuzzy_below_threshold: usage_count=N 低于采纳阈值 1000，仅作候选参考'`;
    key omitted (JSON.stringify drops `undefined`) when no advisory applies.
  - New top-level `manifest`: `lastManifestCheck()` result verbatim (`{ok, reason?} | undefined`).
  - Output schema description updated to `{hits[].candidate, advisories?, manifest, overlay}`.
- `plugins/prompt-master/tests/plugin/catalog-search.test.ts`
  - Appended the 3 brief Step-1 cases (G5 candidate flag, G5 threshold advisory, G4 manifest).
  - No existing assertions touched.

## Verification
1. TDD red: new tests failed 3/3 before implementation (existing 6 green).
2. TDD green: `vitest run tests/plugin/catalog-search.test.ts` → 9/9 passed.
3. `npm run build` (tsc) → exit 0.
4. Full suite: `vitest run` → **53 files / 415 tests passed**, exit 0.

## Concerns
- `manifest` key: when no manifest check has run, `lastManifestCheck()` returns `undefined` and
  `JSON.stringify` omits the key entirely (matches brief's `| undefined` typing; the G4 test path
  always has a check since catalog open runs reconciliation).
- Advisory exactness: per-hit entries (one per low-usage fuzzy hit), matching the brief's `usage_count=N` template.
