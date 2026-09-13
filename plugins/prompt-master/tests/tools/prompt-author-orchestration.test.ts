import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  registerAuthorTool,
  setAuthorIntentProvider,
  setAuthorEnrichProvider,
  setAuthorFeedbackDbPath,
  setAuthorJudgeDeps,
  type AuthorIntentFn,
  type AuthorIntentRequest,
} from '../../src/tools/prompt-author.js'
import { createBlueprintRepo } from '../../src/pe-framework/blueprint/repo.js'
import { recordGeneration, getGeneration } from '../../src/pe-framework/feedback/store.js'
import { ANIMA_PERSONA } from '../../src/pe-framework/intent/subagent-provider.js'
import { ANIMA_BLUEPRINT_PERSONA, ANIMA_BLUEPRINT_SCHEMA } from '../../src/pe-framework/blueprint/analyzer.js'
import { stubCtx, runTool, textStream } from '../plugin/helpers.js'
import type { CriticProvider } from '../../src/pe-framework/eval/critic.js'
import type { EvidenceDeps } from '../../src/pe-framework/eval/evidence.js'

const cfg = { temperature: 0.7 }

function validBriefJson(): string {
  const item = { text: '1girl', source: 'user' }
  return JSON.stringify({
    outputLang: 'en',
    subject: [item],
    scene: [{ text: 'rainy neon street', source: 'enriched' }],
    composition: [{ text: 'medium shot', source: 'enriched' }],
    lighting: [{ text: 'soft ambient shading', source: 'enriched' }],
    color: [{ text: 'teal and orange', source: 'enriched' }],
    style: [{ text: 'cel shading', source: 'enriched' }],
    mood: [{ text: 'melancholic', source: 'enriched' }],
    nameAnchors: [],
  })
}

function capturingEnrich(sink: Array<{ persona: string; user: string }>): CriticProvider {
  return async (req) => {
    sink.push({ persona: req.persona, user: req.user })
    return validBriefJson()
  }
}

/** 最小合法蓝图（parseBlueprintJson 可过；作为 enrich patch 时为自合并无操作） */
const MINI_BP = {
  schema_version: 1,
  media: 'video',
  core: { concept: '三镜头打斗CG', negative: [] },
  media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] } },
}

function settingsRepo() {
  const store: Record<string, string> = {}
  return {
    settings: {
      get: () => ({ ...store }),
      async update(p: Record<string, string>) { Object.assign(store, p) },
      async replace(s: Record<string, string>) { Object.assign(store, s) },
    },
  }
}

// M5-T2（D8 双态 + D1 回滚面）：编码「anima 默认路径 enrich-brief/slots 直译」旧行为的既有用例
// 用 env kill-switch 钉回 slots 形态——这些用例验证的是被保留的兼容态语义（回滚面 R2 本身也是被测对象）
function pinSlotsForm() {
  beforeEach(() => { process.env.PM_AUTHOR_INTENT_FORM = 'slots' })
  afterEach(() => { delete process.env.PM_AUTHOR_INTENT_FORM })
}

/** M5-T2 测试载体：最小合法 anima 蓝图（image 形态，D3 增补字段齐备；scene 齐备保 checkFieldCompleteness 通过 → expansions_count=0 可断言） */
const MINI_IMAGE_BP = {
  schema_version: 1,
  media: 'image',
  core: { concept: '黄昏天台的少女', scene: { environment: 'rooftop', lighting: 'golden hour' }, negative: [] },
  media_layer: {
    image: {
      count_gender: ['1girl'],
      pose_action: ['standing'],
      expression: ['smile'],
      scene_anchors: ['rooftop', 'sunset'],
      camera_angle: 'cowboy shot',
    },
  },
}

// stubCtx 捕获的是 dsh-llm GenerateOptions：system 直挂顶层，user 文本在 messages[0].content[] 块内
function userTextOf(c: unknown): string {
  const msgs = (c as { messages?: Array<{ content?: unknown }> })?.messages ?? []
  const blocks = msgs[0]?.content
  if (typeof blocks === 'string') return blocks
  return Array.isArray(blocks) ? blocks.map((b) => (b as { text?: string })?.text ?? '').join('\n') : ''
}

let tmp: string
beforeEach(() => {
  // 隔离落库：author 成功出口会写 generations，重定向到临时目录
  tmp = mkdtempSync(join(tmpdir(), 'pm-orch-'))
  setAuthorFeedbackDbPath(join(tmp, 'feedback.sqlite'))
})
afterEach(() => {
  setAuthorFeedbackDbPath(null)
  setAuthorIntentProvider(null)
  setAuthorEnrichProvider(null)
  setAuthorJudgeDeps(null)
  rmSync(tmp, { recursive: true, force: true })
})

