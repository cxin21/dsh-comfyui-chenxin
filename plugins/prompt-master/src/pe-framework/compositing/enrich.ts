/**
 * S2 语义美学扩写（spec §4，2026-09-15 管线重设计）：
 * 输入 SemanticBlueprint v0 → LLM patch（仅美学维度）→ v1。
 * patch 路径白名单（COMPOSITING_SET_ALLOWED/ADDITIONS_ALLOWED）确定性剥离越权叶；
 * 降级铁律：解析/应用失败 → v0 原样 + enrich_skipped advisory，永不抛出（不阻塞出稿）。
 */
import { buildTaskText } from '../llm/task-text.js'
import { prunePatchPaths, COMPOSITING_SET_ALLOWED, COMPOSITING_ADDITIONS_ALLOWED } from '../enrichment/engine.js'
import type { SemanticBlueprint } from '../blueprint/semantic-schema.js'

export const ENRICH_SEMANTIC_PERSONA = `角色：你是画面美学扩展引擎。输入是画面语义蓝图 v0，你的任务是把美学维度补足为 v1：
光影（光源物件与人物曝光）、色彩（主色+≤2辅色、冷暖主导）、质感、氛围粒子、构图细节。只补美学，不改语义。

【绝对禁令】
1. 不得改变 subjects 的身份/人数/服装语义、core.concept 指代——你是补光的人，不是改剧本的人。
2. 输出中不得出现任何 Danbooru tag 形式的词（snake_case、1girl、@artist、score_9 等）。
3. 不得调用任何工具；不得做词库判断。
【产出契约】只输出 deepMerge patch JSON：{"set":{...},"additions":{...}}
- set 只允许指向 core.scene.lighting_idea / composition / mood 已存在字段
- additions 只允许追加 core.style_hints / mood 细节
- 不允许新增 subjects、不允许触碰 core.concept
输出：裸 JSON patch，无 fence 无解释。`

export interface SemanticEnrichResult {
  v1: SemanticBlueprint
  advisories: string[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(target[k])) {
      deepMerge(target[k] as Record<string, unknown>, v)
    } else {
      target[k] = v
    }
  }
}

export function buildEnrichPrompt(v0: SemanticBlueprint): string {
  return buildTaskText([
    { tag: 'task_persona', body: ENRICH_SEMANTIC_PERSONA },
    { tag: 'blueprint_v0', body: JSON.stringify(v0, null, 2) },
    {
      tag: 'output_contract',
      body: '仅输出一个 deepMerge patch JSON：{"set":{...},"additions":{...}}（裸 JSON，无 fence，无解释）',
    },
  ])
}

/** patch 解析 + 白名单剥离 + deepMerge（导出供测试）；非法 JSON 抛错由 runSemanticEnrich 捕获降级 */
export function applySemanticPatch(
  v0: SemanticBlueprint,
  raw: string,
): SemanticEnrichResult {
  const braceStart = raw.indexOf('{')
  const braceEnd = raw.lastIndexOf('}')
  const body = braceStart >= 0 && braceEnd > braceStart ? raw.slice(braceStart, braceEnd + 1) : raw
  const parsed = JSON.parse(body) as Record<string, unknown>
  const set = isPlainObject(parsed['set']) ? (parsed['set'] as Record<string, unknown>) : parsed
  const additions = isPlainObject(parsed['additions']) ? (parsed['additions'] as Record<string, unknown>) : undefined
  let violations = prunePatchPaths(set, COMPOSITING_SET_ALLOWED)
  if (additions) violations += prunePatchPaths(additions, COMPOSITING_ADDITIONS_ALLOWED)
  const v1 = structuredClone(v0) as unknown as Record<string, unknown>
  deepMerge(v1, set)
  if (additions) deepMerge(v1, additions)
  const advisories = violations > 0 ? [`enrich_path_violation:${violations}`] : []
  return { v1: v1 as unknown as SemanticBlueprint, advisories }
}

export interface SemanticEnrichOpts {
  /** 子代理文本 runner（pm-enrich）；缺省（无 Agent 会话）→ enrich_skipped 降级 */
  runner?: (taskText: string) => Promise<string>
}

export async function runSemanticEnrich(v0: SemanticBlueprint, opts: SemanticEnrichOpts): Promise<SemanticEnrichResult> {
  if (!opts.runner) return { v1: v0, advisories: ['enrich_skipped:no_runner'] }
  let raw: string
  try {
    raw = await opts.runner(buildEnrichPrompt(v0))
  } catch (e) {
    return { v1: v0, advisories: [`enrich_skipped:llm:${(e as Error).message.slice(0, 120)}`] }
  }
  try {
    return applySemanticPatch(v0, raw)
  } catch (e) {
    return { v1: v0, advisories: [`enrich_skipped:parse:${(e as Error).message.slice(0, 120)}`] }
  }
}
