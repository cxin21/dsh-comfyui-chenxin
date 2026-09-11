import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { TARGETS, type Target } from '../pe-framework/index.js'
import { serializeReport } from '../pe-framework/audit/index.js'
import type { AnimaSlots } from '../pe-framework/dialect/anima.js'
// 方言模块副作用注册（Task 6：DIALECT_READY 静态表 → 注册表查询）
import '../pe-framework/dialect/anima.js'
import '../pe-framework/dialect/h3.js'
import { isDialectReady as registryIsDialectReady, getDialect } from '../pe-framework/dialect/registry.js'
import { buildTextZh } from '../pe-framework/dialect/h3.js'
import { runStage } from '../pe-framework/pipeline/runStage.js'
import { createProductionEvidenceDeps, createProductionCriticProvider } from '../pe-framework/pipeline/judge-assembly.js'
import type { CriticProvider, CriticFinding } from '../pe-framework/eval/critic.js'
import type { EvidenceDeps } from '../pe-framework/eval/evidence.js'
import { assembleEnvelope, computeNextAction, type RepairHint } from '../pe-framework/render/envelope.js'
import type { StageResult, CriticRebuttal } from '../pe-framework/pipeline/types.js'
import { createBlueprintRepo, type RepoSettingsScope } from '../pe-framework/blueprint/repo.js'
import { projectToH3, projectToAnima, preflightRepair } from '../pe-framework/blueprint/project.js'
import { enrichBlueprint } from '../pe-framework/enrichment/engine.js'
import type { BlueprintV1 } from '../pe-framework/blueprint/schema.js'
import { sceneToShotsChecked } from '../pe-framework/schema/scenes.js'
import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'
import { complete } from '../llm/complete.js'
import { resolveRoute, type ExecLike } from '../llm/route.js'
import { resolveJoyExtraOptions, filterJoyExtraClauses } from '../pe-framework/sanitize/joy-extra.js'
import { recordGeneration } from '../pe-framework/feedback/store.js'
import { defaultFeedbackDbPath } from './prompt-feedback.js'
import { createHash } from 'node:crypto'

export interface AuthorArgs {
  target: Target
  input: string
  profile?: string
  variant?: string
  stage?: string
  scenario_id?: string
  form_fields?: Record<string, unknown>
  audit_only?: boolean
  /** Task 10 蓝图管线：风格模板 id（MINIMAL_STYLES，如 cinematic_real） */
  style_id?: string
  /** Task 10 蓝图管线：风格注入 conformity（0=全量注入；>0 仅引用） */
  conformity?: number
  /** Task 10 蓝图管线：关键维度缺失时的澄清策略 ask|auto */
  clarify?: 'ask' | 'auto'
  /** Task 10 蓝图管线：增量修改入口——传蓝图 id 时跳过 analyzeIntent，从 repo 取回旧蓝图直接扩展→投影 */
  blueprint_id?: string
  /** Task 6（spec §2.4/§3.1）：评审模式；缺省 'off' 零行为变化；audit_only=true 时忽略并保持旧行为 */
  judge_mode?: 'off' | 'fast' | 'strict'
  /** T4（spec §10.4-A12）：修正轮评审成本开关；缺省 true（现状每修正轮重评）；false=修正轮 runStage 不带 judgeOpts（省 critic 调用，闭环由规则 gates + judgeFeedback 首轮投影驱动） */
  judgeRepair?: boolean
}

/** 方言归化状态机：查注册表（anima/h3 由上方副作用 import 装配）；sd/generic 未归化 */
export function isDialectReady(target: Target): boolean {
  return registryIsDialectReady(target)
}

/* ── intent 层（LLM；测试注入 seam）── */

export interface AuthorDraft {
  slots?: AnimaSlots
  shots?: H3ShotsInput
  /** Task 10 蓝图管线：蓝图 v0（意图分析产出）；存在时走 enrich→project 分支 */
  blueprint?: BlueprintV1
  /** Task 10 蓝图管线：缺失维度标记（spec §6），传入 enrichBlueprint 作扩展引导 */
  missing?: string[]
}

export interface AuthorIntentRequest {
  target: string
  input: string
  variant?: string
  scenarioId?: string
  formFields?: Record<string, unknown>
  round: number
  feedback?: string
  /** Task 7 方言化：author 按 getDialect(target).intent 注入（req > opts > DEFAULT 兜底在 provider 内） */
  persona?: string
  schema?: string
  /** Task 10 蓝图管线：关键维度缺失澄清策略透传（→ analyzeIntent opts.clarify；t22 F2 修复） */
  clarify?: 'ask' | 'auto'
}

export type AuthorIntentFn = (req: AuthorIntentRequest, exec?: ExecLike) => Promise<AuthorDraft>

let _intentProvider: AuthorIntentFn | null = null

export function setAuthorIntentProvider(fn: AuthorIntentFn | null): void {
  _intentProvider = fn
}

export function getAuthorIntentProvider(): AuthorIntentFn | null {
  return _intentProvider
}

