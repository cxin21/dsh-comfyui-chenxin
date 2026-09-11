/**
 * EnrichedBrief schema + 校验（spec §2.2, §11.2）。
 *
 * 七维度结构化创作 brief：每个维度条目带 source（'user'=用户显式指定硬约束 | 'enriched'=自由发挥补全），
 * nameAnchors 承载角色名词英文锚定（spec §4）。大小硬上限（spec §11.2）：每维 ≤6 条、单条 ≤200 字符，
 * 超限 → ok:false reason='brief_too_large'，**不静默截断**（截断可能丢 user 来源字段）。
 */

export type BriefItem = { text: string; source: 'user' | 'enriched' }

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
}

export const BRIEF_MAX_ITEMS_PER_DIM = 6
export const BRIEF_MAX_TEXT_LEN = 200

const DIMENSIONS = ['subject', 'scene', 'composition', 'lighting', 'color', 'style', 'mood'] as const

const OUTPUT_LANGS = new Set(['en', 'zh', 'ja'])

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validItem(v: unknown): v is BriefItem {
  return isPlainObject(v)
    && typeof v['text'] === 'string'
    && (v['source'] === 'user' || v['source'] === 'enriched')
}

/** 校验 EnrichedBrief：形状不合 → ok:false（描述性 reason）；任一大小超限 → reason='brief_too_large'（不截断）。 */
export function validateBrief(raw: unknown): { ok: true; brief: EnrichedBrief } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return fail('invalid_shape:not_an_object')
  const lang = raw['outputLang']
  if (typeof lang !== 'string' || !OUTPUT_LANGS.has(lang)) return fail('invalid_outputLang')
  for (const dim of DIMENSIONS) {
    const arr = raw[dim]
    if (!Array.isArray(arr)) return fail(`invalid_dim:${dim}`)
    if (arr.length > BRIEF_MAX_ITEMS_PER_DIM) return fail('brief_too_large')
    for (const it of arr) {
      if (!validItem(it)) return fail(`invalid_item:${dim}`)
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
    },
  }
}
