import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
// 方言模块副作用注册（Task 6：编排走 runStage 注册表，需保证 anima/h3 已装配）
import '../pe-framework/dialect/anima.js'
import '../pe-framework/dialect/h3.js'
import { runStage } from '../pe-framework/pipeline/runStage.js'
import { assembleEnvelope } from '../pe-framework/render/envelope.js'
import type { StageResult } from '../pe-framework/pipeline/types.js'
import { serializeReport } from '../pe-framework/audit/report.js'
import { sceneToShotsChecked } from '../pe-framework/schema/scenes.js'
import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js'

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

/** StageResult → Envelope（thin view 组装点）；omitResult 用于 audit_only 语义（不返回提示词正文）。
 *  MF-3：result 省略仅限 audit_only——非 audit_only 即使 ok=false（critical 闸门）也保留 result
 *  （对齐旧 compile 行为：ok:true + audit.passed:false 可见编译产物；确定性编译无「修复重试」路径）。 */
function stageToEnvelope(stage: StageResult, opts?: { omitResult?: boolean }): string {
  const env = JSON.parse(assembleEnvelope(stage)) as Record<string, unknown>
  if (opts?.omitResult) delete env.result
  else if (env.result === undefined) env.result = stage.result
  return serializeReport(env as never)
}

const VARIANT_SET = ['base', 'aesthetic', 'turbo']

/** anima 分支：slots → runStage（compileAnima + auditAnima，无 budget）→ Envelope。variant 未知 → 参数错误（t50 Minor 处置）。onStage：成功前打点钩子（日志摘要，不打正文） */
export function compileAnimaEnvelope(slots: Record<string, unknown> | undefined, variant?: string, auditOnly?: boolean, onStage?: (stage: StageResult) => void): string {
  if (!slots || typeof slots !== 'object') throw new Error('anima 分支需要 slots 输入（AnimaSlots 形状）')
  if (variant !== undefined && !VARIANT_SET.includes(variant)) {
    throw new Error(`未知 variant: ${variant}；可选 base|aesthetic|turbo`)
  }
  const stage = runStage({ target: 'anima', slots, variant, auditOnly: auditOnly === true })
  onStage?.(stage)
  return stageToEnvelope(stage, { omitResult: auditOnly === true })
}

export function registerCompileTool(ctx?: Context) {
  type LogCtx = { logger?: { info?: (msg: string) => void } }
  const logInfo = (msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)
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
      logInfo(`[prompt-master] prompt_compile target=${target}${a.scenario_id ? ` scenario=${String(a.scenario_id).trim()}` : ''}`)
      if (target === 'anima') {
        if (a.scenario_id || a.shots || a.form_fields) {
          throw new Error('参数错误：scenario_id/form_fields/shots 属于 h3 分支，anima 请使用 slots + variant')
        }
        const out = compileAnimaEnvelope(a.slots, a.variant, a.audit_only === true, (stage) => {
          logInfo(`[prompt-master] prompt_compile → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
        })
        return out
      }
      if (target !== 'h3') {
        throw new Error(`DIALECT_NOT_AVAILABLE: ${target} 方言未归化（本期支持 h3 / anima）`)
      }
      if (a.slots || a.variant) {
        throw new Error('参数错误：slots/variant 属于 anima 分支，h3 请使用 scenario_id/form_fields 或 shots')
      }
      let shots: H3ShotsInput | null = null
      let scenarioId: string | undefined
      const extraGates: StageResult['gates'] = []
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
      // stage 推断在 runStage normalize 单点（references > full_reference 场景 > t2va）；references 走 formFields
      let stage = runStage({
        target: 'h3',
        shots,
        scenarioId,
        formFields: a.form_fields,
        auditOnly: a.audit_only === true,
      })
      if (extraGates.length || extraAdvisories.length) {
        const gates = [...extraGates, ...stage.gates]
        stage = { ...stage, gates, advisories: [...extraAdvisories, ...stage.advisories], ok: !gates.some((g) => g.severity === 'critical') }
      }
      logInfo(`[prompt-master] prompt_compile → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
      return stageToEnvelope(stage, { omitResult: a.audit_only === true })
    },
  })
}
