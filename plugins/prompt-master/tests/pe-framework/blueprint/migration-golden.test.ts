/**
 * M5-T4 golden 对照（design §2.6 定版四层机检 + §2.7 清单 5/6 mock 面）。
 * 对照对象（设计稿原文）：旧路径产物 = mock provider 返回 recorded slots 转录（cases.json
 * slotsBaseline，逐案例定版）；新路径产物 = mock provider 返回同案例蓝图 JSON + 空 patch，
 * 走 applyArtDirectionCards→enrichBlueprint(patch 空 + style)→projectToAnima。
 * 断言面全部落本文件（orchestration.test.ts 归 T2 所有，本任务不改它）。
 *
 * L1 主干等价：身份槽 count_gender/character/artist 集合严格相等；内容槽 appearance/clothing/
 *   pose_action/expression/scene/detail_mood Jaccard≥0.6 + allowed_missing/allowed_extra 白名单
 *   （先剔除后算，双方有效集皆空记 1.0）；实现扩展（从严，docs/blueprint-migration-replay.md 留痕）：
 *   camera/exclusions 并入内容槽集；narrative 存在性一致+非空+逐字节相等；rating 操作化为
 *   oldV.rating.resolved === newV.rating.resolved（种子 token 一致由 L2/c07 与 L4 字节面承载）。
 * L2 explicit 端到端（c07）：种子/六负向词/rating.resolved+source/assumptions 四断言。
 * L3 envelope 骨架：顶层键集差异 ⊆ {enrichment} + observability.blueprint 存在性互斥
 *   （合起来 = 设计稿白名单 {enrichment, observability.blueprint}）；新路径 critical gate 家族
 *   ⊆ 旧路径；F2 条件顶层键 blueprint_id 单列专测（settings→落库成功→仅新路径出现）。
 * L4 编译层逐字节：compileAnima(slotsBaseline, {variant:'base', dropUnresolvedMiss:true}) 与
 *   fixture expectedCompile 逐字节一致（方言层未越界的照妖镜；录制来源见 cases.json $meta）。
 *
 * 清单 5（blueprint_id 链路）与清单 6（h3 零变化）以 mock 层落在本套件；清单 1-4/7 的执行留痕
 * 归 docs/blueprint-migration-replay.md（全量/tsc/build/dist 冒烟/真实会话采集/工具面）。
 */
import { describe, expect, it, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  registerAuthorTool,
  setAuthorIntentProvider,
  setAuthorEnrichProvider,
  setAuthorFeedbackDbPath,
  setAuthorJudgeDeps,
  type AuthorIntentRequest,
} from '../../../src/tools/prompt-author.js'
import { createBlueprintRepo } from '../../../src/pe-framework/blueprint/repo.js'
import type { BlueprintV1 } from '../../../src/pe-framework/blueprint/schema.js'
import { projectToAnima } from '../../../src/pe-framework/blueprint/project.js'
import { getGeneration } from '../../../src/pe-framework/feedback/store.js'
import { applyArtDirectionCards } from '../../../src/pe-framework/enrichment/art-direction-apply.js'
import { applyStyle } from '../../../src/pe-framework/enrichment/style.js'
import { compileAnima } from '../../../src/pe-framework/dialect/anima.js'
import type { AnimaSlots } from '../../../src/pe-framework/dialect/anima.js'
import { closeCatalog } from '../../../src/pe-framework/dialect/anima-catalog.js'
import { H3_PERSONA } from '../../../src/pe-framework/intent/subagent-provider.js'
import type { CriticProvider } from '../../../src/pe-framework/eval/critic.js'
import type { EvidenceDeps } from '../../../src/pe-framework/eval/evidence.js'
import { stubCtx, runTool, textStream } from '../../plugin/helpers.js'

const cfg = { temperature: 0.7 }
const EMPTY_PATCH = '{"set":{},"additions":{},"expansions":[]}'

