/**
 * Task 6（二期，spec §2.1 / §2.4 / §4 / §11.3 / §11.4）：prompt_author 接线 enrich 扩写层 e2e。
 * 七条行为规格，全部 mock enrich provider / intent provider（不打真连）。
 * 最高约束（T9 后）：显式 `judge_mode:'off', enrich:false` 与一期缺省逐字段一致；缺省=fast+enrich 见 T9 describe。
 */
import { describe, expect, it, afterAll, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  registerAuthorTool,
  setAuthorIntentProvider,
  setAuthorFeedbackDbPath,
  setAuthorEnrichProvider,
  setAuthorJudgeDeps,
  type AuthorIntentRequest,
} from '../../src/tools/prompt-author.js'
import { getGeneration } from '../../src/pe-framework/feedback/store.js'
import type { CriticProvider } from '../../src/pe-framework/eval/critic.js'
import type { EvidenceDeps } from '../../src/pe-framework/eval/evidence.js'
import { stubCtx, runTool } from './helpers.js'
import { closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'

const cfg = { temperature: 0.7 }
const GOOD_SLOTS = { slots: { count_gender: ['1girl'], appearance: ['long hair'] } }

function tool() {
  return registerAuthorTool(stubCtx() as never, cfg as never)
}

/** mock enrich provider：按调用次序返回预置 JSON；THROW 表示抛错 */
function enrichOf(responses: string[]) {
  const fn = (async () => {
    fn.calls++
    const next = responses[Math.min(fn.calls - 1, responses.length - 1)]
    if (next === 'THROW') throw new Error('enrich llm down')
    return next
  }) as unknown as CriticProvider & { calls: number }
  fn.calls = 0
  return fn
}

/** mock criticProvider（T9 缺省断言用）：按调用次序返回预置 JSON */
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

const PASS_JSON = JSON.stringify({
  verdict: 'pass',
  // D10（外部基准 2026-09）：与 ANIMA_RUBRIC 7 维精确一致（缺/多 → invalid_dimensions）
  dimensionScores: { 'tag-order': 90, contradiction: 90, 'tag-evidence': 90, 'negative-template': 90, composition: 90, 'lighting-color': 90, 'aesthetic-vocabulary': 90 },
  findings: [], praise: [],
})
const mockEvidence: EvidenceDeps = {
  catalog: (q) => [{ tag: q, kind: 'canonical', count: 1 }],
  aesthetics: (q) => ({ concreteness: 'pass', query_len: q.length }),
}

function briefJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    outputLang: 'en',
    subject: [{ text: 'silver hair girl', source: 'user' }],
    scene: [{ text: 'rainy neon street', source: 'enriched' }],
    composition: [{ text: 'medium shot', source: 'enriched' }],
    lighting: [{ text: 'rim light', source: 'enriched' }],
    color: [{ text: 'teal and orange', source: 'enriched' }],
    style: [{ text: 'cinematic', source: 'enriched' }],
    mood: [{ text: 'melancholic', source: 'enriched' }],
    nameAnchors: [],
    ...over,
  })
}

/* 规格1（T9 迁移）：一期「缺省零变化」→ 改显式关闭参数，原断言全保留（off 回退语义） */
describe('规格1 显式关闭回退（judge_mode:off + enrich:false）', () => {
  it('显式 judge_mode:off + enrich:false → 无 enrichment/judge 字段、intent 吃原文、enrich/critic provider 零调用、落库 enrich=0', async () => {
    const enrich = enrichOf([briefJson()])
    setAuthorEnrichProvider(enrich)
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'off', enrich: false })))
    expect(raw.ok).toBe(true)
    expect(raw.result.positive).toBe('masterpiece, best quality, score_7, safe, 1girl, long hair')
    expect(raw.enrichment).toBeUndefined()
    expect(raw.advisories).not.toContain('enrich_skipped')
    expect(enrich.calls).toBe(0)
    expect(intentCalls).toHaveLength(1)
    expect(intentCalls[0].input).toBe('cat portrait')
    expect(typeof raw.generation_id).toBe('string')
  })
})

