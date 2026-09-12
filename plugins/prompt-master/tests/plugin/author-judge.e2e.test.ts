/**
 * Task 6（spec §2.4 / §3.1 / §2.3）：prompt_author 评审工具面 e2e。
 * 六条行为规格，全部 mock criticProvider / evidenceDeps / revisionProvider（不打真连）。
 * 最高约束（T9 后）：显式 `judge_mode:'off', enrich:false` 与一期缺省逐字段一致（除 generation_id）；评审用例一律补 enrich:false 隔离（enrich 缺省已开，见 author-enrich.e2e）。
 */
import { describe, expect, it, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  registerAuthorTool,
  setAuthorIntentProvider,
  setAuthorJudgeDeps,
  setAuthorFeedbackDbPath,
  type AuthorIntentRequest,
} from '../../src/tools/prompt-author.js'
import { getGeneration, recordFeedback } from '../../src/pe-framework/feedback/store.js'
import type { CriticFinding, CriticProvider } from '../../src/pe-framework/eval/critic.js'
import type { EvidenceDeps } from '../../src/pe-framework/eval/evidence.js'
import type { StageResult } from '../../src/pe-framework/pipeline/types.js'
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

// D10（外部基准 2026-09）：rubric 扩为 7 维（composition/lighting-color/aesthetic-vocabulary 替换 aesthetics），
// critic mock 的维度分必须与 ANIMA_RUBRIC 维度 id 精确一致（dimensionScoresOf 缺/多即 invalid_dimensions）
const dimScores = (v: number) => ({
  'tag-order': v, contradiction: v, 'tag-evidence': v, 'negative-template': v,
  composition: v, 'lighting-color': v, 'aesthetic-vocabulary': v,
})
const PASS_JSON = JSON.stringify({ verdict: 'pass', dimensionScores: dimScores(90), findings: [], praise: [] })
const NEEDS_FIX = {
  severity: 'major', dimension: 'tag-order', problem: 'tag 顺序错',
  evidence: { tool: 'catalog', query: '1girl', result: 'canonical,n=120' },
  requiredFix: '把质量词前移到主体前',
}
const NEEDS_JSON = JSON.stringify({ verdict: 'needs_revision', dimensionScores: dimScores(50), findings: [NEEDS_FIX], praise: [] })

const mockEvidence: EvidenceDeps = {
  catalog: (q) => [{ tag: q, kind: 'canonical', count: 1 }],
  aesthetics: (q) => ({ concreteness: 'pass', query_len: q.length }),
}

describe('Task6 规格1（T9 迁移）显式关闭回退：judge_mode:off + enrich:false 与一期缺省逐字段一致', () => {
  it('显式 judge_mode:off + enrich:false → 行为与现版本一致（除 generation_id），critic/enrich provider 零调用', async () => {
    const critic = criticOf([PASS_JSON])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'off', enrich: false })))
    expect(raw.ok).toBe(true)
    expect(raw.result.positive).toBe('masterpiece, best quality, score_7, safe, 1girl, long hair')
    expect(critic.calls).toBe(0)
    expect(raw.judge).toBeUndefined()
    expect(raw.debate).toBeUndefined()
    expect(raw.judgeFeedback).toBeUndefined()
    expect(raw.enrichment).toBeUndefined()
    expect(intentCalls[0].input).toBe('cat portrait')
    expect(typeof raw.generation_id).toBe('string')
    expect(raw.generation_id).toMatch(/^gen_\d+_[0-9a-z]+$/)
  })
})

