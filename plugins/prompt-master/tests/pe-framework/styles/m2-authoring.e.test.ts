/**
 * m2-authoring 批 E（T8，NSFW explicit 4，单成员独立完成）+ 库总账收口：artistic_nude /
 * explicit_solo / explicit_couple / explicit_fantasy。
 * fragments 成人向直白词——spec §4.4 表 L141-144 种子，具体 explicit 词全部经 catalog_search
 * 验证 canonical 存在后采用（禁委婉语禁生造词）；artist_hints 留空（NSFW 收紧裁定同批 D）；
 * negative_hints 照表（minors traits 等——负向命名阻断对象属政策必需，正向字段红线另扫）。
 * 硬边界红线：零未成年/非自愿/兽类语义——批内红线审计（正向字段）+ 总账 MINOR census 双层
 * + 提交前人工自查（提交信息留痕）。
 * 收口总账断言（T8 交付）：stylePresetCount()===82、类别总账十类（spec L146）、style_list
 * explicit cap 活体（explicit 全量 82 / sensitive 78 隔离 explicit / safe 72 隔离 D+E）。
 * 本文件由 T8 独占写入；总账/共享规则在 m2-authoring.test.ts（本批落库后 27/27 归零，
 * 全量 0 failed 首次达成）。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateStylePreset } from '../../../src/pe-framework/styles/schema.js'
import { listStylePresets, stylePresetCount } from '../../../src/pe-framework/styles/registry.js'
import { registerStyleListTool } from '../../../src/tools/style-list.js'
import { stubCtx, runTool } from '../../plugin/helpers.js'

const here = dirname(fileURLToPath(import.meta.url))
const dir = resolve(here, '../../../assets/style-presets')

/** catalog_search 验证留痕（authoring 时点 impl-2 逐条跑，全部 canonical grounded 非 fuzzy，
 *  usage_count 为权威佐证）：nude(855732, 1186329) / bottomless(158082, 210870) /
 *  nipples(839884, 1701428) / spread legs(1122681, 546869) / all fours(57268, 111180) /
 *  hetero(433943, 895429) / sex(1055538, 785810) / missionary(752532, 76473) /
 *  vaginal(1264121, 529879) / masturbation(707957, 90144) / elf(294936, 105333) /
 *  pointed ears(926949, 472) / uncensored(1243787, 442601)。
 *  采纳集：nude/nipples/spread legs/hetero/sex/missionary/vaginal/elf/pointed ears/uncensored
 *  （bottomless/all fours/masturbation 验证在案本批未用到，留作后续扩表）。
 *  非 explicit 词（spec 种子/政策词/场景词，无 catalog 验证要求）：artistic nude、classical
 *  sculpture pose、draped fabric、solo female、adult body type、consensual（政策词，禁生造但
 *  非 explicit 词汇）；'heterosexual couple' 种子按 catalog 形态采用 'hetero couple'（hetero
 *  为 canonical，载体合规注释钉死）。 */
const VERIFIED_EXPLICIT = new Set([
  'nude', 'nipples', 'spread legs', 'hetero', 'sex', 'missionary', 'vaginal', 'elf', 'pointed ears', 'uncensored',
])

const BATCH_E = ['artistic_nude', 'explicit_solo', 'explicit_couple', 'explicit_fantasy'] as const

const load = (id: string) => JSON.parse(readFileSync(resolve(dir, `${id}.json`), 'utf8'))

/** 锚点方向执行度：spec §4.4 表种子 → 落盘 fragments 必须逐一种子（或其 catalog 合规载体）可见 */
const ANCHOR_SPOTS: Record<(typeof BATCH_E)[number], string[]> = {
  artistic_nude: ['artistic nude', 'classical sculpture pose', 'draped fabric'],
  explicit_solo: ['solo female', 'adult body type', 'nude', 'uncensored'],
  explicit_couple: ['hetero couple', 'consensual', 'sex', 'missionary'],
  explicit_fantasy: ['adult elf', 'pointed ears', 'nude', 'uncensored'],
}

