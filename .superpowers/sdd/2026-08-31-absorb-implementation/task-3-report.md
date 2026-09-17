# Task 3 Report — B1 接入 minimax 场景（契约声明 + generate 封装）

## Status: DONE
Commit: `e08875b` — `feat(prompt-master): wire continue engine into minimax scenarios (contract-declared)`

## Actual section names found (dialect/h3.ts buildRef2vaText, lines 169-181)
Emitted verbatim as `name: body` lines:
`subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, `non_diegetic_music`

These match Task 2's sixSegment contract field keys exactly — patterns taken verbatim from
`tests/pe-framework/continue/continue-engine.test.ts` (e.g. `/subject_definitions\s*[:：]/i`, summary also accepts `摘要：`).

## Contract patterns chosen
- `full_reference` (keyed by scenario id AND outputMode): six fields as above, id `minimax-full-reference`.
- `director_segments` (keyed by outputMode; the scenario with this outputMode is `continuous_story` — no scenario is literally
  named director_segments): `fields: []`, `groupSeparator: /={3,}\s*提示词组\s*(\d+)\s*={3,}/`,
  `expectedGroups: (ff) => Number(ff?.['segment_count'] ?? 4)`. Note: `inspectOutput`/engine only consumes `fields`;
  groupSeparator/expectedGroups are declared per brief for future group-level inspection.

Resolution API (scenes.ts): `SCENE_OUTPUT_CONTRACTS` record + `sceneOutputContract(scenarioId, outputMode?)` —
scenario id first, then outputMode fallback.

## Wiring (minimax-scenario.ts)
After the initial `complete`: if `sceneOutputContract(...)` is defined → `continueUntilComplete` with
`finishKind: finish.kind`, seed system/user from `expanded`, `outputLang` derived from `output_lang` ('en' vs 'zh'),
generate wrapper over `complete` reusing B0's `applyCapabilities` temperature (kept from Task 1, per brief),
`signal: exec.signal`, `onContinue` → `ctx.logger?.info?.('[prompt-master] continue round=n/max')` plus a final
summary log. `req.system ?? expanded.system` satisfies complete's required `system` (generate req.system is optional).

## Mock approach (tests/plugin/minimax-continue.test.ts)
Reused the minimax.test.ts pattern (`stubCtx` + StreamChunk shape incl. `finish.reason.kind`) with a sequential
queue: `seqCtx` wraps `ctx.llm.stream` to shift one chunk-array per call — call 1 = half six-section text with
`finish 'max-tokens'`, call 2 = remaining three sections with `finish 'stop'`. Assertions: merged prompt contains
all six labels; llm calls ≥ 2; continuation message contains `已写出` / `缺失内容` / `field:retention_analysis` /
accumulated PART1 text. Second test: structurally complete + stop → exactly 1 llm call (no continuation).

## Carry-over check (zh prompt wording)
`已写出（不要重写，基于它继续）：-----…-----　缺失内容：field:…。请从缺失处继续输出…` renders correctly in the
captured second-call user message — no defect in engine.ts. No engine modification needed.

## Test / build outputs
- New test: 2 passed. minimax.test.ts: 4 passed.
- Build (`tsc`): exit 0 (one fix needed: `req.system ?? expanded.system` for TS2322).
- Full suite: **46 files / 344 tests, all passed** (brief estimated ~352; actual current suite size is 344).

## Deviations
1. **`MiniMaxScenario` type not extended with `outputContract?`**: the type lives in
   `src/resolver/minimax/catalog.ts` (outside this task's allowed file set). Instead contracts are declared in
   `scenes.ts` (`SCENE_OUTPUT_CONTRACTS` + `sceneOutputContract()`), and minimax-scenario.ts resolves via
   `sceneOutputContract(scenario.id, scenario.outputMode)`. Behaviorally equivalent to the brief's
   `scenario.outputContract` lookup.
2. **`tests/plugin/minimax.test.ts` mock updated (1 line)**: its `'rendered prompt'` mock is structurally incomplete
   against the now-declared full_reference contract, so the engine (correctly) continued 3 rounds → `calls.length`
   became 4, breaking `expect(...).toBe(1)`. Changed the mock text to a complete six-section output so the test
   still verifies the original concern (usage-derived tokens, calls=1). This was unavoidable while keeping the
   existing test green and not weakening the contract declaration.
3. Final tool JSON output unchanged (no new `continue` field); rounds are observable via logs and llm call count.

## Self-review
- Contract patterns verbatim-aligned with emitted dialect text — verified by reading buildRef2vaText source.
- Engine untouched; abort semantics, maxRounds default 3, merge behavior all as shipped in Task 2.
- Continuation only fires on contract-declared scenarios (`full_reference` id/outputMode and director_segments
  outputMode); all 8 other scenarios and dry_run path are untouched (calls.length assertions confirm).
- No secrets, no new dependencies, only the 3 planned files (+ the 1-line existing-test mock fix, flagged above).

---

## Review Fix (Important): scope full_reference contract by scenario id
Commit: `074cd4d` �� `fix(prompt-master): scope full_reference continue contract by scenario id (product_ad/brand_promo are t2va)`

**Problem**: `sceneOutputContract` fell back by outputMode, so `product_ad` / `brand_promo`
(outputMode `full_reference` but routed to stage t2va by pickStage, three-field body) got the
six-section ref2va contract �� 3 wasted rounds + INCOMPLETE_AFTER_MAX_ROUNDS on every call.

**Fix**: six-section contract now matches scenario id ONLY. Mode fallback retained for
`director_segments` (verified: catalog shows only `continuous_story` uses that mode).
Regression test added in `tests/plugin/minimax-continue.test.ts`: `product_ad` with complete
three-field t2va body (finish=stop) �� exactly 1 llm call, no continuation.

**Verification**: targeted files 7/7 green; `npm run build` exit 0; full suite 345/345 (46 files).
