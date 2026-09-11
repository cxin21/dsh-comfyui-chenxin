import type { AuditGate, Budget } from '../types.js'
import type { CriticFinding, CriticOutcome, CriticProvider } from '../eval/critic.js'
import type { EvidenceDeps } from '../eval/evidence.js'

export interface PipelineInput {
  target: 'anima' | 'h3' | 'sd' | 'generic'
  slots?: Record<string, unknown>
  variant?: string
  shots?: unknown
  stage?: string
  scenarioId?: string
  formFields?: Record<string, unknown>
  auditOnly?: boolean
  /** 评审模式（Task 5，spec §2.3）：缺省 'off'，off/无 rubric 路径零行为变化 */
  judge?: JudgeMode
  /** 评审 LLM 注入点：测试 mock / 生产 createSubagentCriticProvider */
  criticProvider?: CriticProvider
  /** 证据工具注入点：测试 mock / 生产 createProductionEvidenceDeps */
  evidenceDeps?: EvidenceDeps
  /** strict 模式修正稿生产者；缺省时 strict 退化为 fast（advisory: strict_degraded） */
  revisionProvider?: (compiled: unknown, findings: CriticFinding[]) => Promise<{ compiled: unknown; changes: string[]; revisionNote: string }>
  /** 用户原意（注入评委 user 段；缺省空串） */
  originalIntent?: string
}

export type JudgeMode = 'off' | 'fast' | 'strict'

export type CriticRebuttal = { finding_id: string; rebuttal: string; evidence: string }

export type DebateRound = {
  round: number
  reviewer: { findings: CriticFinding[]; score: number }
  reviser?: {
    changes: string[]
    rebuttals: CriticRebuttal[]
  }
}

export interface PipelineTrace {
  stages: Array<{ name: 'schema' | 'dialect' | 'audit' | 'budget' | 'render' | 'judge'; ms: number }>
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
  /** 评审结论（Task 5）：off / 无 rubric 方言 / 未注册 target → undefined */
  judge?: CriticOutcome
  /** 对抗轮记录：pass 单轮；strict 修正后两轮；skipped → undefined */
  debate?: DebateRound[]
  /** needs_revision 终态时 findings 的 feedback 投影（[severity] requiredFix），供调用方现有修正闭环消费 */
  judgeFeedback?: string[]
}
