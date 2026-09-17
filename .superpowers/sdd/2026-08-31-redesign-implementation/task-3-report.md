# Task 3 Report: Dialect Registry

**Status:** COMPLETE
**Commit:** `f63f9b2` — feat(prompt-master): add dialect registry (registerDialect/getDialect/isDialectReady)

## Implementation
- `src/pe-framework/dialect/contract.ts` — `PipelineInputLike`, `DialectContract<TSlots, TCompiled>` per brief Interfaces. `audit` ctx includes `variant?: string` (required by Task 5 anima.audit).
- `src/pe-framework/dialect/registry.ts` — module-level `Map<Target, DialectContract>`; `registerDialect` (throws `dialect already registered: <id>` on duplicate), `getDialect`, `isDialectReady`, `__resetDialectsForTests`. Zero IO, zero logging.
- `tests/pe-framework/dialect/registry.test.ts` — 3 tests per brief Step 1, verbatim.

## Import verification (brief's flagged adaptation)
- `AuditGate` and `Target` **are both exported** from `src/pe-framework/types.ts` (lines 1, 5) — no local `Target` definition needed.
- `Reference` is **not** at `../schema/h3-shots.js` relative to a root-level `src/schema/` — the file actually lives at `src/pe-framework/schema/h3-shots.ts` (line 52: `export interface Reference`). Since `contract.ts` sits in `src/pe-framework/dialect/`, the brief's relative import `'../schema/h3-shots.js'` resolves correctly as-is. **No deviation required.**
- One deviation from the brief's registry.ts code: added `export type { DialectContract }` re-export from `registry.ts`, because the brief's own test imports `type DialectContract` from `registry.js` and `tsc` (TS2459) rejected the brief's version. Behavior identical.

## TDD evidence
1. Red: `npx vitest run tests/pe-framework/dialect/registry.test.ts` → `Cannot find module ... registry.js`, 1 failed.
2. Green: same command → `3 passed (3)`.
3. Build: `npm run build` (tsc) → exit 0.
4. Full suite `npx vitest run` → **38 files / 285 tests, all passed**.

## Concerns / notes
- First full-suite run had 1 failure in `tests/fidelity/anima-catalog-golden.test.ts` ("fuzzy: silver hair"). Verified pre-existing/flaky, not caused by this change: it passes in isolation with our files present, and the immediate full-suite re-run passed 285/285. Likely a load/parallelism-dependent flake (7.5s in the failing run vs 1.7s isolated).
- Unrelated dirty files exist in the repo working tree (`agent.cordis.yml`, `skills/camera-image/.../confirm.py`, `.superpowers/`); none were staged — commit contains exactly the three task files (79 insertions).
