/**
 * M2 authoring 质量门（总账与共享规则）——T9 骨架（RED 台账）。
 * ①存在性断言由 spec §4.4 新增 27 条清单驱动（RED：当前 0/27 在库），T4-T8 逐批转绿；
 * ②共享规则（MINOR census 空集 / VAGUE 零命中 / LIGHTING_BAN 零命中 / applies_to 规则）
 *   在当前 55 条库即应全绿，并随数据增长持续保持——T8 收口时另由总账断言
 *   stylePresetCount()===82 + 类别总账 + style_list 活体 cap 用例收紧（届时追加）。
 * 各批细则在 m2-authoring.a~e.test.ts（批独立文件，避免多成员并发竞写）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { listStylePresets } from '../../../src/pe-framework/styles/registry.js'
import { MINOR_MARKERS } from '../../../src/pe-framework/safety/boundaries.js'
import { LIGHTING_BAN } from '../../../src/pe-framework/dialect/anima.js'

const here = dirname(fileURLToPath(import.meta.url))
const presetDir = resolve(here, '../../../assets/style-presets')

/** spec §4.4 表（设计文档 118-144 行）逐条台账：id/批次/类别/评级 */
const M2_LEDGER: ReadonlyArray<{ id: string; batch: 'a' | 'b' | 'c' | 'd' | 'e'; category: string; rating: string }> = [
  // 批 A：photography 7（T4）
  { id: 'film_photography', batch: 'a', category: 'photography', rating: 'safe' },
  { id: 'studio_portrait', batch: 'a', category: 'photography', rating: 'safe' },
  { id: 'documentary_photo', batch: 'a', category: 'photography', rating: 'safe' },
  { id: 'fashion_editorial', batch: 'a', category: 'photography', rating: 'safe' },
  { id: 'night_street', batch: 'a', category: 'photography', rating: 'safe' },
  { id: 'sports_action', batch: 'a', category: 'photography', rating: 'safe' },
  { id: 'wildlife_nature', batch: 'a', category: 'photography', rating: 'safe' },
  // 批 B：cg_3d 3 + oriental 2（T5）
  { id: 'unreal_render', batch: 'b', category: 'cg_3d', rating: 'safe' },
  { id: 'figure_model', batch: 'b', category: 'cg_3d', rating: 'safe' },
  { id: 'claymation_clay', batch: 'b', category: 'cg_3d', rating: 'safe' },
  { id: 'ink_wash', batch: 'b', category: 'oriental', rating: 'safe' },
  { id: 'hanfu_xianxia', batch: 'b', category: 'oriental', rating: 'safe' },
  // 批 C：dark 2 + retro 2 + graphic 1（T6）
  { id: 'gothic_vampire', batch: 'c', category: 'dark_supernatural', rating: 'safe' },
  { id: 'eldritch_horror', batch: 'c', category: 'dark_supernatural', rating: 'safe' },
  { id: 'showa_retro', batch: 'c', category: 'retro', rating: 'safe' },
  { id: 'vintage_photo', batch: 'c', category: 'retro', rating: 'safe' },
  { id: 'poster_constructivist', batch: 'c', category: 'graphic', rating: 'safe' },
  // 批 D：glamour sensitive 6（T7，NSFW 单成员完成）
  { id: 'boudoir', batch: 'd', category: 'glamour_intimate', rating: 'sensitive' },
  { id: 'lingerie_fashion', batch: 'd', category: 'glamour_intimate', rating: 'sensitive' },
  { id: 'beach_swimwear', batch: 'd', category: 'glamour_intimate', rating: 'sensitive' },
  { id: 'pinup_retro', batch: 'd', category: 'glamour_intimate', rating: 'sensitive' },
  { id: 'glamour_portrait', batch: 'd', category: 'glamour_intimate', rating: 'sensitive' },
  { id: 'after_dark', batch: 'd', category: 'glamour_intimate', rating: 'sensitive' },
  // 批 E：glamour explicit 4（T8，NSFW 单成员完成）
  { id: 'artistic_nude', batch: 'e', category: 'glamour_intimate', rating: 'explicit' },
  { id: 'explicit_solo', batch: 'e', category: 'glamour_intimate', rating: 'explicit' },
  { id: 'explicit_couple', batch: 'e', category: 'glamour_intimate', rating: 'explicit' },
  { id: 'explicit_fantasy', batch: 'e', category: 'glamour_intimate', rating: 'explicit' },
]

