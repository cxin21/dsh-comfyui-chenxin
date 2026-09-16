/**
 * S2 语义美学扩写（spec §4，2026-09-15 管线重设计）：
 * 输入 SemanticBlueprint v0 → LLM patch（仅美学维度）→ v1。
 * patch 路径白名单（COMPOSITING_SET_ALLOWED/ADDITIONS_ALLOWED）确定性剥离越权叶；
 * 降级铁律：解析/应用失败 → v0 原样 + enrich_skipped advisory，永不抛出（不阻塞出稿）。
 */
import { buildTaskText } from '../llm/task-text.js'
import { extractFirstJsonObject } from '../llm/json-extract.js'
import { prunePatchPaths, COMPOSITING_SET_ALLOWED, COMPOSITING_ADDITIONS_ALLOWED } from '../enrichment/engine.js'
import type { SemanticBlueprint } from '../blueprint/semantic-schema.js'

export const ENRICH_SEMANTIC_PERSONA = `角色：你是画面美学扩展引擎。输入是画面语义蓝图 v0，你的任务是把美学维度补足为 v1：
光影（光源物件与人物曝光）、色彩（主色+≤2辅色、冷暖主导）、质感、氛围粒子、构图细节。只补美学，不改语义。

【绝对禁令】
1. 不得改变 subjects 的身份/人数/服装语义、core.concept 指代——你是补光的人，不是改剧本的人。
2. 输出中不得出现任何 Danbooru tag 形式的词（snake_case、1girl、@artist、score_9 等）。
3. 不得调用任何工具；不得做词库判断。

【美学扩展清单（逐维度自查后再输出）】
- 光影：光源写成场景物件（lantern/corridor/moonless sky glow），并写明人物曝光（face clearly exposed / no silhouette）
- 色彩：一个主色 + ≤2 辅色，写明冷暖谁主导（如 warm amber dominant against cool blue dusk）
- 质感/氛围：材质词 + 粒子词各 ≤2（mist/dust/petals）
- 构图细节：视线引导/前景层次（不与已有 composition 字段重复）

【信息密度基准（few-shot——patch 的粒度即目标形态）】
输入 v0.mood = "nocturnal" →
{"set":{"mood":"nocturnal with quiet tension","composition":{"placement":"right third, stone steps leading lines behind"}},"additions":{"core":{"style_hints":["flat cel shading with muted palette"]}}}
（只补美学语义，不出现任何词库拼写）`

