## commits
73caaf0 feat(enrich): 艺术指导卡片内置——美学与设计感升级 (Round8 T3Q)
0d131c3 fix(intent,eval): subagent 超时 60s→180s + PM_SUBAGENT_TIMEOUT_MS 可配 (实战 session-97f3819d 三连超时)
1f45be7 docs: Round 8 提示词质量层改写登记（含 h3 搭车登记与四期候选定稿）
## stat
 plugins/prompt-master/docs/plans/TASK_TRACKING.md  |  20 ++++
 .../src/pe-framework/enrich/art-direction.ts       | 110 +++++++++++++++++++++
 .../prompt-master/src/pe-framework/enrich/brief.ts |  31 ++++++
 .../src/pe-framework/enrich/engine.ts              |  27 +++--
 .../src/pe-framework/enrich/personas.ts            |   7 ++
 .../prompt-master/src/pe-framework/eval/critic.ts  |   4 +-
 .../src/pe-framework/intent/subagent-provider.ts   |   4 +-
 .../pe-framework/enrich/art-direction.test.ts      |  77 +++++++++++++++
 .../tests/pe-framework/enrich/brief.test.ts        |  57 +++++++++++
 .../tests/pe-framework/enrich/engine.test.ts       |  41 ++++++++
 .../tests/plugin/author-enrich.e2e.test.ts         |  49 +++++++++
 11 files changed, 418 insertions(+), 9 deletions(-)
## diff
diff --git a/plugins/prompt-master/docs/plans/TASK_TRACKING.md b/plugins/prompt-master/docs/plans/TASK_TRACKING.md
index 5a1c011..430a675 100644
--- a/plugins/prompt-master/docs/plans/TASK_TRACKING.md
+++ b/plugins/prompt-master/docs/plans/TASK_TRACKING.md
@@ -12,20 +12,40 @@
 | Phase 3: MiniMax H3 场景 | 5 | 5 | ✅ 已完成 |
 | Phase 4: Torii + Train + Mirror | 5 | 5 | ✅ 已完成 |
 | Phase 5: 工具 + 测试 | 4 | 4 | ✅ 已完成 |
 | **合计** | **25** | **25** | **100%** |
 | Round 2: 遗漏修复（补齐） | 9 | 9 | ✅ 已完成 |
 | **Round 3: 反推清洗链 + 测试体系 + schema 补齐** | 5 | 5 | ✅ 已完成 |
 | **Round 4: 质量飞轮 M1-M4（2026-09-08）** | 11 | 11 | ✅ 已完成 |
 | **Round 5: 二期 enrich+默认评审+一期遗留全量补齐（2026-09-08）** | 9 | 9 | ✅ 已完成 |
 | **Round 6: 三期实战修复（会话 398c261e 暴露的编译/catalog 问题，2026-09-09）** | 5 | 5 | ✅ 已完成 |
 | **Round 7: 全量遗留清零（文档清账+grounding 去重+语言层+健壮性/卫生/观测包，2026-09-09）** | 6 | 6 | ✅ 已完成 |
+| **Round 8: 提示词质量层改写（调研驱动：锚定补全 persona+官方负向+NL 场景块+预算闸门，2026-09-09）** | 3 | 3 | ✅ 已完成 |
+
+---
+
+## Round 8：提示词质量层改写（调研驱动）
+
+> Spec：`docs/2026-09-09-round8-narrative-budget-design.md`；计划：`docs/plans/2026-09-09-round8-implementation.md`（含追加 Task 2Q）
+> 输入：用户实战反馈「提示词质量过于差」+ 深度调研（Anima=tag+NL 混合方言/DTG-DART 档位/锚定补全模式/官方规范）
+> 验收：全量 vitest **880 passed / 1 skipped / 0 failed**（854→880，golden 零破坏）；**生图实战验证通过**——初始提示词（古风美女舞剑/anima base）出稿 21 tags+3 句英文 NL 场景块，ComfyUI 实测出图全部场景细节渲染且主体不稀释（seed 20260909）
+
+| Task | 内容 | 状态 | 关键 commit |
+|---|---|---|---|
+| T1 | F6 narrative 默认排除 + F8 vague_tag 拦截（atmosphere/beautiful 类 minor gate） | ✅ | 1e75fa4 |
+| T2Q | 提示词质量层改写：ANIMA_PERSONA 锚定补全重写（20-40 预算/词表规范 tag/场景≤3/NL 场景块）+ 官方负向八项 + narrative 条件纳入（NL 质量检查） | ✅ | a4b8406 |
+| T2 | F7 tag_budget_exceeded 软预算闸门（>40 段或 >1200 字符，important）+ **important gates 进修正 feedback 接线**（brief 假设被实测证伪后补的必要路径） | ✅ | 2e1c844 |
+| T3 | 实战生图验证 + 终审 PASS + 登记 | ✅ | 7323040+ |
+
+**登记事项（终审 F3 要求）**：F7 的 important 搭车接线为共享修正环——**h3 的 `shot_execution`（rules-h3.ts:248，important）现也进入 h3 修正轮 feedback**，属 h3 修正 prompt 的真实语义变化（大概率是改善：启发式裁剪指令到达修正轮），后续观察是否指令过载，调节点 prompt-author.ts 两行 filter。
+
+**四期候选（终审定稿）**：①h3 important 搭车实战观察+可选白名单收窄；②合格 narrative 被去重吞段时加 `narrative_deduped` advisory + narrativeIncluded 按「实际装配」计数；③补钉测试（仅 important 不出车直接锚定/条件纳入默认路径去重用例）；④设计文档变更记录节+f6f8 标题措辞+resolve.test POSIX 存量；⑤软预算阈值实战观察（调节点 TAG_BUDGET_MAX_SEGMENTS/CHARS 两常量）。
 
 ---
 
 ## Round 7：全量遗留清零
 
 > 计划：`docs/plans/2026-09-09-round7-cleanup-implementation.md`
 > 执行：Subagent-Driven；验收：全量 vitest **854 passed / 1 skipped / 0 failed**（831→854，golden 零破坏）；tsc/build 干净；终审 PASS
 > F4 severity=important→critical 的实现勘误已回写三期设计文档；CJK 三层排查结论已入库 `docs/2026-09-09-cjk-leak-investigation.md`
 
 | Task | 内容 | 状态 | 关键 commit |