describe('m2 batch e: glamour explicit 4 + library ledger 82 (T8, NSFW)', () => {
  it('per-id v2 schema validation + NSFW explicit contract fields', () => {
    for (const id of BATCH_E) {
      const raw = load(id)
      const r = validateStylePreset(raw)
      if (!r.ok) throw new Error(`${id}: ${r.errors.join('; ')}`)
      expect(r.ok, id).toBe(true)
      const p = r.value
      expect(p.source, id).toBe('hand-authored')
      expect(p.rating, id).toBe('explicit')
      expect(p.category, id).toBe('glamour_intimate')
      // NSFW 收紧：applies_to 恰为 ['anima']（schema 校验器同规则，批内显式钉死）
      expect(p.applies_to, id).toEqual(['anima'])
      // NSFW 收紧裁定：artist_hints 留空数组
      expect(p.artist_hints, `${id}: NSFW 档 artist_hints 必须留空`).toEqual([])
      expect(p.artist_max <= 3, id).toBe(true)
      for (const ch of ['image', 'video'] as const) {
        const phrases = p.fragments[ch].split(',').map((s) => s.trim()).filter(Boolean)
        expect(phrases.length, `${id}.${ch} phrase count`).toBeGreaterThanOrEqual(2)
        expect(phrases.length, `${id}.${ch} phrase count`).toBeLessThanOrEqual(4)
      }
      expect(p.negative_hints.length, id).toBeGreaterThanOrEqual(1)
    }
  })
  it('explicit vocabulary is catalog-verified canonical (no euphemism, no invented words)', () => {
    // 直白词门槛（分档）：artistic_nude 为古典美术向，spec 种子本意克制——≥1（nude）；
    // 其余三条为直白向——≥2。政策词（consensual 等）与 spec 场景种子不计入（分工见头注释）。
    const THRESHOLD: Record<(typeof BATCH_E)[number], number> = {
      artistic_nude: 1, explicit_solo: 2, explicit_couple: 2, explicit_fantasy: 2,
    }
    for (const id of BATCH_E) {
      const p = load(id)
      const frag = `${p.fragments.image}`.toLowerCase()
      const explicitHits = [...VERIFIED_EXPLICIT].filter((w) => frag.includes(w))
      expect(explicitHits.length, `${id}: explicit canonical 词数不足（${explicitHits.join(',')}）`).toBeGreaterThanOrEqual(THRESHOLD[id])
    }
  })
  it('anchor-direction fidelity: spec §4.4 seeds visible in fragments (all 4)', () => {
    for (const id of BATCH_E) {
      const p = load(id)
      const frag = `${p.fragments.image} ${p.fragments.video}`.toLowerCase()
      for (const seed of ANCHOR_SPOTS[id]) {
        expect(frag.includes(seed), `${id}: anchor seed "${seed}" not visible`).toBe(true)
      }
    }
  })
  it('negative direction: minors traits blocking per spec (artistic_nude adds grotesque)', () => {
    for (const id of BATCH_E) {
      const p = load(id)
      expect(
        p.negative_hints.some((n: string) => n.includes('minors traits')),
        `${id}: negative_hints 缺 minors traits 阻断方向`,
      ).toBe(true)
    }
    expect(load('artistic_nude').negative_hints.some((n: string) => n.includes('grotesque'))).toBe(true)
  })
  it('redline audit: zero minor/nonconsent/bestiality semantics in positive-side fields (census + manual double check)', () => {
    // 正向字段（id/name/theme/palette/fragments——negative_hints 除外：负向命名阻断对象属
    // 政策必需，由 negative direction 断言单独把关）；总账 census（m2-authoring.test.ts）
    // 仍全字段扫 MINOR_MARKERS 双层兜底。
    // 匹配语义：ASCII 词用 \b<word>\b 词边界（与 boundaries.ts/总账 census 同源）——
    // 裸子串会把 'draped'∋'rape'（t39 词边界红利同一族）误报成红线命中。
    const redline = ['loli', 'shota', 'child', 'kid', 'teen', 'school', 'underage', 'young', 'infant', 'toddler',
      'rape', 'forced', 'nonconsensual', 'bestiality', 'zoophilia']
    const hits: string[] = []
    for (const id of BATCH_E) {
      const p = load(id) as Record<string, unknown>
      const positiveSide = JSON.stringify({ id: p['id'], name: p['name'], theme: p['theme'], palette: p['palette'], fragments: p['fragments'] }).toLowerCase()
      for (const w of redline) {
        if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(positiveSide)) hits.push(`${id} ∋ "${w}"`)
      }
    }
    expect(hits).toEqual([])
  })
  it('batch ids are live in the registry with glamour_intimate/explicit', () => {
    const loaded = new Map(listStylePresets().map((p) => [p.id, p]))
    for (const id of BATCH_E) {
      const p = loaded.get(id)
      expect(p, `${id} missing from registry`).toBeDefined()
      expect(p!.category, id).toBe('glamour_intimate')
      expect(p!.rating, id).toBe('explicit')
    }
  })
  it('T8 closeout ledger: stylePresetCount()===82 (27 new presets all landed)', () => {
    expect(stylePresetCount()).toBe(82)
  })
  it('T8 closeout category ledger: ten-class taxonomy exact counts (spec §4.4 L146)', () => {
    const all = listStylePresets()
    expect(all.length).toBe(82)
    const counts: Record<string, number> = {}
    for (const p of all) counts[p.category] = (counts[p.category] ?? 0) + 1
    expect(counts).toEqual({
      photography: 8,
      anime: 25,
      illustration: 17,
      cg_3d: 6,
      oriental: 4,
      dark_supernatural: 3,
      scifi_fantasy: 2,
      retro: 3,
      graphic: 4,
      glamour_intimate: 10,
    })
  })
  it('T8 closeout style_list explicit cap live: explicit sees all 82 / sensitive isolates explicit (78) / safe isolates D+E (72)', async () => {
    const def = () => registerStyleListTool(null as never, {} as never)
    const totalIds = new Set(listStylePresets().map((p) => p.id))
    // explicit 上限：全量 82 可见（含本批 4 条）
    const explicit = JSON.parse(String(await runTool(stubCtx(), def(), { rating: 'explicit' })))
    expect(explicit.length).toBe(82)
    const explicitIds = new Set(explicit.map((p: { id: string }) => p.id))
    for (const id of BATCH_E) expect(explicitIds.has(id), `${id} missing under explicit cap`).toBe(true)
    expect(explicitIds).toEqual(totalIds)
    // sensitive 上限：78 = 82 - 4 explicit——本批 4 条不可见（cap 语义活体），批 D 6 条可见
    const sensitive = JSON.parse(String(await runTool(stubCtx(), def(), { rating: 'sensitive' })))
    expect(sensitive.length).toBe(78)
    const sensitiveIds = new Set(sensitive.map((p: { id: string }) => p.id))
    for (const id of BATCH_E) expect(sensitiveIds.has(id), `${id} leaked into sensitive cap`).toBe(false)
    expect(sensitiveIds.has('boudoir')).toBe(true)
    // safe 上限：72 = 82 - 6 D - 4 E——批 D 与批 E 全部不可见
    const safe = JSON.parse(String(await runTool(stubCtx(), def(), { rating: 'safe' })))
    expect(safe.length).toBe(72)
    const safeIds = new Set(safe.map((p: { id: string }) => p.id))
    for (const id of BATCH_E) expect(safeIds.has(id), `${id} leaked into safe cap`).toBe(false)
    expect(safeIds.has('boudoir')).toBe(false)
  })
})
