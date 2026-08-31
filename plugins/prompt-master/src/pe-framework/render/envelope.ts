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
 * P1 Envelope 唯一组装点：
 * { ok, ...(ok ? {result} : {}), audit:{passed, gates, ...(budget?{budget}:{})}, advisories:[...stage.advisories, ...trail], target_slot_hint }
 */
export function assembleEnvelope(stage: StageResult, trail?: string[]): string {
  const audit: AuditReport = {
    passed: stage.ok,
    gates: stage.gates,
    ...(stage.budget !== undefined ? { budget: stage.budget } : {}),
    assumptions: stage.assumptions,
    advisories: [...stage.advisories, ...(trail ?? [])],
  }
  const envelope: Record<string, unknown> = {
    ok: stage.ok,
    ...(stage.ok ? { result: stage.result } : {}),
    audit,
    advisories: audit.advisories,
    target_slot_hint: stage.targetSlotHint,
  }
  return serializeReport(envelope as unknown as AuditReport)
}
