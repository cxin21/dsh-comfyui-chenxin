/**
 * 语义蓝图 v0/v1 schema（spec §3，2026-09-15 管线重设计）：
 * S1 意图蓝图的产出契约——纯英文画面语义，零词表交互（D2）。
 * v1 = v0 + S2 扩写 patch（同型，deepMerge 后结构不变），故单一类型承载。
 */

export interface SemanticSubject {
  id: string
  count: number
  identity: string
  appearance: string
  pose: string
  expression: string
}

export interface SemanticBlueprint {
  schema_version: 1
  media: 'image'
  core: {
    concept: string
    scene: { environment: string; time_of_day: string; weather: string; lighting_idea: string }
    style_hints: string[]
  }
  subjects: SemanticSubject[]
  composition: { framing: string; camera_angle: string; placement: string }
  mood: string
  negative_hints: string[]
}

export type ValidateResult =
  | { ok: true; bp: SemanticBlueprint; missing: string[] }
  | { ok: false; error: string }

function isStr(x: unknown): x is string {
  return typeof x === 'string'
}

/**
 * tag 形态判定（spec §3 D3）：snake_case / 1girl 类计数锚 / @artist / score_N。
 * 用于 S1/S2 输出的零词表契约机检（tag_in_blueprint）。
 */
export const TAG_FORM_RE =
  /(^|[\s,;])(\d+\+?(?:girls|boys|girl|boy|other|others)(?=$|[\s,;])|[a-z]+_[a-z]+|@[a-z0-9_]+|score_\d+)/i

export function detectTagForm(text: string): boolean {
  return TAG_FORM_RE.test(text)
}

export function validateSemanticBlueprint(raw: unknown): ValidateResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'blueprint must be a JSON object' }
  }
  const bp = raw as Record<string, unknown>
  if (bp.schema_version !== 1) return { ok: false, error: 'schema_version must be 1' }
  if (bp.media !== 'image') return { ok: false, error: `media must be "image", got ${JSON.stringify(bp.media)}` }

  const core = bp.core
  if (core === null || typeof core !== 'object') return { ok: false, error: 'core missing' }
  const c = core as Record<string, unknown>
  if (!isStr(c.concept) || c.concept.trim() === '') return { ok: false, error: 'core.concept missing/empty' }
  const scene = c.scene
  if (scene === null || typeof scene !== 'object') return { ok: false, error: 'core.scene missing' }
  const sc = scene as Record<string, unknown>
  for (const k of ['environment', 'time_of_day', 'weather', 'lighting_idea'] as const) {
    if (!isStr(sc[k])) return { ok: false, error: `core.scene.${k} must be string` }
  }
  if (c.style_hints !== undefined && (!Array.isArray(c.style_hints) || c.style_hints.some((x) => !isStr(x)))) {
    return { ok: false, error: 'core.style_hints must be string[]' }
  }

  if (!Array.isArray(bp.subjects) || bp.subjects.length === 0) {
    return { ok: false, error: 'subjects must be non-empty array' }
  }
  const ids = new Set<string>()
  for (const s of bp.subjects as Record<string, unknown>[]) {
    if (s === null || typeof s !== 'object') return { ok: false, error: 'subject must be object' }
    for (const k of ['id', 'identity', 'appearance', 'pose', 'expression'] as const) {
      if (!isStr(s[k])) return { ok: false, error: `subject.${k} must be string` }
    }
    if (typeof s.count !== 'number' || !Number.isInteger(s.count) || (s.count as number) < 1) {
      return { ok: false, error: 'subject.count must be positive integer' }
    }
    if (ids.has(s.id as string)) return { ok: false, error: `duplicate subject id: ${s.id}` }
    ids.add(s.id as string)
  }

  const comp = bp.composition
  if (comp === null || typeof comp !== 'object') return { ok: false, error: 'composition missing' }
  const cm = comp as Record<string, unknown>
  for (const k of ['framing', 'camera_angle', 'placement'] as const) {
    if (!isStr(cm[k])) return { ok: false, error: `composition.${k} must be string` }
  }
  if (!isStr(bp.mood) && bp.mood !== undefined) return { ok: false, error: 'mood must be string' }
  if (bp.negative_hints !== undefined && (!Array.isArray(bp.negative_hints) || (bp.negative_hints as unknown[]).some((x) => !isStr(x)))) {
    return { ok: false, error: 'negative_hints must be string[]' }
  }

  // 缺省 advisory 面（非错误）：mood/style_hints 可为空串/空数组——记录供下游推荐先验
  const missing: string[] = []
  if (!isStr(bp.mood) || (bp.mood as string).trim() === '') missing.push('mood')
  if (!Array.isArray(c.style_hints) || (c.style_hints as string[]).length === 0) missing.push('core.style_hints')
  return { ok: true, bp: bp as unknown as SemanticBlueprint, missing }
}
