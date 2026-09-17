# Review package — Absorb T1 (base 50c84b8..02045b7)

## Commits
```02045b7 feat(prompt-master): model capability matrix (family inference + defaults)
```n
## Stat
``` .../model-capabilities/capabilities.ts             | 35 ++++++++++++
 .../pe-framework/model-capabilities/families.ts    | 21 ++++++++
 .../src/pe-framework/model-capabilities/index.ts   |  2 +
 .../prompt-master/src/tools/minimax-scenario.ts    |  5 +-
 plugins/prompt-master/src/tools/prompt-expand.ts   |  5 +-
 plugins/prompt-master/src/tools/prompt-reverse.ts  |  5 +-
 .../model-capabilities/model-capabilities.test.ts  | 62 ++++++++++++++++++++++
 7 files changed, 132 insertions(+), 3 deletions(-)
```n
## Full diff (-U10)
```diff
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
diff --git a/plugins/prompt-master/src/tools/minimax-scenario.ts b/plugins/prompt-master/src/tools/minimax-scenario.ts
index 5a50d87..f316d36 100644
--- a/plugins/prompt-master/src/tools/minimax-scenario.ts
+++ b/plugins/prompt-master/src/tools/minimax-scenario.ts
@@ -1,15 +1,16 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
 import { listScenarios, getScenarioById, resolveMinimaxScenarioExpand } from '../resolver/minimax/index.js'
 import { countChars } from '../utils/length.js'
 import { complete } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
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
@@ -63,23 +64,25 @@ export function registerMinimaxTool(ctx: Context, config: Config) {
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
+      const caps = getCapabilities(inferModelFamily(provider, model))
+      const effectiveParams = applyCapabilities(caps, { temperature: config.temperature })
       const { text, usage } = await complete(ctx, {
         provider, model, system: expanded.system, user: expanded.user,
-        maxTokens: expanded.maxTokens, temperature: config.temperature, signal: exec.signal,
+        maxTokens: expanded.maxTokens, temperature: effectiveParams.temperature, signal: exec.signal,
       })
       const char_count = countChars(text)
       return JSON.stringify({
         prompt: text,
         sections: splitSections(text, scenario.outputMode || 'full_reference'),
         scenario: { id: scenario.id, name: scenario.name, outputMode: scenario.outputMode },
         budget: {
           text_tokens: usage?.outputTokens || budgetCfg.text_tokens,
           char_count, char_limit: budgetCfg.char_limit, over: char_count > budgetCfg.char_limit,
         },
diff --git a/plugins/prompt-master/src/tools/prompt-expand.ts b/plugins/prompt-master/src/tools/prompt-expand.ts
index 255c82c..dadcc2b 100644
--- a/plugins/prompt-master/src/tools/prompt-expand.ts
+++ b/plugins/prompt-master/src/tools/prompt-expand.ts
@@ -1,15 +1,16 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
 import { resolveExpand } from '../resolver/index.js'
 import { findProfileById } from '../resolver/profiles/index.js'
 import { complete } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
+import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 
 export interface ExpandArgs {
   text: string
   profile?: string
   output_lang?: string
   length?: string
   extra_prompt?: string
   dry_run?: boolean
@@ -47,23 +48,25 @@ export function registerExpandTool(ctx: Context, config: Config) {
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
       logInfo(`[prompt-master] prompt_expand → ok=true chars=${result.length}`)
       return result || ''
     },
   })
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/src/tools/prompt-reverse.ts b/plugins/prompt-master/src/tools/prompt-reverse.ts
index 7686416..1957add 100644
--- a/plugins/prompt-master/src/tools/prompt-reverse.ts
+++ b/plugins/prompt-master/src/tools/prompt-reverse.ts
@@ -1,17 +1,18 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
 import type { ContentBlock, ImageBlock, UserMessage } from '@deepseek-ai/dsh-llm'
 import { resolveReverse } from '../resolver/index.js'
 import { findProfileById } from '../resolver/profiles/index.js'
 import { sanitizeFinalCaption } from '../resolver/profiles/reverse/router.js'
 import { completeWithBlocks } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
+import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 
 export interface ReverseArgs {
   image_description?: string
   profile?: string
   output_lang?: string
   length?: string
   extra_prompt?: string
   anima3_enhance?: boolean
@@ -88,36 +89,38 @@ export function registerReverseTool(ctx: Context, config: Config) {
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
+      const caps = getCapabilities(inferModelFamily(provider, model))
+      const effectiveParams = applyCapabilities(caps, { temperature: config.temperature })
       const blocks: ContentBlock[] = [
         ...images.map((b) => ({ ...b })),
         ...(text ? [{ type: 'text' as const, text }] : []),
       ]
       if (images.length > 0) {
         const info = await (ctx.llm as any).resolveModelInfo?.(provider, model, exec.signal)
         if (!info || !info.inputModalities?.includes('image')) {
           throw new Error(`当前模型 ${model} 不支持图片输入，请在 Web UI Settings→Models 切换到支持图片输入的模型（如 deepseek-v4-flash-vision-exp），或在参数中提供 image_description 文本描述`)
         }
       }
       const { text: raw } = await completeWithBlocks(ctx, {
         provider, model,
         system: reverseResult.system,
         blocks,
         maxTokens: 512,
-        temperature: config.temperature,
+        temperature: effectiveParams.temperature,
         signal: exec.signal,
       })
       const sanitized = sanitizeFinalCaption(raw, {
         type: reverseResult.captionType,
         caption_lang: String(args.output_lang || 'zh'),
         len: String(args.length || 'medium'),
         anima3_enhance: args.anima3_enhance === true,
         quality_prompt_enabled: args.quality_prompt_enabled === true,
         quality_prompt_prefix: String(args.quality_prompt_prefix || ''),
       })
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
```
