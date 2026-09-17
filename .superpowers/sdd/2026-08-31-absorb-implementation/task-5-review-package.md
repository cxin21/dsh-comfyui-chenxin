# Review package - def5c53..a4706ec

## Commits
``````

## Stat
``` .../src/pe-framework/sanitize/model-specific.ts    | 44 ++++++++++++++++++++++
 plugins/prompt-master/src/tools/prompt-expand.ts   |  8 +++-
 plugins/prompt-master/src/tools/prompt-reverse.ts  |  6 ++-
 .../pe-framework/sanitize/model-specific.test.ts   | 29 ++++++++++++++
 4 files changed, 84 insertions(+), 3 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/sanitize/model-specific.ts b/plugins/prompt-master/src/pe-framework/sanitize/model-specific.ts
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
diff --git a/plugins/prompt-master/src/tools/prompt-expand.ts b/plugins/prompt-master/src/tools/prompt-expand.ts
index dadcc2b..c981367 100644
--- a/plugins/prompt-master/src/tools/prompt-expand.ts
+++ b/plugins/prompt-master/src/tools/prompt-expand.ts
@@ -1,16 +1,17 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
 import { resolveExpand } from '../resolver/index.js'
 import { findProfileById } from '../resolver/profiles/index.js'
 import { complete } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
 import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js'
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
@@ -58,15 +59,18 @@ export function registerExpandTool(ctx: Context, config: Config) {
       const caps = getCapabilities(inferModelFamily(provider, model))
       const effectiveParams = applyCapabilities(caps, { temperature: config.temperature })
       const { text: result } = await complete(ctx, {
         provider, model,
         system: expanded.system,
         user: expanded.user,
         maxTokens: expanded.maxTokens,
         temperature: effectiveParams.temperature,
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
index 79d1e42..9ef9fad 100644
--- a/plugins/prompt-master/src/tools/prompt-reverse.ts
+++ b/plugins/prompt-master/src/tools/prompt-reverse.ts
@@ -1,19 +1,20 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
 import type { ContentBlock, ImageBlock, UserMessage } from '@deepseek-ai/dsh-llm'
 import { resolveReverse } from '../resolver/index.js'
 import { findProfileById } from '../resolver/profiles/index.js'
 import { sanitizeFinalCaption } from '../resolver/profiles/reverse/router.js'
 import { completeWithBlocks } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
 import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js'
 import { resolveJoyExtraOptions, buildJoyExtraSystemBlock, buildJoyExtraUserTail, filterJoyExtraClauses } from '../pe-framework/sanitize/joy-extra.js'
+import { sanitizeModelSpecific } from '../pe-framework/sanitize/model-specific.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 
 export interface ReverseArgs {
   image_description?: string
   profile?: string
   output_lang?: string
   length?: string
   extra_prompt?: string
   joy_extra_options?: string[]
@@ -123,21 +124,24 @@ export function registerReverseTool(ctx: Context, config: Config) {
         }
       }
       const { text: raw } = await completeWithBlocks(ctx, {
         provider, model,
         system,
         blocks,
         maxTokens: 512,
         temperature: effectiveParams.temperature,
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
       const joyFilteredBefore = sanitized
       const finalCaption = joyExtra.options.length > 0 ? filterJoyExtraClauses(sanitized, joyExtra) : sanitized
       logInfo(`[prompt-master] prompt_reverse → ok=true chars=${finalCaption.length} joy_extra options=${joyExtra.options.join('|') || 'none'} filtered=${finalCaption !== joyFilteredBefore ? 'yes' : 'no'}`)
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
```