describe('规格2 fast + 评审 pass', () => {
  it('Envelope 带 judge.verdict=pass、debate 单轮', async () => {
    const critic = criticOf([PASS_JSON])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'fast', enrich: false })))
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
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'fast', enrich: false })))
    // 首轮 + 2 轮修正 = intent 3 次调用；评审在每轮 runStage 内发生 = critic 3 次
    expect(intentCalls).toHaveLength(3)
    expect(critic.calls).toBe(3)
    // 修正轮 feedback 含规则 gate 行 + judgeFeedback 行（finding 文本必须出现）
    expect(intentCalls[1].feedback).toContain('把质量词前移到主体前')
    expect(raw.ok).toBe(true) // 规则审计通过 → ok 不变
    expect(raw.judge).toMatchObject({ verdict: 'needs_revision' })
    expect(raw.judgeFeedback).toEqual(['[major] 把质量词前移到主体前'])
    expect(raw.observability.corrections).toBe(2)
    // 2026-09-12 P3：judge needs_revision 耗尽修正轮 → 必须浮出 loop_exhausted（此前静默交付，
    // 下游误报「评审 pass」——真实样本 session 89a0dce0）
    expect(raw.advisories).toContain('loop_exhausted:true')
  })
})

describe('规格4 judge LLM 全挂 → 降级出稿', () => {
  it('ok 仍为 true，judge.skipped=true，advisories 含 judge_skipped', async () => {
    const critic = criticOf(['THROW'])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'fast', enrich: false })))
    expect(raw.ok).toBe(true)
    expect(raw.judge).toMatchObject({ skipped: true })
    expect(raw.advisories).toContain('judge_skipped')
    expect(raw.debate).toBeUndefined()
  })
})

describe('规格7 fast + 规则 critical → judge skipped(rule_critical) 不投影（review F1, spec §2.5）', () => {
  it('Envelope 无 judge/debate/judgeFeedback 字段；advisories 无 judge_skipped；闭环仍由 gates 驱动（loop_exhausted 照常）', async () => {
    const critic = criticOf([PASS_JSON])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return { shots: { duration_seconds: 6, shots: [{ what: 'A cat stretches.' }] } } as never })
    // i2va + 无 references → ref_count 规则 critical → runStage 返回 judge={skipped:true,reason:'rule_critical'}
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'h3', input: 'cat stretch', stage: 'i2va', judge_mode: 'fast', enrich: false })))
    expect(raw.ok).toBe(false)
    // 跳过评审不是评审结果：judge 字段缺省
    expect(raw.judge).toBeUndefined()
    expect(raw.debate).toBeUndefined()
    expect(raw.judgeFeedback).toBeUndefined()
    // 评审根本没发生：critic 零调用；advisories 与现状一致（无 judge_skipped，rule critical 照常闭环）
    expect(critic.calls).toBe(0)
    expect(raw.advisories).not.toContain('judge_skipped')
    expect(raw.advisories).toContain('loop_exhausted:true')
    expect(raw.observability.corrections).toBe(2)
    expect(raw.generation_id).toMatch(/^gen_\d+_[0-9a-z]+$/)
  })
})

describe('Round7 T4 规格5：judgeTopLevel 投影联动收紧（ruleCriticalSkip 防御契约，构造直调）', () => {
  it('ruleCriticalSkip 时 judge/debate/judgeFeedback 三字段均不投影（杜绝 judge 缺省却带 debate 的不一致 envelope）；其他 skipped reason 保持 judge 投影', async () => {
    // 直调构造：runStage 的 ruleCritical 分支本就早退（debate=[]/judgeFeedback=undefined），
    // 投影联动只能在该分支的防御契约层面构造验证
    const { judgeTopLevel } = await import('../../src/tools/prompt-author.js')
    const base = { ok: true, result: {}, gates: [], advisories: [], assumptions: [], targetSlotHint: 't2i.prompt' }
    const suppressed = judgeTopLevel({
      ...base,
      judge: { skipped: true, reason: 'rule_critical' },
      debate: [{ round: 1, reviewer: { findings: [], score: 0 } }],
      judgeFeedback: ['[major] fix'],
    } as StageResult)
    expect(suppressed).toEqual({})
    // 对照：非 ruleCritical 的 skipped（如 LLM 故障）保持投影（judge_skipped advisory 可见）
    const llmDown = judgeTopLevel({ ...base, judge: { skipped: true, reason: 'critic_error:boom' } } as StageResult)
    expect(llmDown).toEqual({ judge: { skipped: true, reason: 'critic_error:boom' } })
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
  it('首评 needs_revision → revisionProvider 修正稿 → 复审（A2 独立契约）全关闭 → pass，debate 两轮含 reviser', async () => {
    // A2 迁移（spec §10.1-A2）：复审 round2 不再是全量评审 JSON，而是关闭/反驳裁决契约
    const REV_PASS_JSON = JSON.stringify({
      verdict: 'pass', closedFindingIds: ['f1'], unresolved: [], rebuttalVerdicts: [],
    })
    const critic = criticOf([NEEDS_JSON, REV_PASS_JSON])
    let revisionInput: { compiled: unknown; findings: unknown[]; praise: unknown } | null = null
    const revisionProvider = async (compiled: unknown, findings: CriticFinding[], praise: string[]) => {
      revisionInput = { compiled, findings, praise }
      const c = compiled as Record<string, unknown>
      return {
        compiled: { ...c, positive: `${String(c.positive)}, detailed face` },
        changes: ['补具体细节 tag'],
        revisionNote: '已把质量词前移并补细节',
        rebuttals: [],
      }
    }
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence, revisionProvider })
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'strict', enrich: false })))
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

