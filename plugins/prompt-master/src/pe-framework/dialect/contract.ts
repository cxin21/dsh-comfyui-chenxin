import type { AuditGate, Target } from '../types.js'
import type { Reference } from '../schema/h3-shots.js'

export type { Target }

export interface PipelineInputLike {
  target: Target
  slots?: unknown
  variant?: string
  shots?: unknown
  stage?: string
  scenarioId?: string
  formFields?: Record<string, unknown>
  auditOnly?: boolean
}

export interface DialectContract<TSlots = unknown, TCompiled = unknown> {
  id: Target
  label: string
  auditOnlyOk: boolean
  normalize(input: PipelineInputLike, opts: { stage?: string; scenarioId?: string; formFields?: unknown }): {
    error?: string
    value?: TSlots
    stage?: string
    references?: Reference[]
  }
  compile(slots: TSlots, opts: { variant?: string; stage?: string }): TCompiled
  audit(compiled: TCompiled, ctx: { stage?: string; references?: Reference[]; shots?: unknown; variant?: string }): { gates: AuditGate[]; assumptions?: string[] }
  budget?(compiled: TCompiled, opts: { stage?: string; references?: Reference[] }): unknown
  targetSlotHint: string
  intent?: { persona: string; schema: string }
}
