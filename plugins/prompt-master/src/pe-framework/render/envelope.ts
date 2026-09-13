import type { AuditReport } from '../types.js'
import { serializeReport } from '../audit/report.js'
import type { StageResult } from '../pipeline/types.js'

/** target → 默认 slot 提示；方言自带 targetSlotHint 时优先使用方言值 */
export function targetSlotHint(target: string): string {
  if (target === 'h3') return 't2v.prompt'
  if (target === 'anima') return 't2i.prompt'
  return 'generic.prompt'
}

export type NextAction = 'retry_input' | 'auto_repair' | 'manual' | 'advisory_only' | 'ok'

export interface RepairHint {
  field: string
  fix: string
}

/** critical 契约闸门（spec §11：retry_input 可自动归因的确定性规则集） */
const CONTRACT_GATE_RULES = new Set([
  'max_shots',
  'parse_request',
  'duration_range',
  'ref_count',
  'field_order',
  'cut_timestamps',
  'char_budget',
])

/**
 * 失败语义判定（计划 Task 3 修正版，消除死分支）：
 * - stage.ok 且无 advisories → 'ok'
 * - stage.ok 但有 advisories → 'advisory_only'
 * - 非 ok 且 opts.repaired === true（引擎 Level 1/2 已实际修复过）→ 'auto_repair'
 * - 非 ok 且有 loop_exhausted:true advisory → 'manual'
 * - 非 ok 含 critical 契约闸门 → 'retry_input'（调用方附 repair_hints）
 * - 其余非 ok → 'manual'（无法自动归因）
 */
export function computeNextAction(
  stage: StageResult,
  opts?: { repairHints?: RepairHint[]; repaired?: boolean },
): NextAction {
  if (stage.ok) {
    return stage.advisories.length > 0 ? 'advisory_only' : 'ok'
  }
  if (opts?.repaired === true) return 'auto_repair'
  if (stage.advisories.some((a) => a.includes('loop_exhausted'))) return 'manual'
  if (stage.gates.some((g) => g.severity === 'critical' && CONTRACT_GATE_RULES.has(g.rule))) {
    return 'retry_input'
  }
  return 'manual'
}

/**
 * P1 Envelope 唯一组装点（Task 4 定案：audit 收敛为 legacy 形状 {passed, gates, budget?}；
 * assumptions/advisories 不再入 audit 对象——顶层 advisories 是唯一读取点）：
 * { ok, ...(ok ? {result} : {}), audit:{passed, gates, ...(budget?{budget}:{})}, assumptions:[...stage.assumptions], advisories:[...stage.advisories, ...trail], target_slot_hint }
 * Task 3（spec §11）：顶层加 next_action 与可选 repair_hints（由调用方传 computeNextAction 的结果，repaired 由 Level 1/2 实际修复后置 true）。
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
  /** Task 10 蓝图管线：美学扩展记录（§7.1 改写/自检 advisory） */
  expansions?: string[]
  /** Task 10 蓝图管线：Level 1/2 修复记录（如 duration_3→4） */
  repairs?: string[]
  /** F5（三期 Task 4）：canonical 替换计数——独立新字段，不与 corrections（修正闭环轮次）混淆 */
  canonicalSubstitutions?: number
  /** F5：canonical 替换对（`原片段→新tag`，来自 compile result T1 字段）；无替换为空数组 */
  substitutions?: string[]
  /** A6（外部基准 2026-09）：design_notes 设计说明投影（anima segments 槽位汇总，零 LLM） */
  designNotes?: string[]
  /**
   * M5-T2（D4/D9，design §2.4 envelope 增量①）：默认路径蓝图形态痕迹（T1R 验收草案「envelope
   * 出现 blueprint 痕迹」载体）。仅蓝图载体出现（runEnrich 跳过/修复轮锚定/落库计数一屏可见）；
   * slots 形态（含 rollback）不产出该字段。F2：顶层条件键 blueprint_id（落库成功时）由编排层装配，
   * 不在本接口。
   */
  blueprint?: {
    form: 'blueprint' | 'slots'
    media?: string
    missing_count?: number
    expansions_count?: number
    repairs_count?: number
    anchor_rounds?: number
  }
}

export interface EnvelopeNextAction {
  next_action: NextAction
  repair_hints?: RepairHint[]
}

export function assembleEnvelope(
  stage: StageResult,
  trail?: string[],
  observability?: EnvelopeObservability,
  dialectTopLevel?: Record<string, unknown>,
  nextAction?: EnvelopeNextAction,
): string {
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
    // Task 3：next_action / repair_hints 透传（调用方 computeNextAction 结果；字段顺序保持稳定）
    ...(nextAction !== undefined ? nextAction : {}),
    ...(observability !== undefined ? { observability } : {}),
    // G2：方言顶层投影（如 anima phase_status）最后合并——方言键不被基础键覆盖，h3 不传则无变化
    ...(dialectTopLevel ?? {}),
  }
  return serializeReport(envelope as unknown as AuditReport)
}