diff --git a/plugins/prompt-master/src/pe-framework/enrich/art-direction.ts b/plugins/prompt-master/src/pe-framework/enrich/art-direction.ts
new file mode 100644
index 0000000..f7bf0ad
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/enrich/art-direction.ts
@@ -0,0 +1,110 @@
+/**
+ * 艺术指导卡片库（Round8 T3Q）：把专业美术指导的「设计意图包」固化为组合拳卡片。
+ *
+ * 方法论参考 SD-Anima-Prompt-Studio：出稿「没有美学和设计感」的根因是 enrich persona 只教了
+ * 结构、没教艺术指导。本库让 LLM 先做设计决策（每类至多选 1 张卡）、再按所选卡片的 tag
+ * 组合拳扩写——卡片内容从实战 studio 提炼，5 类 36 张：
+ *   perspective 镜头视角 8 / composition 构图设计 8 / lighting 光影设计 8 / color 色彩设计 6 / motion 动势设计 6。
+ *
+ * id 是 brief.artDirection 的合法取值（brief.ts 按类目校验）；name 为中文设计意图名；tags 为配套英文 tag 组合拳。
+ */
+
+export interface ArtDirectionCard {
+  id: string
+  /** 中文设计意图名 */
+  name: string
+  /** 配套 tag 组合拳（3-5 个） */
+  tags: readonly string[]
+}
+
+/** 镜头视角（8）：突出气势 / 自然人像 / 叙事感 / 紧张动感 / 场景宏大 / 情绪特写 / 俯瞰叙事 / 戏剧轮廓 */
+export const PERSPECTIVE_CARDS: readonly ArtDirectionCard[] = [
+  { id: 'low_angle', name: '低角度仰拍', tags: ['from below', 'dramatic low angle', 'looking up'] },
+  { id: 'three_quarter_view', name: '三分之二视角', tags: ['three-quarter view', 'dynamic angle', 'showing both face and body'] },
+  { id: 'over_shoulder_glance', name: '过肩回眸', tags: ['over the shoulder shot', 'looking back at viewer', 'soft focus on background'] },
+  { id: 'dutch_angle', name: '荷兰角', tags: ['dutch angle', 'tilted frame', 'sense of tension'] },
+  { id: 'wide_panorama', name: '广角全景', tags: ['wide angle shot', 'expansive view', 'cinematic wide shot'] },
+  { id: 'close_up', name: '特写', tags: ['close-up', 'shallow depth of field', 'detailed face'] },
+  { id: 'top_down', name: '俯视', tags: ['from above', 'top-down view', 'looking down'] },
+  { id: 'side_silhouette', name: '侧面剪影', tags: ['from side', 'silhouette', 'backlit subject'] },
+]
+
+/** 构图设计（8）：均衡 / 动势 / 呼吸感 / 聚焦 / 仪式感 / 纵深 / 协调 / 戏剧性 */
+export const COMPOSITION_CARDS: readonly ArtDirectionCard[] = [
+  { id: 'rule_of_thirds', name: '三分法则', tags: ['rule of thirds', 'off-center placement', 'balanced asymmetry'] },
+  { id: 'diagonal_dynamics', name: '对角线动势', tags: ['diagonal composition', 'dynamic diagonal lines', 'sense of movement'] },
+  { id: 'negative_space', name: '负空间', tags: ['negative space composition', 'minimalist', 'empty space for breathing room'] },
+  { id: 'framed_subject', name: '框架构图', tags: ['framed composition', 'natural frame around subject', 'foreground framing'] },
+  { id: 'perfect_symmetry', name: '对称', tags: ['perfect symmetry', 'mirrored composition', 'formal and elegant'] },
+  { id: 'leading_lines', name: '引导线', tags: ['leading lines', 'converging lines', 'depth through perspective'] },
+  { id: 'golden_ratio', name: '黄金分割', tags: ['golden ratio composition', 'naturally pleasing placement', 'organic balance'] },
+  { id: 'strong_silhouette', name: '剪影', tags: ['strong silhouette', 'dramatic outline', 'backlit minimal detail'] },
+]
+
+/** 光影设计（8）：电影感 / 发丝边缘光 / 穿透感 / 夜景 / 黄金时刻 / 暖光私密 / 明暗戏剧 / 梦幻柔焦 */
+export const LIGHTING_CARDS: readonly ArtDirectionCard[] = [
+  { id: 'cinematic_lighting', name: '电影级', tags: ['cinematic lighting', 'volumetric lighting', 'dramatic shadows'] },
+  { id: 'rim_backlight', name: '逆光轮廓', tags: ['backlighting', 'rim lighting', 'glowing edge'] },
+  { id: 'god_rays', name: '体积光', tags: ['god rays', 'light rays', 'volumetric sunlight'] },
+  { id: 'moonlight_cool', name: '月夜冷调', tags: ['moonlight', 'cool blue tones', 'soft night glow'] },
+  { id: 'golden_hour', name: '黄金时刻', tags: ['golden hour lighting', 'warm sunlight', 'long shadows'] },
+  { id: 'lantern_glow', name: '烛光灯火', tags: ['warm lantern light', 'candlelight glow', 'intimate warm tones'] },
+  { id: 'high_contrast', name: '高对比', tags: ['high contrast lighting', 'chiaroscuro', 'dramatic light and shadow'] },
+  { id: 'soft_dreamlight', name: '柔光梦幻', tags: ['soft lighting', 'ethereal glow', 'diffused light'] },
+]
+
+/** 色彩设计（6）：张力 / 统一 / 电影调色 / 点睛 / 淡雅 / 幻想高饱和 */
+export const COLOR_CARDS: readonly ArtDirectionCard[] = [
+  { id: 'warm_cool_contrast', name: '冷暖对比', tags: ['contrasting color palette', 'cool and warm tones', 'color tension'] },
+  { id: 'limited_palette', name: '有限色板', tags: ['limited palette', 'two-tone color scheme', 'unified color harmony'] },
+  { id: 'cinematic_grading', name: '浓郁电影调色', tags: ['cinematic color grading', 'rich saturated colors', 'vivid yet natural tones'] },
+  { id: 'accent_on_mono', name: '单色点缀', tags: ['monochrome with accent color', 'splash of red', 'selective color pop'] },
+  { id: 'soft_pastel', name: '柔和淡彩', tags: ['soft pastel colors', 'muted tones', 'gentle color transition'] },
+  { id: 'vivid_fantasy', name: '高饱和幻想', tags: ['vibrant fantasy colors', 'iridescent highlights', 'luminous colors'] },
+]
+
+/** 动势设计（6）：直接服务舞剑类动作需求 */
+export const MOTION_CARDS: readonly ArtDirectionCard[] = [
+  { id: 'dynamic_pose', name: '动态姿势', tags: ['dynamic pose', 'action-ready stance', 'mid-movement'] },
+  { id: 'flowing_dress', name: '衣袂飘飞', tags: ['flowing dress', 'fabric in motion', 'clothes fluttering in wind'] },
+  { id: 'flowing_hair', name: '发丝飞扬', tags: ['hair flowing in wind', 'dynamic hair', 'hair strands floating'] },
+  { id: 'weapon_trail', name: '武器轨迹', tags: ['sword trail', 'gleaming blade', 'weapon arc'] },
+  { id: 'falling_petals', name: '花瓣飞舞', tags: ['falling petals', 'petals in the wind', 'swirling petals'] },
+  { id: 'frozen_peak', name: '定格瞬间', tags: ['caught mid-action', 'frozen motion', 'peak of the movement'] },
+]
+
+export type ArtDirectionField = 'perspective' | 'composition' | 'lighting' | 'color' | 'motion'
+
+/** 五类卡组总表（brief.artDirection 校验与卡片菜单的唯一数据源） */
+export const ALL_ART_DIRECTION: Record<ArtDirectionField, readonly ArtDirectionCard[]> = {
+  perspective: PERSPECTIVE_CARDS,
+  composition: COMPOSITION_CARDS,
+  lighting: LIGHTING_CARDS,
+  color: COLOR_CARDS,
+  motion: MOTION_CARDS,
+}
+
+const FIELD_LABELS: Record<ArtDirectionField, string> = {
+  perspective: '镜头视角',
+  composition: '构图设计',
+  lighting: '光影设计',
+  color: '色彩设计',
+  motion: '动势设计',
+}
+
+/** 按类目校验：id 必须属于该字段对应卡组（跨类目 id 一律拒绝，保证字段语义无歧义）。 */
+export function isKnownCardId(field: ArtDirectionField, id: string): boolean {
+  return ALL_ART_DIRECTION[field].some((card) => card.id === id)
+}
+
+/** 卡片清单菜单（engine buildUser 注入 user 段）：id+name+tags，供 LLM 先选卡、再按组合拳扩写。 */
+export function buildArtDirectionMenu(): string {
+  const lines: string[] = [
+    '艺术指导卡片菜单（先选卡再扩写：每类至多选 1 张，把卡片 id 填入 schema 的 artDirection 对应字段，并把该卡片的配套 tag 融入对应维度短语）：',
+  ]
+  for (const field of ['perspective', 'composition', 'lighting', 'color', 'motion'] as const) {
+    lines.push(`【${field} ${FIELD_LABELS[field]}】`)
+    for (const card of ALL_ART_DIRECTION[field]) lines.push(`- ${card.id} ${card.name}: ${card.tags.join(', ')}`)
+  }
+  return lines.join('\n')
+}
diff --git a/plugins/prompt-master/src/pe-framework/enrich/brief.ts b/plugins/prompt-master/src/pe-framework/enrich/brief.ts
index 496aa52..3a2fa25 100644
--- a/plugins/prompt-master/src/pe-framework/enrich/brief.ts
+++ b/plugins/prompt-master/src/pe-framework/enrich/brief.ts
@@ -1,37 +1,53 @@
 /**
  * EnrichedBrief schema + 校验（spec §2.2, §11.2）。
  *
  * 七维度结构化创作 brief：每个维度条目带 source（'user'=用户显式指定硬约束 | 'enriched'=自由发挥补全），
  * nameAnchors 承载角色名词英文锚定（spec §4）。大小硬上限（spec §11.2）：每维 ≤6 条、单条 ≤200 字符，
  * 超限 → ok:false reason='brief_too_large'，**不静默截断**（截断可能丢 user 来源字段）。
+ * Round8 T3Q：可选 artDirection 承载所选艺术指导卡片 id（5 类，见 enrich/art-direction.ts）——
+ * 存在的 id 须在对应卡组中，否则 ok:false reason='invalid_art_direction'（与 brief_too_large 同款整体降级，不静默修补）。
  */
 
