/**
 * Task 5（spec §2.3 / §2.4 / §2.5）：runStage 评审阶段六分支行为。
 * 全部走 mock criticProvider / evidenceDeps / revisionProvider，不打真连。
 * 最高约束：off / 无 rubric 路径与现版本逐字段一致（provider 零调用）。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { registerDialect, __resetDialectsForTests, type DialectContract } from '../../../src/pe-framework/dialect/registry.js'
import { runStage } from '../../../src/pe-framework/pipeline/runStage.js'
import type { PipelineInput } from '../../../src/pe-framework/pipeline/types.js'
import type { CriticProvider, CriticFinding } from '../../../src/pe-framework/eval/critic.js'
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
// T4（spec §10.2-A3）：首轮 praise 非空 → 透传 revisionProvider（praise 锚点数据源）
const NEEDS_PRAISE_JSON = JSON.stringify({ verdict: 'needs_revision', dimensionScores: { d1: 50 }, findings: [NEEDS_FIX], praise: ['主体表现力强'] })
// A2 revision 独立契约（spec §10.1-A2）：复审返回关闭/反驳裁决，不产 dimensionScores
const REV_CLOSE_JSON = JSON.stringify({
  verdict: 'pass', closedFindingIds: ['f1'], unresolved: [],
  rebuttalVerdicts: [{ finding_id: 'f1', accepted: true, reason: '已修复，证据见修正稿' }],
})
const REV_REJECT_JSON = JSON.stringify({
  verdict: 'pass', closedFindingIds: ['f1'], unresolved: [], rebuttalVerdicts: [],
})
const REV_STILL_JSON = JSON.stringify({
  verdict: 'needs_revision', closedFindingIds: [], unresolved: ['f1'], rebuttalVerdicts: [],
})
const REV_INVALID_JSON = JSON.stringify({ verdict: 'pass', closedFindingIds: ['f9'], unresolved: [], rebuttalVerdicts: [] })

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

  it('revisionProvider 产修正稿 → 复审独立契约全关闭/反驳接受 → pass；round2.reviewer.score=首轮分（透传），rebuttals 从 rebuttalVerdicts 映射', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON, REV_CLOSE_JSON])
    const revisionProvider = async () => ({
      compiled: { positive: 'p2', negative: 'n2' },
      changes: ['质量词前移'],
      revisionNote: '已把质量词前移',
      rebuttals: [],
    })
    const r = await runStage(baseInput({ judge: 'strict', criticProvider: provider, evidenceDeps, revisionProvider }))
    expect(r.judge).toMatchObject({ verdict: 'pass', score: 50 }) // score 透传首轮，复审不改分
    expect(r.result).toEqual({ positive: 'p2', negative: 'n2' })
    expect(r.debate).toHaveLength(2)
    expect(r.debate?.[0].reviser).toBeUndefined()
    expect(r.debate?.[1].reviewer.score).toBe(50)
    expect(r.debate?.[1].reviewer.findings).toHaveLength(0)
    expect(r.debate?.[1].reviser?.changes).toEqual(['质量词前移'])
    // A2 规格4：rebuttals 从复审 rebuttalVerdicts（accepted 的才进），evidence='reviewer-accepted'
    expect(r.debate?.[1].reviser?.rebuttals).toEqual([
      { finding_id: 'f1', rebuttal: '已修复，证据见修正稿', evidence: 'reviewer-accepted' },
    ])
    // 规格3：revision user 只含首轮 findings + 修正说明 + 裁决任务（负向断言）
    expect(provider.users[1]).toContain('已把质量词前移')
    expect(provider.users[1]).toContain('tag 顺序错')
    expect(provider.users[1]).toContain('closedFindingIds')
    expect(provider.users[1]).not.toContain('重新评审')
    expect(provider.users[1]).not.toContain('dimensionScores')
    expect(provider.calls).toBe(2)
  })

  it('T4 迁移：修订者自带结构化 rebuttals 直通 round2.reviser.rebuttals（provider 优先于复审 verdicts 映射）', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON, REV_REJECT_JSON])
    const r = await runStage(baseInput({
      judge: 'strict', criticProvider: provider, evidenceDeps,
      revisionProvider: async () => ({
        compiled: { x: 2 }, changes: ['c'], revisionNote: 'note',
        rebuttals: [{ finding_id: 'f1', rebuttal: '所需内容已在稿内', evidence: 'x' }],
      }),
    }))
    // A4（spec §10.2-A4）：结构化 rebuttals 不再经 revisionNote 内嵌，也不仅依赖复审裁决映射
    expect(r.debate?.[1].reviser?.rebuttals).toEqual([
      { finding_id: 'f1', rebuttal: '所需内容已在稿内', evidence: 'x' },
    ])
  })

  it('T4 并集：provider rebuttals 与复审 accepted 映射按 finding_id 合并，provider 条目优先', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON, REV_CLOSE_JSON])
    const r = await runStage(baseInput({
      judge: 'strict', criticProvider: provider, evidenceDeps,
      revisionProvider: async () => ({
        compiled: { positive: 'p2', negative: 'n2' }, changes: ['c'], revisionNote: 'note',
        rebuttals: [{ finding_id: 'f1', rebuttal: '修订者自己的证据', evidence: 'compiled-text' }],
      }),
    }))
    expect(r.debate?.[1].reviser?.rebuttals).toEqual([
      { finding_id: 'f1', rebuttal: '修订者自己的证据', evidence: 'compiled-text' },
    ])
  })

  it('T4：修订者无 rebuttals 时回退复审 accepted 映射（reviewer-accepted 证据保留）', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON, REV_CLOSE_JSON])
    const r = await runStage(baseInput({
      judge: 'strict', criticProvider: provider, evidenceDeps,
      revisionProvider: async () => ({
        compiled: { positive: 'p2', negative: 'n2' }, changes: ['c'], revisionNote: 'note', rebuttals: [],
      }),
    }))
    expect(r.debate?.[1].reviser?.rebuttals).toEqual([
      { finding_id: 'f1', rebuttal: '已修复，证据见修正稿', evidence: 'reviewer-accepted' },
    ])
  })

  it('T4 praise 透传：首轮 praise 作为第三参传给 revisionProvider（praise 锚点数据源）', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_PRAISE_JSON, REV_CLOSE_JSON])
    const seen: unknown[] = []
    const r = await runStage(baseInput({
      judge: 'strict', criticProvider: provider, evidenceDeps,
      revisionProvider: async (_c: unknown, _f: CriticFinding[], praise: string[]) => {
        seen.push(praise)
        return { compiled: { positive: 'p2', negative: 'n2' }, changes: ['c'], revisionNote: 'note', rebuttals: [] }
      },
    }))
    expect(seen).toEqual([['主体表现力强']])
    expect(r.judge).toMatchObject({ verdict: 'pass' })
  })

  it('revision 轮不触发证据回查：bridge.query 仅首评调用一次，revision user 无证据工具段', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON, REV_CLOSE_JSON])
    const r = await runStage(baseInput({
      judge: 'strict', criticProvider: provider, evidenceDeps,
      revisionProvider: async () => ({ compiled: { x: 2 }, changes: ['c'], revisionNote: 'note', rebuttals: [] }),
    }))
    expect(r.judge).toMatchObject({ verdict: 'pass' })
    expect(provider.users[1]).not.toContain('可用证据工具')
    expect(provider.users[1]).not.toContain('positive') // 修正稿编译产物不进复审 user
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

  it('复审仍 needs_revision（未关闭 finding 保留）→ judgeFeedback 交现有修正闭环，score 透传首轮分，debate 两轮', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON, REV_STILL_JSON])
    const r = await runStage(baseInput({
      judge: 'strict', criticProvider: provider, evidenceDeps,
      revisionProvider: async () => ({ compiled: { positive: 'p2', negative: 'n2' }, changes: ['c'], revisionNote: 'note', rebuttals: [] }),
    }))
    expect(r.judge).toMatchObject({ verdict: 'needs_revision', score: 50 })
    expect((r.judge as any).findings).toHaveLength(1)
    expect((r.judge as any).findings[0].id).toBe('f1')
    expect(r.result).toEqual({ positive: 'p2', negative: 'n2' })
    expect(r.debate).toHaveLength(2)
    expect(r.debate?.[1].reviewer.score).toBe(50)
    expect(r.judgeFeedback).toEqual(['[major] 把质量词前移'])
    expect(r.ok).toBe(true) // 评审 failure 不阻塞出稿；critical 语义不变
  })

  // A2 校验：revision 契约不合（引用不存在 id）→ skipped，round 2 不 push
  it('复审输出引用不存在 finding id → judge skipped reason=invalid_revision_schema + judge_skipped advisory，debate 只剩 round1', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON, REV_INVALID_JSON])
    const r = await runStage(baseInput({
      judge: 'strict', criticProvider: provider, evidenceDeps,
      revisionProvider: async () => ({ compiled: { positive: 'p2', negative: 'n2' }, changes: ['c'], revisionNote: 'note', rebuttals: [] }),
    }))
    expect(r.judge).toEqual({ skipped: true, reason: 'invalid_revision_schema' })
    expect(r.advisories).toContain('judge_skipped')
    expect(r.debate).toHaveLength(1)
    expect(r.result).toEqual({ positive: 'p2', negative: 'n2' })
  })

  // final review I1：复审 skipped → round 2 整轮不 push（0 分是编造数据，不得污染 debate 语料）
  it('strict 复审 skipped → debate 只剩 round1（不伪造 reviewer），advisories 含 judge_skipped', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON, 'THROW'])
    const r = await runStage(baseInput({
      judge: 'strict', criticProvider: provider, evidenceDeps,
      revisionProvider: async () => ({ compiled: { positive: 'p2', negative: 'n2' }, changes: ['c'], revisionNote: 'note', rebuttals: [] }),
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

describe('A1 证据回查复核（spec §10.1-A1）：runJudgeStage 管线交互', () => {
  beforeEach(() => __resetDialectsForTests())

  it('回查命中 → judge.findings[0].evidence.verified=true，透传 judge/debate', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON])
    const r = await runStage(baseInput({ judge: 'fast', criticProvider: provider, evidenceDeps }))
    expect((r.judge as any).findings[0].evidence.verified).toBe(true)
    expect(r.advisories).not.toContain('evidence_unverified')
  })

  it('evidence dep 缺失（bridge.list 缺工具）→ finding evidenceAssumed 放行 + evidence_partial 只 push 一次，评审照常', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON])
    const r = await runStage(baseInput({ judge: 'fast', criticProvider: provider, evidenceDeps: {} }))
    expect(r.advisories.filter((a) => a === 'evidence_partial')).toHaveLength(1)
    expect(r.judge).toMatchObject({ verdict: 'needs_revision' })
    expect((r.judge as any).findings[0].evidenceAssumed).toBe(true)
  })

  it('evidence dep 抛错 → bridge.query ok=false → finding 丢弃；全丢后 needs_revision 按规格终局 pass', async () => {
    registerDialect(fakeDialect())
    const provider = providerOf([NEEDS_JSON])
    const r = await runStage(baseInput({
      judge: 'fast', criticProvider: provider,
      evidenceDeps: { catalog: () => { throw new Error('dep down') } },
    }))
    expect(r.judge).toMatchObject({ verdict: 'pass' })
    expect((r.judge as any).findings).toHaveLength(0)
    expect(r.judgeFeedback).toBeUndefined()
  })

  it('bridge 整体不可用（list 抛错）→ findings 全保留 + evidence_unverified advisory 透传', async () => {
    registerDialect(fakeDialect({
      rubric: { ...RUBRIC, evidenceTools: { some: () => false, filter: () => { throw new Error('list down') } } as unknown as typeof RUBRIC.evidenceTools },
    }))
    const provider = providerOf([NEEDS_JSON])
    const r = await runStage(baseInput({ judge: 'fast', criticProvider: provider, evidenceDeps }))
    expect(r.advisories).toContain('evidence_unverified')
    expect(r.judge).toMatchObject({ verdict: 'needs_revision' })
    expect((r.judge as any).findings).toHaveLength(1)
  })
})

describe('Round7 T4：revision 复审不消费 ruleGates（gate 语义只在首轮）', () => {
  beforeEach(() => __resetDialectsForTests())

  it('修正稿复审的 ruleGates 传 []——修正稿自身审计出 critical 也照常复审（provider 第 2 次调用发生），critical 语义仅由 gates/ok 承载', async () => {
    let auditCalls = 0
    registerDialect(fakeDialect({
      audit: () => {
        auditCalls++
        return auditCalls === 1
          ? { gates: [] }
          : { gates: [{ rule: 'budget', target: 'anima', severity: 'critical', detail: '超预算', source: 'test' }] }
      },
    }))
    const provider = providerOf([NEEDS_JSON, REV_CLOSE_JSON])
    const r = await runStage(baseInput({
      judge: 'strict', criticProvider: provider, evidenceDeps,
      revisionProvider: async () => ({ compiled: { positive: 'p2', negative: 'n2' }, changes: ['c'], revisionNote: 'note', rebuttals: [] }),
    }))
    // 新契约：复审照常发生（不因修正稿新 critical gate 短路）
    expect(provider.calls).toBe(2)
    expect(r.judge).toMatchObject({ verdict: 'pass', score: 50 })
    // gates 语义不变：修正稿 critical 照常落 ok=false（闭环仍由 gates 驱动）
    expect(r.ok).toBe(false)
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

  it('Round7 T6：target=h3 → catalog 键不进 deps（fail-fast 分流；h3 未声明 catalog 工具）', async () => {
    const { createProductionEvidenceDeps } = await import('../../../src/pe-framework/pipeline/judge-assembly.js')
    const deps = createProductionEvidenceDeps('h3')
    expect(deps.catalog).toBeUndefined() // bridge.list 自然不含 catalog
    // tokenizer/aesthetics 不受分流影响
    expect(typeof deps.tokenizer).toBe('function')
    expect(typeof deps.aesthetics).toBe('function')
  })
})
