# Task 7 Report — B5 双层存储 + 导入导出

**Status:** COMPLETE
**Commit:** `672e2a7` — `feat(prompt-master): two-layer profile storage + import/export with id recast` (6 files, +354/−13)

## Delivered
- `src/pe-framework/profiles/storage-v2.ts` (new): `BuiltinOverride`/`OverridesApi`, `registerOverridesNamespace(ctx)` (settings namespace `prompt-master-profile-overrides`, z.dict value-first per schemastery signature), `listProfilesMerged`, `validateImportPayload`, `recastImportedProfile`. PEProfile has `builtin`, `createdAt?`, `updatedAt?` → recast sets all (compile-gated). Pure module, no logging.
- `src/tools/profile-list.ts`: list/search now merged via `listProfilesMerged(builtins, customs, overrides.all())` (split by `builtin` flag from `getDefaultBuiltinProfiles()`), then kind/target/query filters; new actions `enable` / `sort` / `export` / `import` / `validate_import`; deps gained optional `overrides`. Existing save/delete/get semantics untouched.
- `src/plugin/index.ts`: `const overrides = registerOverridesNamespace(ctx)` passed into `registerProfileListTool(ctx, config, { scope, overrides })`.
- Tests: `tests/pe-framework/profiles/storage-v2.test.ts` (9, brief Step 1 verbatim), `tests/plugin/profile-list-v2.test.ts` (12: enable/sort persistence round-trips through real `registerOverridesNamespace` over a stub settings register; import recast; builtin-id collision contract; export wire format).

## Verification
- `npx vitest run` → **51 files / 385 tests, all pass** (was ~370 before Task 7; +19 net).
- `npm run build` → exit 0.

## Deltas / adaptations (recorded)
1. `tests/plugin/profile-list.test.ts` — **unmodified**: existing assertions count/filter-based; merged read preserves counts and the target-derivation results (56 total / 10 h3 / 13 danbooru). Ordering is now sort-based but no assertion pinned old order.
2. `tests/plugin/registry.test.ts` — adapted: settings stub asserted the single namespace name; now accepts both `prompt-master-custom-profiles` and `prompt-master-profile-overrides`.
3. `z.dict` argument order corrected vs brief sketch: signature is `dict(value, keyPattern)`, so `z.dict(z.object({enabled, sort}))` (brief's `z.dict(z.string(), z.object(...))` fails tsc).
4. Brief used `ctx.settings.register('string-name', …)`; implementation uses `settingsNamespace('prompt-master-profile-overrides')` matching plugin/index.ts's existing pattern.
5. `overrides` dep is optional (`overrides?`) so pre-existing test call sites without it still work; production wiring always passes it.
6. Import/validate_import failures return JSON `{ ok: false, reason }` reports (matches brief's report-style intent; existing tool style is JSON.stringify, not serializeReport).

## Concerns
- Import contract: a payload carrying a builtin id is **rejected** (`ok:false`, reason says "导入将重铸 id") rather than silently recast — this follows the brief's `validateImportPayload` spec/test. If downstream UX expects auto-recast-on-collision, `import` action would need a one-line change (strip id before validate). Flagging for Task 8 review.
- `sort` action force-sets `enabled: true` per brief pseudocode; a builtin disabled via `enable:false` then re-sorted is re-enabled. Intentional per spec, but worth noting.

## Fix round (review findings 1 & 2) — commit a49ef77

**Finding 1 (search 语义变更记录) — took Option A (document).**
依据：`src/resolver/profiles/index.ts` 的 `searchProfiles(query)` 本身就是小写子串过滤（id/name/description/tags 四字段 `toLowerCase().includes`），没有评分或模糊匹配逻辑；`profile-list.ts` 中内联过滤字段逐一对应相同。语义无损（仅范围从内置全量变为 overrides 过滤后的合并列表，这正是变更的功能理由），故无需恢复调用。已在 `src/tools/profile-list.ts` 内联过滤处加注释：`// 注：search 语义=合并列表的小写子串过滤（原 searchProfiles 的评分排序不适用 overrides 过滤后列表）`。

**Finding 2 (误导性 reason 文案) — fixed.**
`storage-v2.ts` validateImportPayload 内置冲突 reason 改为：`id "X" 与内置冲突：请移除 id 字段后重试（导入时会自动重铸）`。测试无断言旧文案（grep `与内置冲突` 零命中），无需调整。

**Test evidence:**
- 定向：`npx vitest run tests/pe-framework/profiles/storage-v2.test.ts tests/plugin/profile-list.test.ts tests/plugin/profile-list-v2.test.ts` → 3 files, 28/28 passed
- 构建：`npm run build` (tsc) → exit 0
- 全量：`npx vitest run` → 51 files, 385/385 passed