/** 旧路径 runEnrich 的 mock brief（brief 内容不影响断言——provider mock 无视输入返回 recorded 转录） */
function briefJson(): string {
  const item = { text: '1girl', source: 'user' }
  return JSON.stringify({
    outputLang: 'en', subject: [item],
    scene: [{ text: 'golden hour', source: 'enriched' }],
    composition: [{ text: 'medium shot', source: 'enriched' }],
    lighting: [{ text: 'soft ambient shading', source: 'enriched' }],
    color: [{ text: 'teal and orange', source: 'enriched' }],
    style: [{ text: 'cel shading', source: 'enriched' }],
    mood: [{ text: 'calm', source: 'enriched' }], nameAnchors: [],
  })
}

interface GoldenCase {
  id: string
  focus: string
  args: Record<string, unknown>
  slotsBaseline: Record<string, string[] | string | undefined>
  blueprint: BlueprintV1
  allowed_missing?: Record<string, string[]>
  allowed_extra?: Record<string, string[]>
  expectedCompile: { positive: string; negative: string }
}

const CASES = (JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/blueprint-migration/cases.json', import.meta.url)), 'utf8'),
) as { cases: GoldenCase[] }).cases

expect(CASES).toHaveLength(12) // 抽样集定版护栏（c01-c12）

const IDENTITY_SLOTS = ['count_gender', 'character', 'artist'] as const
// 设计稿 L1 内容槽六项 + 实现扩展（camera/exclusions 并入 Jaccard 集，从严；留痕 replay doc）
const CONTENT_SLOTS = ['appearance', 'clothing', 'pose_action', 'expression', 'scene', 'detail_mood', 'camera', 'exclusions'] as const

function jaccard(oldTags: string[] | undefined, newTags: string[] | undefined, allowMissing: string[] = [], allowExtra: string[] = []): number {
  const a = new Set((oldTags ?? []).filter((t) => !allowMissing.includes(t)))
  const b = new Set((newTags ?? []).filter((t) => !allowExtra.includes(t)))
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

function settingsRepo() {
  // 修订留痕（M5-HOTFIX）：ctx.settings 形状由裸 owner scope 迁移为 settings 服务（register 返回
  // owner scope，blueprints 段嵌套）——落库接线修复后（settings.register('prompt-master-blueprints')
  // 惰性注册），旧 owner-scope 直传形状已不可达（会落 blueprint_save_failed advisory 且不落库），
  // 本套件 F2 与清单⑤随迁。repoScope = 服务内 store 的 RepoSettingsScope 投影，供断言侧读回。
  const store: Record<string, string> = {}
  const service = {
    register(ns: string, _schema: unknown) {
      if (ns !== 'prompt-master-blueprints') throw new Error(`unexpected settings namespace: ${ns}`)
      return {
        get: () => ({ blueprints: { ...store } }),
        watch: () => () => {},
        update: async (patch: { blueprints?: Record<string, string> }) => { Object.assign(store, patch.blueprints ?? {}) },
        replace: async (section: { blueprints?: Record<string, string> }) => {
          for (const k of Object.keys(store)) delete store[k]
          Object.assign(store, section.blueprints ?? {})
        },
      }
    },
    update: async () => undefined,
    get: async () => ({ blueprints: { ...store } }),
    replace: async () => undefined,
  }
  const repoScope = {
    get: () => ({ ...store }),
    update: async (p: Record<string, string>) => { Object.assign(store, p) },
    replace: async (s: Record<string, string>) => { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, s) },
  }
  return { settings: service, repoScope }
}

interface CaseRun { v: Record<string, any>; intentCalls: AuthorIntentRequest[] }

