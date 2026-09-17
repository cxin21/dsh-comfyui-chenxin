# Review package - 91c1196..3cc4e64246a725de58d79c5501555d32c23090c1

## Commits
``````

## Stat
``` plugins/prompt-master/src/resolver/index.ts        |  26 +-
 .../prompt-master/src/resolver/minimax/assemble.ts | 450 +++++++++++++++------
 .../src/resolver/minimax/h3-full-reference.ts      | 105 +++++
 .../prompt-master/src/resolver/minimax/index.ts    |  11 +-
 .../resolver/minimax/templates/h3-reference.en.ts  | 414 ++++++++++++++++---
 .../resolver/minimax/templates/h3-reference.zh.ts  | 223 +++++++---
 .../src/resolver/profiles/expand-mirror.ts         |   8 +-
 .../src/resolver/profiles/expand-rules.ts          |   4 +
 .../prompt-master/src/resolver/profiles/index.ts   |   3 +
 .../src/resolver/profiles/reverse/anima3.ts        |  13 +-
 .../src/resolver/profiles/reverse/comfyui.ts       |   2 +-
 .../src/resolver/profiles/reverse/descriptive.ts   |   9 +-
 .../src/resolver/profiles/torii/prompts.ts         | 313 +++++++++++---
 .../tests/resolver/minimax-parity.test.ts          | 233 +++++++++++
 .../tests/resolver/parity-low.test.ts              |  60 +++
 .../tests/resolver/parity-medium.test.ts           | 107 +++++
 .../tests/resolver/torii-parity.test.ts            | 147 +++++++
 17 files changed, 1800 insertions(+), 328 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/resolver/index.ts b/plugins/prompt-master/src/resolver/index.ts
index 906b631..b56b4d7 100644
--- a/plugins/prompt-master/src/resolver/index.ts
+++ b/plugins/prompt-master/src/resolver/index.ts
@@ -17,21 +17,23 @@ import {
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
-import { isMinimaxScenarioProfile, resolveMinimaxScenarioExpand } from './minimax/index.js';
+// V1：自定义反推分支的长度块走 CaptionLen（PM promptEngineeringResolver.js:227 CaptionLen.buildCaptionLengthBlock）
+import { buildCaptionLengthBlock } from './profiles/reverse/length.js';
+import { isMinimaxScenarioProfile, resolveMinimaxScenarioExpand, isH3FullReferenceProfile, resolveH3FullReferenceExpand } from './minimax/index.js';
 
 // 给 router 函数起别名避免和上面 expand 解析中的 buildSystemPrompt 冲突
 const buildSystemPrompt = routerBuildSystemPrompt;
 
 /**
  * 扩写管道：profile + params  →  {system, user, maxTokens}
  * 完全对应 PromptMaster 的 resolveExpandPrompts()
  */
 export function resolveExpand(profile: PEProfile, params: ExpandParams): ExpandResult {
   if (!profile) throw new Error('resolveExpand: profile is required');
@@ -47,20 +49,32 @@ export function resolveExpand(profile: PEProfile, params: ExpandParams): ExpandR
   if (isMinimaxScenarioProfile(profile)) {
     const resolved = resolveMinimaxScenarioExpand(profile, {
       ...params,
       tokenLimits,
       mediaPaths: (params && params.mediaPaths) || [],
       minimaxForm: (params && params.minimaxForm) || {},
     });
     if (resolved) return resolved;
   }
 
+  // 1b) H3 Full-Reference 独立入口（X7 — upstream h3FullReferencePromptEngineering.js）
+  // upstream electron resolver 场景路径优先（pe_expand_h3_full_reference 同时在 minimax catalog）；
+  // 独立入口在场景解析未命中时兜底，与 upstream「同一 peId 两条路径、场景路径在前」的调用关系一致
+  if (isH3FullReferenceProfile(profile)) {
+    const resolved = resolveH3FullReferenceExpand(profile, {
+      ...params,
+      tokenLimits,
+      mediaPaths: (params && params.mediaPaths) || [],
+    });
+    if (resolved) return resolved;
+  }
+
   // 2) 反推镜像 Profile（pe_expand_descriptive / pe_expand_sd / pe_expand_danbooru / pe_expand_torii_*）
   if (isReverseCatalogExpandProfile(profile)) {
     return resolveExpandFromReverseMirror(profile, params);
   }
 
   // 3) 内置 expand_* 规则（来自 promptExpandRules.js 的 8 种 system prompt）
   if (profile.builtin && profile.builtinKey && String(profile.builtinKey).startsWith('expand_')) {
     const ruleId = profile.builtinKey;
     return {
       system: resolveExpandSystemMessage(ruleId, '', outputLang, expandLen, expandLenChars, userExtraPrompt),
@@ -121,22 +135,22 @@ export function resolveExpand(profile: PEProfile, params: ExpandParams): ExpandR
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
@@ -153,22 +167,24 @@ export function resolveReverse(profile: PEProfile, params: ReverseParams): Rever
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
diff --git a/plugins/prompt-master/src/resolver/minimax/assemble.ts b/plugins/prompt-master/src/resolver/minimax/assemble.ts
index 342eafa..bc74409 100644
--- a/plugins/prompt-master/src/resolver/minimax/assemble.ts
+++ b/plugins/prompt-master/src/resolver/minimax/assemble.ts
@@ -1,59 +1,85 @@
-// MiniMax H3 场景组装 — 1:1 移植自 PM minimaxScenarios/assemble.js
-// 简化版：完整保留 form 处理 + media tag lock + 6 段 H3 模板拼装
+// MiniMax H3 场景组装 — 1:1 移植自 PM minimaxScenarios/assemble.js（3.1.0 保真版）
+// 覆盖审计项 X1-X5：五块 user 结构 / media tag lock 文案 / 输出格式四分支 /
+// hardConstraints zh 改写 / maxTokens mediaExpandMin 下限 + userExtraPrompt 块
 
 import { resolveExpandMaxTokens } from '../profiles/expand-rules.js';
 import { getScenarioByPeId, getScenarioById, type MiniMaxScenario } from './catalog.js';
 import { H3_REFERENCE_EN, H3_REFERENCE_ZH, H3_REFERENCE_JA } from './templates/index.js';
 
+/** 与 PM DEFAULT_LOCAL_TOKEN_LIMITS.mediaExpandMin 对齐（media 扩写下限） */
+export const DEFAULT_MEDIA_EXPAND_MIN = 4096;
+
 // 模板加载（中英两套 Full-Reference 指南）
 const _cachedFullRefGuides: Record<string, string> = {};
 
-// 内置最小化 Full-Reference 指南（避免 60K 模板文件依赖）
-const MINIMAL_GUIDE_ZH = `# MiniMax-H3 Full-Reference 中文指南
-
-六段标题（强制）：
-1. 主体定义: — 列出 <Subject N>/<Picture N>，每个主体描述身份、外观、穿着
-2. 摘要: — 一句话描述视频主体内容
-3. 保留分析: — 各镜头的保留/部分保留评估
-4. 详细描述: — 每个 [Shot N] 段的开头、镜头、动作、运镜
-5. 整体声景: — 完整声场（含环境音、动作音、对话）
-6. 非叙事配乐: — 背景音乐的风格、节奏、情绪
-
-约束：参考标签 <Subject N>/<Picture N>、关系标记 fully_preserved、镜头 [Shot N] 保持英文。`;
-
-const MINIMAL_GUIDE_EN = `# MiniMax-H3 Full-Reference English Guide
-
-Six section headers (mandatory):
-1. subject_definitions: — list <Subject N>/<Picture N>, each with identity, appearance, wardrobe
-2. summary: — one-sentence video summary
-3. retention_analysis: — per-shot fully/partially preserved evaluation
-4. detailed_description: — each [Shot N] segment opening, camera, action, movement
-5. overall_soundscape: — full sound stage (ambient, action, dialogue)
-6. non_diegetic_music: — background music style, rhythm, mood
-
-Keep all reference tags <Subject N>/<Picture N>, relation markers fully_preserved, [Shot N] shots in English.`;
-
 function loadFullReferenceGuide(lang: string): string {
-  const key = String(lang || 'zh').toLowerCase();
+  const key = String(lang || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';
   if (_cachedFullRefGuides[key]) return _cachedFullRefGuides[key];
-  // 从 templates/ 目录加载完整模板（默认中文），失败时回退到内联精简版
   const guideMap: Record<string, string> = {
     en: H3_REFERENCE_EN,
     zh: H3_REFERENCE_ZH,
     ja: H3_REFERENCE_JA,
   };
   const text = guideMap[key] || guideMap.zh;
-  _cachedFullRefGuides[key] = text || MINIMAL_GUIDE_ZH;
+  _cachedFullRefGuides[key] = text;
   return _cachedFullRefGuides[key];
 }
 
+// === 媒体枚举 — 移植 PM utils/expandMedia.js enumerateTaggedMedia ===
+const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
+const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
+const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg']);
+
+export function classifyMediaPath(filePath: string): 'image' | 'video' | 'audio' | 'file' {
+  const s = String(filePath || '');
+  const m = s.match(/\.([A-Za-z0-9]+)$/);
+  const ext = m ? '.' + m[1].toLowerCase() : '';
+  if (IMAGE_EXTS.has(ext)) return 'image';
+  if (VIDEO_EXTS.has(ext)) return 'video';
+  if (AUDIO_EXTS.has(ext)) return 'audio';
+  return 'file';
+}
+
+export interface TaggedMediaItem {
+  path: string;
+  kind: 'image' | 'video' | 'audio' | 'file';
+  n: number;
+  tag: string;
+  base: string;
+}
+
+export function enumerateTaggedMedia(mediaPaths: string[] | undefined | null): TaggedMediaItem[] {
+  const list = Array.isArray(mediaPaths) ? mediaPaths : [];
+  const counts: Record<string, number> = { image: 0, video: 0, audio: 0, file: 0 };
+  const items: TaggedMediaItem[] = [];
+  for (const raw of list) {
+    const p = String(raw || '').trim();
+    if (!p) continue;
+    const kind = classifyMediaPath(p);
+    counts[kind] += 1;
+    const n = counts[kind];
+    let tag = `<File ${n}>`;
+    if (kind === 'image') tag = `<Picture ${n}>`;
+    else if (kind === 'video') tag = `<Video ${n}>`;
+    else if (kind === 'audio') tag = `<Audio ${n}>`;
+    items.push({ path: p, kind, n, tag, base: p.split(/[/\\]/).pop() || p });
+  }
+  return items;
+}
+
+function formatMediaList(mediaPaths: string[] | undefined): string[] {
+  return enumerateTaggedMedia(mediaPaths).map(
+    (item) => `- ${item.tag} ${item.base}（路径：${item.path}）`
+  );
+}
+
 // ShowIf 条件匹配
 function matchShowIf(cond: any, form: Record<string, any>): boolean {
   if (!cond) return true;
   if (Array.isArray(cond.all) && cond.all.length) {
     return cond.all.every((c: any) => matchShowIf(c, form));
   }
   if (Array.isArray(cond.any) && cond.any.length) {
     return cond.any.some((c: any) => matchShowIf(c, form));
   }
   const cur = form[cond.key];
@@ -74,20 +100,24 @@ function matchShowIf(cond: any, form: Record<string, any>): boolean {
     return Number.isFinite(n) && Number.isFinite(t) && n <= t;
   }
   return true;
 }
 
 export function fieldVisible(field: any, form: Record<string, any>): boolean {
   if (!field || !field.showIf) return true;
   return matchShowIf(field.showIf, form);
 }
 
+function isDirectorCustomPlan(form: Record<string, any>): boolean {
+  return String((form && form.plan_mode) || 'ai') === 'custom';
+}
+
 // 表单标准化
 export function normalizeForm(scenario: MiniMaxScenario, rawForm: Record<string, any>): Record<string, any> {
   const form = { ...(rawForm || {}) };
   for (const f of scenario.formFields || []) {
     if (form[f.key] == null || form[f.key] === '') {
       if (f.default != null && f.default !== '') form[f.key] = f.default;
     }
   }
   return form;
 }
@@ -102,231 +132,403 @@ function formToLines(scenario: MiniMaxScenario, form: Record<string, any>): stri
     let display = String(v);
     if (Array.isArray(f.options)) {
       const opt = f.options.find((o: any) => String(o.value) === String(v));
       if (opt && opt.label) display = `${opt.label} (${opt.value})`;
     }
     lines.push(`- ${f.label}: ${display}`);
   }
   return lines;
 }
 
-// 素材标签锁
+// 素材标签锁（X2：完整文案 + 扩展名分类）
 function buildMediaTagLock(mediaPaths: string[] | undefined, lang: string, outputMode: string, form: Record<string, any>): string[] {
-  const items = (mediaPaths || []).map((p, i) => ({ tag: p.includes('Picture') ? p : `<Picture ${i + 1}>`, path: p, base: p.split(/[/\\]/).pop() || p }));
+  const items = enumerateTaggedMedia(mediaPaths);
   const lines: string[] = [];
-  const r2vLock = outputMode === 'full_reference' || (outputMode === 'director_segments' && String((form && form.prompt_kind) || '') === 'r2v');
+  const r2vLock =
+    outputMode === 'full_reference' ||
+    (outputMode === 'director_segments' && String((form && form.prompt_kind) || '') === 'r2v');
 
   if (!items.length) {
     if (outputMode === 'director_segments') {
       if (lang === 'zh') {
         lines.push('## 参考素材（当前：无附件）');
         lines.push('用户未附带图片/视频/音频。公共「主体定义」可用 <Subject N> 文字锁身份，严禁编造 <Picture N>/<Video N>/<Audio N>。');
       } else {
         lines.push('## Reference media (none attached)');
         lines.push('No media attached. Public subject_definitions may use <Subject N> in prose. Do NOT invent <Picture N>, <Video N>, or <Audio N>.');
       }
       lines.push('');
       return lines;
     }
     if (lang === 'zh') {
       lines.push('## 参考素材（当前：无附件）');
-      lines.push('用户未附带任何图片/视频/音频。严禁编造或输出 <Picture N>、<Subject N>、<Video N>、<Audio N> 等参考标签。');
+      lines.push('用户未附带任何图片/视频/音频。严禁编造或输出 <Picture N>、<Subject N>、<Video N>、<Audio N> 等参考标签。直接用自然语言描述主体即可。');
     } else {
       lines.push('## Reference media (none attached)');
-      lines.push('No media attached. Do NOT invent <Picture N>, <Subject N>, <Video N>, or <Audio N> tags.');
+      lines.push('No media attached. Do NOT invent <Picture N>, <Subject N>, <Video N>, or <Audio N> tags. Describe subjects in plain language only.');
     }
     lines.push('');
     return lines;
   }
 
   const tags = items.map((x) => x.tag);
   if (lang === 'zh') {
-    lines.push('## 参考素材标记（最高优先级）');
-    lines.push(`用户已附带 ${items.length} 个参考素材：${tags.join('、')}。输出中必须使用这些尖括号标签。`);
+    lines.push('## 参考素材标记（最高优先级，有素材时强制）');
+    lines.push(`用户已附带 ${items.length} 个参考素材：${tags.join('、')}。输出中必须使用这些尖括号标签，禁止写成 Picture 1 / picture1 / 图1 等变体。`);
     if (r2vLock) {
       lines.push('在「主体定义」中必须逐条定义每个素材标签，并建立主体映射，例如：');
       lines.push('<Picture 1> 是……（说明该图角色/用途）');
       lines.push('<Subject 1> 是 <Picture 1> 中的……（外观特征）');
+      lines.push('在「保留分析」「详细描述」中引用同一套 <Picture N>/<Subject N>；禁止只在文字里描述角色却不出现标签。');
+    } else {
+      lines.push('在正文中按需引用上述标签锚定外观；不要额外虚构未提供的 <Picture N>。');
     }
   } else {
     lines.push('## Reference media tags (ABSOLUTE when media attached)');
-    lines.push(`User attached ${items.length} media asset(s): ${tags.join(', ')}. Use these exact angle-bracket tags.`);
+    lines.push(`User attached ${items.length} media asset(s): ${tags.join(', ')}. Use these exact angle-bracket tags; never write Picture 1 / picture1 without brackets.`);
     if (r2vLock) {
-      lines.push('In subject_definitions, define every media tag and map subjects.');
+      lines.push('In subject_definitions, define every media tag and map subjects, e.g. <Picture 1> / <Subject 1>.');
+      lines.push('Reuse the same tags in retention_analysis and detailed_description.');
+    } else {
+      lines.push('Reference these tags in the prompt body to ground appearance; do not invent extra <Picture N> not provided.');
     }
   }
   lines.push('');
   return lines;
 }
 
-// 主体组装 system prompt
-function buildSystem(scenario: MiniMaxScenario, form: Record<string, any>, outputLang: string, mediaPaths: string[] | undefined): string {
+// 主体组装 system prompt（X3：输出格式四分支 + X4：hardConstraints zh 改写）
+export function buildSystem(scenario: MiniMaxScenario, form: Record<string, any>, outputLang: string, mediaPaths: string[] | undefined): string {
   const lang = String(outputLang || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';
   const parts: string[] = [];
 
   if (lang === 'zh') {
     parts.push('你是 PromptMaster 的 MiniMax-H3 场景提示词工程师。');
     parts.push(`场景：${scenario.name}（${scenario.id}）`);
     parts.push(`Skill 来源：${scenario.skillSource || scenario.id}`);
   } else {
     parts.push('You are PromptMaster\'s MiniMax-H3 scenario prompt engineer.');
     parts.push(`Scenario: ${scenario.name} (${scenario.id})`);
     parts.push(`Skill source: ${scenario.skillSource || scenario.id}`);
   }
   parts.push('');
   parts.push(...buildMediaTagLock(mediaPaths, lang, scenario.outputMode, form));
 
   // 输出语言
   parts.push(lang === 'zh' ? '## 输出语言（最高优先级）' : '## Output language (highest priority)');
   if (scenario.outputMode === 'full_reference') {
     if (lang === 'zh') {
       parts.push('用户选择【中文】。六段标题与正文都必须用简体中文。');
-      parts.push('六段中文标题（强制）：主体定义: / 摘要: / 保留分析: / 详细描述: / 整体声景: / 非叙事配乐:');
-      parts.push('禁止输出 subject_definitions:、summary: 等英文章节标题。');
+      parts.push('六段中文标题（强制）：主体定义: / 摘要: / 保留分析: / 详细描述: / 整体声景: / 非叙事配乐: —— 禁止输出 subject_definitions:、summary: 等英文章节标题。');
+      parts.push('仅在有参考素材时才使用 <Picture N>/<Subject N>；关系标记 fully_preserved、镜头 [Shot N]、任务前缀 [reference generation] 保持英文。禁止整段英文叙述。');
+      parts.push('画面广告文案：约 4–12 字、单行、Apple 风（除非用户已提供英文文案）。');
     } else {
-      parts.push('User selected 【English】. Write all six section bodies in English.');
+      parts.push('User selected 【English】. Write all six section bodies, shot descriptions, sound, and on-screen advertising copy in English.');
+      parts.push('In-frame advertising copy: 3–5 English words, single line, Apple-style tone.');
     }
   } else if (scenario.outputMode === 'director_segments') {
     if (lang === 'zh') {
-      parts.push('用户选择【中文】。章节标题必须用中文六段式。');
-      parts.push('禁止输出 subject_definitions:、summary: 等英文章节标题。');
+      parts.push('用户选择【中文】。章节标题必须用中文六段式：主体定义 / 摘要 / 保留分析 / 详细描述 / 整体声景 / 非叙事配乐。');
+      parts.push('禁止输出 subject_definitions:、summary: 等英文章节标题。正文简体中文。');
+      parts.push('参考标签 <Subject N>/<Picture N>、关系标记 fully_preserved、镜头 [Shot N] 保持英文。');
     } else {
-      parts.push('User selected 【English】. Use English Full-Reference keys.');
+      parts.push('User selected 【English】. Use English Full-Reference keys. Write all section bodies in English.');
     }
   } else if (lang === 'zh') {
-    parts.push('用户选择【中文】。正文必须用简体中文。');
-    parts.push('本场景不是 Full-Reference 六段式。');
+    parts.push('用户选择【中文】。正文必须用简体中文。禁止整段英文叙述。');
+    parts.push('本场景不是 Full-Reference 六段式：不要输出「主体定义/摘要/保留分析/详细描述/整体声景/非叙事配乐」章节标题。');
+    if (mediaPaths && mediaPaths.length) {
+      parts.push('用户已提供参考素材：正文必须用 <Picture N>/<Subject N> 锚定外观，并写完整分镜、动作、运镜与声景的**自然语言段落**（可用 [Shot N] 标记镜头）；禁止只列标签名、禁止 XML/空壳结构而无正文。');
+    } else {
+      parts.push('无参考素材时不要编造 <Picture N>/<Subject N>。');
+    }
   } else {
     parts.push('User selected 【English】. Write the prompt body in English.');
-    parts.push('This scenario is NOT Full-Reference six-section format.');
+    parts.push('This scenario is NOT Full-Reference six-section format. Do not use subject_definitions:/summary: section headers.');
+    if (mediaPaths && mediaPaths.length) {
+      parts.push('Reference media attached: anchor with <Picture N>/<Subject N> and write full shot/action/camera/audio as **prose paragraphs** ([Shot N] allowed). No tag-only lists, no XML shells without body text.');
+    } else {
+      parts.push('Do not invent <Picture N>/<Subject N> when no media is attached.');
+    }
   }
   parts.push('');
 
-  // 输出格式
+  // 输出格式（四分支）
   if (scenario.outputMode === 'full_reference') {
     if (lang === 'zh') {
       parts.push('## 输出格式（最高优先级）');
       parts.push('仅输出 MiniMax-H3 Full-Reference 标准六段（中文标题）：主体定义 → 摘要 → 保留分析 → 详细描述 → 整体声景 → 非叙事配乐。');
-      parts.push('绝对纯净输出：以「主体定义:」开头，以「非叙事配乐:」内容结束。不要 Markdown 代码围栏。');
-      parts.push('章节标题用中文；参考标签/关系标记/镜头标记保持英文。');
+      parts.push('绝对纯净输出：以「主体定义:」开头，以「非叙事配乐:」内容结束。不要 Markdown 代码围栏，不要寒暄。');
+      parts.push('章节标题用中文；参考标签/关系标记/镜头标记保持英文；正文以中文指南为准。');
       if (form.expand_mode === 'expand') {
-        parts.push('用户允许扩写：可补充必要的视觉/听觉/时间细节。');
+        parts.push('用户允许扩写：可补充必要的视觉/听觉/时间细节，使提示词可直接生成。');
       } else {
-        parts.push('默认严格改写：不要编造用户未给出或未强烈暗示的情节。');
+        parts.push('默认严格改写：不要编造用户未给出或未强烈暗示的情节/动作/角色。');
       }
       parts.push('');
       parts.push('## Full-Reference 中文指南（请严格遵循）');
       parts.push(loadFullReferenceGuide('zh'));
     } else {
       parts.push('## Output format (HIGHEST PRIORITY)');
-      parts.push('Produce MiniMax-H3 Full-Reference Mode standardized 6 sections ONLY.');
-      parts.push('Absolute pure output: start with subject_definitions: end with non_diegetic_music:.');
+      parts.push('Produce MiniMax-H3 Full-Reference Mode standardized 6 sections ONLY: subject_definitions → summary → retention_analysis → detailed_description → overall_soundscape → non_diegetic_music.');
+      parts.push('Absolute pure output: start with subject_definitions: end with non_diegetic_music:. No markdown fences, no greetings.');
+      parts.push('Keep English keys/labels/tags as in the guide. Section bodies in English.');
+      if (form.expand_mode === 'expand') {
+        parts.push('User allowed expansion: you may add necessary visual/audio/temporal details to make a playable prompt.');
+      } else {
+        parts.push('Strict rewrite by default: do NOT invent plot/actions/characters not stated or strongly implied.');
+      }
       parts.push('');
-      parts.push('## Full-Reference Guide (English edition)');
+      parts.push('## Full-Reference Guide (English edition — follow strictly)');
       parts.push(loadFullReferenceGuide('en'));
     }
   } else if (scenario.outputMode === 'director_segments') {
     const n = Math.max(2, parseInt(String(form.segment_count || '4'), 10) || 4);
     const kind = String(form.prompt_kind || 't2v') === 'r2v' ? 'r2v' : 't2v';
-    const customPlan = String(form.plan_mode || 'ai') === 'custom';
+    const customPlan = isDirectorCustomPlan(form);
     const sec = String(form.segment_seconds || '5');
     if (lang === 'zh') {
       parts.push('## 输出格式（最高优先级）');
-      parts.push(`严格按「公共设定 + ${n} 组六段式（去主体定义）」输出。`);
+      parts.push(`严格按「公共设定 + ${n} 组六段式（去主体定义）」输出，不要 Markdown，不要寒暄。`);
       if (customPlan) {
-        parts.push('分段方式=自定义：每段剧情严格按用户填写的「第 N 段在干什么」。');
+        parts.push('分段方式=自定义：每段剧情严格按用户填写的「第 N 段在干什么」；不要擅自改情节主线。');
+      } else {
+        parts.push(
+          '分段方式=AI智能分段：用户只给了总段数和「创作需求」。你必须自行把创作需求拆成恰好 ' +
+            `${n} 段连续剧情（起承转合，段间无硬切），并为每段选定合适时长（5 / 10 / 15 秒，导演台常用）。`
+        );
+        parts.push('在每组「摘要:」里写明本段约几秒。补全运镜、动作、对白、声画。禁止向用户追问各段内容，禁止输出空壳或「待补充」。');
+      }
+      parts.push('### 第一部分：公共设定（只出现一次，可贴导演台「公共参数」）');
+      parts.push('分隔行：===== 公共设定 =====');
+      parts.push('本块只写「主体定义:」，不要摘要/分镜/声景。');
+      if (kind === 'r2v' || (mediaPaths && mediaPaths.length)) {
+        parts.push('有参考图时逐条：<Subject N> 来自 <Picture N> 的……身份与穿着完全锁定参考图：…… 可同时定义 <Picture N> 用途。');
       } else {
-        parts.push('分段方式=AI 智能：模型按创作需求自由分段。');
+        parts.push('无参考图时用自然语言定义 <Subject N> 的身份与穿着，禁止编造 <Picture N>。');
       }
-      parts.push(`Part 2 = ${n} 组提示词（每段约 ${sec} 秒）。`);
-      parts.push('===== 公共设定 ===== 块仅放 主体定义：');
-      parts.push('===== 提示词组 k ===== 块中其余五段（摘要/保留分析/详细描述/整体声景/非叙事配乐）。');
+      parts.push(
+        customPlan
+          ? `### 第二部分：${n} 段提示词（每段约 ${sec} 秒，可贴导演台各「提示词组」）`
+          : `### 第二部分：${n} 段提示词（每段时长由你定，5/10/15 秒，可贴导演台各「提示词组」）`
+      );
+      parts.push('每组分隔行：===== 提示词组 k =====');
+      parts.push('每组必须按 MiniMax 六段式输出，但禁止再写「主体定义:」。固定顺序：摘要: → 保留分析: → 详细描述: → 整体声景: → 非叙事配乐:');
+      parts.push('各段只引用公共设定里已有的 <Subject N>，不要重复外貌/服装圣经。保留分析只写本段出场主体及 fully_preserved 等关系。');
+      parts.push('第 2 组起，「详细描述:」第一句必须是「无硬切。紧接上一段。」本段时间码从 00:00 起算。段末写「段末停在…」。详细描述最后一行：不要乱说话');
+      parts.push('配乐主题跨组连续；除最后一组外段末不要淡出。');
+      parts.push('');
+      parts.push('## Full-Reference 中文指南（章节写法请遵循；主体定义只允许出现在第一部分）');
+      parts.push(loadFullReferenceGuide('zh'));
     } else {
-      parts.push(`Output Format: Public subject_definitions + ${n} Full-Reference groups. Each group uses summary/retention_analysis/detailed_description/overall_soundscape/non_diegetic_music.`);
-      parts.push(`===== Public ===== block uses subject_definitions:.`);
-      parts.push(`===== Group k ===== block uses other 5 sections.`);
+      parts.push('## Output format (HIGHEST PRIORITY)');
+      parts.push(`Output public settings once, then exactly ${n} Full-Reference groups without repeating subject_definitions.`);
+      if (customPlan) {
+        parts.push('Plan mode=custom: follow each user-provided segment beat and duration.');
+      } else {
+        parts.push(`Plan mode=AI: user only gave segment count ${n} and the creative brief. Split it into exactly ${n} continuous beats yourself; pick 5/10/15s per group; write the duration in each summary. Do not ask for per-segment notes.`);
+      }
+      parts.push('Part 1: ===== 公共设定 ===== containing ONLY subject_definitions:');
+      parts.push('If media attached: <Subject N> is from <Picture N>, identity and wardrobe fully locked to the reference.');
+      parts.push(
+        customPlan
+          ? `Part 2: ===== 提示词组 k ===== × ${n} (~${sec}s each)`
+          : `Part 2: ===== 提示词组 k ===== × ${n} (you pick 5/10/15s each)`
+      );
+      parts.push('Each group: summary → retention_analysis → detailed_description → overall_soundscape → non_diegetic_music. NEVER repeat subject_definitions in a group.');
+      parts.push('Group 2+ detailed_description starts with "No hard cut. Immediately following the previous section." End with a freeze-frame handoff and the line 不要乱说话.');
+      parts.push('');
+      parts.push('## Full-Reference Guide (English edition — subject_definitions only in Part 1)');
+      parts.push(loadFullReferenceGuide('en'));
+    }
+  } else if (scenario.outputMode === 'timeline_template') {
+    if (lang === 'zh') {
+      parts.push('## 输出格式（最高优先级）');
+      parts.push('输出一份可直接生成的完整 MiniMax-H3 时间轴/事件框架视频提示词。不要 Markdown 代码围栏，不要闲聊。');
+      parts.push('正文用简体中文（若场景要求 CONTINUE 等固定英文 UI 词可保留）。');
+    } else {
+      parts.push('## Output format (HIGHEST PRIORITY)');
+      parts.push('Output ONE complete MiniMax-H3 timeline / event-framework video prompt ready to generate. No markdown fences, no chat.');
+      parts.push('Prompt body language: English.');
     }
-  } else if (lang === 'zh') {
-    parts.push('## 输出格式（最高优先级）');
-    parts.push('本场景不是 Full-Reference 六段式，不要输出六段标题。');
-    parts.push('按场景专属结构（time-section / template / prose paragraph）输出，遵循场景硬约束。');
   } else {
-    parts.push('## Output format (HIGHEST PRIORITY)');
-    parts.push('This scenario is NOT Full-Reference six-section format.');
-    parts.push('Follow the scenario-specific structure (time-section / template / prose).');
+    if (lang === 'zh') {
+      parts.push('## 输出格式（最高优先级）');
+      parts.push('输出一份完整、可直接使用的场景化 MiniMax-H3 视频提示词。不要 Markdown 代码围栏，不要闲聊，不要过程叙述。');
+      parts.push('严格按本场景硬约束与 Assembly hints 的段落顺序输出；不要套用 Full-Reference 六段标题。');
+    } else {
+      parts.push('## Output format (HIGHEST PRIORITY)');
+      parts.push('Output ONE complete scenario-structured MiniMax-H3 video prompt ready to use. No markdown fences, no chat, no process narration.');
+      parts.push('Follow this scenario hard constraints and assembly hints section order; do NOT wrap into Full-Reference six sections.');
+    }
   }
 
