# Review package - ae2e808..108c11f

## Commits
``````

## Stat
``` .../src/pe-framework/continue/engine.ts            | 16 ++++--
 .../src/pe-framework/continue/inspect.ts           | 16 +++++-
 plugins/prompt-master/src/plugin/index.ts          |  4 ++
 .../prompt-master/src/resolver/profiles/index.ts   |  8 +++
 .../prompt-master/src/tools/minimax-scenario.ts    |  1 +
 .../pe-framework/continue/continue-engine.test.ts  | 57 ++++++++++++++++++++++
 .../tests/pe-framework/profiles/storage-v2.test.ts | 20 +++++++-
 7 files changed, 115 insertions(+), 7 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/continue/engine.ts b/plugins/prompt-master/src/pe-framework/continue/engine.ts
index 658c50e..9fce86f 100644
--- a/plugins/prompt-master/src/pe-framework/continue/engine.ts
+++ b/plugins/prompt-master/src/pe-framework/continue/engine.ts
@@ -7,56 +7,62 @@ type FinishKind = 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'
 /**
  * Structure-aware continuation loop.
  *
  * Trigger: contract inspection incomplete OR finishKind === 'max-tokens'
  * (max-tokens continues even if structurally complete — dark-truncation guard).
  * Each round sends a SINGLE user message carrying the accumulated full text
  * plus the missing list. Pure async orchestration: zero logging; the caller
  * observes rounds via onContinue.
  *
  * Abort semantics: signal.throwIfAborted at round start; abort inside generate
- * propagates via the caller's signal (generate throws → rethrow, with
- * CONTINUE_ABORTED_PARTIAL warning if some continuation text was already
- * merged); post-round signal.aborted check returns the partial result.
+ * propagates via the caller's signal; post-round signal.aborted check returns
+ * the partial result. Generate errors: partial merged text is returned with
+ * CONTINUE_PARTIAL_BEFORE_ERROR (rethrow only if nothing was merged yet).
  */
 export async function continueUntilComplete(params: {
   contract: OutputContract
   initialText: string
   finishKind: FinishKind
   seed: ContinueSeed
   generate: (req: { system?: string; user: string }) => Promise<{ text: string; finishKind: FinishKind }>
   maxRounds?: number
   signal: AbortSignal
   onContinue?: (round: number, maxRounds: number) => void
+  /** Request form fields, passed through to contract.expectedGroups (spec §3.2.3). */
+  formFields?: Record<string, unknown>
 }): Promise<ContinueOutcome> {
   const max = params.maxRounds ?? 3
   const warnings: string[] = []
   let text = params.initialText
   let finish = params.finishKind
   let rounds = 0
   while (rounds < max) {
-    const inspection = inspectOutput(text, params.contract)
+    const inspection = inspectOutput(text, params.contract, params.formFields)
     const shouldContinue = !inspection.complete || finish === 'max-tokens'
     if (!shouldContinue) break
     params.signal.throwIfAborted()
     rounds++
     params.onContinue?.(rounds, max)
     const missingList = inspection.missing.length > 0 ? inspection.missing.join(', ') : '（结构未知，可能有暗截断）'
     const instruction = params.seed.outputLang === 'en'
       ? `Already written (do NOT rewrite; continue from it): -----\n${text}\n-----\n\nMissing: ${missingList}. Continue from where it stops.`
       : `已写出（不要重写，基于它继续）：-----\n${text}\n-----\n\n缺失内容：${missingList}。请从缺失处继续输出，不要重复已有内容。`
     let piece: string
     try {
       const gen = await params.generate({ system: params.seed.system, user: instruction })
       piece = gen.text
       finish = gen.finishKind
     } catch (error) {
-      if (text !== params.initialText) warnings.push('CONTINUE_ABORTED_PARTIAL')
+      // generate 抛错时不丢弃已合并的续写文本：有部分结果则部分返回（spec §3.2.3）
+      if (text !== params.initialText) {
+        warnings.push('CONTINUE_PARTIAL_BEFORE_ERROR')
+        return { text, rounds, complete: false, warnings }
+      }
       throw error
     }
     text = mergeContinuedText(text, piece)
     if (params.signal.aborted) { warnings.push('CONTINUE_ABORTED_PARTIAL'); return { text, rounds, complete: false, warnings } }
   }
   const final = inspectOutput(text, params.contract)
   if (!final.complete || finish === 'max-tokens') warnings.push('INCOMPLETE_AFTER_MAX_ROUNDS')
   return { text, rounds, complete: final.complete && finish !== 'max-tokens', warnings }
 }
diff --git a/plugins/prompt-master/src/pe-framework/continue/inspect.ts b/plugins/prompt-master/src/pe-framework/continue/inspect.ts
index cc796e8..88f3d52 100644
--- a/plugins/prompt-master/src/pe-framework/continue/inspect.ts
+++ b/plugins/prompt-master/src/pe-framework/continue/inspect.ts
@@ -1,28 +1,42 @@
 import type { OutputContract, StructureInspection } from './contract.js'
 
 export type { OutputContract, StructureInspection }
 
 /**
  * Inspect a model output against a contract: every field pattern must hit,
  * and the text right after the hit label (up to end of line) must be a
  * non-empty body (>= 2 chars after trim), otherwise the field counts as missing.
  */
-export function inspectOutput(text: string, contract: OutputContract): StructureInspection {
+export function inspectOutput(text: string, contract: OutputContract, formFields?: Record<string, unknown>): StructureInspection {
   const missing: string[] = []
   for (const f of contract.fields) {
     const hit = f.patterns.some((re) => re.test(text))
     if (!hit) { missing.push(`field:${f.key}`); continue }
     // 标签体非空检查：取命中标签之后到下一个换行（或文末）的文本段
     for (const re of f.patterns) {
       const m = re.exec(text)
       if (m && m.index !== undefined) {
         const lineEnd = text.indexOf('\n', m.index)
         const body = text.slice(m.index + m[0].length, lineEnd === -1 ? undefined : lineEnd)
         // 仅空标签体视为缺失（单字符正文如 "X" 算有效内容 — 以测试为准）
         if (body.trim().length === 0) { missing.push(`field:${f.key}`) }
         break
       }
     }
   }
+  // 分组检查（如 director_segments）：组数 = 分隔符匹配数（前导段视为前言，不计入组）；
+  // 每组分隔符后须有非空正文
+  if (contract.groupSeparator) {
+    const sep = new RegExp(contract.groupSeparator.source, contract.groupSeparator.flags.includes('g') ? contract.groupSeparator.flags : contract.groupSeparator.flags + 'g')
+    const matches = [...text.matchAll(sep)]
+    const groupCount = matches.length
+    const expected = contract.expectedGroups?.(formFields ?? {}) ?? 0
+    if (groupCount < expected) missing.push(`groups:${groupCount}/${expected}`)
+    for (let i = 0; i < matches.length; i++) {
+      const m = matches[i]
+      const end = i + 1 < matches.length ? matches[i + 1].index! : text.length
+      if (text.slice(m.index! + m[0].length, end).trim().length === 0) missing.push(`group:${m[1] ?? i + 1}:body`)
+    }
+  }
   return { missing, complete: missing.length === 0 }
 }
diff --git a/plugins/prompt-master/src/plugin/index.ts b/plugins/prompt-master/src/plugin/index.ts
index e575503..34f41dd 100644
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
+import { setBuiltinFilter } from '../resolver/profiles/index.js'
 import { registerOverridesNamespace } from '../pe-framework/profiles/storage-v2.js'
 import '../pe-framework/dialect/anima.js'
 import '../pe-framework/dialect/h3.js'
 import { createDefaultIntentProvider } from '../pe-framework/intent/index.js'
 import { setPresetRoot } from '../pe-framework/resources/resolve.js'
 import { Config, type Config as ConfigShape } from './config.js'
 
 export const name = 'prompt-master'
 export const inject = ['tools', 'llm', 'settings', 'subagents']
 export { Config }
@@ -42,20 +43,23 @@ export function apply(ctx: Context, config: ConfigShape) {
     Object.entries(profileScope.get()).map(([id, profileJson]) => ({ id, profileJson })),
   )
 
   // R2: 装入默认 Intent Provider（intent 走 DSH one-shot subagent；ownerCtx 一次性绑定；返回 AuthorIntentFn 单参）
   //     必须早于 author 工具注册/调用 → 在 ctx.effect 之前完成
   setAuthorIntentProvider(createDefaultIntentProvider(ctx))
 
   // 内置覆盖层 namespace（Task 7 spec §7.1）→ 注入 profile_list 工具
   const overrides = registerOverridesNamespace(ctx)
 
+  // enable=false 必须同时作用于按 id 引用（resolveExpand/resolveReverse 走 findProfileById）
+  setBuiltinFilter((id) => overrides.all()[id]?.enabled === false)
+
   ctx.effect(() => {
     const disposers: (() => void)[] = []
     disposers.push(ctx.tools.register(registerExpandTool(ctx, config)))
     disposers.push(ctx.tools.register(registerReverseTool(ctx, config)))
     disposers.push(ctx.tools.register(registerMinimaxTool(ctx, config)))
     disposers.push(ctx.tools.register(registerProfileListTool(ctx, config, { scope: profileScope, overrides })))
     disposers.push(ctx.tools.register(registerAuthorTool(ctx, config)))
     disposers.push(ctx.tools.register(registerCompileTool(ctx)))
     disposers.push(ctx.tools.register(registerCatalogSearchTool(ctx, config)))
     disposers.push(ctx.tools.register(registerAuditTool(ctx, config)))
diff --git a/plugins/prompt-master/src/resolver/profiles/index.ts b/plugins/prompt-master/src/resolver/profiles/index.ts
index 8cfce30..cacb2eb 100644
--- a/plugins/prompt-master/src/resolver/profiles/index.ts
+++ b/plugins/prompt-master/src/resolver/profiles/index.ts
@@ -153,21 +153,29 @@ function safeListCustomProfiles(): any[] {
   } catch {
     return []
   }
 }
 
 /** 清除缓存以让 custom_profiles 变更生效 */
 export function clearProfileCache(): void {
   cached = null;
 }
 
+/** 内置 Profile 过滤器（enable=false 时使 findProfileById 对该 id 返回 undefined） */
+let builtinFilter: ((id: string) => boolean) | undefined;
+
+export function setBuiltinFilter(filter: ((id: string) => boolean) | undefined): void {
+  builtinFilter = filter;
+}
+
 export function findProfileById(id: string): PEProfile | undefined {
+  if (builtinFilter?.(id)) return undefined;
   return getDefaultBuiltinProfiles().find((p) => p.id === id);
 }
 
 export function filterProfilesByKind(kind: string): PEProfile[] {
   const k = String(kind || '').trim();
   return getDefaultBuiltinProfiles().filter((p) => {
     if (!p.enabled) return false;
     // 设计 §3.3 的 kind 枚举含 'minimax'；MiniMax 场景的 kind 为 'expand'，按 minimaxScenarioId 识别
     if (k === 'minimax') return !!p.minimaxScenarioId;
     return p.kind === k;
diff --git a/plugins/prompt-master/src/tools/minimax-scenario.ts b/plugins/prompt-master/src/tools/minimax-scenario.ts
index dc3e9c0..9b3116d 100644
--- a/plugins/prompt-master/src/tools/minimax-scenario.ts
+++ b/plugins/prompt-master/src/tools/minimax-scenario.ts
@@ -91,20 +91,21 @@ export function registerMinimaxTool(ctx: Context, config: Config) {
           finishKind: finish.kind,
           seed: { system: expanded.system, userText: expanded.user, outputLang: language === 'en' ? 'en' : 'zh' },
           generate: async (req) => {
             const g = await complete(ctx, {
               provider, model, system: req.system ?? expanded.system, user: req.user,
               maxTokens: expanded.maxTokens, temperature: effectiveParams.temperature, signal: exec.signal,
             })
             return { text: g.text, finishKind: g.finish.kind }
           },
           signal: exec.signal,
+          formFields: args.form_fields || {},
           onContinue: (n, max) => ctx.logger?.info?.(`[prompt-master] continue round=${n}/${max}`),
         })
         text = outcome.text
         continueRounds = outcome.rounds
         continueComplete = outcome.complete
         ctx.logger?.info?.(`[prompt-master] minimax_scenario → continue complete=${outcome.complete} rounds=${continueRounds}`)
       }
       const char_count = countChars(text)
       return JSON.stringify({
         prompt: text,
diff --git a/plugins/prompt-master/tests/pe-framework/continue/continue-engine.test.ts b/plugins/prompt-master/tests/pe-framework/continue/continue-engine.test.ts
index e00ef00..c5c1e3c 100644
--- a/plugins/prompt-master/tests/pe-framework/continue/continue-engine.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/continue/continue-engine.test.ts
@@ -27,20 +27,52 @@ describe('inspectOutput', () => {
     expect(r.complete).toBe(false)
     expect(r.missing).toContain('field:retention_analysis')
   })
 
   it('label with empty body (<2 chars) counts as missing', () => {
     const text = 'subject_definitions: X\nsummary:\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
     expect(inspectOutput(text, sixSegment).missing).toContain('field:summary')
   })
 })
 
+describe('inspectOutput groupSeparator (director_segments)', () => {
+  const director: OutputContract = {
+    id: 'minimax-director-segments', fields: [],
+    groupSeparator: /={3,}\s*提示词组\s*(\d+)\s*={3,}/g,
+    expectedGroups: (ff) => Number(ff?.segment_count ?? 4),
+  }
+
+  it('director contract: 3/4 groups → groups:3/4 missing', () => {
+    const text = '前言\n===== 提示词组 1 =====\nA\n===== 提示词组 2 =====\nB\n===== 提示词组 3 =====\nC'
+    const r = inspectOutput(text, director, { segment_count: 4 })
+    expect(r.complete).toBe(false)
+    expect(r.missing.some(m => m.includes('3/4'))).toBe(true)
+  })
+
+  it('director contract: all 4 groups present → complete', () => {
+    const text = '前言\n===== 提示词组 1 =====\nA\n===== 提示词组 2 =====\nB\n===== 提示词组 3 =====\nC\n===== 提示词组 4 =====\nD'
+    expect(inspectOutput(text, director, { segment_count: 4 }).complete).toBe(true)
+  })
+
+  it('empty group body → group:<n>:body missing', () => {
+    const text = '===== 提示词组 1 =====\nA\n===== 提示词组 2 =====\n   '
+    const r = inspectOutput(text, director, { segment_count: 2 })
+    expect(r.missing).toContain('group:2:body')
+    expect(r.complete).toBe(false)
+  })
+
+  it('text starting with separator → leading segment absent, no phantom group', () => {
+    const text = '===== 提示词组 1 =====\nA\n===== 提示词组 2 =====\nB'
+    expect(inspectOutput(text, director, { segment_count: 2 }).complete).toBe(true)
+  })
+})
+
 describe('mergeContinuedText', () => {
   it('model parrots full text → take continued only', () => {
     expect(mergeContinuedText('ABC', 'ABCDEF')).toBe('ABCDEF')
   })
   it('suffix-prefix overlap 12+ chars → dedupe join', () => {
     const prev = 'A'.repeat(200) + 'TAIL-COMMON-SEGMENT-XXXX'
     const cont = 'TAIL-COMMON-SEGMENT-XXXX' + 'B'.repeat(50)
     const merged = mergeContinuedText(prev, cont)
     expect(merged).toBe(prev + 'B'.repeat(50))
   })
@@ -89,20 +121,45 @@ describe('continueUntilComplete', () => {
       generate: async (req) => {
         ctl.abort()
         return { text: 'summary: Y', finishKind: 'stop' as const }
       },
       signal: ctl.signal,
     })
     expect(r.complete).toBe(false)
     expect(r.warnings).toContain('CONTINUE_ABORTED_PARTIAL')
   })
 
+  it('generate throws after mergeable piece → partial result returned (not throw)', async () => {
+    let n = 0
+    const r = await continueUntilComplete({
+      contract: sixSegment, initialText: 'subject_definitions: X\nsummary: Y', finishKind: 'max-tokens', seed,
+      generate: async () => {
+        n++
+        if (n === 1) return { text: 'retention_analysis: Z', finishKind: 'max-tokens' as const }
+        throw new Error('llm exploded mid-continuation')
+      },
+      signal: new AbortController().signal,
+    })
+    expect(r.complete).toBe(false)
+    expect(r.warnings).toContain('CONTINUE_PARTIAL_BEFORE_ERROR')
+    expect(r.text).toContain('retention_analysis: Z')
+    expect(r.rounds).toBe(2)
+  })
+
+  it('generate throws before any merge → rethrows', async () => {
+    await expect(continueUntilComplete({
+      contract: sixSegment, initialText: 'subject_definitions: X', finishKind: 'max-tokens', seed,
+      generate: async () => { throw new Error('boom') },
+      signal: new AbortController().signal,
+    })).rejects.toThrow('boom')
+  })
+
   it('max rounds exhausted → INCOMPLETE_AFTER_MAX_ROUNDS', async () => {
     let n = 0
     const r = await continueUntilComplete({
       contract: sixSegment, initialText: 'x', finishKind: 'max-tokens', seed, maxRounds: 2,
       generate: async () => { n++; return { text: `chunk${n}`, finishKind: 'max-tokens' as const } },
       signal: new AbortController().signal,
     })
     expect(r.complete).toBe(false)
     expect(r.warnings).toContain('INCOMPLETE_AFTER_MAX_ROUNDS')
     expect(r.rounds).toBe(2)
diff --git a/plugins/prompt-master/tests/pe-framework/profiles/storage-v2.test.ts b/plugins/prompt-master/tests/pe-framework/profiles/storage-v2.test.ts
index f272605..1b26786 100644
--- a/plugins/prompt-master/tests/pe-framework/profiles/storage-v2.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/profiles/storage-v2.test.ts
@@ -1,12 +1,13 @@
-import { describe, expect, it } from 'vitest'
+import { describe, expect, it, afterEach } from 'vitest'
 import { listProfilesMerged, recastImportedProfile, validateImportPayload } from '../../../src/pe-framework/profiles/storage-v2.js'
+import { setBuiltinFilter, findProfileById } from '../../../src/resolver/profiles/index.js'
 
 const builtins = [
   { id: 'pe_a', name: 'A', kind: 'reverse', sort: 1 },
   { id: 'pe_b', name: 'B', kind: 'expand', sort: 2 },
 ]
 const custom = [{ id: 'pe_custom_x', name: 'X', kind: 'expand', sort: 5 }]
 
 describe('listProfilesMerged', () => {
   it('disabled builtin excluded', () => {
     const r = listProfilesMerged(builtins, custom, { pe_a: { enabled: false } })
@@ -45,10 +46,27 @@ describe('validateImportPayload', () => {
 })
 
 describe('recastImportedProfile', () => {
   it('recasts id to pe_custom_+uuid and resets timestamps', () => {
     const out = recastImportedProfile({ id: 'pe_old', name: 'X', kind: 'expand', systemPrompt: 's', createdAt: 1, updatedAt: 1 })
     expect(out.id).toMatch(/^pe_custom_/)
     expect(out.id).not.toBe('pe_old')
     expect(out.createdAt).not.toBe(1)
   })
 })
+
+describe('setBuiltinFilter (findProfileById consults overrides)', () => {
+  afterEach(() => setBuiltinFilter(undefined))
+
+  it('filtered id → findProfileById returns undefined', () => {
+    expect(findProfileById('pe_reverse_descriptive')).toBeDefined()
+    setBuiltinFilter((id) => id === 'pe_reverse_descriptive')
+    expect(findProfileById('pe_reverse_descriptive')).toBeUndefined()
+    expect(findProfileById('pe_reverse_sd')).toBeDefined()
+  })
+
+  it('setBuiltinFilter(undefined) restores lookup', () => {
+    setBuiltinFilter((id) => id === 'pe_reverse_descriptive')
+    setBuiltinFilter(undefined)
+    expect(findProfileById('pe_reverse_descriptive')).toBeDefined()
+  })
+})
```
