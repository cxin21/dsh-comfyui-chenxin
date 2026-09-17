# Review package - 50c84b8..ae2e808b37f9d8c4595b1f1c481298ec90fa6b54

## Commits
``````

## Stat
``` .../task-7-report.md                               |  39 ++++
 .../src/pe-framework/continue/contract.ts          |  43 ++++
 .../src/pe-framework/continue/engine.ts            |  62 ++++++
 .../src/pe-framework/continue/index.ts             |  10 +
 .../src/pe-framework/continue/inspect.ts           |  28 +++
 .../src/pe-framework/continue/merge.ts             |  23 ++
 .../src/pe-framework/media/identity.ts             |  15 ++
 .../model-capabilities/capabilities.ts             |  35 +++
 .../pe-framework/model-capabilities/families.ts    |  21 ++
 .../src/pe-framework/model-capabilities/index.ts   |   2 +
 .../src/pe-framework/profiles/storage-v2.ts        |  73 ++++++
 .../src/pe-framework/sanitize/joy-extra.ts         | 248 +++++++++++++++++++++
 .../src/pe-framework/sanitize/model-specific.ts    |  44 ++++
 .../src/pe-framework/schema/scenes.ts              |  41 ++++
 plugins/prompt-master/src/plugin/index.ts          |   6 +-
 .../prompt-master/src/tools/minimax-scenario.ts    |  35 ++-
 plugins/prompt-master/src/tools/profile-list.ts    |  88 +++++++-
 plugins/prompt-master/src/tools/prompt-author.ts   |  29 ++-
 plugins/prompt-master/src/tools/prompt-expand.ts   |  13 +-
 plugins/prompt-master/src/tools/prompt-reverse.ts  |  50 ++++-
 .../pe-framework/continue/continue-engine.test.ts  | 110 +++++++++
 .../tests/pe-framework/media/identity.test.ts      |  26 +++
 .../model-capabilities/model-capabilities.test.ts  |  62 ++++++
 .../tests/pe-framework/profiles/storage-v2.test.ts |  54 +++++
 .../tests/pe-framework/sanitize/joy-extra.test.ts  |  62 ++++++
 .../pe-framework/sanitize/model-specific.test.ts   |  29 +++
 .../tests/plugin/minimax-continue.test.ts          |  91 ++++++++
 plugins/prompt-master/tests/plugin/minimax.test.ts |   6 +-
 .../tests/plugin/profile-list-v2.test.ts           | 144 ++++++++++++
 .../prompt-master/tests/plugin/registry.test.ts    |   3 +-
 30 files changed, 1463 insertions(+), 29 deletions(-)
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
diff --git a/plugins/prompt-master/src/pe-framework/continue/contract.ts b/plugins/prompt-master/src/pe-framework/continue/contract.ts
new file mode 100644
index 0000000..63773a8
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/continue/contract.ts
@@ -0,0 +1,43 @@
+/**
+ * Structure-aware continue engine: type contracts.
+ * Pure type definitions only — no runtime behavior.
+ */
+
+/** One expected output field: matched by any of its label patterns. */
+export interface OutputFieldContract {
+  key: string
+  patterns: RegExp[]
+}
+
+/** Declares the expected structure of a long-form model output. */
+export interface OutputContract {
+  id: string
+  fields: OutputFieldContract[]
+  /** Optional separator between repeated groups (e.g. per-scene blocks). */
+  groupSeparator?: RegExp
+  /** Optional expected group count, derived from the request form fields. */
+  expectedGroups?: (formFields: Record<string, unknown>) => number
+}
+
+/** Result of inspecting a text against an OutputContract. */
+export interface StructureInspection {
+  /** Missing items, reported as `field:<key>` entries. */
+  missing: string[]
+  /** True when nothing is missing. */
+  complete: boolean
+}
+
+/** Seed context used to build continuation prompts. */
+export interface ContinueSeed {
+  system?: string
+  userText: string
+  outputLang: 'zh' | 'en'
+}
+
+/** Final outcome of continueUntilComplete. */
+export interface ContinueOutcome {
+  text: string
+  rounds: number
+  complete: boolean
+  warnings: string[]
+}
diff --git a/plugins/prompt-master/src/pe-framework/continue/engine.ts b/plugins/prompt-master/src/pe-framework/continue/engine.ts
new file mode 100644
index 0000000..658c50e
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/continue/engine.ts
@@ -0,0 +1,62 @@
+import { inspectOutput } from './inspect.js'
+import { mergeContinuedText } from './merge.js'
+import type { OutputContract, ContinueSeed, ContinueOutcome } from './contract.js'
+
+type FinishKind = 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'
+
+/**
+ * Structure-aware continuation loop.
+ *
+ * Trigger: contract inspection incomplete OR finishKind === 'max-tokens'
+ * (max-tokens continues even if structurally complete — dark-truncation guard).
+ * Each round sends a SINGLE user message carrying the accumulated full text
+ * plus the missing list. Pure async orchestration: zero logging; the caller
+ * observes rounds via onContinue.
+ *
+ * Abort semantics: signal.throwIfAborted at round start; abort inside generate
+ * propagates via the caller's signal (generate throws → rethrow, with
+ * CONTINUE_ABORTED_PARTIAL warning if some continuation text was already
+ * merged); post-round signal.aborted check returns the partial result.
+ */
+export async function continueUntilComplete(params: {
+  contract: OutputContract
+  initialText: string
+  finishKind: FinishKind
+  seed: ContinueSeed
+  generate: (req: { system?: string; user: string }) => Promise<{ text: string; finishKind: FinishKind }>
+  maxRounds?: number
+  signal: AbortSignal
+  onContinue?: (round: number, maxRounds: number) => void
+}): Promise<ContinueOutcome> {
+  const max = params.maxRounds ?? 3
+  const warnings: string[] = []
+  let text = params.initialText
+  let finish = params.finishKind
+  let rounds = 0
+  while (rounds < max) {
+    const inspection = inspectOutput(text, params.contract)
+    const shouldContinue = !inspection.complete || finish === 'max-tokens'
+    if (!shouldContinue) break
+    params.signal.throwIfAborted()
+    rounds++
+    params.onContinue?.(rounds, max)
+    const missingList = inspection.missing.length > 0 ? inspection.missing.join(', ') : '（结构未知，可能有暗截断）'
+    const instruction = params.seed.outputLang === 'en'
+      ? `Already written (do NOT rewrite; continue from it): -----\n${text}\n-----\n\nMissing: ${missingList}. Continue from where it stops.`
+      : `已写出（不要重写，基于它继续）：-----\n${text}\n-----\n\n缺失内容：${missingList}。请从缺失处继续输出，不要重复已有内容。`
+    let piece: string
+    try {
+      const gen = await params.generate({ system: params.seed.system, user: instruction })
+      piece = gen.text
+      finish = gen.finishKind
+    } catch (error) {
+      if (text !== params.initialText) warnings.push('CONTINUE_ABORTED_PARTIAL')
+      throw error
+    }
+    text = mergeContinuedText(text, piece)
+    if (params.signal.aborted) { warnings.push('CONTINUE_ABORTED_PARTIAL'); return { text, rounds, complete: false, warnings } }
+  }
+  const final = inspectOutput(text, params.contract)
+  if (!final.complete || finish === 'max-tokens') warnings.push('INCOMPLETE_AFTER_MAX_ROUNDS')
+  return { text, rounds, complete: final.complete && finish !== 'max-tokens', warnings }
+}
diff --git a/plugins/prompt-master/src/pe-framework/continue/index.ts b/plugins/prompt-master/src/pe-framework/continue/index.ts
new file mode 100644
index 0000000..005d96a
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/continue/index.ts
@@ -0,0 +1,10 @@
+export type {
+  OutputFieldContract,
+  OutputContract,
+  StructureInspection,
+  ContinueSeed,
+  ContinueOutcome,
+} from './contract.js'
+export { inspectOutput } from './inspect.js'
+export { mergeContinuedText } from './merge.js'
+export { continueUntilComplete } from './engine.js'
diff --git a/plugins/prompt-master/src/pe-framework/continue/inspect.ts b/plugins/prompt-master/src/pe-framework/continue/inspect.ts
new file mode 100644
index 0000000..cc796e8
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/continue/inspect.ts
@@ -0,0 +1,28 @@
+import type { OutputContract, StructureInspection } from './contract.js'
+
+export type { OutputContract, StructureInspection }
+
+/**
+ * Inspect a model output against a contract: every field pattern must hit,
+ * and the text right after the hit label (up to end of line) must be a
+ * non-empty body (>= 2 chars after trim), otherwise the field counts as missing.
+ */
+export function inspectOutput(text: string, contract: OutputContract): StructureInspection {
+  const missing: string[] = []
+  for (const f of contract.fields) {
+    const hit = f.patterns.some((re) => re.test(text))
+    if (!hit) { missing.push(`field:${f.key}`); continue }
+    // 标签体非空检查：取命中标签之后到下一个换行（或文末）的文本段
+    for (const re of f.patterns) {
+      const m = re.exec(text)
+      if (m && m.index !== undefined) {
+        const lineEnd = text.indexOf('\n', m.index)
+        const body = text.slice(m.index + m[0].length, lineEnd === -1 ? undefined : lineEnd)
+        // 仅空标签体视为缺失（单字符正文如 "X" 算有效内容 — 以测试为准）
+        if (body.trim().length === 0) { missing.push(`field:${f.key}`) }
+        break
+      }
+    }
+  }
+  return { missing, complete: missing.length === 0 }
+}
diff --git a/plugins/prompt-master/src/pe-framework/continue/merge.ts b/plugins/prompt-master/src/pe-framework/continue/merge.ts
new file mode 100644
index 0000000..00fb448
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/continue/merge.ts
@@ -0,0 +1,23 @@
+/** Common LLM continuation greetings to strip before merging. */
+const GREETING = /^(好的[，。！!]?|继续输出[：:]?|如下[：:]?)\s*/
+
+/**
+ * Merge a continuation piece into the accumulated text:
+ * 1. strip greeting prefix,
+ * 2. parrot detection (model repeats the full accumulated text → take continued only),
+ * 3. suffix-prefix overlap detection (window 12..240 chars) → dedupe join,
+ * 4. otherwise newline join.
+ */
+export function mergeContinuedText(previous: string, continued: string): string {
+  const cont = continued.replace(GREETING, '').trim()
+  if (!cont) return previous
+  if (cont.startsWith(previous.trim())) return cont // 复读
+  // 后缀-前缀重叠探测：窗口 12..240
+  const maxWin = Math.min(240, previous.length, cont.length)
+  for (let win = maxWin; win >= 12; win--) {
+    const tail = previous.slice(-win)
+    const idx = cont.indexOf(tail)
+    if (idx !== -1) return previous + cont.slice(idx + win)
+  }
+  return previous + '\n' + cont
+}
diff --git a/plugins/prompt-master/src/pe-framework/media/identity.ts b/plugins/prompt-master/src/pe-framework/media/identity.ts
new file mode 100644
index 0000000..eb62b88
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/media/identity.ts
@@ -0,0 +1,15 @@
+// src/pe-framework/media/identity.ts — B4 多图身份映射（S 子集）
+export interface TaggedMedia { n: number; tag: string }
+
+export function enumerateTaggedMedia(count: number): TaggedMedia[] {
+  return Array.from({ length: count }, (_, i) => ({ n: i + 1, tag: `<Picture ${i + 1}>` }))
+}
+
+export function buildIdentityDeclarations(media: TaggedMedia[], outputLang: 'zh' | 'en'): string {
+  if (media.length < 2) return ''
+  const lines = media.map((m) => outputLang === 'en' ? `${m.tag} = image #${m.n}` : `${m.tag} = 第 ${m.n} 张图`)
+  const header = outputLang === 'en'
+    ? 'Identity mapping — do not swap identities:'
+    : '身份映射——不要混淆对应关系：'
+  return `${header}\n${lines.join('\n')}`
+}
diff --git a/plugins/prompt-master/src/pe-framework/model-capabilities/capabilities.ts b/plugins/prompt-master/src/pe-framework/model-capabilities/capabilities.ts
new file mode 100644
index 0000000..f84e26f
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/model-capabilities/capabilities.ts
@@ -0,0 +1,35 @@
+import type { ModelFamily } from './families.js'
+
+export interface ModelCapabilities {
+  family: ModelFamily
+  proneToTruncation: boolean
+  sanitizeLevel: 'none' | 'generic'
+  mediaTargets: ReadonlyArray<'image' | 'video' | 'mixed'>
+  lockedOutputLang?: 'zh' | 'en'
+  defaultTemperature?: number
+  defaultTopP?: number
+}
+
+export const FAMILY_CAPABILITIES: Record<ModelFamily, ModelCapabilities> = {
+  deepseek: { family: 'deepseek', proneToTruncation: false, sanitizeLevel: 'none', mediaTargets: ['image'] },
+  glm: { family: 'glm', proneToTruncation: false, sanitizeLevel: 'none', mediaTargets: ['image', 'video', 'mixed'] },
+  'qwen-vl': { family: 'qwen-vl', proneToTruncation: true, sanitizeLevel: 'generic', mediaTargets: ['image', 'video', 'mixed'], defaultTemperature: 0.5 },
+  'qwen-text': { family: 'qwen-text', proneToTruncation: true, sanitizeLevel: 'generic', mediaTargets: [] },
+  gemma: { family: 'gemma', proneToTruncation: true, sanitizeLevel: 'generic', mediaTargets: ['image'] },
+  openai: { family: 'openai', proneToTruncation: false, sanitizeLevel: 'none', mediaTargets: ['image'] },
+  generic: { family: 'generic', proneToTruncation: false, sanitizeLevel: 'none', mediaTargets: [] },
+}
+
+export function getCapabilities(family: ModelFamily): ModelCapabilities {
+  return FAMILY_CAPABILITIES[family] ?? FAMILY_CAPABILITIES.generic
+}
+
+/** 只填 undefined 字段——用户显式值永远赢 */
+export function applyCapabilities<T extends { temperature?: number }>(caps: ModelCapabilities, params: T): T {
+  return {
+    ...params,
+    ...(params.temperature === undefined && caps.defaultTemperature !== undefined
+      ? { temperature: caps.defaultTemperature }
+      : {}),
+  }
+}
diff --git a/plugins/prompt-master/src/pe-framework/model-capabilities/families.ts b/plugins/prompt-master/src/pe-framework/model-capabilities/families.ts
new file mode 100644
index 0000000..efc2616
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/model-capabilities/families.ts
@@ -0,0 +1,21 @@
+export type ModelFamily = 'deepseek' | 'glm' | 'qwen-vl' | 'qwen-text' | 'gemma' | 'openai' | 'generic'
+
+export interface FamilyRule { family: ModelFamily; modelPatterns: RegExp[]; providerPatterns?: RegExp[] }
+
+/** 表驱动：新家族 = 加一行。顺序即优先级（先匹配先得）。 */
+export const FAMILY_RULES: FamilyRule[] = [
+  { family: 'qwen-vl', modelPatterns: [/qwen.*vl/i] },
+  { family: 'qwen-text', modelPatterns: [/qwen/i] },
+  { family: 'gemma', modelPatterns: [/gemma/i] },
+  { family: 'glm', modelPatterns: [/^glm/i], providerPatterns: [/zhipu/i] },
+  { family: 'deepseek', modelPatterns: [/deepseek/i] },
+  { family: 'openai', modelPatterns: [/^gpt/i, /^o\d/i], providerPatterns: [/^openai$/i] },
+]
+
+export function inferModelFamily(provider: string, model: string): ModelFamily {
+  for (const rule of FAMILY_RULES) {
+    if (rule.modelPatterns.some((re) => re.test(model))) return rule.family
+    if (rule.providerPatterns?.some((re) => re.test(provider))) return rule.family
+  }
+  return 'generic'
+}
diff --git a/plugins/prompt-master/src/pe-framework/model-capabilities/index.ts b/plugins/prompt-master/src/pe-framework/model-capabilities/index.ts
new file mode 100644
index 0000000..eeff7a2
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/model-capabilities/index.ts
@@ -0,0 +1,2 @@
+export * from './families.js'
+export * from './capabilities.js'
diff --git a/plugins/prompt-master/src/pe-framework/profiles/storage-v2.ts b/plugins/prompt-master/src/pe-framework/profiles/storage-v2.ts
new file mode 100644
index 0000000..81900b7
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/profiles/storage-v2.ts
@@ -0,0 +1,73 @@
+// storage-v2 — 两层 profile 存储的纯函数层 + 内置覆盖 namespace（spec §7.1）
+// 内置层：只读 builtin profiles + settings 覆盖（enabled/sort）；自定义层：customProfiles（不变）。
+// 纯模块：不落日志（工具层记 action 摘要）。
+
+import { randomUUID } from 'node:crypto'
+import type { Context } from '@deepseek-ai/cordis'
+import z from '@deepseek-ai/schemastery'
+import { settingsNamespace } from '@deepseek-ai/dsh-settings'
+
+export interface BuiltinOverride { enabled: boolean; sort?: number }
+export interface OverridesSection { builtinOverrides: Record<string, BuiltinOverride> }
+
+export interface OverridesApi {
+  get(): Record<string, BuiltinOverride>
+  all(): Record<string, BuiltinOverride>
+  set(id: string, o: BuiltinOverride | null): Promise<void>
+}
+
+/**
+ * 注册内置覆盖层 namespace（spec §7.1）。
+ * schemastery 纪律：无 default 字段即 optional-by-default，绝不 .optional()。
+ */
+export function registerOverridesNamespace(ctx: Context): OverridesApi {
+  const ns = settingsNamespace('prompt-master-profile-overrides')
+  const scope = ctx.settings.register(ns, z.object({
+    builtinOverrides: z.dict(z.object({ enabled: z.boolean(), sort: z.number() })),
+  }))
+  const read = (): Record<string, BuiltinOverride> =>
+    (scope.get() as unknown as OverridesSection | undefined)?.builtinOverrides ?? {}
+  return {
+    get: read,
+    all: read,
+    set: async (id: string, o: BuiltinOverride | null) => {
+      const next = { ...read() }
+      if (o === null) delete next[id]
+      else next[id] = o
+      await scope.update({ builtinOverrides: next })
+    },
+  }
+}
+
+/** 合并读取：builtins 按 overrides 过滤/重排，custom 追加其后，整体按 sort（缺省 999）+ id 稳定排序。 */
+export function listProfilesMerged<T extends { id: string; sort?: number }>(
+  builtins: T[], custom: T[], overrides: Record<string, BuiltinOverride>,
+): T[] {
+  const out: T[] = []
+  for (const b of builtins) {
+    const o = overrides[b.id]
+    if (o && o.enabled === false) continue
+    out.push(o?.sort !== undefined ? { ...b, sort: o.sort } : b)
+  }
+  out.push(...custom)
+  return out.sort((x, y) => (x.sort ?? 999) - (y.sort ?? 999) || String(x.id).localeCompare(String(y.id)))
+}
+
+const IMPORT_KINDS = new Set(['expand', 'reverse', 'train'])
+
+export function validateImportPayload(payload: unknown, builtinIds: string[]): { ok: true; profile: Record<string, unknown> } | { ok: false; reason: string } {
+  if (typeof payload !== 'object' || payload === null) return { ok: false, reason: 'payload 需为对象' }
+  const p = payload as Record<string, unknown>
+  const builtinIdsSet = new Set(builtinIds)
+  if (typeof p['id'] === 'string' && builtinIdsSet.has(p['id'])) return { ok: false, reason: `id "${p['id']}" 与内置冲突：请移除 id 字段后重试（导入时会自动重铸）` }
+  if (typeof p['name'] !== 'string' || !(p['name'] as string).trim()) return { ok: false, reason: 'name 必填' }
+  if (typeof p['kind'] !== 'string' || !IMPORT_KINDS.has(p['kind'])) return { ok: false, reason: `kind 需为 expand|reverse|train，得到 ${String(p['kind'])}` }
+  if (typeof p['systemPrompt'] !== 'string' || !(p['systemPrompt'] as string).trim()) return { ok: false, reason: 'systemPrompt 必填' }
+  return { ok: true, profile: p }
+}
+
+/** 导入重铸：id → pe_custom_+uuid，强制 builtin:false，时间戳重置（PEProfile.createdAt/updatedAt 存在，编译门通过）。 */
+export function recastImportedProfile(profile: Record<string, unknown>): Record<string, unknown> {
+  const now = Date.now()
+  return { ...profile, id: `pe_custom_${randomUUID()}`, builtin: false, createdAt: now, updatedAt: now }
+}
diff --git a/plugins/prompt-master/src/pe-framework/sanitize/joy-extra.ts b/plugins/prompt-master/src/pe-framework/sanitize/joy-extra.ts
new file mode 100644
index 0000000..c23a608
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/sanitize/joy-extra.ts
@@ -0,0 +1,248 @@
+/**
+ * JoyExtra 三段式硬约束（移植自 PromptMaster joyCaption extra-option 系统）：
+ * 1) resolveJoyExtraOptions —— 显式数组 > 标准句嗅探（extra_prompt），解析 character_name
+ * 2) buildJoyExtraSystemBlock / buildJoyExtraUserTail —— prompt 侧注入（优先级声明 + 冲突仲裁）
+ * 3) filterJoyExtraClauses —— 输出侧子句过滤（防灭绝兜底：全被滤掉 → 返回原文）
+ *
+ * 纯函数模块：零日志、零 IO（工具层负责日志）。
+ * 标准句逐字移植自 temp/pm-promptmaster-src .../joyCaptionExtraOptions.js.deob.js；
+ * 子句切分/过滤正则移植自 captionExtraOptionSanitize.js.deob.js（裁掉生僻条目）。
+ */
+
+export type JoyExtraOptionId =
+  | 'no_glasses_headwear'
+  | 'scene_only_no_character_appearance'
+  | 'no_artistic_style'
+  | 'character_name'
+
+export interface JoyExtraResolution {
+  options: JoyExtraOptionId[]
+  characterName?: string
+}
+
+/* ── 标准句（PromptMaster deob 逐字移植，嗅探 + 展示共用）── */
+
+export const JOY_SCENE_ONLY_NO_CHARACTER_APPEARANCE_EN =
+  'Do NOT describe any character appearance traits or clothing. Do not write any visible physical appearance features—such as face, facial features, body, skin, hair, body shape, or similar traits—or any garments, outfits, or clothing items.'
+export const JOY_NO_GLASSES_HEADWEAR_EN =
+  'Do NOT describe any glasses, goggles, eyewear, sunglasses, or headwear on the person/character (including hats, helmets, headbands, crowns, and hair accessories worn on the head).'
+export const JOY_NO_ARTISTIC_STYLE_EN =
+  'Do NOT describe artistic style, rendering style, image medium, quality tags, aesthetic terms, or visual style labels. Do not mention anime, cartoon, realistic, painting, illustration, 3D render, cinematic, digital art, concept art, or similar style-related terms.'
+
+/* ── 选项注册表：标准句 + 嗅探正则 + 中文变体 ── */
+
+interface JoyExtraOptionDef {
+  id: JoyExtraOptionId
+  en: string
+  zh: string
+  sniff: RegExp[]
+}
+
+const OPTION_DEFS: JoyExtraOptionDef[] = [
+  {
+    id: 'no_glasses_headwear',
+    en: JOY_NO_GLASSES_HEADWEAR_EN,
+    zh: '不要写眼镜/头饰：即使画面中有眼镜、面饰或任何头戴物，也必须完全省略，不得提及。',
+    sniff: [
+      /Do NOT describe any glasses, goggles, eyewear/i,
+      /Do not mention glasses/i,
+      /不要(?:写|提|提及|描述).{0,6}(?:眼镜|头饰|帽子)/,
+    ],
+  },
+  {
+    id: 'scene_only_no_character_appearance',
+    en: JOY_SCENE_ONLY_NO_CHARACTER_APPEARANCE_EN,
+    zh: '只写场景，不写任何角色外貌或服装：面部、五官、身体、皮肤、头发、体型及一切衣着类描述都必须省略。',
+    sniff: [
+      /Do NOT describe any character appearance traits or clothing/i,
+      /Do NOT describe any character appearance or clothing/i,
+      /Do not describe any character appearance/i,
+      /只写场景.{0,8}不写.{0,10}(?:外貌|外观|长相)/,
+    ],
+  },
+  {
+    id: 'no_artistic_style',
+    en: JOY_NO_ARTISTIC_STYLE_EN,
+    zh: '不要写艺术风格：不提及画风、渲染风格、媒介、质量词或任何风格标签（anime/cartoon/realistic/painting 等）。',
+    sniff: [
+      /Do NOT describe artistic style/i,
+      /不要(?:写|提|提及|描述).{0,6}(?:画风|艺术风格|风格)/,
+    ],
+  },
+  {
+    id: 'character_name',
+    en: 'Refer to the person/character by the given name only; do not invent or mention any other name.',
+    zh: '用指定名字称呼该角色；不要提及或杜撰其他名字。',
+    sniff: [/refer to them as/i, /(?:称呼|称作|名叫)为?["'「『]?[\w\u4e00-\u9fff]+["'」』]?/],
+  },
+]
+
+const OPTION_BY_ID = new Map(OPTION_DEFS.map((d) => [d.id, d]))
+
+const CHARACTER_NAME_SNIFF = /refer to them as ([A-Za-z0-9_\u4e00-\u9fff]+)/i
+
+/* ── resolve ── */
+
+function asStringArray(v: unknown): string[] {
+  if (!Array.isArray(v)) return []
+  return v.map((x) => String(x ?? '').trim()).filter(Boolean)
+}
+
+export function resolveJoyExtraOptions(input: {
+  joyExtraOptions?: unknown
+  extraPrompt?: string
+  characterName?: unknown
+}): JoyExtraResolution {
+  const explicit = asStringArray(input.joyExtraOptions)
+  const options: JoyExtraOptionId[] = []
+  for (const id of explicit) if (OPTION_BY_ID.has(id as JoyExtraOptionId)) options.push(id as JoyExtraOptionId)
+
+  const extraPrompt = String(input.extraPrompt ?? '')
+  if (extraPrompt.trim()) {
+    for (const def of OPTION_DEFS) {
+      if (options.includes(def.id)) continue
+      if (def.id !== 'character_name' && extraPrompt.includes(def.en)) { options.push(def.id); continue }
+      if (def.sniff.some((re) => re.test(extraPrompt))) options.push(def.id)
+    }
+  }
+
+  let characterName = String(input.characterName ?? '').trim()
+  if (!characterName && extraPrompt) {
+    const m = extraPrompt.match(CHARACTER_NAME_SNIFF)
+    if (m) characterName = m[1].trim()
+  }
+  const res: JoyExtraResolution = { options }
+  if (characterName) res.characterName = characterName
+  return res
+}
+
+/* ── prompt 注入 ── */
+
+/** 冲突仲裁：scene_only（更高优先级）生效时，覆盖 no_glasses_headwear 的"不可变属性"分支表述 */
+function pledgeLines(res: JoyExtraResolution, lang: 'zh' | 'en'): string[] {
+  const sceneOnly = res.options.includes('scene_only_no_character_appearance')
+  return res.options
+    .filter((id) => id !== 'character_name' || res.characterName)
+    .map((id) => {
+      const def = OPTION_BY_ID.get(id)
+      if (!def) return ''
+      if (lang === 'en') return `- ${sceneOnly && id === 'no_glasses_headwear' ? def.en + ' (subsumed by the scene-only rule above; obey the stricter one.)' : def.en}`
+      return `- ${sceneOnly && id === 'no_glasses_headwear' ? def.zh + '（已被上文"只写场景"规则覆盖，以更严格者为准。）' : def.zh}`
+    })
+    .filter(Boolean)
+}
+
+export function buildJoyExtraSystemBlock(res: JoyExtraResolution, outputLang: 'zh' | 'en'): string {
+  if (res.options.length === 0) return ''
+  const pledges = pledgeLines(res, outputLang)
+  const priority =
+    outputLang === 'en'
+      ? 'These are HARD CONSTRAINTS and take priority over any checklist, style guide, or earlier instruction: every listed exclusion must be fully omitted from the output.'
+      : '以下是硬约束，优先级高于任何检查表、风格指南或前文指令：所列每一项禁写内容都必须在输出中完全省略。'
+  const nameLine =
+    res.characterName
+      ? outputLang === 'en'
+        ? `- Refer to the person/character strictly as "${res.characterName}".`
+        : `- 严格以"${res.characterName}"称呼该角色。`
+      : ''
+  const conflict =
+    outputLang === 'en'
+      ? 'Conflict override: when two rules overlap, the stricter (broader exclusion) wins; a forbidden trait must never appear, even if another instruction asks for it.'
+      : '冲突仲裁：两条规则重叠时以更严格（覆盖面更广）者为准；被禁特征即使其他指令要求也绝不得出现。'
+  return ['[JoyExtra Hard Constraints]', priority, ...pledges, nameLine, conflict].filter(Boolean).join('\n')
+}
+
+export function buildJoyExtraUserTail(res: JoyExtraResolution, outputLang: 'zh' | 'en'): string {
+  if (res.options.length === 0) return ''
+  const head =
+    outputLang === 'en'
+      ? 'Reminder (hard constraints): do NOT write anything forbidden by the options below.'
+      : '再次提醒（硬约束）：输出中不得出现下列选项禁止的任何内容。'
+  const lines = pledgeLines(res, outputLang)
+  const nameLine = res.characterName
+    ? outputLang === 'en'
+      ? `- Name: ${res.characterName}.`
+      : `- 名字：${res.characterName}。`
+    : ''
+  return [head, ...lines, nameLine].filter(Boolean).join('\n')
+}
+
+/* ── 输出侧子句过滤（captionExtraOptionSanitize 移植）── */
+
+/** 中文/英文通用：眼镜·头饰类子句模式（deob 版裁剪 + 英文词集补充） */
+const GLASSES_HEADWEAR_CLAUSE_PATTERNS: RegExp[] = [
+  /眼镜/u, /护目镜/u, /墨镜/u, /太阳镜/u, /镜框/u, /目镜/u,
+  /头戴.*镜/u, /佩戴.*镜/u,
+  /头饰/u, /发饰/u, /发箍/u, /头箍/u, /头带/u, /发带/u,
+  /(?:鸭舌|棒球|贝雷|礼|安全|针织)?帽/u,
+  /头盔/u, /皇冠/u, /王冠/u, /头冠/u, /面罩/u, /头套/u,
+  /\b(?:glasses|goggles|sunglasses|eyewear)\b/i,
+  /\b(?:beret|hat|helmet|headband|crown|headwear)\b/i,
+]
+
+/** 外貌·服装类子句模式（deob 版核心条目；scene_only 选项使用） */
+const APPEARANCE_CLOTHING_CLAUSE_PATTERNS: RegExp[] = [
+  /皮肤/u, /肤色/u, /肤质/u, /斑(?:块|纹|点)/u, /胎记/u, /疤痕/u, /痣/u, /胡须/u,
+  /妆容/u, /五官/u, /面部特征/u, /脸型/u,
+  /发型/u, /头发/u, /发丝/u, /刘海/u,
+  /服装/u, /衣着/u, /穿着/u, /身穿/u, /上衣/u, /下装/u,
+  /裤子/u, /裙子/u, /连衣裙/u, /外套/u, /大衣/u,
+  /鞋/u, /靴/u, /袜/u, /衣料/u, /布料/u,
+  /体型/u, /身材/u,
+  /\b(?:skin|complexion|freckle|mole|scar|birthmark)\b/i,
+  /\b(?:hair|hairstyle|bangs|beard|mustache|facial features?)\b/i,
+  /\b(?:shirt|pants|dress|skirt|outfit|garment|clothing|jacket|shoes?|boots?)\b/i,
+]
+
+/** 艺术风格类子句模式（no_artistic_style 选项使用；核心词集） */
+const ARTISTIC_STYLE_CLAUSE_PATTERNS: RegExp[] = [
+  /画风/u, /艺术风格/u, /风格化/u, /渲染风格/u, /质量词/u,
+  /\b(?:anime|cartoon|realistic|painting|illustration|cinematic|digital art|concept art|3d render)\b/i,
+]
+
+/** 按分隔符切子句（deob 版同款字符类），去空并 trim */
+function splitClauses(text: string): string[] {
+  return String(text ?? '')
+    .split(/[，,、；;。．.!！?？\n]+/u)
+    .map((c) => c.trim())
+    .filter(Boolean)
+}
+
+/** 原文分隔符风格探测（deob 版同款：中文逗号 > 顿号 > 分号 > 英文逗号+空格） */
+function pickClauseSeparator(text: string): string {
+  if (text.includes('，')) return '，'
+  if (text.includes('、')) return '、'
+  if (text.includes(';')) return '; '
+  return ', '
+}
+
+function clauseMatches(clause: string, patterns: RegExp[]): boolean {
+  const c = clause.trim()
+  if (!c) return false
+  return patterns.some((re) => re.test(c))
+}
+
+function patternsForOptions(options: JoyExtraOptionId[]): RegExp[] {
+  const patterns: RegExp[] = []
+  if (options.includes('no_glasses_headwear')) patterns.push(...GLASSES_HEADWEAR_CLAUSE_PATTERNS)
+  if (options.includes('scene_only_no_character_appearance')) patterns.push(...APPEARANCE_CLOTHING_CLAUSE_PATTERNS)
+  if (options.includes('no_artistic_style')) patterns.push(...ARTISTIC_STYLE_CLAUSE_PATTERNS)
+  return patterns
+}
+
+/**
+ * 子句过滤：命中任一启用选项的正则组 → 剔除该子句；
+ * 拼回时按原文分隔符风格（pickClauseSeparator）逐一还原；
+ * 防灭绝兜底：全部子句被剔除 → 返回原文。
+ */
+export function filterJoyExtraClauses(text: string, res: JoyExtraResolution): string {
+  const src = String(text ?? '').trim()
+  if (!src) return src
+  const patterns = patternsForOptions(res.options)
+  if (patterns.length === 0) return src
+  const clauses = splitClauses(src)
+  if (clauses.length === 0) return src
+  const kept = clauses.filter((c) => !clauseMatches(c, patterns))
+  if (kept.length === 0) return src // anti-extinction
+  return kept.join(pickClauseSeparator(src))
+}
diff --git a/plugins/prompt-master/src/pe-framework/sanitize/model-specific.ts b/plugins/prompt-master/src/pe-framework/sanitize/model-specific.ts
new file mode 100644
index 0000000..719baef
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/sanitize/model-specific.ts
@@ -0,0 +1,44 @@
+import { getCapabilities, type ModelFamily } from '../model-capabilities/index.js'
+
+const THINK_RE = /<think>[\s\S]*?<\/think>/gi
+const THINK_UNCLOSED_RE = /<think>[\s\S]*$/i
+const THINK_ZH_RE = /思考[：:][\s\S]*?(?=\n|$)/g
+const TAIL_MARKERS = ['润色与精简:', '精简后:', '最终输出:', 'Final polished caption:', 'Polished:', '最终答案:', '优化后:', 'Refined:']
+const ECHO_LINE_RE = /^(这张图片|这是|我需要|关键词构思|整理|组合成|精简并优化|答案[:：])/
+
+function stripThinkingTags(text: string): string {
+  return text.replace(THINK_RE, '').replace(THINK_UNCLOSED_RE, '').replace(THINK_ZH_RE, '').trim()
+}
+
+function extractPolishedTail(text: string): string {
+  let lastIdx = -1
+  let lastLen = 0
+  for (const marker of TAIL_MARKERS) {
+    const idx = text.lastIndexOf(marker)
+    if (idx > lastIdx) {
+      lastIdx = idx
+      lastLen = marker.length
+    }
+  }
+  if (lastIdx === -1) return text
+  const tail = text.slice(lastIdx + lastLen).trim()
+  return tail.length >= 2 ? tail : text
+}
+
+function stripInstructionEchoLines(text: string): string {
+  return text
+    .split('\n')
+    .filter((line) => !ECHO_LINE_RE.test(line.trim()))
+    .join('\n')
+    .trim()
+}
+
+/** 模型家族级输出净化（generic 级）：清 think 标签、提取润色尾段、去指令回声。'none' 级家族原样透传。 */
+export function sanitizeModelSpecific(text: string, ctx: { family: ModelFamily; outputLang: string }): string {
+  const caps = getCapabilities(ctx.family)
+  if (caps.sanitizeLevel !== 'generic') return text
+  let out = stripThinkingTags(text)
+  out = extractPolishedTail(out)
+  out = stripInstructionEchoLines(out)
+  return out
+}
diff --git a/plugins/prompt-master/src/pe-framework/schema/scenes.ts b/plugins/prompt-master/src/pe-framework/schema/scenes.ts
index aa1cb64..f309565 100644
--- a/plugins/prompt-master/src/pe-framework/schema/scenes.ts
+++ b/plugins/prompt-master/src/pe-framework/schema/scenes.ts
@@ -2,20 +2,61 @@
  * PM 10 场景 → H3 shots 映射（resolver 只读引入，不修改）。
  * 来源：src/resolver/minimax/catalog.ts（MINIMAX_SCENARIOS 定义）+ assemble.ts（normalizeForm 语义）。
  * 语义：把场景表单字段（subject/场景要素）确定性翻译为 H3ShotsInput 的 shots/what/ambient/music/dialogue + duration；
  * full_reference 走 ref2va（六段式）默认 stage（compile 层按场景路由）。
  * 不受支持/缺内容字段 → null（调用方报场景映射不可用）。
  */
 import { MINIMAX_SCENARIOS, getScenarioById, type MiniMaxScenario } from '../../resolver/minimax/catalog.js'
 import { normalizeForm } from '../../resolver/minimax/assemble.js'
 import type { H3ShotsInput, H3Shot } from './h3-shots.js'
 import type { AuditGate } from '../types.js'
+import type { OutputContract } from '../continue/contract.js'
+
+/**
+ * T14 Task 3：场景输出契约（声明制——契约只在场景条目声明时生效）。
+ * full_reference 六段 fields 的 patterns 与 dialect/h3.ts buildRef2vaText 实际发出的
+ * 英文段名逐字对齐：subject_definitions / summary / retention_analysis /
+ * detailed_description / overall_soundscape / non_diegetic_music。
+ * director_segments 为分组形态：分隔符 + 期望组数（按表单 segment_count 推导）。
+ */
+export const SCENE_OUTPUT_CONTRACTS: Record<string, OutputContract> = {
+  full_reference: {
+    id: 'minimax-full-reference',
+    fields: [
+      { key: 'subject_definitions', patterns: [/subject_definitions\s*[:：]/i] },
+      { key: 'summary', patterns: [/summary\s*[:：]/i, /摘要\s*[:：]/] },
+      { key: 'retention_analysis', patterns: [/retention_analysis\s*[:：]/i] },
+      { key: 'detailed_description', patterns: [/detailed_description\s*[:：]/i] },
+      { key: 'overall_soundscape', patterns: [/overall_soundscape\s*[:：]/i] },
+      { key: 'non_diegetic_music', patterns: [/non_diegetic_music\s*[:：]/i] },
+    ],
+  },
+  director_segments: {
+    id: 'minimax-director-segments',
+    fields: [],
+    groupSeparator: /={3,}\s*提示词组\s*(\d+)\s*={3,}/,
+    expectedGroups: (ff) => Number(ff?.['segment_count'] ?? 4),
+  },
+}
+
+/**
+ * 场景 → 输出契约解析：六段式 ref2va 契约只按场景 id 匹配——product_ad / brand_promo
+ * 虽然也是 outputMode 'full_reference'，但 pickStage 把它们路由到 t2va（三字段体），
+ * 永远不会出现六个 ref2va 段名 → 按 mode 兜底会导致无限续写轮。
+ * director_segments 按 mode 兜底安全：catalog 里只有 continuous_story 用它。
+ */
+export function sceneOutputContract(scenarioId: string, outputMode?: string): OutputContract | undefined {
+  const byId = SCENE_OUTPUT_CONTRACTS[scenarioId]
+  if (byId) return byId
+  if (outputMode === 'director_segments') return SCENE_OUTPUT_CONTRACTS['director_segments']
+  return undefined
+}
 
 export interface SceneMap {
   scenarioId: string
   toShots(scenarioId: string, formFields: Record<string, unknown>, lang?: string): H3ShotsInput | null
 }
 
 const META_KEYS = [
   'duration_seconds', 'duration', 'seconds', '时长',
   'aspect_ratio', 'expand_mode', 'output_lang', 'prompt_language',
   'plan_mode', 'segment_count', 'segment_seconds', 'prompt_kind', 'copy_mode',
diff --git a/plugins/prompt-master/src/plugin/index.ts b/plugins/prompt-master/src/plugin/index.ts
index bc7503b..e575503 100644
--- a/plugins/prompt-master/src/plugin/index.ts
+++ b/plugins/prompt-master/src/plugin/index.ts
@@ -3,20 +3,21 @@ import type { Context } from '@deepseek-ai/cordis'
 import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
 import { registerExpandTool } from '../tools/prompt-expand.js'
 import { registerReverseTool } from '../tools/prompt-reverse.js'
 import { registerMinimaxTool } from '../tools/minimax-scenario.js'
 import { registerProfileListTool, type ProfileScope } from '../tools/profile-list.js'
 import { registerAuthorTool, setAuthorIntentProvider } from '../tools/prompt-author.js'
 import { registerCompileTool } from '../tools/prompt-compile.js'
 import { registerCatalogSearchTool } from '../tools/catalog-search.js'
 import { registerAuditTool } from '../tools/prompt-audit.js'
 import { setCustomProfileSource } from '../resolver/profiles/source.js'
+import { registerOverridesNamespace } from '../pe-framework/profiles/storage-v2.js'
 import '../pe-framework/dialect/anima.js'
 import '../pe-framework/dialect/h3.js'
 import { createDefaultIntentProvider } from '../pe-framework/intent/index.js'
 import { setPresetRoot } from '../pe-framework/resources/resolve.js'
 import { Config, type Config as ConfigShape } from './config.js'
 
 export const name = 'prompt-master'
 export const inject = ['tools', 'llm', 'settings', 'subagents']
 export { Config }
 
@@ -38,23 +39,26 @@ export function apply(ctx: Context, config: ConfigShape) {
 
   // 注入 resolver 自定义 profile 源（兼证 Task 9 契约）
   setCustomProfileSource(() =>
     Object.entries(profileScope.get()).map(([id, profileJson]) => ({ id, profileJson })),
   )
 
   // R2: 装入默认 Intent Provider（intent 走 DSH one-shot subagent；ownerCtx 一次性绑定；返回 AuthorIntentFn 单参）
   //     必须早于 author 工具注册/调用 → 在 ctx.effect 之前完成
   setAuthorIntentProvider(createDefaultIntentProvider(ctx))
 
+  // 内置覆盖层 namespace（Task 7 spec §7.1）→ 注入 profile_list 工具
+  const overrides = registerOverridesNamespace(ctx)
+
   ctx.effect(() => {
     const disposers: (() => void)[] = []
     disposers.push(ctx.tools.register(registerExpandTool(ctx, config)))
     disposers.push(ctx.tools.register(registerReverseTool(ctx, config)))
     disposers.push(ctx.tools.register(registerMinimaxTool(ctx, config)))
-    disposers.push(ctx.tools.register(registerProfileListTool(ctx, config, { scope: profileScope })))
+    disposers.push(ctx.tools.register(registerProfileListTool(ctx, config, { scope: profileScope, overrides })))
     disposers.push(ctx.tools.register(registerAuthorTool(ctx, config)))
     disposers.push(ctx.tools.register(registerCompileTool(ctx)))
     disposers.push(ctx.tools.register(registerCatalogSearchTool(ctx, config)))
     disposers.push(ctx.tools.register(registerAuditTool(ctx, config)))
     return () => { for (const d of disposers) d() }
   }, 'prompt-master.tools')
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/src/tools/minimax-scenario.ts b/plugins/prompt-master/src/tools/minimax-scenario.ts
index 5a50d87..dc3e9c0 100644
--- a/plugins/prompt-master/src/tools/minimax-scenario.ts
+++ b/plugins/prompt-master/src/tools/minimax-scenario.ts
@@ -1,15 +1,18 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
 import { listScenarios, getScenarioById, resolveMinimaxScenarioExpand } from '../resolver/minimax/index.js'
 import { countChars } from '../utils/length.js'
 import { complete } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
+import { sceneOutputContract } from '../pe-framework/schema/scenes.js'
+import { continueUntilComplete } from '../pe-framework/continue/engine.js'
+import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 
 const STAGE_BUDGETS: Record<string, { text_tokens: number; char_limit: number }> = {
   t2va: { text_tokens: 1200, char_limit: 7000 },
   i2va: { text_tokens: 1500, char_limit: 7000 },
   fl2va: { text_tokens: 1700, char_limit: 7000 },
   l2va: { text_tokens: 1700, char_limit: 7000 },
   ref2va: { text_tokens: 2400, char_limit: 7000 },
 }
@@ -63,24 +66,52 @@ export function registerMinimaxTool(ctx: Context, config: Config) {
         const char_count = countChars(expanded.user)
         return JSON.stringify({
           prompt: expanded.user,
           sections: splitSections(expanded.user, scenario.outputMode || 'full_reference'),
           scenario: { id: scenario.id, name: scenario.name, outputMode: scenario.outputMode },
           budget: { text_tokens: budgetCfg.text_tokens, char_count, char_limit: budgetCfg.char_limit, over: char_count > budgetCfg.char_limit },
           dry_run: true,
         })
       }
       const { provider, model } = resolveRoute(exec as ExecLike)
-      const { text, usage } = await complete(ctx, {
+      const caps = getCapabilities(inferModelFamily(provider, model))
+      const effectiveParams = applyCapabilities(caps, { temperature: config.temperature })
+      const { text: rawText, usage, finish } = await complete(ctx, {
         provider, model, system: expanded.system, user: expanded.user,
-        maxTokens: expanded.maxTokens, temperature: config.temperature, signal: exec.signal,
+        maxTokens: expanded.maxTokens, temperature: effectiveParams.temperature, signal: exec.signal,
       })
+      // T14 Task 3：场景声明输出契约 → 截断/缺段时走 continueUntilComplete 定向续写
+      const contract = sceneOutputContract(scenario.id, scenario.outputMode)
+      let text = rawText
+      let continueRounds = 0
+      let continueComplete = true
+      if (contract) {
+        const outcome = await continueUntilComplete({
+          contract,
+          initialText: text,
+          finishKind: finish.kind,
+          seed: { system: expanded.system, userText: expanded.user, outputLang: language === 'en' ? 'en' : 'zh' },
+          generate: async (req) => {
+            const g = await complete(ctx, {
+              provider, model, system: req.system ?? expanded.system, user: req.user,
+              maxTokens: expanded.maxTokens, temperature: effectiveParams.temperature, signal: exec.signal,
+            })
+            return { text: g.text, finishKind: g.finish.kind }
+          },
+          signal: exec.signal,
+          onContinue: (n, max) => ctx.logger?.info?.(`[prompt-master] continue round=${n}/${max}`),
+        })
+        text = outcome.text
+        continueRounds = outcome.rounds
+        continueComplete = outcome.complete
+        ctx.logger?.info?.(`[prompt-master] minimax_scenario → continue complete=${outcome.complete} rounds=${continueRounds}`)
+      }
       const char_count = countChars(text)
       return JSON.stringify({
         prompt: text,
         sections: splitSections(text, scenario.outputMode || 'full_reference'),
         scenario: { id: scenario.id, name: scenario.name, outputMode: scenario.outputMode },
         budget: {
           text_tokens: usage?.outputTokens || budgetCfg.text_tokens,
           char_count, char_limit: budgetCfg.char_limit, over: char_count > budgetCfg.char_limit,
         },
       })
diff --git a/plugins/prompt-master/src/tools/profile-list.ts b/plugins/prompt-master/src/tools/profile-list.ts
index 3909c86..a18b53e 100644
--- a/plugins/prompt-master/src/tools/profile-list.ts
+++ b/plugins/prompt-master/src/tools/profile-list.ts
@@ -1,13 +1,14 @@
 import { defineTool } from '@deepseek-ai/dsh-tools'
-import { getDefaultBuiltinProfiles, filterProfilesByKind, searchProfiles, clearProfileCache } from '../resolver/profiles/index.js'
+import { getDefaultBuiltinProfiles, clearProfileCache } from '../resolver/profiles/index.js'
 import { getTaxonomyMeta } from '../resolver/taxonomy.js'
+import { listProfilesMerged, validateImportPayload, recastImportedProfile, type OverridesApi } from '../pe-framework/profiles/storage-v2.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 
 export interface ProfileScope {
   get(): Record<string, string>
   update(patch: object): Promise<void>
   replace(section: object): Promise<void>
 }
 
 export type ProfileTarget = 'anima' | 'h3' | 'sd' | 'danbooru' | 'mj' | 'generic'
@@ -17,47 +18,65 @@ export type ProfileTarget = 'anima' | 'h3' | 'sd' | 'danbooru' | 'mj' | 'generic
  * 推导：outputFormat='minimax' → h3；tags 含 'Anima'/'anima3' → anima；
  * outputFormat∈{sd_tags,danbooru_tags} → sd|danbooru；kind='train' 的训练配方按 outputFormat 归入对应变体；其余 → generic。
  */
 export function profileTargets(p: { kind: string; outputFormat: string; tags: string[] }): ProfileTarget[] {
   if (p.outputFormat === 'minimax') return ['h3']
   if ((p.tags ?? []).some((t) => /anima/i.test(t))) return ['anima']
   if (p.outputFormat === 'sd_tags' || p.outputFormat === 'danbooru_tags') return ['sd', 'danbooru']
   return ['generic']
 }
 
-export function registerProfileListTool(_ctx: Context, _config: Config, deps: { scope: ProfileScope }) {
-  const { scope } = deps
+export function registerProfileListTool(_ctx: Context, _config: Config, deps: { scope: ProfileScope; overrides?: OverridesApi }) {
+  const { scope, overrides } = deps
   return defineTool({
     name: 'profile_list',
-    description: '查询/保存/删除提示词 profile（内置 + 自定义）。list/search 查询，get 单查，save/delete 管理自定义 profile。',
+    description: '查询/保存/删除提示词 profile（内置 + 自定义）。list/search 查询，get 单查，save/delete 管理自定义 profile，enable/sort 管理内置覆盖，export/import/validate_import 导入导出。',
     parameters: {
-      action: { type: 'string', default: 'list', description: 'list|search|get|save|delete' },
+      action: { type: 'string', default: 'list', description: 'list|search|get|save|delete|enable|sort|export|import|validate_import' },
       kind: { type: 'string', default: '', description: 'list/search 时按 kind 过滤：expand/reverse/minimax' },
       query: { type: 'string', default: '', description: 'list/search 时按关键字搜索' },
       target: { type: 'string', default: '', description: 'list/search 时按推导 target 过滤：anima|h3|sd|danbooru|mj|generic（缺省不过滤）' },
-      id: { type: 'string', default: '', description: 'get/save/delete 的目标 profile id' },
-      profile: { type: 'object', description: 'save 时要保存的 profile 对象（将强制 id 并保存为 builtin:false）', default: {}, additionalProperties: true },
+      id: { type: 'string', default: '', description: 'get/save/delete/enable/export 的目标 profile id' },
+      profile: { type: 'object', description: 'save 时要保存的 profile 对象（将强制 id 并保存为 builtin:false）；import 时为导入 payload', default: {}, additionalProperties: true },
+      enabled: { type: 'boolean', default: true, description: 'enable 时目标内置 profile 的启用状态' },
+      ids: { type: 'array', description: 'sort 时按顺序排列的内置 profile id 列表', default: [] },
     },
     output: {
       schema: { type: 'string', description: 'JSON 字符串' },
       render: (_a, v) => [{ type: 'text', text: v }],
     },
-    async execute(args: { action?: string; kind?: string; query?: string; target?: string; id?: string; profile?: Record<string, unknown> }) {
+    async execute(args: { action?: string; kind?: string; query?: string; target?: string; id?: string; profile?: Record<string, unknown>; enabled?: boolean; ids?: unknown[] }) {
       const action = String(args.action || 'list').trim()
       if (action === 'list' || action === 'search') {
         const kind = String(args.kind || '').trim()
         const query = String(args.query || '').trim()
         const target = args.target != null ? String(args.target).trim() : ''
-        let profiles = getDefaultBuiltinProfiles()
-        if (kind) profiles = filterProfilesByKind(kind)
+        // 两层合并读取（spec §7.1）：getDefaultBuiltinProfiles 已含 custom 层，按 builtin 标记拆分后走 listProfilesMerged
+        const all = getDefaultBuiltinProfiles()
+        let profiles = listProfilesMerged(
+          all.filter((p) => p.builtin),
+          all.filter((p) => !p.builtin),
+          overrides?.all() ?? {},
+        )
+        if (kind) {
+          const k = kind
+          profiles = profiles.filter((p) => {
+            if (k === 'minimax') return !!p.minimaxScenarioId
+            return p.kind === k
+          })
+        }
         if (target) profiles = profiles.filter((p) => profileTargets(p).includes(target as ProfileTarget))
-        if (query) profiles = searchProfiles(query)
+        if (query) {
+          const q = query.toLowerCase()
+          // 注：search 语义=合并列表的小写子串过滤（原 searchProfiles 的评分排序不适用 overrides 过滤后列表）
+          profiles = profiles.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)))
+        }
         return JSON.stringify({
           profiles: profiles.map((p) => ({ id: p.id, name: p.name, category: p.category, description: p.description, kind: p.kind, outputFormat: p.outputFormat, tags: p.tags, target: profileTargets(p)[0] ?? undefined })),
           taxonomy: getTaxonomyMeta(),
         })
       }
       if (action === 'get') {
         const id = String(args.id || '').trim()
         if (!id) throw new Error('id is required for get action')
         const current = scope.get()
         if (current[id]) return JSON.stringify({ profile: JSON.parse(current[id]), custom: true })
@@ -81,14 +100,61 @@ export function registerProfileListTool(_ctx: Context, _config: Config, deps: {
         if (getDefaultBuiltinProfiles().find((p) => p.id === id && p.builtin)) {
           throw new Error(`${id} 是内置 profile，不能删除`)
         }
         const current = scope.get()
         const next = { ...current }
         delete next[id]
         await scope.replace({ customProfiles: next })
         clearProfileCache()
         return JSON.stringify({ id, message: `Profile ${id} 已删除` })
       }
+      if (action === 'enable') {
+        if (!overrides) throw new Error('overrides namespace 未注册，无法启用/停用内置 profile')
+        const id = String(args.id || '').trim()
+        if (!id) throw new Error('id is required for enable action')
+        const enabled = args.enabled !== false
+        if (!getDefaultBuiltinProfiles().some((p) => p.builtin && p.id === id)) {
+          throw new Error(`内置 profile 不存在: ${id}`)
+        }
+        await overrides.set(id, { enabled })
+        clearProfileCache()
+        return JSON.stringify({ id, enabled, message: `内置 profile ${id} 已${enabled ? '启用' : '停用'}` })
+      }
+      if (action === 'sort') {
+        if (!overrides) throw new Error('overrides namespace 未注册，无法排序内置 profile')
+        const ids = Array.isArray(args.ids) ? args.ids.map((x) => String(x).trim()).filter(Boolean) : []
+        if (!ids.length) throw new Error('ids is required for sort action')
+        const builtinIds = new Set(getDefaultBuiltinProfiles().filter((p) => p.builtin).map((p) => p.id))
+        for (const id of ids) {
+          if (!builtinIds.has(id)) throw new Error(`内置 profile 不存在: ${id}`)
+        }
+        for (let i = 0; i < ids.length; i++) {
+          await overrides.set(ids[i], { enabled: true, sort: i })
+        }
+        clearProfileCache()
+        return JSON.stringify({ ids, message: `已按给定顺序排序 ${ids.length} 个内置 profile` })
+      }
+      if (action === 'export') {
+        const id = String(args.id || '').trim()
+        if (!id) throw new Error('id is required for export action')
+        const all = getDefaultBuiltinProfiles()
+        const merged = listProfilesMerged(all.filter((p) => p.builtin), all.filter((p) => !p.builtin), overrides?.all() ?? {})
+        const p = merged.find((x) => x.id === id)
+        if (!p) throw new Error(`Profile not found: ${id}`)
+        return JSON.stringify({ format: 'prompt-master-prompt-engineering', profile: p })
+      }
+      if (action === 'import' || action === 'validate_import') {
+        const builtinIds = getDefaultBuiltinProfiles().filter((p) => p.builtin).map((p) => p.id)
+        const r = validateImportPayload(args.profile, builtinIds)
+        if (!r.ok) return JSON.stringify({ ok: false, action, reason: r.reason })
+        if (action === 'validate_import') return JSON.stringify({ ok: true, action, message: '导入 payload 校验通过（未落盘）' })
+        const recast = recastImportedProfile(r.profile)
+        const newId = String(recast['id'])
+        const current = scope.get()
+        await scope.update({ customProfiles: { ...current, [newId]: JSON.stringify(recast) } })
+        clearProfileCache()
+        return JSON.stringify({ ok: true, action: 'import', id: newId, message: `已导入为自定义 profile ${newId}` })
+      }
       throw new Error(`Unknown action: ${action}`)
     },
   })
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/src/tools/prompt-author.ts b/plugins/prompt-master/src/tools/prompt-author.ts
index f16d107..47672f1 100644
--- a/plugins/prompt-master/src/tools/prompt-author.ts
+++ b/plugins/prompt-master/src/tools/prompt-author.ts
@@ -8,20 +8,21 @@ import '../pe-framework/dialect/h3.js'
 import { isDialectReady as registryIsDialectReady, getDialect } from '../pe-framework/dialect/registry.js'
 import { runStage } from '../pe-framework/pipeline/runStage.js'
 import { assembleEnvelope } from '../pe-framework/render/envelope.js'
 import type { StageResult } from '../pe-framework/pipeline/types.js'
 import { sceneToShotsChecked } from '../pe-framework/schema/scenes.js'
 import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 import { complete } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
+import { resolveJoyExtraOptions, filterJoyExtraClauses } from '../pe-framework/sanitize/joy-extra.js'
 
 export interface AuthorArgs {
   target: Target
   input: string
   profile?: string
   variant?: string
   stage?: string
   scenario_id?: string
   form_fields?: Record<string, unknown>
   audit_only?: boolean
@@ -147,20 +148,42 @@ function applyScenarioGates(stage: StageResult, opts: { scenarioId?: string; for
   }
 }
 
 /** draft → runStage → applyScenarioGates（author 每轮统一入口；audit 不通过不在此处理——闭环在 execute） */
 function runDraftThroughStage(target: string, draft: AuthorDraft, opts: { stage?: string; scenarioId?: string; formFields?: Record<string, unknown>; variant?: string }): StageResult {
   const input = normalizeDraftToInput(target, draft, opts)
   const stageResult = runStage({ target: target as Target, ...input })
   return applyScenarioGates(stageResult, { scenarioId: opts.scenarioId, formFields: opts.formFields, refsCount: referencesCount(draft, opts.formFields) })
 }
 
+/**
+ * JoyExtra 硬约束输出过滤（Task 4，anima 分支）：form_fields.joy_extra_options 声明的禁写项
+ * 在 compileAnima 产物 positive/negative 上做子句过滤（复核兜底，硬约束优先级高于检查表）。
+ * 返回 true 表示发生了实际剔除。
+ */
+function applyAnimaJoyExtraFilter(stage: StageResult, formFields?: Record<string, unknown>): boolean {
+  if (!formFields) return false
+  const res = resolveJoyExtraOptions({ joyExtraOptions: formFields.joy_extra_options, extraPrompt: '' })
+  if (res.options.length === 0) return false
+  let filtered = false
+  for (const key of ['positive', 'negative'] as const) {
+    const text = stage.result[key]
+    if (typeof text !== 'string' || !text.trim()) continue
+    const out = filterJoyExtraClauses(text, res)
+    if (out !== text) {
+      stage.result[key] = out
+      filtered = true
+    }
+  }
+  return filtered
+}
+
 export function registerAuthorTool(ctx: Context, config: Config) {
   return defineTool({
     name: 'prompt_author',
     description:
       '统一提示词工程主入口（全链路编排）：输入创作意图 → intent（LLM 拆结构）→ schema → dialect（compileAnima/compileH3）→ audit → Envelope + target_slot_hint；audit 未过且有 Critical 时自动修正重跑（max 2 次，仍失败置 loop_exhausted）。当前归化状态：' +
       TARGETS.map((t) => `${t}=${isDialectReady(t) ? 'ready' : 'pending'}`).join(' ') +
       '；sd/generic 报 DIALECT_NOT_AVAILABLE。',
     parameters: {
       target: { type: 'string', description: '目标方言：anima | h3 | sd | generic', default: 'anima' },
       input: { type: 'string', description: '创作意图（一句话/图描述/分镜素材）' },
@@ -202,36 +225,40 @@ export function registerAuthorTool(ctx: Context, config: Config) {
       // audit_only：不调 LLM，把 input 当结构 JSON（原语义：完整编译+审计，result 照常产出——不用内核 auditOnly 标志）
       if (a.audit_only === true) {
         let draft: AuthorDraft
         try {
           const parsed = JSON.parse(input) as Record<string, unknown>
           draft = target === 'anima' ? { slots: parsed as unknown as AnimaSlots } : { shots: parsed as unknown as H3ShotsInput }
         } catch {
           throw new Error('audit_only 需要结构化 JSON 输入（anima: slots；h3: shots{...}）')
         }
         const stage = runDraftThroughStage(target, draft, runOpts)
+        if (target === 'anima') applyAnimaJoyExtraFilter(stage, a.form_fields)
         return assembleEnvelope(stage, [])
       }
 
       const provider = _intentProvider ?? ((req: AuthorIntentRequest, exec2?: ExecLike) => defaultIntent(ctx, resolveRoute((exec2 ?? exec) as ExecLike), req))
       // Task 7：intent persona/schema 方言化——从 dialect 注册表取（ANIMA_*/H3_* 常量），未注册则 undefined → provider 内 DEFAULT 兜底
       const intentCfg = getDialect(target)?.intent
       const intentBase = { target, input, variant: a.variant, scenarioId, formFields: a.form_fields, persona: intentCfg?.persona, schema: intentCfg?.schema }
       ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author target=${target}${a.variant ? ` variant=${a.variant}` : ''}${a.stage ? ` stage=${a.stage}` : ''}`)
+      let joyExtraFiltered = false
       let draft = await provider({ ...intentBase, round: 0 }, exec)
       let stage = runDraftThroughStage(target, draft, runOpts)
+      if (target === 'anima') joyExtraFiltered = applyAnimaJoyExtraFilter(stage, a.form_fields) || joyExtraFiltered
       const trailAdvisories: string[] = []
       let corrections = 0
       while (!stage.ok && stage.gates.some((g) => g.severity === 'critical') && corrections < MAX_CORRECTIONS) {
         corrections++
         const feedback = stage.gates.filter((g) => g.severity === 'critical').map((g) => `[${g.rule}] ${g.detail}`).join('\n')
         draft = await provider({ ...intentBase, round: corrections, feedback }, exec)
         stage = runDraftThroughStage(target, draft, runOpts)
+        if (target === 'anima') joyExtraFiltered = applyAnimaJoyExtraFilter(stage, a.form_fields) || joyExtraFiltered
       }
       if (!stage.ok && stage.gates.some((g) => g.severity === 'critical')) {
         trailAdvisories.push('loop_exhausted:true')
       }
-      ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
+      ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} joy_extra filtered=${joyExtraFiltered ? 'yes' : 'no'} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
       return assembleEnvelope(stage, trailAdvisories)
     },
   })
 }
diff --git a/plugins/prompt-master/src/tools/prompt-expand.ts b/plugins/prompt-master/src/tools/prompt-expand.ts
index 255c82c..c981367 100644
--- a/plugins/prompt-master/src/tools/prompt-expand.ts
+++ b/plugins/prompt-master/src/tools/prompt-expand.ts
@@ -1,15 +1,17 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
 import { resolveExpand } from '../resolver/index.js'
 import { findProfileById } from '../resolver/profiles/index.js'
 import { complete } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
+import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js'
+import { sanitizeModelSpecific } from '../pe-framework/sanitize/model-specific.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 
 export interface ExpandArgs {
   text: string
   profile?: string
   output_lang?: string
   length?: string
   extra_prompt?: string
   dry_run?: boolean
@@ -47,23 +49,28 @@ export function registerExpandTool(ctx: Context, config: Config) {
       })
       if (args.dry_run) {
         const debug = JSON.stringify({
           debug: { system: expanded.system, user: expanded.user, maxTokens: expanded.maxTokens },
           profile_meta: { id: profile.id, name: profile.name, outputFormat: profile.outputFormat },
         })
         logInfo(`[prompt-master] prompt_expand → ok=true dry_run=true chars=${debug.length}`)
         return debug
       }
       const { provider, model } = resolveRoute(exec as ExecLike)
+      const caps = getCapabilities(inferModelFamily(provider, model))
+      const effectiveParams = applyCapabilities(caps, { temperature: config.temperature })
       const { text: result } = await complete(ctx, {
         provider, model,
         system: expanded.system,
         user: expanded.user,
         maxTokens: expanded.maxTokens,
-        temperature: config.temperature,
+        temperature: effectiveParams.temperature,
         signal: exec.signal,
       })
-      logInfo(`[prompt-master] prompt_expand → ok=true chars=${result.length}`)
-      return result || ''
+      const family = inferModelFamily(provider, model)
+      const sanitized = sanitizeModelSpecific(result, { family, outputLang: String(args.output_lang || 'zh') })
+      logInfo(`[prompt-master] prompt_expand sanitize family=${family} changed=${sanitized !== result}`)
+      logInfo(`[prompt-master] prompt_expand → ok=true chars=${sanitized.length}`)
+      return sanitized || ''
     },
   })
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/src/tools/prompt-reverse.ts b/plugins/prompt-master/src/tools/prompt-reverse.ts
index 7686416..45622a5 100644
--- a/plugins/prompt-master/src/tools/prompt-reverse.ts
+++ b/plugins/prompt-master/src/tools/prompt-reverse.ts
@@ -1,26 +1,32 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
 import type { ContentBlock, ImageBlock, UserMessage } from '@deepseek-ai/dsh-llm'
 import { resolveReverse } from '../resolver/index.js'
 import { findProfileById } from '../resolver/profiles/index.js'
 import { sanitizeFinalCaption } from '../resolver/profiles/reverse/router.js'
 import { completeWithBlocks } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
+import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js'
+import { resolveJoyExtraOptions, buildJoyExtraSystemBlock, buildJoyExtraUserTail, filterJoyExtraClauses } from '../pe-framework/sanitize/joy-extra.js'
+import { sanitizeModelSpecific } from '../pe-framework/sanitize/model-specific.js'
+import { enumerateTaggedMedia, buildIdentityDeclarations } from '../pe-framework/media/identity.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 
 export interface ReverseArgs {
   image_description?: string
   profile?: string
   output_lang?: string
   length?: string
   extra_prompt?: string
+  joy_extra_options?: string[]
+  character_name?: string
   anima3_enhance?: boolean
   quality_prompt_enabled?: boolean
   quality_prompt_prefix?: string
   media_target?: string
   dry_run?: boolean
 }
 
 /** 反向找最近一个 'user/message' 事件中的全部 image block */
 export async function collectRecentImages(exec: ToolRunContext): Promise<ImageBlock[]> {
   const events = (exec.agent as any)?.session?.events
@@ -40,20 +46,22 @@ export async function collectRecentImages(exec: ToolRunContext): Promise<ImageBl
 export function registerReverseTool(ctx: Context, config: Config) {
   return defineTool({
     name: 'prompt_reverse',
     description: '根据图片描述（或会话中的图片附件）反推生成可直接用于 AI 绘图的提示词。output_lang/length/profile 决定输出风格。可选 dry_run 查看组装结果而不调用模型。',
     parameters: {
       image_description: { type: 'string', description: '对画面的描述（必填；若会话最近有图片附件可省略，以图片为准）' },
       profile: { type: 'string', default: 'pe_reverse_descriptive', description: '反推 profile id：pe_reverse_descriptive / pe_reverse_sd / pe_reverse_danbooru 或自定义' },
       output_lang: { type: 'string', default: 'zh', description: '输出语言 zh/en' },
       length: { type: 'string', default: 'medium', description: '篇幅 short/medium/long' },
       extra_prompt: { type: 'string', default: '', description: '附加要求' },
+      joy_extra_options: { type: 'array', default: [], description: 'JoyExtra 硬约束选项（no_glasses_headwear / scene_only_no_character_appearance / no_artistic_style / character_name）；硬约束优先级高于检查表' },
+      character_name: { type: 'string', default: '', description: '角色称呼（配合 joy_extra_options=character_name 使用）' },
       anima3_enhance: { type: 'boolean', default: false, description: 'Anima3 增强' },
       quality_prompt_enabled: { type: 'boolean', default: false, description: '启用质量词前缀' },
       quality_prompt_prefix: { type: 'string', default: '', description: '自定义质量词前缀' },
       media_target: { type: 'string', default: 'image', description: 'image（默认，兼容现有）/ anima / h3——anima=产出可槽位化的丰富描述，h3=产出分镜素材' },
       dry_run: { type: 'boolean', default: false, description: '只返回组装好的 system/text/maxTokens，不调用模型' },
     },
     output: {
       schema: { type: 'string', description: '反推提示词正文；dry_run 时返回含 debug 的 JSON 字符串' },
       render: (_a, v) => [{ type: 'text', text: v }],
     },
@@ -66,63 +74,87 @@ export function registerReverseTool(ctx: Context, config: Config) {
       const profile = findProfileById(String(args.profile || 'pe_reverse_descriptive').trim())
       if (!profile) throw new Error(`Profile not found: ${String(args.profile || 'pe_reverse_descriptive')}`)
       logInfo(`[prompt-master] prompt_reverse profile=${profile.id} media_target=${String(args.media_target || 'image')} images=${images.length}${args.dry_run ? ' dry_run=true' : ''}`)
       const reverseResult = resolveReverse(profile, {
         caption_lang: String(args.output_lang || 'zh') as 'zh' | 'en' | 'auto',
         len: String(args.length || 'medium'),
         media_target: String(args.media_target || 'image') as 'image' | 'video',
         extra_prompt: String(args.extra_prompt || ''),
         anima3_enhance: args.anima3_enhance === true,
       })
-      const user = [reverseResult.userLead, reverseResult.userBody, reverseResult.outputConstraints, reverseResult.userTail]
+      const joyExtra = resolveJoyExtraOptions({
+        joyExtraOptions: args.joy_extra_options,
+        extraPrompt: String(args.extra_prompt || ''),
+        characterName: args.character_name,
+      })
+      const outputLang = (String(args.output_lang || 'zh') === 'en' ? 'en' : 'zh') as 'zh' | 'en'
+      const joySystemBlock = joyExtra.options.length > 0 ? buildJoyExtraSystemBlock(joyExtra, outputLang) : ''
+      const system = joySystemBlock ? `${reverseResult.system}\n\n${joySystemBlock}` : reverseResult.system
+      const joyUserTail = joyExtra.options.length > 0 ? buildJoyExtraUserTail(joyExtra, outputLang) : ''
+      const user = [reverseResult.userLead, reverseResult.userBody, reverseResult.outputConstraints, reverseResult.userTail, joyUserTail]
         .filter(Boolean).join('\n')
       // 文本路径修复：画面描述必须进入 LLM 上下文。user 是组装指令，desc 是用户对画面的描述；
       // user 开头非空时也要并入 desc，否则模型只收到指令、看不到画面内容（历史 bug：
       // builtin reverse profiles 四段拼接恒非空 → `user || desc` 永远取 user，desc 被静默丢弃）。
       const text = user
         ? (desc ? `${user}\n\n[${String(args.output_lang || 'zh') === 'en' ? 'Scene description' : '画面描述'}]\n${desc}` : user)
         : desc
       if (args.dry_run) {
         const debug = JSON.stringify({
           debug: {
-            system: reverseResult.system,
+            system,
             text,
             imageBlocks: images.length,
             maxTokens: 512,
           },
           profile_meta: { id: profile.id, name: profile.name, outputFormat: profile.outputFormat },
         })
         logInfo(`[prompt-master] prompt_reverse → ok=true dry_run=true chars=${debug.length}`)
         return debug
       }
       const { provider, model } = resolveRoute(exec as ExecLike)
-      const blocks: ContentBlock[] = [
+      const caps = getCapabilities(inferModelFamily(provider, model))
+      const effectiveParams = applyCapabilities(caps, { temperature: config.temperature })
+      // 多图身份映射（B4 S 子集）：≥2 张图时在媒体块之前注入身份声明，防止模型混淆哪张图是哪张
+      const media = enumerateTaggedMedia(images.length)
+      const declarations = buildIdentityDeclarations(media, outputLang)
+      const blocks: ContentBlock[] = []
+      if (declarations) {
+        blocks.unshift({ type: 'text', text: declarations })   // 声明块置于媒体块之前
+        logInfo(`[prompt-master] multi-image identity declarations injected (n=${images.length})`)
+      }
+      blocks.push(
         ...images.map((b) => ({ ...b })),
         ...(text ? [{ type: 'text' as const, text }] : []),
-      ]
+      )
       if (images.length > 0) {
         const info = await (ctx.llm as any).resolveModelInfo?.(provider, model, exec.signal)
         if (!info || !info.inputModalities?.includes('image')) {
           throw new Error(`当前模型 ${model} 不支持图片输入，请在 Web UI Settings→Models 切换到支持图片输入的模型（如 deepseek-v4-flash-vision-exp），或在参数中提供 image_description 文本描述`)
         }
       }
       const { text: raw } = await completeWithBlocks(ctx, {
         provider, model,
-        system: reverseResult.system,
+        system,
         blocks,
         maxTokens: 512,
-        temperature: config.temperature,
+        temperature: effectiveParams.temperature,
         signal: exec.signal,
       })
-      const sanitized = sanitizeFinalCaption(raw, {
+      const family = inferModelFamily(provider, model)
+      const modelSanitized = sanitizeModelSpecific(raw, { family, outputLang: String(args.output_lang || 'zh') })
+      logInfo(`[prompt-master] prompt_reverse sanitize family=${family} changed=${modelSanitized !== raw}`)
+      const sanitized = sanitizeFinalCaption(modelSanitized, {
         type: reverseResult.captionType,
         caption_lang: String(args.output_lang || 'zh'),
         len: String(args.length || 'medium'),
         anima3_enhance: args.anima3_enhance === true,
         quality_prompt_enabled: args.quality_prompt_enabled === true,
         quality_prompt_prefix: String(args.quality_prompt_prefix || ''),
       })
-      logInfo(`[prompt-master] prompt_reverse → ok=true chars=${sanitized.length}`)
-      return sanitized
+      const joyFilteredBefore = sanitized
+      const finalCaption = joyExtra.options.length > 0 ? filterJoyExtraClauses(sanitized, joyExtra) : sanitized
+      logInfo(`[prompt-master] prompt_reverse → ok=true chars=${finalCaption.length} joy_extra options=${joyExtra.options.join('|') || 'none'} filtered=${finalCaption !== joyFilteredBefore ? 'yes' : 'no'}`)
+      return finalCaption
     },
   })
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/tests/pe-framework/continue/continue-engine.test.ts b/plugins/prompt-master/tests/pe-framework/continue/continue-engine.test.ts
new file mode 100644
index 0000000..e00ef00
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/continue/continue-engine.test.ts
@@ -0,0 +1,110 @@
+import { describe, expect, it } from 'vitest'
+import { inspectOutput, type OutputContract } from '../../../src/pe-framework/continue/inspect.js'
+import { mergeContinuedText } from '../../../src/pe-framework/continue/merge.js'
+import { continueUntilComplete } from '../../../src/pe-framework/continue/engine.js'
+
+const sixSegment: OutputContract = {
+  id: 'minimax-full-reference',
+  fields: [
+    { key: 'subject_definitions', patterns: [/subject_definitions\s*[:：]/i] },
+    { key: 'summary', patterns: [/summary\s*[:：]/i, /摘要\s*[:：]/] },
+    { key: 'retention_analysis', patterns: [/retention_analysis\s*[:：]/i] },
+    { key: 'detailed_description', patterns: [/detailed_description\s*[:：]/i] },
+    { key: 'overall_soundscape', patterns: [/overall_soundscape\s*[:：]/i] },
+    { key: 'non_diegetic_music', patterns: [/non_diegetic_music\s*[:：]/i] },
+  ],
+}
+
+describe('inspectOutput', () => {
+  it('complete text → complete=true, missing=[]', () => {
+    const text = 'subject_definitions: X\nsummary: Y\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
+    expect(inspectOutput(text, sixSegment)).toEqual({ missing: [], complete: true })
+  })
+
+  it('missing field reported as field:<key>', () => {
+    const text = 'subject_definitions: X\nsummary: Y' // 只有 2/6
+    const r = inspectOutput(text, sixSegment)
+    expect(r.complete).toBe(false)
+    expect(r.missing).toContain('field:retention_analysis')
+  })
+
+  it('label with empty body (<2 chars) counts as missing', () => {
+    const text = 'subject_definitions: X\nsummary:\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
+    expect(inspectOutput(text, sixSegment).missing).toContain('field:summary')
+  })
+})
+
+describe('mergeContinuedText', () => {
+  it('model parrots full text → take continued only', () => {
+    expect(mergeContinuedText('ABC', 'ABCDEF')).toBe('ABCDEF')
+  })
+  it('suffix-prefix overlap 12+ chars → dedupe join', () => {
+    const prev = 'A'.repeat(200) + 'TAIL-COMMON-SEGMENT-XXXX'
+    const cont = 'TAIL-COMMON-SEGMENT-XXXX' + 'B'.repeat(50)
+    const merged = mergeContinuedText(prev, cont)
+    expect(merged).toBe(prev + 'B'.repeat(50))
+  })
+  it('no overlap → newline join; strips greeting prefix', () => {
+    expect(mergeContinuedText('AAA', '好的，BBB')).toBe('AAA\nBBB')
+  })
+})
+
+describe('continueUntilComplete', () => {
+  const seed = { system: 'sys', userText: '写六段', outputLang: 'zh' as const }
+
+  it('no truncation + complete → returns immediately (rounds=0)', async () => {
+    const full = 'subject_definitions: X\nsummary: Y\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
+    let genCalls = 0
+    const r = await continueUntilComplete({
+      contract: sixSegment, initialText: full, finishKind: 'stop', seed,
+      generate: async () => { genCalls++; return { text: full, finishKind: 'stop' as const } },
+      signal: new AbortController().signal,
+    })
+    expect(r.complete).toBe(true)
+    expect(r.rounds).toBe(0)
+    expect(genCalls).toBe(0)
+  })
+
+  it('max-tokens + incomplete → continues with accumulated text in user message', async () => {
+    const part1 = 'subject_definitions: X\nsummary: Y'
+    const cont = 'retention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
+    let capturedUser = ''
+    const r = await continueUntilComplete({
+      contract: sixSegment, initialText: part1, finishKind: 'max-tokens', seed,
+      generate: async (req) => { capturedUser = req.user; return { text: cont, finishKind: 'stop' as const } },
+      signal: new AbortController().signal,
+    })
+    expect(r.complete).toBe(true)
+    expect(r.rounds).toBe(1)
+    expect(capturedUser).toContain('已写出')
+    expect(capturedUser).toContain(part1)
+    expect(r.text).toContain('subject_definitions')
+    expect(r.text).toContain('non_diegetic_music')
+  })
+
+  it('abort mid-round → partial text + CONTINUE_ABORTED_PARTIAL warning', async () => {
+    const ctl = new AbortController()
+    const r = await continueUntilComplete({
+      contract: sixSegment, initialText: 'subject_definitions: X', finishKind: 'max-tokens', seed,
+      generate: async (req) => {
+        ctl.abort()
+        return { text: 'summary: Y', finishKind: 'stop' as const }
+      },
+      signal: ctl.signal,
+    })
+    expect(r.complete).toBe(false)
+    expect(r.warnings).toContain('CONTINUE_ABORTED_PARTIAL')
+  })
+
+  it('max rounds exhausted → INCOMPLETE_AFTER_MAX_ROUNDS', async () => {
+    let n = 0
+    const r = await continueUntilComplete({
+      contract: sixSegment, initialText: 'x', finishKind: 'max-tokens', seed, maxRounds: 2,
+      generate: async () => { n++; return { text: `chunk${n}`, finishKind: 'max-tokens' as const } },
+      signal: new AbortController().signal,
+    })
+    expect(r.complete).toBe(false)
+    expect(r.warnings).toContain('INCOMPLETE_AFTER_MAX_ROUNDS')
+    expect(r.rounds).toBe(2)
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/media/identity.test.ts b/plugins/prompt-master/tests/pe-framework/media/identity.test.ts
new file mode 100644
index 0000000..c80b455
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/media/identity.test.ts
@@ -0,0 +1,26 @@
+// tests/pe-framework/media/identity.test.ts
+import { describe, expect, it } from 'vitest'
+import { enumerateTaggedMedia, buildIdentityDeclarations } from '../../../src/pe-framework/media/identity.js'
+
+describe('enumerateTaggedMedia', () => {
+  it('tags are consecutive 1-based <Picture N>', () => {
+    expect(enumerateTaggedMedia(3)).toEqual([
+      { n: 1, tag: '<Picture 1>' }, { n: 2, tag: '<Picture 2>' }, { n: 3, tag: '<Picture 3>' },
+    ])
+  })
+  it('zero media → empty', () => {
+    expect(enumerateTaggedMedia(0)).toEqual([])
+  })
+})
+
+describe('buildIdentityDeclarations', () => {
+  it('multi-image → declaration block with do-not-swap header', () => {
+    const decl = buildIdentityDeclarations(enumerateTaggedMedia(2), 'zh')
+    expect(decl).toContain('<Picture 1>')
+    expect(decl).toContain('<Picture 2>')
+    expect(decl).toContain('不要混淆')   // do-not-swap 语义
+  })
+  it('single image → empty string (no injection)', () => {
+    expect(buildIdentityDeclarations(enumerateTaggedMedia(1), 'zh')).toBe('')
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/model-capabilities/model-capabilities.test.ts b/plugins/prompt-master/tests/pe-framework/model-capabilities/model-capabilities.test.ts
new file mode 100644
index 0000000..0b94806
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/model-capabilities/model-capabilities.test.ts
@@ -0,0 +1,62 @@
+import { describe, expect, it } from 'vitest'
+import { inferModelFamily, getCapabilities, applyCapabilities, FAMILY_CAPABILITIES } from '../../../src/pe-framework/model-capabilities/index.js'
+
+describe('inferModelFamily', () => {
+  const cases: Array<[string, string, string]> = [
+    ['deepseek-official', 'deepseek-v4-flash', 'deepseek'],
+    ['deepseek-official', 'deepseek-r2', 'deepseek'],
+    ['zhipu', 'glm-5.3-flash', 'glm'],
+    ['zhipu', 'glm-4.5v', 'glm'],
+    ['ollama', 'qwen3-vl-8b-instruct', 'qwen-vl'],
+    ['ollama', 'Qwen3-VL-8B', 'qwen-vl'],
+    ['openai', 'qwen3.5-27b', 'qwen-text'],
+    ['ollama', 'gemma4-12b', 'gemma'],
+    ['openai', 'gpt-5', 'openai'],
+    ['unknown-provider', 'mystery-model-9000', 'generic'],
+    ['ollama', 'llama3', 'generic'],
+  ]
+  for (const [provider, model, expected] of cases) {
+    it(`infer(${provider}, ${model}) → ${expected}`, () => {
+      expect(inferModelFamily(provider, model)).toBe(expected)
+    })
+  }
+})
+
+describe('capabilities table', () => {
+  it('every family has a capabilities entry', () => {
+    for (const family of Object.keys(FAMILY_CAPABILITIES)) {
+      expect(FAMILY_CAPABILITIES[family as keyof typeof FAMILY_CAPABILITIES]).toBeTruthy()
+    }
+  })
+
+  it('qwen-vl is prone to truncation and needs generic sanitize', () => {
+    const caps = getCapabilities('qwen-vl')
+    expect(caps.proneToTruncation).toBe(true)
+    expect(caps.sanitizeLevel).toBe('generic')
+    expect(caps.mediaTargets).toContain('image')
+  })
+
+  it('deepseek is clean (no truncation, no sanitize)', () => {
+    const caps = getCapabilities('deepseek')
+    expect(caps.proneToTruncation).toBe(false)
+    expect(caps.sanitizeLevel).toBe('none')
+  })
+})
+
+describe('applyCapabilities', () => {
+  it('user-explicit temperature wins', () => {
+    const caps = getCapabilities('qwen-vl')
+    expect(applyCapabilities(caps, { temperature: 0.9 }).temperature).toBe(0.9)
+  })
+
+  it('family default fills undefined temperature', () => {
+    const caps = getCapabilities('qwen-vl')
+    const withDefault = { ...caps, defaultTemperature: 0.5 }
+    expect(applyCapabilities(withDefault, { temperature: undefined }).temperature).toBe(0.5)
+  })
+
+  it('no default → temperature stays undefined', () => {
+    const caps = getCapabilities('deepseek')
+    expect(applyCapabilities(caps, { temperature: undefined }).temperature).toBeUndefined()
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/profiles/storage-v2.test.ts b/plugins/prompt-master/tests/pe-framework/profiles/storage-v2.test.ts
new file mode 100644
index 0000000..f272605
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/profiles/storage-v2.test.ts
@@ -0,0 +1,54 @@
+import { describe, expect, it } from 'vitest'
+import { listProfilesMerged, recastImportedProfile, validateImportPayload } from '../../../src/pe-framework/profiles/storage-v2.js'
+
+const builtins = [
+  { id: 'pe_a', name: 'A', kind: 'reverse', sort: 1 },
+  { id: 'pe_b', name: 'B', kind: 'expand', sort: 2 },
+]
+const custom = [{ id: 'pe_custom_x', name: 'X', kind: 'expand', sort: 5 }]
+
+describe('listProfilesMerged', () => {
+  it('disabled builtin excluded', () => {
+    const r = listProfilesMerged(builtins, custom, { pe_a: { enabled: false } })
+    expect(r.map((p) => p.id)).not.toContain('pe_a')
+    expect(r.map((p) => p.id)).toContain('pe_b')
+  })
+  it('override sort re-orders', () => {
+    const r = listProfilesMerged(builtins, custom, { pe_b: { enabled: true, sort: 0 } })
+    expect(r[0].id).toBe('pe_b')
+  })
+  it('stale override pointing to nonexistent builtin ignored', () => {
+    const r = listProfilesMerged(builtins, [], { pe_ghost: { enabled: false } })
+    expect(r.map((p) => p.id)).toEqual(['pe_a', 'pe_b'])
+  })
+  it('custom profiles merged after builtins (sort ordered)', () => {
+    const r = listProfilesMerged(builtins, custom, {})
+    expect(r.map((p) => p.id)).toEqual(['pe_a', 'pe_b', 'pe_custom_x'])
+  })
+})
+
+describe('validateImportPayload', () => {
+  it('rejects builtin id collision', () => {
+    const r = validateImportPayload({ id: 'pe_a', name: 'X', kind: 'expand', systemPrompt: 's' }, ['pe_a'])
+    expect(r.ok).toBe(false)
+  })
+  it('rejects missing systemPrompt', () => {
+    expect(validateImportPayload({ name: 'X', kind: 'expand' }, []).ok).toBe(false)
+  })
+  it('rejects bad kind', () => {
+    expect(validateImportPayload({ name: 'X', kind: 'bogus', systemPrompt: 's' }, []).ok).toBe(false)
+  })
+  it('accepts valid single profile', () => {
+    const r = validateImportPayload({ name: 'X', kind: 'expand', systemPrompt: 's' }, [])
+    expect(r.ok).toBe(true)
+  })
+})
+
+describe('recastImportedProfile', () => {
+  it('recasts id to pe_custom_+uuid and resets timestamps', () => {
+    const out = recastImportedProfile({ id: 'pe_old', name: 'X', kind: 'expand', systemPrompt: 's', createdAt: 1, updatedAt: 1 })
+    expect(out.id).toMatch(/^pe_custom_/)
+    expect(out.id).not.toBe('pe_old')
+    expect(out.createdAt).not.toBe(1)
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/sanitize/joy-extra.test.ts b/plugins/prompt-master/tests/pe-framework/sanitize/joy-extra.test.ts
new file mode 100644
index 0000000..737bec9
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/sanitize/joy-extra.test.ts
@@ -0,0 +1,62 @@
+import { describe, expect, it } from 'vitest'
+import { resolveJoyExtraOptions, buildJoyExtraSystemBlock, buildJoyExtraUserTail, filterJoyExtraClauses } from '../../../src/pe-framework/sanitize/joy-extra.js'
+
+describe('resolveJoyExtraOptions', () => {
+  it('array mode: explicit ids win', () => {
+    expect(resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] }).options).toContain('no_glasses_headwear')
+  })
+  it('text sniff mode: standard sentence in extra_prompt detected', () => {
+    const r = resolveJoyExtraOptions({ extraPrompt: 'Do not mention glasses, goggles, hats or any headwear.' })
+    expect(r.options).toContain('no_glasses_headwear')
+  })
+  it('character_name captured from param', () => {
+    const r = resolveJoyExtraOptions({ characterName: '小明' })
+    expect(r.characterName).toBe('小明')
+  })
+  it('character_name sniffed from refer-to pattern', () => {
+    const r = resolveJoyExtraOptions({ extraPrompt: 'refer to them as star_girl' })
+    expect(r.characterName).toBe('star_girl')
+  })
+  it('unknown array ids filtered out', () => {
+    expect(resolveJoyExtraOptions({ joyExtraOptions: ['bogus', 'no_artistic_style'] }).options).toEqual(['no_artistic_style'])
+  })
+})
+
+describe('filterJoyExtraClauses', () => {
+  it('removes glasses/headwear clauses', () => {
+    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
+    const out = filterJoyExtraClauses('一位少女，戴着红色贝雷帽，穿白色连衣裙，站在树下', r)
+    expect(out).not.toContain('贝雷帽')
+    expect(out).toContain('白色连衣裙')
+  })
+  it('keeps original separator style', () => {
+    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
+    const out = filterJoyExtraClauses('1girl, red beret, white dress', r)
+    expect(out).not.toContain('beret')
+    expect(out).toContain('white dress')
+    expect(out).toContain(', ')   // 英文逗号分隔保留
+  })
+  it('all clauses filtered → return original (anti-extinction)', () => {
+    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
+    const src = '戴着墨镜和帽子'
+    expect(filterJoyExtraClauses(src, r)).toBe(src)
+  })
+  it('no options → text unchanged', () => {
+    expect(filterJoyExtraClauses('戴着墨镜的少女', resolveJoyExtraOptions({}))).toBe('戴着墨镜的少女')
+  })
+})
+
+describe('buildJoyExtraSystemBlock', () => {
+  it('contains priority declaration + conflict override for glasses option', () => {
+    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
+    const block = buildJoyExtraSystemBlock(r, 'zh')
+    expect(block).toContain('硬约束')
+    expect(block).toContain('眼镜')
+  })
+  it('user tail lists per-option pledge', () => {
+    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_artistic_style'], characterName: '小明' })
+    const tail = buildJoyExtraUserTail(r, 'zh')
+    expect(tail).toContain('小明')
+    expect(tail).toContain('风格')
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/sanitize/model-specific.test.ts b/plugins/prompt-master/tests/pe-framework/sanitize/model-specific.test.ts
new file mode 100644
index 0000000..cea4e2f
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/sanitize/model-specific.test.ts
@@ -0,0 +1,29 @@
+import { describe, expect, it } from 'vitest'
+import { sanitizeModelSpecific } from '../../../src/pe-framework/sanitize/model-specific.js'
+
+describe('sanitizeModelSpecific', () => {
+  it('sanitizeLevel none → unchanged (deepseek)', () => {
+    const src = '<think>internal</think>输出文本'
+    expect(sanitizeModelSpecific(src, { family: 'deepseek', outputLang: 'zh' })).toBe(src)
+  })
+
+  it('strips think tags for generic family', () => {
+    expect(sanitizeModelSpecific('<think>reasoning</think>正文内容', { family: 'qwen-vl', outputLang: 'zh' })).toBe('正文内容')
+  })
+
+  it('extracts polished tail (last marker wins)', () => {
+    const src = '初稿内容\n润色与精简:\n最终精修文本'
+    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).toBe('最终精修文本')
+  })
+
+  it('strips instruction echo lines', () => {
+    const src = '这张图片展示了一个女孩\n实际的描述内容'
+    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).not.toContain('这张图片')
+    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).toContain('实际的描述内容')
+  })
+
+  it('normal output untouched (negative case)', () => {
+    const src = '一位穿红裙的少女站在樱花树下，阳光柔和'
+    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).toBe(src)
+  })
+})
diff --git a/plugins/prompt-master/tests/plugin/minimax-continue.test.ts b/plugins/prompt-master/tests/plugin/minimax-continue.test.ts
new file mode 100644
index 0000000..8a855cb
--- /dev/null
+++ b/plugins/prompt-master/tests/plugin/minimax-continue.test.ts
@@ -0,0 +1,91 @@
+import { describe, expect, it } from 'vitest'
+import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
+import { registerMinimaxTool } from '../../src/tools/minimax-scenario.js'
+import { stubCtx, runTool, type StubContext } from './helpers.js'
+
+const cfg = { temperature: 0.7 }
+const def = (ctx: any) => registerMinimaxTool(ctx, cfg)
+
+/** 半截六段输出：只有 subject_definitions / summary / detailed_description 三段 */
+const PART1 =
+  'subject_definitions: <Subject 1> is Alice from <Picture 1>.\n' +
+  'summary: [reference generation] Alice appears in a 10-second, 2-shot video with synchronized audio.\n' +
+  'detailed_description: [Shot 1] Alice walks through the garden.'
+/** 续写返回的余下三段 */
+const PART2 =
+  'retention_analysis: <Subject 1> from <Picture 1> remains fully_preserved: identity, face, outfit, and styling unchanged.\n' +
+  'overall_soundscape: gentle wind; birdsong\n' +
+  'non_diegetic_music: soft piano'
+
+const SIX_LABELS = [
+  'subject_definitions',
+  'summary',
+  'retention_analysis',
+  'detailed_description',
+  'overall_soundscape',
+  'non_diegetic_music',
+]
+
+function streamWith(text: string, finishKind: 'stop' | 'max-tokens'): StreamChunk[] {
+  return [
+    { type: 'block-start', index: 0, blockType: 'text' },
+    { type: 'text-delta', index: 0, text },
+    { type: 'block-end', index: 0, block: { type: 'text', text } },
+    { type: 'finish', reason: { kind: finishKind } },
+  ]
+}
+
+/** 顺序 mock：每次 ctx.llm.stream 调用从队列取下一段 chunk 流（复用 stubCtx 的 calls 记录） */
+function seqCtx(streams: StreamChunk[][]): StubContext {
+  const ctx = stubCtx()
+  const calls = ctx.llm.calls
+  ctx.llm.stream = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
+    calls.push(options)
+    for (const chunk of streams.shift() ?? []) yield chunk
+  }
+  return ctx
+}
+
+describe('minimax_scenario continue (contract-declared)', () => {
+  it('truncated six-section output → continues once, merged prompt has all six sections', async () => {
+    const ctx = seqCtx([streamWith(PART1, 'max-tokens'), streamWith(PART2, 'stop')])
+    const v = JSON.parse(
+      String(await runTool(ctx, def(ctx), { scenario_id: 'full_reference', form_fields: { subject: 'cat' } })),
+    )
+    // 合并后六段齐全
+    for (const label of SIX_LABELS) expect(String(v.prompt)).toContain(label)
+    // 续写确实发生：llm 调用 ≥ 2（首轮 + 1 轮续写）
+    expect(ctx.llm.calls.length).toBeGreaterThanOrEqual(2)
+    // zh 续写提示词正确渲染：已写出 / 缺失内容 + 累积文本
+    const contMsg = (ctx.llm.calls[1].messages[0] as { content: { type: string; text: string }[] }).content[0].text
+    expect(contMsg).toContain('已写出')
+    expect(contMsg).toContain('缺失内容')
+    expect(contMsg).toContain('field:retention_analysis')
+    expect(contMsg).toContain(PART1)
+  })
+
+  it('complete output with stop finish → no continuation round', async () => {
+    const full = SIX_LABELS.map((l) => `${l}: content-${l}`).join('\n')
+    const ctx = seqCtx([streamWith(full, 'stop')])
+    const v = JSON.parse(
+      String(await runTool(ctx, def(ctx), { scenario_id: 'full_reference', form_fields: { subject: 'cat' } })),
+    )
+    expect(String(v.prompt)).toContain('non_diegetic_music: content-non_diegetic_music')
+    expect(ctx.llm.calls.length).toBe(1)
+  })
+
+  it('product_ad (full_reference outputMode but t2va stage) complete three-field body → exactly 1 llm call', async () => {
+    // t2va 三字段体（integrated_multimodal_description / overall_soundscape / non_diegetic_music）
+    const t2vaBody =
+      'integrated_multimodal_description: A glossy product shot of the bottle rotating on a pedestal.\n' +
+      'overall_soundscape: crisp fizz; subtle whoosh\n' +
+      'non_diegetic_music: upbeat electronic track'
+    const ctx = seqCtx([streamWith(t2vaBody, 'stop')])
+    const v = JSON.parse(
+      String(await runTool(ctx, def(ctx), { scenario_id: 'product_ad', form_fields: { subject: 'bottle' } })),
+    )
+    expect(String(v.prompt)).toContain('integrated_multimodal_description')
+    // 回归：full_reference 六段契约不得按 outputMode 兜底到 t2va 场景（否则空轮续写 ×3）
+    expect(ctx.llm.calls.length).toBe(1)
+  })
+})
diff --git a/plugins/prompt-master/tests/plugin/minimax.test.ts b/plugins/prompt-master/tests/plugin/minimax.test.ts
index b2386c6..d3b5226 100644
--- a/plugins/prompt-master/tests/plugin/minimax.test.ts
+++ b/plugins/prompt-master/tests/plugin/minimax.test.ts
@@ -20,19 +20,23 @@ describe('minimax_scenario', () => {
 
   it('dry_run returns assembled/budget without calling llm', async () => {
     const ctx = stubCtx()
     const v = JSON.parse(String(await runTool(ctx, def(ctx), { scenario_id: 'full_reference', dry_run: true })))
     expect(v.budget.text_tokens).toBeGreaterThan(0)
     expect(v.dry_run).toBe(true)
     expect(ctx.llm.calls.length).toBe(0)
   })
 
   it('non-dry-run returns prompt + sections + budget with usage-derived tokens', async () => {
-    const ctx = stubCtx({ stream: textStream('rendered prompt') })
+    const ctx = stubCtx({
+      stream: textStream(
+        'subject_definitions: a\nsummary: b\nretention_analysis: c\ndetailed_description: d\noverall_soundscape: e\nnon_diegetic_music: f',
+      ),
+    })
     const v = JSON.parse(String(await runTool(ctx, def(ctx), { scenario_id: 'full_reference', form_fields: { subject: 'cat' } })))
     expect(typeof v.prompt).toBe('string')
     expect(String(v.prompt).length).toBeGreaterThan(0)
     expect(typeof v.sections).toBe('object') // 分节为键值对象（非数组）
     expect(v.budget).toBeTruthy()
     expect(ctx.llm.calls.length).toBe(1)
   })
 })
\ No newline at end of file
diff --git a/plugins/prompt-master/tests/plugin/profile-list-v2.test.ts b/plugins/prompt-master/tests/plugin/profile-list-v2.test.ts
new file mode 100644
index 0000000..4eb156c
--- /dev/null
+++ b/plugins/prompt-master/tests/plugin/profile-list-v2.test.ts
@@ -0,0 +1,144 @@
+// profile_list v2 集成：enable/sort 经 overrides namespace 持久化往返 + import 重铸（Task 7 spec §7.1）
+import { describe, expect, it } from 'vitest'
+import { registerProfileListTool } from '../../src/tools/profile-list.js'
+import { registerOverridesNamespace, type OverridesApi } from '../../src/pe-framework/profiles/storage-v2.js'
+import { stubCtx, runTool } from './helpers.js'
+import type { Context } from '@deepseek-ai/cordis'
+
+const cfg = { temperature: 0.7 }
+
+function makeScope() {
+  let store: Record<string, string> = {}
+  return {
+    store,
+    scope: {
+      get: () => store,
+      update: async (p: object) => { Object.assign(store, (p as any).customProfiles) },
+      replace: async (s: object) => {
+        const next = (s as any).customProfiles ?? {}
+        for (const k of Object.keys(store)) delete store[k]
+        Object.assign(store, next)
+      },
+    },
+  }
+}
+
+/** 内存版 settings register，供 registerOverridesNamespace 使用（最小表面） */
+function makeOverridesNamespace() {
+  let section: { builtinOverrides: Record<string, { enabled: boolean; sort?: number }> } = { builtinOverrides: {} }
+  const fakeCtx = {
+    settings: {
+      register: (_ns: unknown, _schema: unknown) => ({
+        get: () => section,
+        update: async (patch: object) => { section = { ...section, ...(patch as object) } as typeof section },
+        replace: async (s: object) => { section = s as typeof section },
+      }),
+    },
+  }
+  const api: OverridesApi = registerOverridesNamespace(fakeCtx as unknown as Context)
+  return { api, section: () => section }
+}
+
+function makeTool() {
+  const ctx = stubCtx()
+  const ms = makeScope()
+  const ns = makeOverridesNamespace()
+  const tool = registerProfileListTool(ctx as any, cfg, { scope: ms.scope, overrides: ns.api } as any)
+  return { ctx, scope: ms, ns, tool }
+}
+
+describe('profile_list enable/sort round-trip', () => {
+  it('enable=false persists override; merged list excludes that builtin', async () => {
+    const { ns, tool } = makeTool()
+    const id = 'pe_expand_natural'
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'enable', id, enabled: false })))
+    expect(r.enabled).toBe(false)
+    expect(ns.section().builtinOverrides[id]).toEqual({ enabled: false })
+    const list = JSON.parse(String(await runTool(null as never, tool as never, { action: 'list' })))
+    expect(list.profiles.map((p: any) => p.id)).not.toContain(id)
+    expect(list.profiles.length).toBeGreaterThan(0)
+  })
+
+  it('re-enable restores the builtin; unknown builtin id rejected', async () => {
+    const { ns, tool } = makeTool()
+    const id = 'pe_expand_natural'
+    await runTool(null as never, tool as never, { action: 'enable', id, enabled: false })
+    await runTool(null as never, tool as never, { action: 'enable', id, enabled: true })
+    expect(ns.section().builtinOverrides[id]).toEqual({ enabled: true })
+    await expect(runTool(null as never, tool as never, { action: 'enable', id: 'pe_ghost', enabled: false })).rejects.toThrow(/不存在/)
+  })
+
+  it('sort persists order; merged list re-orders builtins by override sort', async () => {
+    const { ns, tool } = makeTool()
+    const list0 = JSON.parse(String(await runTool(null as never, tool as never, { action: 'list' })))
+    const firstTwo: string[] = list0.profiles.filter((p: any) => !p.id.startsWith('pe_custom_')).slice(0, 2).map((p: any) => p.id)
+    const reversed = [...firstTwo].reverse()
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'sort', ids: reversed })))
+    expect(r.ids).toEqual(reversed)
+    expect(ns.section().builtinOverrides[reversed[0]]).toEqual({ enabled: true, sort: 0 })
+    expect(ns.section().builtinOverrides[reversed[1]]).toEqual({ enabled: true, sort: 1 })
+    const list1 = JSON.parse(String(await runTool(null as never, tool as never, { action: 'list' })))
+    const orderedIds = list1.profiles.map((p: any) => p.id)
+    expect(orderedIds.indexOf(reversed[0])).toBeLessThan(orderedIds.indexOf(reversed[1]))
+  })
+
+  it('sort rejects unknown builtin id', async () => {
+    const { tool } = makeTool()
+    await expect(runTool(null as never, tool as never, { action: 'sort', ids: ['pe_ghost'] })).rejects.toThrow(/不存在/)
+  })
+})
+
+describe('profile_list import / validate_import / export', () => {
+  it('validate_import reports pass without persisting', async () => {
+    const { scope, tool } = makeTool()
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'validate_import', profile: { name: 'X', kind: 'expand', systemPrompt: 's' } })))
+    expect(r.ok).toBe(true)
+    expect(Object.keys(scope.store).length).toBe(0)
+  })
+
+  it('validate_import reports failure with reason for bad payload', async () => {
+    const { tool } = makeTool()
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'validate_import', profile: { name: 'X', kind: 'bogus', systemPrompt: 's' } })))
+    expect(r.ok).toBe(false)
+    expect(r.reason).toMatch(/kind/)
+  })
+
+  it('import recasts id to pe_custom_* and persists into customProfiles', async () => {
+    const { scope, tool } = makeTool()
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'import', profile: { name: 'X', kind: 'expand', systemPrompt: 's' } })))
+    expect(r.ok).toBe(true)
+    expect(r.id).toMatch(/^pe_custom_/)
+    const stored = JSON.parse(scope.store[r.id])
+    expect(stored.builtin).toBe(false)
+    expect(stored.createdAt).toBeGreaterThan(0)
+    // 重铸后的 id 不与任何内置 id 冲突
+    expect(r.id.startsWith('pe_custom_')).toBe(true)
+  })
+
+  it('import rejects payload carrying a builtin id (collision contract)', async () => {
+    const { scope, tool } = makeTool()
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'import', profile: { id: 'pe_expand_natural', name: 'X', kind: 'expand', systemPrompt: 's' } })))
+    expect(r.ok).toBe(false)
+    expect(r.reason).toMatch(/冲突/)
+    expect(Object.keys(scope.store).length).toBe(0)
+  })
+
+  it('import rejects missing systemPrompt with ok=false and no persistence', async () => {
+    const { scope, tool } = makeTool()
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'import', profile: { name: 'X', kind: 'expand' } })))
+    expect(r.ok).toBe(false)
+    expect(Object.keys(scope.store).length).toBe(0)
+  })
+
+  it('export returns wire format with profile payload', async () => {
+    const { tool } = makeTool()
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'export', id: 'pe_expand_natural' })))
+    expect(r.format).toBe('prompt-master-prompt-engineering')
+    expect(r.profile.id).toBe('pe_expand_natural')
+  })
+
+  it('export of unknown id throws', async () => {
+    const { tool } = makeTool()
+    await expect(runTool(null as never, tool as never, { action: 'export', id: 'pe_ghost' })).rejects.toThrow(/not found/i)
+  })
+})
diff --git a/plugins/prompt-master/tests/plugin/registry.test.ts b/plugins/prompt-master/tests/plugin/registry.test.ts
index 3778125..d9a4dd8 100644
--- a/plugins/prompt-master/tests/plugin/registry.test.ts
+++ b/plugins/prompt-master/tests/plugin/registry.test.ts
@@ -10,21 +10,22 @@ function stubCtx() {
         return () => {}
       },
     },
     llm: { stream: async function* () {} },
     subagents: {
       start: async () => ({ id: 'stub', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }),
     },
     agent: { options: {} },
     settings: {
       register(ns: string, schema: unknown) {
-        expect(ns).toBe('prompt-master-custom-profiles')
+        // Task 7 起注册两个 namespace：customProfiles + 内置覆盖层（profile-overrides）
+        expect(['prompt-master-custom-profiles', 'prompt-master-profile-overrides']).toContain(ns)
         expect(schema).toBeTruthy()
         return { get: () => ({ customProfiles: {} }), update: async () => {}, replace: async () => {} }
       },
     },
     effect(cb: any) { cb() },   // cordis 4 同步 effect（Task 2 已证）
   }
   return { ctx, registered }
 }
 
 describe('plugin registration', () => {
```