/** 双形态跑法：slots = env kill-switch 兼容态（provider 返回 recorded 转录）；blueprint = 默认蓝图形态（provider 返回案例蓝图 + 空 patch） */
async function runCase(c: GoldenCase, form: 'slots' | 'blueprint', opts: { settings?: unknown; judge?: 'off' | 'fast' } = {}): Promise<CaseRun> {
  if (form === 'slots') process.env.PM_AUTHOR_INTENT_FORM = 'slots'
  else delete process.env.PM_AUTHOR_INTENT_FORM
  const intentCalls: AuthorIntentRequest[] = []
  setAuthorIntentProvider(async (req) => {
    intentCalls.push(req)
    if (form === 'slots') return { slots: JSON.parse(JSON.stringify(c.slotsBaseline)) } as never
    return { blueprint: JSON.parse(JSON.stringify(c.blueprint)), missing: [] } as never
  })
  setAuthorEnrichProvider(async () => briefJson()) // 仅 slots 形态被调；蓝图形态 runEnrich 被 swap
  const ctx = stubCtx({ stream: textStream(EMPTY_PATCH) }) // 蓝图形态 enrichBlueprint 空 patch
  if (opts.settings !== undefined) (ctx as unknown as { settings: unknown }).settings = opts.settings
  const def = registerAuthorTool(ctx as never, cfg as never)
  const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', ...c.args, ...(opts.judge ? { judge_mode: opts.judge } : {}) })))
  return { v, intentCalls }
}

/** 新路径 slots 复现：与编排流水线同序同函数（注入→风格→投影；patch 空，rating 不入 slots 面） */
function projectedSlotsOf(c: GoldenCase): Record<string, unknown> {
  let bp: BlueprintV1 = JSON.parse(JSON.stringify(c.blueprint))
  const ad = c.args['art_direction'] as Record<string, string> | undefined
  if (ad) bp = applyArtDirectionCards(bp, ad).blueprint
  const styleId = c.args['style_id'] as string | undefined
  if (styleId) bp = applyStyle(bp, styleId, (c.args['conformity'] as number | undefined) ?? 0.6)
  return projectToAnima(bp) as unknown as Record<string, unknown>
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pm-golden-'))
  setAuthorFeedbackDbPath(join(tmp, 'feedback.sqlite'))
})
afterEach(() => {
  delete process.env.PM_AUTHOR_INTENT_FORM
  setAuthorFeedbackDbPath(null)
  setAuthorIntentProvider(null)
  setAuthorEnrichProvider(null)
  setAuthorJudgeDeps(null)
  rmSync(tmp, { recursive: true, force: true })
})
afterAll(() => { closeCatalog() })

/* ── L1：主干等价（12 案例 × 双形态）── */
describe('golden L1: trunk equivalence (slots-layer, design §2.6)', () => {
  for (const c of CASES) {
    it(`L1 ${c.id} (${c.focus})`, async () => {
      const [oldRun, newRun] = await Promise.all([runCase(c, 'slots'), runCase(c, 'blueprint')])
      expect(oldRun.v.ok, `${c.id} slots 形态应 ok`).toBe(true)
      expect(newRun.v.ok, `${c.id} blueprint 形态应 ok`).toBe(true)
      const oldS = c.slotsBaseline
      const newS = projectedSlotsOf(c)
      // 身份槽：集合严格相等
      for (const k of IDENTITY_SLOTS) {
        const a = [...((oldS[k] as string[]) ?? [])].sort()
        const b = [...((newS[k] as string[]) ?? [])].sort()
        expect(b, `${c.id} 身份槽 ${k} 严格相等：old=${JSON.stringify(a)} new=${JSON.stringify(b)}`).toEqual(a)
      }
      // 内容槽：Jaccard ≥ 0.6 + 白名单（先剔除后算）
      for (const k of CONTENT_SLOTS) {
        const j = jaccard(oldS[k] as string[], newS[k] as string[], c.allowed_missing?.[k], c.allowed_extra?.[k])
        expect(j, `${c.id} 内容槽 ${k} Jaccard=${j} old=${JSON.stringify(oldS[k])} new=${JSON.stringify(newS[k])}`).toBeGreaterThanOrEqual(0.6)
      }
      // narrative：存在性一致 + 非空 + 逐字节相等
      const on = oldS['narrative'] as string | undefined
      const nn = newS['narrative'] as string | undefined
      expect((on === undefined) === (nn === undefined), `${c.id} narrative 存在性一致`).toBe(true)
      if (on !== undefined) {
        expect(String(nn).length, `${c.id} narrative 非空`).toBeGreaterThan(0)
        expect(nn, `${c.id} narrative 逐字节`).toBe(on)
      }
      // rating：逐字节（操作化为 resolved 档位相等；种子 token 一致由 L2/L4 承载）
      expect(newRun.v.rating.resolved, `${c.id} rating 逐字节相等`).toBe(oldRun.v.rating.resolved)
    })
  }
})