describe('prompt_author orchestration v2 (spec §8 §9)', () => {
  pinSlotsForm() // M5-T2（D8）：anima 默认路径 enrich-brief 旧行为用例钉回 slots 兼容态
  it('① preflight: explicit rating + loli input throws minor_content_conflict with zero LLM calls', async () => {
    let providerCalls = 0
    setAuthorIntentProvider(async () => { providerCalls++; return {} as ReturnType<AuthorIntentFn> })
    let enrichCalls = 0
    setAuthorEnrichProvider(async () => { enrichCalls++; return validBriefJson() })
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    await expect(
      runTool(ctx, def, { target: 'anima', input: 'loli 妹妹在花园里', rating: 'explicit', judge_mode: 'off' }),
    ).rejects.toThrow(/minor_content_conflict/)
    // 违规抛错发生在任何 LLM 之前（0 token）
    expect(providerCalls).toBe(0)
    expect(enrichCalls).toBe(0)
    expect(ctx.llm.calls.length).toBe(0)
  })

  it('② preflight: bikini input without rating escalates to sensitive (advisory + envelope + persona threading)', async () => {
    const sink: Array<{ persona: string; user: string }> = []
    setAuthorEnrichProvider(capturingEnrich(sink))
    setAuthorIntentProvider(async () => ({ slots: { count_gender: ['1girl'] } }))
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '泳池边的 bikini 少女', judge_mode: 'off' })))
    expect(v.rating.resolved).toBe('sensitive')
    expect(v.rating.escalatedFrom).toBe('safe')
    expect(v.rating.source).toBe('keyword')
    expect(v.advisories).toContain('rating_escalated:sensitive')
    // rating 透传进 enrich persona（Task 12 接线）
    expect(sink[0]?.persona).toContain('本请求内容分级：sensitive')
  })

  it('③ schema: audit_only removed; rating added with three-tier enum defaulting safe', () => {
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    // defineTool 把参数 spec 编译为 JSON Schema（{type:'object', properties:{…}}）；根对象显式开放
    //（不设 additionalProperties:false）——「audit_only 不再存在」以声明 schema 形状断言，非运行期拒收。
    const props = (def.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(props['audit_only']).toBeUndefined()
    const rating = props['rating'] as { type?: string; enum?: string[]; default?: string }
    expect(rating?.type).toBe('string')
    expect(rating?.enum).toEqual(['safe', 'sensitive', 'explicit'])
    expect(rating?.default).toBe('safe')
  })

  it('④ blueprint_id: incremental intent carries <old_blueprint> anchor; core.rating deterministically injected; three envelope fields', async () => {
    const { settings } = settingsRepo()
    const repo = createBlueprintRepo({ settings } as never)
    repo.save('bp-inc', MINI_BP as never)
    const ctx = stubCtx({ stream: textStream(JSON.stringify(MINI_BP)) })
    ;(ctx as unknown as { settings: unknown }).settings = settings
    const def = registerAuthorTool(ctx as never, cfg as never)
    // M3-T1b 载体修正：原载体 h3+explicit 与 spec §5.5 L185 冲突（h3 rating gate 落地后非法），
    // 换合法载体 h3+safe——core.rating 确定性注入与 envelope 三字段断言语义不变
    const v = JSON.parse(String(await runTool(ctx, def, {
      target: 'h3', blueprint_id: 'bp-inc', input: '把第二镜改成雨夜', rating: 'safe', judge_mode: 'off',
    })))
    // call#0 = 增量意图分析：persona 含 <old_blueprint> 锚定块与旧蓝图全文
    expect(ctx.llm.calls[0]?.system).toContain('<old_blueprint>')
    expect(ctx.llm.calls[0]?.system).toContain('三镜头打斗CG')
    // call#1 = enrichBlueprint：v0 携带确定性注入的 core.rating
    expect(userTextOf(ctx.llm.calls[1])).toContain('"rating":"safe"')
    // 三字段齐备（蓝图出口）
    expect(v.rating.resolved).toBe('safe')
    expect(v.rating.source).toBe('input')
    expect(Array.isArray(v.aesthetics.recommendedCards)).toBe(true)
    expect(v.style).toBeDefined()
    expect(Array.isArray(v.style.artists)).toBe(true)
    // input 必填豁免取消：blueprint_id 单独传入不再可用
    await expect(
      runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), { target: 'h3', blueprint_id: 'bp-inc', judge_mode: 'off' }),
    ).rejects.toThrow(/input 必填/)
  })

  it('⑤ default path envelope carries aesthetics.recommendedCards (anima=image: no motion card) + style + rating', async () => {
    const sink: Array<{ persona: string; user: string }> = []
    setAuthorEnrichProvider(capturingEnrich(sink))
    setAuthorIntentProvider(async () => ({ slots: { count_gender: ['1girl'], scene: ['花园'] } }))
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '花园里的少女', judge_mode: 'off' })))
    const cards = v.aesthetics.recommendedCards
    expect(Array.isArray(cards)).toBe(true)
    expect(cards.length).toBeGreaterThan(0)
    for (const c of cards) {
      expect(typeof c.field).toBe('string')
      expect(typeof c.cardId).toBe('string')
    }
    // anima → media=image：motion 维度被 media 门关掉（recommendArtDirection ①）
    expect(cards.some((c: { field: string }) => c.field === 'motion')).toBe(false)
    // 推荐先验进 enrich user 段（Task 10 → Task 14 → Task 12 接线）
    expect(sink[0]?.user).toContain('【推荐先验】')
    expect(v.rating).toBeDefined()
    expect(v.style).toBeDefined()
  })
})

