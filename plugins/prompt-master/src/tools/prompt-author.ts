import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { TARGETS, type Target } from '../pe-framework/index.js'
import { serializeReport, buildAuditReport } from '../pe-framework/audit/index.js'
import { compileAnima, auditAnima, type AnimaSlots } from '../pe-framework/dialect/anima.js'
import { compileH3 } from '../pe-framework/dialect/h3.js'
import { auditH3Full, contractGatesH3 } from '../pe-framework/audit/rules-h3.js'
import { buildH3Budget, h3BudgetToReport } from '../pe-framework/audit/budget.js'
import { sceneToShotsChecked } from '../pe-framework/schema/scenes.js'
import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js'
import type { AuditGate } from '../pe-framework/types.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'
import { complete } from '../llm/complete.js'
import { resolveRoute, type ExecLike } from '../llm/route.js'

export interface AuthorArgs {
  target: Target
  input: string
  profile?: string
  variant?: string
  stage?: string
  scenario_id?: string
  form_fields?: Record<string, unknown>
  audit_only?: boolean
}

/** 方言归化状态机：T13 点亮 anima/h3；sd/generic 保持未归化 */
const DIALECT_READY: Record<Target, boolean> = { anima: true, h3: true, sd: false, generic: false }

export function isDialectReady(target: Target): boolean {
  return DIALECT_READY[target] === true
}

/* ── intent 层（LLM；测试注入 seam）── */

export interface AuthorDraft {
  slots?: AnimaSlots
  shots?: H3ShotsInput
}

