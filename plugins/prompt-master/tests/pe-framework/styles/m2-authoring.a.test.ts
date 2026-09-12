/**
 * m2-authoring 批 A（T4）：photography 7 条——film_photography / studio_portrait /
 * documentary_photo / fashion_editorial / night_street / sports_action / wildlife_nature。
 * 批内逐条 validateStylePreset + 锚点方向执行度抽查（spec §4.4 表种子 → 具体名词短语）
 * + artist_hints catalog 验证 provenance（验证时点 2026-09-13，均 canonical grounded）。
 * 总账/共享规则在 m2-authoring.test.ts；本文件由 T4 独占写入。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateStylePreset } from '../../../src/pe-framework/styles/schema.js'
import { listStylePresets } from '../../../src/pe-framework/styles/registry.js'

const here = dirname(fileURLToPath(import.meta.url))
const dir = resolve(here, '../../../assets/style-presets')

/** catalog_search 验证留痕（authoring 时点逐条跑过，全部 canonical grounded、非 fuzzy 候选）：
 *  wlop→@wlop(rec 1299120) / guweiz→@guweiz(397364) / artgerm→artgerm(94714) /
 *  greg rutkowski→@greg rutkowski(389496) / loundraw→@loundraw(665973) /
 *  mika pikazo→@mika pikazo(735625) / ross tran→@ross tran(998912) / loish→@loish(661432) /
 *  ask (askzy)→@ask (askzy)(102263)。
 *  验证未过（miss/fuzzy）：annieleibovitz、steve mccurry、daido moriyama、saul leiter、
 *  krenz cushart、erik johansson、brook shaden——一律不采用。 */
const VERIFIED_ARTISTS = new Set([
  'wlop', 'guweiz', 'artgerm', 'greg rutkowski', 'loundraw', 'mika pikazo', 'ross tran', 'loish', 'ask (askzy)',
])

const BATCH_A = [
  'film_photography', 'studio_portrait', 'documentary_photo',
  'fashion_editorial', 'night_street', 'sports_action', 'wildlife_nature',
] as const

const load = (id: string) => JSON.parse(readFileSync(resolve(dir, `${id}.json`), 'utf8'))

/** 锚点方向执行度：spec §4.4 表种子 → 落盘 fragments 必须逐一种子可见（抽全批 7 条） */
const ANCHOR_SPOTS: Record<(typeof BATCH_A)[number], string[]> = {
  film_photography: ['film grain', 'kodak portra', 'halation', '35mm'],
  studio_portrait: ['seamless paper backdrop', 'softbox key light', 'catchlight'],
  documentary_photo: ['candid unposed moment', 'window light', 'photojournalistic'],
  fashion_editorial: ['editorial pose', 'haute couture', 'glossy magazine'],
  night_street: ['neon signage reflections', 'wet asphalt', 'handheld night street'],
  sports_action: ['motion-blurred', 'panning shot', 'sweat droplets'],
  wildlife_nature: ['telephoto compression', 'natural habitat', 'golden hour ambience'],
}

describe('m2 batch a: photography 7 (T4)', () => {
  it('per-id v2 schema validation + authoring contract fields', () => {
    for (const id of BATCH_A) {
      const raw = load(id)
      const r = validateStylePreset(raw)
      if (!r.ok) throw new Error(`${id}: ${r.errors.join('; ')}`)
      expect(r.ok, id).toBe(true)
      const p = r.value
      expect(p.source, id).toBe('hand-authored')
      expect(p.applies_to, id).toEqual(['anima', 'h3', 'sd'])
      expect(p.rating, id).toBe('safe')
      expect(p.category, id).toBe('photography')
      expect(p.artist_max <= 3, id).toBe(true)
      for (const a of p.artist_hints) {
        expect(VERIFIED_ARTISTS.has(a), `${id}: artist "${a}" not catalog-verified`).toBe(true)
      }
      for (const ch of ['image', 'video'] as const) {
        const phrases = p.fragments[ch].split(',').map((s) => s.trim()).filter(Boolean)
        expect(phrases.length, `${id}.${ch} phrase count`).toBeGreaterThanOrEqual(2)
        expect(phrases.length, `${id}.${ch} phrase count`).toBeLessThanOrEqual(4)
      }
      expect(p.negative_hints.length, id).toBeGreaterThanOrEqual(1)
    }
  })
  it('anchor-direction fidelity: spec §4.4 seeds visible in fragments (all 7)', () => {
    for (const id of BATCH_A) {
      const p = load(id)
      const frag = `${p.fragments.image} ${p.fragments.video}`.toLowerCase()
      for (const seed of ANCHOR_SPOTS[id]) {
        expect(frag.includes(seed), `${id}: anchor seed "${seed}" not visible`).toBe(true)
      }
    }
  })
  it('batch ids are live in the registry (count assertion stays at T8 total ledger)', () => {
    const loaded = new Map(listStylePresets().map((p) => [p.id, p]))
    for (const id of BATCH_A) {
      const p = loaded.get(id)
      expect(p, `${id} missing from registry`).toBeDefined()
      expect(p!.category, id).toBe('photography')
    }
  })
})