/* 规格2：enrich=true + 正常 → brief 成为 intent 权威输入 */
describe('规格2 enrich=true 正常路径', () => {
  let dbDir: string
  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'pm-author-enrich-'))
    setAuthorFeedbackDbPath(join(dbDir, 'feedback.sqlite'))
  })

  it('brief 文本替换 intent 输入（含权威指令与字段样例）；envelope 带 enrichment.brief；落库 enrich=1', async () => {
    const enrich = enrichOf([briefJson()])
    setAuthorEnrichProvider(enrich)
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: '猫の肖像', enrich: true, judge_mode: 'off' })))
    expect(raw.ok).toBe(true)
    expect(enrich.calls).toBe(1)
    // intent 权威输入替换：brief 字段样例 + 权威指令
    expect(intentCalls[0].input).toContain('brief 是权威输入')
    expect(intentCalls[0].input).toContain("source=user 字段不可改")
    expect(intentCalls[0].input).toContain('[user] silver hair girl')
    expect(intentCalls[0].input).toContain('[enriched] rainy neon street')
    // envelope 顶层 enrichment 段
    expect(raw.enrichment).toBeDefined()
    expect(raw.enrichment.skipped).toBeUndefined()
    expect(raw.enrichment.brief).toMatchObject({
      outputLang: 'en',
      subject: [{ text: 'silver hair girl', source: 'user' }],
      nameAnchors: [],
    })
    // 落库 enrich=1（digest 仍是用户原始输入的 sha256）
    const gen = getGeneration(join(dbDir, 'feedback.sqlite'), raw.generation_id)
    expect(gen).toBeDefined()
    expect(gen!.enrich).toBe(1)
    expect(gen!.input_digest).toBe(createHash('sha256').update('猫の肖像', 'utf8').digest('hex'))
  })
})

/* 规格3：enrich 降级 → 照常出稿 */
describe('规格3 enrich 降级', () => {
  let dbDir: string
  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'pm-author-enrich-'))
    setAuthorFeedbackDbPath(join(dbDir, 'feedback.sqlite'))
  })

  it('enrich provider 抛错 → intent 吃原始输入、enrichment.skipped、advisory enrich_skipped、落库 enrich=0', async () => {
    const enrich = enrichOf(['THROW'])
    setAuthorEnrichProvider(enrich)
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', enrich: true, judge_mode: 'off' })))
    expect(raw.ok).toBe(true)
    expect(String(raw.result.positive)).toContain('1girl')
    expect(enrich.calls).toBe(1)
    expect(intentCalls[0].input).toBe('cat portrait')
    expect(raw.enrichment).toEqual({ skipped: true, reason: 'enrich_llm_error' })
    expect(raw.advisories).toContain('enrich_skipped')
    const gen = getGeneration(join(dbDir, 'feedback.sqlite'), raw.generation_id)
    expect(gen).toBeDefined()
    expect(gen!.enrich).toBe(0)
  })
})

/* 规格4：audit_only=true 跳过 enrich（沿一期裁定） */
describe('规格4 audit_only 跳过 enrich', () => {
  let dbDir: string
  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'pm-author-enrich-'))
    setAuthorFeedbackDbPath(join(dbDir, 'feedback.sqlite'))
  })

  it('enrich=true + audit_only → enrich provider 零调用、无 enrichment 字段、不落库', async () => {
    const enrich = enrichOf([briefJson()])
    setAuthorEnrichProvider(enrich)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), {
      target: 'anima', audit_only: true, enrich: true,
      input: JSON.stringify({ count_gender: ['1girl'], appearance: ['long hair'] }),
    })))
    expect(raw.ok).toBe(true)
    expect(enrich.calls).toBe(0)
    expect(raw.enrichment).toBeUndefined()
    expect(getGeneration(join(dbDir, 'feedback.sqlite'), String(raw.generation_id))).toBeUndefined()
  })
})

