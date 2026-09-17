# Scoped re-review package — Task 1 fix round 1 (single commit 207d263)

Note: baseline commit ee78de5 (plugin tree tracking) sits between the prior review head and this fix; it is NOT part of this fix. Review ONLY the single commit below.

## Commit
```207d263 test(prompt-master): cover DSH_COMFYUI_PRESET_ROOT env branch (priority chain level 2)
```n
## Fix diff (-U10)
```diff
commit 207d2633ab8cbb341ef3309af5d184543d98fc8f
Author: cxin21 <1124569937@qq.com>
Date:   Mon Aug 31 18:07:46 2026 +0800

    test(prompt-master): cover DSH_COMFYUI_PRESET_ROOT env branch (priority chain level 2)

diff --git a/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts b/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts
index 1102080..6450f47 100644
--- a/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts
@@ -1,12 +1,12 @@
 // tests/pe-framework/resources/resolve.test.ts
-import { describe, expect, it, beforeEach, afterEach } from 'vitest'
+import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
 import { join, sep } from 'node:path'
 import { setPresetRoot, getPresetRoot, resolveKnowledgePath } from '../../../src/pe-framework/resources/resolve.js'
 
 describe('resolveKnowledgePath', () => {
   beforeEach(() => setPresetRoot('C:/fake-preset'))
   afterEach(() => setPresetRoot(undefined))
 
   it('joins presetRoot + skillDir + knowledge + asset', () => {
     expect(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' }))
       .toBe('C:\\fake-preset\\skills\\anima-prompt-v1\\knowledge\\tag-catalog.sqlite')
@@ -33,11 +33,21 @@ describe('resolveKnowledgePath', () => {
     if (!threw) {
       expect(result).toBeDefined()
       const suffix = join('skills', 'x', 'knowledge', 'y')
       expect(result!.endsWith(suffix)).toBe(true)
       // fallback 解析出的根应为非空绝对路径（本 checkout 下即 preset 根目录）
       const root = result!.slice(0, result!.length - suffix.length).replace(/[\\/]+$/, '')
       expect(root.length).toBeGreaterThan(0)
       expect(sep === '\\' ? /^[A-Za-z]:[\\/]/.test(root) : root.startsWith('/')).toBe(true)
     }
   })
+
+  it('uses DSH_COMFYUI_PRESET_ROOT env when no explicit presetRoot is set', () => {
+    setPresetRoot(undefined)
+    vi.stubEnv('DSH_COMFYUI_PRESET_ROOT', 'C:/env-root')
+    try {
+      expect(resolveKnowledgePath({ skillDir: 'x', asset: 'y.json' })).toBe(join('C:/env-root', 'skills', 'x', 'knowledge', 'y.json'))
+    } finally {
+      vi.unstubAllEnvs()
+    }
+  })
 })
```
