import type { AuditGate, AuditReport, Budget } from '../types.js'

export interface BuildReportInput {
  gates?: AuditGate[]
  budget?: Budget
  assumptions?: string[]
  advisories?: string[]
}

export function buildAuditReport(input: BuildReportInput): AuditReport {
  const gates = input.gates ?? []
  return {
    passed: !gates.some((g) => g.severity === 'critical'),
    gates,
    budget: input.budget,
    assumptions: input.assumptions ?? [],
    advisories: input.advisories ?? [],
  }
}

export function isFatal(gate: AuditGate): boolean {
  return gate.severity === 'critical'
}

/** 稳定序列化（字段顺序固定，供工具返回 JSON 字符串） */
export function serializeReport(report: AuditReport): string {
  return JSON.stringify(report)
}