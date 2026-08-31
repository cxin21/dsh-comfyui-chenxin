import type { AuditGate, Budget } from '../types.js'

export interface PipelineInput {
  target: 'anima' | 'h3' | 'sd' | 'generic'
  slots?: Record<string, unknown>
  variant?: string
  shots?: unknown
  stage?: string
  scenarioId?: string
  formFields?: Record<string, unknown>
  auditOnly?: boolean
}

export interface PipelineTrace {
  stages: Array<{ name: 'schema' | 'dialect' | 'audit' | 'budget' | 'render'; ms: number }>
  catalogHits?: number
  tokenCounter?: 'official-tokenizer' | 'estimate'
  references?: number
}

export interface StageResult {
  ok: boolean
  result: Record<string, unknown>
  gates: AuditGate[]
  advisories: string[]
  assumptions: string[]
  budget?: Budget
  targetSlotHint: string
  trace?: PipelineTrace
}
