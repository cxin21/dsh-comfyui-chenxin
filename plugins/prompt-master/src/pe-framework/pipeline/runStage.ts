import { getDialect } from '../dialect/registry.js'
import type { AuditGate, Budget } from '../types.js'
import { targetSlotHint } from '../render/envelope.js'
import type { PipelineInput, PipelineTrace, StageResult } from './types.js'

/**
 * 唯一管线内核：按注册表调度，零目标业务分支、零日志。
 * normalize error / auditOnly 不兼容 → throw（可读错误）；方言未注册 → 失败 StageResult。
 */
export function runStage(input: PipelineInput): StageResult {
  const d = getDialect(input.target)
  if (!d) {
    const gate: AuditGate = {
      rule: 'dialect_not_available',
      target: input.target,
      severity: 'critical',
      detail: `方言 ${input.target} 未注册（请以 registerDialect 装配）`,
      source: 'pipeline/runStage',
    }
    return {
      ok: false,
      result: {},
      gates: [gate],
      advisories: [],
      assumptions: [],
      targetSlotHint: targetSlotHint(input.target),
    }
  }

  const t0 = performance.now()
  const auditOnly = input.auditOnly === true
  if (auditOnly && !d.auditOnlyOk) {
    throw new Error(`target ${input.target} 不支持 auditOnly`)
  }

  const normalized = d.normalize(
    { target: input.target, slots: input.slots, variant: input.variant, shots: input.shots, stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields, auditOnly },
    { stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields },
  )
  const tSchema = performance.now()
  if (normalized.error !== undefined) throw new Error(normalized.error)
  const slots = normalized.value

  const compiled = d.compile(slots as never, { variant: input.variant, stage: input.stage })
  const tDialect = performance.now()

  const audit = d.audit(compiled as never, { stage: input.stage, references: normalized.references, shots: input.shots, variant: input.variant })
  const tAudit = performance.now()

  const budgetRaw = d.budget?.(compiled as never, { stage: input.stage, references: normalized.references })
  const tBudget = performance.now()

  const ok = audit.gates.every((g) => g.severity !== 'critical')
  const result: Record<string, unknown> = auditOnly ? {} : (compiled as Record<string, unknown>)

  const renderMs = 0
  const stages: PipelineTrace['stages'] = [
    { name: 'schema', ms: tSchema - t0 },
    { name: 'dialect', ms: tDialect - tSchema },
    { name: 'audit', ms: tAudit - tDialect },
    ...(budgetRaw !== undefined ? [{ name: 'budget' as const, ms: tBudget - tAudit }] : []),
    { name: 'render', ms: renderMs },
  ]
  const trace: PipelineTrace = { stages }

  return {
    ok,
    result,
    gates: audit.gates,
    advisories: [],
    assumptions: audit.assumptions ?? [],
    ...(budgetRaw !== undefined ? { budget: budgetRaw as Budget } : {}),
    targetSlotHint: d.targetSlotHint,
    trace,
  }
}