describe('M2-T2 declaredRating judge wiring + h3 negative_hints advisory (spec §7 P3 / §4.3)', () => {
  // anima rubric 7 维分（与 author-judge.e2e 同形）：critic mock 的维度分必须与 ANIMA_RUBRIC 维度一致
  const dimScores = (v: number) => ({
    'tag-order': v, contradiction: v, 'tag-evidence': v, 'negative-template': v,
    composition: v, 'lighting-color': v, 'aesthetic-vocabulary': v,
  })
  const PASS_JSON = JSON.stringify({ verdict: 'pass', dimensionScores: dimScores(90), findings: [], praise: [] })
  const mockEvidence: EvidenceDeps = {
    catalog: (q) => [{ tag: q, kind: 'canonical', count: 1 }],
    aesthetics: (q) => ({ concreteness: 'pass', query_len: q.length }),
  }

  it('judge persona carries declaredRating tail line from the orchestration flow (keyword-escalated sensitive)', async () => {
    const criticReq: Array<{ persona: string; user: string }> = []
    const critic: CriticProvider = async (req) => {
      criticReq.push({ persona: req.persona, user: req.user })
      return PASS_JSON
    }
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: mockEvidence })
    setAuthorIntentProvider(async () => ({ slots: { count_gender: ['1girl'] } }))
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    // bikini 关键词 → 预检定档 sensitive → judgeOpts.declaredRating → runStage → judgeReview → buildPersona 尾行
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '泳池边的 bikini 少女', judge_mode: 'fast', enrich: false })))
    expect(v.ok).toBe(true)
    expect(v.judge.verdict).toBe('pass')
    expect(criticReq).toHaveLength(1)
    expect(criticReq[0]?.persona).toContain('当前内容分级：sensitive')
    expect(criticReq[0]?.persona).toContain('按评级中立条款评审')
    // 对照：显式 rating 声明档位同样透传（source=input）
    const criticReq2: Array<{ persona: string }> = []
    const critic2: CriticProvider = async (req) => { criticReq2.push({ persona: req.persona }); return PASS_JSON }
    setAuthorJudgeDeps({ criticProvider: critic2, evidenceDeps: mockEvidence })
    const v2 = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '花园里的少女', rating: 'explicit', judge_mode: 'fast', enrich: false })))
    expect(v2.judge.verdict).toBe('pass')
    expect(criticReq2[0]?.persona).toContain('当前内容分级：explicit')
  })

  it('blueprint path relays style_negative_hints_h3_ignored advisory to envelope advisories; negatives not merged', async () => {
    const { settings } = settingsRepo()
    const repo = createBlueprintRepo({ settings } as never)
    repo.save('bp-style-h3', MINI_BP as never)
    const ctx = stubCtx({ stream: textStream(JSON.stringify(MINI_BP)) })
    ;(ctx as unknown as { settings: unknown }).settings = settings
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, {
      target: 'h3', blueprint_id: 'bp-style-h3', input: '加一个雨夜镜头', style_id: 'cinematic_real', judge_mode: 'off',
    })))
    expect(v.advisories).toContain('style_negative_hints_h3_ignored:cinematic_real')
    // 仍不注入：style 摘要的 negativeAdded 为空（video 蓝图 core.negative 未被并入风格负向）
    expect(v.style.negativeAdded).toEqual([])
    // 风格其余接线不受影响：artist_hints 截断后写入（style 摘要可见）
    expect(v.style.id).toBe('cinematic_real')
    expect(v.style.artists.length).toBeGreaterThan(0)
  })
})

// 2026-09-12 审计 #1（spec §7 L223 降级语义）：enrich 在 explicit 档被 LLM 拒绝 → 现有故障
// 语义回退（enrich_skipped + user brief 直拆照常出稿）之外，增发档位可观测 advisory
// `enrich_refused_at_rating:explicit`；safe/sensitive 档不打（spec 仅明文 explicit 档）。
describe('audit-fix #1: enrich refusal advisory at declared rating (spec §7 L223)', () => {
  pinSlotsForm() // M5-T2（D8）：enrich-brief 层用例钉回 slots 兼容态（蓝图形态下 runEnrich 被 swap 掉）
  const refusingEnrich: CriticProvider = async () => { throw new Error('provider refused this content') }

  it('enrich refusal at explicit → enrich_refused_at_rating:explicit present alongside enrich_skipped', async () => {
    setAuthorEnrichProvider(refusingEnrich)
    setAuthorIntentProvider(async () => ({ slots: { count_gender: ['1girl'] } }))
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '花园里的少女', rating: 'explicit', judge_mode: 'off' })))
    // 通用 enrich_skipped 语义不动（故障回退路径不变）
    expect(v.advisories).toContain('enrich_skipped')
    // 档位可观测 advisory（本修复新增）
    expect(v.advisories).toContain('enrich_refused_at_rating:explicit')
    expect(v.enrichment.skipped).toBe(true)
  })

  it('enrich refusal at safe → enrich_skipped only, no rating advisory', async () => {
    setAuthorEnrichProvider(refusingEnrich)
    setAuthorIntentProvider(async () => ({ slots: { count_gender: ['1girl'] } }))
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '花园里的少女', judge_mode: 'off' })))
    expect(v.advisories).toContain('enrich_skipped')
    expect(v.advisories).not.toContain('enrich_refused_at_rating:explicit')
  })
})

