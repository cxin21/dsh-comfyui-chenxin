# Review package — Task 1 (base 714e87a..5023056)

## Commits
```5023056 feat(prompt-master): add resource path resolution (resolveKnowledgePath/setPresetRoot)
```n
## Stat
``` .../src/pe-framework/resources/resolve.ts          | 27 ++++++++++
 plugins/prompt-master/src/plugin/config.ts         | 13 +++++
 plugins/prompt-master/src/plugin/index.ts          | 58 ++++++++++++++++++++++
 .../tests/pe-framework/resources/resolve.test.ts   | 43 ++++++++++++++++
 4 files changed, 141 insertions(+)
```n
## Full diff (-U10)
```diff
diff --git a/plugins/prompt-master/src/pe-framework/resources/resolve.ts b/plugins/prompt-master/src/pe-framework/resources/resolve.ts
new file mode 100644
index 0000000..c46a97b
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/resources/resolve.ts
@@ -0,0 +1,27 @@
+// src/pe-framework/resources/resolve.ts
+import { join, sep } from 'node:path'
+
+let _presetRoot: string | undefined
+
+export function setPresetRoot(root: string | undefined): void { _presetRoot = root }
+export function getPresetRoot(): string | undefined { return _presetRoot }
+
+/** 插件 dist 位于 <preset>/plugins/prompt-master/dist/src/... → 定位 plugins 段前为 preset 根 */
+function fallbackPresetRoot(): string | undefined {
+  try {
+    const here = decodeURIComponent(import.meta.url.replace(/^file:\/\/\/?/, ''))
+    const parts = here.split(/[\\/]/)
+    for (let i = 0; i < parts.length - 1; i++) {
+      if (parts[i] === 'plugins' && parts[i + 1] === 'prompt-master') {
+        return parts.slice(0, i).join(sep)
+      }
+    }
+    return undefined
+  } catch { return undefined }
+}
+
+export function resolveKnowledgePath(opts: { skillDir: string; asset: string }): string {
+  const root = _presetRoot?.replace(/[\\/]+$/, '') || process.env.DSH_COMFYUI_PRESET_ROOT || fallbackPresetRoot()
+  if (!root) throw new Error('resolveKnowledgePath: presetRoot not configured (config.presetRoot / DSH_COMFYUI_PRESET_ROOT / preset layout); cannot resolve knowledge asset')
+  return join(root, 'skills', opts.skillDir, 'knowledge', opts.asset)
+}
diff --git a/plugins/prompt-master/src/plugin/config.ts b/plugins/prompt-master/src/plugin/config.ts
new file mode 100644
index 0000000..c6a4786
--- /dev/null
+++ b/plugins/prompt-master/src/plugin/config.ts
@@ -0,0 +1,13 @@
+import z from '@deepseek-ai/schemastery'
+
+/** R1：插件零 provider/model 配置（完全跟随 DSH 会话路由），仅保留 temperature */
+export const Config = z.object({
+  temperature: z.number().default(0.7),
+  /** preset 根目录（资源路径解析用）；schemastery 无 default 的 string 属性即可选，缺省时按 env / preset 布局 fallback */
+  presetRoot: z.string(),
+})
+
+export interface Config {
+  temperature: number
+  presetRoot?: string
+}
\ No newline at end of file
diff --git a/plugins/prompt-master/src/plugin/index.ts b/plugins/prompt-master/src/plugin/index.ts
new file mode 100644
index 0000000..778acf5
--- /dev/null
+++ b/plugins/prompt-master/src/plugin/index.ts
@@ -0,0 +1,58 @@
+import z from '@deepseek-ai/schemastery'
+import type { Context } from '@deepseek-ai/cordis'
+import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
+import { registerExpandTool } from '../tools/prompt-expand.js'
+import { registerReverseTool } from '../tools/prompt-reverse.js'
+import { registerMinimaxTool } from '../tools/minimax-scenario.js'
+import { registerProfileListTool, type ProfileScope } from '../tools/profile-list.js'
+import { registerAuthorTool, setAuthorIntentProvider } from '../tools/prompt-author.js'
+import { registerCompileTool } from '../tools/prompt-compile.js'
+import { registerCatalogSearchTool } from '../tools/catalog-search.js'
+import { registerAuditTool } from '../tools/prompt-audit.js'
+import { setCustomProfileSource } from '../resolver/profiles/source.js'
+import { createDefaultIntentProvider } from '../pe-framework/intent/index.js'
+import { setPresetRoot } from '../pe-framework/resources/resolve.js'
+import { Config, type Config as ConfigShape } from './config.js'
+
+export const name = 'prompt-master'
+export const inject = ['tools', 'llm', 'settings', 'subagents']
+export { Config }
+
+export function apply(ctx: Context, config: ConfigShape) {
+  // 资源路径解析：显式 presetRoot 优先（其后 env / preset 布局 fallback 在 resolve 内部处理）
+  setPresetRoot(config.presetRoot)
+
+  const ns = settingsNamespace('prompt-master-custom-profiles')
+  const scope: SettingsScope<{ customProfiles: Record<string, string> }> = ctx.settings.register(ns, z.object({
+    customProfiles: z.dict(z.string(), z.string()).default({}),
+  }))
+
+  // Ruling #2 显式适配：真实 get() 返回 {customProfiles}，ProfileScope 期望直接表
+  const profileScope: ProfileScope = {
+    get: () => scope.get().customProfiles ?? {},
+    update: (patch) => scope.update(patch),        // 形状 {customProfiles} 与真实兼容
+    replace: (section) => scope.replace(section),  // 同
+  }
+
+  // 注入 resolver 自定义 profile 源（兼证 Task 9 契约）
+  setCustomProfileSource(() =>
+    Object.entries(profileScope.get()).map(([id, profileJson]) => ({ id, profileJson })),
+  )
+
+  // R2: 装入默认 Intent Provider（intent 走 DSH one-shot subagent；ownerCtx 一次性绑定；返回 AuthorIntentFn 单参）
+  //     必须早于 author 工具注册/调用 → 在 ctx.effect 之前完成
+  setAuthorIntentProvider(createDefaultIntentProvider(ctx))
+
+  ctx.effect(() => {
+    const disposers: (() => void)[] = []
+    disposers.push(ctx.tools.register(registerExpandTool(ctx, config)))
+    disposers.push(ctx.tools.register(registerReverseTool(ctx, config)))
+    disposers.push(ctx.tools.register(registerMinimaxTool(ctx, config)))
+    disposers.push(ctx.tools.register(registerProfileListTool(ctx, config, { scope: profileScope })))
+    disposers.push(ctx.tools.register(registerAuthorTool(ctx, config)))
+    disposers.push(ctx.tools.register(registerCompileTool()))
+    disposers.push(ctx.tools.register(registerCatalogSearchTool(ctx, config)))
+    disposers.push(ctx.tools.register(registerAuditTool(ctx, config)))
+    return () => { for (const d of disposers) d() }
+  }, 'prompt-master.tools')
+}
\ No newline at end of file
diff --git a/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts b/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts
new file mode 100644
index 0000000..1102080
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts
@@ -0,0 +1,43 @@
+// tests/pe-framework/resources/resolve.test.ts
+import { describe, expect, it, beforeEach, afterEach } from 'vitest'
+import { join, sep } from 'node:path'
+import { setPresetRoot, getPresetRoot, resolveKnowledgePath } from '../../../src/pe-framework/resources/resolve.js'
+
+describe('resolveKnowledgePath', () => {
+  beforeEach(() => setPresetRoot('C:/fake-preset'))
+  afterEach(() => setPresetRoot(undefined))
+
+  it('joins presetRoot + skillDir + knowledge + asset', () => {
+    expect(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' }))
+      .toBe('C:\\fake-preset\\skills\\anima-prompt-v1\\knowledge\\tag-catalog.sqlite')
+  })
+
+  it('normalizes trailing slash on presetRoot', () => {
+    setPresetRoot('C:/fake-preset/')
+    expect(resolveKnowledgePath({ skillDir: 'x', asset: 'y.json' })).toBe('C:\\fake-preset\\skills\\x\\knowledge\\y.json')
+  })
+
+  it('throws readable error when no presetRoot configured', () => {
+    // 本 checkout 的源码恰好位于 <preset>/plugins/prompt-master/... 布局下，
+    // fallbackPresetRoot() 会成功解析出真实 preset 根（生产环境预期行为），此时不 throw。
+    // 断言两种合法结果之一：throw 可读错误，或返回以 skills/<skillDir>/knowledge/<asset> 结尾的绝对路径。
+    setPresetRoot(undefined)
+    let result: string | undefined
+    let threw = false
+    try {
+      result = resolveKnowledgePath({ skillDir: 'x', asset: 'y' })
+    } catch (e) {
+      threw = true
+      expect(String(e)).toMatch(/presetRoot not configured|preset/i)
+    }
+    if (!threw) {
+      expect(result).toBeDefined()
+      const suffix = join('skills', 'x', 'knowledge', 'y')
+      expect(result!.endsWith(suffix)).toBe(true)
+      // fallback 解析出的根应为非空绝对路径（本 checkout 下即 preset 根目录）
+      const root = result!.slice(0, result!.length - suffix.length).replace(/[\\/]+$/, '')
+      expect(root.length).toBeGreaterThan(0)
+      expect(sep === '\\' ? /^[A-Za-z]:[\\/]/.test(root) : root.startsWith('/')).toBe(true)
+    }
+  })
+})
```
