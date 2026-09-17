# Review package - 074cd4d..def5c53

## Commits
``````

## Stat
``` .../src/pe-framework/sanitize/joy-extra.ts         | 248 +++++++++++++++++++++
 plugins/prompt-master/src/tools/prompt-author.ts   |  29 ++-
 plugins/prompt-master/src/tools/prompt-reverse.ts  |  26 ++-
 .../tests/pe-framework/sanitize/joy-extra.test.ts  |  62 ++++++
 4 files changed, 359 insertions(+), 6 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/sanitize/joy-extra.ts b/plugins/prompt-master/src/pe-framework/sanitize/joy-extra.ts
new file mode 100644
index 0000000..c23a608
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/sanitize/joy-extra.ts
@@ -0,0 +1,248 @@
+/**
+ * JoyExtra 三段式硬约束（移植自 PromptMaster joyCaption extra-option 系统）：
+ * 1) resolveJoyExtraOptions —— 显式数组 > 标准句嗅探（extra_prompt），解析 character_name
+ * 2) buildJoyExtraSystemBlock / buildJoyExtraUserTail —— prompt 侧注入（优先级声明 + 冲突仲裁）
+ * 3) filterJoyExtraClauses —— 输出侧子句过滤（防灭绝兜底：全被滤掉 → 返回原文）
+ *
+ * 纯函数模块：零日志、零 IO（工具层负责日志）。
+ * 标准句逐字移植自 temp/pm-promptmaster-src .../joyCaptionExtraOptions.js.deob.js；
+ * 子句切分/过滤正则移植自 captionExtraOptionSanitize.js.deob.js（裁掉生僻条目）。
+ */
+
+export type JoyExtraOptionId =
+  | 'no_glasses_headwear'
+  | 'scene_only_no_character_appearance'
+  | 'no_artistic_style'
+  | 'character_name'
+
+export interface JoyExtraResolution {
+  options: JoyExtraOptionId[]
+  characterName?: string
+}
+
+/* ── 标准句（PromptMaster deob 逐字移植，嗅探 + 展示共用）── */
+
+export const JOY_SCENE_ONLY_NO_CHARACTER_APPEARANCE_EN =
+  'Do NOT describe any character appearance traits or clothing. Do not write any visible physical appearance features—such as face, facial features, body, skin, hair, body shape, or similar traits—or any garments, outfits, or clothing items.'
+export const JOY_NO_GLASSES_HEADWEAR_EN =
+  'Do NOT describe any glasses, goggles, eyewear, sunglasses, or headwear on the person/character (including hats, helmets, headbands, crowns, and hair accessories worn on the head).'
+export const JOY_NO_ARTISTIC_STYLE_EN =
+  'Do NOT describe artistic style, rendering style, image medium, quality tags, aesthetic terms, or visual style labels. Do not mention anime, cartoon, realistic, painting, illustration, 3D render, cinematic, digital art, concept art, or similar style-related terms.'
+
+/* ── 选项注册表：标准句 + 嗅探正则 + 中文变体 ── */
+
+interface JoyExtraOptionDef {
+  id: JoyExtraOptionId
+  en: string
+  zh: string
+  sniff: RegExp[]
+}
+
+const OPTION_DEFS: JoyExtraOptionDef[] = [
+  {
+    id: 'no_glasses_headwear',
+    en: JOY_NO_GLASSES_HEADWEAR_EN,
+    zh: '不要写眼镜/头饰：即使画面中有眼镜、面饰或任何头戴物，也必须完全省略，不得提及。',
+    sniff: [
+      /Do NOT describe any glasses, goggles, eyewear/i,
+      /Do not mention glasses/i,
+      /不要(?:写|提|提及|描述).{0,6}(?:眼镜|头饰|帽子)/,
+    ],
+  },
+  {
+    id: 'scene_only_no_character_appearance',
+    en: JOY_SCENE_ONLY_NO_CHARACTER_APPEARANCE_EN,
+    zh: '只写场景，不写任何角色外貌或服装：面部、五官、身体、皮肤、头发、体型及一切衣着类描述都必须省略。',
+    sniff: [
+      /Do NOT describe any character appearance traits or clothing/i,
+      /Do NOT describe any character appearance or clothing/i,
+      /Do not describe any character appearance/i,
+      /只写场景.{0,8}不写.{0,10}(?:外貌|外观|长相)/,
+    ],
+  },
+  {
+    id: 'no_artistic_style',
+    en: JOY_NO_ARTISTIC_STYLE_EN,
+    zh: '不要写艺术风格：不提及画风、渲染风格、媒介、质量词或任何风格标签（anime/cartoon/realistic/painting 等）。',
+    sniff: [
+      /Do NOT describe artistic style/i,
+      /不要(?:写|提|提及|描述).{0,6}(?:画风|艺术风格|风格)/,
+    ],
+  },
+  {
+    id: 'character_name',
+    en: 'Refer to the person/character by the given name only; do not invent or mention any other name.',
+    zh: '用指定名字称呼该角色；不要提及或杜撰其他名字。',
+    sniff: [/refer to them as/i, /(?:称呼|称作|名叫)为?["'「『]?[\w\u4e00-\u9fff]+["'」』]?/],
+  },
+]
+
+const OPTION_BY_ID = new Map(OPTION_DEFS.map((d) => [d.id, d]))
+
+const CHARACTER_NAME_SNIFF = /refer to them as ([A-Za-z0-9_\u4e00-\u9fff]+)/i
+
+/* ── resolve ── */
+
+function asStringArray(v: unknown): string[] {
+  if (!Array.isArray(v)) return []
+  return v.map((x) => String(x ?? '').trim()).filter(Boolean)
+}
+
+export function resolveJoyExtraOptions(input: {
+  joyExtraOptions?: unknown
+  extraPrompt?: string
+  characterName?: unknown
+}): JoyExtraResolution {
+  const explicit = asStringArray(input.joyExtraOptions)
+  const options: JoyExtraOptionId[] = []
+  for (const id of explicit) if (OPTION_BY_ID.has(id as JoyExtraOptionId)) options.push(id as JoyExtraOptionId)
+
+  const extraPrompt = String(input.extraPrompt ?? '')
+  if (extraPrompt.trim()) {
+    for (const def of OPTION_DEFS) {
+      if (options.includes(def.id)) continue
+      if (def.id !== 'character_name' && extraPrompt.includes(def.en)) { options.push(def.id); continue }
+      if (def.sniff.some((re) => re.test(extraPrompt))) options.push(def.id)
+    }
+  }
+
+  let characterName = String(input.characterName ?? '').trim()
+  if (!characterName && extraPrompt) {
+    const m = extraPrompt.match(CHARACTER_NAME_SNIFF)
+    if (m) characterName = m[1].trim()
+  }
+  const res: JoyExtraResolution = { options }
+  if (characterName) res.characterName = characterName
+  return res
+}
+
+/* ── prompt 注入 ── */
+
+/** 冲突仲裁：scene_only（更高优先级）生效时，覆盖 no_glasses_headwear 的"不可变属性"分支表述 */
+function pledgeLines(res: JoyExtraResolution, lang: 'zh' | 'en'): string[] {
+  const sceneOnly = res.options.includes('scene_only_no_character_appearance')
+  return res.options
+    .filter((id) => id !== 'character_name' || res.characterName)
+    .map((id) => {
+      const def = OPTION_BY_ID.get(id)
+      if (!def) return ''
+      if (lang === 'en') return `- ${sceneOnly && id === 'no_glasses_headwear' ? def.en + ' (subsumed by the scene-only rule above; obey the stricter one.)' : def.en}`
+      return `- ${sceneOnly && id === 'no_glasses_headwear' ? def.zh + '（已被上文"只写场景"规则覆盖，以更严格者为准。）' : def.zh}`
+    })
+    .filter(Boolean)
+}
+
+export function buildJoyExtraSystemBlock(res: JoyExtraResolution, outputLang: 'zh' | 'en'): string {
+  if (res.options.length === 0) return ''
+  const pledges = pledgeLines(res, outputLang)
+  const priority =
+    outputLang === 'en'
+      ? 'These are HARD CONSTRAINTS and take priority over any checklist, style guide, or earlier instruction: every listed exclusion must be fully omitted from the output.'
+      : '以下是硬约束，优先级高于任何检查表、风格指南或前文指令：所列每一项禁写内容都必须在输出中完全省略。'
+  const nameLine =
+    res.characterName
+      ? outputLang === 'en'
+        ? `- Refer to the person/character strictly as "${res.characterName}".`
+        : `- 严格以"${res.characterName}"称呼该角色。`
+      : ''
+  const conflict =
+    outputLang === 'en'
+      ? 'Conflict override: when two rules overlap, the stricter (broader exclusion) wins; a forbidden trait must never appear, even if another instruction asks for it.'
+      : '冲突仲裁：两条规则重叠时以更严格（覆盖面更广）者为准；被禁特征即使其他指令要求也绝不得出现。'
+  return ['[JoyExtra Hard Constraints]', priority, ...pledges, nameLine, conflict].filter(Boolean).join('\n')
+}
+
+export function buildJoyExtraUserTail(res: JoyExtraResolution, outputLang: 'zh' | 'en'): string {
+  if (res.options.length === 0) return ''
+  const head =
+    outputLang === 'en'
+      ? 'Reminder (hard constraints): do NOT write anything forbidden by the options below.'
+      : '再次提醒（硬约束）：输出中不得出现下列选项禁止的任何内容。'
+  const lines = pledgeLines(res, outputLang)
+  const nameLine = res.characterName
+    ? outputLang === 'en'
+      ? `- Name: ${res.characterName}.`
+      : `- 名字：${res.characterName}。`
+    : ''
+  return [head, ...lines, nameLine].filter(Boolean).join('\n')
+}
+
+/* ── 输出侧子句过滤（captionExtraOptionSanitize 移植）── */
+
+/** 中文/英文通用：眼镜·头饰类子句模式（deob 版裁剪 + 英文词集补充） */
+const GLASSES_HEADWEAR_CLAUSE_PATTERNS: RegExp[] = [
+  /眼镜/u, /护目镜/u, /墨镜/u, /太阳镜/u, /镜框/u, /目镜/u,
+  /头戴.*镜/u, /佩戴.*镜/u,
+  /头饰/u, /发饰/u, /发箍/u, /头箍/u, /头带/u, /发带/u,
+  /(?:鸭舌|棒球|贝雷|礼|安全|针织)?帽/u,
+  /头盔/u, /皇冠/u, /王冠/u, /头冠/u, /面罩/u, /头套/u,
+  /\b(?:glasses|goggles|sunglasses|eyewear)\b/i,
+  /\b(?:beret|hat|helmet|headband|crown|headwear)\b/i,
+]
+
+/** 外貌·服装类子句模式（deob 版核心条目；scene_only 选项使用） */
+const APPEARANCE_CLOTHING_CLAUSE_PATTERNS: RegExp[] = [
+  /皮肤/u, /肤色/u, /肤质/u, /斑(?:块|纹|点)/u, /胎记/u, /疤痕/u, /痣/u, /胡须/u,
+  /妆容/u, /五官/u, /面部特征/u, /脸型/u,
+  /发型/u, /头发/u, /发丝/u, /刘海/u,
+  /服装/u, /衣着/u, /穿着/u, /身穿/u, /上衣/u, /下装/u,
+  /裤子/u, /裙子/u, /连衣裙/u, /外套/u, /大衣/u,
+  /鞋/u, /靴/u, /袜/u, /衣料/u, /布料/u,
+  /体型/u, /身材/u,
+  /\b(?:skin|complexion|freckle|mole|scar|birthmark)\b/i,
+  /\b(?:hair|hairstyle|bangs|beard|mustache|facial features?)\b/i,
+  /\b(?:shirt|pants|dress|skirt|outfit|garment|clothing|jacket|shoes?|boots?)\b/i,
+]
+
+/** 艺术风格类子句模式（no_artistic_style 选项使用；核心词集） */
+const ARTISTIC_STYLE_CLAUSE_PATTERNS: RegExp[] = [
+  /画风/u, /艺术风格/u, /风格化/u, /渲染风格/u, /质量词/u,
+  /\b(?:anime|cartoon|realistic|painting|illustration|cinematic|digital art|concept art|3d render)\b/i,
+]
+
+/** 按分隔符切子句（deob 版同款字符类），去空并 trim */
+function splitClauses(text: string): string[] {
+  return String(text ?? '')
+    .split(/[，,、；;。．.!！?？\n]+/u)
+    .map((c) => c.trim())
+    .filter(Boolean)
+}
+
+/** 原文分隔符风格探测（deob 版同款：中文逗号 > 顿号 > 分号 > 英文逗号+空格） */
+function pickClauseSeparator(text: string): string {
+  if (text.includes('，')) return '，'
+  if (text.includes('、')) return '、'
+  if (text.includes(';')) return '; '
+  return ', '
+}
+
+function clauseMatches(clause: string, patterns: RegExp[]): boolean {
+  const c = clause.trim()
+  if (!c) return false
+  return patterns.some((re) => re.test(c))
+}
+
+function patternsForOptions(options: JoyExtraOptionId[]): RegExp[] {
+  const patterns: RegExp[] = []
+  if (options.includes('no_glasses_headwear')) patterns.push(...GLASSES_HEADWEAR_CLAUSE_PATTERNS)
+  if (options.includes('scene_only_no_character_appearance')) patterns.push(...APPEARANCE_CLOTHING_CLAUSE_PATTERNS)
+  if (options.includes('no_artistic_style')) patterns.push(...ARTISTIC_STYLE_CLAUSE_PATTERNS)
+  return patterns
+}
+
+/**
+ * 子句过滤：命中任一启用选项的正则组 → 剔除该子句；
+ * 拼回时按原文分隔符风格（pickClauseSeparator）逐一还原；
+ * 防灭绝兜底：全部子句被剔除 → 返回原文。
+ */
+export function filterJoyExtraClauses(text: string, res: JoyExtraResolution): string {
+  const src = String(text ?? '').trim()
+  if (!src) return src
+  const patterns = patternsForOptions(res.options)
+  if (patterns.length === 0) return src
+  const clauses = splitClauses(src)
+  if (clauses.length === 0) return src
+  const kept = clauses.filter((c) => !clauseMatches(c, patterns))
+  if (kept.length === 0) return src // anti-extinction
+  return kept.join(pickClauseSeparator(src))
+}
diff --git a/plugins/prompt-master/src/tools/prompt-author.ts b/plugins/prompt-master/src/tools/prompt-author.ts
index f16d107..47672f1 100644
--- a/plugins/prompt-master/src/tools/prompt-author.ts
+++ b/plugins/prompt-master/src/tools/prompt-author.ts
@@ -8,20 +8,21 @@ import '../pe-framework/dialect/h3.js'
 import { isDialectReady as registryIsDialectReady, getDialect } from '../pe-framework/dialect/registry.js'
 import { runStage } from '../pe-framework/pipeline/runStage.js'
 import { assembleEnvelope } from '../pe-framework/render/envelope.js'
 import type { StageResult } from '../pe-framework/pipeline/types.js'
 import { sceneToShotsChecked } from '../pe-framework/schema/scenes.js'
 import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 import { complete } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
+import { resolveJoyExtraOptions, filterJoyExtraClauses } from '../pe-framework/sanitize/joy-extra.js'
 
 export interface AuthorArgs {
   target: Target
   input: string
   profile?: string
   variant?: string
   stage?: string
   scenario_id?: string
   form_fields?: Record<string, unknown>
   audit_only?: boolean
@@ -147,20 +148,42 @@ function applyScenarioGates(stage: StageResult, opts: { scenarioId?: string; for
   }
 }
 
 /** draft → runStage → applyScenarioGates（author 每轮统一入口；audit 不通过不在此处理——闭环在 execute） */
 function runDraftThroughStage(target: string, draft: AuthorDraft, opts: { stage?: string; scenarioId?: string; formFields?: Record<string, unknown>; variant?: string }): StageResult {
   const input = normalizeDraftToInput(target, draft, opts)
   const stageResult = runStage({ target: target as Target, ...input })
   return applyScenarioGates(stageResult, { scenarioId: opts.scenarioId, formFields: opts.formFields, refsCount: referencesCount(draft, opts.formFields) })
 }
 
+/**
+ * JoyExtra 硬约束输出过滤（Task 4，anima 分支）：form_fields.joy_extra_options 声明的禁写项
+ * 在 compileAnima 产物 positive/negative 上做子句过滤（复核兜底，硬约束优先级高于检查表）。
+ * 返回 true 表示发生了实际剔除。
+ */
+function applyAnimaJoyExtraFilter(stage: StageResult, formFields?: Record<string, unknown>): boolean {
+  if (!formFields) return false
+  const res = resolveJoyExtraOptions({ joyExtraOptions: formFields.joy_extra_options, extraPrompt: '' })
+  if (res.options.length === 0) return false
+  let filtered = false
+  for (const key of ['positive', 'negative'] as const) {
+    const text = stage.result[key]
+    if (typeof text !== 'string' || !text.trim()) continue
+    const out = filterJoyExtraClauses(text, res)
+    if (out !== text) {
+      stage.result[key] = out
+      filtered = true
+    }
+  }
+  return filtered
+}
+
 export function registerAuthorTool(ctx: Context, config: Config) {
   return defineTool({
     name: 'prompt_author',
     description:
       '统一提示词工程主入口（全链路编排）：输入创作意图 → intent（LLM 拆结构）→ schema → dialect（compileAnima/compileH3）→ audit → Envelope + target_slot_hint；audit 未过且有 Critical 时自动修正重跑（max 2 次，仍失败置 loop_exhausted）。当前归化状态：' +
       TARGETS.map((t) => `${t}=${isDialectReady(t) ? 'ready' : 'pending'}`).join(' ') +
       '；sd/generic 报 DIALECT_NOT_AVAILABLE。',
     parameters: {
       target: { type: 'string', description: '目标方言：anima | h3 | sd | generic', default: 'anima' },
       input: { type: 'string', description: '创作意图（一句话/图描述/分镜素材）' },
@@ -202,36 +225,40 @@ export function registerAuthorTool(ctx: Context, config: Config) {
       // audit_only：不调 LLM，把 input 当结构 JSON（原语义：完整编译+审计，result 照常产出——不用内核 auditOnly 标志）
       if (a.audit_only === true) {
         let draft: AuthorDraft
         try {
           const parsed = JSON.parse(input) as Record<string, unknown>
           draft = target === 'anima' ? { slots: parsed as unknown as AnimaSlots } : { shots: parsed as unknown as H3ShotsInput }
         } catch {
           throw new Error('audit_only 需要结构化 JSON 输入（anima: slots；h3: shots{...}）')
         }
         const stage = runDraftThroughStage(target, draft, runOpts)
+        if (target === 'anima') applyAnimaJoyExtraFilter(stage, a.form_fields)
         return assembleEnvelope(stage, [])
       }
 
       const provider = _intentProvider ?? ((req: AuthorIntentRequest, exec2?: ExecLike) => defaultIntent(ctx, resolveRoute((exec2 ?? exec) as ExecLike), req))
       // Task 7：intent persona/schema 方言化——从 dialect 注册表取（ANIMA_*/H3_* 常量），未注册则 undefined → provider 内 DEFAULT 兜底
       const intentCfg = getDialect(target)?.intent
       const intentBase = { target, input, variant: a.variant, scenarioId, formFields: a.form_fields, persona: intentCfg?.persona, schema: intentCfg?.schema }
       ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author target=${target}${a.variant ? ` variant=${a.variant}` : ''}${a.stage ? ` stage=${a.stage}` : ''}`)
