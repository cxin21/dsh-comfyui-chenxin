import { describe, it, expect, vi } from 'vitest'
import { judgeReview, createSubagentCriticProvider } from '../../../src/pe-framework/eval/critic.js'
import type { CriticProvider, CriticFinding } from '../../../src/pe-framework/eval/critic.js'
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
    evidence: { tool: 'catalog', query: '1girl', result: '1girl hit(3)' },
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
        finding({ evidence: { tool: 'tokenizer', query: 'tokens', result: 'tokens=42' } }),
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

  describe('A2 revision 独立契约（spec §10.1-A2, §2.3）：只验 findings 关闭 + 反驳裁决，非全量重评', () => {
    const firstFindings: CriticFinding[] = [
      { id: 'f1', severity: 'blocker', dimension: 'tag-order', problem: 'tag 顺序错', requiredFix: '把 1girl 放最前' },
      { id: 'f2', severity: 'major', dimension: 'cross-shot-consistency', problem: '角色矛盾', requiredFix: '统一描述' },
      { id: 'f3', severity: 'minor', dimension: 'tag-order', problem: '风格词弱', requiredFix: '补具体风格词' },
    ]
    const revInput = (over: Record<string, unknown> = {}) => ({
      ...baseInput(),
      stage: 'revision' as const,
      firstFindings,
      firstScore: 40,
      firstPraise: ['结构清晰'],
      revisionNote: '已修复 f1/f2',
      provider: undefined as unknown as CriticProvider,
      ...over,
    })
    const rev = (over: Record<string, unknown> = {}) => JSON.stringify({
      verdict: 'pass', closedFindingIds: ['f1', 'f2'], unresolved: [], rebuttalVerdicts: [], ...over,
    })

    it('规格3：revision user 只含首轮 findings（id+problem+requiredFix）、修正说明与裁决任务；断言负向——无「重新评审」「dimensionScores」/编译产物/原意/证据工具', async () => {
      const provider = vi.fn().mockResolvedValue(rev())
      await judgeReview(revInput({ provider }))
      const req = provider.mock.calls[0][0]
      expect(req.user).toContain('tag 顺序错')
      expect(req.user).toContain('"requiredFix":"把 1girl 放最前"')
      expect(req.user).toContain('已修复 f1/f2')
      expect(req.user).toContain('closedFindingIds')
      expect(req.user).toContain('rebuttalVerdicts')
      expect(req.user).not.toContain('重新评审')
      expect(req.user).not.toContain('dimensionScores')
      expect(req.user).not.toContain('1girl, smile')          // 编译产物不进 revision user
      expect(req.user).not.toContain('一个微笑的女孩')          // originalIntent 不进
      expect(req.user).not.toContain('可用证据工具')            // 回查线索不进（规格6）
      expect(req.schema).not.toContain('dimensionScores')     // 独立 schema 无维度分
      expect(req.schema).toContain('closedFindingIds')
    })

    it('规格6c：revision 缺省 revisionNote → payload 明确写「修正说明：未提供」', async () => {
      const provider = vi.fn().mockResolvedValue(rev())
      const { revisionNote: _n, ...inp } = revInput()
      await judgeReview({ ...inp, provider })
      expect(provider.mock.calls[0][0].user).toContain('修正说明：未提供')
    })

    it('规格2：verdict=pass 条件 = 全部首轮 blocker/major 关闭或反驳被接受；score 透传首轮分；praise 继承首轮', async () => {
      const r = await judgeReview(revInput({ provider: async () => rev() }))
      expect(r).toMatchObject({ verdict: 'pass', score: 40, praise: ['结构清晰'], rebuttalVerdicts: [] })
      // minor f3 未在关闭清单 → 原样保留（pass 条件只看 blocker/major）
      expect((r as any).findings).toHaveLength(1)
      expect((r as any).findings[0].id).toBe('f3')
    })

    it('规格2b：未关闭的 blocker/major 被反驳接受（accepted=true）→ pass；该 finding 不再保留', async () => {
      const r = await judgeReview(revInput({
        provider: async () => rev({
          closedFindingIds: ['f1'], unresolved: ['f2', 'f3'],
          rebuttalVerdicts: [{ finding_id: 'f2', accepted: true, reason: '跨镜头引用实为同一角色' }],
        }),
      }))
      expect(r).toMatchObject({ verdict: 'pass' })
      expect((r as any).findings).toHaveLength(1)
      expect((r as any).findings[0].id).toBe('f3')
    })

    it('规格2c：有未关闭且未被反驳接受的 blocker/major → needs_revision；findings=存活 finding 原样保留（id 不变）；minor 存活不阻断', async () => {
      const r = await judgeReview(revInput({
        provider: async () => rev({
          closedFindingIds: ['f1'], unresolved: ['f2', 'f3'],
          rebuttalVerdicts: [{ finding_id: 'f2', accepted: false, reason: '反驳不成立' }],
        }),
      }))
      expect(r).toMatchObject({ verdict: 'needs_revision', score: 40 })
      const findings = (r as any).findings
      expect(findings).toHaveLength(2)
      expect(findings[0]).toMatchObject({ id: 'f2', severity: 'major', problem: '角色矛盾' })
      expect(findings[1]).toMatchObject({ id: 'f3', severity: 'minor' })
    })

    it('规格2d：仅剩 minor 未关闭 → pass（pass 条件只看 blocker/major）', async () => {
      const r = await judgeReview(revInput({
        provider: async () => rev({ closedFindingIds: ['f1', 'f2'], unresolved: ['f3'] }),
      }))
      expect(r).toMatchObject({ verdict: 'pass' })
      expect((r as any).findings).toHaveLength(1)
      expect((r as any).findings[0].id).toBe('f3')
    })

    it('规格5：revision verdict 由契约数据推导（契约即裁决），不再过规格3/规格4 归一——无 dimensionScores 不触发 invalid_dimensions；首轮阈值不作用', async () => {
      // provider 自称 pass + 存活 blocker → 推导 needs_revision
      const r1 = await judgeReview(revInput({ provider: async () => rev({ closedFindingIds: [], unresolved: ['f1'] }) }))
      expect(r1).toMatchObject({ verdict: 'needs_revision' })
      // provider 自称 needs_revision + 全关闭 → 推导 pass
      const r2 = await judgeReview(revInput({ provider: async () => rev({ verdict: 'needs_revision' }) }))
      expect(r2).toMatchObject({ verdict: 'pass' })
    })

    it('校验：字段缺失/类型错 → 整体 skipped reason=invalid_revision_schema', async () => {
      const bads: unknown[] = [
        'not json',
        { verdict: 'pass' },                                                                                                        // 缺三字段
        { verdict: 'maybe', closedFindingIds: [], unresolved: [], rebuttalVerdicts: [] },                                            // verdict 非法
        { verdict: 'pass', closedFindingIds: 'f1', unresolved: [], rebuttalVerdicts: [] },                                           // 非数组
        { verdict: 'pass', closedFindingIds: [''], unresolved: [], rebuttalVerdicts: [] },                                           // 空 id
        { verdict: 'pass', closedFindingIds: [], unresolved: [], rebuttalVerdicts: [{ finding_id: 'f1', accepted: 'yes', reason: 'x' }] }, // accepted 非布尔
        { verdict: 'pass', closedFindingIds: [], unresolved: [], rebuttalVerdicts: [{ finding_id: 'f1', accepted: true }] },          // 缺 reason
        { verdict: 'pass', closedFindingIds: ['f9'], unresolved: [], rebuttalVerdicts: [] },                                         // 引用不存在 id
        { verdict: 'pass', closedFindingIds: [], unresolved: ['f9'], rebuttalVerdicts: [] },                                         // unresolved 悬空引用
        { verdict: 'pass', closedFindingIds: [], unresolved: [], rebuttalVerdicts: [{ finding_id: 'f9', accepted: true, reason: 'x' }] }, // rebuttal 悬空引用
      ]
      for (const bad of bads) {
        const r = await judgeReview(revInput({ provider: async () => (typeof bad === 'string' ? bad : JSON.stringify(bad)) }))
        expect(r).toEqual({ skipped: true, reason: 'invalid_revision_schema' })
      }
    })

    it('Round7 T4 规格1：firstScore 缺省 → skipped reason=missing_first_score（复审必须基于首轮分，不再静默 score:0；provider 零调用）', async () => {
      const provider = vi.fn()
      const { firstScore: _fs, ...inp } = revInput()
      const r = await judgeReview({ ...inp, provider })
      expect(r).toEqual({ skipped: true, reason: 'missing_first_score' })
      expect(provider).not.toHaveBeenCalled()
    })

    it('Round7 T4 规格2：rebuttal reason 空串/纯空白 → 整体 skipped invalid_revision_schema（与 finding_id 同严格度）', async () => {
      for (const reason of ['', '   ']) {
        const r = await judgeReview(revInput({
          provider: async () => rev({ rebuttalVerdicts: [{ finding_id: 'f1', accepted: true, reason }] }),
        }))
        expect(r).toEqual({ skipped: true, reason: 'invalid_revision_schema' })
      }
    })

    it('Round7 T4 规格3：同一 finding id 同时出现在 closedFindingIds 与 unresolved → 整体 skipped invalid_revision_schema（resolved 以 closed 为准的隐式行为废弃）', async () => {
      const r = await judgeReview(revInput({
        provider: async () => rev({ closedFindingIds: ['f1', 'f2'], unresolved: ['f2', 'f3'] }),
      }))
      expect(r).toEqual({ skipped: true, reason: 'invalid_revision_schema' })
    })

    it('规格6：revision 轮不触发证据回查（无新 evidence 产出、bridge.query 零调用、无 evidenceUnverified 标志）', async () => {
      const bridge = fakeBridge()
      const r = await judgeReview(revInput({ bridge, provider: async () => rev() }))
      expect(bridge.query).not.toHaveBeenCalled()
      expect((r as any).evidenceUnverified).toBeUndefined()
    })
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

describe('A1 证据回查复核（spec §10.1-A1）', () => {
  function bridgeOf(list: () => EvidenceToolId[], queryImpl: (tool: EvidenceToolId, q: string) => Promise<EvidenceResult>): EvidenceBridge & { query: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> } {
    return { list: vi.fn(list), query: vi.fn(queryImpl) }
  }
  const fullList = () => ['catalog', 'tokenizer'] as EvidenceToolId[]
  const hitBridge = () => bridgeOf(fullList, async (tool, q) => ({ tool, query: q, summary: `catalog confirms ${q} canonical`, ok: true }))

  it('规格1+4：携带 evidence 且非 evidenceAssumed → query(tool,query) 回查命中 → finding 保留 + evidence.verified=true', async () => {
    const bridge = hitBridge()
    const r = await judgeReview({ ...baseInput(), bridge, provider: async () => ok('pass') })
    expect(bridge.query).toHaveBeenCalledWith('catalog', '1girl')
    const findings = (r as any).findings
    expect(findings).toHaveLength(1)
    expect(findings[0].evidence.verified).toBe(true)
  })

  it('evidenceAssumed 的 finding 天然跳过回查（无 query 调用）', async () => {
    const bridge = hitBridge()
    const provider: CriticProvider = async () => JSON.stringify({
      verdict: 'needs_revision',
      dimensionScores: { structure: 50, aesthetics: 40 },
      findings: [{ severity: 'minor', dimension: 'aesthetics', problem: '色彩词弱', requiredFix: '补具体色' }],
      praise: [],
    })
    await judgeReview({ ...baseInput(), rubric: RUBRIC_OPT, bridge, provider })
    expect(bridge.query).not.toHaveBeenCalled()
  })

  it('规格2：回查 ok=false → 该 finding 丢弃；全丢后 needs_revision 按规格6 终局改判 pass', async () => {
    const bridge = bridgeOf(fullList, async (tool, q) => ({ tool, query: q, summary: 'tool unavailable', ok: false }))
    const r = await judgeReview({ ...baseInput(), bridge, provider: async () => ok('needs_revision', { dimensionScores: { 'tag-order': 50, 'cross-shot-consistency': 50 } }) })
    expect(r).toMatchObject({ verdict: 'pass' })
    expect((r as any).findings).toHaveLength(0)
    expect((r as any).evidenceUnverified).toBeUndefined()
  })

  it('规格2b：一条 ok=false 一条命中 → 只保留命中条', async () => {
    const bridge = bridgeOf(fullList, async (tool, q) =>
      q === 'bad' ? { tool, query: q, summary: 'tool unavailable', ok: false } : { tool, query: q, summary: `confirms ${q}`, ok: true })
    const provider: CriticProvider = async () => ok('needs_revision', {
      dimensionScores: { 'tag-order': 50, 'cross-shot-consistency': 50 },
      findings: [
        finding({ evidence: { tool: 'catalog', query: 'bad', result: 'never matches' } }),
        finding({ dimension: 'cross-shot-consistency', problem: '角色矛盾' }), // query 1girl 命中
      ],
    })
    const r = await judgeReview({ ...baseInput(), bridge, provider })
    expect(r).toMatchObject({ verdict: 'needs_revision' })
    expect((r as any).findings).toHaveLength(1)
    expect((r as any).findings[0].evidence.verified).toBe(true)
  })

  it('规格3：回查成功但 summary 与声称 result 实词交集为空（编造）→ 丢该 finding', async () => {
    const bridge = bridgeOf(fullList, async (tool, q) => ({ tool, query: q, summary: 'totally unrelated content here', ok: true }))
    const r = await judgeReview({ ...baseInput(), bridge, provider: async () => ok('needs_revision', { dimensionScores: { 'tag-order': 50, 'cross-shot-consistency': 50 } }) })
    expect(r).toMatchObject({ verdict: 'pass' })
    expect((r as any).findings).toHaveLength(0)
  })

  it('规格5a：单条 bridge.query 抛错 → 该 finding 保留 + outcome.evidenceUnverified=true', async () => {
    const bridge = bridgeOf(fullList, async () => { throw new Error('query down') })
    const r = await judgeReview({ ...baseInput(), bridge, provider: async () => ok('needs_revision') })
    expect(r).toMatchObject({ verdict: 'needs_revision', evidenceUnverified: true })
    expect((r as any).findings).toHaveLength(1)
  })

  it('规格5b/8：bridge 未传（可选参数）→ 跳过全部回查，findings 全保留 + evidenceUnverified=true', async () => {
    const { bridge: _b, ...noBridge } = baseInput()
    const r = await judgeReview({ ...noBridge, provider: async () => ok('needs_revision') })
    expect(r).toMatchObject({ verdict: 'needs_revision', evidenceUnverified: true })
    expect((r as any).findings).toHaveLength(1)
  })

  it('规格5c：bridge.list() 抛错 → 整体不可用：跳过回查 findings 全保留 + evidenceUnverified=true，user 仍可构造', async () => {
    const bridge = bridgeOf(() => { throw new Error('list down') }, async (tool, q) => ({ tool, query: q, summary: 'x', ok: true }))
    const provider = vi.fn().mockResolvedValue(ok('needs_revision'))
    const r = await judgeReview({ ...baseInput(), bridge, provider })
    expect(r).toMatchObject({ verdict: 'needs_revision', evidenceUnverified: true })
    expect((r as any).findings).toHaveLength(1)
    expect(provider.mock.calls[0][0].user).toContain('（无）')
    expect(bridge.query).not.toHaveBeenCalled()
  })

  it('carry-id：回查丢弃不重编号——存活的 finding 保留其原 id（f2），被丢的保持无 id 语义', async () => {
    const bridge = bridgeOf(fullList, async (tool, q) =>
      q === 'bad' ? { tool, query: q, summary: 'unrelated', ok: true } : { tool, query: q, summary: `confirms ${q}`, ok: true })
    const provider: CriticProvider = async () => ok('needs_revision', {
      dimensionScores: { 'tag-order': 50, 'cross-shot-consistency': 50 },
      findings: [
        finding({ evidence: { tool: 'catalog', query: 'bad', result: 'fabricated claim' } }),
        finding({ dimension: 'cross-shot-consistency', problem: '角色矛盾' }),
      ],
    })
    const r = await judgeReview({ ...baseInput(), bridge, provider })
    const findings = (r as any).findings
    expect(findings).toHaveLength(1)
    expect(findings[0].id).toBe('f2')
  })

  it('规格7（carry）：bridge 缺 rubric 声明的工具 → 该 finding 视为 evidenceOptional：无证据放行 + evidenceAssumed，声明工具的 evidence 不回查', async () => {
    const bridge = hitBridge()
    bridge.list.mockReturnValue(['catalog'] as EvidenceToolId[]) // tokenizer 缺
    const provider: CriticProvider = async () => ok('needs_revision', {
      dimensionScores: { 'tag-order': 50, 'cross-shot-consistency': 50 },
      findings: [
        finding(),                                                                          // tool=catalog 在 → 走回查命中
        finding({ dimension: 'cross-shot-consistency', evidence: { tool: 'tokenizer', query: 'x', result: 'whatever' } }),
        finding({ dimension: 'cross-shot-consistency', evidence: undefined }),               // 无证据：bridge 缺工具 → 放行
      ],
    })
    const r = await judgeReview({ ...baseInput(), bridge, provider })
    const findings = (r as any).findings
    expect(r).toMatchObject({ verdict: 'needs_revision' })
    expect(findings).toHaveLength(3)
    expect(findings[0].evidenceAssumed).toBeUndefined()
    expect(findings[0].evidence.verified).toBe(true)
    expect(findings[1].evidenceAssumed).toBe(true)
    expect(findings[2].evidenceAssumed).toBe(true)
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
    // 2026-09-12 P0：真实装配要求可解析的 parent（host 装配子代理读 parent.options），mock 同步补 agent
    const ownerCtx: any = { agent: { id: 'owner-agent' }, subagents: { start } }
    const provider = createSubagentCriticProvider(ownerCtx)
    const out = await provider({ persona: 'P', schema: 'S', user: 'U' })
    expect(start).toHaveBeenCalledTimes(1)
    const [providerName, req] = start.mock.calls[0]
    expect(providerName).toBe('spawn')
    expect(req.parent).toEqual({ id: 'owner-agent' })
    expect(JSON.stringify(req.prompt)).toContain('P')
    expect(JSON.stringify(req.prompt)).toContain('S')
    expect(JSON.stringify(req.prompt)).toContain('U')
    expect(dispose).toHaveBeenCalled()
    // provider 返回原始文本（含 fence）；fence 剥离是 judgeReview 的职责
    const parsed = JSON.parse(out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim())
    expect(parsed).toMatchObject({ verdict: 'pass' })
  })

  it('装配（2026-09-12 P0）：opts.parent 优先于 ownerCtx.agent 且必须进 start payload', async () => {
    const start = vi.fn().mockResolvedValue({
      id: 'run-p',
      result: Promise.resolve({ output: [{ type: 'text', text: ok('pass') }], stopReason: 'completed' }),
      dispose: vi.fn(),
    })
    const ownerCtx: any = { agent: { id: 'ctx-agent' }, subagents: { start } }
    const provider = createSubagentCriticProvider(ownerCtx, { parent: { id: 'exec-agent' } })
    await provider({ persona: 'P', schema: 'S', user: 'U' })
    expect(start.mock.calls[0][1].parent).toEqual({ id: 'exec-agent' })
  })

  it('装配（2026-09-12 P0）：opts.parent 与 ownerCtx.agent 均缺 → 抛可操作错误（judgeReview catch 后 skipped），不再落到 host TypeError', async () => {
    const start = vi.fn()
    const ownerCtx: any = { subagents: { start } }
    const provider = createSubagentCriticProvider(ownerCtx)
    await expect(provider({ persona: 'P', schema: 'S', user: 'U' })).rejects.toThrow(/需要调用 Agent 上下文/)
    expect(start).not.toHaveBeenCalled()
  })

  it('装配：ownerCtx 不可用 → 返回的 provider 被调用时抛错（由 judgeReview catch 后 skipped）', async () => {
    const provider = createSubagentCriticProvider(undefined)
    await expect(provider({ persona: 'P', schema: 'S', user: 'U' })).rejects.toThrow()
    const r = await judgeReview({ ...baseInput(), provider })
    expect(r).toMatchObject({ skipped: true })
  })
})
