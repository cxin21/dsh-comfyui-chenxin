/**
 * m2-authoring 批 B（T5）：cg_3d 3 + oriental 2——unreal_render / figure_model /
 * claymation_clay / ink_wash / hanfu_xianxia。
 * 批内逐条 validateStylePreset + 锚点方向执行度抽查（spec §4.4 表 L125-129 种子 → 具体名词短语）
 * + artist_hints catalog 验证 provenance（验证时点 2026-09-13，impl-2 逐条跑 catalog_search，
 * 均为 canonical grounded、非 fuzzy 候选）。总账/共享规则在 m2-authoring.test.ts；
 * 本文件由 T5 独占写入。
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
 *  wlop→@wlop(1299120) / greg rutkowski→@greg rutkowski(389496) / simon stalenhag→@simon
 *  stalenhag(1093412) / aardman→aardman(28036) / hokusai→@hokusai(452301) / anmi→@anmi(75427) /
 *  ask (askzy)→@ask (askzy)(102263)。
 *  验证未过（miss / fuzzy-only）：xu beihong（miss）、good smile company（仅 fuzzy 命中
 *  goodsmile_company，fuzzy_below_threshold 不采纳——figure_model 无 canonical 手办摄影画师，
 *  按规则留空 artist_hints）。 */
const VERIFIED_ARTISTS = new Set([
  'wlop', 'greg rutkowski', 'simon stalenhag', 'aardman', 'hokusai', 'anmi', 'ask (askzy)',
])

const BATCH_B = ['unreal_render', 'figure_model', 'claymation_clay', 'ink_wash', 'hanfu_xianxia'] as const

const load = (id: string) => JSON.parse(readFileSync(resolve(dir, `${id}.json`), 'utf8'))

/** 锚点方向执行度：spec §4.4 表种子 → 落盘 fragments 必须逐一种子可见（全批 5 条）。
 *  唯一改写：unreal_render 种子「cinematic engine render」——'cinematic' 撞 VAGUE 具名词表
 *  （M2 Global 3 数据闸门），按闸门权威改写为「real-time engine render」（方向不变：
 *  引擎渲染感由 lumen/nanite/ray-traced 具体承载）。 */
const ANCHOR_SPOTS: Record<(typeof BATCH_B)[number], string[]> = {
  unreal_render: ['lumen global illumination', 'nanite', 'real-time engine render', 'ray-traced reflections'],
  figure_model: ['pvc figure', 'glossy coat', 'display base'],
  claymation_clay: ['clay texture', 'fingerprint marks', 'stop motion feel'],
  ink_wash: ['ink wash painting', 'brush splashes', 'negative space rice paper'],
  hanfu_xianxia: ['flowing hanfu', 'ribbon sleeves', 'immortal mist peaks'],
}

const CATEGORY: Record<(typeof BATCH_B)[number], string> = {
  unreal_render: 'cg_3d',
  figure_model: 'cg_3d',
  claymation_clay: 'cg_3d',
  ink_wash: 'oriental',
  hanfu_xianxia: 'oriental',
}

describe('m2 batch b: cg_3d 3 + oriental 2 (T5)', () => {
  it('per-id v2 schema validation + authoring contract fields', () => {
    for (const id of BATCH_B) {
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
    for (const id of BATCH_B) {
      const p = load(id)
      const frag = `${p.fragments.image} ${p.fragments.video}`.toLowerCase()
      for (const seed of ANCHOR_SPOTS[id]) {
        expect(frag.includes(seed), `${id}: anchor seed "${seed}" not visible`).toBe(true)
      }
    }
  })
  it('negative_hints oppose the spec §4.4 negative direction (per-id)', () => {
    const NEGATIVE_SEEDS: Record<(typeof BATCH_B)[number], string> = {
      unreal_render: 'flat shading',
      figure_model: '2d lineart',
      claymation_clay: 'smooth render',
      ink_wash: 'heavy saturation',
      hanfu_xianxia: 'modern clothing',
    }
    for (const id of BATCH_B) {
      const p = load(id)
      expect(p.negative_hints.some((n: string) => n.includes(NEGATIVE_SEEDS[id])), `${id}: negative seed "${NEGATIVE_SEEDS[id]}" absent`).toBe(true)
    }
  })
  it('batch ids are live in the registry (count assertion stays at T8 total ledger)', () => {
    const loaded = new Map(listStylePresets().map((p) => [p.id, p]))
    for (const id of BATCH_B) {
      const p = loaded.get(id)
      expect(p, `${id} missing from registry`).toBeDefined()
      expect(p!.category, id).toBe(CATEGORY[id])
    }
  })
})
