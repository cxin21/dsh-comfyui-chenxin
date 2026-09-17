# Review package - a4706ec..fdaacff

## Commits
``````

## Stat
``` .../src/pe-framework/media/identity.ts             | 15 +++++++++++++
 plugins/prompt-master/src/tools/prompt-reverse.ts  | 13 +++++++++--
 .../tests/pe-framework/media/identity.test.ts      | 26 ++++++++++++++++++++++
 3 files changed, 52 insertions(+), 2 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/media/identity.ts b/plugins/prompt-master/src/pe-framework/media/identity.ts
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
diff --git a/plugins/prompt-master/src/tools/prompt-reverse.ts b/plugins/prompt-master/src/tools/prompt-reverse.ts
index 9ef9fad..45622a5 100644
--- a/plugins/prompt-master/src/tools/prompt-reverse.ts
+++ b/plugins/prompt-master/src/tools/prompt-reverse.ts
@@ -1,20 +1,21 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
 import type { ContentBlock, ImageBlock, UserMessage } from '@deepseek-ai/dsh-llm'
 import { resolveReverse } from '../resolver/index.js'
 import { findProfileById } from '../resolver/profiles/index.js'
 import { sanitizeFinalCaption } from '../resolver/profiles/reverse/router.js'
 import { completeWithBlocks } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
 import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js'
 import { resolveJoyExtraOptions, buildJoyExtraSystemBlock, buildJoyExtraUserTail, filterJoyExtraClauses } from '../pe-framework/sanitize/joy-extra.js'
 import { sanitizeModelSpecific } from '../pe-framework/sanitize/model-specific.js'
+import { enumerateTaggedMedia, buildIdentityDeclarations } from '../pe-framework/media/identity.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 
 export interface ReverseArgs {
   image_description?: string
   profile?: string
   output_lang?: string
   length?: string
   extra_prompt?: string
   joy_extra_options?: string[]
@@ -106,24 +107,32 @@ export function registerReverseTool(ctx: Context, config: Config) {
             maxTokens: 512,
           },
           profile_meta: { id: profile.id, name: profile.name, outputFormat: profile.outputFormat },
         })
         logInfo(`[prompt-master] prompt_reverse → ok=true dry_run=true chars=${debug.length}`)
         return debug
       }
       const { provider, model } = resolveRoute(exec as ExecLike)
       const caps = getCapabilities(inferModelFamily(provider, model))
       const effectiveParams = applyCapabilities(caps, { temperature: config.temperature })
-      const blocks: ContentBlock[] = [
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
         system,
         blocks,
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
```
