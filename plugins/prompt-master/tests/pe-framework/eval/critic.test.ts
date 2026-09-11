import { describe, it, expect, vi } from 'vitest'
import { judgeReview, createSubagentCriticProvider } from '../../../src/pe-framework/eval/critic.js'
import type { CriticProvider } from '../../../src/pe-framework/eval/critic.js'
import type { DialectRubric } from '../../../src/pe-framework/eval/rubrics/contract.js'
import type { EvidenceBridge, EvidenceToolId, EvidenceResult } from '../../../src/pe-framework/eval/evidence.js'
import type { AuditGate } from '../../../src/pe-framework/types.js'

const RUBRIC: DialectRubric = {
  dimensions: [
    { id: 'tag-order', weight: 0.5, instruction: '检查 tag 顺序是否符合方言惯例' },
    { id: 'cross-shot-consistency', weight: 0.5, instruction: '检查跨镜头一致性' },
  ],
  severityRules: 'blocker=必须修复；major=显著缺陷；minor=可忽略',
  evidenceTools: ['catalog', 'tokenizer'],
  passThreshold: 70,
}

const RUBRIC_OPT: DialectRubric = {
  dimensions: [
    { id: 'structure', weight: 0.6, instruction: '检查结构完整性' },
    { id: 'aesthetics', weight: 0.4, instruction: '检查美学具体性', evidenceOptional: true },
  ],
  severityRules: 'blocker=必须修复；major=显著缺陷；minor=可忽略',
  evidenceTools: ['catalog'],
  passThreshold: 70,
}

function fakeBridge(): EvidenceBridge {
  return {
    list: () => ['catalog', 'tokenizer'] as EvidenceToolId[],
    query: vi.fn(async (_tool: EvidenceToolId, q: string): Promise<EvidenceResult> => ({
      tool: _tool,
      query: q,
      summary: `evidence:${q}`,
      ok: true,
    })),
  }
}

function gate(severity: AuditGate['severity']): AuditGate {
  return { rule: 'catalog_miss', target: 'anima', severity, detail: 'x' }
}

function finding(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    severity: 'major',
    dimension: 'tag-order',
    problem: 'tag 顺序错',
    evidence: { tool: 'catalog', query: '1girl', result: 'hit(3)' },
    requiredFix: '把 1girl 放最前',
    ...over,
  }
}

function ok(verdict: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict,
    dimensionScores: { 'tag-order': 85, 'cross-shot-consistency': 85 },
    findings: [finding()],
    praise: ['结构清晰'],
    ...over,
  })
}

const baseInput = () => ({
  target: 'anima' as const,
  rubric: RUBRIC,
  bridge: fakeBridge(),
  compiled: { positive: '1girl, smile' },
  ruleGates: [] as AuditGate[],
  originalIntent: '一个微笑的女孩',
  provider: undefined as unknown as CriticProvider,
})