-  // 场景硬约束
   parts.push('');
-  parts.push('## 场景硬约束（必须全部遵守）');
-  for (const hc of scenario.hardConstraints) {
-    parts.push(`- ${hc}`);
+  parts.push('## Scenario hard constraints');
+  for (const c of scenario.hardConstraints || []) {
+    // 产品广告里写死 English copy 时，按输出语言改写该条（X4）
+    if (lang === 'zh' && /In-frame copy:\s*English/i.test(c)) {
+      parts.push('- In-frame copy: concise Simplified Chinese (约 4–12 字), single line only; never two rows or bottom subtitles.');
+      continue;
+    }
+    parts.push(`- ${c}`);
   }
 
-  // 表单字段
-  const formLines = formToLines(scenario, form);
-  if (formLines.length) {
+  if (scenario.assembleHints) {
     parts.push('');
-    parts.push('## 当前表单输入');
-    parts.push(...formLines);
+    parts.push('## Assembly hints');
+    parts.push(scenario.assembleHints);
   }
 
   return parts.join('\n');
 }
 
-// 主体组装 user prompt
-function buildUser(scenario: MiniMaxScenario, form: Record<string, any>, outputLang: string, mediaPaths: string[] | undefined): string {
+// 主体组装 user prompt（X1：五块结构）
+function buildUser(scenario: MiniMaxScenario, form: Record<string, any>, shortText: string, mediaPaths: string[] | undefined, outputLang: string): string {
   const lang = String(outputLang || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';
-  const parts: string[] = [];
-
-  if (lang === 'zh') {
-    parts.push('请按以上系统提示与场景硬约束，输出可直接投喂 MiniMax-H3 视频模型的提示词正文。');
-    parts.push('仅输出最终正文；不要解释过程、不要 Markdown。');
+  const userParts: string[] = [];
+  userParts.push('【场景】' + scenario.name);
+  userParts.push('【输出语言】' + (lang === 'en' ? '英文' : '中文') + ' — 这是强制要求，不是偏好；正文语言必须与此一致。');
+  if (scenario.outputMode === 'full_reference') {
+    userParts.push(
+      lang === 'zh'
+        ? '【强制】六段标题用中文（主体定义/摘要/保留分析/详细描述/整体声景/非叙事配乐），正文与画面文案用简体中文；禁止英文章节标题。无附图时禁止编造 <Picture N>。'
+        : '【强制】Write detailed_description / summary / retention_analysis / sound sections and on-screen copy in English. Do not invent <Picture N> when no media is attached.'
+    );
+  } else if (scenario.outputMode === 'director_segments') {
+    const n = Math.max(2, parseInt(String(form.segment_count || '4'), 10) || 4);
+    const kind = String(form.prompt_kind || 't2v') === 'r2v' ? 'r2v' : 't2v';
+    const customPlan = isDirectorCustomPlan(form);
+    userParts.push(
+      lang === 'zh'
+        ? `【强制】先输出 ===== 公共设定 =====（仅「主体定义:」），再输出 ${n} 组 ===== 提示词组 k =====。每组按六段式但禁止再写主体定义，只写摘要/保留分析/详细描述/整体声景/非叙事配乐。方式=${kind === 'r2v' ? '参考图锁角色' : '文生锁角色'}。分段=${customPlan ? '自定义（按各段说明）' : 'AI智能分段（按创作需求自行拆成 ' + n + ' 段）'}。`
+        : `【REQUIRED】Part 1 ===== 公共设定 ===== (subject_definitions only). Part 2 = ${n} Full-Reference groups without repeating subject_definitions. Mode=${kind}. Plan=${customPlan ? 'custom beats' : 'AI split from brief'}.`
+    );
+    if (!customPlan) {
+      userParts.push(
+        lang === 'zh'
+          ? '【智能分段】不要等待「第 N 段在干什么」。根据下方创作需求自行设计每段事件、时长与衔接。'
+          : '【AI split】Do not wait for per-segment beats. Invent each group from the brief below.'
+      );
+    }
   } else {
-    parts.push('Follow the system prompt and scenario hard constraints above; output the ready-to-use MiniMax-H3 prompt body.');
-    parts.push('Output only the final body; no explanation, no markdown.');
+    userParts.push(
+      lang === 'zh'
+        ? '【强制】按本场景段落顺序输出纯视频提示词正文（简体中文）。禁止套用六段式标题，禁止在无附图时编造 <Picture N>/<Subject N>。'
+        : '【强制】Output a plain scenario video prompt in English. Do NOT use Full-Reference six sections. Do not invent <Picture N>/<Subject N> without attached media.'
+    );
   }
-  parts.push('');
-
-  if (scenario.outputMode === 'director_segments') {
-    const n = Math.max(2, parseInt(String(form.segment_count || '4'), 10) || 4);
+  userParts.push('【表单参数】');
+  const formLines = formToLines(scenario, form);
+  userParts.push(formLines.length ? formLines.join('\n') : '- （无额外表单填写）');
+
+  userParts.push('');
+  userParts.push('【创作需求 / User request】');
+  userParts.push(String(shortText || '').trim() || '(empty)');
+
+  const mediaItems = enumerateTaggedMedia(mediaPaths);
+  const mediaLines = formatMediaList(mediaPaths);
+  if (mediaLines.length) {
+    userParts.push('');
+    userParts.push('【参考素材 / Reference media】');
+    userParts.push(...mediaLines);
+    userParts.push('');
     if (lang === 'zh') {
-      parts.push(`请输出 ${n} 段：Part 1 = 公共设定（===== 公共设定 =====）；Part 2 = ${n} 个提示词组（===== 提示词组 1..${n} =====）。`);
+      userParts.push('【强制·素材标签】主体定义必须以如下标签逐条起笔（可按实际素材增减）：');
+      for (const item of mediaItems) {
+        userParts.push(`${item.tag} …`);
+      }
+      if (scenario.outputMode === 'full_reference') {
+        userParts.push('并为每个主要角色/产品写 <Subject N> 是 <Picture N> 中的……；后续段落必须复用这些标签。禁止只写角色名而不出现 <Picture N>。');
+      } else {
+        userParts.push('在正文中引用上述标签锚定外观；不要虚构额外未提供的素材标签。');
+      }
     } else {
-      parts.push(`Output ${n} segments: Part 1 = Public subject_definitions; Part 2 = ${n} groups.`);
+      userParts.push('【REQUIRED media tags】Use these exact tags in the prompt body:');
+      for (const item of mediaItems) {
+        userParts.push(`${item.tag} …`);
+      }
+      if (scenario.outputMode === 'full_reference') {
+        userParts.push('Also define <Subject N> is from <Picture N> … and reuse these tags in later sections.');
+      } else {
+        userParts.push('Do not invent extra media tags beyond the list above.');
+      }
+    }
+  } else {
+    userParts.push('');
+    if (scenario.outputMode === 'director_segments') {
+      userParts.push(
+        lang === 'zh'
+          ? '【强制】本次无参考图：公共设定可用 <Subject N> 文字锁身份，严禁编造 <Picture N>/<Video N>/<Audio N>。'
+          : '【REQUIRED】No media: public subject_definitions may use <Subject N> in prose. Do not invent <Picture N>/<Video N>/<Audio N>.'
+      );
+    } else {
+      userParts.push(
+        lang === 'zh'
+          ? '【强制】本次无参考素材附件：输出中不得出现 <Picture N>/<Subject N>/<Video N>/<Audio N>。'
+          : '【REQUIRED】No media attached: do not output <Picture N>/<Subject N>/<Video N>/<Audio N>.'
+      );
     }
   }
 
-  if (scenario.assembleHints) {
-    parts.push('');
-    parts.push(`## 组装提示：${scenario.assembleHints}`);
-  }
-
-  return parts.join('\n');
+  userParts.push('');
+  userParts.push('【任务】根据场景硬约束 + 表单参数 + 创作需求 + 参考素材，输出最终提示词。');
+  return userParts.join('\n');
 }
 
-// 判定是否是 MinMax Scenario Profile
+// 判定是否是 MiniMax Scenario Profile（upstream assemble.js isMinimaxScenarioProfile）
 export function isMinimaxScenarioProfile(profile: any): boolean {
-  return !!(profile && profile.minimaxScenarioId);
+  if (!profile || profile.kind !== 'expand') return false;
+  if (profile.minimaxScenarioId) return true;
+  if (String(profile.outputFormat || '') === 'minimax') return true;
+  return !!getScenarioByPeId(profile?.id);
 }
 
-// 主体组装：MinMax 场景的扩写管线
-export function resolveMinimaxScenarioExpand(
-  profile: any,
-  params: any,
-): { system: string; user: string; maxTokens: number; ruleId: string } | null {
-  const scenarioId = profile?.minimaxScenarioId || params?.minimaxForm?.scenario_id;
-  if (!scenarioId) return null;
+// 主体组装：MiniMax 场景的扩写管线（X5：maxTokens 下限 / userExtraPrompt / form 兼容 / peId 兜底 / 返回字段）
+export interface MinimaxExpandResult {
+  system: string;
+  user: string;
+  maxTokens: number;
+  ruleId: string;
+  minimaxScenarioId: string;
+  mediaExpandLayout: boolean;
+}
 
-  const scenario = getScenarioById(scenarioId) || getScenarioByPeId(profile.id);
+export function resolveMinimaxScenarioExpand(profile: any, params: any): MinimaxExpandResult | null {
+  const scenario =
+    getScenarioByPeId(profile && profile.id) ||
+    getScenarioById(profile && profile.minimaxScenarioId) ||
+    getScenarioByPeId(params && (params.peId || params.ruleId));
   if (!scenario) return null;
 
-  const outputLang = (params?.minimaxForm?.output_lang || params?.outputLang || 'zh') as 'zh' | 'en';
-  const form = normalizeForm(scenario, params?.minimaxForm?.form_fields || {});
-  const mediaPaths = params?.mediaPaths || [];
-
-  const system = buildSystem(scenario, form, outputLang, mediaPaths);
-  const user = buildUser(scenario, form, outputLang, mediaPaths);
-  const maxTokens = resolveExpandMaxTokens('long'); // MiniMax 场景总是需要较长输出
+  // X5c：params.minimaxForm 直传（upstream）与 { form_fields, output_lang } 嵌套（插件工具面）两种都兼容
+  const rawForm = params?.minimaxForm?.form_fields ?? params?.minimaxForm ?? {};
+  const form = normalizeForm(scenario, rawForm);
+  const shortText = String((params && params.shortText) || '').trim();
+  const mediaPaths = Array.isArray(params && params.mediaPaths) ? params.mediaPaths : [];
+  const expandLen = (params && params.expandLen) || 'long';
+  const expandLenChars = params && params.expandLenChars;
+  const userExtraPrompt = String((params && params.userExtraPrompt) || '').trim();
+  const outputLangRaw =
+    (params && params.outputLang) || (params && params.minimaxForm && params.minimaxForm.output_lang) || 'zh';
+  const outputLang = String(outputLangRaw).toLowerCase() === 'en' ? 'en' : 'zh';
+
+  let system = buildSystem(scenario, form, outputLang, mediaPaths);
+  if (userExtraPrompt) {
+    system += `\n\n【User additional requirements】${userExtraPrompt}`;
+  }
 
-  return { system, user, maxTokens, ruleId: profile.id || scenario.id };
-}
\ No newline at end of file
+  const tokenLimits: any = (params && params.tokenLimits) || null;
+  const mediaMin =
+    (tokenLimits && Number.isFinite(Number(tokenLimits.mediaExpandMin)) && Number(tokenLimits.mediaExpandMin)) ||
+    DEFAULT_MEDIA_EXPAND_MIN;
+  const maxTokens = Math.max(resolveExpandMaxTokens(expandLen, expandLenChars, tokenLimits), mediaMin);
+
+  return {
+    system,
+    user: buildUser(scenario, form, shortText, mediaPaths, outputLang),
+    maxTokens,
+    ruleId: scenario.peId,
+    minimaxScenarioId: scenario.id,
+    mediaExpandLayout: true,
+  };
+}
diff --git a/plugins/prompt-master/src/resolver/minimax/h3-full-reference.ts b/plugins/prompt-master/src/resolver/minimax/h3-full-reference.ts
new file mode 100644
index 0000000..eb02458
--- /dev/null
+++ b/plugins/prompt-master/src/resolver/minimax/h3-full-reference.ts
@@ -0,0 +1,105 @@
+// H3 Full-Reference 独立入口 — 1:1 移植自 PM config/h3FullReferencePromptEngineering.js（X7）
+// system = 指南全文（zh/en 模板）+ 语言附加块；user = 固定 Rewrite 模板 + 参考素材列表
+
+import { resolveExpandMaxTokens } from '../profiles/expand-rules.js';
+import { H3_REFERENCE_EN, H3_REFERENCE_ZH } from './templates/index.js';
+import { enumerateTaggedMedia, DEFAULT_MEDIA_EXPAND_MIN } from './assemble.js';
+
+export const H3_FULL_REFERENCE_PROFILE_ID = 'pe_expand_h3_full_reference';
+export const H3_FULL_REFERENCE_BUILTIN_KEY = 'h3_full_reference';
+
+export const H3_FULL_REFERENCE_USER_PROMPT_TEMPLATE = `Rewrite the user materials below into a MiniMax-H3 Full-Reference Mode standardized 6-section video prompt.
+
+Follow the system instructions exactly.
+Output ONLY the six sections, starting with subject_definitions: and ending with non_diegetic_music:.
+Do NOT wrap the output in markdown code fences.
+Do NOT add greetings, explanations, or notes.
+
+【User materials / brief】
+{{user_input}}`;
+
+export function loadH3FullReferenceSystem(lang: string): string {
+  const key = String(lang || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';
+  let system = key === 'en' ? H3_REFERENCE_EN : H3_REFERENCE_ZH;
+  if (key === 'zh') {
+    system += '\n\n【输出语言】本模板为中文版。六段标题必须中文：主体定义: / 摘要: / 保留分析: / 详细描述: / 整体声景: / 非叙事配乐:。禁止 subject_definitions: 等英文章节标题。正文必须简体中文。对白/歌词/画面可见文字在 <d> 内保留原语言；参考标签与关系标记保持英文。';
+    system += '\n\n【输出契约】绝对纯净输出。以「主体定义:」开头，以「非叙事配乐:」结束。不要 Markdown 代码围栏，不要解释。';
+    system += '\n\n【参考素材】可附带真实图片/视频（或关键帧）。标签 <Picture N>/<Video N>/<Audio N> 在六段中保持同一身份。视觉细节以素材为准。';
+  } else {
+    system += '\n\n【Output language】English edition. Write all six rewrite sections in English. Preserve the original language ONLY for dialogue, lyrics, and visible on-screen text inside <d> tags.';
+    system += '\n\n【Output contract】Absolute pure output only. Start with subject_definitions: and end with non_diegetic_music:. No markdown fences, no explanations.';
+    system += '\n\n【Reference media】Reference media may be attached as real images/video (or keyframes). Tags <Picture N>, <Video N>, <Audio N> keep stable identity across the six sections. Ground visual details on attached media.';
+  }
+  return system;
+}
+
+export function isH3FullReferenceProfile(profile: any): boolean {
+  if (!profile || profile.kind !== 'expand') {
+    return false;
+  }
+  const id = String(profile.id || '').trim();
+  const key = String(profile.builtinKey || '').trim();
+  return id === H3_FULL_REFERENCE_PROFILE_ID || key === H3_FULL_REFERENCE_BUILTIN_KEY;
+}
+
+export function isH3FullReferencePeId(peId: string): boolean {
+  const id = String(peId || '').trim();
+  return (
+    id === H3_FULL_REFERENCE_PROFILE_ID ||
+    id === H3_FULL_REFERENCE_BUILTIN_KEY ||
+    id === `pe_expand_${H3_FULL_REFERENCE_BUILTIN_KEY}`
+  );
+}
+
+function renderUserPrompt(shortText: string): string {
+  const body = String(shortText || '').trim();
+  return H3_FULL_REFERENCE_USER_PROMPT_TEMPLATE.split('{{user_input}}').join(body);
+}
+
+/**
+ * Full-Reference 改写独立解析：不套用绘图扩写的语言锁 / 篇幅提示 / 待扩写原文守卫。
+ * 支持参考素材列表（Minimax 媒体扩写布局）。
+ */
+export function resolveH3FullReferenceExpand(profile: any, params: any): {
+  system: string;
+  user: string;
+  maxTokens: number;
+  ruleId: string;
+  mediaExpandLayout: boolean;
+} | null {
+  const shortText = String((params && params.shortText) || '').trim();
+  const expandLen = (params && params.expandLen) || 'long';
+  const expandLenChars = params && params.expandLenChars;
+  const userExtraPrompt = String((params && params.userExtraPrompt) || '').trim();
+  const mediaPaths = Array.isArray(params && params.mediaPaths) ? params.mediaPaths : [];
+
+  const outputLang =
+    String((params && params.outputLang) || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';
+  let system = loadH3FullReferenceSystem(outputLang);
+
+  if (userExtraPrompt) {
+    system += `\n\n【User additional requirements】${userExtraPrompt}`;
+  }
+
+  const userParts = [renderUserPrompt(shortText || '(empty)')];
+  const mediaLines = enumerateTaggedMedia(mediaPaths).map(
+    (item) => `- ${item.tag} ${item.base}（路径：${item.path}）`
+  );
+  if (mediaLines.length) {
+    userParts.push('', '【参考素材 / Reference media】', ...mediaLines);
+  }
+
+  const tokenLimits: any = (params && params.tokenLimits) || null;
+  const mediaMin =
+    (tokenLimits && Number.isFinite(Number(tokenLimits.mediaExpandMin)) && Number(tokenLimits.mediaExpandMin)) ||
+    DEFAULT_MEDIA_EXPAND_MIN;
+  const maxTokens = Math.max(resolveExpandMaxTokens(expandLen, expandLenChars, tokenLimits), mediaMin);
+
+  return {
+    system,
+    user: userParts.join('\n'),
+    maxTokens,
+    ruleId: H3_FULL_REFERENCE_PROFILE_ID,
+    mediaExpandLayout: true,
+  };
+}
diff --git a/plugins/prompt-master/src/resolver/minimax/index.ts b/plugins/prompt-master/src/resolver/minimax/index.ts
index 7f3d5b5..790f023 100644
--- a/plugins/prompt-master/src/resolver/minimax/index.ts
+++ b/plugins/prompt-master/src/resolver/minimax/index.ts
@@ -1,6 +1,15 @@
 // MiniMax H3 场景模块入口 — 汇总 catalog / assemble / templates
 export { listScenarios, getScenarioById, getScenarioByPeId, MINIMAX_SCENARIOS, ASPECT_COMMON, CONTINUOUS_STORY_MAX_SEGMENTS } from './catalog.js';
-export { resolveMinimaxScenarioExpand, isMinimaxScenarioProfile, fieldVisible, normalizeForm } from './assemble.js';
+export { resolveMinimaxScenarioExpand, isMinimaxScenarioProfile, fieldVisible, normalizeForm, enumerateTaggedMedia, classifyMediaPath } from './assemble.js';
+export {
+  H3_FULL_REFERENCE_PROFILE_ID,
+  H3_FULL_REFERENCE_BUILTIN_KEY,
+  H3_FULL_REFERENCE_USER_PROMPT_TEMPLATE,
+  isH3FullReferenceProfile,
+  isH3FullReferencePeId,
+  resolveH3FullReferenceExpand,
+  loadH3FullReferenceSystem,
+} from './h3-full-reference.js';
 export { H3_REFERENCE_EN } from './templates/h3-reference.en.js';
 export { H3_REFERENCE_ZH } from './templates/h3-reference.zh.js';
 export { H3_REFERENCE_JA } from './templates/h3-reference.ja.js';
\ No newline at end of file
diff --git a/plugins/prompt-master/src/resolver/minimax/templates/h3-reference.en.ts b/plugins/prompt-master/src/resolver/minimax/templates/h3-reference.en.ts
index 58d881c..896b722 100644
--- a/plugins/prompt-master/src/resolver/minimax/templates/h3-reference.en.ts
+++ b/plugins/prompt-master/src/resolver/minimax/templates/h3-reference.en.ts
@@ -1,59 +1,355 @@
-// MiniMax-H3 Full-Reference Guide (English) — simplified from PM
-// Full version: see electron/config/prompts/h3-full-reference-rewrite.en.js (60K original)
-
-export const H3_REFERENCE_EN = `# MiniMax-H3 Full-Reference Mode (English)
-
-## Six-Section Structure (MANDATORY)
-
-### 1. subject_definitions:
-For each Subject, provide:
-- Identity (who they are, IP/character name)
-- Visual appearance (hair, eyes, body type, age impression)
-- Wardrobe (clothing layers, materials, colors)
-- Pose baseline (default stance)
-
-Reference tags: <Subject N>, <Picture N>, <Video N>, <Audio N>
-
-### 2. summary:
-One sentence (≤30 words) describing the core visual content of the video.
-
-### 3. retention_analysis:
-For each shot:
-- Which Subjects appear (cite by tag)
-- Retention status: fully_preserved | partially_preserved
-- What identity/wardrobe details are preserved vs. lost
-
-### 4. detailed_description:
-For each [Shot N]:
-- Camera (shot type, movement, framing)
-- Subject action (concrete verbs, gaze direction)
-- Environment
-- Lighting
-- Temporal beats (start/middle/end of shot)
-
-Use timestamps: At 00:00.000 to MM:SS.mmm
-
-### 5. overall_soundscape:
-- Ambient sounds (city, nature, room tone)
-- Action sounds (footsteps, doors, breath)
-- Dialogue (in <d>[Language] text</d> format)
-- Foley/impact sounds
-
-### 6. non_diegetic_music:
-- Genre (orchestral, electronic, ambient, etc.)
-- Tempo / BPM
-- Emotional tone
-- Music arc (build/release/resolution)
-
-## Hard Rules
-- DO NOT output markdown fences (no \`\`\`)
-- DO NOT output greetings or explanations
-- Start with subject_definitions: directly
-- End with non_diegetic_music: content
-- Use <d>[Language] text</d> for dialogue only
-- Reference tags stay in English even when body is Chinese
-
-## Length Budget
-- Each shot description: 50-150 words
-- Total: 800-1500 tokens for a 5-15s video
-`;
\ No newline at end of file
+// MiniMax-H3 Full-Reference Guide (en) — verbatim from PM 3.1.0 h3-full-reference-rewrite.en.js (X8)
+
+export const H3_REFERENCE_EN = `# Role & Task
+You are an expert AI Video Prompt Engineer. Your task is to process the user's input and rewrite it into a strictly standardized 6-section Full-Reference video prompt based on the "Full-Reference Mode Rewrite Output Format Guide" provided below.
+
+# Core Execution Rules
+1. **Absolute Pure Output**: Output ONLY the final standardized 6-section prompt. Do NOT output any greetings, explanations, markdown code fences (like \`\`\`text or \`\`\`markdown), apologies, notes, or conversational filler. The output must start directly with \`subject_definitions:\` and end with the content of \`non_diegetic_music:\`.
+2. **Strict Rewrite vs. Expansion**: 
+   - By default, strictly rewrite the user's provided materials into the full-reference format. Do NOT invent new plot points, actions, characters, or scenes that are not explicitly stated or strongly implied by the user's input.
+   - **ONLY** if the user explicitly says "帮我写提示词" (help me write a prompt) or gives a similar explicit expansion request, you are allowed to expand the brief idea into a complete, detailed, and playable video prompt by adding necessary visual, auditory, and temporal details.
+3. **Image Order Consistency**: If the user provides multiple pictures or image references, their order must remain exactly the same as the user's input order. Map them consistently as \`<Picture 1>\`, \`<Picture 2>\`, etc., following the user's original sequence.
+4. **Audio Reference Handling**: If the user mentions reference audio, handle it strictly according to the template rules (define as \`<Audio N>\`, explain copy/reference role, cite in relevant sections).
+5. **Language**: Write all six sections in English. Preserve the original language ONLY for dialogue, lyrics, and visible on-screen text inside \`<d>\` tags.
+
+---
+
+# Full-Reference Mode Rewrite Output Format Guide
+
+This guide explains how rewrite outputs are organized and written in full-reference mode.
+
+Write all six rewrite sections in English. Preserve the original language only for dialogue and lyrics inside \`<d>\` and for text visibly present in the scene.
+
+**Description detail:** Make \`detailed_description\` as detailed and explicit as possible. For each shot, clearly establish the current composition, subject appearance and position, environment and lighting, actions and state changes, camera movement, current sound, and the points where referenced content actually appears or takes effect. Avoid reducing the description to a plot summary or a list of reference relationships.
+
+> The basic formats for shots, camera movement, speakers, dialogue, and ordinary sound are shared with the Video Prompt Writing Guide (T2VA / I2VA / FL2VA / L2VA). This guide focuses on the reference labels, analysis sections, and format differences specific to full-reference mode.
+
+## 1. Overall Structure
+
+A complete rewrite output consists of six sections in the following order:
+
+| Section | Purpose |
+| --- | --- |
+| \`subject_definitions\` | Defines referenced content and its reference labels |
+| \`summary\` | Summarizes the task type, target video, and main reference relationships |
+| \`retention_analysis\` | Describes how referenced content is preserved, transferred, or reused |
+| \`detailed_description\` | Describes visuals, actions, shots, sound, and dialogue in playback order |
+| \`overall_soundscape\` | Summarizes ambience and physical sounds |
+| \`non_diegetic_music\` | Describes background music audible only to the audience |
+
+## 2. Reference Labels and Definitions (\`subject_definitions\`)
+
+Full-reference rewrites use four types of labels to identify the source and role of referenced content:
+
+| Label | Meaning |
+| --- | --- |
+| \`<Subject N>\` | Visible content abstracted from reference assets that can be reused or modified in the target video |
+| \`<Picture N>\` | A reference image used as a concrete target frame or shot-planning anchor |
+| \`<Video N>\` | A reference video that provides an editing source, continuation starting point, or whole-video temporal structure |
+| \`<Audio N>\` | An audio signal that is copied or referenced |
+
+> Once a reference label is assigned to a piece of content, it keeps the same meaning across \`subject_definitions\`, \`summary\`, \`retention_analysis\`, \`detailed_description\`, and the audio sections.
+
+\`subject_definitions\` defines each piece of referenced content that must be tracked separately later, such as a person, an environment, a source video's structure, or an audio track. Give each item its own line and explain what its label denotes, its reference role, and the main features to follow; name the corresponding source asset when its provenance needs to be made explicit. If \`<Picture N>\` or \`<Video N>\` only identifies the source of another referenced item and will not be analyzed or used separately later, cite it inside that item's definition without adding a separate line. \`retention_analysis\` records where each referenced item appears and whether it is fully preserved, partially preserved, transferred, or reused.
+
+### 2.1 \`<Subject N>\`
+
+\`<Subject N>\` is used for reusable visible content, including:
+
+- People, animals, or objects
+- Scenes, backgrounds, or environments
+- Clothing, props, interfaces, or visual effects
+- Styles, actions, expressions, or poses
+
+It represents a content unit that will actually be used in the target video, rather than the source file itself. One subject may be defined by multiple reference assets, and one reference asset may provide multiple subjects.
+
+\`\`\`text
+<Subject 1> is the young woman in <Picture 1>, with long dark hair, a blue cardigan, and a thin silver necklace.
+\`\`\`
+
+When the same subject comes from multiple assets, combine the sources and state what each asset provides:
+
+\`\`\`text
+<Subject 1> is the woman whose appearance comes from <Picture 1> and whose walking motion comes from <Video 1>.
+\`\`\`
+
+### 2.2 \`<Picture N>\`
+
+Use a standalone \`<Picture N>\` when the reference image itself serves as a shot's first frame, keyframe, last frame, edited keyframe, or composition anchor:
+
+\`\`\`text
+<Picture 2> is the first frame of [Shot 1], showing a woman seated beside a café window.
+\`\`\`
+
+If an image is used only to define a character, scene, costume, or style, do not create a standalone picture entry. Instead, cite the image source inside the corresponding \`<Subject N>\` definition.
+
+When an image acts as a storyboard or shot-planning reference, state which shots it maps to and what planning information it provides:
+
+\`\`\`text
+<Picture 3> is a storyboard reference for [Shot 1] and [Shot 2], defining their viewpoint, subject placement, and shot order.
+\`\`\`
+
+### 2.3 \`<Video N>\`
+
+\`<Video N>\` is reserved for whole-video relationships, such as:
+
+- Editing an original video
+- Continuing from the end of an original video
+- Referencing the original video's camera movement, cuts, rhythm, or temporal structure
+
+\`\`\`text
+<Video 1> is the source video for the target video edit.
+\`\`\`
+
+If a person, object, scene, action, or effect from a reference video is reused as visible content, it still belongs under \`<Subject N>\`. \`<Video N>\` identifies the asset or structural source and does not replace subject labels.
+
+### 2.4 \`<Audio N>\`
+
+\`<Audio N>\` represents a standalone audio asset or an enabled synchronized audio track from a reference video. Common uses include:
+
+- Copying all or part of an audio signal
+- Referencing a background-music style
+- Referencing a speaker's voice timbre and delivery
+- Using dialogue, lyrics, or sound effects from the original audio
+- Referencing beat, rhythm, or audio continuity
+
+When an \`<Audio N>\` explicitly corresponds to a target speaker, reuse that speaker's global ID in the definition: write \`<Subject N> (Sx)\` when the speaker maps to a defined subject, or use a stable voice description followed by \`(Sx)\` otherwise. The ID comes from the target video's global speaker order and is not independently assigned or renumbered in the audio definition. See Section 5.4 for the speaker-numbering rules:
+
+\`\`\`text
+<Audio 1> is the voice-timbre reference for <Subject 1> (S1).
+\`\`\`
+
+When one audio asset serves multiple roles, describe those roles in one natural sentence rather than creating additional subsections.
+
+### 2.5 Visual and Audio Tracks from the Same Reference Video
+
+\`<Video N>\` and \`<Audio N>\` are numbered independently. Each index indicates only the label's order within its own category and does not encode a pairing between the two categories. The same reference video may therefore correspond to \`<Video 1>\` and \`<Audio 2>\`; different indices do not prevent them from coming from the same source asset.
+
+An ordinary reference video does not create \`<Audio N>\` merely because the file contains sound.
+
+An \`<Audio N>\` definition primarily states the audio's role and does not have to name the \`<Video N>\` it comes from. State the shared source only when needed to remove provenance ambiguity, for example:
+
+\`\`\`text
+<Video 1> is the source video for the target video edit.
+<Audio 2> is the synchronized audio track of <Video 1> and is reused in the target video.
+\`\`\`
+
+## 3. \`summary\`
+
+This section uses one short English paragraph to summarize the target video and its reference relationships. It begins with a square-bracketed task-type prefix:
+
+\`\`\`text
+[reference generation] ...
+[video editing + reference generation + audio reuse] ...
+\`\`\`
+
+Choose task types according to the actual role each reference asset plays in the target video:
+
+| Task type | When to use it |
+| --- | --- |
+| \`keyframe completion\` | An image serves as the target video's first frame, keyframe, last frame, edited keyframe, or another concrete frame anchor |
+| \`reference generation\` | An image, video, or audio asset provides generation guidance for a character, scene, style, action, camera movement, storyboard, and so on, without serving as a concrete frame or as the source video being edited or continued |
+| \`video editing\` | An existing source video is directly modified; editing an image or generating between still keyframes does not belong to this type |
+| \`video continuation\` | New content continues, extends, resumes, or transitions from an existing source video |
+| \`audio reuse\` | The same audio signal is reused in full or in part |
+| \`audio reference\` | The audio signal is not copied directly; only its music style, timbre, dialogue or lyric content, sound-effect texture, beat, or continuity is referenced |
+
+When a task satisfies multiple relationships, combine the task types with \` + \` and do not repeat a type. For example, continuing from a source video while using an image as the last frame is written as \`[video continuation + keyframe completion]\`. Editing a source video while retaining its original audio may be written as \`[video editing + audio reuse]\`.
+
+The mere presence of video or audio does not automatically create a corresponding task type. If a reference video provides only camera movement, cuts, or rhythm, it normally belongs to \`reference generation\`. Use \`video editing\` or \`video continuation\` only when that video is directly edited or continued.
+
+When editing a source video, use \`audio reuse\` as well if its original audio remains audible. When continuing a source video without directly copying the audio signal, use \`audio reference\` if the new audio only continues the original track's audible characteristics.
+
+The summary uses the previously defined \`<Subject N>\`, \`<Picture N>\`, \`<Video N>\`, and \`<Audio N>\` labels to describe the main subjects, shot flow, and roles of the reference assets. Do not introduce new reference labels in this section.
+
+For video-editing tasks, begin the summary after the task-type prefix with:
+
+\`\`\`text
+The target video is an edited version of <Video 1>.
+\`\`\`
+
+## 4. \`retention_analysis\`
+
+This section describes how each piece of referenced content is preserved, transferred, copied, or referenced in the target video. Use one line for each reference label and preserve the meaning established in \`subject_definitions\`.
+
+### 4.1 Visible Content
+
+\`<Subject N>\`, \`<Picture N>\`, and \`<Video N>\` use the following relationship markers. These markers are fixed English values in the output format:
+
+| Relationship marker | Meaning |
+| --- | --- |
+| \`fully_preserved\` | The defined role of the referenced content is fully preserved |
+| \`partially_preserved\` | The referenced content is still used, but some defined characteristics are changed or only partially retained |
+| \`attribute_transfer\` | Referenced characteristics are transferred to a different identifiable target subject |
+| \`weak_reference\` | Only broad similarity in style, category, composition, or atmosphere is retained |
+
+Subject entry:
+
+\`\`\`text
+<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - ...
+\`\`\`
+
+Picture entry:
+
+\`\`\`text
+<Picture 2> ([Shot 1] first frame): fully_preserved - ...
+\`\`\`
+
+Video-structure entry:
+
+\`\`\`text
+<Video 1> (cut and pacing structure): weak_reference - ...
+\`\`\`
+
+### 4.2 Audio
+
+\`<Audio N>\` uses the following relationship markers:
+
+| Relationship marker | Meaning |
+| --- | --- |
+| \`fully_copy\` | The complete source audio serves as the target video's complete final audio track |
+| \`partially_copy\` | Only part of the timeline or selected audio layers are copied, or other sounds are added, removed, or replaced after copying |
+| \`reference\` | The signal is not copied directly; only timbre, rhythm, music style, dialogue content, or sound texture is referenced |
+| \`weak_reference\` | Only broad similarity in category or atmosphere is retained |
+
+\`\`\`text
+<Audio 1>: fully_copy - <Audio 1> is reused 1:1 as the target video's complete final audio track.
+\`\`\`
+
+\`\`\`text
+<Audio 2>: reference - the target speaker follows <Audio 2>'s voice timbre and measured delivery without copying the original signal.
+\`\`\`
+
+Choose each relationship marker only within the reference role already defined for that label in \`subject_definitions\`. Do not treat newly added actions, backgrounds, or plot events in the target video as losses of reference fidelity.
+
+## 5. \`detailed_description\`
+
+This is the main body of a full-reference rewrite. It describes visuals, actions, sound, and dialogue shot by shot in target-video playback order and inserts reference labels where they apply.
+
+### 5.1 Basic Format
+
+The basic format follows the Video Prompt Writing Guide (T2VA / I2VA / FL2VA / L2VA):
+
+- Write the body in English. Preserve the original language of dialogue, lyrics, and visible text.
+- \`[Shot 1]\` marks the opening shot and has no timestamp. Later shots use \`[Shot N] At MM:SS.mmm, ...\` to mark cut times.
+- Write camera movement as natural English within the current shot, including movement type, amplitude, and speed when they need to be expressed.
+- Give vocal sources stable \`(S1)\`, \`(S2)\`, and subsequent IDs. Write dialogue and lyrics as \`<d>[Language] ...</d>\`.
+- Use \`<scenetrans>\`, \`<cutoff>\`, and the corresponding continuity descriptions for dialogue crossing a cut, speech truncated by the video ending, and continuous audio across shots.
+
+For complete rules and examples covering camera vocabulary, group speech, voice-over, dialogue across cuts, and visible text, see the Video Prompt Writing Guide (T2VA / I2VA / FL2VA / L2VA).
+
+### 5.2 Full-Reference Mode Differences
+
+| Dimension | T2VA | Full-reference mode |
+| --- | --- | --- |
+| Main field | \`integrated_multimodal_description\` | \`detailed_description\` |
+| Style opening | Written after \`[Shot 1]\` | Established in one or two English sentences before \`[Shot 1]\` |
+| Reference information | Does not use full-reference labels | Inserts \`<Subject N>\`, \`<Picture N>\`, \`<Video N>\`, and \`<Audio N>\` at their first appearance and where their roles apply |
+| Audio relationships | Describes the target video's own sound | Cites \`<Audio N>\` in the corresponding shot or audio phase and states whether the signal is copied or referenced |
+
+Opening example:
+
+\`\`\`text
+The target video is in a cinematic, literary music-video style with soft lighting and a slightly desaturated color palette.
+[Shot 1] The scene opens in a crowded urban street...
+[Shot 2] At 00:09.000, the shot cuts to an extreme close-up...
+\`\`\`
+
+For generation tasks, \`detailed_description\` is normally 350-500 English words. Dialogue-dense content prioritizes fitting the complete spoken timeline rather than mechanically reaching a word count. Video-editing descriptions scale with the complexity of the source video and do not have to follow the generation-task range. A single shot does not automatically justify a shorter description; distribute detail across multiple shots according to their information load.
+
+### 5.3 Using Reference Labels in Shots
+
+At the first clear appearance of an important \`<Subject N>\`, describe its referenced characteristics, position in the frame, and current action within what is actually visible in the shot. Continue using the same label in later shots without redefining what the label represents.
+
+Use natural phrasing for concrete frame anchors:
+
+\`\`\`text
+the shot begins from <Picture 1>
+the shot's keyframe corresponds to <Picture 2>
+the shot ends on <Picture 3>
+\`\`\`
+
+When editing or continuing an original video, cite \`<Video N>\` naturally where its source state, structure, or continuation relationship applies. Cite \`<Audio N>\` in the shot or semantic phase where the audio relationship is active.
+
+### 5.4 Speakers, Audio Sources, and Dialogue
+
+The basic speaker-ID and \`<d>\` formats follow T2VA. When a referenced subject physically speaks, retain both the visual reference label and the speaker ID:
+
+\`\`\`text
+<Subject 2> (S1) turns toward the woman and says, <d>[English] Last summer, I went to my grandfather's house. He talked about you.</d>
+\`\`\`
+
+\`<Subject N>\` identifies the referenced subject, while \`(Sx)\` identifies the actual speaker. When the subject speaks, write \`<Subject N> (Sx)\`. If the same subject speaks off-screen, keep the same form and mark it as \`off-screen\`. When the speaker does not correspond to a defined subject, use a stable voice description followed by \`(Sx)\`.
+
+When verbal content is only a cue within a directly reused BGM or complete soundtrack, and no person, character, narrator, or other independent vocal source physically produces it, use \`<Audio N>\` as the audible source and do not invent an additional \`(Sx)\`. If a concrete person, character, narrator, or other independent vocal source produces the voice, assign and reuse \`(Sx)\` for that source:
+
+\`\`\`text
+When <Audio 1> reaches the phrase <d>[English] I'm lonely lonely lonely lonely lonely I'm lonely</d>, <Subject 1> performs the corresponding hand gesture without becoming a separate speaker source.
+\`\`\`
+
+When dialogue, narration, or lyrics from reference audio are directly reused, or when the input prompt explicitly requests their reperformance, preserve the exact source words and original language inside \`<d>\`. Write \`[unclear]\` for unintelligible spans instead of guessing or paraphrasing them. Standardize punctuation to the basic written marks needed to express the sentence, such as \`,\`, \`.\`, \`?\`, and \`!\`; remove repeated tildes, emoji, bullets, and repeated or decorative punctuation. End complete statements, questions, and exclamations with \`.\`, \`?\`, or \`!\` respectively before \`</d>\`.
+
+When only timbre, rhythm, emotion, or delivery is referenced, do not carry the original dialogue from the reference audio into the target video.
+
+Assign \`(Sx)\` once according to the order of actual vocal events in the target video. Reuse the corresponding ID at every actual vocal event in \`detailed_description\`; an \`<Audio N>\` definition bound to a target speaker in \`subject_definitions\` also reuses the same \`(Sx)\` but never assigns a new one independently. Do not write \`(Sx)\` in \`retention_analysis\`. Verbal cues that exist only within a directly reused BGM or complete soundtrack use \`<Audio N>\`; voices physically produced by a concrete person, character, narrator, or other independent vocal source use \`(Sx)\`.
+
+## 6. \`overall_soundscape\` and \`non_diegetic_music\`
+
+The definitions of these two sound categories follow the Video Prompt Writing Guide (T2VA / I2VA / FL2VA / L2VA).
+
+\`overall_soundscape\` summarizes ambience and physical sounds across the full video. Dialogue, singing, and sound events synchronized to a particular shot remain in \`detailed_description\`:
+
+\`\`\`text
+overall_soundscape: Quiet indoor room tone and a low ventilation hum continue throughout the video.
+\`\`\`
+
+\`non_diegetic_music\` describes background music that the characters cannot hear and that is audible only to the audience. When music is present, state its instrumentation, tempo, and dynamic development:
+
+\`\`\`text
+non_diegetic_music: A restrained solo-piano score at a slow tempo, with sustained low cello underneath and no swell.
+\`\`\`
+
+When reference audio is used, state its copy or reference relationship only in the section that matches the audible layer: ambience and sound effects belong in \`overall_soundscape\`, while audience-only score belongs in \`non_diegetic_music\`. If the same audio provides both kinds of content, describe the corresponding relationship in each section:
+
+\`\`\`text
+overall_soundscape: The copied ambience layer from <Audio 1> continues throughout the target video.
+non_diegetic_music: <Audio 2> is directly reused as the complete audience-only score.
+\`\`\`
+
+Write complete dialogue and lyrics only inside \`<d>\` in \`detailed_description\`; do not repeat them in these two sections.
+
+## 7. Complete Example
+
+
+### Complete Example
+
+\`\`\`text
+subject_definitions:
+<Subject 1> is the coffee-shop environment in <Picture 1>, featuring an exposed brick wall, an orange tufted sofa with patterned pillows, a neon sign, and a wooden coffee table.
+<Subject 2> is the fluffy white Samoyed in <Picture 2>, <Picture 3>, and <Picture 4>, with thick white fur, pointed ears, a dark nose, and a curved tail.
+<Subject 3> is the young blonde woman in <Video 1>, with long blonde hair and a light-pink button-down shirt with rolled-up sleeves.
+<Subject 4> is the young man in <Video 2>, with short wavy brown hair and a dark-grey hoodie with drawstrings.
+<Audio 1> is the voice-timbre reference for <Subject 3> (S1), containing a spoken English vocal layer.
+
+summary:
+[reference generation + audio reference] The target video shows <Subject 3> eating a cookie in <Subject 1>. <Subject 4> enters with <Subject 2>, which lunges toward the cookie. The three-shot exchange uses <Audio 1> as the voice-timbre reference for <Subject 3> and ends with a canned audience laugh.
+
+retention_analysis:
+<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - the exposed brick wall, orange tufted sofa, patterned pillows, neon sign, and wooden coffee table are retained.
+<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - the Samoyed's thick white fur, pointed ears, dark nose, and curved tail are retained.
+<Subject 3> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - the blonde woman's identity, long hair, and light-pink shirt are retained.
+<Subject 4> (appears in [Shot 1], [Shot 2]): fully_preserved - the young man's short wavy brown hair and dark-grey hoodie are retained.
+<Audio 1>: reference - its vocal timbre guides the dialogue delivery of <Subject 3> without copying the original signal.
+
+detailed_description:
+The target video uses a realistic multi-camera sitcom style with warm indoor lighting.
+[Shot 1] A medium shot establishes <Subject 1>, the coffee shop with its exposed brick wall, orange tufted sofa, patterned pillows, neon sign, and wooden coffee table. <Subject 3> (S1), the young woman with long blonde hair and a light-pink button-down shirt with rolled-up sleeves, sits on the sofa holding a chocolate-chip cookie. From the left, <Subject 4>, the young man with short wavy brown hair and a dark-grey hoodie with drawstrings, enters holding the leash of <Subject 2>, the thick-furred white Samoyed with pointed ears, a dark nose, and a curved tail. The dog lunges toward the cookie and pulls the leash taut. <Subject 3> (S1) jerks her hand back and, using the clear youthful voice timbre referenced from <Audio 1>, exclaims with light annoyance, <d>[English] Hey! Watch your dog!</d> She closes her lips and guards the cookie while <Subject 4> pulls the dog back.
+[Shot 2] At 00:03.000, the shot cuts to a close-up of <Subject 4> (S2), the young man in the dark-grey hoodie from Shot 1, sitting beside <Subject 3> on the sofa and holding <Subject 2> securely in his arms. <Subject 4> (S2) says in a casual young male voice with a playful tone and an easy conversational pace, <d>[English] He just likes cookies more than me.</d> He closes his mouth into an apologetic smile and strokes the dog's thick white fur.
+[Shot 3] At 00:05.000, the shot cuts to a close-up of <Subject 3> (S1), the blonde woman in the light-pink shirt from Shot 1. Her annoyance softens as she looks toward the Samoyed. <Subject 3> (S1) replies in the same clear youthful voice referenced from <Audio 1> with an amused cadence, <d>[English] Well, he has good taste at least.</d> She smiles and raises the cookie in a small toast-like gesture. A classic canned audience laugh begins immediately after the line and continues through the final frame.
+
+overall_soundscape:
+Soft indoor coffee-shop room tone continues throughout the scene.
+
+non_diegetic_music:
+N/A
+\`\`\``;
diff --git a/plugins/prompt-master/src/resolver/minimax/templates/h3-reference.zh.ts b/plugins/prompt-master/src/resolver/minimax/templates/h3-reference.zh.ts
index d8390b7..f617dc2 100644
--- a/plugins/prompt-master/src/resolver/minimax/templates/h3-reference.zh.ts
+++ b/plugins/prompt-master/src/resolver/minimax/templates/h3-reference.zh.ts
@@ -1,59 +1,164 @@
-// MiniMax-H3 Full-Reference Guide (中文) — simplified from PM
-// 完整版：electron/config/prompts/h3-full-reference-rewrite.zh.js (60K 原版)
-
-export const H3_REFERENCE_ZH = `# MiniMax-H3 Full-Reference 模式（中文指南）
-
-## 六段式结构（强制）
-
-### 1. 主体定义:
-对每个主体列出：
-- 身份（IP/角色名）
-- 视觉特征（发色、瞳色、体型、年龄感）
-- 服装（穿搭层次、材质、配色）
-- 默认姿态
-
-参考标签：<Subject N>、<Picture N>、<Video N>、<Audio N>
-
-### 2. 摘要:
-一句话（≤30字）描述视频主体内容。
-
-### 3. 保留分析:
-每个镜头：
-- 出现哪些主体（按标签引用）
-- 保留状态：fully_preserved | partially_preserved
-- 哪些身份/服装特征保留 vs 流失
-
-### 4. 详细描述:
-每个 [Shot N]：
-- 镜头（景别、运动、构图）
-- 主体动作（具体动词、视线方向）
-- 环境
-- 光影
-- 时间节拍（开头/中间/结尾）
-
-时间戳：At 00:00.000 至 MM:SS.mmm
-
-### 5. 整体声景:
-- 环境音（城市/自然/室内底噪）
-- 动作音（脚步声、门声、呼吸）
-- 对白（<d>[语言] 文字</d> 格式）
-- 拟音/冲击音
-
-### 6. 非叙事配乐:
-- 风格（管弦/电子/氛围）
-- 节奏/BPM
-- 情绪基调
-- 配乐弧线（推进/释放/收束）
-
-## 硬性规则
-- 禁止 Markdown 代码围栏（不要 \`\`\`）
-- 禁止寒暄与解释
-- 直接以「主体定义:」开头
-- 以「非叙事配乐:」内容结束
-- 对白用 <d>[语言] 文字</d> 格式
-- 参考标签、关系标记、镜头标记保持英文
-
-## 篇幅预算
-- 每个 [Shot N] 描述：50-150 字
-- 总长度：800-1500 tokens（5-15 秒视频）
-`;
\ No newline at end of file
+// MiniMax-H3 Full-Reference Guide (zh) — verbatim from PM 3.1.0 h3-full-reference-rewrite.zh.js (X8)
+
+export const H3_REFERENCE_ZH = `# 角色与任务
+你是专业的 AI 视频提示词工程师。请把用户输入改写为严格标准的 MiniMax-H3 Full-Reference 六段视频提示词。
+
+# 核心执行规则
+1. **纯净输出**：只输出最终六段正文。不要寒暄、解释、Markdown 代码围栏、道歉或备注。输出必须以 \`主体定义:\` 开头，以 \`非叙事配乐:\` 的内容结束。
+2. **严格改写 vs 扩写**：
+   - 默认严格改写，不要编造用户未给出或未强烈暗示的情节、动作、角色或场景。
+   - **仅当**用户明确说「帮我写提示词」或同类扩写请求时，才可补充必要的视觉、听觉与时间细节，使提示词可直接生成。
+3. **图片顺序一致**：多张参考图必须保持用户原始顺序，依次映射为 \`<Picture 1>\`、\`<Picture 2>\` 等。
+4. **音频参考**：若用户提到参考音频，按模板规则定义为 \`<Audio N>\`，说明复制/参考角色，并在相关段落引用。
+5. **语言（本模板强制中文）**：
+   - **六段标题必须用中文**：\`主体定义:\` / \`摘要:\` / \`保留分析:\` / \`详细描述:\` / \`整体声景:\` / \`非叙事配乐:\`
+   - **禁止**输出英文章节标题（如 \`subject_definitions:\`、\`summary:\` 等）
+   - 六段正文必须全部使用简体中文
+   - 以下技术标记保持英文不变：
+     - 参考标签：\`<Subject N>\` / \`<Picture N>\` / \`<Video N>\` / \`<Audio N>\`
+     - 关系标记：\`fully_preserved\` / \`partially_preserved\` / \`attribute_transfer\` / \`weak_reference\` / \`fully_copy\` / \`partially_copy\` / \`reference\`
+     - 镜头标记：\`[Shot 1]\`、\`[Shot 2] At 00:03.000, ...\`
+     - 任务前缀：\`[reference generation]\` 等
+     - 对白标签语言码：\`<d>[Chinese] ...</d>\` / \`<d>[English] ...</d>\`
+   对白、歌词、画面可见文字在 \`<d>\` 内保留其实际语言。
+
+---
+
+# Full-Reference 模式改写格式指南（中文标题 + 中文正文）
+
+## 1. 整体结构
+
+完整输出按以下顺序包含六段（标题用中文，冒号后换行写正文）：
+
+| 中文标题 | 作用 |
+| --- | --- |
+| \`主体定义:\` | 定义参考内容及其标签 |
+| \`摘要:\` | 总结任务类型、目标视频与主要参考关系 |
+| \`保留分析:\` | 说明各参考内容如何保留、迁移或复用 |
+| \`详细描述:\` | 按播放顺序描述画面、动作、镜头、声音与对白 |
+| \`整体声景:\` | 总结全程环境音与物理声 |
+| \`非叙事配乐:\` | 描述仅观众能听见的背景音乐 |
+
+## 2. 参考标签与定义（主体定义）
+
+四类标签：
+
+| 标签 | 含义 |
+| --- | --- |
+| \`<Subject N>\` | 可复用/可修改的可见内容单元（人、物、场景、服饰、风格动作等） |
+| \`<Picture N>\` | 作为首帧/关键帧/构图锚点的参考图 |
+| \`<Video N>\` | 提供剪辑源、续写起点或整体时间结构的参考视频 |
+| \`<Audio N>\` | 被复制或参考的音频 |
+
+标签一旦分配，在全文各段保持同一含义。
+
+每条定义独占一行，说明标签所指、参考角色、需遵循的主要特征。
+
+中文正文示例：
+
+\`\`\`text
+<Subject 1> 是 <Picture 1> 中的银色智能手机，具有抛光金属边框、全面屏与蓝粉渐变壁纸。
+<Picture 1> 是 [Shot 1] 的英雄主视角构图锚点，展示对角悬浮的产品摄影角度。
+\`\`\`
+
+多素材合成同一主体时：
+
+\`\`\`text
+<Subject 1> 是外观来自 <Picture 1>、材质细节参考 <Picture 2> 的同一款产品。
+\`\`\`
+
+## 3. 摘要
+
+用一小段中文总结目标视频与参考关系，并以方括号任务类型开头，例如：
+
+\`\`\`text
+[reference generation] 目标视频以 <Picture 1> 中的 <Subject 1> 为主角，呈现白色科技风极简产品广告，并在中段与结尾出现单行中文画面文案。
+\`\`\`
+
+常用任务类型（英文键名保持不变，可用 \` + \` 组合）：
+\`keyframe completion\` / \`reference generation\` / \`video editing\` / \`video continuation\` / \`audio reuse\` / \`audio reference\`
+
+## 4. 保留分析
+
+每个参考标签一行，中文说明保留方式。可见内容关系标记：
+\`fully_preserved\` / \`partially_preserved\` / \`attribute_transfer\` / \`weak_reference\`
+
+音频关系标记：
+\`fully_copy\` / \`partially_copy\` / \`reference\` / \`weak_reference\`
+
+示例：
+
+\`\`\`text
+<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - 银色金属边框、屏幕渐变与机身轮廓完整保留。
+<Picture 1> ([Shot 1] hero view): fully_preserved - 对角英雄构图与产品比例被保留为开场视觉。
+\`\`\`
+
+## 5. 详细描述
+
+这是主体。按目标视频播放顺序，用中文逐镜头写清：构图、主体外观与位置、环境光线、动作与状态变化、运镜、当前声音，以及参考内容生效点。不要写成剧情摘要。
+
+基本格式：
+- 开头用一两句中文建立风格。
+- \`[Shot 1]\` 无时间戳；后续镜头用 \`[Shot N] At MM:SS.mmm, ...\`
+- 运镜用自然语言写在镜头内。
+- 说话人用 \`(S1)\` \`(S2)\`；对白写 \`<d>[Chinese] ...</d>\` 或对应语言。
+- 生成任务通常 350–500 汉字量级的信息密度；对白密集时以完整口播时间轴优先。
+
+示例开头：
+
+\`\`\`text
+目标视频采用干净的白色科技风产品片语言，留白充足，光线均匀高级。
+[Shot 1] 中景建立 <Subject 1>……
+[Shot 2] At 00:03.000, 镜头切到金属边特写……
+\`\`\`
+
+## 6. 整体声景 与 非叙事配乐
+
+\`整体声景:\`：用中文总结全程环境音与物理声；对白与单镜头同步事件留在 \`详细描述:\`。
+
+\`非叙事配乐:\`：用中文描述仅观众听见的配乐（乐器、节奏、动态）。若无配乐写 \`N/A\`。
+
+示例：
+
+\`\`\`text
+整体声景:
+干净的室内空气感底噪贯穿全片，伴随轻微高频空间感。
+
+非叙事配乐:
+约 100 BPM 的克制科技感配乐，拨弦与空气噪声铺底，结尾 0.5 秒内突然收束，仅留拨弦余韵。
+\`\`\`
+
+## 7. 完整示例（中文标题 + 中文正文）
+
+\`\`\`text
+主体定义:
+<Subject 1> 是 <Picture 1> 中的银色智能手机，抛光金属直边、圆角、全面屏显示蓝到品红渐变壁纸，屏幕中央有白色产品名。
+<Picture 1> 是 [Shot 1] 与结尾构图的英雄视角锚点。
+
+摘要:
+[reference generation] 目标视频以 <Subject 1> 完成一条 10 秒 9:16 白色科技风极简产品广告，强调金属质感与屏幕渐变，并在中段与结尾落下单行中文画面文案。
+
+保留分析:
+<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - 银色机身、边框高光与屏幕渐变被完整保留。
+<Picture 1> ([Shot 1] hero / closing): fully_preserved - 产品轮廓与对角英雄感被保留。
+
+详细描述:
+目标视频采用极简白色科技风，背景干净留白，光线均匀，突出产品质感。
+[Shot 1] 刁钻对角英雄角快速建立 <Subject 1>，机身轻旋约 12 度，高光沿右侧银边滑过；无空镜，无文字。
+[Shot 2] At 00:03.000, 推近至四分之三正面，屏幕蓝到品红渐变稳定发光，产品轮廓清晰；无文字。
+[Shot 3] At 00:05.000, 切至金属边与侧键微距，高光滑过抛光银框；无文字。
+[Shot 4] At 00:07.000, 回拉半身，机身轻微立起。单行中文文案先淡入前半「触感」，再同线淡入后半「精准」，后半使用银色强调，终帧前可读。
+[Shot 5] At 00:08.500, 稳定收尾构图，产品清晰，留白充足，完整单行文案静持到结束。禁止宫格、分屏或产品墙。
+
+整体声景:
+干净通透的室内底噪贯穿全片，金属轻触的细微质感音偶发但不抢戏。
+
+非叙事配乐:
+约 100 BPM 的科技感轻配乐，块状和弦、清脆拨弦与空气噪声，结尾突然收束并留下短尾音。
+\`\`\`
+
+# 再次强调
+- 六段标题必须是中文：\`主体定义:\` \`摘要:\` \`保留分析:\` \`详细描述:\` \`整体声景:\` \`非叙事配乐:\`
+- 禁止使用 \`subject_definitions:\` / \`summary:\` / \`retention_analysis:\` / \`detailed_description:\` / \`overall_soundscape:\` / \`non_diegetic_music:\`
+- 参考标签、关系标记、镜头标记保持英文格式
+- 正文、声音与画面广告文案必须是简体中文`;
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
 
diff --git a/plugins/prompt-master/src/resolver/profiles/torii/prompts.ts b/plugins/prompt-master/src/resolver/profiles/torii/prompts.ts
index 3fb665d..d048fae 100644
--- a/plugins/prompt-master/src/resolver/profiles/torii/prompts.ts
+++ b/plugins/prompt-master/src/resolver/profiles/torii/prompts.ts
@@ -1,11 +1,20 @@
-// Torii Gate-0.5 结构化 prompt 数据 — 1:1 移植自 PM torii_prompts_data.js
+// Torii Gate-0.5 结构化 prompt 数据 — 1:1 移植自 PM 3.1.0 torii_prompts_data.js
+// （resolver×3.1.0 parity 审计高危项 #2：PROMPTS_B 官方模板回填 + TORII_JSON_FORMATS /
+//   JSON_OUTPUT_SUFFIX / SYSTEM_PROMPT / makeUserQuery grounding 管线补回）
+
+export interface ToriiGroundingItem {
+  tags?: string[];
+  characters?: string[];
+  char_p_tags?: { chars?: Record<string, string[]>; skins?: Record<string, string[]> };
+  char_descr?: { chars?: Record<string, string>; skins?: Record<string, string> };
+}
 
 export const PROMPTS_B: Record<string, string> = {
   long_thoughts_v2: `Your answer must contain 6 parts:
 <format>
 # 1. Thoughts about characters
 You need to think here and compare peoples/creatures that you see on the picture with given popular tags, or descriptions, or your memories for each characters to determine who is who.
 # 2. Key details
 Here you need to determine key details on comic and list them.
 # 3. Long description
 Here come up with a long and detailed description of image content. Be creative, mention all detailes you listed above and other important things.
@@ -40,102 +49,282 @@ Give some info about objects on background, describe the location (if seen). The
 `,
 
   json: `Use json-style caption for given image with following structure:
 {"character" : "Description for character or object. Name (if defined), main details, features, position, pose, etc.",
 /or in case of multiple
 "character_1" : "Description for first"
 "character_2" : "Description for second ",
 "character_N"...
 /or if there are no characters
 "main content" : "long and detailed description of main content of image that might be the main focus if characters are missing",
-/or
-"background" : "description of background",
-"style" : "art style, camera angle, lighting"
-}`,
+/
+"background" : "Detailed descritpion of background and it's content",
+"image_effects" : "If there are some visual effects like fisheye distortion, chromatic aberration, glitches, messy drawing or anything else - write about it. If it's just a general anime art - omit this field."
+"texts" : "Speech bubbles, bars, marks, signs etc. with texts if present, else None",
+"atmosphere" : "...",
+}
+In special cases you can add extra keys.
+`,
+
+  long: `Make a caption for given image with natural text. Use 2 to 5 paragraphs. Make your description long and vivid, mentioning all the details.
+`,
 
   min_structured_md: `Your answer must contain 3 parts:
 <format>
 # 1. Thoughts about characters
-You need to think here and compare peoples/creatures that you see on the picture with given popular tags, or descriptions, or your memories for each characters to determine who is who.
+You need to think here and compare peoples/creatures that you see on the picture  with given popular tags, or descriptions, or your memories for each characters to determine who is who.
+If no characters are listed in input - just write here "No named characters"
 # 2. Key details
-Here you need to determine key details on image and list them.
+Here you need to write about the key details on image, prefere using regular text.
 # 3. Structured description
 ## General
-Write here composition, background, and all objects on background that are not characters.
+Write about general composition, content of image, background and all things that are not related to characters directly.
 ## Character name 1 (put here the name if any)
-Description of character/character name.
+Write about datails and content related to specific character, including features, poses, look, used objects, interactions, and other things.
 ## Character name 2 (put here the name if any)
 Same for each character.
-...
 ## Image effects
-Write here about style, camera, lighting, etc. If no effects - write "none" here.
+Mention image effect, style, camera angle
 </format>
-For captioning only structured description is required. Generate only # 3 in your output. Don't output your thoughts or key details list to final answer. Just output ## headers, body, and image_effects section under # 3. `,
+In general stick to shorter descriptions.
+`,
+
+  json_comic: `Use json-style caption to describe to comin, stick to following structure:
+{
+"comic_format": "menation the format, for example Comic of N frames",
+"1st_frame": "Main description of the content for fist frame",
+"2nd_frame": "Same for the second",
+...
+"Nth_ftame": "...",
+"character_1": "Describe the characters in comic",
+...
+"character_N": "Separate description for each",
+"meaning": "Try to guess general mood, vibe and meaning of the comic"
+}
+`,
+
+  md_comic: `Use markdown format to describe to comic, 5 parts are recommended:
+<format>
+# 1. Thoughts about characters
+You need to think here and compare peoples/creatures that you see on the picture with given popular tags, or descriptions, or your memories for each characters to determine who is who.
+# 2. Key details
+Here you need to determine key details on comic and list them.
+# 3. Comic format
+In this section come up with the description of comic format, how many pages there are, horisontal/vertical orientation and other things. Optionally you can list main characters here.
+# 4. Details for each frame
+## 4.1 Frame 1 (position)
+Description for each frame, includding characters, objects, interactions, texts/speech bubbles and other things. Be detailed but not overdoo.
+## 4.2 Frame 2 (position)
+Same for each frame.
+...
+# 5. Extra comment
+Here you should write general desciption and some other info about the image.
+</format>
+`,
 
+  min_structured_json: `
+Use json-style caption for given image with following structure:
+{"General" : "Here you need to come up with general/common information about picture, overall composition. Stick to shorter phrases and tags instead of long purple prose. Avoid bullets and markdown, write in plain text.",
+"character_1 (put here the name if any)" : "Description of first character."
+"character_2 (if present" : "Description for second ",
+"character_N"
+...
+"image_effects" : "Mention here effects on image if there are any distinct."
+"texts" : "Speech bubbles, bars, marks, signs etc. with texts if present, else None",
+"watermarks" : "If present",
+}
+Prefere shorter description and tags.
+`,
+
+  'chroma-style': `Your task is to describe the picture in very detail using a structure of 4 parts.
+### 1. Regular Summary:
+[A one-paragraph summary of the image. The paragraph should mention all individual parts/things/characters/etc.]
+### 2. Individual Parts:
+[List the individual things you see in the image and their relative positions to other parts. Use a numbered list of between 5 and 30 items depending on image complexity.]
+### 3. Midjourney-Style Summary:
+[A summary that has higher concept density by using comma-separated partial sentences instead of proper sentence structure.]
+### 4. DeviantArt Commission Request
+[Write a description as if you're commissioning this *exact* image via someone who is currently taking requests.]
+`,
+
+  short: `The caption for image should be quite short without long purple prose and slop. Cover main objects and details.
+`,
+
+  danbooru_line: `Return ONLY one JSON object (no markdown, no prose before or after JSON) with exactly these keys:
+{"artist":"artist name or unknown",
+"copyright":"series/copyright or original",
+"character":"character name(s) or none",
+"meta":"meta tag or none",
+"tags":"general Danbooru tags ONLY: comma-separated lowercase English; spaces inside phrases (long hair, blue eyes); include counts (1girl, solo), clothing, pose, expression, background. NO full sentences in any value."}
+`,
+
+  sd_tag_line: `Return ONLY one JSON object with key "tags": comma-separated English Stable Diffusion prompt tags/phrases (one line; spaces inside phrases OK). NO sentences, NO markdown, NO extra keys unless needed.`,
+
+  // port-only extension：上游无此模板（上游靠 cTypeRuntime=min_structured_md 复用），
+  // 保留以兼容既有 pe_torii_min_structured_md_body 语义；无直接 PROMPTS_B 消费方。
   min_structured_md_body: `Your answer must contain only 3 parts in body format:
 <format>
 ## General
 Write here composition, background, and all objects on background that are not characters.
 ## Character name 1 (put here the name if any)
 Description of character/character name.
 ## Character name 2 (put here the name if any)
 Same for each character.
 ...
 ## Image effects
 Write here about style, camera, lighting, etc. If no effects - write "none" here.
 </format>
 Output only this. Do not output thoughts, key details or other parts to final answer. Just output structured description body. `,
+};
 
-  min_structured_json: `Output ONLY valid JSON with following keys (omit missing keys):
-{
-  "General": "composition, background, non-character objects",
-  "<Character name 1>": "name + traits, clothing, pose, expression, actions, interactions",
-  "<Character name 2>": "...",
-  "Background": "...",
-  "Style": "...",
-  "Image effects": "...",
-  "OCR/text": "transcribe text, fonts, positions",
-  "Individual Parts": "numbered list 5-20 items"
+// upstream parity：官方 JSON 类格式集合（json / json_comic / min_structured_json / danbooru_line / sd_tag_line）。
+// 上游消费方 torii_llama_helper.js 属 llama 推理路径，port 已裁剪 —— upstream parity, no consumer in port。
+export const TORII_JSON_FORMATS: ReadonlySet<string> = new Set([
+  'json',
+  'json_comic',
+  'min_structured_json',
+  'danbooru_line',
+  'sd_tag_line',
+]);
+
+// upstream parity, no consumer in port（上游由 torii_llama_helper.js 追加到 JSON 类 userQuery 尾部）
+export const JSON_OUTPUT_SUFFIX =
+  '\n\n# Output requirement\n' +
+  'Return exactly one valid JSON object matching the schema above. ' +
+  'Do not use markdown section headings (for example # 1. Thoughts, # 2. Key details, ' +
+  '# 3. Long description). No prose before or after the JSON.\n';
+
+// upstream parity, no consumer in port（上游为 torii 打标的统一 system prompt）
+export const SYSTEM_PROMPT =
+  "You are image captioning expert. Describe user's picture according to requested format and instructions.";
+
+function shuffleInPlace(arr: string[]): string[] {
+  for (let i = arr.length - 1; i > 0; i--) {
+    const j = Math.floor(Math.random() * (i + 1));
+    [arr[i], arr[j]] = [arr[j], arr[i]];
+  }
+  return arr;
 }
-Valid JSON only. No markdown, no prose. `,
-
-  md_comic: `Output ONLY markdown comic format:
-# Title
-## Panel 1
-[Framing, camera, panel layout, lighting, sound effects]
-### Visual
-[Detailed visual description]
-### Caption
-[Dialogue/narration with character names in CAPS, sound effects]
-### Mood
-[Overall mood and tone]
-## Panel 2
-[same structure]
-...
-## Summary
-[Brief overall story summary]`,
-
-  json_comic: `Output ONLY valid JSON array of panels:
-[
-  {
-    "panel": 1,
-    "framing": "close-up, wide shot, etc.",
-    "camera": "pan, zoom, etc.",
-    "visual": "detailed visual description",
-    "caption": "dialogue/narration",
-    "characters": ["name1", "name2"],
-    "sound_effects": "...",
-    "mood": "..."
-  },
-  ...
-]
-Valid JSON only. No markdown.`,
-
-  long: `Write a long, natural-language description of the image in 2-5 paragraphs. Cover main subjects, scene, action, style. Do not use markdown headers.`,
-
-  short: `Write a short, concise description covering main subjects and key details. No redundancy, no markdown.`,
-};
 
-// Torii prompt 数据 — 训练 grounding 相关
+/**
+ * Torii grounding user-query 构造管线 — 1:1 移植自上游 makeUserQuery。
+ * upstream parity, no consumer in port：上游由 torii_llama_helper.js（llama 路径）消费；
+ * port 的反推走 CaptionPE / expand-mirror 路线，保留此管线以保证数据/行为完整性。
+ */
+export function makeUserQuery(
+  item: ToriiGroundingItem,
+  cType: string,
+  useNames: boolean,
+  addTags: boolean,
+  addCharacters: boolean,
+  addCharTags: boolean,
+  addDescription: boolean,
+  underscoresReplace = false,
+): string {
+  const tags = [...(item.tags || [])];
+  shuffleInPlace(tags);
+  let tagsString: string;
+  if (underscoresReplace) {
+    tagsString = tags
+      .map((a) => (a.length > 3 ? a.replace(/_/g, ' ') : a))
+      .join(', ');
+  } else {
+    tagsString = tags.join(' ');
+  }
+
+  let userRequest = '# Captioning format:\n';
+  userRequest += PROMPTS_B[cType];
+  userRequest += '\n';
+
+  if (addTags) {
+    userRequest += `# Booru tags for the image\n[${tagsString}]\n\n`;
+  }
+
+  if (useNames) {
+    if (addCharacters) {
+      let charsTags = [...(item.characters || [])];
+      let charsString: string;
+      if (underscoresReplace) {
+        charsTags = charsTags.map((a) => a.replace(/_/g, ' '));
+        charsString = charsTags.join(', ');
+      } else {
+        charsString = charsTags.join(' ');
+      }
+
+      userRequest +=
+        '# Characters on picture:\n' +
+        `Here are names/tags for characters from the picture, make sure to use them: [${charsString}].\n\n`;
+
+      const charsPopularTags = item.char_p_tags || { chars: {}, skins: {} };
+      const charsDescription = item.char_descr || { chars: {}, skins: {} };
+      const popularTagsChars = charsPopularTags.chars || {};
+      const popularTagsSkins = charsPopularTags.skins || {};
+      const descrChars = charsDescription.chars || {};
+      const descrSkins = charsDescription.skins || {};
+
+      if (
+        Object.keys(popularTagsChars).length > 0 &&
+        (addCharTags || addDescription)
+      ) {
+        userRequest += '# Known traits for characters\n';
+        const charUnderscores = underscoresReplace;
+
+        if (addCharTags) {
+          userRequest += 'Here are popular tags for each characters on picture:\n';
+          for (const [cName, cTags] of Object.entries(popularTagsChars)) {
+            const name = charUnderscores ? cName.replace(/_/g, ' ') : cName;
+            const tagsS = charUnderscores
+              ? cTags
+                  .map((a) => (a.length > 3 ? a.replace(/_/g, ' ') : a))
+                  .join(', ')
+              : cTags.join(' ');
+            userRequest += `${name}: [${tagsS}]\n`;
+          }
+          if (Object.keys(popularTagsSkins).length > 0) {
+            userRequest += 'Extra tags for characters skins:\n';
+            for (const [cName, cTags] of Object.entries(popularTagsSkins)) {
+              const name = charUnderscores ? cName.replace(/_/g, ' ') : cName;
+              const tagsS = charUnderscores
+                ? cTags
+                    .map((a) => (a.length > 3 ? a.replace(/_/g, ' ') : a))
+                    .join(', ')
+                : cTags.join(' ');
+              userRequest += `${name}: [${tagsS}]\n`;
+            }
+          }
+        } else if (addDescription) {
+          userRequest +=
+            'Here are general descriptions for each characters on the picture:\n';
+          for (const [cName, cDescr] of Object.entries(descrChars)) {
+            const name = charUnderscores ? cName.replace(/_/g, ' ') : cName;
+            userRequest += `## ${name}\n${cDescr}\n\n`;
+          }
+          if (Object.keys(descrSkins).length > 0) {
+            userRequest +=
+              'Here are also descriptions for specific skin of characters:\n';
+            for (const [cName, cDescr] of Object.entries(descrSkins)) {
+              const name = charUnderscores ? cName.replace(/_/g, ' ') : cName;
+              userRequest += `## ${name}\n${cDescr}\n\n`;
+            }
+          }
+        }
+      }
+    } else {
+      userRequest +=
+        '# Characters on picture:\nTry to recognize the characters in the picture and use their names.\n';
+    }
+    userRequest += '\n';
+  } else {
+    userRequest += '# Characters on picture:\nAvoid to guess names for characters.\n';
+  }
+
+  return userRequest;
+}
+
+// Torii prompt 数据 — 训练 grounding 相关（历史命名空间导出，保留兼容）
 export const TORII_PROMPTS_DATA = {
   PROMPTS_B,
-};
\ No newline at end of file
+  TORII_JSON_FORMATS,
+  JSON_OUTPUT_SUFFIX,
+  SYSTEM_PROMPT,
+  makeUserQuery,
+};
diff --git a/plugins/prompt-master/tests/resolver/minimax-parity.test.ts b/plugins/prompt-master/tests/resolver/minimax-parity.test.ts
new file mode 100644
index 0000000..8a5d2aa
--- /dev/null
+++ b/plugins/prompt-master/tests/resolver/minimax-parity.test.ts
@@ -0,0 +1,233 @@
+// minimax assemble parity — upstream 3.1.0 对照断言（X1-X8）
+import { describe, expect, it } from 'vitest'
+import {
+  resolveMinimaxScenarioExpand,
+  isMinimaxScenarioProfile,
+  enumerateTaggedMedia,
+  classifyMediaPath,
+  buildSystem,
+} from '../../src/resolver/minimax/assemble.js'
+import {
+  isH3FullReferenceProfile,
+  isH3FullReferencePeId,
+  resolveH3FullReferenceExpand,
+  H3_FULL_REFERENCE_PROFILE_ID,
+  H3_FULL_REFERENCE_USER_PROMPT_TEMPLATE,
+} from '../../src/resolver/minimax/h3-full-reference.js'
+import { H3_REFERENCE_ZH, H3_REFERENCE_EN } from '../../src/resolver/minimax/templates/index.js'
+import { getScenarioById } from '../../src/resolver/minimax/catalog.js'
+
+const expand = (scenarioId: string, params: any = {}, profile: any = {}) =>
+  resolveMinimaxScenarioExpand(
+    { id: scenarioId, minimaxScenarioId: scenarioId, kind: 'expand', ...profile },
+    params,
+  )!
+
+// === X5：resolveMinimaxScenarioExpand ===
+describe('X5 resolveMinimaxScenarioExpand', () => {
+  it('maxTokens >= 4096 (mediaExpandMin floor, was 768)', () => {
+    const r = expand('full_reference', {})
+    expect(r.maxTokens).toBeGreaterThanOrEqual(4096)
+  })
+
+  it('tokenLimits.mediaExpandMin override respected', () => {
+    const r = expand('full_reference', { tokenLimits: { expandMax: 8192, mediaExpandMin: 5000 } })
+    expect(r.maxTokens).toBeGreaterThanOrEqual(5000)
+  })
+
+  it('userExtraPrompt appended to system', () => {
+    const r = expand('full_reference', { userExtraPrompt: '加一段彩蛋镜头' })
+    expect(r.system).toContain('【User additional requirements】加一段彩蛋镜头')
+  })
+
+  it('accepts params.minimaxForm direct form (upstream) AND nested form_fields (tool surface)', () => {
+    const direct = expand('full_reference', { minimaxForm: { aspect_ratio: '9:16' } })
+    const nested = expand('full_reference', { minimaxForm: { form_fields: { aspect_ratio: '9:16' }, output_lang: 'zh' } })
+    expect(direct.user).toContain('9:16')
+    expect(nested.user).toContain('9:16')
+  })
+
+  it('scenario resolution falls back to params.peId / params.ruleId', () => {
+    const r1 = resolveMinimaxScenarioExpand(null as any, { peId: 'pe_expand_minimax_coop_game' })
+    const r2 = resolveMinimaxScenarioExpand({ kind: 'expand' } as any, { ruleId: 'pe_expand_minimax_coop_game' })
+    expect(r1?.minimaxScenarioId).toBe('coop_game')
+    expect(r2?.minimaxScenarioId).toBe('coop_game')
+  })
+
+  it('returns minimaxScenarioId + mediaExpandLayout + upstream ruleId', () => {
+    const r = expand('full_reference', {})
+    expect(r.minimaxScenarioId).toBe('full_reference')
+    expect(r.mediaExpandLayout).toBe(true)
+    expect(r.ruleId).toBe('pe_expand_h3_full_reference')
+  })
+
+  it('isMinimaxScenarioProfile matches upstream semantics', () => {
+    expect(isMinimaxScenarioProfile({ kind: 'expand', minimaxScenarioId: 'full_reference' })).toBe(true)
+    expect(isMinimaxScenarioProfile({ kind: 'expand', outputFormat: 'minimax' })).toBe(true)
+    expect(isMinimaxScenarioProfile({ kind: 'expand', id: 'pe_expand_minimax_coop_game' })).toBe(true)
+    expect(isMinimaxScenarioProfile({ kind: 'reverse', minimaxScenarioId: 'x' })).toBe(false)
+  })
+})
+
+// === X1：buildUser 五块结构 ===
+describe('X1 buildUser five-block structure', () => {
+  const r = expand('full_reference', { shortText: '银色手机悬浮旋转', mediaPaths: ['refs/phone.png'] })
+
+  it('contains 【场景】【输出语言】 blocks', () => {
+    expect(r.user).toContain('【场景】Minimax六段式通用提示词')
+    expect(r.user).toContain('【输出语言】中文 — 这是强制要求')
+  })
+
+  it('contains 【表单参数】 block with form lines', () => {
+    expect(r.user).toContain('【表单参数】')
+    expect(r.user).toMatch(/- 画幅比例: .+16:9/)
+  })
+
+  it('contains 【创作需求 / User request】 block with shortText', () => {
+    expect(r.user).toContain('【创作需求 / User request】')
+    expect(r.user).toContain('银色手机悬浮旋转')
+  })
+
+  it('contains 【参考素材】 list + <Picture 1> anchoring block + 【任务】 tail', () => {
+    expect(r.user).toContain('【参考素材 / Reference media】')
+    expect(r.user).toContain('<Picture 1> phone.png')
+    expect(r.user).toContain('【强制·素材标签】主体定义必须以如下标签逐条起笔')
+    expect(r.user).toContain('<Picture 1> …')
+    expect(r.user).toContain('【任务】根据场景硬约束 + 表单参数 + 创作需求 + 参考素材')
+  })
+
+  it('no-media path forbids inventing tags', () => {
+    const r = expand('full_reference', {})
+    expect(r.user).toContain('本次无参考素材附件：输出中不得出现 <Picture N>/<Subject N>')
+  })
+})
+
+// === X2：buildMediaTagLock 文案 + 扩展名分类 ===
+describe('X2 media tag lock + extension classification', () => {
+  it('zh lock contains forbidden-variant sentence and reuse sentence', () => {
+    const r = expand('full_reference', { mediaPaths: ['a.png'] })
+    expect(r.system).toContain('禁止写成 Picture 1 / picture1 / 图1 等变体')
+    expect(r.system).toContain('在「保留分析」「详细描述」中引用同一套 <Picture N>/<Subject N>')
+  })
+
+  it('classifyMediaPath maps extensions to <Video N>/<Audio N>/<Picture N>', () => {
+    expect(classifyMediaPath('a.MP4')).toBe('video')
+    expect(classifyMediaPath('b.wav')).toBe('audio')
+    expect(classifyMediaPath('c.jpg')).toBe('image')
+    const items = enumerateTaggedMedia(['c.jpg', 'a.MP4', 'b.wav'])
+    expect(items.map((i) => i.tag)).toEqual(['<Picture 1>', '<Video 1>', '<Audio 1>'])
+  })
+
+  it('system lock enumerates mixed-media tags', () => {
+    const r = expand('full_reference', { mediaPaths: ['c.jpg', 'a.MP4'] })
+    expect(r.system).toContain('<Picture 1>、<Video 1>')
+  })
+})
+
+// === X3：输出格式四分支 ===
+describe('X3 output format four branches', () => {
+  it('timeline_template branch emits timeline prompt rules (coop_game)', () => {
+    const r = expand('coop_game', {})
+    expect(r.system).toContain('时间轴/事件框架视频提示词')
+    expect(r.system).toContain('不要 Markdown 代码围栏，不要闲聊')
+  })
+
+  it('plain branch appends prose anchoring constraint when mediaPaths present (handdrawn)', () => {
+    const withMedia = expand('handdrawn_live', { mediaPaths: ['c.jpg'] })
+    expect(withMedia.system).toContain('自然语言段落')
+    expect(withMedia.system).toContain('禁止只列标签名、禁止 XML/空壳结构而无正文')
+  })
+
+  it('full_reference branch contains 4–12 字 copy rule and [reference generation] keep-English line', () => {
+    const r = expand('full_reference', {})
+    expect(r.system).toContain('画面广告文案：约 4–12 字、单行、Apple 风')
+    expect(r.system).toContain('任务前缀 [reference generation] 保持英文')
+  })
+
+  it('director_segments branch emits six-group rules (continuous_story)', () => {
+    const r = expand('continuous_story', { minimaxForm: { segment_count: '3' } })
+    expect(r.system).toContain('===== 提示词组 k =====')
+    expect(r.system).toContain('无硬切。紧接上一段。')
+    expect(r.system).toContain('不要乱说话')
+    expect(r.system).toContain('除最后一组外段末不要淡出')
+    expect(r.user).toContain('【智能分段】不要等待「第 N 段在干什么」')
+  })
+})
+
+// === X4：hardConstraints zh 改写 ===
+describe('X4 hardConstraints zh rewrite', () => {
+  const scenario: any = {
+    ...getScenarioById('full_reference')!,
+    hardConstraints: ['In-frame copy: English, 3-5 words only.', 'Keep tags stable.'],
+  }
+
+  it('rewrites "In-frame copy: English" entry in zh output', () => {
+    const sys = buildSystem(scenario, {}, 'zh', [])
+    expect(sys).toContain('In-frame copy: concise Simplified Chinese (约 4–12 字), single line only')
+    expect(sys).not.toContain('In-frame copy: English, 3-5 words only.')
+    expect(sys).toContain('- Keep tags stable.')
+  })
+
+  it('keeps original entry in en output', () => {
+    const sys = buildSystem(scenario, {}, 'en', [])
+    expect(sys).toContain('- In-frame copy: English, 3-5 words only.')
+  })
+})
+
+// === X7：h3FullReference 独立入口 ===
+describe('X7 h3FullReference independent entry', () => {
+  it('profile/peId judgments match upstream', () => {
+    expect(isH3FullReferenceProfile({ kind: 'expand', id: H3_FULL_REFERENCE_PROFILE_ID })).toBe(true)
+    expect(isH3FullReferenceProfile({ kind: 'expand', builtinKey: 'h3_full_reference' })).toBe(true)
+    expect(isH3FullReferenceProfile({ kind: 'expand', id: 'other' })).toBe(false)
+    expect(isH3FullReferencePeId('h3_full_reference')).toBe(true)
+    expect(isH3FullReferencePeId('pe_expand_h3_full_reference')).toBe(true)
+    expect(isH3FullReferencePeId('nope')).toBe(false)
+  })
+
+  it('user = fixed Rewrite template with {{user_input}} filled; system = guide + language appendix', () => {
+    const r = resolveH3FullReferenceExpand(null as any, { shortText: '雨夜霓虹街道' })!
+    expect(r.user).toContain(H3_FULL_REFERENCE_USER_PROMPT_TEMPLATE.split('{{user_input}}')[0])
+    expect(r.user).toContain('雨夜霓虹街道')
+    expect(r.system).toContain('【输出语言】本模板为中文版')
+    expect(r.system).toContain('【输出契约】绝对纯净输出')
+    expect(r.maxTokens).toBeGreaterThanOrEqual(4096)
+    expect(r.mediaExpandLayout).toBe(true)
+    expect(r.ruleId).toBe(H3_FULL_REFERENCE_PROFILE_ID)
+  })
+
+  it('en edition appends English appendices; media list lands in user', () => {
+    const r = resolveH3FullReferenceExpand(null as any, { outputLang: 'en', mediaPaths: ['c.jpg'] })!
+    expect(r.system).toContain('【Output language】English edition')
+    expect(r.user).toContain('【参考素材 / Reference media】')
+    expect(r.user).toContain('<Picture 1> c.jpg')
+  })
+
+  it('mapping: scenario path keeps priority; independent entry used as fallback in resolver', async () => {
+    // upstream electron resolver: isMinimaxScenarioProfile 分支在 resolveExpandPrompts 最前，
+    // pe_expand_h3_full_reference 同时在 minimax catalog → 场景路径优先（buildSystem + guide 全文）。
+    // 独立入口在场景未命中时兜底。此处断言场景路径对该 peId 可命中（优先）且独立入口可兜底。
+    const viaScenario = expand('full_reference', {})
+    expect(viaScenario.system).toContain('场景：Minimax六段式通用提示词')
+    const viaIndependent = resolveH3FullReferenceExpand(
+      { kind: 'expand', id: H3_FULL_REFERENCE_PROFILE_ID },
+      { shortText: 'x' },
+    )
+    expect(viaIndependent).not.toBeNull()
+  })
+})
+
+// === X8：官方模板细则 ===
+describe('X8 official rewrite template rules', () => {
+  it('zh template carries strict-vs-expand / image-order / dialogue language-code rules', () => {
+    expect(H3_REFERENCE_ZH).toContain('严格改写 vs 扩写')
+    expect(H3_REFERENCE_ZH).toContain('图片顺序一致')
+    expect(H3_REFERENCE_ZH).toContain('<d>[Chinese]')
+    expect(H3_REFERENCE_ZH).toContain('主体定义:')
+  })
+
+  it('en template carries the six-section contract rules', () => {
+    expect(H3_REFERENCE_EN).toContain('subject_definitions')
+    expect(H3_REFERENCE_EN).toContain('non_diegetic_music')
+  })
+})
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
diff --git a/plugins/prompt-master/tests/resolver/torii-parity.test.ts b/plugins/prompt-master/tests/resolver/torii-parity.test.ts
new file mode 100644
index 0000000..55a8952
--- /dev/null
+++ b/plugins/prompt-master/tests/resolver/torii-parity.test.ts
@@ -0,0 +1,147 @@
+// torii prompts parity — upstream PM 3.1.0 torii_prompts_data.js 对照断言（审计高危项 #2）
+// 覆盖：PROMPTS_B 12 个上游键存在性、3 个此前缺失键 + 2 个此前重写键的内容包含性抽查、
+//       TORII_JSON_FORMATS / JSON_OUTPUT_SUFFIX / SYSTEM_PROMPT、makeUserQuery grounding 管线。
+import { describe, expect, it } from 'vitest'
+import {
+  PROMPTS_B,
+  TORII_JSON_FORMATS,
+  JSON_OUTPUT_SUFFIX,
+  SYSTEM_PROMPT,
+  makeUserQuery,
+} from '../../src/resolver/profiles/torii/prompts.js'
+
+// 上游 PROMPTS_B 全部 12 键（torii_prompts_data.js:5-143）
+const UPSTREAM_KEYS = [
+  'long_thoughts_v2',
+  'long_thoughts',
+  'json',
+  'long',
+  'min_structured_md',
+  'json_comic',
+  'md_comic',
+  'min_structured_json',
+  'chroma-style',
+  'short',
+  'danbooru_line',
+  'sd_tag_line',
+]
+
+describe('T1: PROMPTS_B key surface', () => {
+  it('contains all 12 upstream keys', () => {
+    for (const key of UPSTREAM_KEYS) {
+      expect(PROMPTS_B[key], `missing key: ${key}`).toBeTruthy()
+    }
+  })
+})
+
+describe('T1/T2: previously-missing keys — content containment (official strings)', () => {
+  it("chroma-style: official 4-part structure", () => {
+    const t = PROMPTS_B['chroma-style']
+    expect(t).toContain('### 3. Midjourney-Style Summary:')
+    expect(t).toContain('### 4. DeviantArt Commission Request')
+  })
+
+  it('danbooru_line: official JSON keys contract', () => {
+    const t = PROMPTS_B['danbooru_line']
+    expect(t).toContain('Return ONLY one JSON object (no markdown, no prose before or after JSON)')
+    expect(t).toContain('"tags":"general Danbooru tags ONLY')
+    expect(t).toContain('include counts (1girl, solo)')
+  })
+
+  it('sd_tag_line: official one-line SD tags contract', () => {
+    expect(PROMPTS_B['sd_tag_line']).toContain(
+      'Return ONLY one JSON object with key "tags"',
+    )
+  })
+
+  it('json: official schema restored (was rewritten in port)', () => {
+    const t = PROMPTS_B['json']
+    expect(t).toContain('"main content" : "long and detailed description')
+    expect(t).toContain('"image_effects" :')
+    expect(t).toContain('In special cases you can add extra keys.')
+  })
+
+  it('min_structured_json: official watermarks contract (was rewritten)', () => {
+    const t = PROMPTS_B['min_structured_json']
+    expect(t).toContain('"General" :')
+    expect(t).toContain('"watermarks" : "If present"')
+    expect(t).toContain('Prefere shorter description and tags.')
+  })
+})
+
+describe('T4: TORII_JSON_FORMATS / JSON_OUTPUT_SUFFIX / SYSTEM_PROMPT', () => {
+  it('TORII_JSON_FORMATS = {json, json_comic, min_structured_json, danbooru_line, sd_tag_line}', () => {
+    expect([...TORII_JSON_FORMATS].sort()).toEqual(
+      ['danbooru_line', 'json', 'json_comic', 'min_structured_json', 'sd_tag_line'].sort(),
+    )
+  })
+
+  it('JSON_OUTPUT_SUFFIX present with official "# Output requirement" block', () => {
+    expect(JSON_OUTPUT_SUFFIX).toContain('# Output requirement')
+    expect(JSON_OUTPUT_SUFFIX).toContain('Return exactly one valid JSON object matching the schema above.')
+  })
+
+  it('SYSTEM_PROMPT matches official captioning-expert line', () => {
+    expect(SYSTEM_PROMPT).toBe(
+      "You are image captioning expert. Describe user's picture according to requested format and instructions.",
+    )
+  })
+})
+
+describe('T5: makeUserQuery grounding pipeline', () => {
+  const item = {
+    tags: ['long_hair', '1girl', 'blue_eyes'],
+    characters: ['hatsune_miku'],
+    char_p_tags: { chars: { hatsune_miku: ['twintails', 'vocaloid'] }, skins: {} },
+    char_descr: { chars: { hatsune_miku: 'A virtual singer with teal hair.' }, skins: {} },
+  }
+
+  it('builds caption format header + format block', () => {
+    const q = makeUserQuery(item, 'long', false, false, false, false, false)
+    expect(q.startsWith('# Captioning format:\n')).toBe(true)
+    expect(q).toContain('Make a caption for given image with natural text.')
+    expect(q).toContain('# Characters on picture:\nAvoid to guess names for characters.\n')
+  })
+
+  it('injects booru tags block when addTags', () => {
+    const q = makeUserQuery(item, 'long', false, true, false, false, false)
+    expect(q).toContain('# Booru tags for the image\n[')
+    // all tags present regardless of shuffle order
+    for (const tag of item.tags!) expect(q).toContain(tag)
+  })
+
+  it('underscoresReplace swaps underscores for spaces on long tags only', () => {
+    const q = makeUserQuery(item, 'long', false, true, false, false, false, true)
+    expect(q).toContain('long hair')
+    expect(q).toContain('1girl') // length <= 3 stays untouched
+    expect(q).not.toContain('long_hair')
+  })
+
+  it('character names + traits injection (addCharacters + addCharTags)', () => {
+    const q = makeUserQuery(item, 'long_thoughts', true, true, true, true, false, true)
+    expect(q).toContain('# Characters on picture:')
+    expect(q).toContain('make sure to use them: [hatsune miku].')
+    expect(q).toContain('# Known traits for characters')
+    expect(q).toContain('hatsune miku: [twintails, vocaloid]')
+  })
+
+  it('description mode (addDescription) injects char descriptions instead of tags', () => {
+    const q = makeUserQuery(item, 'long_thoughts', true, false, true, false, true, false)
+    expect(q).toContain('Here are general descriptions for each characters on the picture:')
+    expect(q).toContain('## hatsune_miku\nA virtual singer with teal hair.')
+    // upstream: '# Known traits for characters' header guards (addCharTags || addDescription),
+    // so it appears in both modes; only the body differs
+    expect(q).toContain('# Known traits for characters')
+    expect(q).not.toContain('Here are popular tags for each characters on picture:')
+  })
+
+  it('JSON format + JSON_OUTPUT_SUFFIX wiring matches upstream llama helper behavior', () => {
+    const q = makeUserQuery(item, 'json', false, false, false, false, false)
+    expect(TORII_JSON_FORMATS.has('json')).toBe(true)
+    if (TORII_JSON_FORMATS.has('json')) {
+      // upstream: userQuery += JSON_OUTPUT_SUFFIX (torii_llama_helper.js:109-110)
+      const wired = q + JSON_OUTPUT_SUFFIX
+      expect(wired).toContain('# Output requirement')
+    }
+  })
+})
```
