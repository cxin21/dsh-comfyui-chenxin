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
import { validateBlueprint, type BlueprintV1 } from './schema.js'
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
 */
export function parseBlueprintJson(text: string): { blueprint: BlueprintV1; missing: string[] } {
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