export interface SemanticEnrichResult {
  v1: SemanticBlueprint
  advisories: string[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A7 类型守卫：写入值与目标字段类型一致才放行（目标未定义视为新字段，放行） */
function typeOk(tv: unknown, v: unknown): boolean {
  if (tv === undefined) return true
  if (Array.isArray(v)) return Array.isArray(tv)
  if (Array.isArray(tv)) return false
  if (isPlainObject(v) !== isPlainObject(tv)) return false
  return typeof v === typeof tv
}

function deepMergeChecked(target: Record<string, unknown>, patch: Record<string, unknown>): number {
  let violations = 0
  for (const [k, v] of Object.entries(patch)) {
    const tv = target[k]
    if (isPlainObject(v) && isPlainObject(tv)) {
      violations += deepMergeChecked(tv as Record<string, unknown>, v)
    } else if (!typeOk(tv, v)) {
      violations++ // A7：类型不匹配确定性丢弃（run1 崩溃根因：对象覆写字符串 mood）
    } else {
      target[k] = v
    }
  }
  return violations
}

/**
 * A7（spec 2026-09-17 agentic-pipeline-redesign）：patch 值类型校验——目标字段类型必须与
 * 写入值类型一致。活跑实证（会话 158642b0 run1）：enrich 输出 additions.core.mood = 对象
 * {palette,texture,particles}，旧 mergeAdditions 的 else 分支让对象直接覆写字符串 mood →
 * S2.5 `bp.mood.trim()` TypeError → 整个 prompt_author 硬崩。现：字符串字段禁对象/数组写入、
 * 数组字段禁非数组写入、对象字段禁标量写入——违规**确定性丢弃**并计数（enrich_type_violation）。
 * 返回违规计数（0 = 无）。
 */
function mergeAdditionsChecked(target: Record<string, unknown>, additions: Record<string, unknown>): number {
  let violations = 0
  const walk = (t: Record<string, unknown>, p: Record<string, unknown>): void => {
    for (const [k, v] of Object.entries(p)) {
      const tv = t[k]
      if (Array.isArray(v)) {
        if (tv !== undefined && !Array.isArray(tv)) {
          violations++ // 数组字段禁非数组写入
          continue
        }
        const base = Array.isArray(tv) ? (tv as unknown[]) : []
        t[k] = [...base, ...v.filter((x) => !base.some((b) => JSON.stringify(b) === JSON.stringify(x)))]
      } else if (typeof v === 'string') {
        if (tv !== undefined && typeof tv !== 'string' && !Array.isArray(tv)) {
          violations++ // 标量写入非标量字段
          continue
        }
        if (typeof tv === 'string') {
          t[k] = tv.toLowerCase().includes(v.toLowerCase()) ? tv : `${tv}, ${v}`
        } else {
          t[k] = v
        }
      } else if (isPlainObject(v)) {
        if (tv !== undefined && !isPlainObject(tv)) {
          violations++ // 对象写入非对象字段（run1 崩溃根因：对象覆写字符串 mood）
          continue
        }
        if (!isPlainObject(tv)) t[k] = {}
        walk(t[k] as Record<string, unknown>, v)
      } else {
        violations++ // 其他标量：仅允许写入 undefined 或同型标量字段
        continue
      }
    }
  }
  walk(target, additions)
  return violations
}

/**
 * additions 追加语义（spec §4「additions 只允许追加」——自我复审发现：deepMerge 对数组是
 * 整体替换，会把 V0 已有的 style_hints 清掉，与"追加细节"契约相反）：
 * - 数组：concat 去重（保留 V0 原项，追加新项）
 * - 字符串（mood 细节）：未包含才以 ", " 追加（防重复描述）
 * - 其余（嵌套对象）：递归同规则
 * A7：值类型不匹配的写入确定性丢弃（见 mergeAdditionsChecked）。
 */
const mergeAdditions = mergeAdditionsChecked

export function buildEnrichPrompt(v0: SemanticBlueprint): string {
  return buildTaskText([
    { tag: 'task_persona', body: ENRICH_SEMANTIC_PERSONA },
    { tag: 'blueprint_v0', body: JSON.stringify(v0, null, 2) },
    {
      tag: 'rules',
      body: [
        '【patch 路径白名单（硬性，越权路径会被系统确定性剥离并计数）】',
        '- set 仅允许指向：core.scene.lighting_idea / composition（各子字段）/ mood',
        '- additions 仅允许追加：core.style_hints / mood 细节',
        '- 不允许新增 subjects、不允许触碰 core.concept',
      ].join('\n'),
    },
    {
      tag: 'output_contract',
      body: [
        '仅输出一个 JSON 对象（裸 JSON：无 markdown fence、无解释、无任何前后缀文字）：',
        '{"set":{"core":{"scene":{"lighting_idea":"…"}},"composition":{"placement":"…"},"mood":"…"},"additions":{"core":{"style_hints":["…"]}}}',
        'set/additions 块按需省略；本任务为 one-shot 结构产出：不要调用任何工具',
      ].join('\n'),
    },
  ])
}

/** patch 解析 + 白名单剥离 + set 深合并 + additions 追加（导出供测试）；非法 JSON 抛错由 runSemanticEnrich 捕获降级 */
export function applySemanticPatch(
  v0: SemanticBlueprint,
  raw: string,
): SemanticEnrichResult {
  // 2026-09-16 活跑实证（gen_1789522875279）：LLM 在 JSON 后追加说明文字 → 首{到尾}切片跨界
  // parse 失败 → 扩写整轮被跳过。统一改用平衡花括号扫描（截取第一个完整 JSON 对象）。
  const body = extractFirstJsonObject(raw)
  const parsed = JSON.parse(body) as Record<string, unknown>
  const set = isPlainObject(parsed['set']) ? (parsed['set'] as Record<string, unknown>) : parsed
  const additions = isPlainObject(parsed['additions']) ? (parsed['additions'] as Record<string, unknown>) : undefined
  let pathViolations = prunePatchPaths(set, COMPOSITING_SET_ALLOWED)
  if (additions) pathViolations += prunePatchPaths(additions, COMPOSITING_ADDITIONS_ALLOWED)
  const v1 = structuredClone(v0) as unknown as Record<string, unknown>
  let typeViolations = deepMergeChecked(v1, set)
  if (additions) typeViolations += mergeAdditionsChecked(v1, additions) // 追加语义（数组 concat 去重 / 字符串增量），非覆盖
  const advisories: string[] = []
  if (pathViolations > 0) advisories.push(`enrich_path_violation:${pathViolations}`)
  if (typeViolations > 0) advisories.push(`enrich_type_violation:${typeViolations}`)
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
