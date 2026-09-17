# Review package - 672e2a7..ae2e808

## Commits
``````

## Stat
``` .../task-7-report.md                               | 39 ++++++++++++++++++++++
 .../src/pe-framework/profiles/storage-v2.ts        |  2 +-
 plugins/prompt-master/src/tools/profile-list.ts    |  1 +
 3 files changed, 41 insertions(+), 1 deletion(-)
```

## Full diff (-U10)
```diff --git a/.superpowers/sdd/2026-08-31-absorb-implementation/task-7-report.md b/.superpowers/sdd/2026-08-31-absorb-implementation/task-7-report.md
new file mode 100644
index 0000000..4964d31
--- /dev/null
+++ b/.superpowers/sdd/2026-08-31-absorb-implementation/task-7-report.md
@@ -0,0 +1,39 @@
+# Task 7 Report — B5 双层存储 + 导入导出
+
+**Status:** COMPLETE
+**Commit:** `672e2a7` — `feat(prompt-master): two-layer profile storage + import/export with id recast` (6 files, +354/−13)
+
+## Delivered
+- `src/pe-framework/profiles/storage-v2.ts` (new): `BuiltinOverride`/`OverridesApi`, `registerOverridesNamespace(ctx)` (settings namespace `prompt-master-profile-overrides`, z.dict value-first per schemastery signature), `listProfilesMerged`, `validateImportPayload`, `recastImportedProfile`. PEProfile has `builtin`, `createdAt?`, `updatedAt?` → recast sets all (compile-gated). Pure module, no logging.
+- `src/tools/profile-list.ts`: list/search now merged via `listProfilesMerged(builtins, customs, overrides.all())` (split by `builtin` flag from `getDefaultBuiltinProfiles()`), then kind/target/query filters; new actions `enable` / `sort` / `export` / `import` / `validate_import`; deps gained optional `overrides`. Existing save/delete/get semantics untouched.
+- `src/plugin/index.ts`: `const overrides = registerOverridesNamespace(ctx)` passed into `registerProfileListTool(ctx, config, { scope, overrides })`.
+- Tests: `tests/pe-framework/profiles/storage-v2.test.ts` (9, brief Step 1 verbatim), `tests/plugin/profile-list-v2.test.ts` (12: enable/sort persistence round-trips through real `registerOverridesNamespace` over a stub settings register; import recast; builtin-id collision contract; export wire format).
+
+## Verification
+- `npx vitest run` → **51 files / 385 tests, all pass** (was ~370 before Task 7; +19 net).
+- `npm run build` → exit 0.
+
+## Deltas / adaptations (recorded)
+1. `tests/plugin/profile-list.test.ts` — **unmodified**: existing assertions count/filter-based; merged read preserves counts and the target-derivation results (56 total / 10 h3 / 13 danbooru). Ordering is now sort-based but no assertion pinned old order.
+2. `tests/plugin/registry.test.ts` — adapted: settings stub asserted the single namespace name; now accepts both `prompt-master-custom-profiles` and `prompt-master-profile-overrides`.
+3. `z.dict` argument order corrected vs brief sketch: signature is `dict(value, keyPattern)`, so `z.dict(z.object({enabled, sort}))` (brief's `z.dict(z.string(), z.object(...))` fails tsc).
+4. Brief used `ctx.settings.register('string-name', …)`; implementation uses `settingsNamespace('prompt-master-profile-overrides')` matching plugin/index.ts's existing pattern.
+5. `overrides` dep is optional (`overrides?`) so pre-existing test call sites without it still work; production wiring always passes it.
+6. Import/validate_import failures return JSON `{ ok: false, reason }` reports (matches brief's report-style intent; existing tool style is JSON.stringify, not serializeReport).
+
+## Concerns
+- Import contract: a payload carrying a builtin id is **rejected** (`ok:false`, reason says "导入将重铸 id") rather than silently recast — this follows the brief's `validateImportPayload` spec/test. If downstream UX expects auto-recast-on-collision, `import` action would need a one-line change (strip id before validate). Flagging for Task 8 review.
+- `sort` action force-sets `enabled: true` per brief pseudocode; a builtin disabled via `enable:false` then re-sorted is re-enabled. Intentional per spec, but worth noting.
+
+## Fix round (review findings 1 & 2) — commit a49ef77
+
+**Finding 1 (search 语义变更记录) — took Option A (document).**
+依据：`src/resolver/profiles/index.ts` 的 `searchProfiles(query)` 本身就是小写子串过滤（id/name/description/tags 四字段 `toLowerCase().includes`），没有评分或模糊匹配逻辑；`profile-list.ts` 中内联过滤字段逐一对应相同。语义无损（仅范围从内置全量变为 overrides 过滤后的合并列表，这正是变更的功能理由），故无需恢复调用。已在 `src/tools/profile-list.ts` 内联过滤处加注释：`// 注：search 语义=合并列表的小写子串过滤（原 searchProfiles 的评分排序不适用 overrides 过滤后列表）`。
+
+**Finding 2 (误导性 reason 文案) — fixed.**
+`storage-v2.ts` validateImportPayload 内置冲突 reason 改为：`id "X" 与内置冲突：请移除 id 字段后重试（导入时会自动重铸）`。测试无断言旧文案（grep `与内置冲突` 零命中），无需调整。
+
+**Test evidence:**
+- 定向：`npx vitest run tests/pe-framework/profiles/storage-v2.test.ts tests/plugin/profile-list.test.ts tests/plugin/profile-list-v2.test.ts` → 3 files, 28/28 passed
+- 构建：`npm run build` (tsc) → exit 0
+- 全量：`npx vitest run` → 51 files, 385/385 passed
diff --git a/plugins/prompt-master/src/pe-framework/profiles/storage-v2.ts b/plugins/prompt-master/src/pe-framework/profiles/storage-v2.ts
index 3b5f320..81900b7 100644
--- a/plugins/prompt-master/src/pe-framework/profiles/storage-v2.ts
+++ b/plugins/prompt-master/src/pe-framework/profiles/storage-v2.ts
@@ -52,21 +52,21 @@ export function listProfilesMerged<T extends { id: string; sort?: number }>(
   out.push(...custom)
   return out.sort((x, y) => (x.sort ?? 999) - (y.sort ?? 999) || String(x.id).localeCompare(String(y.id)))
 }
 
 const IMPORT_KINDS = new Set(['expand', 'reverse', 'train'])
 
 export function validateImportPayload(payload: unknown, builtinIds: string[]): { ok: true; profile: Record<string, unknown> } | { ok: false; reason: string } {
   if (typeof payload !== 'object' || payload === null) return { ok: false, reason: 'payload 需为对象' }
   const p = payload as Record<string, unknown>
   const builtinIdsSet = new Set(builtinIds)
-  if (typeof p['id'] === 'string' && builtinIdsSet.has(p['id'])) return { ok: false, reason: `id "${p['id']}" 与内置冲突，导入将重铸 id` }
+  if (typeof p['id'] === 'string' && builtinIdsSet.has(p['id'])) return { ok: false, reason: `id "${p['id']}" 与内置冲突：请移除 id 字段后重试（导入时会自动重铸）` }
   if (typeof p['name'] !== 'string' || !(p['name'] as string).trim()) return { ok: false, reason: 'name 必填' }
   if (typeof p['kind'] !== 'string' || !IMPORT_KINDS.has(p['kind'])) return { ok: false, reason: `kind 需为 expand|reverse|train，得到 ${String(p['kind'])}` }
   if (typeof p['systemPrompt'] !== 'string' || !(p['systemPrompt'] as string).trim()) return { ok: false, reason: 'systemPrompt 必填' }
   return { ok: true, profile: p }
 }
 
 /** 导入重铸：id → pe_custom_+uuid，强制 builtin:false，时间戳重置（PEProfile.createdAt/updatedAt 存在，编译门通过）。 */
 export function recastImportedProfile(profile: Record<string, unknown>): Record<string, unknown> {
   const now = Date.now()
   return { ...profile, id: `pe_custom_${randomUUID()}`, builtin: false, createdAt: now, updatedAt: now }
diff --git a/plugins/prompt-master/src/tools/profile-list.ts b/plugins/prompt-master/src/tools/profile-list.ts
index 05a7545..a18b53e 100644
--- a/plugins/prompt-master/src/tools/profile-list.ts
+++ b/plugins/prompt-master/src/tools/profile-list.ts
@@ -60,20 +60,21 @@ export function registerProfileListTool(_ctx: Context, _config: Config, deps: {
         if (kind) {
           const k = kind
           profiles = profiles.filter((p) => {
             if (k === 'minimax') return !!p.minimaxScenarioId
             return p.kind === k
           })
         }
         if (target) profiles = profiles.filter((p) => profileTargets(p).includes(target as ProfileTarget))
         if (query) {
           const q = query.toLowerCase()
+          // 注：search 语义=合并列表的小写子串过滤（原 searchProfiles 的评分排序不适用 overrides 过滤后列表）
           profiles = profiles.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)))
         }
         return JSON.stringify({
           profiles: profiles.map((p) => ({ id: p.id, name: p.name, category: p.category, description: p.description, kind: p.kind, outputFormat: p.outputFormat, tags: p.tags, target: profileTargets(p)[0] ?? undefined })),
           taxonomy: getTaxonomyMeta(),
         })
       }
       if (action === 'get') {
         const id = String(args.id || '').trim()
         if (!id) throw new Error('id is required for get action')
```
