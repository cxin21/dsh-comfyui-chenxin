import { defineTool } from '@deepseek-ai/dsh-tools'
import { compileAnima, auditAnima, type AnimaSlots } from '../pe-framework/dialect/anima.js'
import { auditH3Full, contractGatesH3 } from '../pe-framework/audit/rules-h3.js'
import { buildH3Budget, h3BudgetToReport } from '../pe-framework/audit/budget.js'
import { serializeReport } from '../pe-framework/audit/report.js'
import type { AuditGate } from '../pe-framework/types.js'
import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'

export interface AuditContent {
  target: 'anima' | 'h3'
  // anima: positive/negative + variant + slots（catalog_miss 等需 slots）
  positive?: string
  negative?: string
  variant?: string
  slots?: AnimaSlots
  // h3: text + 元信息 + references
  text?: string
  stage?: string
  duration?: number
  shotCount?: number
  references?: unknown[]
}

/** 纯审计闸门（无 LLM）：按 target 直接 audit + budget → Envelope */
export function auditContentEnvelope(content: AuditContent): string {
  const target = content.target
  let gates: AuditGate[]
  let budget: unknown
  let ok: boolean
  if (target === 'anima') {
    if (typeof content.positive !== 'string' || typeof content.negative !== 'string') {
      throw new Error('anima 审计需要 positive + negative 文本')
    }
    const variant = (content.variant ?? 'base') as 'base' | 'aesthetic' | 'turbo'
    gates = auditAnima(content.positive, content.negative, { variant, slots: content.slots })
    budget = undefined
    ok = gates.every((g) => g.severity !== 'critical')
  } else {
    if (typeof content.text !== 'string') throw new Error('h3 审计需要 text 文本')
    const stage = content.stage ?? 't2va'
    const duration = content.duration ?? 10
    const shotCount = content.shotCount ?? ((content.text.match(/\[Shot \d+\]/g) ?? []).length || 1)
    const references = content.references ?? []
    const shots: H3ShotsInput = { duration_seconds: duration, shots: [{ what: content.text.slice(0, 200) }] }
    gates = [
      ...contractGatesH3(stage, { duration_seconds: duration, shots: [{ what: 'x' }] }, references),
      ...auditH3Full(content.text, { stage, duration, shotCount }, references),
    ]
    budget = h3BudgetToReport(buildH3Budget(stage, content.text, toRefs(references)))
    ok = gates.every((g) => g.severity !== 'critical')
    void shots
  }
  return serializeReport({
    ok,
    audit: { passed: ok, gates, ...(budget ? { budget } : {}) },
    advisories: [],
  } as never)
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

export function registerAuditTool(_ctx: Context, _config: Config) {
  return defineTool({
    name: 'prompt_audit',
    description:
      '纯审计闸门（无 LLM）：按 target 对已有内容直接跑审计 + budget（anima: positive/negative（可附 slots）；h3: text + stage/duration/shotCount/references）。',
    parameters: {
      target: { type: 'string', default: 'h3', description: 'anima | h3' },
      positive: { type: 'string', default: '', description: 'anima positive' },
      negative: { type: 'string', default: '', description: 'anima negative' },
      variant: { type: 'string', default: 'base', description: 'anima variant' },
      slots: { type: 'object', description: 'anima 槽位（catalog_miss/段数审计）', default: {}, additionalProperties: true },
      text: { type: 'string', default: '', description: 'h3 提示词文本' },
      stage: { type: 'string', default: 't2va', description: 'h3 stage' },
      duration: { type: 'number', default: 10, description: 'h3 duration_seconds' },
      shotCount: { type: 'number', default: 1, description: 'h3 镜头数' },
      references: { type: 'array', description: 'h3 图片引用', default: [] },
    },
    output: {
      schema: { type: 'string', description: 'Envelope JSON 字符串 {ok, audit, advisories}' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: Record<string, unknown>) {
      const target = String(args.target ?? 'h3') as 'anima' | 'h3'
      if (target !== 'anima' && target !== 'h3') throw new Error(`未知 target: ${target}`)
      return auditContentEnvelope({
        target,
        positive: typeof args.positive === 'string' ? args.positive : undefined,
        negative: typeof args.negative === 'string' ? args.negative : undefined,
        variant: typeof args.variant === 'string' ? args.variant : undefined,
        slots: args.slots as AnimaSlots | undefined,
        text: typeof args.text === 'string' ? args.text : undefined,
        stage: typeof args.stage === 'string' ? args.stage : undefined,
        duration: typeof args.duration === 'number' ? args.duration : undefined,
        shotCount: typeof args.shotCount === 'number' ? args.shotCount : undefined,
        references: Array.isArray(args.references) ? args.references : undefined,
      })
    },
  })
}