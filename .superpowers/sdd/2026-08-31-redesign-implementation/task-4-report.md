# Task 4 Report: runStage 内核 + render/ 层

## Status: COMPLETE

Commit: `c9f095d` — feat(prompt-master): add runStage pipeline kernel + render envelope layer (4 files, +217)

## Test results
- TDD: test written first, confirmed FAIL (module not found → then implementation).
- After one fix: `npx vitest run tests/pe-framework/pipeline/runStage.test.ts` → 8 passed (8).
- `npm run build` (tsc) → exit 0.
- Full suite `npx vitest run` → **39 files / 293 tests passed** (285 existing + 8 new, zero regressions).

## Files created
- `plugins/prompt-master/src/pe-framework/pipeline/types.ts` — PipelineInput / PipelineTrace / StageResult exactly per brief Produces block.
- `plugins/prompt-master/src/pe-framework/pipeline/runStage.ts` — kernel.
- `plugins/prompt-master/src/pe-framework/render/envelope.ts` — targetSlotHint + assembleEnvelope.
- `plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts` — brief Step 1 test verbatim.

## Implementation notes
- **runStage**: zero target-specific branches. Single dispatch via `getDialect(input.target)`:
  1. Unregistered dialect → failed StageResult (no throw) with `dialect_not_available` critical gate carrying `target` + `source: 'pipeline/runStage'`; falls back to `targetSlotHint()` generic mapping.
  2. `auditOnly && !auditOnlyOk` → throws `target X 不支持 auditOnly`.
  3. normalize `error` → throws that string wrapped in Error.
  4. compile → audit → optional `d.budget?.(...)`; budget included (cast to `Budget`) only when defined.
  5. `ok = gates.every(g => g.severity !== 'critical')`.
  6. `result = {}` in auditOnly mode, else compiled cast to `Record<string, unknown>`.
  7. trace stages via `performance.now()` deltas: schema/dialect/audit/[budget when present]/render.
  8. `assumptions = audit.assumptions ?? []`; `advisories: []`.
- Pure functions, no logging anywhere.

## serializeReport integration
`audit/report.ts` exports `serializeReport(report: AuditReport): string` = plain `JSON.stringify`. assembleEnvelope builds the P1 envelope `{ ok, ...(ok?{result}:{}), audit:{passed,gates,...(budget?{budget}:{})}, advisories, target_slot_hint }` and calls `serializeReport(envelope as unknown as AuditReport)` — the cast is required because the envelope superset doesn't literally match `AuditReport`; key order and key names are exact per spec, and serialization stays centralized on serializeReport.

## Deviations
1. **Envelope carries top-level `advisories` in addition to `audit.advisories`.** The brief's spec line lists `advisories:[...stage.advisories, ...trail]` as an envelope key, but the first implementation put advisories only inside `audit`; test case 7 (`s.advisories` deep-equal) failed. Fixed by also exposing `advisories` at the envelope top level (same array). Tests parse JSON so this matches both the brief text and the assertions. Downstream note for Task 6: envelope has both `advisories` (top) and `audit.advisories` (identical content).
2. **render stage trace ms is 0** — rendering in this kernel is just the return value, so the render stage measures nothing. Spec only requires the stage entry to exist.
3. Test file is the brief's code verbatim (no assertion-string adaptation needed — `serializeReport` is plain JSON.stringify as predicted).

## Self-review
- No `if(target==='anima')`-style logic in runStage; only registry lookup and one fallback hint mapping in render/envelope.ts (which is where target→hint mapping belongs per spec).
- Attempt IDs / capabilities: n/a (direct task).
- Constraints respected: only the three created files + the test were touched; no other files modified; no other subagents used.
- Task 6 dependency shapes (PipelineInput/StageResult/envelope keys) match the Produces block exactly.