/** 与 boundaries.ts 两级匹配语义镜像（M2 T1）：ASCII \b<marker>\b 'i'；CJK substring。
 *  测试侧镜像沿 LIGHTING_BAN 卡 tag 镜像测试先例——词表单一源仍在 boundaries.ts。 */
const CJK_MARKER_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
function hitsMarker(text: string, marker: string): boolean {
  if (CJK_MARKER_RE.test(marker)) return text.includes(marker)
  return new RegExp(`\\b${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
}
/** 递归收集 JSON 值里的全部字符串叶子（id/name/fragments/artist_hints/… 全字段扫） */
function stringLeaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out)
  else if (v !== null && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) stringLeaves(x, out)
  return out
}

describe('m2 authoring ledger (spec §4.4, 27 presets)', () => {
  it('all 27 new presets exist in the registry (T4-T8 land batch by batch)', () => {
    const loaded = new Map(listStylePresets().map((p) => [p.id, p]))
    const missing = M2_LEDGER.filter((l) => !loaded.has(l.id)).map((l) => l.id)
    expect(missing, `${missing.length}/27 presets not yet authored (T4-T8 逐批转绿)`).toEqual([])
  })
  it('ledgered presets match their spec category/rating as they land', () => {
    const loaded = new Map(listStylePresets().map((p) => [p.id, p]))
    for (const l of M2_LEDGER) {
      const p = loaded.get(l.id)
      if (p === undefined) continue
      expect(p.category, l.id).toBe(l.category)
      expect(p.rating, l.id).toBe(l.rating)
    }
  })
})

describe('m2 authoring shared rules (whole library, keep green as batches land)', () => {
  const files = readdirSync(presetDir).filter((f) => f.endsWith('.json'))
  const presets = files.map((f) => ({ file: f, data: JSON.parse(readFileSync(resolve(presetDir, f), 'utf8')) as Record<string, unknown> }))

  it('MINOR census: zero minor-marker hits across all preset fields (two-tier semantics)', () => {
    const hits: string[] = []
    for (const { file, data } of presets) {
      for (const text of stringLeaves(data)) {
        for (const m of MINOR_MARKERS) {
          if (hitsMarker(text, m)) hits.push(`${file}: "${text}" ∋ ${m}`)
        }
      }
    }
    expect(hits).toEqual([])
  })
  it('VAGUE words zero hits in fragments across the whole library', () => {
    // M2 Global 3 具名词表（cinematic/beautiful/大气/电影感）——authoring 数据闸门；
    // 运行期具体性检查仍用 aesthetics/check.ts 完整 10 词表，两者分工不混。
    const vague = ['cinematic', 'beautiful', '大气', '电影感']
    const hits: string[] = []
    for (const { file, data } of presets) {
      const frag = data['fragments'] as { image?: string; video?: string } | undefined
      for (const text of [frag?.image ?? '', frag?.video ?? '']) {
        const low = text.toLowerCase()
        for (const w of vague) {
          if (low.includes(w)) hits.push(`${file}: fragments ∋ "${w}"`)
        }
      }
    }
    expect(hits).toEqual([])
  })
  it('LIGHTING_BAN zero hits in fragments across the whole library', () => {
    const hits: string[] = []
    for (const { file, data } of presets) {
      const frag = data['fragments'] as { image?: string; video?: string } | undefined
      for (const text of [frag?.image ?? '', frag?.video ?? '']) {
        const low = text.toLowerCase()
        for (const b of LIGHTING_BAN) {
          if (low.includes(b)) hits.push(`${file}: fragments ∋ LIGHTING_BAN "${b}"`)
        }
      }
    }
    expect(hits).toEqual([])
  })
  it('sensitive/explicit presets apply to anima only (spec §4.1 schema rule)', () => {
    for (const { file, data } of presets) {
      const rating = data['rating'] as string | undefined
      if (rating === 'sensitive' || rating === 'explicit') {
        expect(data['applies_to'], `${file} rating=${rating}`).toEqual(['anima'])
      }
    }
  })
})