// final review C1：author 非 audit_only 成功出口落库 generations（飞轮死链修复）
describe('final-fix C1：author 落库 generations', () => {
  let dbDir: string
  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'pm-author-db-'))
    setAuthorFeedbackDbPath(join(dbDir, 'feedback.sqlite'))
  })

  it('fast + pass → generation 记录存在且 judge_score 正确；feedback record 可挂', async () => {
    const critic = criticOf([PASS_JSON])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'fast', enrich: false })))
    expect(raw.ok).toBe(true)
    const gen = getGeneration(join(dbDir, 'feedback.sqlite'), raw.generation_id)
    expect(gen).toBeDefined()
    expect(gen!.target).toBe('anima')
    expect(gen!.judge_mode).toBe('fast')
    expect(gen!.judge_score).toBe(90)
    expect(gen!.judge_verdict).toBe('pass')
    expect(gen!.input_digest).toBe(createHash('sha256').update('cat portrait', 'utf8').digest('hex'))
    expect(String(gen!.final_output)).toContain('1girl, long hair')
    expect(gen!.debate_json).toBeDefined()
    // 飞轮回路闭合：该 generation_id 可直接挂人工反馈
    const fb = recordFeedback(join(dbDir, 'feedback.sqlite'), { generation_id: raw.generation_id, rating: 4 })
    expect(fb).toEqual({ ok: true })
  })

  it('judge skipped（LLM 故障）→ 记录存在但不填 judge_score/verdict', async () => {
    const critic = criticOf(['THROW'])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'fast', enrich: false })))
    const gen = getGeneration(join(dbDir, 'feedback.sqlite'), raw.generation_id)
    expect(gen).toBeDefined()
    expect(gen!.judge_score).toBeUndefined()
    expect(gen!.judge_verdict).toBeUndefined()
  })

  it('judge_mode=off → 也落库（judge_mode=off，无 judge 字段）', async () => {
    setAuthorJudgeDeps(null)
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'off', enrich: false })))
    const gen = getGeneration(join(dbDir, 'feedback.sqlite'), raw.generation_id)
    expect(gen).toBeDefined()
    expect(gen!.judge_mode).toBe('off')
    expect(gen!.judge_score).toBeUndefined()
  })

  it('audit_only → 不落库（读路径无可反馈结果）', async () => {
    setAuthorJudgeDeps(null)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), {
      target: 'anima', audit_only: true,
      input: JSON.stringify({ count_gender: ['1girl'], appearance: ['long hair'] }),
    })))
    expect(raw.generation_id).toMatch(/^gen_\d+_[0-9a-z]+$/)
    expect(getGeneration(join(dbDir, 'feedback.sqlite'), raw.generation_id)).toBeUndefined()
  })

  it('落库失败 → 不阻塞出稿，advisories 含 feedback_write_failed', async () => {
    // 父路径是文件 → mkdirSync/openDb 必失败
    const blocker = join(dbDir, 'not-a-dir')
    writeFileSync(blocker, 'x', 'utf8')
    setAuthorFeedbackDbPath(join(blocker, 'feedback.sqlite'))
    setAuthorJudgeDeps(null)
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'off', enrich: false })))
    expect(raw.ok).toBe(true)
    expect(String(raw.result.positive)).toContain('1girl')
    expect(raw.advisories).toContain('feedback_write_failed')
  })
})

