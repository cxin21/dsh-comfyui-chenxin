/**
 * S5 修复 LLM（spec 2026-09-17 agentic-pipeline-redesign §5，A4）：
 * 独立于成文引擎的专一角色——对着违规清单（机器 gates + 审计 findings）改稿，
 * 工具查字典验证新 tag，最小改动原则，蓝图语义冻结。输出契约与 WriterOutput 一致。
 */
import { buildTaskText } from '../llm/task-text.js'
import type { WriterOutput } from './writer.js'
import type { SemanticBlueprint } from '../blueprint/semantic-schema.js'
import { parseWriterOutput } from './writer.js'

export const REPAIRER_PERSONA = `角色：你是 Anima 提示词修复引擎。输入 = 画面语义蓝图 v1 + 当前成文产物 + 违规清单
（机器审计 gates + 审计引擎 findings）。你有一个工具：catalog_search（tag 字典查询）。
你产出一份修复后的完整成文产物（输出契约与成文引擎完全一致）。

【修复纪律】
R1. 逐条执行违规清单中的 requiredFix；未被点名的部分保持原样（最小改动原则）。
R2. 新引入/替换的 tag 必须先用 catalog_search 验证 canonical/alias；查不到 → 改写进 NL 尾，不得硬造。
R3. 蓝图语义冻结：不得改变主体身份/人数/构图语义——你是对着质检单改稿的人，不是改剧本的人。
R4. 修复后自检一遍机器门会查的项：tag 数 20-40、无重复、T3 顺序（人数→身份→artist→外观→动作→表情→景别→场景→氛围）、NL 2-4 句、无光效词、negative 无质量词/分级词。
R5. 违规清单无法在不违反 R3 的前提下满足时，如实输出当前最优解（宁缺毋滥，禁止编造凑数）。`

export interface RepairInput {
  bp: SemanticBlueprint
  draft: WriterOutput
  /** 机器审计 gates 文本（rule/severity/detail） */
  gateViolations: string[]
  /** 审计 LLM findings 文本（[severity] requiredFix） */
  auditorFindings: string[]
}

export function buildRepairPrompt(input: RepairInput): string {
  const violations = [
    ...(input.gateViolations.length > 0 ? ['【机器审计 gates】', ...input.gateViolations.map((g) => `- ${g}`)] : []),
    ...(input.auditorFindings.length > 0 ? ['【审计引擎 findings】', ...input.auditorFindings.map((f) => `- ${f}`)] : []),
  ].join('\n')
  return buildTaskText([
    { tag: 'task_persona', body: REPAIRER_PERSONA },
    { tag: 'blueprint_v1', body: JSON.stringify(input.bp, null, 2) },
    { tag: 'response', body: JSON.stringify(input.draft, null, 2) },
    { tag: 'violations', body: violations || '（无违规——正常不应发生，输出等价产物）' },
    {
      tag: 'output_contract',
      body: '仅输出一个 JSON 对象：{"tags":[{"text":"…","source_concept":"…"}…],"nl":"…","negative":["…"]}。裸 JSON，无 fence，无解释。',
    },
  ])
}

/** 修复产物解析：契约与 WriterOutput 完全一致（复用 parseWriterOutput） */
export function parseRepairOutput(raw: string): WriterOutput {
  return parseWriterOutput(raw)
}