+import { isKnownCardId, type ArtDirectionField } from './art-direction.js'
+
 export type BriefItem = { text: string; source: 'user' | 'enriched' }
 
+/** Round8 T3Q：所选艺术指导卡片 id（值须为对应类目卡组中的卡片 id；字段全部可选） */
+export interface ArtDirectionSelection {
+  perspective?: string
+  composition?: string
+  lighting?: string
+  color?: string
+  motion?: string
+}
+
 export interface EnrichedBrief {
   outputLang: 'en' | 'zh' | 'ja'
   subject: BriefItem[]
   scene: BriefItem[]
   composition: BriefItem[]
   lighting: BriefItem[]
   color: BriefItem[]
   style: BriefItem[]
   mood: BriefItem[]
   nameAnchors: Array<{ original: string; anchored: string }>
+  artDirection?: ArtDirectionSelection
 }
 
 export const BRIEF_MAX_ITEMS_PER_DIM = 6
 export const BRIEF_MAX_TEXT_LEN = 200
 
 const DIMENSIONS = ['subject', 'scene', 'composition', 'lighting', 'color', 'style', 'mood'] as const
 
+const ART_DIRECTION_KEYS: readonly ArtDirectionField[] = ['perspective', 'composition', 'lighting', 'color', 'motion']
+
 const OUTPUT_LANGS = new Set(['en', 'zh', 'ja'])
 
 function fail(reason: string): { ok: false; reason: string } {
   return { ok: false, reason }
 }
 
 function isPlainObject(v: unknown): v is Record<string, unknown> {
   return typeof v === 'object' && v !== null && !Array.isArray(v)
 }
 
@@ -55,25 +71,40 @@ export function validateBrief(raw: unknown): { ok: true; brief: EnrichedBrief }
       if (it.text.length > BRIEF_MAX_TEXT_LEN) return fail('brief_too_large')
     }
   }
   const anchors = raw['nameAnchors']
   if (!Array.isArray(anchors)) return fail('invalid_nameAnchors')
   for (const a of anchors) {
     if (!isPlainObject(a) || typeof a['original'] !== 'string' || typeof a['anchored'] !== 'string') {
       return fail('invalid_nameAnchors')
     }
   }
