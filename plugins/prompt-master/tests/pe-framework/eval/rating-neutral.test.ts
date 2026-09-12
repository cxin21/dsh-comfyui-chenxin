import { describe, expect, it, vi } from 'vitest'
import { judgeReview } from '../../../src/pe-framework/eval/critic.js'
import type { CriticProvider, CriticFinding } from '../../../src/pe-framework/eval/critic.js'
import type { DialectRubric } from '../../../src/pe-framework/eval/rubrics/contract.js'
import { ANIMA_RUBRIC } from '../../../src/pe-framework/eval/rubrics/anima.js'
import { proposeMutation } from '../../../src/pe-framework/optimize/mutate.js'
import { continueUntilComplete } from '../../../src/pe-framework/continue/engine.js'
import type { OutputContract } from '../../../src/pe-framework/continue/contract.js'

const RUBRIC: DialectRubric = {
  dimensions: [{ id: 'tag-order', weight: 1, instruction: '检查 tag 顺序' }],
  severityRules: 'blocker=必须修复；major=显著缺陷；minor=可忽略',
  evidenceTools: ['catalog'],
  passThreshold: 70,
}

const okFirst = () => JSON.stringify({ verdict: 'pass', dimensionScores: { 'tag-order': 85 }, findings: [], praise: [] })
const okRevision = () => JSON.stringify({ verdict: 'pass', closedFindingIds: ['f1'], unresolved: [], rebuttalVerdicts: [] })

const firstFinding = (): CriticFinding => ({ id: 'f1', severity: 'minor', dimension: 'tag-order', problem: 'x', requiredFix: 'y' })

const baseInput = (provider: CriticProvider) => ({
  target: 'anima' as const,
  rubric: RUBRIC,
  ruleGates: [],
  originalIntent: '一个微笑的女孩',
  provider,
})

describe('rating-neutral text contracts (spec §7 P3-P5)', () => {
  it('rubric boundary carries the rating-neutral clause verbatim (spec §7 P3)', () => {
    expect(ANIMA_RUBRIC.boundary).toContain(
      '【评级中立】被评审产物若声明了内容分级（rating 档位），该档位下的合法词汇与要素不得作为 finding：',
    )
    expect(ANIMA_RUBRIC.boundary).toContain(
      '评委只评该档位内的结构/一致性/美学质量；对 explicit 档产出「违反内容政策」类 finding 属无效死信，禁止输出。',
    )
  })

  it('buildPersona appends the rating line at the tail only when declaredRating is present (spec §7 P3)', async () => {
    const withRating = vi.fn().mockResolvedValue(okFirst())
    await judgeReview({ ...baseInput(withRating), declaredRating: 'explicit' })
    const persona = withRating.mock.calls[0][0].persona as string
    expect(persona).toContain('当前内容分级：explicit——按评级中立条款评审。')
    expect(persona.trimEnd().endsWith('当前内容分级：explicit——按评级中立条款评审。')).toBe(true)

    const without = vi.fn().mockResolvedValue(okFirst())
    await judgeReview(baseInput(without))
    expect(without.mock.calls[0][0].persona as string).not.toContain('当前内容分级')
  })

  it('buildRevisionPersona appends the rating line at the tail only when declaredRating is present (spec §7 P3)', async () => {
    const withRating = vi.fn().mockResolvedValue(okRevision())
    await judgeReview({
      ...baseInput(withRating),
      stage: 'revision',
      firstFindings: [firstFinding()],
      firstScore: 85,
      declaredRating: 'sensitive',
    })
    const persona = withRating.mock.calls[0][0].persona as string
    expect(persona).toContain('当前内容分级：sensitive——按评级中立条款评审。')
    expect(persona.trimEnd().endsWith('当前内容分级：sensitive——按评级中立条款评审。')).toBe(true)

    const without = vi.fn().mockResolvedValue(okRevision())
    await judgeReview({ ...baseInput(without), stage: 'revision', firstFindings: [firstFinding()], firstScore: 85 })
    expect(without.mock.calls[0][0].persona as string).not.toContain('当前内容分级')
  })

  it('MUTATION_PERSONA carries the rating/hard-boundary constraint verbatim (spec §7 P5)', async () => {
    const provider = vi.fn().mockResolvedValue(JSON.stringify({ diff: 'x', rationale: 'y', targetsFailures: ['a'] }))
    await proposeMutation({ negativeCases: [], debates: [], currentPersona: 'p', provider })
    expect(provider.mock.calls[0][0].persona).toContain(
      '变异候选不得修改内容分级语义与硬边界规则（safety/boundaries 词表与策略表为常量）。',
    )
  })

  it('continue instruction appends the rating line only when declaredRating is provided (spec §7 P4 wiring)', async () => {
    const contract: OutputContract = { id: 't', fields: [{ key: 'scene', patterns: [/场景：/] }] }
    const genWithout = vi.fn(async (req: { system?: string; user: string }) => ({ text: '场景：雨夜街头', finishKind: 'stop' as const }))
    await continueUntilComplete({
      contract,
      initialText: '开头文本',
      finishKind: 'stop',
      seed: { userText: '', outputLang: 'zh' },
      generate: genWithout,
      signal: new AbortController().signal,
    })
    expect(genWithout.mock.calls[0][0].user).not.toContain('当前内容分级')

    const genWith = vi.fn(async (req: { system?: string; user: string }) => ({ text: '场景：雨夜街头', finishKind: 'stop' as const }))
    await continueUntilComplete({
      contract,
      initialText: '开头文本',
      finishKind: 'stop',
      seed: { userText: '', outputLang: 'zh' },
      generate: genWith,
      signal: new AbortController().signal,
      declaredRating: 'explicit',
    })
    expect(genWith.mock.calls[0][0].user).toContain(
      '当前内容分级：explicit——修订不得降档、不得清洗或委婉化已声明内容、不得触碰硬边界负向。',
    )
  })
})