/* ── L2：explicit 档端到端（c07，design §2.6 五断言）── */
describe('golden L2: explicit end-to-end (c07)', () => {
  it('c07: rating_explicit seed + six-word negative group + resolved/source + assumption (migrated default path)', async () => {
    const { v } = await runCase(CASES.find((c) => c.id === 'c07')!, 'blueprint')
    expect(v.ok).toBe(true)
    expect(String(v.result.positive)).toContain('rating_explicit')
    expect(String(v.result.positive)).not.toContain('rating_sensitive')
    const neg = String(v.result.negative)
    for (const w of ['child', 'loli', 'shota', 'toddler', 'kid', 'preteen']) expect(neg).toContain(w)
    expect(v.rating.resolved).toBe('explicit')
    expect(v.rating.source).toBe('input')
    expect(JSON.stringify(v.result.assumptions)).toContain('rating_active:explicit')
  })
})

/* ── L3：envelope 骨架（12 案例双路径）+ F2 条件顶层键 ── */
describe('golden L3: envelope skeleton + F2 blueprint_id conditional key', () => {
  for (const c of CASES) {
    it(`L3 ${c.id}: top-level key diff ⊆ {enrichment}; observability.blueprint mutual-exclusive; critical families ⊆`, async () => {
      const [oldRun, newRun] = await Promise.all([runCase(c, 'slots'), runCase(c, 'blueprint')])
      const oldKeys = new Set(Object.keys(oldRun.v))
      const newKeys = new Set(Object.keys(newRun.v))
      const diff = [...oldKeys].filter((k) => !newKeys.has(k)).concat([...newKeys].filter((k) => !oldKeys.has(k)))
      // 顶层差异白名单 = {enrichment} + {next_action, repair_hints}——后两者是 blueprint_id 分支
      // 既有（迁移前已存在）的条件顶层键：blueprint 分支自始装配 nextAction（含空 repair_hints），
      // legacy slots 分支自始不装配（T4 无 src 改动权，迁移零贡献）——非迁移引入的形状差，记入
      // docs/blueprint-migration-replay.md envelope 差异清单，交 T4R/M5 台账定夺是否拉平。
      // observability.blueprint 为嵌套字段，以存在性互斥断言补全设计稿白名单
      // {enrichment, observability.blueprint}（§2.4 envelope 契约增量①③）。
      expect(
        diff.filter((k) => !['enrichment', 'next_action', 'repair_hints'].includes(k)),
        `${c.id} 顶层键差异=${JSON.stringify(diff)}`,
      ).toEqual([])
      expect(oldKeys.has('enrichment'), `${c.id} 旧路径（slots 兼容态）有 enrichment`).toBe(true)
      expect(newKeys.has('enrichment'), `${c.id} 新路径 enrichment 消失（增量③）`).toBe(false)
      expect(newKeys.has('next_action') && newKeys.has('repair_hints'), `${c.id} 新路径 next_action/repair_hints（blueprint 分支既有装配）`).toBe(true)
      expect(oldKeys.has('next_action'), `${c.id} 旧路径无 next_action（既有不对称，见 replay doc）`).toBe(false)
      expect(newRun.v.observability?.blueprint?.form, `${c.id} 新路径 blueprint 痕迹（增量①）`).toBe('blueprint')
      expect(oldRun.v.observability?.blueprint, `${c.id} 旧路径无 blueprint 痕迹`).toBeUndefined()
      // T4 附录（T2R nit）：落库 enrich 列两态对照钉死——蓝图形态 enrichFlag=0（D4 增量④：
      // runEnrich swap 后 generations.enrich 恒 0），slots 兼容态 enrich=1（brief 走通）
      expect(getGeneration(join(tmp, 'feedback.sqlite'), newRun.v.generation_id)?.enrich, `${c.id} 新路径 generations.enrich=0`).toBe(0)
      expect(getGeneration(join(tmp, 'feedback.sqlite'), oldRun.v.generation_id)?.enrich, `${c.id} 旧路径 generations.enrich=1`).toBe(1)
      // 新路径 critical gate 家族 ⊆ 旧路径（无新增 critical 家族）
      const fams = (v: Record<string, any>) =>
        new Set(((v.audit?.gates ?? []) as Array<{ severity: string; rule: string }>).filter((g) => g.severity === 'critical').map((g) => String(g.rule).split(':')[0]))
      for (const f of fams(newRun.v)) expect(fams(oldRun.v).has(f), `${c.id} 新增 critical 家族 ${f}`).toBe(true)
    })
  }

  it('F2 (design §5): settings → repo.save 成功 → 条件顶层键 blueprint_id 仅出现在新路径且可回读（旧路径恒无）', async () => {
    const c = CASES.find((x) => x.id === 'c01')!
    const { settings, repoScope } = settingsRepo()
    const [oldRun, newRun] = await Promise.all([
      runCase(c, 'slots', { settings }),
      runCase(c, 'blueprint', { settings }),
    ])
    expect(oldRun.v.blueprint_id).toBeUndefined()
    expect(typeof newRun.v.blueprint_id).toBe('string')
    const repo = createBlueprintRepo({ settings: repoScope } as never)
    const saved = repo.load(newRun.v.blueprint_id as string)
    expect(saved?.media).toBe('image')
    // 落库键 = generation_id（Q2）：与 envelope.generation_id 同值
    expect(newRun.v.blueprint_id).toBe(newRun.v.generation_id)
  })
})

