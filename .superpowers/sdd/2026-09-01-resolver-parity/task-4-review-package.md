# Review package - 9c6c951..3cc4e64

## Commits
``````

## Stat
``` plugins/prompt-master/src/resolver/index.ts        |  4 +-
 .../src/resolver/profiles/expand-rules.ts          |  4 ++
 .../prompt-master/src/resolver/profiles/index.ts   |  3 ++
 .../src/resolver/profiles/reverse/comfyui.ts       |  2 +-
 .../tests/resolver/parity-low.test.ts              | 60 ++++++++++++++++++++++
 5 files changed, 70 insertions(+), 3 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/resolver/index.ts b/plugins/prompt-master/src/resolver/index.ts
index 0e6126d..b56b4d7 100644
--- a/plugins/prompt-master/src/resolver/index.ts
+++ b/plugins/prompt-master/src/resolver/index.ts
@@ -135,22 +135,22 @@ export function resolveExpand(profile: PEProfile, params: ExpandParams): ExpandR
     user,
     maxTokens: resolveExpandMaxTokens(expandLen, expandLenChars, tokenLimits),
     ruleId: profile.id,
   };
 }
 
 function ensureCustomExpandSystem(system: string, outputLang: string, shortText: string): string {
   let s = String(system || '').trim();
   const useEn = resolveUseEnglishOutput(outputLang, shortText);
   const guard = useEn
-    ? ' Expand ONLY the source text labeled「待扩写原文」or「Source text to expand」. Never treat style names as the subject to elaborate.'
-    : ' 仅扩写用户消息中「待扩写原文」一段为绘图正向提示词；不要把风格名、扩写规则本身扩写成说明文。';
+    ? ' Expand ONLY the source text labeled「待扩写原文」or「Source text to expand」in the user message. Never treat style names or expansion rules as the subject to elaborate.'
+    : ' 仅扩写用户消息中「待扩写原文」一段为绘图正向提示词；不要把风格名、扩写规则本身扩写成说明文或散文。';
   if (!/待扩写原文|Source text to expand|用户输入|User input/i.test(s)) s += guard;
   return s;
 }
 
 /**
  * 反推管道：profile + params  →  {system, userLead, userBody, outputConstraints, userTail}
  * 对应 PromptMaster 的 resolveReversePrompts()
  * 内部走 reverse/router.ts 路由到 Comfyui / Descriptive / Danbooru / Anima3 / Prose 模块
  */
 export function resolveReverse(profile: PEProfile, params: ReverseParams): ReverseResult {
diff --git a/plugins/prompt-master/src/resolver/profiles/expand-rules.ts b/plugins/prompt-master/src/resolver/profiles/expand-rules.ts
index 1ca9299..8e686d9 100644
--- a/plugins/prompt-master/src/resolver/profiles/expand-rules.ts
+++ b/plugins/prompt-master/src/resolver/profiles/expand-rules.ts
@@ -1,14 +1,18 @@
 // 扩写规则 — 1:1 移植 PromptMaster config/promptExpandRules.js
 // 8 种扩写 Profile + 篇幅控制 + 输出语言锁定
 
 // === 篇幅预设 ===
+// E1 (审计 2026-08-31-resolver-3.1.0-diff.md §10): 上游 promptExpandRules.js:189-233 每条预设还带 labelUi
+// （如 `标准（约 150～300 字）`），EXPAND_LENGTH_OPTIONS 取 `label: p.labelUi || p.label` 作为 UI 完整文案。
+// 本 port 的数据结构不承载 labelUi（port-only 决定，T4 裁决）：preset 类型无该字段，UI label 保留短词，
+// 完整篇幅语义由 listExpandLengthsForUi 的 description（= hintZh）承载；不影响 prompt 文本（hintZh/hintEn/maxTokens 逐字一致）。
 export const EXPAND_LENGTH_PRESETS: Record<string, {
   label: string; maxTokens: number; hintZh: string; hintEn: string;
 }> = {
   very_short: {
     label: '极简', maxTokens: 128,
     hintZh: '打标/扩写结果控制在 80 字以内（或等价英文词数），只保留最关键信息，禁止冗长描述与重复堆砌。',
     hintEn: 'Keep output within 80 words or equivalent; essential details only, no verbosity.',
   },
   short: {
     label: '简短', maxTokens: 256,
diff --git a/plugins/prompt-master/src/resolver/profiles/index.ts b/plugins/prompt-master/src/resolver/profiles/index.ts
index cacb2eb..fa810f3 100644
--- a/plugins/prompt-master/src/resolver/profiles/index.ts
+++ b/plugins/prompt-master/src/resolver/profiles/index.ts
@@ -52,20 +52,23 @@ const BUILTIN_REVERSE_PROFILES: PEProfile[] = [
     category: '反推',
     description: '一行英文 Danbooru 风格 tag（短语内空格）。',
     enabled: true, sort: 30,
     outputFormat: 'danbooru_tags',
     tags: REVERSE_TAGS.Danbooru_tag_list,
     subjectDomains: ['general', 'portrait'],
   },
 ];
 
 // ========== 8 种内置扩写 Profile（来自 expand-rules.ts 的 EXPAND_RULES）==========
+// legacy-name collision: PM 3.1.0 内置该 id 为其他语义；本 port 保留 expand 语义（消费方为 expand 路由）
+// （审计 R1：pe_expand_natural 等在 LEGACY_EXPAND_PE_ID_MAP 中是应映射到 pe_expand_descriptive/pe_expand_sd 的旧 id；
+//   port 将其注册为现役 expand profile，legacy 映射对这些 key 不会被触发——id 体系保持不变，此处仅声明语义）
 function buildBuiltinExpandProfiles(): PEProfile[] {
   return EXPAND_RULES.map((r, i) => ({
     id: `pe_${r.id}`,
     kind: 'expand',
     builtin: true,
     builtinKey: r.id,
     name: r.name,
     category: r.category,
     description: r.description,
     enabled: true,
diff --git a/plugins/prompt-master/src/resolver/profiles/reverse/comfyui.ts b/plugins/prompt-master/src/resolver/profiles/reverse/comfyui.ts
index 15cb18e..5b70680 100644
--- a/plugins/prompt-master/src/resolver/profiles/reverse/comfyui.ts
+++ b/plugins/prompt-master/src/resolver/profiles/reverse/comfyui.ts
@@ -388,21 +388,21 @@ export const COMFYUI_EXTRA_TEMPLATES: Record<string, { zh: string; en: string }>
   comfyui_video_motion: {
     zh: '必须写清动作过程与运镜；在完整还原静态样貌（含头手腿朝向）的前提下描述动态。',
     en: 'State motion and camera; keep full static fidelity including head/hand/leg orientation.',
   },
   comfyui_lora_character: {
     zh: '仅描述场景、背景、构图、光影、姿态（含头/手/腿朝向与动作）、表情；不描述人物外貌、服装、发型、年龄、性别（人物 LoRA 训练用）。',
     en: 'Scene, background, composition, lighting, pose incl. head/hand/leg—NO face/clothing/hair/age/gender (character LoRA).',
   },
   comfyui_lora_style: {
     zh: '描述主体、环境、姿态（含四肢与朝向）、互动；删除画风、媒介、渲染方式与质量词（风格 LoRA 训练用）。',
-    en: 'Subject, environment, pose/orion, interaction—strip style/medium/quality (style LoRA).',
+    en: 'Subject, environment, pose/orientation, interaction—strip style/medium/quality (style LoRA).',
   },
   comfyui_fidelity_max: {
     zh: '最高优先级：还原度。逐项扫视检查表，人物必须写头朝向、视线、表情、双手动作、双腿与脚姿态、持物方式；禁止概括性省略。',
     en: 'Priority: maximum fidelity. Full checklist; for people include head/gaze, both hands, legs/feet, grip—no summarization that drops pose.',
   },
 };
 
 // sanitizeOutput — SD/ComfyUI 正向标签行后处理。
 // PM 的 SD 输出清洗实际在 captionPromptEngineering.sanitizeFinalCaption 内完成：
 // 非 ANIMA 直接保留原文 raw，随后由 tagLineSanitize.cleanTagLineBody 去方括号/hex 垃圾/去重。
diff --git a/plugins/prompt-master/tests/resolver/parity-low.test.ts b/plugins/prompt-master/tests/resolver/parity-low.test.ts
new file mode 100644
index 0000000..9589520
--- /dev/null
+++ b/plugins/prompt-master/tests/resolver/parity-low.test.ts
@@ -0,0 +1,60 @@
+// 低危 parity 项测试（审计 2026-08-31-resolver-3.1.0-diff.md §10/§12 优先级 4）
+// C1 comfyui lora_style typo · R1 expand 内置 profile 撞名语义（保留现役）· E1 labelUi port-only 决定 · ensureCustomExpandSystem 守卫文案
+import { describe, it, expect } from 'vitest';
+import { COMFYUI_EXTRA_TEMPLATES } from '../../src/resolver/profiles/reverse/comfyui.js';
+import { resolveExpand } from '../../src/resolver/index.js';
+import { findProfileById } from '../../src/resolver/profiles/index.js';
+import { LEGACY_EXPAND_PE_ID_MAP, mapLegacyExpandPeId } from '../../src/resolver/profiles/expand-mirror.js';
+import { EXPAND_LENGTH_OPTIONS, listExpandLengthsForUi } from '../../src/resolver/profiles/expand-rules.js';
+
+describe('C1: comfyui lora_style 文案 typo（上游 comfyuiPromptEngineering.js:402 pose/orientation）', () => {
+  it('en 文案为 pose/orientation 而非 pose/orion', () => {
+    expect(COMFYUI_EXTRA_TEMPLATES.comfyui_lora_style.en).toContain('pose/orientation');
+    expect(COMFYUI_EXTRA_TEMPLATES.comfyui_lora_style.en).not.toContain('pose/orion');
+  });
+});
+
+describe('R1: 8 个 expand 内置 profile 撞名语义（保持现役 + legacy 映射不变）', () => {
+  it('pe_expand_natural 仍以 expand 语义注册（消费方为 expand 路由）', () => {
+    const p = findProfileById('pe_expand_natural');
+    expect(p).toBeTruthy();
+    expect(p!.kind).toBe('expand');
+    expect(p!.builtinKey).toBe('expand_natural');
+  });
+
+  it('legacy 映射仍保留（pe_expand_natural → pe_expand_descriptive），id 体系未动', () => {
+    expect(LEGACY_EXPAND_PE_ID_MAP.pe_expand_natural).toBe('pe_expand_descriptive');
+    expect(mapLegacyExpandPeId('pe_expand_natural')).toBe('pe_expand_descriptive');
+  });
+});
+
+describe('E1: labelUi 不承载（port-only 决定，T4 裁决）', () => {
+  it('EXPAND_LENGTH_PRESETS 无 labelUi 字段；UI label 保留短词', () => {
+    expect(EXPAND_LENGTH_OPTIONS.find((o) => o.value === 'medium')!.label).toBe('标准');
+  });
+
+  it('完整篇幅语义由 listExpandLengthsForUi 的 description（= hintZh）承载', () => {
+    const medium = listExpandLengthsForUi().find((o) => o.value === 'medium')!;
+    expect(medium.description).toContain('150～300');
+  });
+});
+
+describe('ensureCustomExpandSystem 守卫文案（上游 promptEngineeringResolver.js:82-83 逐字）', () => {
+  it('en 守卫含 "in the user message" 与 "or expansion rules"', () => {
+    const r = resolveExpand(
+      { id: 'custom_expand', kind: 'expand', builtin: false, name: 'x', category: 'x', description: 'x', systemPrompt: '自定义扩写规则。' } as any,
+      { outputLang: 'en', expandLen: 'medium', shortText: 'a cat' },
+    );
+    expect(r.system).toContain('in the user message');
+    expect(r.system).toContain('or expansion rules');
+    expect(r.system).toContain('Never treat style names or expansion rules as the subject to elaborate.');
+  });
+
+  it('zh 守卫含「或散文」', () => {
+    const r = resolveExpand(
+      { id: 'custom_expand', kind: 'expand', builtin: false, name: 'x', category: 'x', description: 'x', systemPrompt: '自定义扩写规则。' } as any,
+      { outputLang: 'zh', expandLen: 'medium', shortText: '一只猫' },
+    );
+    expect(r.system).toContain('扩写成说明文或散文');
+  });
+});
\ No newline at end of file
```