describe('M3-T1b h3 rating gate at preflight (spec §5.5 L185)', () => {
  // t62 核实备案兑现：spec L185「target=h3 且 rating≠safe → argument error」在 prompt_author
  // 从未实现（原测试④曾把 h3+explicit 蓝图成功钉为绿——spec 与实现冲突由本轮核实）。
  // gate 语义与 t62 minimax_scenario 同源：resolved.rating≠safe（显式声明或关键词升档皆然）
  // → h3_rating_unsupported，政策依据 + 指路 target=anima，不做降级猜测，0 token。
  it.each(['sensitive', 'explicit'] as const)('h3 + explicit %s → h3_rating_unsupported before any LLM call (no downgrade guessing)', async (rating) => {
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    await expect(
      runTool(ctx, def, { target: 'h3', input: '花园里的少女', rating, judge_mode: 'off' }),
    ).rejects.toThrow(/h3_rating_unsupported/)
    await expect(
      runTool(ctx, def, { target: 'h3', input: '花园里的少女', rating, judge_mode: 'off' }),
    ).rejects.toThrow(/MiniMax/)
    await expect(
      runTool(ctx, def, { target: 'h3', input: '花园里的少女', rating, judge_mode: 'off' }),
    ).rejects.toThrow(/target=anima/)
    // 0 token：拒收发生在任何 LLM 调用之前（预检段，与硬边界检查同层）
    expect(ctx.llm.calls.length).toBe(0)
  })

  it('h3 keyword escalation (bikini → sensitive) hits the same gate — gate is on resolved rating, not raw input', async () => {
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    await expect(
      runTool(ctx, def, { target: 'h3', input: '泳池边的 bikini 少女', judge_mode: 'off' }),
    ).rejects.toThrow(/h3_rating_unsupported/)
    expect(ctx.llm.calls.length).toBe(0)
  })
  // 「h3 + safe 放行」半边由测试④（h3+safe 蓝图全流程：resolved='safe'/source='input'/
  // core.rating 注入）活体覆盖，不在此重复。
})

describe('generations store rating column (Task 14 ⑥)', () => {
  pinSlotsForm() // M5-T2（D8）：本组验证 slots 兼容态下的 generations 落库语义
  it('recordGenerationSafe persists rating; repeated opens stay idempotent', async () => {
    setAuthorEnrichProvider(async () => validBriefJson())
    setAuthorIntentProvider(async () => ({ slots: { count_gender: ['1girl'] } }))
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '泳池 bikini 少女', judge_mode: 'off' })))
    expect(getGeneration(join(tmp, 'feedback.sqlite'), v.generation_id)?.rating).toBe('sensitive')
    // 第二次成功出口 → 再次 openDb（ALTER 重复执行走 catch）→ 幂等不抛
    const v2 = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '又一次 bikini 写真', judge_mode: 'off' })))
    expect(getGeneration(join(tmp, 'feedback.sqlite'), v2.generation_id)?.rating).toBe('sensitive')
  })

  it('legacy db without rating column upgrades in place via try/catch ALTER', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-orch-legacy-'))
    const dbPath = join(dir, 'legacy.sqlite')
    const raw = new DatabaseSync(dbPath)
    raw.exec(
      'CREATE TABLE IF NOT EXISTS generations (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, target TEXT NOT NULL, variant TEXT, judge_mode TEXT NOT NULL, input_digest TEXT NOT NULL, final_output TEXT NOT NULL, judge_score REAL, judge_verdict TEXT, debate_json TEXT, repair_rounds INTEGER, enrich INTEGER NOT NULL DEFAULT 0);',
    )
    raw.close()
    recordGeneration(dbPath, {
      id: 'gen_legacy1', created_at: Date.now(), target: 'anima', judge_mode: 'off',
      input_digest: 'd', final_output: '{}', enrich: 0, rating: 'explicit',
    })
    expect(getGeneration(dbPath, 'gen_legacy1')?.rating).toBe('explicit')
    // 第二次写入 → ALTER 再次走 catch → 幂等
    recordGeneration(dbPath, {
      id: 'gen_legacy2', created_at: Date.now(), target: 'anima', judge_mode: 'off',
      input_digest: 'd', final_output: '{}', enrich: 0, rating: 'safe',
    })
    expect(getGeneration(dbPath, 'gen_legacy2')?.rating).toBe('safe')
    rmSync(dir, { recursive: true, force: true })
  })
})