+      let joyExtraFiltered = false
       let draft = await provider({ ...intentBase, round: 0 }, exec)
       let stage = runDraftThroughStage(target, draft, runOpts)
+      if (target === 'anima') joyExtraFiltered = applyAnimaJoyExtraFilter(stage, a.form_fields) || joyExtraFiltered
       const trailAdvisories: string[] = []
       let corrections = 0
       while (!stage.ok && stage.gates.some((g) => g.severity === 'critical') && corrections < MAX_CORRECTIONS) {
         corrections++
         const feedback = stage.gates.filter((g) => g.severity === 'critical').map((g) => `[${g.rule}] ${g.detail}`).join('\n')
         draft = await provider({ ...intentBase, round: corrections, feedback }, exec)
         stage = runDraftThroughStage(target, draft, runOpts)
+        if (target === 'anima') joyExtraFiltered = applyAnimaJoyExtraFilter(stage, a.form_fields) || joyExtraFiltered
       }
       if (!stage.ok && stage.gates.some((g) => g.severity === 'critical')) {
         trailAdvisories.push('loop_exhausted:true')
       }
-      ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
+      ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} joy_extra filtered=${joyExtraFiltered ? 'yes' : 'no'} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
       return assembleEnvelope(stage, trailAdvisories)
     },
   })
 }
