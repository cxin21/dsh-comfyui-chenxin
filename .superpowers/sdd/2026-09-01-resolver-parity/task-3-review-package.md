# Review package - b804932..9c6c951

## Commits
``````

## Stat
``` plugins/prompt-master/src/resolver/index.ts        |   8 +-
 .../src/resolver/profiles/expand-mirror.ts         |   8 +-
 .../src/resolver/profiles/reverse/anima3.ts        |  13 +--
 .../src/resolver/profiles/reverse/descriptive.ts   |   9 +-
 .../tests/resolver/parity-medium.test.ts           | 107 +++++++++++++++++++++
 5 files changed, 126 insertions(+), 19 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/resolver/index.ts b/plugins/prompt-master/src/resolver/index.ts
index 80c5819..0e6126d 100644
--- a/plugins/prompt-master/src/resolver/index.ts
+++ b/plugins/prompt-master/src/resolver/index.ts
@@ -17,20 +17,22 @@ import {
 import { renderTemplate, blockOrEmpty, userTemplateHasInputPlaceholder, appendExpandSourceBlock } from './renderer.js';
 import {
   buildSystemPrompt as routerBuildSystemPrompt,
   buildSystemAddons,
   buildUserTaskLead,
   buildUserTaskBody,
   buildUserTaskTail,
   buildOutputConstraints,
 } from './profiles/reverse/router.js';
 import { isReverseCatalogExpandProfile, resolveExpandFromReverseMirror } from './profiles/expand-mirror.js';
+// V1：自定义反推分支的长度块走 CaptionLen（PM promptEngineeringResolver.js:227 CaptionLen.buildCaptionLengthBlock）
+import { buildCaptionLengthBlock } from './profiles/reverse/length.js';
 import { isMinimaxScenarioProfile, resolveMinimaxScenarioExpand, isH3FullReferenceProfile, resolveH3FullReferenceExpand } from './minimax/index.js';
 
 // 给 router 函数起别名避免和上面 expand 解析中的 buildSystemPrompt 冲突
 const buildSystemPrompt = routerBuildSystemPrompt;
 
 /**
  * 扩写管道：profile + params  →  {system, user, maxTokens}
  * 完全对应 PromptMaster 的 resolveExpandPrompts()
  */
 export function resolveExpand(profile: PEProfile, params: ExpandParams): ExpandResult {
@@ -165,22 +167,24 @@ export function resolveReverse(profile: PEProfile, params: ReverseParams): Rever
       outputConstraints: buildOutputConstraints(cap),
       userTail: buildUserTaskTail(cap),
     };
   }
 
   // 自定义 Profile
   const zh = (cap.caption_lang || 'en') === 'zh';
   let system = String(profile.systemPrompt || '').trim();
   system = applyOutputLanguage(system, cap.caption_lang || 'zh');
 
-  // 标题块（PM 中用 CaptionLen.buildCaptionLengthBlock）
-  system += '\n\n' + routerBuildSystemPrompt(cap, mediaTarget);
+  // V1：上游此处追加 CaptionLen.buildCaptionLengthBlock(cap)（resolver.js:227）；
+  // port 曾误用 routerBuildSystemPrompt 顶替长度块——恢复长度块。JoyExtra enforcement 块
+  // （resolver.js:228）按既定裁剪方针维持不移植。
+  system += buildCaptionLengthBlock(cap);
 
   const taskLead = zh
     ? '请根据当前媒体内容，严格按系统提示词要求输出反推结果。只输出正文，不要解释。'
     : 'Analyze the media and output the caption per system instructions. Output body only.';
 
   // 走模板
   const userTpl = (cap.userPromptTemplate || '{{task_lead}}\n\n{{length_block}}\n\n{{extra_block}}').toString();
   let user = userTpl.includes('{{') ? renderTemplate(userTpl, {
     task_lead: taskLead,
     length_block: '',
diff --git a/plugins/prompt-master/src/resolver/profiles/expand-mirror.ts b/plugins/prompt-master/src/resolver/profiles/expand-mirror.ts
index b71579d..4a03acd 100644
--- a/plugins/prompt-master/src/resolver/profiles/expand-mirror.ts
+++ b/plugins/prompt-master/src/resolver/profiles/expand-mirror.ts
@@ -1,17 +1,17 @@
 // 反推→扩写镜像管线 — 1:1 移植自 PM expandReverseMirror.js
 
 import { resolveExpandSystemMessage, buildExpandUserPrompt, resolveExpandMaxTokens, applyExpandLength, applyUserExtraPrompt, applyOutputLanguage } from './expand-rules.js';
 import { PROMPTS_B } from './torii/prompts.js';
 import { isStructuredTemplateProfile } from './torii/formats.js';
 import { PEProfile, ExpandResult } from '../types.js';
-import * as ComfyuiPE from './reverse/comfyui.js';
+import { buildSystemPrompt as routerBuildSystemPrompt, buildSystemAddons as routerBuildSystemAddons } from './reverse/router.js';
 import { renderTemplate } from '../renderer.js';
 
 function mirrorProfileForExpand(src: PEProfile): PEProfile {
   let id = String(src.id || '').trim();
   if (id.startsWith('pe_reverse_')) id = id.replace(/^pe_reverse_/, 'pe_expand_');
   else if (id.startsWith('pe_torii_')) id = id.replace(/^pe_torii_/, 'pe_expand_torii_');
   else if (id && !id.startsWith('pe_expand_')) id = `pe_expand_${id.replace(/^pe_/, '')}`;
 
   return {
     ...src,
@@ -89,38 +89,40 @@ export function resolveExpandFromReverseMirror(profile: PEProfile, params: any):
   }
 
   const cap = {
     type: (profile as any).builtinKey || 'Descriptive',
     caption_lang: outputLang,
     len: expandLen,
     caption_len_chars: expandLenChars,
     media_target: 'image',
   } as any;
 
-  let system = ComfyuiPE.buildExpertSystemPrefix(cap, 'image') + ComfyuiPE.buildFaithfulReproductionBlock(cap, 'image');
+  // M1：上游 expandReverseMirror.js:125-126 走 CaptionPE.buildSystemPrompt + buildSystemAddons
+  // （按 type 路由 Descriptive/Danbooru/Anima3，并叠加 workflow/长度 addon），非 ComfyUI 双块硬编码
+  let system = routerBuildSystemPrompt(cap, 'image') + routerBuildSystemAddons(cap, 'image');
   system = adaptReversePeSystemForExpand(system, outputLang);
   system = applyExpandLength(system, expandLen, outputLang, expandLenChars);
   system = applyUserExtraPrompt(system, userExtraPrompt, outputLang);
 
   const user = buildExpandUserPrompt(
     shortText,
     expandLen,
     outputLang,
     expandLenChars,
     (profile as any).builtinKey,
     userExtraPrompt
   );
 
   return {
     system,
     user,
-    maxTokens: resolveExpandMaxTokens(expandLen, expandLenChars),
+    maxTokens: resolveExpandMaxTokens(expandLen, expandLenChars, tokenLimits),
     ruleId: profile.id,
   };
 }
 
 // 旧 ID → 新 ID 映射（与 PM 中 LEGACY_EXPAND_PE_ID_MAP 对齐）
 export const LEGACY_EXPAND_PE_ID_MAP: Record<string, string> = {
   pe_expand_natural: 'pe_expand_descriptive',
   expand_natural: 'pe_expand_descriptive',
   natural: 'pe_expand_descriptive',
   pe_expand_compact: 'pe_expand_sd',
diff --git a/plugins/prompt-master/src/resolver/profiles/reverse/anima3.ts b/plugins/prompt-master/src/resolver/profiles/reverse/anima3.ts
index d229f8a..852d88f 100644
--- a/plugins/prompt-master/src/resolver/profiles/reverse/anima3.ts
+++ b/plugins/prompt-master/src/resolver/profiles/reverse/anima3.ts
@@ -1,32 +1,27 @@
 // ANIMA3 提示词生成 — 1:1 移植自 PM anima3PromptEngineering.js
 
 // tag 行清洗统一走共享模块 tagLineSanitize.ts（1:1 移植自 PM tagLineSanitize.js），
 // 避免与 router.ts 重复维护两份 cleanTagLineBody 实现。
 import { cleanTagLineBody } from './tagLineSanitize.js';
+// A1：字数档解析统一走 CaptionLen（PM anima3PromptEngineering.js:15 直接委托
+// CaptionLen.resolveAnima3TagCountBand——内联版丢失 custom 分支，此处改为委托 length.ts 的 1:1 移植）
+import { resolveAnima3TagCountBand } from './length.js';
 
 // ANIMA3 主逻辑
 
 function isZh(caption: any): boolean {
   return (caption.caption_lang || 'en') === 'zh';
 }
 
 function resolveTagCountBand(caption: any): { band: string; tier: string } {
-  const len = caption.len || 'medium';
-  const map: Record<string, { band: string; tier: string }> = {
-    very_short: { band: '10-18', tier: 'minimal' },
-    short: { band: '16-30', tier: 'simple' },
-    medium: { band: '22-38', tier: 'standard' },
-    long: { band: '30-48', tier: 'complex' },
-    very_long: { band: '36-55', tier: 'complex' },
-  };
-  return map[len] || map.medium;
+  return resolveAnima3TagCountBand(caption);
 }
 
 const PRIORITY_ZH =
   '【最高优先级·ANIMA3 v3.0】以下规则优先于 ComfyUI 还原检查表、中文逗号标签、叙事描写等一切其它打标约定；冲突时严格执行 ANIMA3。';
 const PRIORITY_EN =
   '[TOP PRIORITY · ANIMA3 v3.0] These rules OVERRIDE ComfyUI fidelity checklists, Chinese comma tags, and any other caption conventions.';
 
 const NO_META_ZH =
   '【严禁输出】自检/分析/小标题/Markdown（含 ** 标题）、self-check、fidelity analysis；内心完成检查，回复有且仅能是一行 tag。';
 const NO_META_EN =
diff --git a/plugins/prompt-master/src/resolver/profiles/reverse/descriptive.ts b/plugins/prompt-master/src/resolver/profiles/reverse/descriptive.ts
index 1c390cf..a21e97f 100644
--- a/plugins/prompt-master/src/resolver/profiles/reverse/descriptive.ts
+++ b/plugins/prompt-master/src/resolver/profiles/reverse/descriptive.ts
@@ -1,33 +1,32 @@
 // 「自然语言」(Descriptive) 反推 — 1:1 移植自 PM descriptivePromptEngineering.js
 // 五点结构 + 极致还原检查表 + 单段自然文本
 
 import * as ComfyuiPE from './comfyui.js';
-import { resolveExpandMaxTokens } from '../expand-rules.js';
+// D1：字数表述统一走 CaptionLen.resolveCaptionWordCountHint（PM descriptivePromptEngineering.js:25 委托，
+// 返回档位文案如「150～300」；旧内联 maxTokens×0.75 裸数字系统性偏离上游）
+import { resolveCaptionWordCountHint } from './length.js';
 
 const DESCRIPTIVE_TYPE = 'Descriptive';
 
 const FIDELITY_PREAMBLE_ZH =
   '【极致还原总则】你的职责是「视觉取证式」反推：像为后续文生图/图生图提供可复现的所见要素清单，而非写作文、讲故事或审美评论。写作前须逐项扫视画面；有则必写、无则省略；只写可见事实，禁止臆造。若画面含人物或拟人主体，头/面/视线、双臂双手（含持物与握法）、双腿双脚与重心、服装配饰材质均为硬性必写项，禁止用「美女/帅哥/精致/一个人」等套话代替。';
 
 const FIDELITY_PREAMBLE_EN =
   '[MAX FIDELITY] Forensic visual extraction for faithful regeneration—not creative writing or story. Scan the frame before writing; include every visible fact, invent nothing. For people/anthropomorphic subjects: head/face orientation, gaze, expression, both arms/hands (grip if holding), legs/feet/weight, clothing materials are mandatory—no generic praise or category-only labels.';
 
 function applies(caption: any): boolean {
   return (caption.type || '') === DESCRIPTIVE_TYPE;
 }
 
 export function resolveWordCountHint(caption: any): string {
-  const len = caption.len || 'medium';
-  const maxTokens = resolveExpandMaxTokens(len, caption.caption_len_chars);
-  // 近似 1 token ≈ 1 word/1.5 字符
-  return String(Math.round(maxTokens * 0.75));
+  return resolveCaptionWordCountHint(caption);
 }
 
 function isZhCaption(caption: any): boolean {
   return (caption.caption_lang || 'en') === 'zh';
 }
 
 function buildFivePointFrameworkBody(caption: any, video: boolean): string {
   const zh = isZhCaption(caption);
   const media = video ? (zh ? '视频画面（含关键帧可见信息）' : 'video (key visible frames)') : zh ? '图像' : 'image';
 
diff --git a/plugins/prompt-master/tests/resolver/parity-medium.test.ts b/plugins/prompt-master/tests/resolver/parity-medium.test.ts
new file mode 100644
index 0000000..0fd5b9a
--- /dev/null
+++ b/plugins/prompt-master/tests/resolver/parity-medium.test.ts
@@ -0,0 +1,107 @@
+// 中危 parity 项测试（审计 2026-08-31-resolver-3.1.0-diff.md §2/§6/§10）
+// M1/M2 expandMirror 非结构化分支 · A1 anima3 custom 字数档 · V1 resolveReverse 长度块 · D1 字数表述
+import { describe, it, expect } from 'vitest';
+import { resolveExpandFromReverseMirror } from '../../src/resolver/profiles/expand-mirror.js';
+import { resolveReverse } from '../../src/resolver/index.js';
+import * as Anima3PE from '../../src/resolver/profiles/reverse/anima3.js';
+import { resolveWordCountHint } from '../../src/resolver/profiles/reverse/descriptive.js';
+
+const mirrorProfile = {
+  id: 'pe_expand_descriptive',
+  kind: 'expand',
+  builtinKey: 'Descriptive',
+} as any;
+
+describe('M1: expandMirror 非结构化分支走 CaptionPE 路由', () => {
+  it('Descriptive 镜像 system 含五点框架/极致还原路线（非 ComfyUI 检查表硬编码）', () => {
+    const r = resolveExpandFromReverseMirror(mirrorProfile, {
+      outputLang: 'zh',
+      expandLen: 'medium',
+      shortText: 'a girl in a garden',
+    });
+    // 上游 CaptionPE.buildSystemPrompt 对 Descriptive 走 descriptivePromptEngineering：
+    // 含「视觉取证式」总则与五点结构框架（旧硬编码 ComfyUI 双块无这两块）
+    expect(r.system).toContain('视觉取证式');
+    expect(r.system).toContain('【五点结构框架·极致还原】');
+    expect(r.system).toContain('【极致还原总则】');
+  });
+
+  it('Descriptive 镜像 system 叠加长度 addon（buildSystemAddons）', () => {
+    const r = resolveExpandFromReverseMirror(mirrorProfile, {
+      outputLang: 'zh',
+      expandLen: 'long',
+      shortText: 'a girl in a garden',
+    });
+    expect(r.system).toContain('【篇幅】');
+  });
+});
+
+describe('M2: expandMirror tokenLimits 透传', () => {
+  it('非结构化分支 maxTokens 尊重 tokenLimits.expandMax', () => {
+    const r = resolveExpandFromReverseMirror(mirrorProfile, {
+      outputLang: 'zh',
+      expandLen: 'long',
+      shortText: 'a girl in a garden',
+      tokenLimits: { expandMax: 256 },
+    });
+    expect(r.maxTokens).toBeLessThanOrEqual(256);
+    expect(r.maxTokens).toBeGreaterThan(0);
+  });
+});
+
+describe('A1: anima3 custom 字数档', () => {
+  it('custom 字数 400 → band 40（round(chars/10)，此前恒按 medium 22-38）', () => {
+    const cap = { caption_lang: 'zh', len: 'custom', caption_len_chars: 400 };
+    const c = Anima3PE.buildOutputConstraints(cap);
+    expect(c).toContain('约 40 个');
+    expect(c).not.toContain('22-38');
+    expect(c).not.toContain('约 22');
+  });
+
+  it('custom 字数 clamp 到 [16, 80]', () => {
+    const lo = Anima3PE.buildOutputConstraints({ caption_lang: 'zh', len: 'custom', caption_len_chars: 50 });
+    const hi = Anima3PE.buildOutputConstraints({ caption_lang: 'zh', len: 'custom', caption_len_chars: 9999 });
+    expect(lo).toContain('约 16 个');
+    expect(hi).toContain('约 80 个');
+  });
+});
+
+describe('V1: resolveReverse 自定义分支恢复长度块', () => {
+  const customProfile = { id: 'custom_rev', builtin: false, systemPrompt: '自定义反推提示。' } as any;
+
+  it('system 追加 CaptionLen.buildCaptionLengthBlock（【篇幅】+ 档位文案）', () => {
+    const r = resolveReverse(customProfile, {
+      caption_lang: 'zh',
+      len: 'long',
+      media_target: 'image',
+    } as any);
+    expect(r.system).toContain('自定义反推提示');
+    expect(r.system).toContain('【篇幅】');
+    expect(r.system).toContain('300～500');
+  });
+
+  it('长度块不再被 router workflow 块顶替（无 ComfyUI 还原检查表）', () => {
+    const r = resolveReverse(customProfile, {
+      caption_lang: 'zh',
+      len: 'medium',
+      media_target: 'image',
+    } as any);
+    expect(r.system).not.toContain('还原检查表·有则必写');
+  });
+});
+
+describe('D1: descriptive/prose 字数表述走 CaptionLen 档位文案', () => {
+  it('medium → 「150～300」（非 maxTokens×0.75 裸数字）', () => {
+    expect(resolveWordCountHint({ caption_lang: 'zh', len: 'medium' })).toBe('150～300');
+  });
+
+  it('custom 字数 → 具体数字字符串', () => {
+    expect(resolveWordCountHint({ caption_lang: 'zh', len: 'custom', caption_len_chars: 200 })).toBe('200');
+  });
+
+  it('descriptive 五点框架正文引用档位文案', async () => {
+    const { buildSystemPrompt } = await import('../../src/resolver/profiles/reverse/descriptive.js');
+    const sys = buildSystemPrompt({ caption_lang: 'zh', len: 'short', type: 'Descriptive' }, 'image');
+    expect(sys).toContain('80～150');
+  });
+});
```
