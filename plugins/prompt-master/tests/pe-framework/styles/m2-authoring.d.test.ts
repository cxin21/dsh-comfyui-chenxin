/**
 * m2-authoring 批 D（T7，NSFW sensitive 6，单成员独立完成）：boudoir /
 * lingerie_fashion / beach_swimwear / pinup_retro / glamour_portrait / after_dark。
 * 性感不露骨（泳装/内衣/私房氛围词，spec §4.4 表 L135-140 种子）；negative_hints 一律
 * explicit nudity 阻断方向；artist_hints 留空数组（NSFW 档收紧裁定，captain/计划 T7 行
 * ——无 catalog 验证需求，与批 A/B 的画师验证流不同）；红线自查：未成年暗示词零容忍
 * （批内显式红线扫描 + 总账 MINOR census 双层把关）。
 * 唯一锚点改写：beach_swimwear 种子「beach sunlight」——'sunlight' 撞 LIGHTING_BAN
 * （光照渲染由 LoRA/控件承接的真光效词），按闸门权威改写「bright beach sun」（海滩
 * 太阳=场景天体/光源物件写法，语义不变）；after_dark 种子「club lighting object」本身
 * 即光源物件写法（俱乐部灯具），不撞任何禁用复合词，保留。批内测试由 T7 独占写入；
 * 总账/共享规则在 m2-authoring.test.ts。
 * style_list 活体 cap 断言设计为计数无关（qualitative + 批相对）：safe 上限不可见本批
 * sensitive 预设、sensitive 上限可见本批且永不见 explicit——跨批次（T8 explicit 落库）
 * 保持成立；精确计数钉在 registry.test/style-list.test 共享夹具随批次递增。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateStylePreset } from '../../../src/pe-framework/styles/schema.js'
import { listStylePresets } from '../../../src/pe-framework/styles/registry.js'
import { registerStyleListTool } from '../../../src/tools/style-list.js'
import { stubCtx, runTool } from '../../plugin/helpers.js'

const here = dirname(fileURLToPath(import.meta.url))
const dir = resolve(here, '../../../assets/style-presets')

const BATCH_D = [
  'boudoir', 'lingerie_fashion', 'beach_swimwear', 'pinup_retro', 'glamour_portrait', 'after_dark',
] as const

const load = (id: string) => JSON.parse(readFileSync(resolve(dir, `${id}.json`), 'utf8'))

/** 锚点方向执行度：spec §4.4 表种子 → 落盘 fragments 必须逐一种子可见（全批 6 条；
 *  beach_swimwear 的 'bright beach sun' 为 LIGHTING_BAN 权威改写形，见头注释） */
const ANCHOR_SPOTS: Record<(typeof BATCH_D)[number], string[]> = {
  boudoir: ['boudoir posing', 'silk sheets', 'intimate interior'],
  lingerie_fashion: ['lingerie set', 'fashion catalogue posing'],
  beach_swimwear: ['one-piece swimsuit', 'bright beach sun', 'sunscreen sheen'],
  pinup_retro: ['retro pin-up pose', 'victory rolls', 'winking gesture'],
  glamour_portrait: ['smoky eyes', 'red lips', 'off-shoulder', 'sultry gaze'],
  after_dark: ['club lighting object', 'cocktail glass', 'party dress'],
}

describe('m2 batch d: glamour sensitive 6 (T7, NSFW)', () => {
  it('per-id v2 schema validation + NSFW contract fields', () => {
    for (const id of BATCH_D) {
      const raw = load(id)
      const r = validateStylePreset(raw)
      if (!r.ok) throw new Error(`${id}: ${r.errors.join('; ')}`)
      expect(r.ok, id).toBe(true)
      const p = r.value
      expect(p.source, id).toBe('hand-authored')
      expect(p.rating, id).toBe('sensitive')
      expect(p.category, id).toBe('glamour_intimate')
      // NSFW 收紧：applies_to 恰为 ['anima']（schema 校验器同规则，此处批内显式钉死）
      expect(p.applies_to, id).toEqual(['anima'])
      // NSFW 收紧裁定：artist_hints 留空数组（质量由 tag 组合承担）
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
  it('anchor-direction fidelity: spec §4.4 seeds visible in fragments (all 6)', () => {
    for (const id of BATCH_D) {
      const p = load(id)
      const frag = `${p.fragments.image} ${p.fragments.video}`.toLowerCase()
      for (const seed of ANCHOR_SPOTS[id]) {
        expect(frag.includes(seed), `${id}: anchor seed "${seed}" not visible`).toBe(true)
      }
    }
  })
  it('negative direction: every preset blocks explicit nudity (spec negative column)', () => {
    for (const id of BATCH_D) {
      const p = load(id)
      expect(
        p.negative_hints.some((n: string) => n.includes('explicit nudity')),
        `${id}: negative_hints 缺 explicit nudity 阻断方向`,
      ).toBe(true)
    }
  })
  it('redline audit: no minor-suggestion words anywhere in batch files (belt+suspenders over ledger census)', () => {
    const redline = ['loli', 'shota', 'child', 'kid', 'teen', 'school', 'underage', 'young', 'minor']
    const hits: string[] = []
    for (const id of BATCH_D) {
      const raw = JSON.stringify(load(id)).toLowerCase()
      for (const w of redline) {
        if (raw.includes(w)) hits.push(`${id} ∋ "${w}"`)
      }
    }
    expect(hits).toEqual([])
  })
  it('batch ids are live in the registry with glamour_intimate/sensitive', () => {
    const loaded = new Map(listStylePresets().map((p) => [p.id, p]))
    for (const id of BATCH_D) {
      const p = loaded.get(id)
      expect(p, `${id} missing from registry`).toBeDefined()
      expect(p!.category, id).toBe('glamour_intimate')
      expect(p!.rating, id).toBe('sensitive')
    }
  })
  it('style_list live cap semantics: sensitive session sees safe+sensitive (this batch), never explicit; safe session never sees this batch', async () => {
    const def = () => registerStyleListTool(null as never, {} as never)
    // sensitive 上限：可见 safe+sensitive（含本批 6 条），永不见 explicit——计数无关设计，
    // T8 explicit 批落库后本断言仍成立（届时 sensitive 上限不含那 4 条）。
    const sensitive = JSON.parse(String(await runTool(stubCtx(), def(), { rating: 'sensitive' })))
    for (const p of sensitive) expect(p.rating, p.id).not.toBe('explicit')
    for (const p of sensitive) expect(['safe', 'sensitive'], p.id).toContain(p.rating)
    const ids = new Set(sensitive.map((p: { id: string }) => p.id))
    for (const id of BATCH_D) expect(ids.has(id), `${id} not visible under sensitive cap`).toBe(true)
    // safe 上限：只返回 safe——本批 sensitive 预设全部不可见（cap 语义活体，非仅枚举过滤）
    const safe = JSON.parse(String(await runTool(stubCtx(), def(), { rating: 'safe' })))
    for (const p of safe) expect(p.rating, p.id).toBe('safe')
    const safeIds = new Set(safe.map((p: { id: string }) => p.id))
    for (const id of BATCH_D) expect(safeIds.has(id), `${id} leaked into safe cap`).toBe(false)
    // explicit 上限：全量可见（cap ≥ sensitive）
    const explicit = JSON.parse(String(await runTool(stubCtx(), def(), { rating: 'explicit' })))
    const explicitIds = new Set(explicit.map((p: { id: string }) => p.id))
    for (const id of BATCH_D) expect(explicitIds.has(id), `${id} missing under explicit cap`).toBe(true)
  })
})
