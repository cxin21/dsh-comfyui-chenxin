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

/* ── 方言包声明（spec §9）：DialectContract 升级，可选字段由方言注册时挂载 ── */

export interface DialectCapabilities {
  native_negative: boolean       // 有无独立负向框
  supports_audio: boolean        // 音频/台词语法
  supports_dialogue: boolean
  camera_axes: number            // 运镜轴数
  media_targets: Array<'image' | 'video' | 'mixed'>
  aspect_ratios: string[]
  duration_range: [number, number]  // 秒
  max_shots_formula?: string     // 如 '1 + floor((duration - 1) / 3)'
  max_prompt_chars: number
  budget_quality_cap: number     // 每 stage token 上限
}

export interface DialectConstraintInput {
  stage: string
  shots: { duration_seconds: number; shots: unknown[] }
  refs?: unknown[]
}

export interface DialectConstraints {
  validate(input: DialectConstraintInput): AuditGate[]   // preflight 用确定性约束表
}

export interface DialectAesthetics {
  forbidden_words: string[]
  few_shot_examples: Array<{ input: string; output: string }>
  style_hints: string[]
}

export interface DialectLicense {
  id: string
  url: string
  territory_restrictions?: string
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
  compile(slots: TSlots, opts: { variant?: string; stage?: string; depth?: 'quick' | 'director' }): TCompiled
  audit(compiled: TCompiled, ctx: { stage?: string; references?: Reference[]; shots?: unknown; variant?: string }): { gates: AuditGate[]; assumptions?: string[] }
  budget?(compiled: TCompiled, opts: { stage?: string; references?: Reference[]; depth?: 'quick' | 'director' }): unknown
  targetSlotHint: string
  intent?: { persona: string; schema: string }
  /** 方言包声明（spec §9）：capabilities/constraints/aesthetics 为包必需；license 可选 */
  capabilities?: DialectCapabilities
  constraints?: DialectConstraints
  aesthetics?: DialectAesthetics
  rubric?: import('../eval/rubrics/contract.js').DialectRubric
  license?: DialectLicense
}
