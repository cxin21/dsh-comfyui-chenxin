# Task 8 Fix Report — Final-Review Findings (MF-1/2/3)

Commit: `108c11f` — `fix(prompt-master): director group inspection, continue partial-on-error, enable filter reaches findProfileById`

## MF-1: Group inspection (director_segments contract inert)

**Files:** `src/pe-framework/continue/inspect.ts`, `src/pe-framework/continue/engine.ts`, `src/tools/minimax-scenario.ts`

- `inspectOutput(text, contract, formFields?)`: after field checks, if `contract.groupSeparator` exists — count groups as separator matches; expected from `contract.expectedGroups?.(formFields ?? {}) ?? 0`; missing `groups:<n>/<expected>` when under; per-group non-empty body check emits `group:<n>:body`.
- **Adaptation (documented per instructions):** the sketch said to count a non-empty leading segment as a group, but the prescribed tests are authoritative and treat the leading `前言` as preamble (test 1 expects `groups:3/4` with a non-empty preamble). Implemented groupCount = separator match count only; leading segment never counted as a group.
- Engine: `continueUntilComplete` params extended with `formFields?`, passed to both `inspectOutput` calls; minimax-scenario.ts passes `formFields: args.form_fields || {}`.

**Tests added (continue-engine.test.ts, 6 new):** 3/4 groups → `groups:3/4`; all 4 → complete; empty group body → `group:2:body`; separator-first text → no phantom leading group.

## MF-2: Engine generate-error path throws away partial text

**File:** `src/pe-framework/continue/engine.ts`

- On generate throw: if merged text differs from `initialText` → push `CONTINUE_PARTIAL_BEFORE_ERROR` and return partial `{ text, rounds, complete: false, warnings }`; rethrow only when nothing was merged. Abort path keeps `CONTINUE_ABORTED_PARTIAL`.

**Tests added:** generate throws after one mergeable piece → partial result (complete=false, warning, text retains merged piece, rounds=2); generate throws before any merge → rethrows.

## MF-3: enable=false doesn't reach findProfileById

**Files:** `src/resolver/profiles/index.ts` (filter home — `pe-framework/profiles/index.ts` does not exist; `findProfileById` lives in resolver/profiles), `src/plugin/index.ts`

- New `setBuiltinFilter(filter | undefined)` + module-level `builtinFilter`; `findProfileById` returns `undefined` when filter matches.
- plugin/index.ts: after `registerOverridesNamespace`, `setBuiltinFilter((id) => overrides.all()[id]?.enabled === false)` — read live at each lookup.

**Tests added (storage-v2.test.ts, 2 new):** filter `id==='pe_a'-style` (pe_reverse_descriptive) → `findProfileById` undefined, others still resolve; `setBuiltinFilter(undefined)` restores.

## Commands & outputs

- `npm run build` → exit 0 (tsc clean)
- `npx vitest run` → **Test Files 51 passed (51), Tests 393 passed (393)** (baseline 385 + 8 new)
- Touched files: 7 (5 src, 2 test files); one commit, no refactors beyond the three fixes.

## Residual fix: final inspectOutput omitted formFields (director contract false INCOMPLETE)

Commit: `be3aff8` �� `fix(prompt-master): pass formFields to final continue inspection (director contract completeness)`

**Files:** `src/pe-framework/continue/engine.ts`, `tests/pe-framework/continue/continue-engine.test.ts`

- Line ~65 final `inspectOutput(text, params.contract)` now passes `params.formFields` (in-loop call already did).
- **Additional engine change (required by the prescribed test, beyond the one-liner):** the post-loop verdict also gated on `finish !== 'max-tokens'`, forcing `complete:false` + `INCOMPLETE_AFTER_MAX_ROUNDS` even when the final inspection was verified complete. Final verdict is now structural: warning only when `!final.complete`; `complete: final.complete`. The dark-truncation trigger (max-tokens forces extra continuation rounds in-loop) is unchanged at the loop condition.
- Test added: director contract (4 expected groups), initial finishKind max-tokens, maxRounds:1, generate returns all-4-groups text still finishing max-tokens �� `complete === true`, `warnings` empty. Fails before the fix (final inspect without formFields �� groups:0/4).

**Verification:** continue-engine.test.ts 17/17; `npm run build` exit 0; full suite 394/394 green.
