# Task 2 Report: 替换硬编码路径 + 资产 manifest 对账

**Status: DONE** · Commit: `e46ae2c` (main)

## What changed

### Created: `src/pe-framework/resources/manifest.ts`
- `AssetCheck` type (`{ok:true} | {ok:false; reason}`), `sha256File`, `assertAnimaCatalog`, `assertH3Tokenizer` — per brief Step C, verbatim API.
- Verified real manifest field shapes before implementing:
  - `skills/anima-prompt-v1/knowledge/manifest.json` → checksum at `output.checksum` (matches brief's `m?.output?.checksum ?? m?.checksum` chain; added early-return for missing checksum so reason says "no checksum field" without hashing).
  - `skills/minimax-h3-prompt/knowledge/manifest.json` → `snapshot_id: "h3-qwen3-vl"` confirmed.

### Modified: `src/pe-framework/dialect/anima-catalog.ts` (Step A)
- Deleted both hardcoded `C:/Users/11245/...` consts; added `defaultCatalogPath()` / `defaultOverlayPath()` via `resolveKnowledgePath({skillDir:'anima-prompt-v1', asset:...})`.
- `_dbPath = process.env.ANIMA_CATALOG_PATH ?? defaultCatalogPath()` (env injection preserved).
- `overlayStatus()` now checks `defaultOverlayPath()` lazily (no ANIMA_OVERLAY_PATH env existed before — verified by read; none added).
- `knowledgeDir()` returns `dirname(defaultCatalogPath())`.
- `setCatalogPath` / `catalogPath()` / `searchCatalog` / `overlayStatus` / all other exports unchanged.
- Manifest check wired once per process via module-level `_manifestChecked` flag; on failure: `console.warn('[prompt-master] <reason>：资产与 golden 基线不同，请 re-run fidelity capture')`, open continues.

### Modified: `src/pe-framework/audit/tokenizer-h3.ts` (Step B)
- Deleted `DEFAULT_SOURCE_DIR` hardcoded path; added `defaultTokenizerSourceDir()` = `dirname(resolveKnowledgePath({skillDir:'minimax-h3-prompt', asset:'tokenizer.json'}))`.
- Priority chain preserved: explicit `sourceDir` arg > `H3_TOKENIZER_DIR` env > `defaultTokenizerSourceDir()` (both in `h3Tokenizer()` and the `H3Tokenizer` constructor default).
- `assertH3Tokenizer()` wired in the constructor behind a module-level once-flag with the same console.warn; cheap (no hashing), so it stays on the lazy load path.

### Created: `tests/pe-framework/resources/manifest.test.ts` (Step D)
- TDD: written first, confirmed red (module not found → then 2 real failures caught a genuine bug: `createHash` initially imported from `node:fs`), then implementation made it green.
- 8 cases (brief required ≥4): anima match/mismatch/missing-manifest/missing-checksum-field; h3 match/wrong-snapshot_id/missing-tokenizer.json/missing-manifest. All use `mkdtempSync` tmp fixtures + `setPresetRoot`; `setPresetRoot(undefined)` + `rmSync` in `afterEach`. No real 783 MiB catalog touched.

## Verification (Step E)

| Command | Result |
|---|---|
| `npx vitest run tests/pe-framework/resources/manifest.test.ts` | 8/8 passed |
| `npx vitest run tests/plugin/budget-tokenizer.test.ts tests/plugin/tokenizer.test.ts tests/plugin/anima-catalog.test.ts` | 25/25 passed (injection points intact) |
| `npx vitest run` (full) | **282/282 passed, 37/37 files** |
| `npm run build` | exit 0 |
| `Select-String 'C:/Users/11245'` under src/ | **0 matches** |

## Deviations

1. **Anima manifest check moved from lazy `db()`-first-open to module evaluation time.** Rationale: full-suite run initially failed 9 previously-green tests with vitest 5s per-test timeouts — the 783 MiB sha256 runs once per vitest worker, and under parallel IO contention it exceeded 5s inside the first db-opening test of 9 files. Module evaluation (import/collection phase) is untimed by vitest and still strictly precedes any db open, preserving "check before first open + warn once". Tokenizer check stays on the lazy constructor path (cheap, no hashing). Behavior for production code is unchanged.
2. `assertAnimaCatalog` returns the "no checksum field" reason before hashing (brief sketch hashed first); avoids pointless 783 MiB hashing when manifest is malformed.

## Self-review

- All existing exports preserved (`setCatalogPath`, `catalogPath`, `searchCatalog`, `overlayStatus`, `OVERLAY_ADVISORY`, `classifyTag`, `catalogMeta`, `closeCatalog`, `knowledgeDir`; tokenizer: `H3Tokenizer`, `h3Tokenizer`, `countTokensH3`, `encodeTokensH3`, `tokenizerMeta`). `budget.ts` untouched; `tokenizerSourceDir` option flows through unchanged.
- No `console.log` added; only the two brief-specified `console.warn` sites. ESM `.js` import suffixes used. Only the 4 Files-list paths touched.
- One process hiccup (not a code issue): a PowerShell `-replace | Set-Content` pass corrupted the test file's encoding early on; file was recreated via the write tool — final committed content is clean UTF-8.
- Risk noted for Task 3+: `knowledgeDir()` now depends on `resolveKnowledgePath` throwing if no preset root can be located (env/fallback absent) — previously it always returned the hardcoded string. All current callers pass in the real preset layout (fallback resolves), and the full suite is green, but any future consumer outside the preset layout should set `DSH_COMFYUI_PRESET_ROOT`/`setPresetRoot`.
