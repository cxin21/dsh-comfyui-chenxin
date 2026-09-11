/**
 * Task 6（spec §2.4 / §3.1 / §2.3）：prompt_author 评审工具面 e2e。
 * 六条行为规格，全部 mock criticProvider / evidenceDeps / revisionProvider（不打真连）。
 * 最高约束：缺省（不传 judge_mode）与现版本逐字段一致（除 generation_id），provider 零调用。
 */
import { describe, expect, it, afterAll } from 'vitest'
import {
  registerAuthorTool,
  setAuthorIntentProvider,
  setAuthorJudgeDeps,
  type AuthorIntentRequest,
} from '../../src/tools/prompt-author.js'
import type { CriticFinding, CriticProvider } from '../../src/pe-framework/eval/critic.js'
import type { EvidenceDeps } from '../../src/pe-framework/eval/evidence.js'
import { stubCtx, runTool } from './helpers.js'
import { closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'

const cfg = { temperature: 0.7 }

const GOOD_SLOTS = { slots: { count_gender: ['1girl'], appearance: ['long hair'] } }

function tool() {
  return registerAuthorTool(stubCtx() as never, cfg as never)
}

/** mock criticProvider：按调用次序返回预置 JSON；THROW 表示抛错 */
function criticOf(responses: string[]) {
  const fn = (async () => {
    fn.calls++
    const next = responses[Math.min(fn.calls - 1, responses.length - 1)]
    if (next === 'THROW') throw new Error('judge llm down')
    return next
  }) as unknown as CriticProvider & { calls: number }
  fn.calls = 0
  return fn
}

const PASS_JSON = JSON.stringify({ verdict: 'pass', score: 90, findings: [], praise: [] })
const NEEDS_FIX = {
  severity: 'major', dimension: 'tag-order', problem: 'tag 顺序错',
  evidence: { tool: 'catalog', query: '1girl', result: 'canonical,n=120' },
  requiredFix: '把质量词前移到主体前',
}
const NEEDS_JSON = JSON.stringify({ verdict: 'needs_revision', score: 50, findings: [NEEDS_FIX], praise: [] })

const mockEvidence: EvidenceDeps = {
  catalog: (q) => [{ tag: q, kind: 'canonical', count: 1 }],
  aesthetics: (q) => ({ concreteness: 'pass', query_len: q.length }),
}

describe('Task6 prompt_author 评审工具面：规格1 缺省零行为变化', () => {
  it('不传 judge_mode → 行为与现版本一致（除 generation_id），critic provider 零调用', async () => {
    const critic = criticOf([PASS_JSON])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait' })))
    expect(raw.ok).toBe(true)
    expect(raw.result.positive).toBe('masterpiece, best quality, score_7, safe, 1girl, long hair')
    expect(critic.calls).toBe(0)
    expect(raw.judge).toBeUndefined()
    expect(raw.debate).toBeUndefined()
    expect(raw.judgeFeedback).toBeUndefined()
    expect(typeof raw.generation_id).toBe('string')
    expect(raw.generation_id).toMatch(/^gen_\d+_[0-9a-z]+$/)
  })
})

describe('规格2 fast + 评审 pass', () => {
  it('Envelope 带 judge.verdict=pass、debate 单轮', async () => {
    const critic = criticOf([PASS_JSON])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'fast' })))
    expect(raw.ok).toBe(true)
    expect(raw.judge).toMatchObject({ verdict: 'pass' })
    expect(raw.debate).toHaveLength(1)
    expect(critic.calls).toBe(1)
  })
})

describe('规格3 fast + needs_revision 终态 → 工具层 max-2 闭环消费 judgeFeedback', () => {
  it('judgeFeedback 拼进修正轮 feedback（intent provider 收到 finding 文本）；两轮后停，loop_exhausted 语义不变', async () => {
    const critic = criticOf([NEEDS_JSON])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'fast' })))
    // 首轮 + 2 轮修正 = intent 3 次调用；评审在每轮 runStage 内发生 = critic 3 次
    expect(intentCalls).toHaveLength(3)
    expect(critic.calls).toBe(3)
    // 修正轮 feedback 含规则 gate 行 + judgeFeedback 行（finding 文本必须出现）
    expect(intentCalls[1].feedback).toContain('把质量词前移到主体前')
    expect(raw.ok).toBe(true) // 规则审计通过 → ok 不变
    expect(raw.judge).toMatchObject({ verdict: 'needs_revision' })
    expect(raw.judgeFeedback).toEqual(['[major] 把质量词前移到主体前'])
    expect(raw.observability.corrections).toBe(2)
    // loop_exhausted 语义不变：无规则 critical → 不置 loop_exhausted
    expect(raw.advisories).not.toContain('loop_exhausted:true')
  })
})

describe('规格4 judge LLM 全挂 → 降级出稿', () => {
  it('ok 仍为 true，judge.skipped=true，advisories 含 judge_skipped', async () => {
    const critic = criticOf(['THROW'])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'fast' })))
    expect(raw.ok).toBe(true)
    expect(raw.judge).toMatchObject({ skipped: true })
    expect(raw.advisories).toContain('judge_skipped')
    expect(raw.debate).toBeUndefined()
  })
})

describe('规格5 audit_only=true 不触发评审', () => {
  it('judge_mode=fast + audit_only → critic 零调用，judge/debate 缺省，generation_id 仍生成', async () => {
    const critic = criticOf([PASS_JSON])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), {
      target: 'anima', audit_only: true, judge_mode: 'fast',
      input: JSON.stringify({ count_gender: ['1girl'], appearance: ['long hair'] }),
    })))
    expect(raw.ok).toBe(true)
    expect(critic.calls).toBe(0)
    expect(intentCalls).toHaveLength(0)
    expect(raw.judge).toBeUndefined()
    expect(raw.debate).toBeUndefined()
    expect(raw.generation_id).toMatch(/^gen_\d+_[0-9a-z]+$/)
  })
})

describe('规格6 strict：revisionProvider 接线（mock 验证对抗二轮）', () => {
  it('首评 needs_revision → revisionProvider 修正稿 → 复审 pass，debate 两轮含 reviser', async () => {
    const critic = criticOf([NEEDS_JSON, PASS_JSON])
    let revisionInput: { compiled: unknown; findings: unknown[] } | null = null
    const revisionProvider = async (compiled: unknown, findings: CriticFinding[]) => {
      revisionInput = { compiled, findings }
      const c = compiled as Record<string, unknown>
      return {
        compiled: { ...c, positive: `${String(c.positive)}, detailed face` },
        changes: ['补具体细节 tag'],
        revisionNote: '已把质量词前移并补细节',
      }
    }
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence, revisionProvider })
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'strict' })))
    expect(raw.ok).toBe(true)
    expect(critic.calls).toBe(2)
    expect(raw.judge).toMatchObject({ verdict: 'pass' })
    expect(raw.debate).toHaveLength(2)
    expect(raw.debate[0].reviser).toBeUndefined()
    expect(raw.debate[1].reviser).toBeDefined()
    expect(raw.debate[1].reviser.changes).toEqual(['补具体细节 tag'])
    // 修正稿结果落 result
    expect(String(raw.result.positive)).toContain('detailed face')
    // revisionProvider 确实收到了首轮 compiled 与 findings
    const ri = revisionInput as unknown as { compiled: Record<string, unknown>; findings: Array<{ requiredFix: string }> }
    expect(ri).not.toBeNull()
    expect(ri.findings[0].requiredFix).toBe('把质量词前移到主体前')
  })
})

afterAll(() => { setAuthorIntentProvider(null); setAuthorJudgeDeps(null); closeCatalog() })