/* ── T4（spec §10.2-A3/A4, §10.4-A12/A13）：makeRevisionProvider v2 工具面 ── */

const dimScores5 = (v: number) => ({
  'tag-order': v, contradiction: v, 'tag-evidence': v, 'negative-template': v,
  composition: v, 'lighting-color': v, 'aesthetic-vocabulary': v,
})
const REV_CLOSE_F1 = JSON.stringify({ verdict: 'pass', closedFindingIds: ['f1'], unresolved: [], rebuttalVerdicts: [] })

describe('T4 规格1 praise 锚点 + 规格3 patch 失败回退整稿重拆', () => {
  it('首轮 praise 非空 → 修订 prompt 含「以下优点须保留：…」+ 条目 + 禁删指令；定位不到字段 → fallback:full-rebuild', async () => {
    const finding = {
      severity: 'major', dimension: 'aesthetic-vocabulary', problem: '夜空氛围不足',
      evidence: { tool: 'catalog', query: 'night sky', result: 'night sky atmosphere' },
      requiredFix: 'starry sky backdrop',
    }
    const NEEDS_PRAISE = JSON.stringify({ verdict: 'needs_revision', dimensionScores: dimScores5(50), findings: [finding], praise: ['构图干净'] })
    const critic = criticOf([NEEDS_PRAISE, REV_CLOSE_F1])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence }) // 不注入 revisionProvider → 生产 makeRevisionProvider
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'strict', enrich: false })))
    expect(raw.judge).toMatchObject({ verdict: 'pass' })
    // patch 定位不到字段（night sky 与 1girl/long hair 零交集）→ 回退整稿重拆（intent 第 2 次调用）
    expect(intentCalls).toHaveLength(2)
    const fb = intentCalls[1].feedback ?? ''
    expect(fb).toContain('以下优点须保留')
    expect(fb).toContain('构图干净')
    expect(fb).toContain('不得删除上述优点对应的内容')
    expect(fb).toContain('starry sky backdrop')
    expect(raw.debate[1].reviser.changes).toContain('fallback:full-rebuild')
  })
})

describe('T4 规格3 稿内编辑成功（anima 槽字段 patch，不重拆）', () => {
  it('finding 定位到 1girl 所在槽 → requiredFix 追加为该槽 tag，intent provider 不再调用，changes 记录所改字段', async () => {
    // F4：requiredFix 用英文——patch 会把 requiredFix 注入 positive 槽位，CJK 文本会被
    // cjk_in_positive（critical）守门拦下并触发重拆闭环，patch 路径需 CJK-free 输入才能测到
    const NEEDS_FIX_EN = {
      severity: 'major', dimension: 'tag-order', problem: 'tag order wrong',
      evidence: { tool: 'catalog', query: '1girl', result: 'canonical,n=120' },
      requiredFix: 'move quality tags before subject',
    }
    const NEEDS_JSON_EN = JSON.stringify({ verdict: 'needs_revision', dimensionScores: dimScores(50), findings: [NEEDS_FIX_EN], praise: [] })
    const critic = criticOf([NEEDS_JSON_EN, REV_CLOSE_F1])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'strict', enrich: false })))
    // patch 成功 → 不重拆（intent 只有 round 0 一次调用）
    expect(intentCalls).toHaveLength(1)
    expect(String(raw.result.positive)).toContain('move quality tags before subject')
    expect(raw.debate[1].reviser.changes[0]).toContain('patch:slot count_gender')
    expect(raw.debate[1].reviser.changes.join('\n')).not.toContain('fallback')
    expect(raw.judge).toMatchObject({ verdict: 'pass' })
    expect(critic.calls).toBe(2)
  })
})