/* ── L4：编译层逐字节（照妖镜：方言层未越界）── */
describe('golden L4: compile-layer byte identity (recorded vs live)', () => {
  for (const c of CASES) {
    it(`L4 ${c.id}: compileAnima(slotsBaseline) ≡ expectedCompile（逐字节）`, () => {
      const r = compileAnima(c.slotsBaseline as unknown as AnimaSlots, { variant: 'base', dropUnresolvedMiss: true })
      expect(r.positive, `${c.id} positive 逐字节`).toBe(c.expectedCompile.positive)
      expect(r.negative, `${c.id} negative 逐字节`).toBe(c.expectedCompile.negative)
    })
  }
})

/* ── 清单 5（§2.7）：blueprint_id 链路——默认路径落库 → 增量入口 → 修复轮锚定全通 ── */
describe('replay item 5: blueprint_id chain (save → increment → anchored repair closure)', () => {
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
  const evidence: EvidenceDeps = {
    catalog: (q) => [{ tag: q, kind: 'canonical', count: 1 }],
    aesthetics: (q) => ({ concreteness: 'pass', query_len: q.length }),
  }

  it('blueprint_id 链：落库 → 增量（provider 收蓝图形态路由）→ judge needs → 修复轮收 anchorBlueprint（= 落库蓝图）→ 闭环推进 → 二次落库', async () => {
    const c = CASES.find((x) => x.id === 'c01')!
    const { settings, repoScope } = settingsRepo()
    // 第一程：默认路径 + settings → blueprint_id
    const run1 = await runCase(c, 'blueprint', { settings })
    const id = run1.v.blueprint_id as string
    expect(typeof id).toBe('string')
    // 第二程：blueprint_id 增量入口 + judge fast（NEEDS→PASS）→ 修复轮锚定。
    // 增量分析走 analyzeBlueprintIncremental（ctx stream），provider seam 仅在修复轮被调。
    const repo = createBlueprintRepo({ settings: repoScope } as never)
    const savedBp = repo.load(id)
    expect(savedBp).toBeDefined()
    const critic = (() => {
      const fn = (async () => {
        fn.calls++
        return [NEEDS_JSON, PASS_JSON][Math.min(fn.calls - 1, 1)]
      }) as unknown as CriticProvider & { calls: number }
      fn.calls = 0
      return fn
    })()
    setAuthorJudgeDeps({ criticProvider: critic, evidenceDeps: evidence })
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => {
      intentCalls.push(req)
      return { blueprint: JSON.parse(JSON.stringify(c.blueprint)), missing: [] } as never
    })
    const ctx = stubCtx({ stream: textStream(JSON.stringify(c.blueprint)) }) // 增量分析产出 = 完整新蓝图
    ;(ctx as unknown as { settings: unknown }).settings = settings
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v2 = JSON.parse(String(await runTool(ctx, def, { target: 'anima', blueprint_id: id, input: '把场景换成雨夜街道', judge_mode: 'fast' })))
    expect(v2.ok).toBe(true)
    // 修复轮（V5/V6 经 blueprint_id 入口）：provider 收蓝图形态路由 + anchorBlueprint = 落库蓝图同源
    expect(intentCalls).toHaveLength(1) // provider 唯一调用 = 修复轮（增量分析走 stream）
    expect(intentCalls[0]?.blueprintMode).toBe(true)
    const anchor = intentCalls[0]?.anchorBlueprint as BlueprintV1 | undefined
    expect(anchor).toBeDefined()
    expect(anchor?.media).toBe(savedBp?.media)
    expect(anchor?.core?.concept).toBe(savedBp?.core?.concept)
    expect(anchor?.core?.rating).toBe(savedBp?.core?.rating)
    expect(JSON.stringify(anchor)).toContain('rooftop')
    // 二次落库：修复后的最终蓝图有新 blueprint_id
    expect(typeof v2.blueprint_id).toBe('string')
    expect(v2.blueprint_id).not.toBe(id)
  })
})

