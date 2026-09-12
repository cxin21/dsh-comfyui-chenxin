/**
 * m2-authoring 批 C（T6）：dark_supernatural 2 + retro 2 + graphic 1——gothic_vampire /
 * eldritch_horror / showa_retro / vintage_photo / poster_constructivist。
 * 批内逐条 validateStylePreset + 锚点方向执行度抽查（spec §4.4 表 L130-134 种子 → 具体名词短语）
 * + artist_hints catalog 验证 provenance（验证时点 2026-09-13，impl-1 逐条跑 catalog_search，
 * 均为 canonical grounded、非 fuzzy 候选）。总账/共享规则在 m2-authoring.test.ts；
 * 本文件由 T6 独占写入。
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
 *  本批新增 5 名：abigail larson→@abigail larson(29397) / alphonse mucha→@alphonse mucha(58901) /
 *  gustave dore→@gustave dore(397092) / edward gorey→edward gorey(288947) /
 *  terada katsuya→@terada katsuya(1183599)。
 *  复用已验证池（批 A a.test / 批 B b.test 各自 rec 号留痕）：greg rutkowski(389496) /
 *  loundraw(665973) / ross tran(998912) / wlop(1299120) / loish(661432) / mika pikazo(735625)。
 *  验证未过（miss / fuzzy-only）：mary blair（仅 fuzzy 'blair'）、katsuhiro otomo（仅 fuzzy
 *  otomo_katsuhiro_(style)）、egon schiele（仅 fuzzy egon_spengler）——均 fuzzy_below_threshold 不采纳。 */
const VERIFIED_ARTISTS = new Set([
  'abigail larson', 'alphonse mucha', 'gustave dore', 'edward gorey', 'terada katsuya',
  'greg rutkowski', 'loundraw', 'ross tran', 'wlop', 'loish', 'mika pikazo',
])

const BATCH_C = [
  'gothic_vampire', 'eldritch_horror', 'showa_retro', 'vintage_photo', 'poster_constructivist',
] as const

const load = (id: string) => JSON.parse(readFileSync(resolve(dir, `${id}.json`), 'utf8'))

/** 锚点方向执行度：spec §4.4 表种子 → 落盘 fragments 必须逐一种子可见（全批 5 条）。
 *  两处改写（spec 种子自撞 LIGHTING_BAN，按闸门权威改写、方向不变，t50 先例）：
 *  ① gothic_vampire 种子「candlelit chandelier object」——'candlelit' 是 LIGHTING_BAN 词表
 *     成员，改写为「candle chandelier」光源物件写法（candle chandelier 不含 banned 子串）；
 *  ② vintage_photo 种子「sepia tone」——'sepia' 是 LIGHTING_BAN 词表成员，改写为
 *     「yellowed brown monochrome print」（老照片暖褪色方向由 yellowed brown 具体承载）。 */
const ANCHOR_SPOTS: Record<(typeof BATCH_C)[number], string[]> = {
  gothic_vampire: ['gothic cathedral architecture', 'candle chandelier', 'pale skin', 'victorian lace'],
  eldritch_horror: ['non-euclidean geometry', 'tentacular silhouettes', 'abyssal palette'],
  showa_retro: ['showa era cityscape', 'retro anime color dot tone'],
  vintage_photo: ['yellowed brown monochrome print', 'faded edges', 'analog film damage'],
  poster_constructivist: ['constructivist poster', 'bold geometric blocks', 'propaganda print style'],
}

const CATEGORY: Record<(typeof BATCH_C)[number], string> = {
  gothic_vampire: 'dark_supernatural',
  eldritch_horror: 'dark_supernatural',
  showa_retro: 'retro',
  vintage_photo: 'retro',
  poster_constructivist: 'graphic',
}

describe('m2 batch c: dark 2 + retro 2 + graphic 1 (T6)', () => {
  it('per-id v2 schema validation + authoring contract fields', () => {
    for (const id of BATCH_C) {
      const raw = load(id)
      const r = validateStylePreset(raw)
      if (!r.ok) throw new Error(`${id}: ${r.errors.join('; ')}`)
      expect(r.ok, id).toBe(true)
      const p = r.value
      expect(p.source, id).toBe('hand-authored')
      expect(p.applies_to, id).toEqual(['anima', 'h3', 'sd'])
      expect(p.rating, id).toBe('safe')
      expect(p.category, id).toBe(CATEGORY[id])
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
  it('anchor-direction fidelity: spec §4.4 seeds visible in fragments (all 5)', () => {
    for (const id of BATCH_C) {
      const p = load(id)
      const frag = `${p.fragments.image} ${p.fragments.video}`.toLowerCase()
      for (const seed of ANCHOR_SPOTS[id]) {
        expect(frag.includes(seed), `${id}: anchor seed "${seed}" not visible`).toBe(true)
      }
    }
  })
  it('negative_hints oppose the spec §4.4 negative direction (per-id)', () => {
    const NEGATIVE_SEEDS: Record<(typeof BATCH_C)[number], string> = {
      gothic_vampire: 'bright daylight',
      eldritch_horror: 'cheerful tones',
      showa_retro: 'modern digital look',
      vintage_photo: 'hdr clarity',
      poster_constructivist: 'photorealism',
    }
    for (const id of BATCH_C) {
      const p = load(id)
      expect(p.negative_hints.some((n: string) => n.includes(NEGATIVE_SEEDS[id])), `${id}: negative seed "${NEGATIVE_SEEDS[id]}" absent`).toBe(true)
    }
  })
  it('batch ids are live in the registry (count assertion stays at T8 total ledger)', () => {
    const loaded = new Map(listStylePresets().map((p) => [p.id, p]))
    for (const id of BATCH_C) {
      const p = loaded.get(id)
      expect(p, `${id} missing from registry`).toBeDefined()
      expect(p!.category, id).toBe(CATEGORY[id])
    }
  })
})