+  // Round8 T3Q：artDirection 可选——出现即逐字段校验（未选字段忽略；未知/跨类目/非串 id → 整体 invalid_art_direction）
+  let artDirection: ArtDirectionSelection | undefined
+  const rawAd = raw['artDirection']
+  if (rawAd !== undefined) {
+    if (!isPlainObject(rawAd)) return fail('invalid_art_direction')
+    const sel: ArtDirectionSelection = {}
+    for (const field of ART_DIRECTION_KEYS) {
+      const v = rawAd[field]
+      if (v === undefined) continue
+      if (typeof v !== 'string' || !isKnownCardId(field, v)) return fail('invalid_art_direction')
+      sel[field] = v
+    }
+    if (ART_DIRECTION_KEYS.some((field) => sel[field] !== undefined)) artDirection = sel
+  }
   return {
     ok: true,
     brief: {
       outputLang: lang as EnrichedBrief['outputLang'],
       subject: raw['subject'] as BriefItem[],
       scene: raw['scene'] as BriefItem[],
       composition: raw['composition'] as BriefItem[],
       lighting: raw['lighting'] as BriefItem[],
       color: raw['color'] as BriefItem[],
       style: raw['style'] as BriefItem[],
       mood: raw['mood'] as BriefItem[],
       nameAnchors: anchors as EnrichedBrief['nameAnchors'],
+      ...(artDirection ? { artDirection } : {}),
     },
   }
 }
diff --git a/plugins/prompt-master/src/pe-framework/enrich/engine.ts b/plugins/prompt-master/src/pe-framework/enrich/engine.ts
index dd9e9a8..fe2d3b8 100644
--- a/plugins/prompt-master/src/pe-framework/enrich/engine.ts
+++ b/plugins/prompt-master/src/pe-framework/enrich/engine.ts
@@ -5,55 +5,64 @@
  * - outputLang（spec §2.2/§4）：anima 方言锁 'en'（显式传 zh 也直接纠正，advisory 语义由接线层 T6 承担）；
  *   h3 显式指定优先，否则 detectLanguage(userInput) 映射（中文→zh，日本語→ja，其他→en）；
  * - 降级铁律（spec §2.1/§6）：provider 抛错 / parse 失败 / schema 不合 / 大小超限 → { skipped: true, reason }，
  *   永不抛出、永不静默截断。
  */
 import type { CriticProvider } from '../eval/critic.js'
 import { detectLanguage } from '../dialect/h3.js'
 import { validateBrief } from './brief.js'
 import type { EnrichedBrief } from './brief.js'
 import { buildEnrichPersona } from './personas.js'
+import { buildArtDirectionMenu } from './art-direction.js'
 
 export type EnrichTarget = 'anima' | 'h3'
 
 export type EnrichResult = { brief: EnrichedBrief } | { skipped: true; reason: string }
 
 function stripFences(text: string): string {
   return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
 }
 