/* ── 清单 6（§2.7）：h3 全链零变化（未迁移面）── */
describe('replay item 6: h3 untouched (no migration leakage)', () => {
  it('h3：intent persona/schema 不变、shots 直译、无蓝图痕迹、无 blueprint_id', async () => {
    const H3_SHOTS = { shots: { duration_seconds: 6, shots: [{ what: 'A baker opens shutters', ambient: 'morning' }] } }
    const intentCalls: AuthorIntentRequest[] = []
    setAuthorIntentProvider(async (req) => { intentCalls.push(req); return JSON.parse(JSON.stringify(H3_SHOTS)) as never })
    const ctx = stubCtx({ stream: textStream(JSON.stringify(H3_SHOTS)) })
    const def = registerAuthorTool(ctx as never, cfg as never)
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'h3', input: 'A baker opens shutters at dawn', judge_mode: 'off' })))
    expect(v.ok).toBe(true)
    expect(intentCalls).toHaveLength(1)
    expect(intentCalls[0]?.blueprintMode).toBeUndefined()
    expect(intentCalls[0]?.blueprintExpectedMedia).toBeUndefined()
    expect(intentCalls[0]?.persona).toBe(H3_PERSONA) // h3 persona 原样（未迁移面零变化）
    // envelope 面：legacy h3（shots 直译）路径既有形状——audit 装配、无 next_action（blueprint 分支
    // 才装配，见 L3 白名单披露）、无蓝图痕迹泄漏
    expect(v.audit).toBeDefined()
    expect(v.next_action).toBeUndefined()
    expect(v.observability?.blueprint).toBeUndefined()
    expect(v.blueprint_id).toBeUndefined()
  })
})