describe('T4 规格2 结构化 rebuttals（requiredFix 已在稿内 → 带证据反驳）', () => {
  it('patch 路径产 rebuttals 直通 debate round2.reviser.rebuttals（provider 优先于 reviewer-accepted 映射）', async () => {
    const SLOTS = { slots: { count_gender: ['1girl'], appearance: ['detailed face'] } }
    const finding = {
      severity: 'minor', dimension: 'aesthetic-vocabulary', problem: '细节不足',
      evidence: { tool: 'catalog', query: 'detailed face', result: 'detailed face already present' },
      requiredFix: 'detailed face',
    }
    const NEEDS = JSON.stringify({ verdict: 'needs_revision', dimensionScores: dimScores5(60), findings: [finding], praise: [] })
    const REV_ACCEPT = JSON.stringify({ verdict: 'pass', closedFindingIds: [], unresolved: [], rebuttalVerdicts: [{ finding_id: 'f1', accepted: true, reason: '反驳成立' }] })
    const critic = criticOf([NEEDS, REV_ACCEPT])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    setAuthorIntentProvider(async () => SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'strict', enrich: false })))
    const reb = raw.debate[1].reviser.rebuttals
    expect(reb).toHaveLength(1)
    expect(reb[0].finding_id).toBe('f1')
    expect(reb[0].rebuttal).toContain('已在稿内')
    expect(reb[0].evidence).toContain('detailed face')
    expect(reb[0].evidence).not.toBe('reviewer-accepted') // provider 一手证据优先
  })
})

describe('T4 规格3 h3 镜头段 patch', () => {
  it('finding 定位到 [Shot N] 段 → requiredFix 重写该镜头段文本，不重拆', async () => {
    const finding = {
      severity: 'major', dimension: 'shot-increment', problem: '动作不清晰',
      evidence: { tool: 'aesthetics', query: 'cat stretches', result: 'pass concreteness' },
      requiredFix: 'The cat yawns and blinks slowly',
    }
    const NEEDS_H3 = JSON.stringify({
      verdict: 'needs_revision',
      dimensionScores: { 'shot-structure': 40, 'shot-increment': 40, 'cross-shot-consistency': 40, 'duration-fit': 40, pacing: 40, 'atmosphere-coupling': 40, 'performance-causality': 40, 'continuity-exit-entry': 40, 'camera-motivation': 40 },
      findings: [finding], praise: [],
    })
    const critic = criticOf([NEEDS_H3, REV_CLOSE_F1])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    setAuthorIntentProvider(async () => ({ shots: { duration_seconds: 6, shots: [{ what: 'A cat stretches' }] } }) as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'h3', input: 'cat stretch', judge_mode: 'strict', enrich: false })))
    expect(String(raw.result.text)).toContain('[Shot 1] The cat yawns and blinks slowly.')
    expect(raw.debate[1].reviser.changes[0]).toBe('patch:shot 1 (finding f1)')
    expect(raw.judge).toMatchObject({ verdict: 'pass' })
  })
})

describe('T4 规格4 judgeRepair=false 修正轮跳过评审', () => {
  it('judge_mode=fast + judgeRepair:false → critic 仅首轮 1 次调用，闭环由规则 gates + judgeFeedback 首轮投影驱动', async () => {
    const critic = criticOf([NEEDS_JSON])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'fast', enrich: false, judgeRepair: false })))
    expect(critic.calls).toBe(1) // 修正轮 provider 零调用
    expect(intentCalls).toHaveLength(2) // 首轮 + 1 轮修正（judgeFeedback 首轮投影驱动）
    expect(raw.observability.corrections).toBe(1)
    expect(raw.ok).toBe(true)
    expect(raw.judge).toMatchObject({ verdict: 'needs_revision' })
  })
})

afterAll(() => { setAuthorIntentProvider(null); setAuthorJudgeDeps(null); setAuthorFeedbackDbPath(null); closeCatalog() })
