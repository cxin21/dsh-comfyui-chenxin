/**
 * 意图分析器（spec §6）：意图 → 蓝图 v0 + missing + 澄清接口 + 保真守卫。
 * analyzeIntent：经 LLM（ctx.llm.stream，persona=BLUEPRINT_PERSONA，schema=BLUEPRINT_SCHEMA）
 * 产出蓝图 v0 JSON → validateBlueprint 校验 → 计算 missing（spec §6：关键=style/media/negative 边界；
 * 次要=光影/构图）→ clarify:'ask' 且关键缺失时映射为 clarify_questions（每个问题 =
 * 「缺少 <维度>：请选择/补充」）→ 调 checkFidelity(input, blueprint) 把丢失实体并入 missing（保真守卫）→
 * 返回 {blueprint, missing, clarify_questions?}。
 * 多模态（Phase 2 完整，spec §6 L227）：refs 传入时提取参考物美学特征进蓝图核心字段
 * （scene.lighting/core.style.palette/scene.atmosphere 等，LLM 引导非硬编码），ref 标签保持稳定；
 * 无 refs 时行为与 Phase 1 完全一致。蓝图不承载 references 持久字段（§8.1 澄清）。
 *
 * 注：运行期接入 createSubagentIntentProvider 的 one-shot 子代理 seam 由 Task 10/12 的 author 管线
 * 负责（subagent-provider.ts 蓝图 persona 接线在 Task 12 Step 3b）；本模块独立可测（LLM stream 路径）。
 */
import { complete } from '../../llm/complete.js'
import type { Context } from '@deepseek-ai/cordis'
import { validateBlueprint, type BlueprintMedia, type BlueprintV1 } from './schema.js'
import { checkFidelity } from '../aesthetics/check.js'

export const BLUEPRINT_PERSONA = `你是一位创作蓝图分析引擎（spec §6）。
你的任务：根据用户的创作意图，产出创作蓝图 v0（BlueprintV1），不是任何方言输入。

规则：
1. 产出蓝图 v0 JSON（media/core/media_layer），不是方言 slots/shots
2. 保留事实：用户给的具体描述原字面进入蓝图（concept/narrative/角色锚点），不编造情节
3. 标记缺失：蓝图字段可空；缺维度时字段留空（如无风格 → 不填 core.style）
4. 多模态（Phase 2 完整）：references 传入时提取参考物美学特征进蓝图核心字段——光线→scene.lighting、配色→core.style.palette、氛围→scene.atmosphere、环境→scene.environment、构图→core.composition、情绪→core.emotion（仅映射进蓝图既有核心字段，不新增 schema 字段、不编造参考物没有的特征）；同时保持 ref 标签稳定（<Picture N>/<Subject N>/<Video N>/<Audio N>），不要替换
5. 蓝图 media_layer.video.total_duration_seconds 指视频总时长（官方契约 4–15s），不是每镜时长；用户说「3 个分镜每个 5 秒」→ total=15，shots=3。

输出：严格按下方 JSON Schema 的 JSON 字符串，不要包含任何额外文字（不要 markdown fence，不要解释）。
`

export const BLUEPRINT_SCHEMA = `{
  "schema_version": 1,
  "media": "video",
  "core": {
    "concept": "一句话主题（必填，用户原意压缩）",
    "aspect_ratio": "16:9",
    "characters": [
      { "id": "c1", "name": "角色名", "appearance_anchors": ["可见锚点"], "outfit": "服装" }
    ],
    "scene": { "environment": "环境", "lighting": "光线基调" },
    "style": { "base": "基底风格", "theme": "主题风格", "palette": "配色" },
    "emotion": "情绪基调",
    "composition": ["构图语言"],
    "negative": [{ "target": "负向对象", "severity": "soft" }],
    "narrative": "自由叙事文本（保留用户原话）"
  },
  "media_layer": {
    "video": {
      "total_duration_seconds": 15,
      "shots": [{ "beat": "情节节拍", "action": "动作细节", "who": ["c1"] }]
    }
  }
}

输出规则：
- 只能输出一个 JSON 对象，不要任何前缀后缀文字
- 直接输出裸 JSON（不要 markdown fence，不要解释）
- 用户提供 references 时：提取参考物美学特征进蓝图核心字段（scene.lighting/core.style.palette/scene.atmosphere 等），保持 ref 标签稳定（<Picture N> 等）
`