describe('judgeReview', () => {
  it('规格1：ruleGates 含 critical → skipped reason=rule_critical，provider 零调用', async () => {
    const provider = vi.fn()
    const r = await judgeReview({ ...baseInput(), ruleGates: [gate('important'), gate('critical')], provider })
    expect(r).toEqual({ skipped: true, reason: 'rule_critical' })
    expect(provider).not.toHaveBeenCalled()
  })

  it('规格2：正常路径——persona 拼 dimensions[].instruction+severityRules；schema 注入 dimension 枚举；strip fence 后原样返回', async () => {
    const provider = vi.fn().mockResolvedValue('```json\n' + ok('pass') + '\n```')
    const input = baseInput()
    input.provider = provider
    const res = await judgeReview(input)
    expect(res).toMatchObject({ verdict: 'pass', score: 85, praise: ['结构清晰'] })
    expect((res as any).findings).toHaveLength(1)
    const req = provider.mock.calls[0][0]
    expect(req.persona).toContain('检查 tag 顺序是否符合方言惯例')
    expect(req.persona).toContain('检查跨镜头一致性')
    expect(req.persona).toContain('blocker=必须修复')
    expect(req.schema).toContain('"tag-order"')
    expect(req.schema).toContain('"cross-shot-consistency"')
    expect(req.schema).toContain('"dimensionScores"')
    expect(req.user).toContain('1girl, smile')
    expect(req.user).toContain('一个微笑的女孩')
    // 非预期参数不进入：此断言仅记录签名为三段式
    expect(Object.keys(req).sort()).toEqual(['persona', 'schema', 'user'])
  })

  it('规格3：verdict=pass 但 score<passThreshold → 改判 needs_revision（其余字段保留）', async () => {
    const provider: CriticProvider = async () => ok('pass', { dimensionScores: { 'tag-order': 40, 'cross-shot-consistency': 40 } })
    const r = await judgeReview({ ...baseInput(), provider })
    expect(r).toMatchObject({ verdict: 'needs_revision', score: 40 })
  })

  it('规格3b：verdict=pass 但 findings 含 blocker → 改判 needs_revision', async () => {
    const provider: CriticProvider = async () => ok('pass', { findings: [finding({ severity: 'blocker' })] })
    const r = await judgeReview({ ...baseInput(), provider })
    expect(r).toMatchObject({ verdict: 'needs_revision' })
    expect((r as any).findings[0].severity).toBe('blocker')
  })

  it('规格4：缺 evidence 三键任一的 finding 被丢弃；全丢后 needs_revision → 改判 pass', async () => {
    const provider: CriticProvider = async () => ok('needs_revision', {
      findings: [
        finding({ evidence: { tool: 'catalog', query: 'x' } }),           // 缺 result
        finding({ evidence: { query: 'x', result: 'y' } }),               // 缺 tool
        finding({ evidence: { tool: 'catalog', result: 'y' } }),          // 缺 query
        finding({ evidence: { tool: 'catalog', query: 'x', result: '' } }), // 空串视为无有效证据
      ],
    })
    const r = await judgeReview({ ...baseInput(), provider })
    expect(r).toMatchObject({ verdict: 'pass' })
    expect((r as any).findings).toHaveLength(0)
  })

  it('规格4b：有 evidence 的 finding 保留，verdict=needs_revision 维持', async () => {
    const provider: CriticProvider = async () => ok('needs_revision', {
      findings: [
        finding({ evidence: { tool: 'tokenizer', query: 'x', result: 'tokens=42' } }),
        finding(),
      ],
    })
    const r = await judgeReview({ ...baseInput(), provider })
    expect(r).toMatchObject({ verdict: 'needs_revision' })
    expect((r as any).findings).toHaveLength(2)
  })

  it('规格4-F1：needs_revision + 零有效 findings + score=50 → 终局改判 pass（规格4 对 needs_revision 终局生效，不再被规格3 低分改回）', async () => {
    const provider: CriticProvider = async () => ok('needs_revision', { dimensionScores: { 'tag-order': 50, 'cross-shot-consistency': 50 }, findings: [] })
    const r = await judgeReview({ ...baseInput(), provider })
    expect(r).toMatchObject({ verdict: 'pass', score: 50 })
    expect((r as any).findings).toHaveLength(0)
  })

  it('规格4-F1b：needs_revision + 零有效 findings + findings 含 blocker（已丢弃）→ 仍改判 pass', async () => {
    const provider: CriticProvider = async () => ok('needs_revision', {
      dimensionScores: { 'tag-order': 50, 'cross-shot-consistency': 50 },
      findings: [finding({ severity: 'blocker', evidence: { tool: 'catalog', query: 'x' } })], // 无效证据，被丢弃
    })
    const r = await judgeReview({ ...baseInput(), provider })
    expect(r).toMatchObject({ verdict: 'pass' })
  })

  it('规格5a：provider 抛错 → skipped，绝不抛出', async () => {
    const provider: CriticProvider = async () => { throw new Error('boom') }
    const r = await judgeReview({ ...baseInput(), provider })
    expect(r).toEqual({ skipped: true, reason: expect.any(String) })
  })

  it('规格5b：provider 返回非 JSON → skipped', async () => {
    const provider: CriticProvider = async () => '这不是 JSON'
    const r = await judgeReview({ ...baseInput(), provider })
    expect(r).toEqual({ skipped: true, reason: expect.any(String) })
  })

  it('规格5c：schema 不合（verdict 非法 / 缺 score）→ skipped', async () => {
    const bad1: CriticProvider = async () => JSON.stringify({ verdict: 'maybe', dimensionScores: { 'tag-order': 80, 'cross-shot-consistency': 80 }, findings: [], praise: [] })
    const bad2: CriticProvider = async () => JSON.stringify({ verdict: 'pass', findings: [], praise: [] })
    // 旧单数字 score 字段不再接受（schema 移除）：缺 dimensionScores → skipped
    const r1 = await judgeReview({ ...baseInput(), provider: bad1 })
    const r2 = await judgeReview({ ...baseInput(), provider: bad2 })
    expect(r1).toMatchObject({ skipped: true })
    expect(r2).toMatchObject({ skipped: true, reason: 'invalid_dimensions' })
  })

  it('finding id：有效 findings 按序编号 f1…fN（LLM 不产 id，parse 后由代码编号）', async () => {
    const provider: CriticProvider = async () => ok('needs_revision', {
      dimensionScores: { 'tag-order': 40, 'cross-shot-consistency': 40 },
      findings: [finding(), finding({ dimension: 'cross-shot-consistency', problem: '角色描述矛盾' })],
    })
    const r = await judgeReview({ ...baseInput(), provider })
    const findings = (r as any).findings
    expect(findings).toHaveLength(2)
    expect(findings[0].id).toBe('f1')
    expect(findings[1].id).toBe('f2')
  })

  it('维度加权分：score = Math.round(Σ weight × dimScore)，由代码计算', async () => {
    const provider: CriticProvider = async () => ok('pass', {
      dimensionScores: { 'tag-order': 83, 'cross-shot-consistency': 67 }, // 0.5*83 + 0.5*67 = 75
    })
    const r = await judgeReview({ ...baseInput(), provider })
    expect((r as any).score).toBe(75)
  })

  it('invalid_dimensions：缺维度 / 多维度 / 非法值 / 非对象 → 整体 skipped reason=invalid_dimensions', async () => {
    const cases: unknown[] = [
      { 'tag-order': 80 },                                                                        // 缺 cross-shot-consistency
      { 'tag-order': 80, 'cross-shot-consistency': 80, extra: 80 },                               // 多维度
      { 'tag-order': 'high', 'cross-shot-consistency': 80 },                                      // 非数字
      { 'tag-order': 80, 'cross-shot-consistency': 101 },                                         // 越界
      { 'tag-order': 80, 'cross-shot-consistency': Number.NaN },                                  // 非法数
      'not-an-object',                                                                            // 非对象
    ]
    for (const dimensionScores of cases) {
      const provider: CriticProvider = async () => ok('pass', { dimensionScores })
      const r = await judgeReview({ ...baseInput(), provider })
      expect(r).toMatchObject({ skipped: true, reason: 'invalid_dimensions' })
    }
  })

  it('规格6：revision 模式——user 含 firstFindings 与修正说明，逻辑同 first', async () => {
    const provider = vi.fn().mockResolvedValue(ok('pass'))
    const firstFindings = [finding()]
    const r = await judgeReview({
      ...baseInput(),
      provider,
      stage: 'revision',
      firstFindings: firstFindings as any,
    })
    expect(r).toMatchObject({ verdict: 'pass' })
    const req = provider.mock.calls[0][0]
    expect(req.user).toContain('revision')
    expect(req.user).toContain('tag 顺序错')
    expect(req.user).toContain(JSON.stringify(firstFindings))
  })

  it('规格6b：revision 提供 revisionNote → 注入 user payload', async () => {
    const provider = vi.fn().mockResolvedValue(ok('pass'))
    await judgeReview({
      ...baseInput(),
      provider,
      stage: 'revision',
      firstFindings: [finding()] as any,
      revisionNote: '已把 1girl 前移并补齐质量 tag',
    })
    const req = provider.mock.calls[0][0]
    expect(req.user).toContain('已把 1girl 前移并补齐质量 tag')
  })

  it('规格6c：revision 缺省 revisionNote → payload 明确写「修正说明：未提供」，并保留 firstFindings + compiled', async () => {
    const provider = vi.fn().mockResolvedValue(ok('pass'))
    await judgeReview({
      ...baseInput(),
      provider,
      stage: 'revision',
      firstFindings: [finding()] as any,
    })
    const req = provider.mock.calls[0][0]
    expect(req.user).toContain('修正说明：未提供')
    expect(req.user).toContain('tag 顺序错')
    expect(req.user).toContain('1girl, smile')
    // 不再引导核对不存在的「修正说明」字段
    expect(req.user).not.toContain('核对编译产物的修正说明')
  })

  it('first 模式不受 revisionNote 影响：user 不含修正说明节', async () => {
    const provider = vi.fn().mockResolvedValue(ok('pass'))
    await judgeReview({ ...baseInput(), provider, revisionNote: '不应出现' })
    const req = provider.mock.calls[0][0]
    expect(req.user).not.toContain('不应出现')
    expect(req.user).not.toContain('修正说明')
  })

describe('A5 evidenceOptional（spec §10.2-A5）', () => {
  const optInput = () => ({ ...baseInput(), rubric: RUBRIC_OPT })

  it('evidenceOptional 维度的 finding 无证据也放行，加 evidenceAssumed: true，verdict 维持 needs_revision', async () => {
    const provider: CriticProvider = async () => JSON.stringify({
      verdict: 'needs_revision',
      dimensionScores: { structure: 50, aesthetics: 40 },
      findings: [{ severity: 'major', dimension: 'aesthetics', problem: 'beautiful 太抽象', requiredFix: '换成具体风格词' }],
      praise: [],
    })
    const r = await judgeReview({ ...optInput(), provider })
    expect(r).toMatchObject({ verdict: 'needs_revision' })
    const findings = (r as any).findings
    expect(findings).toHaveLength(1)
    expect(findings[0].evidenceAssumed).toBe(true)
    expect(findings[0].id).toBe('f1')
  })

  it('非 evidenceOptional 维度无证据 → 照旧丢弃；仅剩 evidenceOptional 无证据 findings 时非零有效，不触发规格4', async () => {
    const provider: CriticProvider = async () => JSON.stringify({
      verdict: 'needs_revision',
      dimensionScores: { structure: 50, aesthetics: 40 },
      findings: [
        { severity: 'major', dimension: 'structure', problem: '缺段', requiredFix: '补齐' },          // 无证据 → 丢
        { severity: 'minor', dimension: 'aesthetics', problem: '色彩词弱', requiredFix: '补具体色' }, // 放行
      ],
      praise: [],
    })
    const r = await judgeReview({ ...optInput(), provider })
    expect(r).toMatchObject({ verdict: 'needs_revision' })
    expect((r as any).findings).toHaveLength(1)
    expect((r as any).findings[0].dimension).toBe('aesthetics')
  })

  it('evidenceOptional 维度照常参与 dimensionScores 加权，铁律不影响打分', async () => {
    const provider: CriticProvider = async () => JSON.stringify({
      verdict: 'pass',
      dimensionScores: { structure: 90, aesthetics: 80 }, // 0.6*90 + 0.4*80 = 86
      findings: [{ severity: 'minor', dimension: 'aesthetics', problem: '可更具体', requiredFix: 'x' }],
      praise: [],
    })
    const r = await judgeReview({ ...optInput(), provider })
    expect((r as any).score).toBe(86)
    expect(r).toMatchObject({ verdict: 'pass' })
  })

  it('persona/schema 标注证据可选维度', async () => {
    const provider = vi.fn().mockResolvedValue(JSON.stringify({
      verdict: 'pass', dimensionScores: { structure: 90, aesthetics: 90 }, findings: [], praise: [],
    }))
    await judgeReview({ ...optInput(), provider })
    const req = provider.mock.calls[0][0]
    expect(req.persona).toContain('证据可选')
    expect(req.persona).toContain('该维度 finding 无证据也可输出')
    expect(req.schema).toContain('"structure"')
    expect(req.schema).toContain('"aesthetics"')
  })
})

  it('装配：createSubagentCriticProvider 用 ctx.subagents.start 装配，生命周期 start→result→dispose，文本 strip fence 后可解析', async () => {
    const dispose = vi.fn()
    const start = vi.fn().mockResolvedValue({
      id: 'run-1',
      result: Promise.resolve({
        output: [{ type: 'text', text: '```json\n' + ok('pass') + '\n```' }],
        stopReason: 'completed',
      }),
      dispose,
    })
    const ownerCtx: any = { subagents: { start } }
    const provider = createSubagentCriticProvider(ownerCtx)
    const out = await provider({ persona: 'P', schema: 'S', user: 'U' })
    expect(start).toHaveBeenCalledTimes(1)
    const [providerName, req] = start.mock.calls[0]
    expect(providerName).toBe('spawn')
    expect(JSON.stringify(req.prompt)).toContain('P')
    expect(JSON.stringify(req.prompt)).toContain('S')
    expect(JSON.stringify(req.prompt)).toContain('U')
    expect(dispose).toHaveBeenCalled()
    // provider 返回原始文本（含 fence）；fence 剥离是 judgeReview 的职责
    const parsed = JSON.parse(out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim())
    expect(parsed).toMatchObject({ verdict: 'pass' })
  })

  it('装配：ownerCtx 不可用 → 返回的 provider 被调用时抛错（由 judgeReview catch 后 skipped）', async () => {
    const provider = createSubagentCriticProvider(undefined)
    await expect(provider({ persona: 'P', schema: 'S', user: 'U' })).rejects.toThrow()
    const r = await judgeReview({ ...baseInput(), provider })
    expect(r).toMatchObject({ skipped: true })
  })
})
