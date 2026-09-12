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
} from '../../src/tools/prompt-author.js'
import { createBlueprintRepo } from '../../src/pe-framework/blueprint/repo.js'
import { recordGeneration, getGeneration } from '../../src/pe-framework/feedback/store.js'
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
    const v = JSON.parse(String(await runTool(ctx, def, {
      target: 'h3', blueprint_id: 'bp-inc', input: '把第二镜改成雨夜', rating: 'explicit', judge_mode: 'off',
    })))
    // call#0 = 增量意图分析：persona 含 <old_blueprint> 锚定块与旧蓝图全文
    expect(ctx.llm.calls[0]?.system).toContain('<old_blueprint>')
    expect(ctx.llm.calls[0]?.system).toContain('三镜头打斗CG')
    // call#1 = enrichBlueprint：v0 携带确定性注入的 core.rating
    expect(userTextOf(ctx.llm.calls[1])).toContain('"rating":"explicit"')
    // 三字段齐备（蓝图出口）
    expect(v.rating.resolved).toBe('explicit')
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

describe('generations store rating column (Task 14 ⑥)', () => {
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
