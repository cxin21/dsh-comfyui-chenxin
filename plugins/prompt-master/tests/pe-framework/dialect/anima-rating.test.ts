import { describe, expect, it, afterAll } from 'vitest'
import { compileAnima, auditAnima } from '../../../src/pe-framework/dialect/anima.js'
import { searchCatalog, closeCatalog } from '../../../src/pe-framework/dialect/anima-catalog.js'
import { EXPLICIT_MARKERS, SENSITIVE_MARKERS } from '../../../src/pe-framework/safety/rating.js'

const realSearch = (t: string) => searchCatalog(t, { limit: 5 })

const slots = (extra: Record<string, unknown>) => ({
  count_gender: ['1girl'], detail_mood: ['white dress'], ...extra,
}) as Parameters<typeof compileAnima>[0]

describe('rating integration (spec §5.3)', () => {
  it('safe: seed "safe", no additions, no legacy safety assumption', () => {
    const r = compileAnima(slots({}), { variant: 'base', search: realSearch })
    expect(r.positive).toContain('safe,')
    expect(r.negative).not.toContain('rating_explicit')
    expect(r.assumptions).not.toContain('safety_seed_injected:default_for_non_explicit_request')
  })
  it('sensitive: rating_sensitive seed + explicit blockers in negative', () => {
    const r = compileAnima(slots({ rating: 'sensitive' }), { variant: 'base', search: realSearch })
    expect(r.positive).toContain('rating_sensitive')
    expect(r.positive).not.toContain(' safe,')
    expect(r.negative).toContain('nude')
    expect(r.assumptions).toContain('rating_active:sensitive')
  })
  it('explicit bool alias maps to explicit tier; qualityPrefix=false still adds negative additions', () => {
    const r = compileAnima(slots({ explicit: true, qualityPrefix: false }), { variant: 'base', search: realSearch })
    expect(r.positive).toContain('rating_explicit')
    expect(r.negative).toContain('loli')
  })
  it('terminal boundary gate fires on compiled corpus', () => {
    const s = slots({ rating: 'explicit', appearance: ['loli'] })
    const r = compileAnima(s, { variant: 'base', search: realSearch })
    expect(r.phase_status.inspection).toBe('ADVISORY')
    const gates = auditAnima(r.positive, r.negative, { variant: 'base', search: realSearch, slots: s })
    expect(gates.some((g) => g.rule === 'minor_content_conflict')).toBe(true)
  })
  it('repair r2: terminal tier mirrors assembly tier (keyword-escalated, undeclared rating)', () => {
    // 无显式 rating 声明：detail_mood 'nude' 关键词升档 → 装配档位 explicit（3b）；
    // 终检档位必须恒等于装配档位，否则 appearance 'loli' 的 minor gate 在 safe 档被跳过（漏检）。
    const s = slots({ detail_mood: ['nude'], appearance: ['loli'] })
    const r = compileAnima(s, { variant: 'base', search: realSearch })
    expect(r.positive).toContain('rating_explicit')
    expect(r.assumptions).toContain('rating_active:explicit')
    const gates = auditAnima(r.positive, r.negative, { variant: 'base', search: realSearch, slots: s })
    expect(gates.some((g) => g.rule === 'minor_content_conflict')).toBe(true)
  })
  it('repair r3: terminal tier is monotone across canonical substitution (vulva→pussy escaper)', () => {
    // 审计实证的唯一逃逸词：vulva（∈ EXPLICIT_MARKERS）是 catalog alias，prompt_form='pussy'（不含任何
    // marker）。但 canonical 替换发生在 grounding（只换文本段），effectiveSlots 保留原始 vulva →
    // audit 重算档位仍 explicit（与 3b 同源）→ minor gate 正常触发。本用例钉死该不变量：
    // 「grounding 形态替换不得影响档位重算」——若未来有人把 effectiveSlots 同步成 prompt_form 视图，
    // 重算将回落 safe、infant 的 minor gate 消失，本用例即 FAIL（机制回归哨兵）。
    const s = slots({ appearance: ['vulva', 'infant'] })
    const r = compileAnima(s, { variant: 'base', search: realSearch })
    expect(r.positive).toContain('pussy') // grounding 形态替换确实发生（前提钉死）
    expect(r.positive).not.toContain('vulva')
    expect(r.assumptions).toContain('rating_active:explicit') // 3b 装配档位（原始 slots 升档）
    expect(r.phase_status.inspection).toBe('ADVISORY')
  })
  it('repair r3: tier stays monotone when escalation tag is dropped in production (dropUnresolvedMiss)', () => {
    // 生产管线真窗（P2' 证据流丢弃）：nudity ∈ EXPLICIT_MARKERS 但 catalog 顶层仅 fuzzy（miss）→
    // 非例外面（CJK 例外②不适用、非 lighting_ban、appearance 可丢）→ dropUnresolvedMiss 把它从
    // 文本与 effectiveSlots 同时移除 → 重算回落 safe，而文本仍携带 3b 已装配的 rating_explicit 种子，
    // 同现的 minor 词 loli 逃过 minor gate。裁定分支③：audit 档位 = max(装配档位, 重算)——装配档位
    // 经 compile 透传进 audit 链（subst/auditAnima 均接收），种子与终检恒同源。
    // （审计附注：乳头等 CJK 升档词被例外②保留——cjk_in_positive critical 驱动修复轮回炉，不构成丢弃窗。）
    const s = slots({ appearance: ['nudity', 'infant'] })
    const r = compileAnima(s, { variant: 'base', search: realSearch, dropUnresolvedMiss: true })
    expect(r.assumptions).toContain('rating_active:explicit') // 装配档位（原始 nudity 升档）
    expect(r.positive).toContain('infant') // infant 是 catalog 命中 tag 且不在 additions（不引入 conflict 混淆），不随丢弃消失
    expect(r.positive).not.toContain('nudity') // nudity 被生产管线丢弃（前提钉死）
    expect(r.phase_status.inspection).toBe('ADVISORY') // 当前实现重算回落 safe → PASS，断言 RED
  })
  it('repair r3: auditAnima honors threaded tier over effectiveSlots recompute (override precedence)', () => {
    // 机制用例：显式传入的档位（compile 内部透传 3b eff 的载体）优先于 slots 重算——
    // safe 档 slots + rating:'explicit' 覆盖 → minor gate 必触发。当前实现无此参数（RED）。
    const s = slots({ appearance: ['loli'] })
    const r = compileAnima(s, { variant: 'base', search: realSearch })
    const gates = auditAnima(r.positive, r.negative, { variant: 'base', search: realSearch, slots: s, rating: 'explicit' })
    expect(gates.some((g) => g.rule === 'minor_content_conflict')).toBe(true)
  })
  it('canonical substitution census: escaper set is exactly {vulva→pussy} (TR8-1 residual audit, captain-ruled)', () => {
    // 29 词全量审计的 durable 形态（EXPLICIT 19 + SENSITIVE 10，captain 口径「18 词」以源码数组为准）：
    // 每个 marker 词经 searchCatalog 取 top grounded 形态，替换后不再命中任何 marker 者=逃逸词。
    // 现状恰一条（vulva→pussy，alias），由档位单调化（compile 透传 3b eff）兜底。
    // 未来 catalog 变更引入新逃逸词会在此处 FAIL，强制复核档位链路；若把 pussy 加入词表，
    // 本期望应随之改为 []（有意的词表变更走评审）。
    const escapers: string[] = []
    for (const w of [...EXPLICIT_MARKERS, ...SENSITIVE_MARKERS]) {
      const top = searchCatalog(w, { limit: 5 })[0]
      if (top && (top.match_type === 'canonical' || top.match_type === 'alias') && top.prompt_form && top.prompt_form !== w) {
        const f = top.prompt_form.toLowerCase()
        if (!EXPLICIT_MARKERS.some((m) => f.includes(m)) && !SENSITIVE_MARKERS.some((m) => f.includes(m))) {
          escapers.push(`${w}->${top.prompt_form}`)
        }
      }
    }
    expect(escapers).toEqual(['vulva->pussy'])
  })
  afterAll(() => closeCatalog())
})