/* ── P0 修复（t1，style-aesthetics-audit-fix）：声明档位在标准 anima 路径直达组装层 ──
 * 根因（captain 实证）：provider 返回 {slots}（无 blueprint）→ core.rating 注入（blueprint 分支）
 * 不触发 → slots 无 rating → compileAnima resolveEffectiveRating 回退全槽关键词扫描 →
 * slots 内容（如 cleavage）命中 SENSITIVE_MARKERS → 声明 explicit 被静默降档为 sensitive 组装
 * （真实会话 8e31ff2a：envelope 报 explicit、产物 rating_sensitive 种子 + sensitive 负向）。
 * 修复：slots.rating 确定性写入（首轮 + 修复轮 mergeRepairSlots 后重写）+ 蓝图投影映射（验收④）。 */
describe('P0-fix t1: declared rating reaches anima assembly on the standard slots path (spec §5.1)', () => {
  // critic mock 维度分必须与 ANIMA_RUBRIC 7 维精确一致（M2-T2 同款）
  const dimScores = (v: number) => ({
    'tag-order': v, contradiction: v, 'tag-evidence': v, 'negative-template': v,
    composition: v, 'lighting-color': v, 'aesthetic-vocabulary': v,
  })
  const PASS_JSON = JSON.stringify({ verdict: 'pass', dimensionScores: dimScores(90), findings: [], praise: [] })
  const NEEDS_JSON = JSON.stringify({
    verdict: 'needs_revision', dimensionScores: dimScores(50),
    findings: [{
      severity: 'major', dimension: 'tag-order', problem: 'tag order wrong',
      evidence: { tool: 'catalog', query: '1girl', result: 'canonical,n=1' },
      requiredFix: 'move quality tags before subject',
    }],
    praise: [],
  })
  const t1Evidence: EvidenceDeps = {
    catalog: (q) => [{ tag: q, kind: 'canonical', count: 1 }],
    aesthetics: (q) => ({ concreteness: 'pass', query_len: q.length }),
  }
  function criticOf(responses: string[]) {
    const fn = (async () => {
      fn.calls++
      return responses[Math.min(fn.calls - 1, responses.length - 1)]
    }) as unknown as CriticProvider & { calls: number }
    fn.calls = 0
    return fn
  }

  it('slots-mock provider + rating=explicit → rating_explicit seed + explicit negative group (no silent downgrade)', async () => {
    // slots 内容含 cleavage：复现 8e31ff2a 降档载体（关键词回退在 slots 上命中 sensitive）
    setAuthorIntentProvider(async () => ({ slots: { count_gender: ['1girl'], clothing: ['cleavage'] } }))
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '黑裙礼服少女', rating: 'explicit', judge_mode: 'off', enrich: false })))
    expect(v.ok).toBe(true)
    expect(v.rating.resolved).toBe('explicit')
    // envelope rating.resolved 与产物种子档位一致性（修复前此处是 rating_sensitive）
    expect(String(v.result.positive)).toContain('rating_explicit')
    expect(String(v.result.positive)).not.toContain('rating_sensitive')
    // explicit 档策略负向全组（RATING_NEGATIVE_ADDITIONS.explicit）
    const neg = String(v.result.negative)
    for (const w of ['child', 'loli', 'shota', 'toddler', 'kid', 'preteen']) expect(neg).toContain(w)
  })

  it('no rating param + cleavage input → sensitive keyword fallback preserved; envelope/product consistent', async () => {
    setAuthorIntentProvider(async () => ({ slots: { count_gender: ['1girl'] } }))
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '泳池边的 cleavage 少女', judge_mode: 'off', enrich: false })))
    // 关键词回退语义保持（预检定档不变）
    expect(v.rating.resolved).toBe('sensitive')
    expect(v.rating.escalatedFrom).toBe('safe')
    expect(v.rating.source).toBe('keyword')
    // 一致性：修复前 slots 无 rating → 产物档位回落 safe（'safe' 种子、无 sensitive 阻断负向）
    expect(String(v.result.positive)).toContain('rating_sensitive')
    const neg = String(v.result.negative)
    for (const w of ['nude', 'nudity', 'genitals', 'rating_explicit']) expect(neg).toContain(w)
  })

  it('repair round: judgeFeedback-driven re-split + mergeRepairSlots keeps declared rating (re-write effective)', async () => {
    const critic = criticOf([NEEDS_JSON, PASS_JSON])
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: t1Evidence })
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => {
      intentCalls.push(req)
      // 修正轮产物不带 rating（LLM 产物不可信）且改写 clothing——迫使 mergeRepairSlots 真参与
      return req.round === 0
        ? { slots: { count_gender: ['1girl'], clothing: ['cleavage'] } }
        : { slots: { count_gender: ['1girl'], clothing: ['evening gown'] } }
    })
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '晚礼服少女', rating: 'explicit', judge_mode: 'fast', enrich: false })))
    expect(intentCalls).toHaveLength(2) // 首轮 + judgeFeedback 触发的 1 轮修正
    expect(v.rating.resolved).toBe('explicit')
    // 修复轮重写生效：最终产物仍按声明档位组装（修复前回落关键词档）
    expect(String(v.result.positive)).toContain('rating_explicit')
    expect(String(v.result.positive)).not.toContain('rating_sensitive')
    const neg = String(v.result.negative)
    for (const w of ['child', 'loli', 'shota', 'toddler', 'kid', 'preteen']) expect(neg).toContain(w)
  })

  it('anima blueprint path: core.rating injection survives projectToAnima → assembly tier consistent (acceptance ④)', async () => {
    const { settings } = settingsRepo()
    const repo = createBlueprintRepo({ settings } as never)
    repo.save('bp-anima-rating', MINI_BP as never)
    const ctx = stubCtx({ stream: textStream(JSON.stringify(MINI_BP)) })
    ;(ctx as unknown as { settings: unknown }).settings = settings
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', blueprint_id: 'bp-anima-rating', input: '一张概念图', rating: 'explicit', judge_mode: 'off' })))
    expect(v.rating.resolved).toBe('explicit')
    // call#1 = enrichBlueprint：v0 已携带确定性注入的 core.rating（与 h3 版测试④同款断言）
    expect(userTextOf(ctx.llm.calls[1])).toContain('"rating":"explicit"')
    // 投影映射（修复前 projectToAnima 丢 rating → 组装层关键词回退 safe）
    expect(String(v.result.positive)).toContain('rating_explicit')
    expect(String(v.result.negative)).toContain('preteen')
  })
})

