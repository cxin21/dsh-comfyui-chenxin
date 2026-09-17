# Task 7 Report: H3 budget 帧底精确化 + intent persona/schema 方言化 + 生产级日志

**Status: COMPLETE** · Commit `d0d1b67` · Full suite 309/309 green (43 files) · `npm run build` exit 0

## 1. countTokensH3 real signature

`src/pe-framework/audit/tokenizer-h3.ts` L224:

```ts
export function countTokensH3(text: string, sourceDir?: string, referenceCount = 0): { tokens: number; ids?: number[] }
```

Brief's sketch matched the real export (param order text → dir → refCount). Internally delegates to `H3Tokenizer.countContext(text, refCount)` — the official user-message context frame `<|im_start|>user\n{Picture i: <|vision_start|><|image_pad|><|vision_end|>\n × N}{text}<|im_end|>\n` fully BPE-encoded. `countTokensH3('', dir, N).tokens` is exactly the official frame bottom.

## 2. Frame-bottom grounding values

- Golden `h3-tokenizer-golden_t2va_baker.json`: raw=76, framed=81 → **zero-ref frame bottom = 5** (matches old estimate for refs=0 — asserted in test 3).
- 1-ref exact frame (real tokenizer): `countTokensH3('', dir, 1).tokens` computed live in the test and asserted equal to `budget.chatTemplateTokens`; also asserted `> 7` (old estimate `5+2N` for N=1) proving the exact value is in play.
- Fallback preserved: invalid `tokenizerSourceDir` → `chatTemplateTokens === 7` (old `5+2·1`), independent of the textTokens estimate fallback (separate try/catch, both fall back to old口径).

### Implementation (budget.ts)
- Added observable field `chatTemplateTokens: number` to `H3BudgetProjection` (additive; no existing test asserts exact shape — verified by grep). Pure, log-free.
- `chatTemplateTokens` = `countTokensH3('', options?.tokenizerSourceDir, references.length).tokens` in try/catch; catch → old `refs===0 ? 5 : ceil(5+2N)`. `tokenizerSourceDir` override semantics unchanged.
- TDD: test first → 3 failed (field undefined) → fix → 4/4 pass.

## 3. Logger access pattern found

Grep of `src/` found **no `ctx.logger` precedent** (only a comment in anima-catalog.ts saying resource layer has no ctx.logger; the plan doc states Cordis Context self-carries `logger`). Decision: tools access it via optional chaining on a cast — `(ctx as unknown as { logger?: { info?: (msg: string) => void } })?.logger?.info?.(...)` — so stub test environments without a logger silently skip (explicit no-logger test added).

Per-tool wiring:
- **prompt_author**: entry log (target/variant/stage) + success log `→ ok= gates= critical= trace=[schema:Xms,...]` before assembleEnvelope.
- **prompt_compile**: `registerCompileTool(ctx?)` — param is optional so existing `registerCompileTool()` callers (plugin/index.ts, compile tests) are untouched. anima branch logs via a new optional `onStage` callback param on `compileAnimaEnvelope` (preserves its slots/variant validation semantics); h3 branch logs directly. Both attach trace summary.
- **prompt_audit**: `registerAuditTool(_ctx→ctx, ...)`; execute parses the envelope JSON it is about to return to log `ok/gates/critical` (parse wrapped in try/catch — log failure can't affect the tool result).
- **prompt_expand / prompt_reverse**: entry log (profile/length/media_target/images, `dry_run=true` marker) + success `→ ok=true chars=N`; dry_run path logged too. No prompt bodies, no image data in any log line.

## 4. Intent dialect wiring

- `subagent-provider.ts`: persona/schema resolution moved from `createSubagentIntentProvider` factory into `subagentIntent(req)`: `req.persona ?? opts.persona ?? DEFAULT_PERSONA` (same for schema). DEFAULT_* fallback unchanged → all 11 pre-existing intent tests pass untouched.
- `prompt-author.ts`: `AuthorIntentRequest` gains optional `persona?`/`schema?`; execute computes `getDialect(target)?.intent` (ANIMA_*/H3_* constants registered by Task 5) and spreads it into both provider calls (round 0 and correction rounds).
- New test: req persona/schema beat opts and DEFAULT (prompt contains markers, not `资深`/OPTS values). Red → green confirmed.

## 5. Test outputs

| Step | Result |
|---|---|
| `budget-frame.test.ts` (new, 4 tests) | red 3F/1P → green 4/4 |
| `subagent-provider.test.ts` + `intent.test.ts` + `author-e2e.test.ts` | 21/21 (incl. new priority case) |
| `logger-spy.test.ts` (new, 3 tests) | 3/3 |
| Full suite `npx vitest run` | **309 passed / 43 files**, zero failures — no flaky re-runs needed (catalog-search, anima-brief-golden passed in-suite) |
| `npm run build` | exit 0 (after casting `stubExec() as any` in logger-spy test — stub exec lacks full ToolRunContext fields under tsc) |

Fidelity goldens all green (text-token assertions unaffected by frame-bottom change; zero-ref frame bottom = 5 = old value, so existing budgets unchanged for refs=0).

## 6. Deviations from brief

1. **`chatTemplateTokens` exposed on projection** — brief's sketch kept the value internal and suggested only counter/effectiveCap assertions; with qualityCap=1200 ≪ available, `effectiveCap` can't distinguish exact vs estimate without ~260k-token text. Exposing the additive field makes the exact-frame assertion direct and grounded (`=== countTokensH3('', dir, N).tokens`).
2. **compile anima branch via `onStage` callback** instead of inline runStage, to keep `compileAnimaEnvelope`'s exported validation semantics identical.
3. **`registerCompileTool(ctx?)` optional param** rather than changing plugin/index.ts (not in the Files whitelist).
4. Test-file-only fix: `stubExec() as any` cast in logger-spy (build typechecks tests).

## 7. Self-review

- budget.ts remains pure/log-free (constraint ✔); both fallbacks independent per brief note ✔.
- No prompt bodies/image data/API keys in any log message — asserted by tests for compile + expand ✔.
- `run_stage` trace attached only to author/compile success logs per brief; audit logs gate counts from the returned envelope.
- Optional chaining everywhere: tools verified to work with logger-less ctx (dedicated test) ✔.
- Files touched: exactly the whitelist + 2 new test files ✔. No other subagents used ✔.
