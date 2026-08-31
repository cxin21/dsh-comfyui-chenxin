import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { compileH3 } from '../pe-framework/dialect/h3.js'
import { auditH3Full, contractGatesH3 } from '../pe-framework/audit/rules-h3.js'
import { buildH3Budget, h3BudgetToReport } from '../pe-framework/audit/budget.js'
import { serializeReport, buildAuditReport } from '../pe-framework/audit/report.js'
import { sceneToShots, sceneToShotsChecked } from '../pe-framework/schema/scenes.js'
import type { H3ShotsInput, Reference } from '../pe-framework/schema/h3-shots.js'
import { compileAnima, auditAnima, type AnimaSlots } from '../pe-framework/dialect/anima.js'
import type { AuditGate } from '../pe-framework/types.js'

export interface CompileArgs {
  target?: string
  shots?: H3ShotsInput
  scenario_id?: string
  form_fields?: Record<string, unknown>
  output_lang?: string
  audit_only?: boolean
  slots?: Record<string, unknown>
  variant?: string
}

export function toReferences(raw: unknown[]): Reference[] {
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

/** stage 推断（official-capabilities 路由）：有 references → ref2va；full_reference 场景 → ref2va；否则 t2va */
export function inferH3Stage(shots: H3ShotsInput, scenarioId?: string): 't2va' | 'ref2va' {
  if (Array.isArray(shots.references) && shots.references.length > 0) return 'ref2va'
  if (scenarioId === 'full_reference') return 'ref2va'
  return 't2va'
}

export function compileH3Envelope(
  input: { stage: string; shots: H3ShotsInput; references?: unknown[]; auditOnly?: boolean },
): string {
  const { text, textZh } = compileH3(input.shots, { stage: input.stage })
  const shotCount = input.shots.shots.length
  const gates = [
    ...contractGatesH3(input.stage, input.shots, input.references ?? []), // T13 F1 前置契约闸门
    ...auditH3Full(text, { stage: input.stage, duration: input.shots.duration_seconds, shotCount }, input.references),
  ]
  const budget = h3BudgetToReport(buildH3Budget(input.stage, text, toReferences(input.references ?? [])))
  const report = buildAuditReport({ gates, budget, assumptions: [], advisories: [] })
  const envelope: Record<string, unknown> = {
    ok: true,
    audit: { passed: report.passed, gates: report.gates, budget: report.budget },
    advisories: report.advisories,
  }
  if (!input.auditOnly) {
    envelope.result = { text, text_zh: textZh }
  }
  return serializeReport(envelope as never)
}

/** anima 分支：slots → compileAnima + auditAnima → Envelope（无 budget）。variant 未知 → 参数错误（t50 Minor 处置） */
export function compileAnimaEnvelope(slots: Record<string, unknown> | undefined, variant?: string, auditOnly?: boolean): string {
  if (!slots || typeof slots !== 'object') throw new Error('anima 分支需要 slots 输入（AnimaSlots 形状）')
  if (variant !== undefined && !['base', 'aesthetic', 'turbo'].includes(variant)) {
    throw new Error(`未知 variant: ${variant}；可选 base|aesthetic|turbo`)
  }
  const aSlots = slots as unknown as AnimaSlots
  const v = (variant ?? 'base') as 'base' | 'aesthetic' | 'turbo'
  const compiled = compileAnima(aSlots, { variant: v })
  const gates = auditAnima(compiled.positive, compiled.negative, { variant: v, slots: aSlots })
  const report = buildAuditReport({ gates, assumptions: [], advisories: [] })
  const envelope: Record<string, unknown> = {
    ok: true,
    audit: { passed: report.passed, gates: report.gates },
    advisories: report.advisories,
  }
  if (!auditOnly) {
    envelope.result = { positive: compiled.positive, negative: compiled.negative }
  }
  return serializeReport(envelope as never)
}

export function registerCompileTool() {
  return defineTool({
    name: 'prompt_compile',
    description:
      '确定性编译+审计：target=h3（场景/shots → official dialect 文本+审计）或 target=anima（slots → positive/negative+审计；无 budget）。h3 budget counter=estimate（T12 前）。',
    parameters: {
      target: { type: 'string', default: 'h3', description: '目标方言：h3 / anima' },
      slots: { type: 'object', description: 'anima 槽位 brief（AnimaSlots 形状）', default: {}, additionalProperties: true },
      variant: { type: 'string', default: 'base', description: 'anima variant：base/aesthetic/turbo' },
      shots: { type: 'object', description: '直接传入 H3 shots（{duration_seconds, shots[]}）', default: {}, additionalProperties: true },
      scenario_id: { type: 'string', default: '', description: 'PM 场景 id（如 full_reference；映射生成 shots）' },
      form_fields: { type: 'object', description: '场景表单字段（随场景而异）', default: {}, additionalProperties: true },
      output_lang: { type: 'string', default: 'zh', description: '输出语言 zh/en/ja' },
      audit_only: { type: 'boolean', default: false, description: '只返回审计结果（不返回提示词正文）' },
    },
    output: {
      schema: { type: 'string', description: 'Envelope JSON 字符串 {ok, result?, audit, advisories}' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { target?: string; shots?: Record<string, unknown>; scenario_id?: string; form_fields?: Record<string, unknown>; output_lang?: string; audit_only?: boolean; slots?: Record<string, unknown>; variant?: string }, _exec: ToolRunContext) {
      const a = args as unknown as CompileArgs
      const target = String(a.target || 'h3')
      if (target === 'anima') {
        if (a.scenario_id || a.shots || a.form_fields) {
          throw new Error('参数错误：scenario_id/form_fields/shots 属于 h3 分支，anima 请使用 slots + variant')
        }
        return compileAnimaEnvelope(a.slots, a.variant, a.audit_only === true)
      }
      if (target !== 'h3') {
        throw new Error(`DIALECT_NOT_AVAILABLE: ${target} 方言未归化（本期支持 h3 / anima）`)
      }
      if (a.slots || a.variant) {
        throw new Error('参数错误：slots/variant 属于 anima 分支，h3 请使用 scenario_id/form_fields 或 shots')
      }
      let shots: H3ShotsInput | null = null
      let scenarioId: string | undefined
      const extraGates: AuditGate[] = []
      const extraAdvisories: string[] = []
      if (a.scenario_id) {
        scenarioId = String(a.scenario_id).trim()
        // T13 F2：references 映射 + ref2va 形态缺引用 advisory/critical
        const checked = sceneToShotsChecked(scenarioId, a.form_fields ?? {}, { lang: a.output_lang })
        shots = checked.shots
        if (!shots) throw new Error(`场景映射不可用: ${scenarioId}`)
        extraGates.push(...checked.gates)
        extraAdvisories.push(...checked.advisories)
      } else if (a.shots && Array.isArray(a.shots.shots) && (a.shots.shots as unknown[]).length > 0) {
        shots = a.shots as unknown as H3ShotsInput
      }
      if (!shots) throw new Error('需要 scenario_id 或 shots 输入')
      const stage = inferH3Stage(shots, scenarioId)
      const references = Array.isArray(a.form_fields?.references) ? (a.form_fields.references as unknown[]) : []
      const envelope = JSON.parse(compileH3Envelope({ stage, shots, references, auditOnly: a.audit_only === true })) as Record<string, unknown>
      if (extraGates.length || extraAdvisories.length) {
        const audit = envelope.audit as { passed: boolean; gates: AuditGate[] }
        const mergedGates = [...extraGates, ...(audit.gates ?? [])]
        envelope.audit = { passed: !mergedGates.some((g) => g.severity === 'critical'), gates: mergedGates }
        envelope.advisories = [...(extraAdvisories), ...((envelope.advisories as string[]) ?? [])]
      }
      return serializeReport(envelope as never)
    },
  })
}