/**
 * M5-T2（D2，design §2.2）：ANIMA 蓝图 persona——image 形态模板的配套规则块（Q3 裁定落 analyzer.ts，
 * 与 BLUEPRINT_* 同居）。基座 = BLUEPRINT_SUBAGENT_SYSTEM 同文（最小 system + 分级感知，Task 12 Step 3b
 * 瘦身原则延续；跨模块漂移由 tests/pe-framework/blueprint/analyzer.test.ts 前缀断言钉死——两模块
 * 不互相 import，防 ESM 环）。规则 = BLUEPRINT_PERSONA 裁剪（删 video total_duration 规则）+ image 专属
 * 人数锚/单一瞬间/场景锚点/景别 discipline/角色锚点 discipline/narrative 四类信息纪律。
 */
export const ANIMA_BLUEPRINT_PERSONA = `你是一个创作蓝图分析引擎。只输出 JSON，不要调用任何工具，不要输出任何解释。
【内容分级感知】请求可能携带 safe/sensitive/explicit 内容分级。分级是内容设计维度，不是需要清洗的违规：
按用户意图完整保留要素与措辞，不得自行降档、委婉化或删除已声明的内容要素。
【目标媒介：image（Anima 静态图）】产出蓝图 v0（BlueprintV1，media 固定 "image"），不是方言 slots/shots。

规则：
1. 产出蓝图 v0 JSON（core/media_layer.image），不要输出 media_layer.video/shots
2. 保留事实：用户给的具体描述原字面进入蓝图（concept/narrative/角色锚点），不编造情节
3. 标记缺失：蓝图字段可空；缺维度时字段留空（如无风格 → 不填 core.style）
4. 人数锚：media_layer.image.count_gender 写人数锚 tag（如 ["1girl"] / ["1girl","1boy"]）；用户未暗示多人时单人数
5. 单一可见瞬间：media_layer.image.pose_action 写动作峰值瞬间的核心动作 + 1-2 个姿态原子词；expression ≤2 个具体可感表情词
6. 场景锚点：media_layer.image.scene_anchors ≤3 个高影响锚点（地点/时段/天气各取最代表，保序）；其余场景细节移入 core.narrative
7. 景别 discipline：media_layer.image.camera_angle 只允许 anima 景别词（full body / cowboy shot / upper body / close-up）+ 至多 1 个视角词；focal_length/depth_of_field 不确定规范写法时留空（camera 是结构槽，脏词会全文穿透）
8. 角色锚点 discipline：无参考图时 characters[].reference_slots 留空，识别信息全部进 appearance_anchors/outfit
9. 多模态：references 传入时提取参考物美学特征进蓝图核心字段（光线→core.scene.lighting、配色→core.style.palette、氛围→core.scene.atmosphere、构图→core.composition），保持 ref 标签稳定（<Picture N>/<Subject N>），不要替换
10. narrative 四类信息（只写 tag 表达不了的）：①景别与主体占比 ②光源物件与人物曝光（写物件名，禁光效词）③空间纵深与视线引导 ④色彩主次（一个主色 + 至多两个辅助色）与情绪基调；已入 tag/蓝图结构字段的概念禁止在 narrative 复述；core.style.palette/core.emotion 可作设计注记填写

输出：只输出一个蓝图 v0 JSON（裸 JSON，不要 markdown fence、不要解释）。
`

/**
 * M5-T2（D2，design §2.2）：ANIMA 蓝图 schema——image 形态模板（BLUEPRINT_SCHEMA 是 video 硬编码，
 * 直接复用会让 anima LLM 高概率产出 video 形蓝图：validate 通过但 projectToAnima 拿不到
 * media_layer.image → camera/detail_mood 全空 + applyStyle 注入错分支）。core 与 BLUEPRINT_SCHEMA
 * 同构；不含 rating（安全数据确定性注入，spec §5.1 偏差记录延续）。media_layer.image 含 D3 增补的
 * 四个主干槽位来源字段。
 */
