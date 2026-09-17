# Scoped re-review — final fix wave (single commit 110ae88)

## Fix diff (-U10)
```diff
commit 110ae8879f6de0b9f07f1c3fadf4b34f57d55d76
Author: cxin21 <1124569937@qq.com>
Date:   Tue Sep 1 02:23:41 2026 +0800

    fix(prompt-master): lazy catalog path (config priority + no import throw), emit assumptions in envelope, preserve compile result on critical gates

diff --git a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
index f61c9e1..64e97df 100644
--- a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
+++ b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
@@ -21,46 +21,49 @@ export interface CatalogQueryOptions {
   mode?: 'auto' | 'exact'
   limit?: number
 }
 
 export type MatchKind = 'canonical' | 'alias' | 'fuzzy' | 'miss'
 
 const defaultCatalogPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
 const defaultOverlayPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'relation-overlay.sqlite' })
 
 let _db: DatabaseSync | null = null
-let _dbPath = process.env.ANIMA_CATALOG_PATH ?? defaultCatalogPath()
+/** 惰性解析（MF-1）：路径在 db() 打开时才解析，保证 setPresetRoot(config.presetRoot) 先于路径求值；
+ *  模块求值期不再触碰文件系统（resolveKnowledgePath fallback 失败的 throw 不再发生在 import 时）。 */
+let _dbPathOverride: string | null = process.env.ANIMA_CATALOG_PATH ?? null
 let _manifestChecked = false
 
 /** manifest 对账只跑一次；失败 console.warn 但不硬崩（资源层无 ctx.logger，spec §4.2）。
- *  在模块求值期执行（先于任何 db 打开）：783MiB catalog 的 sha256 在全量测试并行 IO 下会超过
- *  vitest 单测 5s 超时，放在惰性 db() 路径会把首次查询拖超时；模块期不计入测试计时。 */
+ *  在首次 db() 调用时执行（MF-1：从模块求值期移入惰性路径，先于任何 db 打开）：783MiB catalog 的
+ *  sha256 在全量测试并行 IO 下会超过 vitest 单测 5s 超时，once-flag 保证每个进程只对账一次。 */
 function verifyManifestOnce(): void {
   if (_manifestChecked) return
   _manifestChecked = true
   const r = assertAnimaCatalog()
   if (!r.ok) console.warn(`[prompt-master] ${r.reason}：资产与 golden 基线不同，请 re-run fidelity capture`)
 }
-verifyManifestOnce()
 
 export function catalogPath(): string {
-  return _dbPath
+  return _dbPathOverride ?? defaultCatalogPath()
 }
 
 export function setCatalogPath(path: string): void {
   if (_db) { _db.close(); _db = null }
-  _dbPath = path
+  // 空串 = 清除显式覆盖，回落到 env 优先级（level 0），再回落 defaultCatalogPath()
+  _dbPathOverride = path || (process.env.ANIMA_CATALOG_PATH ?? null)
 }
 
 function db(): DatabaseSync {
   if (!_db) {
-    _db = new DatabaseSync(_dbPath, { readOnly: true })
+    verifyManifestOnce()
+    _db = new DatabaseSync(catalogPath(), { readOnly: true })
   }
   return _db
 }
 
 /** facets.normalize 移植：lowercase、underscores→spaces、collapse whitespace、strip */
 export function normalizeTag(value: string): string {
   return value.trim().toLowerCase().replaceAll('_', ' ').split(/\s+/).filter(Boolean).join(' ')
 }
 
 /** search.py _fts_query 移植：OR + prefix tokens（word-root discovery） */
@@ -146,26 +149,27 @@ export function overlayStatus(): 'available' | 'unavailable' {
 
 export const OVERLAY_ADVISORY = 'overlay_unavailable'
 
 export function catalogMeta(): { file: string; sizeBytes: number; tables: string[]; fts: boolean } {
   const tables = db()
     .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
     .all()
     .map((r) => (r as { name: string }).name)
   const fts = tables.includes('catalog_fts')
   let sizeBytes = 0
+  const path = catalogPath()
   try {
-    sizeBytes = statSync(_dbPath).size
+    sizeBytes = statSync(path).size
   } catch {
     /* path may be a file: URI fallback */
   }
-  return { file: _dbPath, sizeBytes, tables, fts }
+  return { file: path, sizeBytes, tables, fts }
 }
 
 /** 便捷 close（测试隔离用） */
 export function closeCatalog(): void {
   if (_db) { _db.close(); _db = null }
 }
 
 /** 预设 knowledge 目录推导（供 config 接线） */
 export function knowledgeDir(): string {
   return dirname(defaultCatalogPath())
diff --git a/plugins/prompt-master/src/pe-framework/render/envelope.ts b/plugins/prompt-master/src/pe-framework/render/envelope.ts
index 1a232e5..81a8ec9 100644
--- a/plugins/prompt-master/src/pe-framework/render/envelope.ts
+++ b/plugins/prompt-master/src/pe-framework/render/envelope.ts
@@ -5,27 +5,28 @@ import type { StageResult } from '../pipeline/types.js'
 /** target → 默认 slot 提示；方言自带 targetSlotHint 时优先使用方言值 */
 export function targetSlotHint(target: string): string {
   if (target === 'h3') return 't2v.prompt'
   if (target === 'anima') return 't2i.prompt'
   return 'generic.prompt'
 }
 
 /**
  * P1 Envelope 唯一组装点（Task 4 定案：audit 收敛为 legacy 形状 {passed, gates, budget?}；
  * assumptions/advisories 不再入 audit 对象——顶层 advisories 是唯一读取点）：
- * { ok, ...(ok ? {result} : {}), audit:{passed, gates, ...(budget?{budget}:{})}, advisories:[...stage.advisories, ...trail], target_slot_hint }
+ * { ok, ...(ok ? {result} : {}), audit:{passed, gates, ...(budget?{budget}:{})}, assumptions:[...stage.assumptions], advisories:[...stage.advisories, ...trail], target_slot_hint }
  */
 export function assembleEnvelope(stage: StageResult, trail?: string[]): string {
   const audit = {
     passed: stage.ok,
     gates: stage.gates,
     ...(stage.budget !== undefined ? { budget: stage.budget } : {}),
   }
   const envelope: Record<string, unknown> = {
     ok: stage.ok,
     ...(stage.ok ? { result: stage.result } : {}),
     audit,
+    assumptions: stage.assumptions,
     advisories: [...stage.advisories, ...(trail ?? [])],
     target_slot_hint: stage.targetSlotHint,
   }
   return serializeReport(envelope as unknown as AuditReport)
 }
diff --git a/plugins/prompt-master/src/tools/prompt-compile.ts b/plugins/prompt-master/src/tools/prompt-compile.ts
index f6d542d..0052f0f 100644
--- a/plugins/prompt-master/src/tools/prompt-compile.ts
+++ b/plugins/prompt-master/src/tools/prompt-compile.ts
@@ -14,24 +14,27 @@ export interface CompileArgs {
   target?: string
   shots?: H3ShotsInput
   scenario_id?: string
   form_fields?: Record<string, unknown>
   output_lang?: string
   audit_only?: boolean
   slots?: Record<string, unknown>
   variant?: string
 }
 
-/** StageResult → Envelope（thin view 组装点）；omitResult 用于 audit_only 语义（不返回提示词正文） */
+/** StageResult → Envelope（thin view 组装点）；omitResult 用于 audit_only 语义（不返回提示词正文）。
+ *  MF-3：result 省略仅限 audit_only——非 audit_only 即使 ok=false（critical 闸门）也保留 result
+ *  （对齐旧 compile 行为：ok:true + audit.passed:false 可见编译产物；确定性编译无「修复重试」路径）。 */
 function stageToEnvelope(stage: StageResult, opts?: { omitResult?: boolean }): string {
   const env = JSON.parse(assembleEnvelope(stage)) as Record<string, unknown>
   if (opts?.omitResult) delete env.result
+  else if (env.result === undefined) env.result = stage.result
   return serializeReport(env as never)
 }
 
 const VARIANT_SET = ['base', 'aesthetic', 'turbo']
 
 /** anima 分支：slots → runStage（compileAnima + auditAnima，无 budget）→ Envelope。variant 未知 → 参数错误（t50 Minor 处置）。onStage：成功前打点钩子（日志摘要，不打正文） */
 export function compileAnimaEnvelope(slots: Record<string, unknown> | undefined, variant?: string, auditOnly?: boolean, onStage?: (stage: StageResult) => void): string {
   if (!slots || typeof slots !== 'object') throw new Error('anima 分支需要 slots 输入（AnimaSlots 形状）')
   if (variant !== undefined && !VARIANT_SET.includes(variant)) {
     throw new Error(`未知 variant: ${variant}；可选 base|aesthetic|turbo`)
diff --git a/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts b/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
index c2fd10d..70f219c 100644
--- a/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
@@ -51,28 +51,30 @@ describe('runStage', () => {
 
   it('auditOnly throws when dialect.auditOnlyOk is false', () => {
     registerDialect({ ...fakeDialect, auditOnlyOk: false })
     expect(() => runStage({ target: 'anima', auditOnly: true } as any)).toThrow(/auditOnly/)
   })
 })
 
 describe('assembleEnvelope', () => {
   it('emits P1 envelope with ok/result/audit/advisories/target_slot_hint', () => {
     const s = JSON.parse(assembleEnvelope(
-      { ok: true, result: { x: 1 }, gates: [], advisories: ['a'], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
+      { ok: true, result: { x: 1 }, gates: [], advisories: ['a'], assumptions: ['assumed:1'], targetSlotHint: 't2i.prompt' } as any,
       ['trail'],
     ))
     expect(s.ok).toBe(true)
     expect(s.result).toEqual({ x: 1 })
     expect(s.audit.passed).toBe(true)
     // Task 4 定案：audit 收敛为 {passed, gates, budget?}——assumptions/advisories 不再入 audit 对象
     expect(Object.keys(s.audit).sort()).toEqual(['gates', 'passed'])
+    // MF-2：内核计算的 assumptions 必须到达 Envelope（顶层，与 advisories 并列）
+    expect(s.assumptions).toEqual(['assumed:1'])
     expect(s.target_slot_hint).toBe('t2i.prompt')
     expect(s.advisories).toEqual(['a', 'trail'])
   })
 
   it('omits result when ok=false (audit_only semantics)', () => {
     const s = JSON.parse(assembleEnvelope(
       { ok: false, result: {}, gates: [{ rule: 'x', target: 'anima', severity: 'critical', detail: 'd' }], advisories: [], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
     ))
     expect(s.ok).toBe(false)
     expect(s.result).toBeUndefined()
diff --git a/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts b/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts
index 6450f47..2e7348e 100644
--- a/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts
@@ -1,14 +1,15 @@
 // tests/pe-framework/resources/resolve.test.ts
 import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
 import { join, sep } from 'node:path'
 import { setPresetRoot, getPresetRoot, resolveKnowledgePath } from '../../../src/pe-framework/resources/resolve.js'
+import { catalogPath, setCatalogPath, closeCatalog } from '../../../src/pe-framework/dialect/anima-catalog.js'
 
 describe('resolveKnowledgePath', () => {
   beforeEach(() => setPresetRoot('C:/fake-preset'))
   afterEach(() => setPresetRoot(undefined))
 
   it('joins presetRoot + skillDir + knowledge + asset', () => {
     expect(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' }))
       .toBe('C:\\fake-preset\\skills\\anima-prompt-v1\\knowledge\\tag-catalog.sqlite')
   })
 
@@ -44,10 +45,41 @@ describe('resolveKnowledgePath', () => {
   it('uses DSH_COMFYUI_PRESET_ROOT env when no explicit presetRoot is set', () => {
     setPresetRoot(undefined)
     vi.stubEnv('DSH_COMFYUI_PRESET_ROOT', 'C:/env-root')
     try {
       expect(resolveKnowledgePath({ skillDir: 'x', asset: 'y.json' })).toBe(join('C:/env-root', 'skills', 'x', 'knowledge', 'y.json'))
     } finally {
       vi.unstubAllEnvs()
     }
   })
 })
+
+// MF-1：catalog 路径惰性解析——setPresetRoot 在 import 之后（插件 apply 期）改变时 catalogPath 必须跟随
+describe('anima-catalog lazy path resolution', () => {
+  afterEach(() => {
+    setCatalogPath(process.env.ANIMA_CATALOG_PATH ?? '')
+    delete (process.env as Record<string, string | undefined>).ANIMA_CATALOG_PATH
+    closeCatalog()
+  })
+
+  it('catalogPath() reflects setPresetRoot called after module import', () => {
+    setPresetRoot('C:/late-preset')
+    expect(catalogPath()).toBe(join('C:/late-preset', 'skills', 'anima-prompt-v1', 'knowledge', 'tag-catalog.sqlite'))
+    setPresetRoot('C:/other-preset')
+    expect(catalogPath()).toBe(join('C:/other-preset', 'skills', 'anima-prompt-v1', 'knowledge', 'tag-catalog.sqlite'))
+  })
+
+  it('setCatalogPath override wins over presetRoot; clearing restores lazy default', () => {
+    setPresetRoot('C:/late-preset')
+    setCatalogPath('C:/custom/catalog.sqlite')
+    expect(catalogPath()).toBe('C:/custom/catalog.sqlite')
+    setCatalogPath('')
+    expect(catalogPath()).toBe(join('C:/late-preset', 'skills', 'anima-prompt-v1', 'knowledge', 'tag-catalog.sqlite'))
+  })
+
+  it('ANIMA_CATALOG_PATH env takes priority level 0 over presetRoot', () => {
+    setPresetRoot('C:/late-preset')
+    process.env.ANIMA_CATALOG_PATH = 'C:/env/catalog.sqlite'
+    setCatalogPath('') // re-derive override from env
+    expect(catalogPath()).toBe('C:/env/catalog.sqlite')
+  })
+})
diff --git a/plugins/prompt-master/tests/plugin/compile-h3.test.ts b/plugins/prompt-master/tests/plugin/compile-h3.test.ts
index 516b70e..06fb1ca 100644
--- a/plugins/prompt-master/tests/plugin/compile-h3.test.ts
+++ b/plugins/prompt-master/tests/plugin/compile-h3.test.ts
@@ -39,20 +39,33 @@ describe('prompt_compile (target=h3)', () => {
     const raw = await run({
       target: 'h3',
       stage: 'ref2va',
       shots: { duration_seconds: 8, shots: [{ what: 'x', who: 'A' }] },
       form_fields: { references: [{ who: 'A', image: 'a.png' }, { who: 'B', image: 'b.png' }] },
     })
     expect(raw.audit.passed).toBe(false) // 审计闸门经 audit.passed 表达
     expect(raw.audit.gates.some((g: any) => g.rule === 'ref_count' && g.severity === 'critical')).toBe(true)
   })
 
+  it('MF-3: critical gate keeps result for non-audit_only compile (ok=false but result.text present)', async () => {
+    const raw = await run({
+      target: 'h3',
+      stage: 'ref2va',
+      shots: { duration_seconds: 8, shots: [{ what: 'x', who: 'A' }] },
+      form_fields: { references: [{ who: 'A', image: 'a.png' }, { who: 'B', image: 'b.png' }] },
+    })
+    expect(raw.ok).toBe(false)
+    expect(raw.result).toBeDefined()
+    expect(typeof raw.result.text).toBe('string')
+    expect(raw.result.text.length).toBeGreaterThan(0)
+  })
+
   it('budget counter is official-tokenizer (T12 switch)', async () => {
     const raw = await run({ target: 'h3', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } })
     expect(raw.audit.budget.counter).toBe('official-tokenizer')
   })
 
   it('unknown target errors with DIALECT_NOT_AVAILABLE', async () => {
     await expect(runTool(stubCtx(), def(), { target: 'sd', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } } as any)).rejects.toThrow(/DIALECT_NOT_AVAILABLE/)
   })
 
   it('stage inference via tool: references → ref2va, else t2va, full_reference scenario → ref2va', async () => {
```
