# Task 5 Report — G2 Envelope top-level `phase_status` via `dialectTopLevel`

**Status:** COMPLETE
**Commit:** `72a6916` — `feat(prompt-master): G2 envelope top-level phase_status via dialectTopLevel`
**Tests:** 421 passed (53 files), build (`tsc`) exit 0.

## Changes

### `src/pe-framework/render/envelope.ts`
- `assembleEnvelope` gains optional 4th param `dialectTopLevel?: Record<string, unknown>`.
- Spread last in the envelope object literal (`...(dialectTopLevel ?? {})`) so dialect keys merge into the top level and cannot be dropped by base keys. h3 path passes nothing → envelope unchanged (verified by a new negative test).

### `src/tools/prompt-compile.ts`
- `stageToEnvelope` opts now accept `dialectTopLevel` and forward it as the 4th `assembleEnvelope` arg.
- `compileAnimaEnvelope` extracts `phase_status` from `stage.result` (when present) and passes `{ phase_status }`. Works even under `audit_only` (result omitted, top-level projection still visible — SKILL.md:343-356 verbatim four-stage reporting).
- h3 branch untouched: no `dialectTopLevel` → no top-level `phase_status` in generic layer.

### Tests (TDD: red → green)
- `tests/pe-framework/pipeline/runStage.test.ts`: `assembleEnvelope` describe — dialectTopLevel keys merge into envelope top level.
- `tests/plugin/compile-anima.test.ts`:
  - `raw.phase_status` equals `{ policy:'PASS', grounding:'PASS', composition:'PASS', inspection:'PASS' }` at envelope TOP level (not just inside `result`).
  - Negative: h3 envelope has no top-level `phase_status`.

## Verification
- New tests failed before implementation (3 red), passed after.
- Full suite: `421 passed (421)` / 53 files.
- `pnpm build` (tsc): exit 0.

## Concerns
- Brief's Step-1 snippet passes `dialectTopLevel` as the 3rd arg (collision with `observability`); implemented per task spec as the 4th param — tests written accordingly.
- `phase_status` projection now also appears on `audit_only` anima envelopes (result omitted, top-level status retained) — believed desirable per SKILL.md verbatim-reporting requirement; flag if audit_only should strip it.
