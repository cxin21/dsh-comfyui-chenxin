# Scoped re-review — T3 fix (single commit 074cd4d)

## Fix diff (-U10)
```diff
commit 074cd4d58802e837f16463b4ab53778f601c9bfb
Author: cxin21 <1124569937@qq.com>
Date:   Tue Sep 1 08:42:30 2026 +0800

    fix(prompt-master): scope full_reference continue contract by scenario id (product_ad/brand_promo are t2va)

diff --git a/plugins/prompt-master/src/pe-framework/schema/scenes.ts b/plugins/prompt-master/src/pe-framework/schema/scenes.ts
index f5a49cf..f309565 100644
--- a/plugins/prompt-master/src/pe-framework/schema/scenes.ts
+++ b/plugins/prompt-master/src/pe-framework/schema/scenes.ts
@@ -31,23 +31,31 @@ export const SCENE_OUTPUT_CONTRACTS: Record<string, OutputContract> = {
     ],
   },
   director_segments: {
     id: 'minimax-director-segments',
     fields: [],
     groupSeparator: /={3,}\s*提示词组\s*(\d+)\s*={3,}/,
     expectedGroups: (ff) => Number(ff?.['segment_count'] ?? 4),
   },
 }
 
-/** 场景 → 输出契约解析：先按场景 id，再按 outputMode（声明制，未声明 → undefined） */
+/**
+ * 场景 → 输出契约解析：六段式 ref2va 契约只按场景 id 匹配——product_ad / brand_promo
+ * 虽然也是 outputMode 'full_reference'，但 pickStage 把它们路由到 t2va（三字段体），
+ * 永远不会出现六个 ref2va 段名 → 按 mode 兜底会导致无限续写轮。
+ * director_segments 按 mode 兜底安全：catalog 里只有 continuous_story 用它。
+ */
 export function sceneOutputContract(scenarioId: string, outputMode?: string): OutputContract | undefined {
-  return SCENE_OUTPUT_CONTRACTS[scenarioId] ?? (outputMode ? SCENE_OUTPUT_CONTRACTS[outputMode] : undefined)
+  const byId = SCENE_OUTPUT_CONTRACTS[scenarioId]
+  if (byId) return byId
+  if (outputMode === 'director_segments') return SCENE_OUTPUT_CONTRACTS['director_segments']
+  return undefined
 }
 
 export interface SceneMap {
   scenarioId: string
   toShots(scenarioId: string, formFields: Record<string, unknown>, lang?: string): H3ShotsInput | null
 }
 
 const META_KEYS = [
   'duration_seconds', 'duration', 'seconds', '时长',
   'aspect_ratio', 'expand_mode', 'output_lang', 'prompt_language',
diff --git a/plugins/prompt-master/tests/plugin/minimax-continue.test.ts b/plugins/prompt-master/tests/plugin/minimax-continue.test.ts
index cbc6b2a..8a855cb 100644
--- a/plugins/prompt-master/tests/plugin/minimax-continue.test.ts
+++ b/plugins/prompt-master/tests/plugin/minimax-continue.test.ts
@@ -66,11 +66,26 @@ describe('minimax_scenario continue (contract-declared)', () => {
 
   it('complete output with stop finish → no continuation round', async () => {
     const full = SIX_LABELS.map((l) => `${l}: content-${l}`).join('\n')
     const ctx = seqCtx([streamWith(full, 'stop')])
     const v = JSON.parse(
       String(await runTool(ctx, def(ctx), { scenario_id: 'full_reference', form_fields: { subject: 'cat' } })),
     )
     expect(String(v.prompt)).toContain('non_diegetic_music: content-non_diegetic_music')
     expect(ctx.llm.calls.length).toBe(1)
   })
+
+  it('product_ad (full_reference outputMode but t2va stage) complete three-field body → exactly 1 llm call', async () => {
+    // t2va 三字段体（integrated_multimodal_description / overall_soundscape / non_diegetic_music）
+    const t2vaBody =
+      'integrated_multimodal_description: A glossy product shot of the bottle rotating on a pedestal.\n' +
+      'overall_soundscape: crisp fizz; subtle whoosh\n' +
+      'non_diegetic_music: upbeat electronic track'
+    const ctx = seqCtx([streamWith(t2vaBody, 'stop')])
+    const v = JSON.parse(
+      String(await runTool(ctx, def(ctx), { scenario_id: 'product_ad', form_fields: { subject: 'bottle' } })),
+    )
+    expect(String(v.prompt)).toContain('integrated_multimodal_description')
+    // 回归：full_reference 六段契约不得按 outputMode 兜底到 t2va 场景（否则空轮续写 ×3）
+    expect(ctx.llm.calls.length).toBe(1)
+  })
 })
```
