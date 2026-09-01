import type { AuditReport } from '../types.js'
import { serializeReport } from '../audit/report.js'
import type { StageResult } from '../pipeline/types.js'

/** target → 默认 slot 提示；方言自带 targetSlotHint 时优先使用方言值 */
export function targetSlotHint(target: string): string {
  if (target === 'h3') return 't2v.prompt'
  if (target === 'anima') return 't2i.prompt'
  return 'generic.prompt'
}

/**
 * P1 Envelope 唯一组装点（Task 4 定案：audit 收敛为 legacy 形状 {passed, gates, budget?}；
 * assumptions/advisories 不再入 audit 对象——顶层 advisories 是唯一读取点）：
 * { ok, ...(ok ? {result} : {}), audit:{passed, gates, ...(budget?{budget}:{})}, assumptions:[...stage.assumptions], advisories:[...stage.advisories, ...trail], target_slot_hint }
 */
export interface EnvelopeObservability {
  corrections?: number
  loopExhausted?: boolean
  joyExtraFiltered?: boolean
  sanitizeChanged?: boolean
  continueRounds?: number
  continueWarnings?: string[]
  /** 各管线阶段耗时（ms）；内核 trace 摘要，供 GUI/模型可见性 */
  traceStages?: Array<{ name: string; ms: number }>
}

export function assembleEnvelope(stage: StageResult, trail?: string[], observability?: EnvelopeObservability): string {
  const audit = {
    passed: stage.ok,
    gates: stage.gates,
    ...(stage.budget !== undefined ? { budget: stage.budget } : {}),
  }
  const envelope: Record<string, unknown> = {
    ok: stage.ok,
    ...(stage.ok ? { result: stage.result } : {}),
    audit,
    assumptions: stage.assumptions,
    advisories: [...stage.advisories, ...(trail ?? [])],
    target_slot_hint: stage.targetSlotHint,
    ...(observability !== undefined ? { observability } : {}),
  }
  return serializeReport(envelope as unknown as AuditReport)
}