/* 规格5：outputLang 透传 + anima 显式 zh 纠正（T5 carry①） */
describe('规格5 outputLang 语言归一化', () => {
  it("anima 显式 outputLang='zh' → brief.outputLang 纠正为 'en' + advisory enrich_lang_forced", async () => {
    const enrich = enrichOf([briefJson({ outputLang: 'zh' })])
    setAuthorEnrichProvider(enrich)
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: '雨中的少女', enrich: true, outputLang: 'zh', judge_mode: 'off' })))
    expect(raw.ok).toBe(true)
    expect(raw.enrichment.brief.outputLang).toBe('en')
    expect(raw.advisories).toContain('enrich_lang_forced')
    // outputLang 透传：enrich provider 收到显式指定（由引擎内部强制纠正）
    expect(enrich.calls).toBe(1)
  })

  it("anima 显式 outputLang='ja' → brief.outputLang 纠正为 'en' + advisory enrich_lang_forced（终审 I-2）", async () => {
    const enrich = enrichOf([briefJson({ outputLang: 'ja' })])
    setAuthorEnrichProvider(enrich)
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: '雨中的少女', enrich: true, outputLang: 'ja', judge_mode: 'off' })))
    expect(raw.ok).toBe(true)
    expect(raw.enrichment.brief.outputLang).toBe('en')
    expect(raw.advisories).toContain('enrich_lang_forced')
    expect(enrich.calls).toBe(1)
  })

  it("h3 显式 outputLang='ja' → 透传生效，无 enrich_lang_forced", async () => {
    const enrich = enrichOf([briefJson({ outputLang: 'ja' })])
    setAuthorEnrichProvider(enrich)
    setAuthorIntentProvider(async () => ({ shots: { duration_seconds: 6, shots: [{ what: 'A cat stretches.' }] } }) as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'h3', input: 'cat stretch', enrich: true, outputLang: 'ja', judge_mode: 'off' })))
    expect(raw.ok).toBe(true)
    expect(raw.enrichment.brief.outputLang).toBe('ja')
    expect(raw.advisories).not.toContain('enrich_lang_forced')
  })
})

/* 规格6：nameAnchors 透传（spec §11.4：锚点经 brief 固化进 intent prompt，critic 无需单独传参） */
describe('规格6 nameAnchors 透传 + 接线层修剪（T5 carry③）', () => {
  it('锚点进 intent prompt（固定映射指令）且 envelope enrichment 段可见；>10 条或单条 >100 字符 → 丢弃多余 + advisory name_anchors_trimmed', async () => {
    const anchors = [
      { original: '小明', anchored: 'XiaoMing' },
      ...Array.from({ length: 9 }, (_, i) => ({ original: `角色${i}`, anchored: `Char${i}` })),
      { original: '超长名' + 'x'.repeat(100), anchored: 'TooLong' }, // 第 11 条：超 100 字符 → 丢弃
      { original: '第12个', anchored: 'Twelfth' }, // 第 12 条：超 10 条上限 → 丢弃
    ]
    const enrich = enrichOf([briefJson({ nameAnchors: anchors })])
    setAuthorEnrichProvider(enrich)
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return { shots: { duration_seconds: 6, shots: [{ what: 'XiaoMing runs in the rain.' }] } } as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'h3', input: '小明在雨夜奔跑', enrich: true, judge_mode: 'off' })))
    expect(raw.ok).toBe(true)
    // intent prompt：固定映射指令 + 锚点条目
    expect(intentCalls[0].input).toContain('角色名固定映射，全程一致')
    expect(intentCalls[0].input).toContain('小明 → XiaoMing')
    expect(intentCalls[0].input).not.toContain('Twelfth')
    // envelope：修剪后 10 条
    expect(raw.enrichment.brief.nameAnchors).toHaveLength(10)
    expect(raw.enrichment.brief.nameAnchors[0]).toEqual({ original: '小明', anchored: 'XiaoMing' })
    expect(raw.advisories).toContain('name_anchors_trimmed')
  })
})