export interface AuthorIntentRequest {
  target: string
  input: string
  variant?: string
  scenarioId?: string
  formFields?: Record<string, unknown>
  round: number
  feedback?: string
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

/* ── 编排（意图 → schema → dialect → audit → render + 修正闭环）── */

const VARIANT_SET = new Set(['base', 'aesthetic', 'turbo'])

function inferH3Stage(shots: H3ShotsInput, references: unknown[], scenarioId?: string): string {
  if (references.length > 0) return 'ref2va'
  if (scenarioId === 'full_reference') return 'ref2va'
  return 't2va'
}

function toRefs(raw: unknown[]): Array<{ who: string | null; image: string; width: number | null; height: number | null }> {
  return raw.map((r) => {
    const x = r as Record<string, unknown>
    return {
      who: x['who'] != null ? String(x['who']) : null,
      image: String(x['image'] ?? ''),
      width: typeof x['width'] === 'number' ? x['width'] : null,
      height: typeof x['height'] === 'number' ? x['height'] : null,
    }
  })
}

function runDraftStage(opts: { target: string; draft: AuthorDraft; stage?: string; scenarioId?: string; formFields?: Record<string, unknown>; variant?: string }): StageResult {
  const target = opts.target
  if (target === 'anima') {
    const slots = opts.draft.slots
    if (!slots || typeof slots !== 'object') throw new Error('intent 未产出 slots 结构')
    const variant = opts.variant ?? 'base'
    if (!VARIANT_SET.has(variant)) throw new Error(`未知 variant: ${variant}；可选 base|aesthetic|turbo`)
    const compiled = compileAnima(slots, { variant: variant as 'base' | 'aesthetic' | 'turbo' })
    const gates = auditAnima(compiled.positive, compiled.negative, { variant: variant as 'base' | 'aesthetic' | 'turbo', slots })
    return {
      ok: gates.every((g) => g.severity !== 'critical'),
      result: { positive: compiled.positive, negative: compiled.negative },
      gates,
      advisories: [],
      targetSlotHint: 't2i.prompt',
    }
  }
  const shots = opts.draft.shots
  if (!shots || !Array.isArray(shots.shots) || shots.shots.length === 0) throw new Error('intent 未产出 shots 结构')
  const refs = Array.isArray(shots.references) ? shots.references : []
  const formRefs = Array.isArray(opts.formFields?.references) ? (opts.formFields.references as unknown[]) : []
  const references = refs.length ? refs : formRefs
  const stage = opts.stage ?? inferH3Stage(shots, references, opts.scenarioId)
  const extraGates: AuditGate[] = []
  const extraAdvisories: string[] = []
  if (opts.scenarioId) {
    const checked = sceneToShotsChecked(opts.scenarioId, opts.formFields ?? {})
    const unmapped = references.length > 0
    extraGates.push(...checked.gates.filter((g) => !(g.rule === 'references_unmapped' && unmapped)))
    extraAdvisories.push(...checked.advisories.filter((a) => !(a === 'references_unmapped' && unmapped)))
  }
  const { text, textZh } = compileH3(shots, { stage })
  const gates = [
    ...contractGatesH3(stage, shots, references), // T13 F1
    ...extraGates,
    ...auditH3Full(text, { stage, duration: shots.duration_seconds, shotCount: shots.shots.length }, references),
  ]
  const budget = h3BudgetToReport(buildH3Budget(stage, text, toRefs(references)))
  return {
    ok: gates.every((g) => g.severity !== 'critical'),
    result: { text, text_zh: textZh },
    gates,
    advisories: extraAdvisories,
    budget,
    targetSlotHint: 't2v.prompt',
  }
}

export interface StageResult {
  ok: boolean
  result: Record<string, unknown>
  gates: AuditGate[]
  advisories: string[]
  budget?: { counter: 'official-tokenizer' | 'estimate'; tokens: number; max?: number; over: boolean }
  targetSlotHint: string
}

function renderEnvelope(stage: StageResult, trailAdvisories: string[]): string {
  const envelope: Record<string, unknown> = {
    ok: stage.ok,
    result: stage.result,
    audit: { passed: stage.ok, gates: stage.gates, ...(stage.budget ? { budget: stage.budget } : {}) },
    advisories: [...stage.advisories, ...trailAdvisories],
    target_slot_hint: stage.targetSlotHint,
  }
  return serializeReport(envelope as never)
}

const MAX_CORRECTIONS = 2

export function registerAuthorTool(ctx: Context, config: Config) {
  return defineTool({
    name: 'prompt_author',
    description:
      '统一提示词工程主入口（全链路编排）：输入创作意图 → intent（LLM 拆结构）→ schema → dialect（compileAnima/compileH3）→ audit → Envelope + target_slot_hint；audit 未过且有 Critical 时自动修正重跑（max 2 次，仍失败置 loop_exhausted）。当前归化状态：' +
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
    },
    output: {
      schema: { type: 'string', description: 'P1 Envelope JSON 字符串' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { target?: string; input?: string; variant?: string; stage?: string; scenario_id?: string; form_fields?: Record<string, unknown>; audit_only?: boolean }, exec: ToolRunContext) {
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
      if (!input.trim()) throw new Error('input 必填')

      const scenarioId = String(a.scenario_id ?? '').trim() || undefined

      // audit_only：不调 LLM，把 input 当结构 JSON
      if (a.audit_only === true) {
        let draft: AuthorDraft
        try {
          const parsed = JSON.parse(input) as Record<string, unknown>
          draft = target === 'anima' ? { slots: parsed as unknown as AnimaSlots } : { shots: parsed as unknown as H3ShotsInput }
        } catch {
          throw new Error('audit_only 需要结构化 JSON 输入（anima: slots；h3: shots{...}）')
        }
        const stage = runDraftStage({ target, draft, stage: a.stage, scenarioId, formFields: a.form_fields, variant: a.variant })
        return renderEnvelope(stage, [])
      }

      const provider = _intentProvider ?? ((req: AuthorIntentRequest, exec2?: ExecLike) => defaultIntent(ctx, resolveRoute((exec2 ?? exec) as ExecLike), req))
      let draft = await provider({ target, input, variant: a.variant, scenarioId, formFields: a.form_fields, round: 0 }, exec)
      let stage = runDraftStage({ target, draft, stage: a.stage, scenarioId, formFields: a.form_fields, variant: a.variant })
      const trailAdvisories: string[] = []
      let corrections = 0
      while (!stage.ok && stage.gates.some((g) => g.severity === 'critical') && corrections < MAX_CORRECTIONS) {
        corrections++
        const feedback = stage.gates.filter((g) => g.severity === 'critical').map((g) => `[${g.rule}] ${g.detail}`).join('\n')
        draft = await provider({ target, input, variant: a.variant, scenarioId, formFields: a.form_fields, round: corrections, feedback }, exec)
        stage = runDraftStage({ target, draft, stage: a.stage, scenarioId, formFields: a.form_fields, variant: a.variant })
      }
      if (!stage.ok && stage.gates.some((g) => g.severity === 'critical')) {
        trailAdvisories.push('loop_exhausted:true')
      }
      return renderEnvelope(stage, trailAdvisories)
    },
  })
}