/** 缺省 intent（真实运行）：经 ctx.llm 走 complete 组装；测试一律注入 provider（route 在 execute 入口经 resolveRoute 解析） */
async function defaultIntent(ctx: Context, route: { provider: string; model: string }, req: AuthorIntentRequest): Promise<AuthorDraft> {
  const system =
    req.target === 'anima'
      ? '你是 Anima 提示词意图拆解器：把创作意图拆成槽位 JSON，仅输出 JSON（形如 {"slots": {"count_gender": [...], "appearance": [...], ...}}，键为 count_gender/character/appearance/clothing/pose_action/expression/camera/scene/detail_mood/narrative）。'
      : '你是 MiniMax-H3 意图拆解器：把创作意图写成 shots JSON，仅输出 JSON（形如 {"shots": {"duration_seconds": 6, "shots": [{"what": "...", "ambient": "...", "music": "..."}]}}）。'
  const user = (req.feedback ? `上一轮审计反馈（请修正后重新给出结构 JSON）:\n${req.feedback}\n\n` : '') + `创作意图: ${req.input}`
  const { text } = await complete(ctx, {
    provider: route.provider,
    model: route.model,
    system,
    user,
    maxTokens: 1400,
    temperature: 0.3,
    signal: new AbortController().signal,
  })
  // 剥离 markdown code fence 与前后非 JSON 杂质（LLM 常见 ```json ... ``` 包裹；与 subagent-provider 同款策略）
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const cleaned = (fenced ? fenced[1] : text).trim()
  const parsed = JSON.parse(cleaned) as { slots?: Record<string, unknown>; shots?: H3ShotsInput }
  // 归一化 slots：narrative 强制 string；其余槽强制 string[]
  const slots = parsed.slots ? normalizeSlots(parsed.slots) : undefined
  if (req.target === 'anima') return { slots: slots ?? ({} as AnimaSlots) }
  return { shots: parsed.shots ?? undefined }
}

/** LLM 输出形状兜底：narrative 强转 string；其余槽强转 string[]（数组→join / 标量→[标量] / null→[]） */
function normalizeSlots(raw: Record<string, unknown>): AnimaSlots {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'narrative') {
      out[k] = typeof v === 'string' ? v : (Array.isArray(v) ? (v as unknown[]).map(String).join(' ') : v == null ? '' : String(v))
    } else {
      out[k] = Array.isArray(v) ? (v as unknown[]).map((x) => String(x))
        : v == null ? [] : [String(v)]
    }
  }
  return out as AnimaSlots
}

/* ── 视图层（意图 → runStage 内核 → 场景表单闸门合并 → Envelope + 修正闭环）── */

const VARIANT_SET = new Set(['base', 'aesthetic', 'turbo'])
const MAX_CORRECTIONS = 2

/* ── Task 6 评审接线（spec §2.4/§3.1）：注入点 + 生产装配 ── */

/** strict 修正稿生产者（与 PipelineInput.revisionProvider 同形；T4 增 praise 参与结构化 rebuttals 产物） */
export type AuthorRevisionProvider = (compiled: unknown, findings: CriticFinding[], praise: string[]) => Promise<{
  compiled: unknown
  changes: string[]
  revisionNote: string
  rebuttals: CriticRebuttal[]
}>

/** 评审依赖注入 seam：生产缺省走 createProduction* 装配；e2e/单测经此注入 mock */
export interface AuthorJudgeDeps {
  criticProvider?: CriticProvider
  evidenceDeps?: EvidenceDeps
  revisionProvider?: AuthorRevisionProvider
}

let _judgeDeps: AuthorJudgeDeps | null = null

export function setAuthorJudgeDeps(deps: AuthorJudgeDeps | null): void {
  _judgeDeps = deps
}

export function getAuthorJudgeDeps(): AuthorJudgeDeps | null {
  return _judgeDeps
}

/** runStage 评审透传段（judge=off 时为 undefined → 同步旧路径零变化） */
interface JudgeStageOpts {
  judge: 'fast' | 'strict'
  criticProvider: CriticProvider
  evidenceDeps: EvidenceDeps
  originalIntent: string
  revisionProvider?: AuthorRevisionProvider
}

