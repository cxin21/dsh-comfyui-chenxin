import { describe, expect, it, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileAnima, auditAnima, applyRelationOverlay, overlayAdvisory, isExplicitRequest, variantPolicy } from '../../src/pe-framework/dialect/anima.js'
import { searchCatalog, closeCatalog, overlayStatus } from '../../src/pe-framework/dialect/anima-catalog.js'
import { setOverlayPath } from '../../src/pe-framework/anima-knowledge/relations.js'

let tmp: string

beforeEach(() => {
  // O2 隔离：overlay-degrade 断言不依赖环境残留——注入保证不存在的临时 overlay 路径
  tmp = mkdtempSync(join(tmpdir(), 'pm-ovl-'))
  setOverlayPath(join(tmp, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite'))
})

afterEach(() => {
  setOverlayPath('')
  rmSync(tmp, { recursive: true, force: true })
})
import { SLOT_ORDER } from '../../src/pe-framework/anima.js'

const realSearch = (t: string) => searchCatalog(t, { limit: 5 })

describe('anima compile (anima.ts P2 core)', () => {
  it('variant policy injection: base adds score_7 + safety seed', () => {
    const r = compileAnima({ count_gender: ['1girl'], appearance: ['long hair'] }, { variant: 'base', search: realSearch })
    expect(r.positive).toBe('masterpiece, best quality, score_7, safe, 1girl, long hair')
    expect(r.negative).toBe('worst quality, low quality, score_1, score_2, score_3')
  })

  it('aesthetic drops score_7 and score_1..3', () => {
    const r = compileAnima({ count_gender: ['1girl'] }, { variant: 'aesthetic', search: realSearch })
    expect(r.positive).toBe('masterpiece, best quality, safe, 1girl')
    expect(r.negative).toBe('worst quality, low quality')
  })

  it('turbo mirrors aesthetic policy terms', () => {
    const p = variantPolicy('turbo')
    expect(p.mandatoryPositive).toEqual(['masterpiece', 'best quality'])
    expect(p.mandatoryNegative).toEqual(['worst quality', 'low quality'])
  })

  it('explicit drops the safety seed', () => {
    const r = compileAnima({ count_gender: ['1girl'], explicit: true }, { variant: 'base', search: realSearch })
    expect(r.positive).not.toContain('safe')
    expect(r.assumptions).not.toContain('safety_seed_injected:default_for_non_explicit_request')
  })

  it('narrative is emitted last after all slot tags', () => {
    const r = compileAnima({ count_gender: ['1girl'], scene: ['ruins'], narrative: 'she walks away.' }, { variant: 'base', search: realSearch })
    expect(r.positive.endsWith('ruins, she walks away.')).toBe(true)
  })

  it('exclusions go verbatim to negative channel', () => {
    const r = compileAnima({ count_gender: ['1girl'], exclusions: ['no text', 'no watermark'] }, { variant: 'base', search: realSearch })
    expect(r.negative).toContain('worst quality')
    expect(r.negative.endsWith('no text, no watermark')).toBe(true)
  })

  it('SLOT_ORDER emitted in fixed front-weight order regardless of brief field order', () => {
    const r = compileAnima(
      { scene: ['night'], expression: ['smile'], count_gender: ['solo'] },
      { variant: 'base', search: realSearch },
    )
    const idxSolo = r.positive.indexOf('solo')
    const idxSmile = r.positive.indexOf('smile')
    const idxNight = r.positive.indexOf('night')
    expect(idxSolo).toBeGreaterThan(-1)
    expect(idxSmile).toBeGreaterThan(idxSolo)
    expect(idxNight).toBeGreaterThan(idxSmile)
    expect(SLOT_ORDER[0]).toBe('count_gender')
  })

  it('quality_prefix false skips policy terms', () => {
    const r = compileAnima({ count_gender: ['1girl'], qualityPrefix: false }, { variant: 'base', search: realSearch })
    expect(r.positive).toBe('safe, 1girl')
  })

  it('silver hair regression (A14): fuzzy miss preserves original text + advisory suggests candidates', () => {
    const slots = { appearance: ['silver hair'] }
    const r = compileAnima(slots, { variant: 'base', search: realSearch })
    expect(r.positive).toContain('silver hair')                       // 保留原文
    expect(r.positive).not.toContain('silver_hairband')               // 不自动替换
    expect(r.assumptions).toContain('catalog_miss:silver hair')
    const gates = auditAnima(r.positive, r.negative, { variant: 'base', search: realSearch, slots })
    const miss = gates.find((g) => g.rule === 'catalog_miss')
    expect(miss).toBeTruthy()
    expect(miss!.detail).toContain('silver hair')
    expect(miss!.detail).toContain('silvery hair')                    // 候选建议（catalog fuzzy 顶层含 silvery hair）
  })

  it('fuzzy and miss both preserve original text (no auto substitution)', () => {
    const r = compileAnima({ expression: ['expression'], character: ['zzzzzzzzq'] }, { variant: 'base', search: realSearch })
    expect(r.positive).toContain('expression')
    expect(r.positive).toContain('zzzzzzzzq')
    expect(r.assumptions).toContain('catalog_miss:zzzzzzzzq')
  })

  it('audit gates: mutual exclusion + lighting ban detected on rendered text', () => {
    const slots = { camera: ['from front', 'from behind'], scene: ['moonlight'] }
    const r = compileAnima(slots, { variant: 'base', search: realSearch })
    const gates = auditAnima(r.positive, r.negative, { variant: 'base', search: realSearch, slots })
    expect(gates.some((g) => g.rule === 'mutual_exclusion')).toBe(true)
    expect(gates.some((g) => g.rule === 'lighting_term_banned')).toBe(true)
  })

  it('duplicate segment and tag-count gates fire on small briefs', () => {
    const slots = { appearance: ['long hair', 'smile', 'smile'], expression: ['smile'] }
    const r = compileAnima(slots, { variant: 'base', search: realSearch })
    const gates = auditAnima(r.positive, r.negative, { variant: 'base', search: realSearch, slots })
    expect(gates.some((g) => g.rule === 'duplicate_segment')).toBe(true)
    expect(gates.some((g) => g.rule === 'tag_count_out_of_range')).toBe(true)
  })

  it('F1 regression: tag_count uses segment semantics — 47 slots + 5-comma narrative stays in range (48)', () => {
    // 47 槽标签 + 带 5 个逗号的 narrative：segment 语义 = 48（槽逐项 + narrative 计 1）→ 阈值 [12,50] 内不触发；
    // token 拆分语义 = 47 + 6 = 53 → 会误触发 out_of_range（修复点）
    const tags = Array.from({ length: 47 }, (_, i) => `tag${i + 1}`)
    const slots = { appearance: tags, narrative: 'alpha, beta, gamma, delta, epsilon, omega' }
    const r = compileAnima(slots, { variant: 'base', search: realSearch })
    const gates = auditAnima(r.positive, r.negative, { variant: 'base', search: realSearch, slots })
    expect(gates.some((g) => g.rule === 'tag_count_out_of_range')).toBe(false)
  })

  it('explicit marker detection covers mutex-free corpus (nude in narrative)', () => {
    expect(isExplicitRequest({ narrative: 'nude study' })).toBe(true)
    expect(isExplicitRequest({ scene: ['对镜自拍'] })).toBe(false)
  })

  it('relation overlay degrade: unavailable → advisory mounted, empty view', () => {
    applyRelationOverlay({ overlayStatus: () => overlayStatus() })
    expect(overlayStatus()).toBe('unavailable')
    expect(overlayAdvisory()).toContain('overlay_unavailable')
  })

  afterAll(() => closeCatalog())
})