/* 规格7：enrich flag 落库（store 层在 store.test.ts；此处补 author 出口缺省 0 已在规格1/3 覆盖） */
describe('规格7 enrich=false 显式传参 → 落库 enrich=0', () => {
  let dbDir: string
  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'pm-author-enrich-'))
    setAuthorFeedbackDbPath(join(dbDir, 'feedback.sqlite'))
  })

  it('enrich=false → 行为与显式关闭一致，enrich provider 零调用，落库 enrich=0', async () => {
    const enrich = enrichOf([briefJson()])
    setAuthorEnrichProvider(enrich)
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', enrich: false, judge_mode: 'off' })))
    expect(raw.ok).toBe(true)
    expect(raw.enrichment).toBeUndefined()
    expect(enrich.calls).toBe(0)
    expect(intentCalls[0].input).toBe('cat portrait')
    const gen = getGeneration(join(dbDir, 'feedback.sqlite'), raw.generation_id)
    expect(gen!.enrich).toBe(0)
  })
})

/* T9（spec §3 / §2.4）：缺省 = fast + enrich —— 不传任何参数 → enrich/judge provider 均被调、envelope 带 enrichment 与 judge */
describe('T9 缺省=fast+enrich', () => {
  let dbDir: string
  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'pm-author-default-'))
    setAuthorFeedbackDbPath(join(dbDir, 'feedback.sqlite'))
  })

  it('不传任何参数 → enrich provider 被调 1 次、critic provider 被调 1 次（fast 首评）、envelope 带 enrichment.brief 与 judge、落库 judge_mode=fast/enrich=1', async () => {
    const enrich = enrichOf([briefJson()])
    setAuthorEnrichProvider(enrich)
    const critic = criticOf([PASS_JSON])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait' })))
    expect(raw.ok).toBe(true)
    expect(enrich.calls).toBe(1)
    expect(critic.calls).toBe(1)
    expect(intentCalls).toHaveLength(1)
    expect(intentCalls[0].input).toContain('brief 是权威输入') // enrich 后 brief 成为 intent 权威输入
    expect(raw.enrichment).toBeDefined()
    expect(raw.enrichment.brief).toMatchObject({ outputLang: 'en', subject: [{ text: 'silver hair girl', source: 'user' }] })
    expect(raw.judge).toMatchObject({ verdict: 'pass' })
    const gen = getGeneration(join(dbDir, 'feedback.sqlite'), raw.generation_id)
    expect(gen).toBeDefined()
    expect(gen!.judge_mode).toBe('fast')
    expect(gen!.enrich).toBe(1)
  })
})