/** generation_id（spec §3.1）：唯一允许的缺省新增 Envelope 字段——gen_<Date.now()>_<random36> */
export function makeGenerationId(): string {
  return `gen_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

/* ── final review C1：generations 落库（质量飞轮 §3.2）── */

/** 测试/特殊部署注入 db 路径（与 prompt-feedback 的 setFeedbackDbPath 同款 seam）；null 恢复默认解析 */
let _feedbackDbPathOverride: string | null = null
export function setAuthorFeedbackDbPath(p: string | null): void {
  _feedbackDbPathOverride = p
}

function resolveFeedbackDbPath(): string | undefined {
  try {
    return _feedbackDbPathOverride ?? defaultFeedbackDbPath()
  } catch {
    return undefined // presetRoot 未配置 → 不落库（增强层，不阻塞出稿）
  }
}

/** StageResult.result → final_output 文本（编译产物整体 JSON，≤32KB 由 store 层裁剪） */
function finalOutputText(stage: StageResult): string {
  try {
    return JSON.stringify(stage.result) ?? ''
  } catch {
    return ''
  }
}

/**
 * 非 audit_only 成功出口统一落库（spec §6：反馈增强层，try/catch 全包——
 * 写失败只 push `feedback_write_failed` advisory，绝不阻塞出稿）。
 */
function recordGenerationSafe(args: {
  id: string
  target: Target
  variant?: string
  judgeMode: 'off' | 'fast' | 'strict'
  input: string
  stage: StageResult
  repairRounds: number
  advisories: string[]
}): void {
  try {
    const dbPath = resolveFeedbackDbPath()
    if (!dbPath) return
    const j = args.stage.judge
    const judged = j !== undefined && 'verdict' in j
    recordGeneration(dbPath, {
      id: args.id,
      created_at: Date.now(),
      target: args.target,
      ...(args.variant !== undefined ? { variant: args.variant } : {}),
      judge_mode: args.judgeMode,
      input_digest: createHash('sha256').update(args.input, 'utf8').digest('hex'),
      final_output: finalOutputText(args.stage),
      ...(judged ? { judge_score: (j as { score: number }).score, judge_verdict: (j as { verdict: string }).verdict } : {}),
      ...(args.stage.debate !== undefined ? { debate_json: JSON.stringify(args.stage.debate) } : {}),
      repair_rounds: args.repairRounds,
    })
  } catch {
    args.advisories.push('feedback_write_failed')
  }
}

/** StageResult → Envelope 顶层评审投影：字段仅在评审实际发生时出现 */
function judgeTopLevel(stage: StageResult): Record<string, unknown> {
  const j = stage.judge
  // F1（review fix1，控制器裁决方案 a，spec §2.5）：规则 critical 跳过评审不是评审结果——不投影 judge
  // （闭环仍由 gates 驱动）；其他 skipped reason（如 LLM 故障）保持投影（judge_skipped advisory 可见）。
  const ruleCriticalSkip = j !== undefined && 'skipped' in j && j.skipped === true && (j as { reason?: string }).reason === 'rule_critical'
  return {
    ...(j !== undefined && !ruleCriticalSkip ? { judge: j } : {}),
    ...(stage.debate !== undefined ? { debate: stage.debate } : {}),
    ...(stage.judgeFeedback !== undefined ? { judgeFeedback: stage.judgeFeedback } : {}),
  }
}

/* ── T4（spec §10.2-A3/A4, §10.4-A13）：makeRevisionProvider v2 —— 稿内编辑 + praise 锚点 + 结构化 rebuttals ── */

/** 与 eval/critic.ts tokensOf 同款词元集（实词交集判定；CJK/假名取 2 字符 bigram） */
function patchTokens(s: string): Set<string> {
  const out = new Set<string>()
  for (const m of String(s).toLowerCase().matchAll(/[a-z0-9\u4e00-\u9fff\u3040-\u30ff\uff66-\uff9f]+/g)) {
    const run = m[0]
    if (/[a-z0-9]/.test(run[0]) && /[a-z0-9]/.test(run[run.length - 1])) {
      if (run.length >= 2) out.add(run)
    } else {
      for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
    }
  }
  return out
}

function patchIntersects(a: string, b: string): boolean {
  const ta = patchTokens(a)
  for (const t of patchTokens(b)) if (ta.has(t)) return true
  return false
}

/** finding 定位键：优先证据查询串，缺省回落 problem 描述 */
function locatorOf(f: CriticFinding): string {
  return (f.evidence?.query ?? '') + ' ' + f.problem
}

type PatchResult = { compiled: unknown; changes: string[]; rebuttals: CriticRebuttal[] } | null

/**
 * anima 稿内编辑：从 compiled.segments 重建槽字段（slot→tags / narrative / exclusions），
 * 按 finding 定位所属槽后把 requiredFix 追加为该槽新 tag（字段级 patch），再经方言重编译。
 * requiredFix 内容已在稿内 → 不改稿，产结构化 rebuttal（带稿内证据）。
 * 任一 finding 定位不到槽 → null（调用方回退整稿重拆）。
 */
function patchAnima(compiled: unknown, findings: CriticFinding[], variant: string): PatchResult {
  const c = compiled as { segments?: unknown; positive?: unknown }
  if (!Array.isArray(c?.segments) || typeof c.positive !== 'string') return null
  const positiveText = String(c.positive).toLowerCase()
  const fields: Record<string, string[]> = {}
  let narrative: string | undefined
  let exclusions: string[] | undefined
  for (const seg of c.segments as Array<Record<string, unknown>>) {
    const slot = typeof seg['slot'] === 'string' ? seg['slot'] : null
    const text = typeof seg['text'] === 'string' ? seg['text'] : null
    const origin = seg['origin']
    const channel = seg['channel']
    if (!text) return null
    if (origin === 'narrative' && channel === 'positive') { narrative = text; continue }
    if (origin === 'exclusion' && channel === 'negative') { (exclusions ??= []).push(text); continue }
    if (channel !== 'positive' || typeof slot !== 'string') continue
    (fields[slot] ??= []).push(text)
  }
  const changes: string[] = []
  const rebuttals: CriticRebuttal[] = []
  let patched = false
  for (const f of findings) {
    const fix = f.requiredFix.trim()
    if (!fix) return null
    if (positiveText.includes(fix.toLowerCase())) {
      // A4：所需内容已在稿内 → 结构化反驳（带稿内证据），不改稿
      rebuttals.push({ finding_id: f.id, rebuttal: `requiredFix 内容已在稿内（无需修改）: ${fix}`, evidence: String(c.positive) })
      continue
    }
    let target: string | null = null
    for (const [slot, tags] of Object.entries(fields)) {
      if (tags.some((t) => patchIntersects(t, locatorOf(f)))) { target = slot; break }
    }
    if (target === null) return null // 定位不到槽 → 整体回退整稿重拆
    fields[target].push(fix)
    changes.push(`patch:slot ${target} += "${fix}" (finding ${f.id})`)
    patched = true
  }
  if (!patched && rebuttals.length === 0) return null
  const d = getDialect('anima')
  if (!d) return null
  const slots: Record<string, unknown> = { ...fields }
  if (narrative !== undefined) slots['narrative'] = narrative
  if (exclusions !== undefined) slots['exclusions'] = exclusions
  try {
    const compiled2 = d.compile(slots as never, { variant: (variant as 'base' | 'aesthetic' | 'turbo') ?? 'base' })
    return { compiled: compiled2, changes, rebuttals }
  } catch {
    return null
  }
}

/**
 * h3 稿内编辑：在 compiled.text 里按词元交集定位 finding 对应的 [Shot N] 段，
 * 用 requiredFix 重写该镜头段文本（保留 dialogue 后缀），text_zh 经 buildTextZh 重投影。
 * 任一 finding 定位不到镜头 / 结构不合规 → null（回退整稿重拆）。
 */
function patchH3(compiled: unknown, findings: CriticFinding[]): PatchResult {
  const text = (compiled as { text?: unknown } | null | undefined)?.text
  if (typeof text !== 'string' || !text.includes('[Shot ')) return null
  let cur = text
  const changes: string[] = []
  const rebuttals: CriticRebuttal[] = []
  for (const f of findings) {
    const fix = f.requiredFix.trim()
    if (!fix) return null
    // 镜头段切分：[Shot N] 起点到下一 [Shot 或文本末尾
    const starts: number[] = []
    const re = /\[Shot (\d+)\]/g
    for (const m of cur.matchAll(re)) starts.push(m.index)
    if (starts.length === 0) return null
    let hitIdx = -1
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1] : cur.length
      const seg = cur.slice(starts[i], end)
      if (patchIntersects(seg, locatorOf(f))) { hitIdx = i; break }
    }
    if (hitIdx < 0) return null
    const start = starts[hitIdx]
    // 段边界：下一 [Shot，或本行行尾（最后一个镜头不得吞掉后续字段行）
    const nl = cur.indexOf('\n', start)
    const end = hitIdx + 1 < starts.length ? starts[hitIdx + 1] : (nl >= 0 ? nl : cur.length)
    const seg = cur.slice(start, end)
    const headerM = /^\[Shot \d+\] /.exec(seg)
    if (!headerM) return null
    const body = seg.slice(headerM[0].length).replace(/\s+$/, '')
    if (body.toLowerCase().includes(fix.toLowerCase())) {
      rebuttals.push({ finding_id: f.id, rebuttal: `requiredFix 内容已在稿内（无需修改）: ${fix}`, evidence: body })
      continue
    }
    // 保留 dialogue 后缀（body 首个「 <d>」之后的部分）
    const dIdx = body.indexOf(' <d>')
    const dialogue = dIdx >= 0 ? body.slice(dIdx) : ''
    const segNo = hitIdx + 1
    const replaced = `[Shot ${segNo}] ${fix}.${dialogue} `
    cur = cur.slice(0, start) + replaced + cur.slice(end)
    changes.push(`patch:shot ${segNo} (finding ${f.id})`)
  }
  if (changes.length === 0 && rebuttals.length === 0) return null
  return { compiled: { text: cur.trimEnd(), text_zh: buildTextZh(cur.trimEnd()) }, changes, rebuttals }
}

/**
 * strict 生产 revisionProvider v2（T4，spec §10.2-A3/A4 + §10.4-A13）：
 * 1. praise 锚点：首轮 praise 非空 → 修订 prompt（feedback）追加「以下优点须保留」块 + 禁删指令；
 * 2. 稿内编辑优先：按 finding 定位 compiled 槽/镜头字段做定点修改（anima 槽字段追加 tag、h3 重写镜头段），
 *    patch 成功不重拆（intent provider 零调用）；
 * 3. patch 失败（定位不到字段/结构不合规）→ 回退整稿重拆（原行为），changes 标注 fallback:full-rebuild；
 * 4. rebuttals：patch 路径上「requiredFix 已在稿内」的 finding 产结构化反驳（带稿内证据）；
 *    回退路径一律照改 → 空数组。
 */
function makeRevisionProvider(args: {
  target: Target
  provider: AuthorIntentFn
  intentBase: Omit<AuthorIntentRequest, 'round' | 'feedback'>
  runOpts: { stage?: string; scenarioId?: string; formFields?: Record<string, unknown>; variant?: string }
  exec: ToolRunContext
}): AuthorRevisionProvider {
  return async (compiled, findings, praise) => {
    const feedback = [
      ...findings.map((f) => `[${f.severity}] ${f.requiredFix}`),
      ...(praise.length > 0
        ? ['', '以下优点须保留：', ...praise.map((p) => `- ${p}`), '（修订时不得删除上述优点对应的内容）']
        : []),
    ].join('\n')
    // 1) 稿内编辑优先（A13）：patch 成功 → 不重拆
    const patched = args.target === 'anima'
      ? patchAnima(compiled, findings, args.runOpts.variant ?? 'base')
      : args.target === 'h3'
        ? patchH3(compiled, findings)
        : null
    if (patched) {
      return { compiled: patched.compiled, changes: patched.changes, revisionNote: feedback, rebuttals: patched.rebuttals }
    }
    // 2) 回退整稿重拆（原 makeRevisionProvider 行为），changes 标注 fallback（A13）
    const draft = await args.provider({ ...args.intentBase, round: 1, feedback }, args.exec)
    const input = normalizeDraftToInput(args.target, draft, args.runOpts)
    const d = getDialect(args.target)
    if (!d) throw new Error(`方言 ${args.target} 未注册（revisionProvider 内部）`)
    const normalized = d.normalize(
      { target: args.target, slots: input.slots, variant: input.variant, shots: input.shots, stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields, auditOnly: false },
      { stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields },
    )
    if (normalized.error !== undefined) throw new Error(normalized.error)
    const revised = d.compile(normalized.value as never, { variant: input.variant, stage: normalized.stage ?? input.stage })
    return { compiled: revised, changes: [...findings.map((f) => f.requiredFix), 'fallback:full-rebuild'], revisionNote: feedback, rebuttals: [] }
  }
}

/** draft → PipelineInput 输入段：anima {slots, variant}；h3 {shots, stage, scenarioId, formFields}
 *  Task 10 蓝图分支：draft.blueprint 存在时先 projectTo* 再入 runStage（扩展在 execute 完成——LLM 异步） */
function normalizeDraftToInput(target: string, draft: AuthorDraft, opts: { stage?: string; scenarioId?: string; formFields?: Record<string, unknown>; variant?: string }): { slots?: Record<string, unknown>; variant?: string; shots?: unknown; stage?: string; scenarioId?: string; formFields?: Record<string, unknown> } {
  if (target === 'anima') {
    if (draft.blueprint) return { slots: projectToAnima(draft.blueprint) as unknown as Record<string, unknown>, variant: opts.variant ?? 'base' }
    if (!draft.slots || typeof draft.slots !== 'object') throw new Error('intent 未产出 slots 结构')
    return { slots: draft.slots as unknown as Record<string, unknown>, variant: opts.variant ?? 'base' }
  }
  if (draft.blueprint) return { shots: projectToH3(draft.blueprint), stage: opts.stage || undefined, scenarioId: opts.scenarioId, formFields: opts.formFields }
  if (!draft.shots || !Array.isArray(draft.shots.shots) || draft.shots.shots.length === 0) throw new Error('intent 未产出 shots 结构')
  return { shots: draft.shots, stage: opts.stage || undefined, scenarioId: opts.scenarioId, formFields: opts.formFields }
}

/** h3 references 计数（原 L144-146 优先级：shots.references > form_fields.references） */
function referencesCount(draft: AuthorDraft, formFields?: Record<string, unknown>): number {
  const refs = Array.isArray(draft.shots?.references) ? draft.shots!.references : []
  if (refs.length > 0) return refs.length
  const formRefs = Array.isArray(formFields?.references) ? (formFields!.references as unknown[]) : []
  return formRefs.length
}

/**
 * 场景表单闸门合并（原 prompt-author L150-155 语义，视图层职责——场景表单语义不是方言本质）：
 * sceneToShotsChecked 的 extraGates/advisories 并入 stage；references 非空时抑制 references_unmapped；
 * 合并后 ok 按全部 gates 重算（extraGates 可能引入 critical）。
 */
function applyScenarioGates(stage: StageResult, opts: { scenarioId?: string; formFields?: Record<string, unknown>; refsCount: number }): StageResult {
  if (!opts.scenarioId) return stage
  const checked = sceneToShotsChecked(opts.scenarioId, opts.formFields ?? {})
  const unmapped = opts.refsCount > 0
  const extraGates = checked.gates.filter((g) => !(g.rule === 'references_unmapped' && unmapped))
  const extraAdvisories = checked.advisories.filter((a) => !(a === 'references_unmapped' && unmapped))
  const gates = [...stage.gates, ...extraGates]
  return {
    ...stage,
    gates,
    advisories: [...stage.advisories, ...extraAdvisories],
    ok: gates.every((g) => g.severity !== 'critical'),
  }
}

/** draft → runStage → applyScenarioGates（author 每轮统一入口；audit 不通过不在此处理——闭环在 execute）
 *  Task 6：judgeOpts 传入时 runStage 走评审（Promise，必须 await）；off/缺省时同步旧路径零变化 */
async function runDraftThroughStage(target: string, draft: AuthorDraft, opts: { stage?: string; scenarioId?: string; formFields?: Record<string, unknown>; variant?: string }, judgeOpts?: JudgeStageOpts): Promise<StageResult> {
  const input = normalizeDraftToInput(target, draft, opts)
  const stageResult = await runStage({ target: target as Target, ...input, ...judgeOpts })
  return applyScenarioGates(stageResult, { scenarioId: opts.scenarioId, formFields: opts.formFields, refsCount: referencesCount(draft, opts.formFields) })
}

/**
 * JoyExtra 硬约束输出过滤（Task 4，anima 分支）：form_fields.joy_extra_options 声明的禁写项
 * 在 compileAnima 产物 positive/negative 上做子句过滤（复核兜底，硬约束优先级高于检查表）。
 * 返回 true 表示发生了实际剔除。
 */
function applyAnimaJoyExtraFilter(stage: StageResult, formFields?: Record<string, unknown>): boolean {
  if (!formFields) return false
  const res = resolveJoyExtraOptions({ joyExtraOptions: formFields.joy_extra_options, extraPrompt: '' })
  if (res.options.length === 0) return false
  let filtered = false
  for (const key of ['positive', 'negative'] as const) {
    const text = stage.result[key]
    if (typeof text !== 'string' || !text.trim()) continue
    const out = filterJoyExtraClauses(text, res)
    if (out !== text) {
      stage.result[key] = out
      filtered = true
    }
  }
  return filtered
}

export function registerAuthorTool(ctx: Context, config: Config) {
  return defineTool({
    name: 'prompt_author',
    description:
      '统一提示词工程主入口（全链路编排）：输入创作意图 → intent（LLM 拆结构）→ schema → dialect（compileAnima/compileH3）→ audit → Envelope + target_slot_hint；audit 未过且有 Critical 时自动修正重跑（max 2 次，仍失败置 loop_exhausted）。' +
      '创作蓝图流水线：分析意图→美学扩展→方言投影→审计；h3 的 duration_seconds 指视频总时长（如 3 个 5 秒分镜请传总时长 15，shots 数 ≤ max_shots）。可选 style_id/conformity/clarify。失败时读取 next_action 决定重试/人工。' +
      '当前归化状态：' +
      TARGETS.map((t) => `${t}=${isDialectReady(t) ? 'ready' : 'pending'}`).join(' ') +
      '；sd/generic 报 DIALECT_NOT_AVAILABLE。',
    parameters: {
      target: { type: 'string', description: '目标方言：anima | h3 | sd | generic', default: 'anima' },
      input: { type: 'string', description: '创作意图（一句话/图描述/分镜素材）' },
      variant: { type: 'string', default: 'base', description: 'anima variant：base/aesthetic/turbo' },
      stage: { type: 'string', default: '', description: 'h3 stage（t2va/ref2va…；缺省按 references/场景推断）' },
      scenario_id: { type: 'string', default: '', description: 'h3 场景 id（如 full_reference；可配合 form_fields）' },
      form_fields: { type: 'object', description: 'h3 场景表单字段（含 references 可选）', default: {}, additionalProperties: true },
      audit_only: { type: 'boolean', default: false, description: '仅审计（不调 LLM）：input 需为结构化 JSON（anima: slots；h3: shots{...}）' },
      style_id: { type: 'string', default: '', description: '蓝图风格模板 id（MINIMAL_STYLES：cinematic_real/game_cg/cel_shading/thick_paint/cyberpunk/wafuu/wasteland/dark_epic；空=不注入）' },
      conformity: { type: 'number', default: 0.6, description: '风格注入 conformity：0=全量注入素材（base+theme+palette 进 style 与 media_layer 片段），>0=仅蓝图 style 引用' },
      clarify: { type: 'string', enum: ['ask', 'auto'], default: 'auto', description: '关键维度缺失（style/media/negative 边界）时的澄清策略：ask=产出 clarify_questions，auto=直接进入扩展' },
      blueprint_id: { type: 'string', default: '', description: '增量修改入口：传蓝图 id 时跳过 analyzeIntent，从 repo 取回旧蓝图直接扩展→投影（取回旧蓝图改一字段重投影）' },
      judge_mode: { type: 'string', enum: ['off', 'fast', 'strict'], default: 'off', description: 'LLM 评审模式（spec §2.4）：off=不评审（缺省）；fast=单轮评审；strict=评审+对抗修正一轮。audit_only=true 时忽略' },
      judgeRepair: { type: 'boolean', default: true, description: '修正轮评审成本开关（spec §10.4-A12）：true（缺省）=每修正轮照常重评；false=修正轮 runStage 不带评审（省 critic 调用，闭环由规则 gates + judgeFeedback 首轮投影驱动）' },
    },
    output: {
      schema: { type: 'string', description: 'P1 Envelope JSON 字符串' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { target?: string; input?: string; variant?: string; stage?: string; scenario_id?: string; form_fields?: Record<string, unknown>; audit_only?: boolean; style_id?: string; conformity?: number; clarify?: 'ask' | 'auto'; blueprint_id?: string; judge_mode?: 'off' | 'fast' | 'strict'; judgeRepair?: boolean }, exec: ToolRunContext) {
      const a = args as unknown as AuthorArgs
      const target = String(a.target || 'anima') as Target
      if (!TARGETS.includes(target)) throw new Error(`Unknown target: ${target}; 可选 ${TARGETS.join('|')}`)
      if (!isDialectReady(target)) {
        return serializeReport({
          ok: false,
          audit: {
            passed: false,
            gates: [{ rule: 'dialect_not_available', target, severity: 'critical', detail: `方言 ${target} 未归化（P4 范围外），请改用 anima / h3 或 prompt_compile`, source: 'tools/prompt-author' }],
          },
          advisories: [],
        } as never)
      }
      const input = String(a.input ?? '')
      if (!input.trim() && !a.blueprint_id) throw new Error('input 必填')

      const scenarioId = String(a.scenario_id ?? '').trim() || undefined
      const runOpts = { stage: a.stage || undefined, scenarioId, formFields: a.form_fields, variant: a.variant }

      // anima variant 参数校验（runStage 的 compileAnima 对未知 variant 静默回退 base——契约要求显式报错）
      if (target === 'anima' && a.variant !== undefined && !VARIANT_SET.has(a.variant)) {
        throw new Error(`未知 variant: ${a.variant}；可选 base|aesthetic|turbo`)
      }

      // audit_only：不调 LLM，把 input 当结构 JSON（原语义：完整编译+审计，result 照常产出——不用内核 auditOnly 标志）
      if (a.audit_only === true) {
        let draft: AuthorDraft
        try {
          const parsed = JSON.parse(input) as Record<string, unknown>
          draft = target === 'anima' ? { slots: parsed as unknown as AnimaSlots } : { shots: parsed as unknown as H3ShotsInput }
        } catch {
          throw new Error('audit_only 需要结构化 JSON 输入（anima: slots；h3: shots{...}）')
        }
        const stage = await runDraftThroughStage(target, draft, runOpts)
        if (target === 'anima') applyAnimaJoyExtraFilter(stage, a.form_fields)
        // Task 6：audit_only 不触发评审；generation_id 仍生成（唯一允许的缺省新增字段）
        return assembleEnvelope(stage, [], undefined, { generation_id: makeGenerationId() })
      }

      const provider = _intentProvider ?? ((req: AuthorIntentRequest, exec2?: ExecLike) => defaultIntent(ctx, resolveRoute((exec2 ?? exec) as ExecLike), req))
      // Task 7：intent persona/schema 方言化——从 dialect 注册表取（ANIMA_*/H3_* 常量），未注册则 undefined → provider 内 DEFAULT 兜底
      // t22 F2：clarify 透传（→ analyzeIntent opts.clarify），否则参数声明了但运行期静默 no-op
      const intentCfg = getDialect(target)?.intent
      const intentBase = { target, input, variant: a.variant, scenarioId, formFields: a.form_fields, persona: intentCfg?.persona, schema: intentCfg?.schema, clarify: a.clarify }

      // Task 6 评审接线（spec §2.4/§3.1）：judge_mode=off → judgeOpts=undefined，runStage 同步旧路径零变化
      const judgeMode = a.judge_mode ?? 'off'
      let judgeOpts: JudgeStageOpts | undefined
      if (judgeMode !== 'off') {
        judgeOpts = {
          judge: judgeMode,
          criticProvider: _judgeDeps?.criticProvider ?? createProductionCriticProvider(ctx),
          evidenceDeps: _judgeDeps?.evidenceDeps ?? createProductionEvidenceDeps(target as 'anima' | 'h3'),
          originalIntent: input,
        }
        if (judgeMode === 'strict') {
          judgeOpts.revisionProvider = _judgeDeps?.revisionProvider ?? makeRevisionProvider({ target, provider, intentBase, runOpts, exec })
        }
      }
      ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author target=${target}${a.variant ? ` variant=${a.variant}` : ''}${a.stage ? ` stage=${a.stage}` : ''}${a.blueprint_id ? ` blueprint_id=${a.blueprint_id}` : ''}`)
      // T4（spec §10.4-A12）：judgeRepair=false → 修正轮 runStage 不带 judgeOpts（provider 零调用）
      const repairJudgeOpts = a.judgeRepair === false ? undefined : judgeOpts

      // Task 10 蓝图管线：blueprint_id → repo.load 跳过 analyzeIntent（增量修改入口）；否则走 intent provider seam
      let draft: AuthorDraft
      if (a.blueprint_id) {
        const settings = (ctx as unknown as { settings?: RepoSettingsScope }).settings
        if (!settings) throw new Error('blueprint_id 需要 repo 后端（ctx.settings 不可用）')
        const repo = createBlueprintRepo({ settings })
        const bp = repo.load(a.blueprint_id)
        if (!bp) throw new Error(`blueprint 不存在: ${a.blueprint_id}`)
        draft = { blueprint: bp }
      } else {
        draft = await provider({ ...intentBase, round: 0 }, exec)
      }

      // 蓝图分支：enrich（LLM 1 次）→ Level 1 预修（零 LLM，不计入 MAX_CORRECTIONS）→ 投影 → runStage
      // → Level 2 LLM 结构化修复（≤2 次，计入 MAX_CORRECTIONS）→ Level 3 manual + loop_exhausted
      if (draft.blueprint) {
        const route = resolveRoute(exec as ExecLike)
        const enrichOpts = { styleId: a.style_id, conformity: a.conformity, missing: (draft.missing ?? []).length > 0 ? draft.missing : undefined }
        const expansions: string[] = []
        const repairs: string[] = []
        let repaired = false
        let joyExtraFiltered = false
        const trailAdvisories: string[] = []

        const e0 = await enrichBlueprint(ctx, route, draft.blueprint, enrichOpts)
        expansions.push(...e0.expansions)
        const l1 = preflightRepair(e0.blueprint)
        if (l1.repairs.length > 0) { repaired = true; repairs.push(...l1.repairs) }
        let bp = l1.bp
        let stage = await runDraftThroughStage(target, { blueprint: bp }, runOpts, judgeOpts)
        // T4（A12）：judgeRepair=false 时修正轮不带评审——投影保留最近一轮带评审的结果（envelope 可见性，不影响闭环）
        let lastJudged: StageResult | undefined = judgeOpts ? stage : undefined
        if (target === 'anima') joyExtraFiltered = applyAnimaJoyExtraFilter(stage, a.form_fields) || joyExtraFiltered

        let corrections = 0
        while (((!stage.ok && stage.gates.some((g) => g.severity === 'critical')) || (stage.judgeFeedback?.length ?? 0) > 0) && corrections < MAX_CORRECTIONS) {
          corrections++
          repaired = true
          // Task 6：feedback = 规则 critical gate + judgeFeedback（needs_revision 终态投影）
          const feedback = JSON.stringify({
            gates: stage.gates.filter((g) => g.severity === 'critical').map((g) => ({ rule: g.rule, severity: g.severity, detail: g.detail })),
            ...(stage.judgeFeedback !== undefined ? { judgeFeedback: stage.judgeFeedback } : {}),
          })
          const d2 = await provider({ ...intentBase, round: corrections, feedback }, exec)
          if (!d2.blueprint) break // provider 未返回蓝图 → 保留当前 stage，走 Level 3
          const e2 = await enrichBlueprint(ctx, route, d2.blueprint, enrichOpts)
          expansions.push(...e2.expansions)
          const l2 = preflightRepair(e2.blueprint)
          repairs.push(...l2.repairs)
          bp = l2.bp
          stage = await runDraftThroughStage(target, { blueprint: bp }, runOpts, repairJudgeOpts)
          if (repairJudgeOpts) lastJudged = stage
          if (target === 'anima') joyExtraFiltered = applyAnimaJoyExtraFilter(stage, a.form_fields) || joyExtraFiltered
        }
        if (!stage.ok && stage.gates.some((g) => g.severity === 'critical')) {
          trailAdvisories.push('loop_exhausted:true') // Level 3：仍失败 → manual + loop_exhausted
        }
        const repair_hints: RepairHint[] = repairs.map((r) => ({
          field: r.startsWith('duration_') ? 'total_duration_seconds' : 'shots',
          fix: r,
        }))
        // t22 F1：computeNextAction 只读 stage.advisories——把 trailAdvisories（loop_exhausted:true）并入
        // stage 视图；且循环耗尽时 repaired 失效化（否则 repaired 分支在 manual 判定前短路 → 误报 auto_repair）
        const loopExhausted = trailAdvisories.includes('loop_exhausted:true')
        const projStage: StageResult = (repairJudgeOpts === undefined && stage.judge === undefined && lastJudged !== undefined)
          ? { ...stage, judge: lastJudged.judge, debate: lastJudged.debate, judgeFeedback: lastJudged.judgeFeedback }
          : stage
        const nextStage: StageResult = loopExhausted
          ? { ...stage, advisories: [...stage.advisories, ...trailAdvisories] }
          : stage
        ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author(blueprint) → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} expansions=${expansions.length} repairs=${repairs.length} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
        const generationId = makeGenerationId()
        recordGenerationSafe({ id: generationId, target, variant: a.variant, judgeMode, input, stage: projStage, repairRounds: corrections, advisories: trailAdvisories })
        return assembleEnvelope(projStage, trailAdvisories, {
          corrections,
          loopExhausted,
          joyExtraFiltered,
          traceStages: stage.trace?.stages,
          expansions,
          repairs,
        }, {
          generation_id: generationId,
          ...judgeTopLevel(projStage),
        }, {
          next_action: computeNextAction(nextStage, { repairHints: repair_hints, repaired: loopExhausted ? false : repaired }),
          repair_hints,
        })
      }

      // 旧 slots/shots 直传路径（向后兼容——AuthorDraft.blueprint 缺省时走原逻辑）
      let stage = await runDraftThroughStage(target, draft, runOpts, judgeOpts)
      // T4（A12）：judgeRepair=false 时修正轮不带评审——投影保留最近一轮带评审的结果
      let lastJudged: StageResult | undefined = judgeOpts ? stage : undefined
      let joyExtraFiltered = false
      if (target === 'anima') joyExtraFiltered = applyAnimaJoyExtraFilter(stage, a.form_fields) || joyExtraFiltered
      const trailAdvisories: string[] = []
      let corrections = 0
      // Task 6：闭环条件在规则 critical 之上追加 judgeFeedback（needs_revision 终态）；
      // feedback 拼接 = 规则 gate 的 `[rule] detail` 行 + judgeFeedback 行；max-2 / loop_exhausted 语义不变
      while (((!stage.ok && stage.gates.some((g) => g.severity === 'critical')) || (stage.judgeFeedback?.length ?? 0) > 0) && corrections < MAX_CORRECTIONS) {
        corrections++
        const feedback = [
          ...stage.gates.filter((g) => g.severity === 'critical').map((g) => `[${g.rule}] ${g.detail}`),
          ...(stage.judgeFeedback ?? []),
        ].join('\n')
        draft = await provider({ ...intentBase, round: corrections, feedback }, exec)
        stage = await runDraftThroughStage(target, draft, runOpts, repairJudgeOpts)
        if (repairJudgeOpts) lastJudged = stage
        if (target === 'anima') joyExtraFiltered = applyAnimaJoyExtraFilter(stage, a.form_fields) || joyExtraFiltered
      }
      if (!stage.ok && stage.gates.some((g) => g.severity === 'critical')) {
        trailAdvisories.push('loop_exhausted:true')
      }
      ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} joy_extra filtered=${joyExtraFiltered ? 'yes' : 'no'} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
      const projStage: StageResult = (repairJudgeOpts === undefined && stage.judge === undefined && lastJudged !== undefined)
        ? { ...stage, judge: lastJudged.judge, debate: lastJudged.debate, judgeFeedback: lastJudged.judgeFeedback }
        : stage
      const generationId = makeGenerationId()
      recordGenerationSafe({ id: generationId, target, variant: a.variant, judgeMode, input, stage: projStage, repairRounds: corrections, advisories: trailAdvisories })
      return assembleEnvelope(projStage, trailAdvisories, {
        corrections,
        loopExhausted: trailAdvisories.includes('loop_exhausted:true'),
        joyExtraFiltered,
        traceStages: stage.trace?.stages,
      }, {
        generation_id: generationId,
        ...judgeTopLevel(projStage),
      })
    },
  })
}