/* ── M5-T2：默认路径蓝图形态迁移（design §2.4，D1-D5/D7/D9）──
 * 默认 anima 路径 = 蓝图形态（registry intent.form='blueprint'）：provider 收 blueprintMode/
 * blueprintExpectedMedia → parseBlueprintJson(+expectedMedia) → {blueprint} → core.rating 注入
 * 天然生效 → enrichBlueprint 扩展层（runEnrich swap，D4）→ projectToAnima（D3 扩展）→ runStage。
 * 修复轮三合一（D5）：anchorBlueprint 增量锚定 + core.rating 重注入（缺口#2）+ validate 单次反馈重试。 */
describe('M5-T2: blueprint-form default path (D1/D3/D4/D9)', () => {
  afterEach(() => { delete process.env.PM_AUTHOR_INTENT_FORM })

  function imageBpProvider(seen: AuthorIntentRequest[]) {
    return async (req: AuthorIntentRequest) => {
      seen.push(req)
      return { blueprint: JSON.parse(JSON.stringify(MINI_IMAGE_BP)), missing: [] }
    }
  }

  it('D1/D3/D4: registry default routes blueprint form — provider receives blueprintMode/expectedMedia/blueprint persona; envelope carries blueprint trace; enrichment field absent', async () => {
    const seen: AuthorIntentRequest[] = []
    setAuthorIntentProvider(imageBpProvider(seen))
    const { settings } = settingsRepo()
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    ;(ctx as unknown as { settings: unknown }).settings = settings
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '黄昏天台的少女', judge_mode: 'off' })))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.blueprintMode).toBe(true)
    expect(seen[0]?.blueprintExpectedMedia).toBe('image')
    // D1：ANIMA 蓝图 persona（registry blueprintPersona 下行，Q3 常量本体）
    expect(seen[0]?.persona).toBe(ANIMA_BLUEPRINT_PERSONA)
    expect(seen[0]?.schema).toBe(ANIMA_BLUEPRINT_SCHEMA)
    // D3：D3 增补字段经投影进产物（主干槽位不再塌陷）
    expect(String(v.result.positive)).toContain('1girl')
    expect(String(v.result.positive)).toContain('rooftop')
    expect(String(v.result.positive)).toContain('standing')
    // D4 增量①：observability.blueprint 痕迹；增量③：enrichment 字段消失（runEnrich swap）
    expect(v.observability?.blueprint?.form).toBe('blueprint')
    expect(v.observability?.blueprint?.media).toBe('image')
    expect(v.observability?.blueprint?.expansions_count).toBe(0)
    expect(v.enrichment).toBeUndefined()
    // D4 增量②：trace 含 blueprint_enrich 子条目
    expect((v.observability?.traceStages ?? []).some((s: { name: string }) => s.name === 'blueprint_enrich')).toBe(true)
    // D9：settings 存在 → 落库成功 → 条件顶层键 blueprint_id（可回读同一蓝图）
    expect(typeof v.blueprint_id).toBe('string')
    const repo = createBlueprintRepo({ settings } as never)
    const saved = repo.load(v.blueprint_id as string)
    expect(saved?.media).toBe('image')
    // 落库的是最终蓝图（含 D5b 注入档位——确定性注入先于落库）
    expect(['safe', 'sensitive', 'explicit']).toContain(saved?.core.rating)
  })

  it('D9 fail-open: settings missing → no blueprint_id key, no save advisory, still ok', async () => {
    const seen: AuthorIntentRequest[] = []
    setAuthorIntentProvider(imageBpProvider(seen))
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '黄昏天台的少女', judge_mode: 'off' })))
    expect(v.blueprint_id).toBeUndefined()
    expect(v.advisories).not.toContain('blueprint_save_failed')
    expect(v.ok).toBe(true)
  })

  it('D9 fail-open: repo.save failure → advisory blueprint_save_failed, no throw', async () => {
    const seen: AuthorIntentRequest[] = []
    setAuthorIntentProvider(imageBpProvider(seen))
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    ;(ctx as unknown as { settings: unknown }).settings = {
      get: () => ({}),
      update: () => { throw new Error('disk full') },
      replace: () => ({}),
    }
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '黄昏天台的少女', judge_mode: 'off' })))
    expect(v.advisories).toContain('blueprint_save_failed')
    expect(v.blueprint_id).toBeUndefined()
  })

  it('D1 kill-switch: PM_AUTHOR_INTENT_FORM=slots reverts to slots form + advisory (rollback surface R2)', async () => {
    process.env.PM_AUTHOR_INTENT_FORM = 'slots'
    const seen: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { seen.push(req); return { slots: { count_gender: ['1girl'] } } })
    const ctx = stubCtx({ stream: textStream(JSON.stringify(validBriefJson())) })
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '黄昏天台的少女', judge_mode: 'off' })))
    expect(seen[0]?.blueprintMode).toBeUndefined()
    expect(seen[0]?.persona).toBe(ANIMA_PERSONA) // registry slots persona 原样
    expect(v.advisories).toContain('intent_form_override:slots')
    expect(v.observability?.blueprint).toBeUndefined()
  })

  it('D1 kill-switch: invalid env value → fail-fast before any LLM call', async () => {
    process.env.PM_AUTHOR_INTENT_FORM = 'bogus'
    let providerCalls = 0
    setAuthorIntentProvider(async () => { providerCalls++; return {} as ReturnType<AuthorIntentFn> })
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    await expect(
      runTool(ctx, def, { target: 'anima', input: '黄昏天台的少女', judge_mode: 'off' }),
    ).rejects.toThrow(/PM_AUTHOR_INTENT_FORM/)
    expect(providerCalls).toBe(0)
    expect(ctx.llm.calls.length).toBe(0)
  })

  it('D2: expectedMedia guard — video-shaped blueprint rejected at parse layer（守卫在 parse 层：mock provider 直返 draft 绕过解析，生产 subagent/defaultIntent 两路均经守卫；解析面单测归 analyzer/subagent-provider 套件）', async () => {
    // 编排层用 mock provider 验证「video 形蓝图未在编排层误闯」之外的语义无意义——
    // parseBlueprintJson(expectedMedia) 守卫的机检见 tests/pe-framework/blueprint/analyzer.test.ts
    // 与 tests/pe-framework/intent/subagent-provider.test.ts（本用例保留作为行为锚：mock 直返 video
    // 蓝图时编排层不做二次守卫——fail-fast 边界在 parse 层，非编排层）。
    setAuthorIntentProvider(async () => ({ blueprint: JSON.parse(JSON.stringify(MINI_BP)), missing: [] }))
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '黄昏天台的少女', judge_mode: 'off', enrich: false })))
    expect(v.observability?.blueprint?.media).toBe('video') // mock 直返绕过 parse 守卫（编排层零二次防御，边界单一）
  })

  it('D5c: blueprint validate failure → single feedback retry (advisory blueprint_repair_retry, counts 1 correction) then success', async () => {
    let calls = 0
    const seen: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => {
      seen.push(req)
      calls++
      if (calls === 1) throw new Error('blueprint media mismatch: expected image got video')
      return { blueprint: JSON.parse(JSON.stringify(MINI_IMAGE_BP)), missing: [] }
    })
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '黄昏天台的少女', rating: 'explicit', judge_mode: 'off' })))
    expect(calls).toBe(2)
    expect(seen[1]?.round).toBe(1)
    expect(seen[1]?.feedback).toContain('blueprint media mismatch')
    expect(v.advisories).toContain('blueprint_repair_retry')
    expect(v.observability?.corrections).toBe(1)
    // L2 explicit 档一致性（D5b 注入 + 投影映射）
    expect(String(v.result.positive)).toContain('rating_explicit')
    const neg = String(v.result.negative)
    for (const w of ['child', 'loli', 'shota', 'toddler', 'kid', 'preteen']) expect(neg).toContain(w)
  })

  it('D5c: second failure → original error rethrown (fail-closed, no slots silent downgrade)', async () => {
    setAuthorIntentProvider(async () => { throw new Error('蓝图校验失败：core.concept must be a non-empty string') })
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, cfg as never)
    await expect(
      runTool(ctx, def, { target: 'anima', input: '黄昏天台的少女', judge_mode: 'off' }),
    ).rejects.toThrow(/蓝图校验失败/)
  })

  it('D7/F1: explicit cards deterministic injection (perspective whitelist / lighting separator / motion / color→recommendation channel)', async () => {
    const seen: AuthorIntentRequest[] = []
    setAuthorIntentProvider(imageBpProvider(seen))
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, {
      target: 'anima', input: '黄昏天台的少女', judge_mode: 'off',
      art_direction: { perspective: 'close_up', lighting: 'golden_hour', motion: 'flowing_hair', color: 'warm_cool_contrast' },
    })))
    // 注入发生在 provider 之后 enrich 之前 → enrichBlueprint user 段 v0 JSON 携带注入结果
    const enrichUser = userTextOf(ctx.llm.calls[0])
    expect(enrichUser).toContain('close-up')             // F1 白名单词（close_up 卡）
    expect(enrichUser).not.toContain('detailed face')    // F1 非白名单词丢弃
    expect(enrichUser).toContain('golden hour')          // lighting 卡 tags 追加（A7 安全词表）
    expect(enrichUser).toContain('hair flowing in wind') // motion 卡 → pose_action
    expect(enrichUser).toContain('【推荐先验】')           // F1：color 卡走推荐先验通道
    expect(enrichUser).toContain('warm_cool_contrast')
    expect(enrichUser).not.toContain('teal against orange accents') // color 卡 tags 不假注入（推荐先验只带 id）
    // advisory：实际注入卡逐条 + 丢弃词留痕
    expect(v.advisories).toContain('art_direction_applied:perspective:close_up')
    expect(v.advisories).toContain('art_direction_dropped:perspective:close_up:shallow depth of field,detailed face')
    expect(v.advisories).toContain('art_direction_applied:lighting:golden_hour')
    expect(v.advisories).toContain('art_direction_applied:motion:flowing_hair')
    expect(v.advisories).toContain('art_direction_applied:color:warm_cool_contrast')
    // 产物面：motion 卡进 pose_action 槽（投影直映射；tag 经 catalog grounding 取规范形
    // 'hair flowing in wind' → 'hair in wind'）
    expect(String(v.result.positive)).toContain('hair in wind')
  })
})