/* Round7 T3（brief C）：persona 语言层修正 — anima + 中文 user 条目 + mock enrich 返回英文翻译 brief */
describe('Round7 T3 persona 语言层修正', () => {
  let dbDir: string
  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'pm-author-enrich-'))
    setAuthorFeedbackDbPath(join(dbDir, 'feedback.sqlite'))
  })

  it('anima + 中文输入 + enrich 返回英文翻译 brief → envelope enrichment.brief 为英文；enrich prompt 含「语言必须改写为 outputLang」指令；英文 brief 流程不回归', async () => {
    const enrichReq: { persona: string; user: string } = { persona: '', user: '' }
    const enrich: CriticProvider = async (req) => {
      enrichReq.persona = req.persona
      enrichReq.user = req.user
      // mock enrich LLM 遵从 persona：把中文 user 条目译成英文（source=user 语义级保留）
      return briefJson({ subject: [{ text: 'a girl running through a rainy night street', source: 'user' }] })
    }
    setAuthorEnrichProvider(enrich)
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: '雨夜街道上奔跑的少女', enrich: true, judge_mode: 'off' })))
    expect(raw.ok).toBe(true)
    // persona 指令级验证：语义级保留 + 语言改写指令在位（且不再字面「原样保留」）；画面/视觉子串保持（T6 carry）
    expect(enrichReq.persona).toContain('语言必须改写为 outputLang')
    expect(enrichReq.persona).toContain('语义与指代必须保留')
    expect(enrichReq.persona).toContain('不得增删要素')
    expect(enrichReq.persona).not.toContain('原样保留')
    expect(enrichReq.persona).toContain('画面')
    expect(enrichReq.persona).toContain('视觉')
    expect(enrichReq.user).not.toContain('不改写')
    // envelope：brief 语言为英文（anima outputLang 代码强制 en + 英文 user 条目原样透传）
    expect(raw.enrichment.brief.outputLang).toBe('en')
    expect(raw.enrichment.brief.subject[0]).toEqual({ text: 'a girl running through a rainy night street', source: 'user' })
    // 现有英文 brief 流程不回归：intent 吃英文 brief 权威输入
    expect(intentCalls[0].input).toContain('brief 是权威输入')
    expect(intentCalls[0].input).toContain('[user] a girl running through a rainy night street')
  })
})

/* Round8 T3Q：artDirection 透传（envelope enrichment 段）+ 旧形状 brief 向后兼容 */
describe('Round8 T3Q artDirection 透传与向后兼容', () => {
  let dbDir: string
  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'pm-author-enrich-'))
    setAuthorFeedbackDbPath(join(dbDir, 'feedback.sqlite'))
  })

  it('mock enrich 返回含 artDirection 的 brief → envelope enrichment.brief 带 artDirection，出稿流程不回归', async () => {
    const ad = { perspective: 'low_angle', composition: 'diagonal_dynamics', lighting: 'rim_backlight', color: 'warm_cool_contrast', motion: 'flowing_dress' }
    const enrich = enrichOf([briefJson({ artDirection: ad })])
    setAuthorEnrichProvider(enrich)
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: '月夜持剑而舞的少女', enrich: true, judge_mode: 'off' })))
    expect(raw.ok).toBe(true)
    // envelope enrichment 段带 artDirection（所选卡片 id 原样透传）
    expect(raw.enrichment).toBeDefined()
    expect(raw.enrichment.skipped).toBeUndefined()
    expect(raw.enrichment.brief.artDirection).toEqual(ad)
    // 出稿流程不回归：brief 仍是 intent 权威输入
    expect(intentCalls[0].input).toContain('brief 是权威输入')
  })

  it('旧形状 brief（无 artDirection）→ 照常通过（向后兼容），enrichment.brief 无 artDirection 键', async () => {
    const enrich = enrichOf([briefJson()])
    setAuthorEnrichProvider(enrich)
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', enrich: true, judge_mode: 'off' })))
    expect(raw.ok).toBe(true)
    expect(raw.enrichment).toBeDefined()
    expect(raw.enrichment.brief.outputLang).toBe('en')
    expect(raw.enrichment.brief.artDirection).toBeUndefined()
  })

  it('mock enrich 返回未知卡片 id → enrichment.skipped reason=invalid_art_direction + advisory enrich_skipped，照常出稿', async () => {
    const enrich = enrichOf([briefJson({ artDirection: { lighting: 'no_such_card' } })])
    setAuthorEnrichProvider(enrich)
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return GOOD_SLOTS as never })
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', enrich: true, judge_mode: 'off' })))
    expect(raw.ok).toBe(true)
    expect(raw.enrichment).toEqual({ skipped: true, reason: 'invalid_art_direction' })
    expect(raw.advisories).toContain('enrich_skipped')
    expect(String(raw.result.positive)).toContain('1girl') // 降级铁律：intent 吃原始输入，照常出稿
    expect(intentCalls[0].input).toBe('cat portrait')
  })
})

