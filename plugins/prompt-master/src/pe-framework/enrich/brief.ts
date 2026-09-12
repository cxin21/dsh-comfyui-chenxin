/**
 * EnrichedBrief schema + 校验（spec §2.2, §11.2）。
 *
 * 七维度结构化创作 brief：每个维度条目带 source（'user'=用户显式指定硬约束 | 'enriched'=自由发挥补全），
 * nameAnchors 承载角色名词英文锚定（spec §4）。大小硬上限（spec §11.2）：每维 ≤6 条、单条 ≤200 字符，
 * 超限 → ok:false reason='brief_too_large'，**不静默截断**（截断可能丢 user 来源字段）。
 * Round8 T3Q：可选 artDirection 承载所选艺术指导卡片 id（5 类，见 enrich/art-direction.ts）——
 * 存在的 id 须在对应卡组中，否则 ok:false reason='invalid_art_direction'（与 brief_too_large 同款整体降级，不静默修补）。
 */

import { isKnownCardId, type ArtDirectionField } from './art-direction.js'

export type BriefItem = { text: string; source: 'user' | 'enriched' }

/** Round8 T3Q：所选艺术指导卡片 id（值须为对应类目卡组中的卡片 id；字段全部可选） */
export interface ArtDirectionSelection {
  perspective?: string
  composition?: string
  lighting?: string
  color?: string
  motion?: string
}

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
  artDirection?: ArtDirectionSelection
}

export const BRIEF_MAX_ITEMS_PER_DIM = 6
export const BRIEF_MAX_TEXT_LEN = 200

const DIMENSIONS = ['subject', 'scene', 'composition', 'lighting', 'color', 'style', 'mood'] as const

const ART_DIRECTION_KEYS: readonly ArtDirectionField[] = ['perspective', 'composition', 'lighting', 'color', 'motion']

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
  // Round8 T3Q：artDirection 可选——出现即逐字段校验（未选字段忽略；未知/跨类目/非串 id → 整体 invalid_art_direction）
  let artDirection: ArtDirectionSelection | undefined
  const rawAd = raw['artDirection']
  if (rawAd !== undefined) {
    if (!isPlainObject(rawAd)) return fail('invalid_art_direction')
    const sel: ArtDirectionSelection = {}
    for (const field of ART_DIRECTION_KEYS) {
      const v = rawAd[field]
      if (v === undefined) continue
      if (typeof v !== 'string' || !isKnownCardId(field, v)) return fail('invalid_art_direction')
      sel[field] = v
    }
    if (ART_DIRECTION_KEYS.some((field) => sel[field] !== undefined)) artDirection = sel
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
      ...(artDirection ? { artDirection } : {}),
    },
  }
}
