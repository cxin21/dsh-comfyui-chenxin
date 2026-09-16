/**
 * S5 修复 LLM（spec 2026-09-17 agentic-pipeline-redesign §5，A4）：
 * 独立于成文引擎的专一角色——对着违规清单（机器 gates + 审计 findings）改稿，
 * 工具查字典验证新 tag，最小改动原则，蓝图语义冻结。输出契约与 WriterOutput 一致。
 */
import { buildTaskText } from '../llm/task-text.js';
import type { WriterOutput } from './writer.js';
import type { SemanticBlueprint } from '../blueprint/semantic-schema.js';
import { parseWriterOutput } from './writer.js';

export const REPAIRER_PERSONA = `角色：你是 Anima 提示词修复引擎。输入 = 画面语义蓝图 v1 + 当前成文产物 + 违规清单
（机器审计 gates + 审计引擎 findings）。你有一个工具：catalog_search（tag 字典查询）。
你产出一份修复后的完整成文产物（输出契约与成文引擎完全一致）。

【工具协议】
- 新引入/替换的 tag 先调用 catalog_search（{"tag":"<英文短语>","mode":"auto","limit":5}）验证：
  只采用 hits[] 中 canonical/alias 的 prompt_form 原样。
- 查不到时换更简单的英文说法再试一次；仍查不到 → 该概念改写进 NL 尾，不得硬造 tag。
- 工具调用预算 ≤15 次；未被违规清单点名的 tag 无需重复验证。

【修复纪律】
R1. 逐条执行违规清单中的 requiredFix；未被点名的部分保持原样（最小改动原则）。
R2. 新引入/替换的 tag 必须先经工具验证 canonical/alias；查不到 → 改写进 NL 尾，不得硬造。
R3. 蓝图语义冻结：不得改变主体身份/人数/构图语义——你是对着质检单改稿的人，不是改剧本的人。
R4. 修复后自检一遍机器门会查的项：tag 数 20-40、无重复、T3 顺序（人数→身份→artist→外观→动作→表情→景别→场景→氛围）、NL 2-4 句、无光效词、negative 无质量词/分级词。
R5. 违规清单无法在不违反 R3 的前提下满足时，如实输出当前最优解（宁缺毋滥，禁止编造凑数）。

【信息密度基准（few-shot——最小改动原则的目标形态）】
例（违规：tag 'long hair' 与 'hair over shoulder' 近义重复；NL 复述 tag 'night'）：
violations：duplicate... near-duplicate long hair + hair over shoulder / NL restates tag night
修复输出（只动被点名的两处，其余逐字保留）：
{"tags":[{"text":"1girl","source_concept":"S1.count"},{"text":"solo","source_concept":"S1.count"},{"text":"long hair","source_concept":"S1.appearance"},{"text":"black leather jacket","source_concept":"S1.appearance"},{"text":"looking back","source_concept":"S1.pose"}],"nl":"She stands on the rain-wet street while signboard glow from both sides keeps her face clearly exposed with no silhouette.","negative":[]}
（删 'hair over shoulder'；NL 的夜景改写为 signboard 光源物件句——tag 'night' 不再被复述）`;

export interface RepairInput {
  bp: SemanticBlueprint;
  draft: WriterOutput;
  /** 机器审计 gates 文本（rule/severity/detail） */
  gateViolations: string[];
  /** 审计 LLM findings 文本（[severity] requiredFix） */
  auditorFindings: string[];
}

export function buildRepairPrompt(input: RepairInput): string {
  const violations = [
    ...(input.gateViolations.length > 0 ? ['【机器审计 gates】', ...input.gateViolations.map((g) => `- ${g}`)] : []),
    ...(input.auditorFindings.length > 0
      ? ['【审计引擎 findings】', ...input.auditorFindings.map((f) => `- ${f}`)]
      : []),
  ].join('\n');
  return buildTaskText([
    { tag: 'task_persona', body: REPAIRER_PERSONA },
    { tag: 'blueprint_v1', body: JSON.stringify(input.bp, null, 2) },
    { tag: 'response', body: JSON.stringify(input.draft, null, 2) },
    { tag: 'violations', body: violations || '（无违规——正常不应发生，输出等价产物）' },
    {
      tag: 'output_contract',
      body: [
        '仅输出一个 JSON 对象（裸 JSON：无 markdown fence、无解释、无任何前后缀文字）：',
        '{"tags":[{"text":"…","source_concept":"…"}…],"nl":"…2-4 句英文…","negative":["…"]}',
      ].join('\n'),
    },
  ]);
}

/** 修复产物解析：契约与 WriterOutput 完全一致（复用 parseWriterOutput） */
export function parseRepairOutput(raw: string): WriterOutput {
  return parseWriterOutput(raw);
}
