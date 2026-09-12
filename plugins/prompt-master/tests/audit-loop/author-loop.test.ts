import { describe, expect, it, afterAll } from 'vitest'
import { registerAuthorTool, setAuthorIntentProvider, type AuthorIntentRequest } from '../../src/tools/prompt-author.js'
import { stubCtx, runTool } from '../plugin/helpers.js'

const cfg = { temperature: 0.7 }

/** Per-round h3 drafts: round0 uses 2 references (critical ref_count) → round>=1 uses 3 (good) */
function loopProvider() {
  const rounds: number[] = []
  const fn = async (req: AuthorIntentRequest) => {
    rounds.push(req.round)
    const count = req.round === 0 ? 2 : 3
    return {
      shots: {
        duration_seconds: 8,
        shots: [{ what: 'A waves.', who: 'A' }],
        references: Array.from({ length: count }, (_, i) => ({ kind: 'picture', who: ['A', 'B', 'C'][i], image: `${['A', 'B', 'C'][i]}.png` })),
      },
    }
  }
  return { fn, rounds: () => rounds }
}

describe('prompt_author correction loop (P4)', () => {
  it('bad → critical → corrected on 2nd intent round → passed', async () => {
    const { fn, rounds } = loopProvider()
    setAuthorIntentProvider(fn)
    const raw = JSON.parse(String(await runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), { target: 'h3', input: 'x', judge_mode: 'off', enrich: false })))
    expect(rounds()).toEqual([0, 1]) // round0 bad (2 refs) → 1 correction (3 refs) → good
    expect(raw.ok).toBe(true)
    expect(raw.audit.passed).toBe(true)
    expect(raw.audit.gates.some((g: any) => g.rule === 'ref_count')).toBe(false)
  })

  it('two corrections still failing → loop_exhausted advisory', async () => {
    let calls = 0
    setAuthorIntentProvider(async () => {
      calls++
      // Always bad: constant 2 refs (ref_count critical)
      return {
        shots: {
          duration_seconds: 8,
          shots: [{ what: 'A waves.', who: 'A' }],
          references: [{ kind: 'picture', who: 'A', image: 'a.png' }, { kind: 'picture', who: 'B', image: 'b.png' }],
        },
      }
    })
    const raw = JSON.parse(String(await runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), { target: 'h3', input: 'x', judge_mode: 'off', enrich: false })))
    expect(calls).toBe(3) // round0 + 2 corrections
    expect(raw.ok).toBe(false)
    expect(raw.advisories).toContain('loop_exhausted:true')
  })

  it('audit_only performs zero LLM calls', async () => {
    let calls = 0
    setAuthorIntentProvider(async () => { calls++; return { slots: { count_gender: ['1girl'] } } })
    await runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), {
      target: 'anima', audit_only: true, input: JSON.stringify({ count_gender: ['1girl'] }),
    })
    expect(calls).toBe(0)
  })

  it('F1: ref2va with 2 references is rejected as critical ref_count gate (loop not engaged)', async () => {
    setAuthorIntentProvider(async () => ({
      shots: {
        duration_seconds: 8,
        shots: [{ what: 'Neko waves.', who: 'Neko' }],
        references: [{ kind: 'picture', who: 'Neko', image: 'n.png' }, { kind: 'picture', who: 'Mei', image: 'm.png' }],
      },
    }))
    const raw = JSON.parse(String(await runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), { target: 'h3', input: 'x', judge_mode: 'off', enrich: false })))
    expect(raw.ok).toBe(false)
    expect(raw.audit.gates.some((g: any) => g.rule === 'ref_count' && g.severity === 'critical')).toBe(true)
  })

  it('F2: full_reference scenario without references → references_unmapped advisory + critical gate', async () => {
    setAuthorIntentProvider(async () => ({
      shots: { duration_seconds: 10, shots: [{ what: 'a snow house', who: 'Snow' }] },
    }))
    const raw = JSON.parse(String(await runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), {
      target: 'h3', input: 'x', scenario_id: 'full_reference', judge_mode: 'off', enrich: false,
      form_fields: { subject: 'snow house', duration_seconds: '10' },
    })))
    expect(raw.advisories).toContain('references_unmapped')
    expect(raw.audit.gates.some((g: any) => g.rule === 'references_unmapped' && g.severity === 'critical')).toBe(true)
  })

  // Round7 T6：三期 T3 闭环联动的行为级锚定——中文片段触发 cjk_in_positive critical 后，
  // 修正闭环必须真走（intent provider 第二次调用 + feedback 携带 gate detail），修正后英文稿出稿 ok
  it('cjk_in_positive critical (Chinese fragment) truly drives the correction loop → English draft ok', async () => {
    const reqs: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => {
      reqs.push(req)
      return req.round === 0
        ? { slots: { count_gender: ['1girl'], appearance: ['蓝色短发'] } } // 含中文片段 → cjk_in_positive critical
        : { slots: { count_gender: ['1girl'], appearance: ['blue short hair'] } } // 修正轮纯英文
    })
    const raw = JSON.parse(String(await runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), { target: 'anima', input: 'x', judge_mode: 'off', enrich: false })))
    expect(reqs.map((r) => r.round)).toEqual([0, 1]) // intent provider 第二次调用——闭环真走
    // feedback 携带 cjk gate 的 detail 片段文本（闭环驱动内容可观测）
    expect(reqs[1].feedback).toContain('cjk_in_positive')
    expect(reqs[1].feedback).toContain('cjk fragment in positive (invalid for anima tag library)')
    expect(reqs[1].feedback).toContain('蓝色短发')
    // 修正后英文稿出稿 ok=true，cjk gate 不再出现
    expect(raw.ok).toBe(true)
    expect(raw.audit.passed).toBe(true)
    expect(raw.audit.gates.some((g: any) => g.rule === 'cjk_in_positive')).toBe(false)
  })

  // Round 8 F7：tag_budget_exceeded（important）随修正 feedback 拼接传达——闭环触发仍只认
  // critical（cjk 驱动），但首轮超预算的软预算裁剪指令必须真的到达 intent 修正轮（feedback 含
  // tag_budget_exceeded detail），修正轮裁剪到预算内 → 最终出稿 ok=true 且 gate 消失
  it('F7: over-budget important gate detail rides correction feedback → trimmed draft ok', async () => {
    const reqs: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => {
      reqs.push(req)
      if (req.round === 0) {
        // 40 appearance（39 英文 + 1 中文片段→cjk critical 驱动闭环）+ 1 count_gender = 41 槽位
        // tag + 4 质量前缀 = 45 段 > 40 → tag_budget_exceeded（important）
        return { slots: { count_gender: ['1girl'], appearance: [...Array.from({ length: 39 }, (_, i) => `tag${i + 1}`), '蓝色短发'] } }
      }
      // 修正轮：裁剪到预算内——29 appearance + 1 count_gender + 4 前缀 = 34 段 ≤ 40，纯英文
      return { slots: { count_gender: ['1girl'], appearance: Array.from({ length: 29 }, (_, i) => `tag${i + 1}`) } }
    })
    const raw = JSON.parse(String(await runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), { target: 'anima', input: 'x', judge_mode: 'off', enrich: false })))
    expect(reqs.map((r) => r.round)).toEqual([0, 1]) // 闭环真走（cjk critical 驱动），修正轮后收敛
    // 软预算裁剪指令随 feedback 到达 intent 修正轮（F7 链路实测）
    expect(reqs[1].feedback).toContain('tag_budget_exceeded')
    expect(reqs[1].feedback).toContain('场景细节>氛围词>次要动作')
    // 闭环驱动源不变：critical gate 照旧在 feedback 里
    expect(reqs[1].feedback).toContain('cjk_in_positive')
    // 修正稿在预算内 → 最终出稿 ok，预算 gate 消失
    expect(raw.ok).toBe(true)
    expect(raw.audit.passed).toBe(true)
    expect(raw.audit.gates.some((g: any) => g.rule === 'tag_budget_exceeded')).toBe(false)
  })

  afterAll(() => setAuthorIntentProvider(null))
})