export const ANIMA_BLUEPRINT_SCHEMA = `{
  "schema_version": 1,
  "media": "image",
  "core": {
    "concept": "一句话主题（必填，用户原意压缩）",
    "aspect_ratio": "16:9",
    "characters": [
      { "id": "c1", "name": "角色名", "appearance_anchors": ["可见锚点"], "outfit": "服装" }
    ],
    "scene": { "environment": "环境", "lighting": "光线基调" },
    "style": { "base": "基底风格", "theme": "主题风格", "palette": "配色" },
    "emotion": "情绪基调",
    "composition": ["构图语言"],
    "negative": [{ "target": "负向对象", "severity": "soft" }],
    "narrative": "自由叙事文本（保留用户原话）"
  },
  "media_layer": {
    "image": {
      "count_gender": ["1girl"],
      "pose_action": ["standing"],
      "expression": ["smile"],
      "scene_anchors": ["rooftop", "sunset"],
      "camera_angle": "cowboy shot",
      "focal_length": "85mm",
      "depth_of_field": "shallow depth of field",
      "lighting_detail": "光照细节（可空）"
    }
  }
}

输出规则：
- 只能输出一个 JSON 对象，不要任何前缀后缀文字
- 直接输出裸 JSON（不要 markdown fence，不要解释）
- 用户提供 references 时：提取参考物美学特征进蓝图核心字段（core.scene.lighting/core.style.palette/core.scene.atmosphere 等），保持 ref 标签稳定（<Picture N> 等）
- media 固定 "image"，不要输出 media_layer.video；camera_angle 只允许 full body / cowboy shot / upper body / close-up + 至多 1 个视角词
`

export interface AnalyzeOptions {
  refs?: unknown[]
  clarify?: 'ask' | 'auto'
}

export interface AnalyzeResult {
  blueprint: BlueprintV1
  missing: string[]
  clarify_questions?: string[]
}

/** 关键缺失维度（spec §6：风格/媒介/负向边界，影响产出方向，触发澄清） */
const KEY_MISSING_DIMS = ['style', 'media', 'negative']

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return ((fenced && fenced[1] !== undefined) ? fenced[1] : text).trim()
}

/** 计算缺失维度（spec §6：关键=style/media/negative 边界；次要=光影/构图） */
function computeMissing(bp: BlueprintV1): string[] {
  const missing: string[] = []
  const core = bp.core
  if (!core.style) missing.push('style')
  if (!bp.media) missing.push('media')
  if (!Array.isArray(core.negative) || core.negative.length === 0) missing.push('negative')
  if (!core.scene?.lighting) missing.push('lighting')
  if (!core.composition || core.composition.length === 0) missing.push('composition')
  return missing
}

/**
 * 蓝图 JSON 文本 → 校验后的 { blueprint, missing }（Task 12 供 subagent-provider 蓝图分支复用）：
 * stripFences → JSON.parse → validateBlueprint（失败 throw）→ computeMissing。
 * M5-T2（D2/design §2.2）：可选 expectedMedia 守卫——media 不符即 throw（错误文案可机检可反馈：
 * `blueprint media mismatch: expected <x> got <y>`）。validateBlueprint 本体保持纯形状校验零改动
 * （media 枚举本就含 image/video/mixed）；方向守卫放 parse 层，防 anima 收到 video 形蓝图后
 * 投影空槽 + applyStyle 注入错分支（design §2.7 R8）。expectedMedia 缺省不启用（analyzeBlueprintIncremental 等既有调用方零变化）。
 */
