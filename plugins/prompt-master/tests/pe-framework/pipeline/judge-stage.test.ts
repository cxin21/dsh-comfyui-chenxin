/**
 * Task 5（spec §2.3 / §2.4 / §2.5）：runStage 评审阶段六分支行为。
 * 全部走 mock criticProvider / evidenceDeps / revisionProvider，不打真连。
 * 最高约束：off / 无 rubric 路径与现版本逐字段一致（provider 零调用）。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { registerDialect, __resetDialectsForTests, type DialectContract } from '../../../src/pe-framework/dialect/registry.js'
import { runStage } from '../../../src/pe-framework/pipeline/runStage.js'
import type { PipelineInput } from '../../../src/pe-framework/pipeline/types.js'
import type { CriticProvider } from '../../../src/pe-framework/eval/critic.js'
import type { EvidenceDeps } from '../../../src/pe-framework/eval/evidence.js'

const RUBRIC = {
  dimensions: [{ id: 'd1', weight: 1, instruction: '按维度 d1 评审' }],
  severityRules: 'blocker=硬伤; major=明显; minor=轻微',
  evidenceTools: ['catalog' as const],
  passThreshold: 70,
}

function fakeDialect(overrides: Partial<DialectContract> = {}): DialectContract {
  return {
    id: 'anima', label: 'Fake', auditOnlyOk: true,
    normalize: () => ({ value: { a: 1 } }),
    compile: () => ({ positive: 'p', negative: 'n' }),
    audit: () => ({ gates: [] }),
    targetSlotHint: 't2i.prompt',
    rubric: RUBRIC,
    ...overrides,
  }
}

const PASS_JSON = JSON.stringify({ verdict: 'pass', dimensionScores: { d1: 90 }, findings: [], praise: [] })
const NEEDS_FIX = {
  severity: 'major', dimension: 'd1', problem: 'tag 顺序错',
  evidence: { tool: 'catalog', query: '1girl', result: 'canonical,n=120' },
  requiredFix: '把质量词前移',
}
const NEEDS_JSON = JSON.stringify({ verdict: 'needs_revision', dimensionScores: { d1: 50 }, findings: [NEEDS_FIX], praise: [] })

function providerOf(responses: string[]): CriticProvider & { calls: number; users: string[] } {
  const fn = (async (req: { persona: string; schema: string; user: string }) => {
    fn.calls++
    fn.users.push(req.user)
    const next = responses[Math.min(fn.calls - 1, responses.length - 1)]
    if (next === 'THROW') throw new Error('provider down')
    return next
  }) as CriticProvider & { calls: number; users: string[] }
  fn.calls = 0
  fn.users = []
  return fn
}

const evidenceDeps: EvidenceDeps = {
  catalog: (q) => [{ tag: q, kind: 'canonical', count: 1 }],
}

function baseInput<T extends Partial<PipelineInput>>(over: T = {} as T): Omit<PipelineInput, 'judge'> & T {
  return { target: 'anima', slots: { a: 1 }, ...over }
}

describe('Task5 runStage 评审阶段：分支1 off / 无 rubric 零行为变化', () => {
  beforeEach(() => __resetDialectsForTests())

  it('judge=off → 同步返回，judge/debate undefined，provider 零调用，与无评审版本逐字段一致', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([PASS_JSON])
    const withJudge = runStage(baseInput({ judge: 'off', criticProvider: provider, evidenceDeps })) as Awaited<ReturnType<typeof runStage>>
    const withoutJudge = runStage(baseInput())
    expect(withJudge).not.toBeInstanceOf(Promise)
    expect(withJudge.judge).toBeUndefined()
    expect(withJudge.debate).toBeUndefined()
    expect(provider.calls).toBe(0)
    const { judge: _j, debate: _d, ...rest } = withJudge
    const stripMs = (r: typeof withoutJudge) => ({ ...r, trace: { stages: r.trace?.stages.map(({ name }) => ({ name })) } })
    expect(stripMs(rest as typeof withoutJudge)).toEqual(stripMs(withoutJudge))
  })

  it('方言无 rubric + judge=fast → judge/debate undefined，provider 零调用', async () => {
    registerDialect(fakeDialect({ rubric: undefined }))
    const provider = providerOf([PASS_JSON])
    const r = await runStage(baseInput({ judge: 'fast', criticProvider: provider, evidenceDeps }))
    expect(r.judge).toBeUndefined()
    expect(r.debate).toBeUndefined()
    expect(provider.calls).toBe(0)
  })
})

describe('分支2 fast + pass', () => {
  beforeEach(() => __resetDialectsForTests())

  it('出稿 + verdict=pass + debate 单轮无 reviser', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([PASS_JSON])
    const r = await runStage(baseInput({ judge: 'fast', criticProvider: provider, evidenceDeps }))
    expect(r.judge).toEqual({ verdict: 'pass', score: 90, findings: [], praise: [] })
    expect(r.debate).toEqual([{ round: 1, reviewer: { findings: [], score: 90 } }])
    expect(r.debate?.[0].reviser).toBeUndefined()
    expect(r.result).toEqual({ positive: 'p', negative: 'n' })
    expect(provider.calls).toBe(1)
  })
})

describe('分支3 fast + needs_revision', () => {
  beforeEach(() => __resetDialectsForTests())

  it('findings 转 judgeFeedback（[severity] requiredFix），debate 单轮，照常出稿交调用方闭环', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON])
    const r = await runStage(baseInput({ judge: 'fast', criticProvider: provider, evidenceDeps }))
    expect(r.judge).toMatchObject({ verdict: 'needs_revision' })
    expect(r.debate).toHaveLength(1)
    expect(r.judgeFeedback).toEqual(['[major] 把质量词前移'])
    expect(r.result).toEqual({ positive: 'p', negative: 'n' })
    expect(r.debate?.[0].reviser).toBeUndefined()
  })
})

describe('分支4 skipped 路径（provider 抛错 / schema 不合）', () => {
  beforeEach(() => __resetDialectsForTests())

  it('provider 抛错 → judge={skipped:true}，advisories 含 judge_skipped，照常出稿', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf(['THROW'])
    const r = await runStage(baseInput({ judge: 'fast', criticProvider: provider, evidenceDeps }))
    expect(r.judge).toMatchObject({ skipped: true })
    expect(r.advisories).toContain('judge_skipped')
    expect(r.result).toEqual({ positive: 'p', negative: 'n' })
    expect(r.ok).toBe(true)
    expect(r.debate).toBeUndefined()
  })

  it('critic 输出 schema 不合 → 同样 skipped + judge_skipped advisory', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf(['not json at all'])
    const r = await runStage(baseInput({ judge: 'fast', criticProvider: provider, evidenceDeps }))
    expect(r.judge).toMatchObject({ skipped: true })
    expect(r.advisories).toContain('judge_skipped')
  })
})

describe('分支5 strict + 首评 needs_revision → 修正稿复审 pass', () => {
  beforeEach(() => __resetDialectsForTests())

  it('revisionProvider 产修正稿 → judgeReview(revision, revisionNote) → 复审 pass，debate 两轮含 reviser', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON, PASS_JSON])
    const revisionProvider = async () => ({
      compiled: { positive: 'p2', negative: 'n2' },
      changes: ['质量词前移'],
      revisionNote: '已把质量词前移',
      rebuttals: [{ finding_id: 'f1', rebuttal: '已修复', evidence: 'positive 前 3 token' }],
    })
    const r = await runStage(baseInput({ judge: 'strict', criticProvider: provider, evidenceDeps, revisionProvider }))
    expect(r.judge).toMatchObject({ verdict: 'pass' })
    expect(r.result).toEqual({ positive: 'p2', negative: 'n2' })
    expect(r.debate).toHaveLength(2)
    expect(r.debate?.[0].reviser).toBeUndefined()
    expect(r.debate?.[1].reviser?.changes).toEqual(['质量词前移'])
    expect(r.debate?.[1].reviser?.rebuttals).toEqual([{ finding_id: 'f1', rebuttal: '已修复', evidence: 'positive 前 3 token' }])
    // T3 carry：strict 复审必须传 revisionNote（user payload 含修正说明）
    expect(provider.users[1]).toContain('已把质量词前移')
    expect(provider.users[1]).toContain('revision')
    expect(provider.calls).toBe(2)
  })

  it('rebuttals 缺失 → reviser.rebuttals 为空数组', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON, PASS_JSON])
    const r = await runStage(baseInput({
      judge: 'strict', criticProvider: provider, evidenceDeps,
      revisionProvider: async () => ({ compiled: { x: 2 }, changes: ['c'], revisionNote: 'note' }),
    }))
    expect(r.debate?.[1].reviser?.rebuttals).toEqual([])
  })

  it('strict 缺 revisionProvider → 退化为 fast 并标 strict_degraded advisory', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON])
    const r = await runStage(baseInput({ judge: 'strict', criticProvider: provider, evidenceDeps }))
    expect(r.advisories).toContain('strict_degraded')
    expect(r.judge).toMatchObject({ verdict: 'needs_revision' })
    expect(provider.calls).toBe(1)
  })

  // Task 6 顺手项回归：strict_degraded 只在首评 needs_revision 时标注——首评 pass 不追加噪音
  it('strict 缺 revisionProvider 但首评 pass → 不标 strict_degraded', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([PASS_JSON])
    const r = await runStage(baseInput({ judge: 'strict', criticProvider: provider, evidenceDeps }))
    expect(r.advisories).not.toContain('strict_degraded')
    expect(r.judge).toMatchObject({ verdict: 'pass' })
    expect(provider.calls).toBe(1)
  })
})

describe('分支6 strict + 复审仍 needs_revision / 规则审计 critical 短路', () => {
  beforeEach(() => __resetDialectsForTests())

  it('复审仍 needs_revision → judgeFeedback 交现有修正闭环，result 为修正稿，debate 两轮', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON, NEEDS_JSON])
    const r = await runStage(baseInput({
      judge: 'strict', criticProvider: provider, evidenceDeps,
      revisionProvider: async () => ({ compiled: { positive: 'p2', negative: 'n2' }, changes: ['c'], revisionNote: 'note' }),
    }))
    expect(r.judge).toMatchObject({ verdict: 'needs_revision' })
    expect(r.result).toEqual({ positive: 'p2', negative: 'n2' })
    expect(r.debate).toHaveLength(2)
    expect(r.judgeFeedback).toEqual(['[major] 把质量词前移'])
    expect(r.ok).toBe(true) // 评审 failure 不阻塞出稿；critical 语义不变
  })

  // final review I1：复审 skipped → round 2 整轮不 push（0 分是编造数据，不得污染 debate 语料）
  it('strict 复审 skipped → debate 只剩 round1（不伪造 reviewer），advisories 含 judge_skipped', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON, 'THROW'])
    const r = await runStage(baseInput({
      judge: 'strict', criticProvider: provider, evidenceDeps,
      revisionProvider: async () => ({ compiled: { positive: 'p2', negative: 'n2' }, changes: ['c'], revisionNote: 'note' }),
    }))
    expect(r.judge).toMatchObject({ skipped: true })
    expect(r.advisories).toContain('judge_skipped')
    expect(r.debate).toHaveLength(1)
    expect(r.debate?.[0].round).toBe(1)
    expect(r.result).toEqual({ positive: 'p2', negative: 'n2' }) // 修正稿照常出稿
    expect(provider.calls).toBe(2)
  })

  it('规则审计含 critical gate → provider 零调用，judge={skipped,reason:rule_critical}', async () => {
    registerDialect(fakeDialect({
      audit: () => ({ gates: [{ rule: 'budget', target: 'anima', severity: 'critical', detail: '超预算', source: 'test' }] }),
    }))
    const provider = providerOf([PASS_JSON])
    const r = await runStage(baseInput({ judge: 'strict', criticProvider: provider, evidenceDeps }))
    expect(provider.calls).toBe(0)
    expect(r.judge).toEqual({ skipped: true, reason: 'rule_critical' })
    expect(r.ok).toBe(false)
  })

  it('evidenceDeps 缺 rubric 声明的工具键 → evidence_partial advisory，评审照常', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([PASS_JSON])
    const r = await runStage(baseInput({ judge: 'fast', criticProvider: provider, evidenceDeps: {} }))
    expect(r.advisories).toContain('evidence_partial')
    expect(r.judge).toMatchObject({ verdict: 'pass' })
  })

  // Task 6 顺手项回归：evidenceDeps 整个未传（undefined）→ 同样标 evidence_partial
  it('evidenceDeps 整个未传 → evidence_partial advisory，评审照常', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([PASS_JSON])
    const r = await runStage({ ...baseInput({ criticProvider: provider }), judge: 'fast' })
    expect(r.advisories).toContain('evidence_partial')
    expect(r.judge).toMatchObject({ verdict: 'pass' })
  })
})

describe('judge-assembly 生产装配（不打真连，只验适配器形状）', () => {
  it('createProductionEvidenceDeps：catalog/tokenizer/aesthetics 适配器产出桥层可摘要的形状', async () => {
    const { createProductionEvidenceDeps } = await import('../../../src/pe-framework/pipeline/judge-assembly.js')
    const deps = createProductionEvidenceDeps('anima')
    expect(typeof deps.catalog).toBe('function')
    expect(typeof deps.tokenizer).toBe('function')
    expect(typeof deps.aesthetics).toBe('function')
    const hit = await deps.catalog!('1girl')
    const h = (hit as Array<Record<string, unknown>>)[0]
    expect(h).toHaveProperty('tag')
    expect(h).toHaveProperty('kind')
    expect(h).toHaveProperty('count')
    const tok = await deps.tokenizer!('a girl in a garden')
    expect(typeof (tok as { tokens: unknown }).tokens).toBe('number')
    const aes = await deps.aesthetics!('a beautiful cinematic girl')
    expect(aes).toBeDefined()
  })

  it('createProductionCriticProvider：缺 agent 的 ownerCtx → provider 抛错（管线层转 skipped）', async () => {
    const { createProductionCriticProvider } = await import('../../../src/pe-framework/pipeline/judge-assembly.js')
    const provider = createProductionCriticProvider({})
    await expect(provider({ persona: 'p', schema: 's', user: 'u' })).rejects.toThrow()
  })
})