/* ── M5-T2 V5/R6：修复轮死路复活专测（TDD RED 先行）──
 * 验尸 V5：修复轮 provider 按 target 返回 slots/shots → d2.blueprint 恒空 → L950 必 break（死路）。
 * 修复：intentBase 携带 blueprintMode（D1）→ provider 蓝图形态返回；D5a anchor 增量锚定；
 * D5b 修复轮 core.rating 重注入（缺口#2）。mock provider 记录 blueprintMode + anchorBlueprint。 */
describe('M5-T2 V5/R6: repair-round closure revival (D5a anchor + D5b rating re-injection)', () => {
  const dimScores = (v: number) => ({
    'tag-order': v, contradiction: v, 'tag-evidence': v, 'negative-template': v,
    composition: v, 'lighting-color': v, 'aesthetic-vocabulary': v,
  })
  const PASS_JSON = JSON.stringify({ verdict: 'pass', dimensionScores: dimScores(90), findings: [], praise: [] })
  const NEEDS_JSON = JSON.stringify({
    verdict: 'needs_revision', dimensionScores: dimScores(50),
    findings: [{
      severity: 'major', dimension: 'tag-order', problem: 'tag order wrong',
      evidence: { tool: 'catalog', query: '1girl', result: 'canonical,n=1' },
      requiredFix: 'move quality tags before subject',
    }],
    praise: [],
  })
  const v56Evidence: EvidenceDeps = {
    catalog: (q) => [{ tag: q, kind: 'canonical', count: 1 }],
    aesthetics: (q) => ({ concreteness: 'pass', query_len: q.length }),
  }

  it('repair round receives blueprintMode + anchorBlueprint; core.rating re-injected despite untrusted LLM output (缺口#2)', async () => {
    const critic = (() => {
      const fn = (async () => {
        fn.calls++
        return [NEEDS_JSON, PASS_JSON][Math.min(fn.calls - 1, 1)]
      }) as unknown as CriticProvider & { calls: number }
      fn.calls = 0
      return fn
    })()
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: v56Evidence })
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => {
      intentCalls.push(req)
      // 修复轮产物不带 rating（LLM 产物不可信）——D5b 重注入必须兜住
      return { blueprint: JSON.parse(JSON.stringify(MINI_IMAGE_BP)), missing: [] }
    })
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '黄昏天台的少女', rating: 'explicit', judge_mode: 'fast' })))
    expect(intentCalls).toHaveLength(2) // 首轮 + judgeFeedback 触发的 1 轮修正
    // V5：修复轮 provider 收到蓝图形态路由（死路修复的判据）
    expect(intentCalls[1]?.blueprintMode).toBe(true)
    // V6/D5a：修复轮携带增量锚定（当前蓝图 → <old_blueprint> 语义）
    expect(intentCalls[1]?.anchorBlueprint).toBeDefined()
    expect(JSON.stringify(intentCalls[1]?.anchorBlueprint)).toContain('rooftop')
    // D5b 缺口#2：修复轮 rating 重注入 → 最终产物按声明档位组装（修复轮 LLM 产物不含 rating）
    expect(String(v.result.positive)).toContain('rating_explicit')
    expect(String(v.result.positive)).not.toContain('rating_sensitive')
    const neg = String(v.result.negative)
    for (const w of ['child', 'loli', 'shota', 'toddler', 'kid', 'preteen']) expect(neg).toContain(w)
    // 可观测：anchor_rounds=1 + trace 含 blueprint_enrich
    expect(v.observability?.blueprint?.anchor_rounds).toBe(1)
    expect((v.observability?.traceStages ?? []).filter((s: { name: string }) => s.name === 'blueprint_enrich')).toHaveLength(2)
  })
})
