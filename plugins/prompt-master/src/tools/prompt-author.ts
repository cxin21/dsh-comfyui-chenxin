import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { TARGETS, type Target } from '../pe-framework/index.js'
import { serializeReport } from '../pe-framework/audit/index.js'
import type { AnimaSlots } from '../pe-framework/dialect/anima.js'
// 方言模块副作用注册（Task 6：DIALECT_READY 静态表 → 注册表查询）
import '../pe-framework/dialect/anima.js'
import '../pe-framework/dialect/h3.js'
import { isDialectReady as registryIsDialectReady, getDialect } from '../pe-framework/dialect/registry.js'
import { runStage } from '../pe-framework/pipeline/runStage.js'
import { assembleEnvelope, computeNextAction, type RepairHint } from '../pe-framework/render/envelope.js'
import type { StageResult } from '../pe-framework/pipeline/types.js'
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

/** draft → runStage → applyScenarioGates（author 每轮统一入口；audit 不通过不在此处理——闭环在 execute） */
function runDraftThroughStage(target: string, draft: AuthorDraft, opts: { stage?: string; scenarioId?: string; formFields?: Record<string, unknown>; variant?: string }): StageResult {
  const input = normalizeDraftToInput(target, draft, opts)
  const stageResult = runStage({ target: target as Target, ...input })
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
      style_id: { type: 'string', default: '', description: '蓝图风格模板 id（MINIMAL_STYLES：cinematic_real/game_cg/cel_shading/thick_paint/cyberpunk/wafuu/wasteland/dark_epic；空=不注入）' },
      conformity: { type: 'number', default: 0.6, description: '风格注入 conformity：0=全量注入素材（base+theme+palette 进 style 与 media_layer 片段），>0=仅蓝图 style 引用' },
      clarify: { type: 'string', enum: ['ask', 'auto'], default: 'auto', description: '关键维度缺失（style/media/negative 边界）时的澄清策略：ask=产出 clarify_questions，auto=直接进入扩展' },
      blueprint_id: { type: 'string', default: '', description: '增量修改入口：传蓝图 id 时跳过 analyzeIntent，从 repo 取回旧蓝图直接扩展→投影（取回旧蓝图改一字段重投影）' },
    },
    output: {
      schema: { type: 'string', description: 'P1 Envelope JSON 字符串' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { target?: string; input?: string; variant?: string; stage?: string; scenario_id?: string; form_fields?: Record<string, unknown>; audit_only?: boolean; style_id?: string; conformity?: number; clarify?: 'ask' | 'auto'; blueprint_id?: string }, exec: ToolRunContext) {
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
        const stage = runDraftThroughStage(target, draft, runOpts)
        if (target === 'anima') applyAnimaJoyExtraFilter(stage, a.form_fields)
        return assembleEnvelope(stage, [])
      }

      const provider = _intentProvider ?? ((req: AuthorIntentRequest, exec2?: ExecLike) => defaultIntent(ctx, resolveRoute((exec2 ?? exec) as ExecLike), req))
      // Task 7：intent persona/schema 方言化——从 dialect 注册表取（ANIMA_*/H3_* 常量），未注册则 undefined → provider 内 DEFAULT 兜底
      const intentCfg = getDialect(target)?.intent
      const intentBase = { target, input, variant: a.variant, scenarioId, formFields: a.form_fields, persona: intentCfg?.persona, schema: intentCfg?.schema }
      ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author target=${target}${a.variant ? ` variant=${a.variant}` : ''}${a.stage ? ` stage=${a.stage}` : ''}${a.blueprint_id ? ` blueprint_id=${a.blueprint_id}` : ''}`)

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
        let stage = runDraftThroughStage(target, { blueprint: bp }, runOpts)
        if (target === 'anima') joyExtraFiltered = applyAnimaJoyExtraFilter(stage, a.form_fields) || joyExtraFiltered

        let corrections = 0
        while (!stage.ok && stage.gates.some((g) => g.severity === 'critical') && corrections < MAX_CORRECTIONS) {
          corrections++
          repaired = true
          const feedback = JSON.stringify({
            gates: stage.gates.filter((g) => g.severity === 'critical').map((g) => ({ rule: g.rule, severity: g.severity, detail: g.detail })),
          })
          const d2 = await provider({ ...intentBase, round: corrections, feedback }, exec)
          if (!d2.blueprint) break // provider 未返回蓝图 → 保留当前 stage，走 Level 3
          const e2 = await enrichBlueprint(ctx, route, d2.blueprint, enrichOpts)
          expansions.push(...e2.expansions)
          const l2 = preflightRepair(e2.blueprint)
          repairs.push(...l2.repairs)
          bp = l2.bp
          stage = runDraftThroughStage(target, { blueprint: bp }, runOpts)
          if (target === 'anima') joyExtraFiltered = applyAnimaJoyExtraFilter(stage, a.form_fields) || joyExtraFiltered
        }
        if (!stage.ok && stage.gates.some((g) => g.severity === 'critical')) {
          trailAdvisories.push('loop_exhausted:true') // Level 3：仍失败 → manual + loop_exhausted
        }
        const repair_hints: RepairHint[] = repairs.map((r) => ({
          field: r.startsWith('duration_') ? 'total_duration_seconds' : 'shots',
          fix: r,
        }))
        ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author(blueprint) → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} expansions=${expansions.length} repairs=${repairs.length} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
        return assembleEnvelope(stage, trailAdvisories, {
          corrections,
          loopExhausted: trailAdvisories.includes('loop_exhausted:true'),
          joyExtraFiltered,
          traceStages: stage.trace?.stages,
          expansions,
          repairs,
        }, undefined, {
          next_action: computeNextAction(stage, { repairHints: repair_hints, repaired }),
          repair_hints,
        })
      }

      // 旧 slots/shots 直传路径（向后兼容——AuthorDraft.blueprint 缺省时走原逻辑）
      let stage = runDraftThroughStage(target, draft, runOpts)
      let joyExtraFiltered = false
      if (target === 'anima') joyExtraFiltered = applyAnimaJoyExtraFilter(stage, a.form_fields) || joyExtraFiltered
      const trailAdvisories: string[] = []
      let corrections = 0
      while (!stage.ok && stage.gates.some((g) => g.severity === 'critical') && corrections < MAX_CORRECTIONS) {
        corrections++
        const feedback = stage.gates.filter((g) => g.severity === 'critical').map((g) => `[${g.rule}] ${g.detail}`).join('\n')
        draft = await provider({ ...intentBase, round: corrections, feedback }, exec)
        stage = runDraftThroughStage(target, draft, runOpts)
        if (target === 'anima') joyExtraFiltered = applyAnimaJoyExtraFilter(stage, a.form_fields) || joyExtraFiltered
      }
      if (!stage.ok && stage.gates.some((g) => g.severity === 'critical')) {
        trailAdvisories.push('loop_exhausted:true')
      }
      ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} joy_extra filtered=${joyExtraFiltered ? 'yes' : 'no'} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
      return assembleEnvelope(stage, trailAdvisories, {
        corrections,
        loopExhausted: trailAdvisories.includes('loop_exhausted:true'),
        joyExtraFiltered,
        traceStages: stage.trace?.stages,
      })
    },
  })
}
