# Review package - 276fe14..e89d459

## Commits
``````

## Stat
``` .gitignore                                         |  5 ++
 .../src/pe-framework/resources/resolve.ts          | 14 +++-
 .../resources/resolve-knowledge-path.test.ts       | 80 ++++++++++++++++++++++
 .../tests/pe-framework/resources/resolve.test.ts   | 18 ++---
 .../tests/plugin/catalog-build.test.ts             |  6 +-
 5 files changed, 110 insertions(+), 13 deletions(-)
```

## Full diff (-U10)
```diff --git a/.gitignore b/.gitignore
index 00dd69b..95b4246 100644
--- a/.gitignore
+++ b/.gitignore
@@ -19,10 +19,15 @@ scratch/
 
 # Runtime-generated artifacts (all skill outputs land here, grouped per skill)
 temp/
 
 # Large knowledge snapshots — shipped via GitHub Releases, not the repo.
 # Download from https://github.com/cxin21/dsh-comfyui-chenxin/releases
 # (tag v0.1.0) and place them back at these paths before use:
 skills/anima-prompt-v1/knowledge/tag-catalog.sqlite
 skills/anima-prompt-v1/knowledge/tags.sqlite
 skills/minimax-h3-prompt/knowledge/tokenizer.json
+
+# Stage 2 skill-merge: migrated location (assets/knowledge preferred; skills/ removed in Stage 3)
+assets/knowledge/anima-prompt-v1/tag-catalog.sqlite
+assets/knowledge/anima-prompt-v1/tags.sqlite
+assets/knowledge/minimax-h3-prompt/tokenizer.json
diff --git a/plugins/prompt-master/src/pe-framework/resources/resolve.ts b/plugins/prompt-master/src/pe-framework/resources/resolve.ts
index c46a97b..33396cc 100644
--- a/plugins/prompt-master/src/pe-framework/resources/resolve.ts
+++ b/plugins/prompt-master/src/pe-framework/resources/resolve.ts
@@ -1,27 +1,39 @@
 // src/pe-framework/resources/resolve.ts
 import { join, sep } from 'node:path'
+import { existsSync } from 'node:fs'
 
 let _presetRoot: string | undefined
 
 export function setPresetRoot(root: string | undefined): void { _presetRoot = root }
 export function getPresetRoot(): string | undefined { return _presetRoot }
 
 /** 插件 dist 位于 <preset>/plugins/prompt-master/dist/src/... → 定位 plugins 段前为 preset 根 */
 function fallbackPresetRoot(): string | undefined {
   try {
     const here = decodeURIComponent(import.meta.url.replace(/^file:\/\/\/?/, ''))
     const parts = here.split(/[\\/]/)
     for (let i = 0; i < parts.length - 1; i++) {
       if (parts[i] === 'plugins' && parts[i + 1] === 'prompt-master') {
         return parts.slice(0, i).join(sep)
       }
     }
     return undefined
   } catch { return undefined }
 }
 
+/**
+ * 知识资产双路径解析（Stage 2 skill-merge）：
+ * 1) 优先 <root>/assets/knowledge/<skillDir>/<asset>（迁移后的新位置）
+ * 2) 不存在且旧位置 <root>/skills/<skillDir>/knowledge/<asset> 存在 → 回退旧路径
+ *    （Graceful migration：Stage 3 删除 skills/ 之前两者皆可用；删除后新路径为唯一来源）
+ * 3) 两处都不存在 → 返回新路径（调用方错误处理兜底，见 assertAnimaCatalog / assertH3Tokenizer）
+ */
 export function resolveKnowledgePath(opts: { skillDir: string; asset: string }): string {
   const root = _presetRoot?.replace(/[\\/]+$/, '') || process.env.DSH_COMFYUI_PRESET_ROOT || fallbackPresetRoot()
   if (!root) throw new Error('resolveKnowledgePath: presetRoot not configured (config.presetRoot / DSH_COMFYUI_PRESET_ROOT / preset layout); cannot resolve knowledge asset')
-  return join(root, 'skills', opts.skillDir, 'knowledge', opts.asset)
+  const newPath = join(root, 'assets', 'knowledge', opts.skillDir, opts.asset)
+  if (existsSync(newPath)) return newPath
+  const oldPath = join(root, 'skills', opts.skillDir, 'knowledge', opts.asset)
+  if (existsSync(oldPath)) return oldPath
+  return newPath
 }
diff --git a/plugins/prompt-master/tests/pe-framework/resources/resolve-knowledge-path.test.ts b/plugins/prompt-master/tests/pe-framework/resources/resolve-knowledge-path.test.ts
new file mode 100644
index 0000000..c563e49
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/resources/resolve-knowledge-path.test.ts
@@ -0,0 +1,80 @@
+// tests/pe-framework/resources/resolve-knowledge-path.test.ts
+// Stage 2 skill-merge：resolveKnowledgePath 双路径优先级（assets/knowledge 优先，skills 回退，都缺 → 新路径）。
+// 用真实临时目录做假 preset root，确定性验证 existsSync 驱动的分支，而非依赖磁盘上不存在的假根。
+import { describe, expect, it, beforeEach, afterEach } from 'vitest'
+import { join } from 'node:path'
+import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { setPresetRoot, resolveKnowledgePath } from '../../../src/pe-framework/resources/resolve.js'
+
+function makeFakeRoot(): { root: string; newDir: string; oldDir: string; newPath: string; oldPath: string } {
+  const root = mkdtempSync(join(tmpdir(), 'prompt-master-resolve-'))
+  const skillDir = 'anima-prompt-v1'
+  const asset = 'tag-catalog.sqlite'
+  const newDir = join(root, 'assets', 'knowledge', skillDir)
+  const oldDir = join(root, 'skills', skillDir, 'knowledge')
+  const newPath = join(newDir, asset)
+  const oldPath = join(oldDir, asset)
+  return { root, newDir, oldDir, newPath, oldPath }
+}
+
+describe('resolveKnowledgePath dual-path priority (fake root with real files)', () => {
+  let fake: ReturnType<typeof makeFakeRoot>
+
+  beforeEach(() => {
+    fake = makeFakeRoot()
+    setPresetRoot(fake.root)
+  })
+
+  afterEach(() => {
+    setPresetRoot(undefined)
+    rmSync(fake.root, { recursive: true, force: true })
+  })
+
+  it('resolves NEW path when assets/knowledge/<skill>/<asset> exists (preferred)', () => {
+    mkdirSync(fake.newDir, { recursive: true })
+    writeFileSync(fake.newPath, 'new')
+    // 旧路径也存在时仍须选新路径（Stage 2 过渡期两者并存）
+    mkdirSync(fake.oldDir, { recursive: true })
+    writeFileSync(fake.oldPath, 'old')
+    expect(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })).toBe(fake.newPath)
+  })
+
+  it('falls back to OLD path when only skills/<skill>/knowledge/<asset> exists', () => {
+    mkdirSync(fake.oldDir, { recursive: true })
+    writeFileSync(fake.oldPath, 'old')
+    expect(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })).toBe(fake.oldPath)
+  })
+
+  it('resolves NEW path when neither location exists (graceful; callers handle missing assets)', () => {
+    expect(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })).toBe(fake.newPath)
+    // 顺带验证：该路径当前确实不存在（证明优先级是「都不存在 → 仍给新路径」而非误判存在）
+    expect(existsSync(fake.newPath)).toBe(false)
+  })
+
+  it('per-asset resolution: h3 tokenizer asset follows the same priority', () => {
+    const h3New = join(fake.root, 'assets', 'knowledge', 'minimax-h3-prompt', 'tokenizer.json')
+    mkdirSync(join(fake.root, 'assets', 'knowledge', 'minimax-h3-prompt'), { recursive: true })
+    writeFileSync(h3New, 'tok')
+    expect(resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'tokenizer.json' })).toBe(h3New)
+  })
+})
+
+describe('resolveKnowledgePath on real preset checkout (before/after migration both resolve)', () => {
+  // 不注入 setPresetRoot / env → fallbackPresetRoot 解析出真实 preset 根（本 checkout 布局）。
+  // Stage 2 前后此测试都必须绿：迁移前旧路径存在 → 解析到 skills/…；迁移后新路径存在 → 解析到 assets/knowledge/…，
+  // 始终落在一个实际存在的资产文件上（golden 不变量：catalog/tokenizer 照常可读）。
+  beforeEach(() => setPresetRoot(undefined))
+
+  it('tag-catalog.sqlite resolves to an existing file', () => {
+    const resolved = resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
+    expect(resolved).toContain('tag-catalog.sqlite')
+    expect(existsSync(resolved)).toBe(true)
+  })
+
+  it('tokenizer.json resolves to an existing file', () => {
+    const resolved = resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'tokenizer.json' })
+    expect(resolved).toContain('tokenizer.json')
+    expect(existsSync(resolved)).toBe(true)
+  })
+})
\ No newline at end of file
diff --git a/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts b/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts
index 2e7348e..7f57702 100644
--- a/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts
@@ -1,85 +1,85 @@
 // tests/pe-framework/resources/resolve.test.ts
 import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
 import { join, sep } from 'node:path'
 import { setPresetRoot, getPresetRoot, resolveKnowledgePath } from '../../../src/pe-framework/resources/resolve.js'
 import { catalogPath, setCatalogPath, closeCatalog } from '../../../src/pe-framework/dialect/anima-catalog.js'
 
 describe('resolveKnowledgePath', () => {
   beforeEach(() => setPresetRoot('C:/fake-preset'))
   afterEach(() => setPresetRoot(undefined))
 
-  it('joins presetRoot + skillDir + knowledge + asset', () => {
+  it('joins presetRoot + assets + knowledge + skillDir + asset (new default when neither location exists)', () => {
     expect(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' }))
-      .toBe('C:\\fake-preset\\skills\\anima-prompt-v1\\knowledge\\tag-catalog.sqlite')
+      .toBe('C:\\fake-preset\\assets\\knowledge\\anima-prompt-v1\\tag-catalog.sqlite')
   })
 
   it('normalizes trailing slash on presetRoot', () => {
     setPresetRoot('C:/fake-preset/')
-    expect(resolveKnowledgePath({ skillDir: 'x', asset: 'y.json' })).toBe('C:\\fake-preset\\skills\\x\\knowledge\\y.json')
+    expect(resolveKnowledgePath({ skillDir: 'x', asset: 'y.json' })).toBe('C:\\fake-preset\\assets\\knowledge\\x\\y.json')
   })
 
   it('throws readable error when no presetRoot configured', () => {
     // 本 checkout 的源码恰好位于 <preset>/plugins/prompt-master/... 布局下，
     // fallbackPresetRoot() 会成功解析出真实 preset 根（生产环境预期行为），此时不 throw。
-    // 断言两种合法结果之一：throw 可读错误，或返回以 skills/<skillDir>/knowledge/<asset> 结尾的绝对路径。
+    // 断言两种合法结果之一：throw 可读错误，或返回以 assets/knowledge/<skillDir>/<asset> 结尾的绝对路径。
     setPresetRoot(undefined)
     let result: string | undefined
     let threw = false
     try {
       result = resolveKnowledgePath({ skillDir: 'x', asset: 'y' })
     } catch (e) {
       threw = true
       expect(String(e)).toMatch(/presetRoot not configured|preset/i)
     }
     if (!threw) {
       expect(result).toBeDefined()
-      const suffix = join('skills', 'x', 'knowledge', 'y')
+      const suffix = join('assets', 'knowledge', 'x', 'y')
       expect(result!.endsWith(suffix)).toBe(true)
       // fallback 解析出的根应为非空绝对路径（本 checkout 下即 preset 根目录）
       const root = result!.slice(0, result!.length - suffix.length).replace(/[\\/]+$/, '')
       expect(root.length).toBeGreaterThan(0)
       expect(sep === '\\' ? /^[A-Za-z]:[\\/]/.test(root) : root.startsWith('/')).toBe(true)
     }
   })
 
   it('uses DSH_COMFYUI_PRESET_ROOT env when no explicit presetRoot is set', () => {
     setPresetRoot(undefined)
     vi.stubEnv('DSH_COMFYUI_PRESET_ROOT', 'C:/env-root')
     try {
-      expect(resolveKnowledgePath({ skillDir: 'x', asset: 'y.json' })).toBe(join('C:/env-root', 'skills', 'x', 'knowledge', 'y.json'))
+      expect(resolveKnowledgePath({ skillDir: 'x', asset: 'y.json' })).toBe(join('C:/env-root', 'assets', 'knowledge', 'x', 'y.json'))
     } finally {
       vi.unstubAllEnvs()
     }
   })
 })
 
 // MF-1：catalog 路径惰性解析——setPresetRoot 在 import 之后（插件 apply 期）改变时 catalogPath 必须跟随
 describe('anima-catalog lazy path resolution', () => {
   afterEach(() => {
     setCatalogPath(process.env.ANIMA_CATALOG_PATH ?? '')
     delete (process.env as Record<string, string | undefined>).ANIMA_CATALOG_PATH
     closeCatalog()
   })
 
   it('catalogPath() reflects setPresetRoot called after module import', () => {
     setPresetRoot('C:/late-preset')
-    expect(catalogPath()).toBe(join('C:/late-preset', 'skills', 'anima-prompt-v1', 'knowledge', 'tag-catalog.sqlite'))
+    expect(catalogPath()).toBe(join('C:/late-preset', 'assets', 'knowledge', 'anima-prompt-v1', 'tag-catalog.sqlite'))
     setPresetRoot('C:/other-preset')
-    expect(catalogPath()).toBe(join('C:/other-preset', 'skills', 'anima-prompt-v1', 'knowledge', 'tag-catalog.sqlite'))
+    expect(catalogPath()).toBe(join('C:/other-preset', 'assets', 'knowledge', 'anima-prompt-v1', 'tag-catalog.sqlite'))
   })
 
   it('setCatalogPath override wins over presetRoot; clearing restores lazy default', () => {
     setPresetRoot('C:/late-preset')
     setCatalogPath('C:/custom/catalog.sqlite')
     expect(catalogPath()).toBe('C:/custom/catalog.sqlite')
     setCatalogPath('')
-    expect(catalogPath()).toBe(join('C:/late-preset', 'skills', 'anima-prompt-v1', 'knowledge', 'tag-catalog.sqlite'))
+    expect(catalogPath()).toBe(join('C:/late-preset', 'assets', 'knowledge', 'anima-prompt-v1', 'tag-catalog.sqlite'))
   })
 
   it('ANIMA_CATALOG_PATH env takes priority level 0 over presetRoot', () => {
     setPresetRoot('C:/late-preset')
     process.env.ANIMA_CATALOG_PATH = 'C:/env/catalog.sqlite'
     setCatalogPath('') // re-derive override from env
     expect(catalogPath()).toBe('C:/env/catalog.sqlite')
   })
 })
diff --git a/plugins/prompt-master/tests/plugin/catalog-build.test.ts b/plugins/prompt-master/tests/plugin/catalog-build.test.ts
index eb67ccf..eaa846f 100644
--- a/plugins/prompt-master/tests/plugin/catalog-build.test.ts
+++ b/plugins/prompt-master/tests/plugin/catalog-build.test.ts
@@ -52,22 +52,22 @@ beforeEach(() => {
 
 afterEach(() => {
   setPresetRoot(undefined)
   closeCatalog()
   rmSync(presetTmp, { recursive: true, force: true })
   rmSync(looseTmp, { recursive: true, force: true })
 })
 
 describe('catalog_build tool', () => {
   it('无参数默认：resolveKnowledgePath 推导源/输出/manifest，构建 + manifest 更新', async () => {
-    // 假 preset 布局：<tmp>/skills/anima-prompt-v1/knowledge/tags.sqlite
-    const knowledge = join(presetTmp, 'skills', 'anima-prompt-v1', 'knowledge')
+    // 假 preset 布局：<tmp>/assets/knowledge/anima-prompt-v1/tags.sqlite（Stage 2 新位置）
+    const knowledge = join(presetTmp, 'assets', 'knowledge', 'anima-prompt-v1')
     mkdirSync(knowledge, { recursive: true })
     seedTagsSource(join(knowledge, 'tags.sqlite'))
     setPresetRoot(presetTmp)
 
     const ctx = stubCtx()
     const tool = registerCatalogBuildTool(ctx as never, cfg as never)
     const env = JSON.parse(String(await runTool(ctx, tool, {}))) as {
       ok: boolean
       stats: { records: number; names: number; ftsRows: number }
       output: string
@@ -102,21 +102,21 @@ describe('catalog_build tool', () => {
       stats: { records: number }
       manifest: string | null
     }
     expect(env.ok).toBe(true)
     expect(env.stats.records).toBe(3)
     expect(env.manifest).toBeNull() // 自定义 output → 不更新 manifest
     expect(existsSync(outputPath)).toBe(true)
   })
 
   it('显式 output 与默认一致 → 仍更新默认 manifest（就地重建语义）', async () => {
-    const knowledge = join(presetTmp, 'skills', 'anima-prompt-v1', 'knowledge')
+    const knowledge = join(presetTmp, 'assets', 'knowledge', 'anima-prompt-v1')
     mkdirSync(knowledge, { recursive: true })
     seedTagsSource(join(knowledge, 'tags.sqlite'))
     setPresetRoot(presetTmp)
 
     const ctx = stubCtx()
     const tool = registerCatalogBuildTool(ctx as never, cfg as never)
     const env = JSON.parse(String(await runTool(ctx, tool, { output: join(knowledge, 'tag-catalog.sqlite') }))) as {
       ok: boolean
       manifest: string | null
     }
```