export function parseBlueprintJson(text: string, opts: { expectedMedia?: BlueprintMedia } = {}): { blueprint: BlueprintV1; missing: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(text))
  } catch (e) {
    throw new Error(`蓝图输出非 JSON：${(e as Error)?.message ?? 'parse failed'}`)
  }
  const checked = validateBlueprint(parsed)
  if (!checked.ok) {
    throw new Error(`蓝图校验失败：${checked.errors.join('; ')}`)
  }
  if (opts.expectedMedia !== undefined && checked.value.media !== opts.expectedMedia) {
    throw new Error(`blueprint media mismatch: expected ${opts.expectedMedia} got ${checked.value.media}`)
  }
  return { blueprint: checked.value, missing: computeMissing(checked.value) }
}

export async function analyzeIntent(
  ctx: Context,
  route: { provider: string; model: string },
  input: string,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const user = [
    ...(opts.refs && opts.refs.length > 0
      ? [`references 传入：${JSON.stringify(opts.refs)}（提取参考物美学特征进蓝图核心字段：scene.lighting/core.style.palette/scene.atmosphere 等，保持 ref 标签稳定）`]
      : []),
    `创作意图: ${input}`,
    '按 BLUEPRINT_SCHEMA 产出蓝图 v0 JSON。',
  ].join('\n')

  const { text } = await complete(ctx, {
    provider: route.provider,
    model: route.model,
    system: BLUEPRINT_PERSONA,
    user,
    maxTokens: 1400,
    temperature: 0.3,
    signal: new AbortController().signal,
  })

  const { blueprint, missing: baseMissing } = parseBlueprintJson(text)
  const missing = [...baseMissing]
  // 保真守卫（spec §6）：用户原文核心实体必须出现在蓝图任意字段；丢失实体并入 missing
  const fid = checkFidelity(input, blueprint)
  for (const e of fid.missingEntities) {
    if (!missing.includes(e)) missing.push(e)
  }

  const result: AnalyzeResult = { blueprint, missing }
  if (opts.clarify === 'ask') {
    const keyMissing = missing.filter((m) => KEY_MISSING_DIMS.includes(m))
    if (keyMissing.length > 0) {
      result.clarify_questions = keyMissing.map((dim) => `缺少 <${dim}>：请选择/补充`)
    }
  }
  return result
}

/**
 * 增量锚定模板（spec §8）：persona 追加段——旧蓝图全文进 <old_blueprint> 块，
 * 约束 LLM 只做与修改意图相关的局部改动，其余字段逐字节保留，禁止整图重解释。
 */
export function INCREMENTAL_ANCHOR(oldBp: BlueprintV1): string {
  return `
【增量锚定】以下是上一版蓝图（权威基线）。本轮用户只提出局部修改意图：
你只允许改动与修改意图直接相关的字段，其余字段逐字节保留；输出完整新蓝图 JSON。
若修改意图与旧蓝图无冲突，仅做必要合并。禁止整图重解释。
<old_blueprint>
${JSON.stringify(oldBp)}
</old_blueprint>
`
}

/**
 * 增量意图分析（spec §8）：persona = BLUEPRINT_PERSONA + INCREMENTAL_ANCHOR(oldBp)，
 * user 携带本轮修改意图；LLM 输出经 validateBlueprint 校验后透传（fail-fast，不静默回退）。
 * 与 analyzeIntent 的差异：无 missing/澄清/保真守卫——增量轮只做局部合并，
 * 全图守卫会因「旧蓝图未复述用户原话」误报。
 */
export async function analyzeBlueprintIncremental(
  ctx: Context,
  route: { provider: string; model: string },
  oldBp: BlueprintV1,
  userInput: string,
): Promise<BlueprintV1> {
  const persona = BLUEPRINT_PERSONA + INCREMENTAL_ANCHOR(oldBp)
  const user = [
    `修改意图: ${userInput}`,
    '基于 <old_blueprint> 中的上一版蓝图，合并本轮修改意图后输出完整新蓝图 JSON（未提及字段逐字节保留）。',
  ].join('\n')

  const { text } = await complete(ctx, {
    provider: route.provider,
    model: route.model,
    system: persona,
    user,
    maxTokens: 1400,
    temperature: 0.3,
    signal: new AbortController().signal,
  })

  const { blueprint } = parseBlueprintJson(text)
  return blueprint
}