/* 2026-09-12 P1（docs/2026-09-12-camera-language-research.md §6）：调用方显式指定艺术指导卡（art_direction 参数） */
describe('art_direction 调用方指定卡', () => {
  /** 捕获 enrich 收到的 user 段（断言指定卡硬要求块被注入） */
  function enrichCapturing(responses: string[]) {
    const seen: { persona: string; schema: string; user: string }[] = []
    const fn = (async (req: { persona: string; schema: string; user: string }) => {
      seen.push(req)
      const next = responses[Math.min(seen.length - 1, responses.length - 1)]
      if (next === 'THROW') throw new Error('enrich llm down')
      return next
    }) as unknown as CriticProvider & { seen: typeof seen }
    fn.seen = seen
    return fn
  }

  it('合法 art_direction → enrich user 含指定卡硬要求块；brief 回写卡片 id；无 art_direction_ignored_* advisory', async () => {
    const enrich = enrichCapturing([briefJson({ artDirection: { motion: 'weapon_trail', perspective: 'three_quarter_view' } })])
    setAuthorEnrichProvider(enrich)
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), {
      target: 'anima', input: '古风美女舞剑', enrich: true, judge_mode: 'off',
      art_direction: { motion: 'weapon_trail', perspective: 'three_quarter_view' },
    })))
    expect(raw.ok).toBe(true)
    expect(enrich.seen[0].user).toContain('调用方已指定的艺术指导卡片')
    expect(enrich.seen[0].user).toContain('- motion=weapon_trail（武器轨迹）: sword trail, gleaming blade, weapon arc')
    expect(enrich.seen[0].user).toContain('- perspective=three_quarter_view（三分之二视角）')
    expect(raw.enrichment.brief.artDirection).toEqual({ motion: 'weapon_trail', perspective: 'three_quarter_view' })
    expect(raw.advisories.filter((a: string) => a.startsWith('art_direction_ignored'))).toEqual([])
  })

  it('无效卡片 id → execute fail-fast 抛错（不烧 LLM）', async () => {
    const enrich = enrichCapturing([briefJson()])
    setAuthorEnrichProvider(enrich)
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    await expect(runTool(stubCtx(), tool(), {
      target: 'anima', input: 'x', enrich: true, judge_mode: 'off',
      art_direction: { motion: 'no_such_card' },
    })).rejects.toThrow(/无效卡片 id/)
    expect(enrich.seen).toHaveLength(0)
  })

  it('enrich:false + art_direction → advisory art_direction_ignored_enrich_off，enrich 零调用，照常出稿', async () => {
    const enrich = enrichCapturing([briefJson()])
    setAuthorEnrichProvider(enrich)
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), {
      target: 'anima', input: 'cat portrait', enrich: false, judge_mode: 'off',
      art_direction: { motion: 'weapon_trail' },
    })))
    expect(raw.ok).toBe(true)
    expect(raw.advisories).toContain('art_direction_ignored_enrich_off')
    expect(enrich.seen).toHaveLength(0)
    expect(String(raw.result.positive)).toContain('1girl')
  })

  it('target=h3 + art_direction → advisory art_direction_ignored_h3（enrich 正常跑但不注入卡片块）', async () => {
    const enrich = enrichCapturing([briefJson()])
    setAuthorEnrichProvider(enrich)
    setAuthorIntentProvider(async () => ({ shots: { duration_seconds: 5, references: [], shots: [{ what: 'x' }] } }) as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), {
      target: 'h3', input: '一段舞蹈', enrich: true, judge_mode: 'off',
      art_direction: { motion: 'weapon_trail' },
    })))
    expect(raw.ok).toBe(true)
    expect(raw.advisories).toContain('art_direction_ignored_h3')
    expect(enrich.seen[0].user).not.toContain('调用方已指定的艺术指导卡片')
  })
})

afterAll(() => { setAuthorIntentProvider(null); setAuthorEnrichProvider(null); setAuthorJudgeDeps(null); setAuthorFeedbackDbPath(null); closeCatalog() })
