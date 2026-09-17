# Review package — Absorb T3 (base 86b02ae..e08875b)

## Commits
```e08875b feat(prompt-master): wire continue engine into minimax scenarios (contract-declared)
```n
## Stat
``` .../src/pe-framework/schema/scenes.ts              | 33 ++++++++++
 .../prompt-master/src/tools/minimax-scenario.ts    | 30 ++++++++-
 .../tests/plugin/minimax-continue.test.ts          | 76 ++++++++++++++++++++++
 plugins/prompt-master/tests/plugin/minimax.test.ts |  6 +-
 4 files changed, 143 insertions(+), 2 deletions(-)
```n
## Full diff (-U10)
```diff
diff --git a/plugins/prompt-master/src/pe-framework/schema/scenes.ts b/plugins/prompt-master/src/pe-framework/schema/scenes.ts
index aa1cb64..f5a49cf 100644
--- a/plugins/prompt-master/src/pe-framework/schema/scenes.ts
+++ b/plugins/prompt-master/src/pe-framework/schema/scenes.ts
@@ -2,20 +2,53 @@
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
+/** 场景 → 输出契约解析：先按场景 id，再按 outputMode（声明制，未声明 → undefined） */
+export function sceneOutputContract(scenarioId: string, outputMode?: string): OutputContract | undefined {
+  return SCENE_OUTPUT_CONTRACTS[scenarioId] ?? (outputMode ? SCENE_OUTPUT_CONTRACTS[outputMode] : undefined)
+}
 
 export interface SceneMap {
   scenarioId: string
   toShots(scenarioId: string, formFields: Record<string, unknown>, lang?: string): H3ShotsInput | null
 }
 
 const META_KEYS = [
   'duration_seconds', 'duration', 'seconds', '时长',
   'aspect_ratio', 'expand_mode', 'output_lang', 'prompt_language',
   'plan_mode', 'segment_count', 'segment_seconds', 'prompt_kind', 'copy_mode',
diff --git a/plugins/prompt-master/src/tools/minimax-scenario.ts b/plugins/prompt-master/src/tools/minimax-scenario.ts
index f316d36..dc3e9c0 100644
--- a/plugins/prompt-master/src/tools/minimax-scenario.ts
+++ b/plugins/prompt-master/src/tools/minimax-scenario.ts
@@ -1,15 +1,17 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
 import { listScenarios, getScenarioById, resolveMinimaxScenarioExpand } from '../resolver/minimax/index.js'
 import { countChars } from '../utils/length.js'
 import { complete } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
+import { sceneOutputContract } from '../pe-framework/schema/scenes.js'
+import { continueUntilComplete } from '../pe-framework/continue/engine.js'
 import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 
 const STAGE_BUDGETS: Record<string, { text_tokens: number; char_limit: number }> = {
   t2va: { text_tokens: 1200, char_limit: 7000 },
   i2va: { text_tokens: 1500, char_limit: 7000 },
   fl2va: { text_tokens: 1700, char_limit: 7000 },
   l2va: { text_tokens: 1700, char_limit: 7000 },
   ref2va: { text_tokens: 2400, char_limit: 7000 },
@@ -66,24 +68,50 @@ export function registerMinimaxTool(ctx: Context, config: Config) {
           prompt: expanded.user,
           sections: splitSections(expanded.user, scenario.outputMode || 'full_reference'),
           scenario: { id: scenario.id, name: scenario.name, outputMode: scenario.outputMode },
           budget: { text_tokens: budgetCfg.text_tokens, char_count, char_limit: budgetCfg.char_limit, over: char_count > budgetCfg.char_limit },
           dry_run: true,
         })
       }
       const { provider, model } = resolveRoute(exec as ExecLike)
       const caps = getCapabilities(inferModelFamily(provider, model))
       const effectiveParams = applyCapabilities(caps, { temperature: config.temperature })
-      const { text, usage } = await complete(ctx, {
+      const { text: rawText, usage, finish } = await complete(ctx, {
         provider, model, system: expanded.system, user: expanded.user,
         maxTokens: expanded.maxTokens, temperature: effectiveParams.temperature, signal: exec.signal,
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
diff --git a/plugins/prompt-master/tests/plugin/minimax-continue.test.ts b/plugins/prompt-master/tests/plugin/minimax-continue.test.ts
new file mode 100644
index 0000000..cbc6b2a
--- /dev/null
+++ b/plugins/prompt-master/tests/plugin/minimax-continue.test.ts
@@ -0,0 +1,76 @@
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
```
