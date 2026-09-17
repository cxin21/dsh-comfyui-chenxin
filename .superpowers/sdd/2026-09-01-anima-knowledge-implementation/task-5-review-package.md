# Review package - 3d55a19..72a6916

## Commits
``````

## Stat
``` plugins/prompt-master/src/pe-framework/render/envelope.ts  |  4 +++-
 plugins/prompt-master/src/tools/prompt-compile.ts          | 12 +++++++++---
 .../tests/pe-framework/pipeline/runStage.test.ts           |  8 ++++++++
 plugins/prompt-master/tests/plugin/compile-anima.test.ts   | 14 ++++++++++++++
 4 files changed, 34 insertions(+), 4 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/render/envelope.ts b/plugins/prompt-master/src/pe-framework/render/envelope.ts
index 1f790ea..2f3175f 100644
--- a/plugins/prompt-master/src/pe-framework/render/envelope.ts
+++ b/plugins/prompt-master/src/pe-framework/render/envelope.ts
@@ -18,27 +18,29 @@ export interface EnvelopeObservability {
   corrections?: number
   loopExhausted?: boolean
   joyExtraFiltered?: boolean
   sanitizeChanged?: boolean
   continueRounds?: number
   continueWarnings?: string[]
   /** 各管线阶段耗时（ms）；内核 trace 摘要，供 GUI/模型可见性 */
   traceStages?: Array<{ name: string; ms: number }>
 }
 
-export function assembleEnvelope(stage: StageResult, trail?: string[], observability?: EnvelopeObservability): string {
+export function assembleEnvelope(stage: StageResult, trail?: string[], observability?: EnvelopeObservability, dialectTopLevel?: Record<string, unknown>): string {
   const audit = {
     passed: stage.ok,
     gates: stage.gates,
     ...(stage.budget !== undefined ? { budget: stage.budget } : {}),
   }
   const envelope: Record<string, unknown> = {
     ok: stage.ok,
     ...(stage.ok ? { result: stage.result } : {}),
     audit,
     assumptions: stage.assumptions,
     advisories: [...stage.advisories, ...(trail ?? [])],
     target_slot_hint: stage.targetSlotHint,
     ...(observability !== undefined ? { observability } : {}),
+    // G2：方言顶层投影（如 anima phase_status）最后合并——方言键不被基础键覆盖，h3 不传则无变化
+    ...(dialectTopLevel ?? {}),
   }
   return serializeReport(envelope as unknown as AuditReport)
 }
diff --git a/plugins/prompt-master/src/tools/prompt-compile.ts b/plugins/prompt-master/src/tools/prompt-compile.ts
index 0052f0f..71a70b6 100644
--- a/plugins/prompt-master/src/tools/prompt-compile.ts
+++ b/plugins/prompt-master/src/tools/prompt-compile.ts
@@ -17,38 +17,44 @@ export interface CompileArgs {
   form_fields?: Record<string, unknown>
   output_lang?: string
   audit_only?: boolean
   slots?: Record<string, unknown>
   variant?: string
 }
 
 /** StageResult → Envelope（thin view 组装点）；omitResult 用于 audit_only 语义（不返回提示词正文）。
  *  MF-3：result 省略仅限 audit_only——非 audit_only 即使 ok=false（critical 闸门）也保留 result
  *  （对齐旧 compile 行为：ok:true + audit.passed:false 可见编译产物；确定性编译无「修复重试」路径）。 */
-function stageToEnvelope(stage: StageResult, opts?: { omitResult?: boolean }): string {
-  const env = JSON.parse(assembleEnvelope(stage)) as Record<string, unknown>
+function stageToEnvelope(stage: StageResult, opts?: { omitResult?: boolean; dialectTopLevel?: Record<string, unknown> }): string {
+  const env = JSON.parse(assembleEnvelope(stage, undefined, undefined, opts?.dialectTopLevel)) as Record<string, unknown>
   if (opts?.omitResult) delete env.result
   else if (env.result === undefined) env.result = stage.result
   return serializeReport(env as never)
 }
 
 const VARIANT_SET = ['base', 'aesthetic', 'turbo']
 
 /** anima 分支：slots → runStage（compileAnima + auditAnima，无 budget）→ Envelope。variant 未知 → 参数错误（t50 Minor 处置）。onStage：成功前打点钩子（日志摘要，不打正文） */
 export function compileAnimaEnvelope(slots: Record<string, unknown> | undefined, variant?: string, auditOnly?: boolean, onStage?: (stage: StageResult) => void): string {
   if (!slots || typeof slots !== 'object') throw new Error('anima 分支需要 slots 输入（AnimaSlots 形状）')
   if (variant !== undefined && !VARIANT_SET.includes(variant)) {
     throw new Error(`未知 variant: ${variant}；可选 base|aesthetic|turbo`)
   }
   const stage = runStage({ target: 'anima', slots, variant, auditOnly: auditOnly === true })
   onStage?.(stage)
-  return stageToEnvelope(stage, { omitResult: auditOnly === true })
+  return stageToEnvelope(stage, {
+    omitResult: auditOnly === true,
+    // G2：anima 四阶段状态投影到 Envelope 顶层（SKILL.md 343-356 要求原样上报）；audit_only 时 result 被 omit，顶层投影仍可见
+    dialectTopLevel: typeof stage.result === 'object' && stage.result !== null && 'phase_status' in stage.result
+      ? { phase_status: (stage.result as { phase_status: unknown }).phase_status }
+      : undefined,
+  })
 }
 
 export function registerCompileTool(ctx?: Context) {
   type LogCtx = { logger?: { info?: (msg: string) => void } }
   const logInfo = (msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)
   return defineTool({
     name: 'prompt_compile',
     description:
       '确定性编译+审计：target=h3（场景/shots → official dialect 文本+审计）或 target=anima（slots → positive/negative+审计；无 budget）。h3 budget counter=estimate（T12 前）。',
     parameters: {
diff --git a/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts b/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
index 70f219c..156530d 100644
--- a/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
@@ -65,19 +65,27 @@ describe('assembleEnvelope', () => {
     expect(s.result).toEqual({ x: 1 })
     expect(s.audit.passed).toBe(true)
     // Task 4 定案：audit 收敛为 {passed, gates, budget?}——assumptions/advisories 不再入 audit 对象
     expect(Object.keys(s.audit).sort()).toEqual(['gates', 'passed'])
     // MF-2：内核计算的 assumptions 必须到达 Envelope（顶层，与 advisories 并列）
     expect(s.assumptions).toEqual(['assumed:1'])
     expect(s.target_slot_hint).toBe('t2i.prompt')
     expect(s.advisories).toEqual(['a', 'trail'])
   })
 
+  it('dialectTopLevel keys merge into envelope top level', () => {
+    const s = JSON.parse(assembleEnvelope(
+      { ok: true, result: { x: 1 }, gates: [], advisories: [], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
+      [], undefined, { phase_status: { policy: 'PASS' } },
+    ))
+    expect(s.phase_status).toEqual({ policy: 'PASS' })
+  })
+
   it('omits result when ok=false (audit_only semantics)', () => {
     const s = JSON.parse(assembleEnvelope(
       { ok: false, result: {}, gates: [{ rule: 'x', target: 'anima', severity: 'critical', detail: 'd' }], advisories: [], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
     ))
     expect(s.ok).toBe(false)
     expect(s.result).toBeUndefined()
     expect(s.audit.passed).toBe(false)
   })
 })
diff --git a/plugins/prompt-master/tests/plugin/compile-anima.test.ts b/plugins/prompt-master/tests/plugin/compile-anima.test.ts
index 1df48d3..0e7fa2d 100644
--- a/plugins/prompt-master/tests/plugin/compile-anima.test.ts
+++ b/plugins/prompt-master/tests/plugin/compile-anima.test.ts
@@ -93,19 +93,33 @@ describe('prompt_compile (target=anima)', () => {
     expect(segs.every((s) => typeof s.priority === 'number')).toBe(true)
   })
 
   it('G2: phase_status four stages', async () => {
     const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
       target: 'anima', slots: { count_gender: ['1girl'] },
     })))
     expect(raw.result.phase_status).toEqual({ policy: 'PASS', grounding: 'PASS', composition: 'PASS', inspection: 'PASS' })
   })
 
+  it('G2: phase_status projected at envelope top level', async () => {
+    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
+      target: 'anima', slots: { count_gender: ['1girl'] },
+    })))
+    expect(raw.phase_status).toEqual({ policy: 'PASS', grounding: 'PASS', composition: 'PASS', inspection: 'PASS' })
+  })
+
+  it('G2: h3 envelope has no top-level phase_status', async () => {
+    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
+      target: 'h3', shots: { duration_seconds: 5, shots: [{ what: '女孩走进便利店', dialogue: ['你好'] }] },
+    })))
+    expect('phase_status' in raw).toBe(false)
+  })
+
   it('G2: metadata carries variant', async () => {
     const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
       target: 'anima', slots: { count_gender: ['1girl'] }, variant: 'aesthetic',
     })))
     expect(raw.result.metadata).toEqual({ variant: 'aesthetic' })
   })
 
   afterAll(() => closeCatalog())
 })
\ No newline at end of file
```