diff --git a/plugins/prompt-master/src/tools/prompt-reverse.ts b/plugins/prompt-master/src/tools/prompt-reverse.ts
index 1957add..79d1e42 100644
--- a/plugins/prompt-master/src/tools/prompt-reverse.ts
+++ b/plugins/prompt-master/src/tools/prompt-reverse.ts
@@ -1,27 +1,30 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
 import type { ContentBlock, ImageBlock, UserMessage } from '@deepseek-ai/dsh-llm'
 import { resolveReverse } from '../resolver/index.js'
 import { findProfileById } from '../resolver/profiles/index.js'
 import { sanitizeFinalCaption } from '../resolver/profiles/reverse/router.js'
 import { completeWithBlocks } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
 import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js'
+import { resolveJoyExtraOptions, buildJoyExtraSystemBlock, buildJoyExtraUserTail, filterJoyExtraClauses } from '../pe-framework/sanitize/joy-extra.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 
 export interface ReverseArgs {
   image_description?: string
   profile?: string
   output_lang?: string
   length?: string
   extra_prompt?: string
+  joy_extra_options?: string[]
+  character_name?: string
   anima3_enhance?: boolean
   quality_prompt_enabled?: boolean
   quality_prompt_prefix?: string
   media_target?: string
   dry_run?: boolean
 }
 
 /** 反向找最近一个 'user/message' 事件中的全部 image block */
 export async function collectRecentImages(exec: ToolRunContext): Promise<ImageBlock[]> {
   const events = (exec.agent as any)?.session?.events
@@ -41,20 +44,22 @@ export async function collectRecentImages(exec: ToolRunContext): Promise<ImageBl
 export function registerReverseTool(ctx: Context, config: Config) {
   return defineTool({
     name: 'prompt_reverse',
     description: '根据图片描述（或会话中的图片附件）反推生成可直接用于 AI 绘图的提示词。output_lang/length/profile 决定输出风格。可选 dry_run 查看组装结果而不调用模型。',
     parameters: {
       image_description: { type: 'string', description: '对画面的描述（必填；若会话最近有图片附件可省略，以图片为准）' },
       profile: { type: 'string', default: 'pe_reverse_descriptive', description: '反推 profile id：pe_reverse_descriptive / pe_reverse_sd / pe_reverse_danbooru 或自定义' },
       output_lang: { type: 'string', default: 'zh', description: '输出语言 zh/en' },
       length: { type: 'string', default: 'medium', description: '篇幅 short/medium/long' },
       extra_prompt: { type: 'string', default: '', description: '附加要求' },
+      joy_extra_options: { type: 'array', default: [], description: 'JoyExtra 硬约束选项（no_glasses_headwear / scene_only_no_character_appearance / no_artistic_style / character_name）；硬约束优先级高于检查表' },
+      character_name: { type: 'string', default: '', description: '角色称呼（配合 joy_extra_options=character_name 使用）' },
       anima3_enhance: { type: 'boolean', default: false, description: 'Anima3 增强' },
       quality_prompt_enabled: { type: 'boolean', default: false, description: '启用质量词前缀' },
       quality_prompt_prefix: { type: 'string', default: '', description: '自定义质量词前缀' },
       media_target: { type: 'string', default: 'image', description: 'image（默认，兼容现有）/ anima / h3——anima=产出可槽位化的丰富描述，h3=产出分镜素材' },
       dry_run: { type: 'boolean', default: false, description: '只返回组装好的 system/text/maxTokens，不调用模型' },
     },
     output: {
       schema: { type: 'string', description: '反推提示词正文；dry_run 时返回含 debug 的 JSON 字符串' },
       render: (_a, v) => [{ type: 'text', text: v }],
     },
@@ -67,32 +72,41 @@ export function registerReverseTool(ctx: Context, config: Config) {
       const profile = findProfileById(String(args.profile || 'pe_reverse_descriptive').trim())
       if (!profile) throw new Error(`Profile not found: ${String(args.profile || 'pe_reverse_descriptive')}`)
       logInfo(`[prompt-master] prompt_reverse profile=${profile.id} media_target=${String(args.media_target || 'image')} images=${images.length}${args.dry_run ? ' dry_run=true' : ''}`)
       const reverseResult = resolveReverse(profile, {
         caption_lang: String(args.output_lang || 'zh') as 'zh' | 'en' | 'auto',
         len: String(args.length || 'medium'),
         media_target: String(args.media_target || 'image') as 'image' | 'video',
         extra_prompt: String(args.extra_prompt || ''),
         anima3_enhance: args.anima3_enhance === true,
       })
-      const user = [reverseResult.userLead, reverseResult.userBody, reverseResult.outputConstraints, reverseResult.userTail]
+      const joyExtra = resolveJoyExtraOptions({
+        joyExtraOptions: args.joy_extra_options,
+        extraPrompt: String(args.extra_prompt || ''),
+        characterName: args.character_name,
+      })
+      const outputLang = (String(args.output_lang || 'zh') === 'en' ? 'en' : 'zh') as 'zh' | 'en'
+      const joySystemBlock = joyExtra.options.length > 0 ? buildJoyExtraSystemBlock(joyExtra, outputLang) : ''
+      const system = joySystemBlock ? `${reverseResult.system}\n\n${joySystemBlock}` : reverseResult.system
+      const joyUserTail = joyExtra.options.length > 0 ? buildJoyExtraUserTail(joyExtra, outputLang) : ''
+      const user = [reverseResult.userLead, reverseResult.userBody, reverseResult.outputConstraints, reverseResult.userTail, joyUserTail]
         .filter(Boolean).join('\n')
       // 文本路径修复：画面描述必须进入 LLM 上下文。user 是组装指令，desc 是用户对画面的描述；
       // user 开头非空时也要并入 desc，否则模型只收到指令、看不到画面内容（历史 bug：
       // builtin reverse profiles 四段拼接恒非空 → `user || desc` 永远取 user，desc 被静默丢弃）。
       const text = user
         ? (desc ? `${user}\n\n[${String(args.output_lang || 'zh') === 'en' ? 'Scene description' : '画面描述'}]\n${desc}` : user)
         : desc
       if (args.dry_run) {
         const debug = JSON.stringify({
           debug: {
-            system: reverseResult.system,
+            system,
             text,
             imageBlocks: images.length,
             maxTokens: 512,
           },
           profile_meta: { id: profile.id, name: profile.name, outputFormat: profile.outputFormat },
         })
         logInfo(`[prompt-master] prompt_reverse → ok=true dry_run=true chars=${debug.length}`)
         return debug
       }
       const { provider, model } = resolveRoute(exec as ExecLike)
@@ -103,29 +117,31 @@ export function registerReverseTool(ctx: Context, config: Config) {
         ...(text ? [{ type: 'text' as const, text }] : []),
       ]
       if (images.length > 0) {
         const info = await (ctx.llm as any).resolveModelInfo?.(provider, model, exec.signal)
         if (!info || !info.inputModalities?.includes('image')) {
           throw new Error(`当前模型 ${model} 不支持图片输入，请在 Web UI Settings→Models 切换到支持图片输入的模型（如 deepseek-v4-flash-vision-exp），或在参数中提供 image_description 文本描述`)
         }
       }
       const { text: raw } = await completeWithBlocks(ctx, {
         provider, model,
-        system: reverseResult.system,
+        system,
         blocks,
         maxTokens: 512,
         temperature: effectiveParams.temperature,
         signal: exec.signal,
       })
       const sanitized = sanitizeFinalCaption(raw, {
         type: reverseResult.captionType,
         caption_lang: String(args.output_lang || 'zh'),
         len: String(args.length || 'medium'),
         anima3_enhance: args.anima3_enhance === true,
         quality_prompt_enabled: args.quality_prompt_enabled === true,
         quality_prompt_prefix: String(args.quality_prompt_prefix || ''),
       })
-      logInfo(`[prompt-master] prompt_reverse → ok=true chars=${sanitized.length}`)
-      return sanitized
+      const joyFilteredBefore = sanitized
+      const finalCaption = joyExtra.options.length > 0 ? filterJoyExtraClauses(sanitized, joyExtra) : sanitized
+      logInfo(`[prompt-master] prompt_reverse → ok=true chars=${finalCaption.length} joy_extra options=${joyExtra.options.join('|') || 'none'} filtered=${finalCaption !== joyFilteredBefore ? 'yes' : 'no'}`)
+      return finalCaption
     },
   })
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/tests/pe-framework/sanitize/joy-extra.test.ts b/plugins/prompt-master/tests/pe-framework/sanitize/joy-extra.test.ts
new file mode 100644
index 0000000..737bec9
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/sanitize/joy-extra.test.ts
@@ -0,0 +1,62 @@
+import { describe, expect, it } from 'vitest'
+import { resolveJoyExtraOptions, buildJoyExtraSystemBlock, buildJoyExtraUserTail, filterJoyExtraClauses } from '../../../src/pe-framework/sanitize/joy-extra.js'
+
+describe('resolveJoyExtraOptions', () => {
+  it('array mode: explicit ids win', () => {
+    expect(resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] }).options).toContain('no_glasses_headwear')
+  })
+  it('text sniff mode: standard sentence in extra_prompt detected', () => {
+    const r = resolveJoyExtraOptions({ extraPrompt: 'Do not mention glasses, goggles, hats or any headwear.' })
+    expect(r.options).toContain('no_glasses_headwear')
+  })
+  it('character_name captured from param', () => {
+    const r = resolveJoyExtraOptions({ characterName: '小明' })
+    expect(r.characterName).toBe('小明')
+  })
+  it('character_name sniffed from refer-to pattern', () => {
+    const r = resolveJoyExtraOptions({ extraPrompt: 'refer to them as star_girl' })
+    expect(r.characterName).toBe('star_girl')
+  })
+  it('unknown array ids filtered out', () => {
+    expect(resolveJoyExtraOptions({ joyExtraOptions: ['bogus', 'no_artistic_style'] }).options).toEqual(['no_artistic_style'])
+  })
+})
+
+describe('filterJoyExtraClauses', () => {
+  it('removes glasses/headwear clauses', () => {
+    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
+    const out = filterJoyExtraClauses('一位少女，戴着红色贝雷帽，穿白色连衣裙，站在树下', r)
+    expect(out).not.toContain('贝雷帽')
+    expect(out).toContain('白色连衣裙')
+  })
+  it('keeps original separator style', () => {
+    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
+    const out = filterJoyExtraClauses('1girl, red beret, white dress', r)
+    expect(out).not.toContain('beret')
+    expect(out).toContain('white dress')
+    expect(out).toContain(', ')   // 英文逗号分隔保留
+  })
+  it('all clauses filtered → return original (anti-extinction)', () => {
+    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
+    const src = '戴着墨镜和帽子'
+    expect(filterJoyExtraClauses(src, r)).toBe(src)
+  })
+  it('no options → text unchanged', () => {
+    expect(filterJoyExtraClauses('戴着墨镜的少女', resolveJoyExtraOptions({}))).toBe('戴着墨镜的少女')
+  })
+})
+
+describe('buildJoyExtraSystemBlock', () => {
+  it('contains priority declaration + conflict override for glasses option', () => {
+    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
+    const block = buildJoyExtraSystemBlock(r, 'zh')
+    expect(block).toContain('硬约束')
+    expect(block).toContain('眼镜')
+  })
+  it('user tail lists per-option pledge', () => {
+    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_artistic_style'], characterName: '小明' })
+    const tail = buildJoyExtraUserTail(r, 'zh')
+    expect(tail).toContain('小明')
+    expect(tail).toContain('风格')
+  })
+})
```