-function buildSchema(): string {
+function buildSchema(target: EnrichTarget): string {
   const item = `{ "text": "维度内容（≤200 字符）", "source": "user" | "enriched" }`
+  // Round8 T3Q：anima 增加 artDirection（所选卡片 id，全部可选）；h3 不做美学升级，schema 不出现该字段
+  const artDirection = target === 'anima'
+    ? `
+  "artDirection": { "perspective": "镜头视角卡片 id（可省略）", "composition": "构图卡片 id（可省略）", "lighting": "光影卡片 id（可省略）", "color": "色彩卡片 id（可省略）", "motion": "动势卡片 id（可省略）" },`
+    : ''
   return `{
   "outputLang": "en" | "zh" | "ja",
   "subject": [${item}],
   "scene": [${item}],
   "composition": [${item}],
   "lighting": [${item}],
   "color": [${item}],
   "style": [${item}],
-  "mood": [${item}],
+  "mood": [${item}],${artDirection}
   "nameAnchors": [{ "original": "用户原角色名", "anchored": "英文锚定名" }]
 }`
 }
 
 function buildUser(input: { target: EnrichTarget; userInput: string }): string {
-  return [
+  const lines = [
     `target=${input.target}`,
     '',
     '用户原始输入：',
     input.userInput,
     '',
     // Round7 T3：与 persona 的语义级保留规则同步——字面「原样保留，不改写」会让中文 user 条目穿透英文 brief
     '要求：source=user 仅用于用户显式指定的内容（语义与指代保留、不得增删要素，语言必须改写为 outputLang 对应语言）；其余全部标 source=enriched。',
     '每维度 ≤6 条、单条 ≤200 字符。outputLang 按目标方言给出（anima 恒为 en）。',
-  ].join('\n')
+  ]
+  // Round8 T3Q：anima user 段附艺术指导卡片清单（id+name+tags），供 LLM 先选卡、再按组合拳扩写
+  if (input.target === 'anima') lines.push('', buildArtDirectionMenu())
+  return lines.join('\n')
 }
 
 /** detectLanguage（'中文'|'日本語'|'English'）→ brief outputLang（'zh'|'ja'|'en'，其他归 en）。 */
 function mapDetectedLang(detected: string): EnrichedBrief['outputLang'] {
   if (detected === '中文') return 'zh'
   if (detected === '日本語') return 'ja'
   return 'en'
 }
 
 /** spec §2.2/§4：目标方言的最终 outputLang（在 validate 之后由代码强制，不信任 LLM 输出）。 */
@@ -61,44 +70,48 @@ function resolveOutputLang(target: EnrichTarget, explicit: EnrichedBrief['output
   if (target === 'anima') return 'en'
   if (explicit !== undefined) return explicit
   return mapDetectedLang(detectLanguage(userInput))
 }
 
 /**
  * runEnrich：扩写引擎入口。永不抛出；任何故障路径返回 { skipped: true, reason }：
  * - provider 抛错 → enrich_llm_error
  * - JSON parse 失败 / schema 不合 → enrich_invalid_schema
  * - 大小超限（validateBrief brief_too_large）→ brief_too_large（不截断，整体降级）
+ * - Round8 T3Q：未知/跨类目艺术指导卡片 id（validateBrief invalid_art_direction）→ invalid_art_direction（整体降级）
  */
 export async function runEnrich(input: {
   target: EnrichTarget
   userInput: string
   /** 显式指定优先（仅 h3 有效；anima 恒锁 en） */
   outputLang?: EnrichedBrief['outputLang']
   provider: CriticProvider
 }): Promise<EnrichResult> {
   try {
     const raw = await input.provider({
       persona: buildEnrichPersona(input.target),
-      schema: buildSchema(),
+      schema: buildSchema(input.target),
       user: buildUser(input),
     })
     let parsed: unknown
     try {
       parsed = JSON.parse(stripFences(raw))
     } catch {
       return { skipped: true, reason: 'enrich_invalid_schema' }
     }
     const validated = validateBrief(parsed)
     if (!validated.ok) {
-      // 形状/schema 不合归一为 enrich_invalid_schema；大小超限保留专属 reason（不截断，整体降级）
-      const reason = validated.reason === 'brief_too_large' ? 'brief_too_large' : 'enrich_invalid_schema'
+      // 形状/schema 不合归一为 enrich_invalid_schema；专属降级 reason 保留（不修补，整体降级）：
+      // 大小超限 brief_too_large；Round8 T3Q 未知/跨类目卡片 id invalid_art_direction
+      const reason = validated.reason === 'brief_too_large' || validated.reason === 'invalid_art_direction'
+        ? validated.reason
+        : 'enrich_invalid_schema'
       return { skipped: true, reason }
     }
     const brief: EnrichedBrief = {
       ...validated.brief,
       outputLang: resolveOutputLang(input.target, input.outputLang, input.userInput),
     }
     return { brief }
   } catch {
     return { skipped: true, reason: 'enrich_llm_error' }
   }
diff --git a/plugins/prompt-master/src/pe-framework/enrich/personas.ts b/plugins/prompt-master/src/pe-framework/enrich/personas.ts
index 79e943a..c0fbc6e 100644
--- a/plugins/prompt-master/src/pe-framework/enrich/personas.ts
+++ b/plugins/prompt-master/src/pe-framework/enrich/personas.ts
@@ -13,20 +13,27 @@ export function buildEnrichPersona(target: 'anima' | 'h3'): string {
       '你是一位资深的 Anima 图像提示词扩写专家。',
       '任务：把用户的一句话意图富化为七维度结构化创作 brief，重点补充画面感与视觉细节：',
       '光影质感、色彩氛围、构图视角、媒介画风等。扩写自由发挥，但唯一硬约束是不得与用户显式指定的内容冲突',
       '（用户指定的内容标 source=user，你补充的内容标 source=enriched）。',
       'source=user 条目按语义级保留：语义与指代必须保留、不得增删要素，但语言必须改写为 outputLang 对应语言',
       '（Anima 恒为英文）——中文/日文等原文条目一律译成英文进 brief，不得原样照搬原语言。',
       '风格词优先使用常见英文 tag 词汇；角色名保持原样并按 schema 给出英文锚定（nameAnchors）。',
       // Round 8 T2Q（D）：tag 化准备指引——enrich brief 是下游 intent 补全/tag 化的锚点，短语质量决定 tag 块质量
       '每个维度 2-3 条高质量短语即可，禁止堆砌；场景维度最终最多 3 条进 tag，其余走 narrative NL；',
       '用 danbooru 词表常见英文词汇（如 holding sword 而非 sword tip lifting flower petals），多词自造短语响应弱。',
+      // Round 8 T3Q：艺术指导课程——先做设计决策（选组合拳卡）再扩写，治「出稿没有美学和设计感」
+      '艺术指导课程（必须先做设计决策再扩写）：',
+      '1. 先从四类设计卡中各选定一套组合拳：镜头视角（如低角度仰拍/三分之二视角）、构图（如对角线动势/三分法则/负空间）、光影（如逆光轮廓/体积光/月夜冷调）、色彩（如冷暖对比/有限色板）；',
+      '2. 把所选组合的配套 tag 写入 composition 与 lighting/color 维度（标 source=enriched），并把所选卡片 id 填入 schema 的 artDirection 对应字段；',
+      '3. 动势设计：动作场景必须含动势卡（衣袂飘飞/发丝飞扬/武器轨迹/定格瞬间至少其一），静态场景可选；',
+      '4. 服装描述采用五件套：材质颜色 + 剪裁细节 + 纹样点缀 + 动态特征 + 整体轮廓（如 white silk hanfu | wide flowing sleeves | subtle cloud embroidery | sleeves trailing in motion | elegant silhouette）；',
+      '5. 设计决策服务于情绪叙事：先定画面情绪，再选服务于该情绪的光影与色彩组合。',
       '输出：只输出一个 JSON（可带 ```json fence），形状见 schema；不要任何额外文字或解释。',
     ].join('\n')
   }
   return [
     '你是一位资深的 MiniMax H3 视频提示词分镜扩写专家。',
     '任务：把用户的一句话意图富化为七维度结构化创作 brief，重点补充每镜头的内容量与节奏感：',
     '镜头语言（景别/机位/运镜）、分镜内容、环境与氛围细节。铁律：不新增镜头数——镜头数由时长公式决定，',
     '你只填充现有镜头的内容量。扩写自由发挥，但唯一硬约束是不得与用户显式指定的内容冲突',
     '（用户指定的内容标 source=user，你补充的内容标 source=enriched）。',
     'source=user 条目按语义级保留：语义与指代必须保留、不得增删要素，但语言必须改写为 outputLang 对应语言',
diff --git a/plugins/prompt-master/src/pe-framework/eval/critic.ts b/plugins/prompt-master/src/pe-framework/eval/critic.ts
index f4e1c23..0fdabb7 100644
--- a/plugins/prompt-master/src/pe-framework/eval/critic.ts
+++ b/plugins/prompt-master/src/pe-framework/eval/critic.ts
@@ -427,21 +427,23 @@ interface SubagentLikeRun {
   dispose: () => Promise<unknown> | unknown
 }
 
 /**
  * 用 ctx.subagents.start 装 CriticProvider（模式对齐 intent/subagent-provider.ts 的
  * createSubagentIntentProvider：one-shot run + persona/schema 前缀 + 解析 text + run.dispose +
  * 超时 AbortController）。persona/schema/user 三段由 judgeReview 构造后整体传入。
  * ctx 不可用/抛错由调用方 catch 后走 skipped 降级。
  */
 export function createSubagentCriticProvider(ownerCtx: any, opts?: { timeoutMs?: number }): CriticProvider {
-  const timeoutMs = opts?.timeoutMs ?? 60_000
+  // R9：默认 60s 实战连续超时 → 180s，支持 PM_SUBAGENT_TIMEOUT_MS 覆盖
+  const envTimeout = Number(process.env.PM_SUBAGENT_TIMEOUT_MS ?? '')
+  const timeoutMs = opts?.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 180_000)
   const providerName = 'spawn'
 
   return async function subagentCritic(req: { persona: string; schema: string; user: string }): Promise<string> {
     if (!ownerCtx?.subagents?.start) {
       throw new Error('SubagentCriticProvider 不可用：ctx.subagents 未注册（plugin 未注入 "subagents"）')
     }
     const taskText = [
       req.persona,
       '',
       '输出 JSON Schema:',
diff --git a/plugins/prompt-master/src/pe-framework/intent/subagent-provider.ts b/plugins/prompt-master/src/pe-framework/intent/subagent-provider.ts
index ed2099c..9ca7716 100644
--- a/plugins/prompt-master/src/pe-framework/intent/subagent-provider.ts
+++ b/plugins/prompt-master/src/pe-framework/intent/subagent-provider.ts
@@ -55,21 +55,23 @@ export interface SubagentProviderOptions {
 }
 
 /**
  * 创建子代理 Intent Provider：ownerCtx 在此一次性绑定，返回可装入 author.ts seam 的 AuthorIntentFn。
  * ownerCtx 应包含 ctx.subagents 服务（plugin inject ['subagents']）。
  */
 export function createSubagentIntentProvider(
   ownerCtx: any,
   opts: SubagentProviderOptions = {},
 ): AuthorIntentFn {
-  const timeoutMs = opts.timeoutMs ?? 60_000
+  // R9：默认 60s 实战连续超时（session-97f3819d 三连失败）→ 180s，支持 PM_SUBAGENT_TIMEOUT_MS 覆盖
+  const envTimeout = Number(process.env.PM_SUBAGENT_TIMEOUT_MS ?? '')
+  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 180_000)
   const provider = opts.provider ?? 'spawn'
 
   if (!ownerCtx?.subagents?.start) {
     throw new Error('SubagentIntentProvider 不可用：ctx.subagents 未注册（DSH host 未加载 subagent 服务或 plugin 未注入 "subagents"）。提示：检查 plugin inject 是否含 "subagents"，或稍后重试。')
   }
 
   return async function subagentIntent(req: AuthorIntentRequest, exec?: any): Promise<AuthorDraft> {
     // persona/schema 解析（Task 7 方言化）：req（author 按 dialect.intent 注入）> opts（插件配置）> 全局 DEFAULT 兜底
     // Task 12 Step 3b：蓝图模式（target='blueprint'）强制 BLUEPRINT_SUBAGENT_SYSTEM + BLUEPRINT_SCHEMA（最小 system，不含技能/工具噪音）
     const isBlueprint = req.target === 'blueprint'
diff --git a/plugins/prompt-master/tests/pe-framework/enrich/art-direction.test.ts b/plugins/prompt-master/tests/pe-framework/enrich/art-direction.test.ts
new file mode 100644
index 0000000..850a48a
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/enrich/art-direction.test.ts
@@ -0,0 +1,77 @@
+/**
+ * Round8 T3Q：艺术指导卡片库（美术指导设计意图包，方法论来自 SD-Anima-Prompt-Studio）。
+ * 本测试锁定卡片库结构契约：5 类 36 张、id 全局唯一、每卡 tags 3-5 个、菜单可渲染。
+ */
+import { describe, it, expect } from 'vitest'
+import {
+  PERSPECTIVE_CARDS,
+  COMPOSITION_CARDS,
+  LIGHTING_CARDS,
+  COLOR_CARDS,
+  MOTION_CARDS,
+  ALL_ART_DIRECTION,
+  isKnownCardId,
+  buildArtDirectionMenu,
+  type ArtDirectionCard,
+} from '../../../src/pe-framework/enrich/art-direction.js'
+
+const GROUPS: Array<{ field: keyof typeof ALL_ART_DIRECTION; cards: readonly ArtDirectionCard[]; count: number }> = [
+  { field: 'perspective', cards: PERSPECTIVE_CARDS, count: 8 },
+  { field: 'composition', cards: COMPOSITION_CARDS, count: 8 },
+  { field: 'lighting', cards: LIGHTING_CARDS, count: 8 },
+  { field: 'color', cards: COLOR_CARDS, count: 6 },
+  { field: 'motion', cards: MOTION_CARDS, count: 6 },
+]
+
+describe('艺术指导卡片库结构契约', () => {
+  it('5 类卡组、数量 8/8/8/6/6 共 36 张', () => {
+    expect(Object.keys(ALL_ART_DIRECTION).sort()).toEqual(['color', 'composition', 'lighting', 'motion', 'perspective'])
+    let total = 0
+    for (const g of GROUPS) {
+      expect(ALL_ART_DIRECTION[g.field]).toBe(g.cards) // ALL_ART_DIRECTION 直接引用五类卡组
+      expect(g.cards).toHaveLength(g.count)
+      total += g.cards.length
+    }
+    expect(total).toBe(36)
+  })
+
+  it('每张卡：id 蛇形小写、name 非空中文设计意图、tags 3-5 个非空英文短语', () => {
+    for (const g of GROUPS) {
+      for (const card of g.cards) {
+        expect(card.id).toMatch(/^[a-z][a-z0-9_]*$/)
+        expect(card.name.length).toBeGreaterThan(0)
+        expect(/[一-龥]/.test(card.name)).toBe(true) // name 是中文设计意图名
+        expect(card.tags.length).toBeGreaterThanOrEqual(3)
+        expect(card.tags.length).toBeLessThanOrEqual(5)
+        for (const tag of card.tags) {
+          expect(tag.length).toBeGreaterThan(0)
+          expect(tag).not.toMatch(/[一-龥]/) // tag 是英文组合拳
+        }
+      }
+    }
+  })
+
+  it('id 全局唯一（36 张无重复）——artDirection 字段值才能无歧义寻址', () => {
+    const ids = GROUPS.flatMap((g) => g.cards.map((c) => c.id))
+    expect(new Set(ids).size).toBe(36)
+  })
+
+  it('isKnownCardId：本类 id → true；跨类 id / 未知 id → false（按类目寻址，不允许 lighting=构图卡）', () => {
+    expect(isKnownCardId('perspective', 'low_angle')).toBe(true)
+    expect(isKnownCardId('motion', 'flowing_dress')).toBe(true)
+    expect(isKnownCardId('lighting', 'rule_of_thirds')).toBe(false) // 构图卡不能填进光影
+    expect(isKnownCardId('perspective', 'no_such_card')).toBe(false)
+  })
+
+  it('buildArtDirectionMenu：含全部 36 张卡的 id+name+tags（LLM 选择清单）', () => {
+    const menu = buildArtDirectionMenu()
+    for (const g of GROUPS) {
+      for (const card of g.cards) {
+        expect(menu).toContain(card.id)
+        expect(menu).toContain(card.name)
+        for (const tag of card.tags) expect(menu).toContain(tag)
+      }
+    }
+    expect(menu).toContain('艺术指导卡片菜单')
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/enrich/brief.test.ts b/plugins/prompt-master/tests/pe-framework/enrich/brief.test.ts
index ca9b1ff..15965b6 100644
--- a/plugins/prompt-master/tests/pe-framework/enrich/brief.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/enrich/brief.test.ts
@@ -77,10 +77,67 @@ describe('validateBrief', () => {
     const edge = { text: 'y'.repeat(BRIEF_MAX_TEXT_LEN as number), source: 'user' }
     expect(validateBrief(okBrief({ subject: six, mood: [edge] })).ok).toBe(true)
   })
 
   it('nameAnchors：空数组合法；条目须 {original, anchored} 字符串', () => {
     expect(validateBrief(okBrief({ nameAnchors: [{ original: '小明', anchored: 'XiaoMing' }] })).ok).toBe(true)
     expect(validateBrief(okBrief({ nameAnchors: [{}] })).ok).toBe(false)
     expect(validateBrief(okBrief({ nameAnchors: 'x' })).ok).toBe(false)
   })
 })
+
+/* Round8 T3Q：artDirection 可选字段——所选艺术指导卡片 id 的合法性校验 */
+describe('validateBrief artDirection', () => {
+  it('缺省（旧形状）→ ok:true，输出 brief 无 artDirection 键（向后兼容硬约束）', () => {
+    const res = validateBrief(okBrief())
+    expect(res.ok).toBe(true)
+    if (res.ok) expect('artDirection' in res.brief).toBe(false)
+  })
+
+  it('合法卡片 id（全五类）→ ok:true 且 brief.artDirection 原样保留', () => {
+    const ad = { perspective: 'low_angle', composition: 'diagonal_dynamics', lighting: 'rim_backlight', color: 'warm_cool_contrast', motion: 'flowing_dress' }
+    const res = validateBrief(okBrief({ artDirection: ad }))
+    expect(res.ok).toBe(true)
+    if (res.ok) expect(res.brief.artDirection).toEqual(ad)
+  })
+
+  it('部分选择（子集字段）→ ok:true，仅保留所选字段', () => {
+    const res = validateBrief(okBrief({ artDirection: { lighting: 'god_rays', color: 'limited_palette' } }))
+    expect(res.ok).toBe(true)
+    if (res.ok) expect(res.brief.artDirection).toEqual({ lighting: 'god_rays', color: 'limited_palette' })
+  })
+
+  it('未知卡片 id → ok:false reason=invalid_art_direction', () => {
+    const res = validateBrief(okBrief({ artDirection: { perspective: 'no_such_card' } }))
+    expect(res.ok).toBe(false)
+    if (!res.ok) expect(res.reason).toBe('invalid_art_direction')
+  })
+
+  it('跨类目 id（lighting 填构图卡）→ ok:false reason=invalid_art_direction', () => {
+    const res = validateBrief(okBrief({ artDirection: { lighting: 'rule_of_thirds' } }))
+    expect(res.ok).toBe(false)
+    if (!res.ok) expect(res.reason).toBe('invalid_art_direction')
+  })
+
+  it('值非字符串（数字/null）→ ok:false reason=invalid_art_direction', () => {
+    expect(validateBrief(okBrief({ artDirection: { color: 42 } })).ok).toBe(false)
+    const res = validateBrief(okBrief({ artDirection: { color: null } }))
+    expect(res.ok).toBe(false)
+    if (!res.ok) expect(res.reason).toBe('invalid_art_direction')
+  })
+
+  it('artDirection 非对象（串/数组）→ ok:false reason=invalid_art_direction', () => {
+    const s = validateBrief(okBrief({ artDirection: 'low_angle' }))
+    expect(s.ok).toBe(false)
+    if (!s.ok) expect(s.reason).toBe('invalid_art_direction')
+    expect(validateBrief(okBrief({ artDirection: ['low_angle'] })).ok).toBe(false)
+  })
+
+  it('未知子键被丢弃；空对象 {} → ok:true 且不产出空 artDirection', () => {
+    const dropped = validateBrief(okBrief({ artDirection: { perspective: 'low_angle', bogus: 'x' } }))
+    expect(dropped.ok).toBe(true)
+    if (dropped.ok) expect(dropped.brief.artDirection).toEqual({ perspective: 'low_angle' })
+    const empty = validateBrief(okBrief({ artDirection: {} }))
+    expect(empty.ok).toBe(true)
+    if (empty.ok) expect('artDirection' in empty.brief).toBe(false)
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/enrich/engine.test.ts b/plugins/prompt-master/tests/pe-framework/enrich/engine.test.ts
index 89ab982..d263d6f 100644
--- a/plugins/prompt-master/tests/pe-framework/enrich/engine.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/enrich/engine.test.ts
@@ -161,10 +161,51 @@ describe('runEnrich 保真', () => {
   it("source='user' 的 item 原样保留（引擎不改写）", async () => {
     const userItems = [
       { text: '红色连衣裙', source: 'user' },
       { text: '微笑', source: 'user' },
     ]
     const res: EnrichedBrief | null = await runEnrich({ target: 'h3', userInput: 'x', provider: providerReturning(validBriefJson({ subject: userItems })) }).then((r) => ('brief' in r ? r.brief : null))
     expect(res).not.toBeNull()
     expect(res!.subject).toEqual(userItems)
   })
 })
+
+/* Round8 T3Q：艺术指导卡片内置——persona 课程 / user 卡片清单 / artDirection 校验降级 */
+describe('runEnrich 艺术指导（Round8 T3Q）', () => {
+  const ART = { perspective: 'low_angle', composition: 'diagonal_dynamics', lighting: 'rim_backlight', color: 'warm_cool_contrast', motion: 'flowing_dress' }
+
+  it('anima persona 含「艺术指导」「设计决策」「五件套」课程关键词；h3 persona 不含（h3 不做美学升级）', async () => {
+    captured.length = 0
+    await runEnrich({ target: 'anima', userInput: 'u1', provider: capturing(providerReturning(validBriefJson())) })
+    await runEnrich({ target: 'h3', userInput: 'u2', provider: capturing(providerReturning(validBriefJson())) })
+    expect(captured[0].persona).toContain('艺术指导')
+    expect(captured[0].persona).toContain('设计决策')
+    expect(captured[0].persona).toContain('五件套')
+    expect(captured[1].persona).not.toContain('艺术指导')
+  })
+
+  it('anima user 段附五类卡片清单（id+name+tags）与 schema 的 artDirection 字段；h3 user/schema 无卡片清单', async () => {
+    captured.length = 0
+    await runEnrich({ target: 'anima', userInput: 'u1', provider: capturing(providerReturning(validBriefJson())) })
+    await runEnrich({ target: 'h3', userInput: 'u2', provider: capturing(providerReturning(validBriefJson())) })
+    // anima：菜单 + 代表性卡片 id/tag + schema artDirection 形状
+    expect(captured[0].user).toContain('艺术指导卡片菜单')
+    expect(captured[0].user).toContain('low_angle 低角度仰拍')
+    expect(captured[0].user).toContain('from below')
+    expect(captured[0].user).toContain('flowing_dress 衣袂飘飞')
+    expect(captured[0].schema).toContain('artDirection')
+    // h3：不加卡片清单（范围钉死：T3Q 只做 anima 美学升级）
+    expect(captured[1].user).not.toContain('艺术指导卡片菜单')
+    expect(captured[1].schema).not.toContain('artDirection')
+  })
+
+  it('mock brief 含合法 artDirection → brief.artDirection 原样透传', async () => {
+    const res = await runEnrich({ target: 'anima', userInput: '持剑舞者的少女', provider: providerReturning(validBriefJson({ artDirection: ART })) })
+    if ('brief' in res) expect(res.brief.artDirection).toEqual(ART)
+    else expect.unreachable()
+  })
+
+  it('未知卡片 id → skipped invalid_art_direction（reason 不被归并为 enrich_invalid_schema）', async () => {
+    const res = await runEnrich({ target: 'anima', userInput: 'x', provider: providerReturning(validBriefJson({ artDirection: { lighting: 'no_such_card' } })) })
+    expect(res).toEqual({ skipped: true, reason: 'invalid_art_direction' })
+  })
+})
diff --git a/plugins/prompt-master/tests/plugin/author-enrich.e2e.test.ts b/plugins/prompt-master/tests/plugin/author-enrich.e2e.test.ts
index 7ad0b4c..993c1b8 100644
--- a/plugins/prompt-master/tests/plugin/author-enrich.e2e.test.ts
+++ b/plugins/prompt-master/tests/plugin/author-enrich.e2e.test.ts
@@ -329,11 +329,60 @@ describe('Round7 T3 persona 语言层修正', () => {
     expect(enrichReq.user).not.toContain('不改写')
     // envelope：brief 语言为英文（anima outputLang 代码强制 en + 英文 user 条目原样透传）
     expect(raw.enrichment.brief.outputLang).toBe('en')
     expect(raw.enrichment.brief.subject[0]).toEqual({ text: 'a girl running through a rainy night street', source: 'user' })
     // 现有英文 brief 流程不回归：intent 吃英文 brief 权威输入
     expect(intentCalls[0].input).toContain('brief 是权威输入')
     expect(intentCalls[0].input).toContain('[user] a girl running through a rainy night street')
   })
 })
 
+/* Round8 T3Q：artDirection 透传（envelope enrichment 段）+ 旧形状 brief 向后兼容 */
+describe('Round8 T3Q artDirection 透传与向后兼容', () => {
+  let dbDir: string
+  beforeEach(() => {
+    dbDir = mkdtempSync(join(tmpdir(), 'pm-author-enrich-'))
+    setAuthorFeedbackDbPath(join(dbDir, 'feedback.sqlite'))
+  })
+
+  it('mock enrich 返回含 artDirection 的 brief → envelope enrichment.brief 带 artDirection，出稿流程不回归', async () => {
+    const ad = { perspective: 'low_angle', composition: 'diagonal_dynamics', lighting: 'rim_backlight', color: 'warm_cool_contrast', motion: 'flowing_dress' }
+    const enrich = enrichOf([briefJson({ artDirection: ad })])
+    setAuthorEnrichProvider(enrich)
+    const intentCalls: AuthorIntentRequest[] = []
+    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
+    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: '月夜持剑而舞的少女', enrich: true, judge_mode: 'off' })))
+    expect(raw.ok).toBe(true)
+    // envelope enrichment 段带 artDirection（所选卡片 id 原样透传）
+    expect(raw.enrichment).toBeDefined()
+    expect(raw.enrichment.skipped).toBeUndefined()
+    expect(raw.enrichment.brief.artDirection).toEqual(ad)
+    // 出稿流程不回归：brief 仍是 intent 权威输入
+    expect(intentCalls[0].input).toContain('brief 是权威输入')
+  })
+
+  it('旧形状 brief（无 artDirection）→ 照常通过（向后兼容），enrichment.brief 无 artDirection 键', async () => {
+    const enrich = enrichOf([briefJson()])
+    setAuthorEnrichProvider(enrich)
+    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
+    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', enrich: true, judge_mode: 'off' })))
+    expect(raw.ok).toBe(true)
+    expect(raw.enrichment).toBeDefined()
+    expect(raw.enrichment.brief.outputLang).toBe('en')
+    expect(raw.enrichment.brief.artDirection).toBeUndefined()
+  })
+
+  it('mock enrich 返回未知卡片 id → enrichment.skipped reason=invalid_art_direction + advisory enrich_skipped，照常出稿', async () => {
+    const enrich = enrichOf([briefJson({ artDirection: { lighting: 'no_such_card' } })])
+    setAuthorEnrichProvider(enrich)
+    const intentCalls: AuthorIntentRequest[] = []
+    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
+    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', enrich: true, judge_mode: 'off' })))
+    expect(raw.ok).toBe(true)
+    expect(raw.enrichment).toEqual({ skipped: true, reason: 'invalid_art_direction' })
+    expect(raw.advisories).toContain('enrich_skipped')
+    expect(String(raw.result.positive)).toContain('1girl') // 降级铁律：intent 吃原始输入，照常出稿
+    expect(intentCalls[0].input).toBe('cat portrait')
+  })
+})
+
 afterAll(() => { setAuthorIntentProvider(null); setAuthorEnrichProvider(null); setAuthorJudgeDeps(null); setAuthorFeedbackDbPath(null); closeCatalog() })
