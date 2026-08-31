export type Target = 'anima' | 'h3' | 'sd' | 'generic'

export type Severity = 'critical' | 'important' | 'minor'

export interface AuditGate {
  rule: string            // 如 catalog_miss / cut_timestamps / soundscape_dialogue
  target: Target          // 规则所属方言
  severity: Severity
  detail: string          // 人类/模型可读说明（含修正建议）
  source?: string         // 规则来源层/文件（M4：跨层标注，如 "dialect/anima"、"audit/rules-h3"）
}

export interface Budget {
  counter: 'official-tokenizer' | 'estimate'   // 精确来源标注（A2）
  tokens: number
  max?: number
  over: boolean
}

export interface AuditReport {
  passed: boolean          // 无 critical gates 即 true
  gates: AuditGate[]
  budget?: Budget
  assumptions: string[]    // 非阻断但模型需知晓（含 catalog_miss 等）
  advisories: string[]     // 原样展示给用户，不改写
}

/** StageIO 分层变体（M3 处置——扁平 bag 提升为分层） */
export interface IntentIO { target: Target; text: string; profile?: string }
export interface SchemaIO { target: Target; slots?: Record<string, string[]>; shots?: unknown[]; sceneId?: string; formFields?: Record<string, unknown> }
export interface DialectIO { target: Target; positive?: string; negative?: string; text?: string; textZh?: string }
export interface AuditIO { target: Target; report: AuditReport }
export interface RenderIO { target: Target; payload: string; targetSlotHint?: string }   // targetSlotHint 如 "t2i.prompt"/"t2v.prompt"