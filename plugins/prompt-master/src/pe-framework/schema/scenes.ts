/**
 * PM 10 场景 → H3 shots 映射（resolver 只读引入，不修改）。
 * 来源：src/resolver/minimax/catalog.ts（MINIMAX_SCENARIOS 定义）+ assemble.ts（normalizeForm 语义）。
 * 语义：把场景表单字段（subject/场景要素）确定性翻译为 H3ShotsInput 的 shots/what/ambient/music/dialogue + duration；
 * full_reference 走 ref2va（六段式）默认 stage（compile 层按场景路由）。
 * 不受支持/缺内容字段 → null（调用方报场景映射不可用）。
 */
import { MINIMAX_SCENARIOS, getScenarioById, type MiniMaxScenario } from '../../resolver/minimax/catalog.js'
import { normalizeForm } from '../../resolver/minimax/assemble.js'
import type { H3ShotsInput, H3Shot } from './h3-shots.js'
import type { AuditGate } from '../types.js'
import type { OutputContract } from '../continue/contract.js'

/**
 * T14 Task 3：场景输出契约（声明制——契约只在场景条目声明时生效）。
 * full_reference 六段 fields 的 patterns 与 dialect/h3.ts buildRef2vaText 实际发出的
 * 英文段名逐字对齐：subject_definitions / summary / retention_analysis /
 * detailed_description / overall_soundscape / non_diegetic_music。
 * director_segments 为分组形态：分隔符 + 期望组数（按表单 segment_count 推导）。
 */
export const SCENE_OUTPUT_CONTRACTS: Record<string, OutputContract> = {
  full_reference: {
    id: 'minimax-full-reference',
    fields: [
      { key: 'subject_definitions', patterns: [/subject_definitions\s*[:：]/i] },
      { key: 'summary', patterns: [/summary\s*[:：]/i, /摘要\s*[:：]/] },
      { key: 'retention_analysis', patterns: [/retention_analysis\s*[:：]/i] },
      { key: 'detailed_description', patterns: [/detailed_description\s*[:：]/i] },
      { key: 'overall_soundscape', patterns: [/overall_soundscape\s*[:：]/i] },
      { key: 'non_diegetic_music', patterns: [/non_diegetic_music\s*[:：]/i] },
    ],
  },
  director_segments: {
    id: 'minimax-director-segments',
    fields: [],
    groupSeparator: /={3,}\s*提示词组\s*(\d+)\s*={3,}/,
    expectedGroups: (ff) => Number(ff?.['segment_count'] ?? 4),
  },
}

/**
 * 场景 → 输出契约解析：六段式 ref2va 契约只按场景 id 匹配——product_ad / brand_promo
 * 虽然也是 outputMode 'full_reference'，但 pickStage 把它们路由到 t2va（三字段体），
 * 永远不会出现六个 ref2va 段名 → 按 mode 兜底会导致无限续写轮。
 * director_segments 按 mode 兜底安全：catalog 里只有 continuous_story 用它。
 */
export function sceneOutputContract(scenarioId: string, outputMode?: string): OutputContract | undefined {
  const byId = SCENE_OUTPUT_CONTRACTS[scenarioId]
  if (byId) return byId
  if (outputMode === 'director_segments') return SCENE_OUTPUT_CONTRACTS['director_segments']
  return undefined
}

export interface SceneMap {
  scenarioId: string
  toShots(scenarioId: string, formFields: Record<string, unknown>, lang?: string): H3ShotsInput | null
}

const META_KEYS = [
  'duration_seconds', 'duration', 'seconds', '时长',
  'aspect_ratio', 'expand_mode', 'output_lang', 'prompt_language',
  'plan_mode', 'segment_count', 'segment_seconds', 'prompt_kind', 'copy_mode',
  'references', 'media_paths', 'mediaPaths',
]
const WHAT_KEYS = [
  'subject', 'what', 'content', 'description', 'scene_description', 'main_content',
  'text', 'body', 'story', 'beat', 'scene', 'action', '动作', '主体', '画面', '内容', '需求', '剧情',
]
const AMBIENT_KEYS = ['ambient', 'soundscape', 'sound', 'audio', '环境', '音效', '声景']
const MUSIC_KEYS = ['music', 'bgm', 'score', '配乐']
const DIALOGUE_KEYS = ['dialogue', '台词', 'copy', '文案', '旁白', 'narration', 'user_copy', 'lyrics']

function pickFirst(keys: string[], form: Record<string, unknown>): string | undefined {
  for (const k of keys) {
    const v = form[k]
    if (v != null && String(v).trim()) return String(v).trim()
  }
  return undefined
}

function parseDuration(form: Record<string, unknown>): number | null {
  const raw = form['duration_seconds'] ?? form['duration'] ?? form['seconds'] ?? form['时长']
  if (raw == null) return null
  if (String(raw) === 'custom') {
    const custom = pickFirst(['duration_custom', 'custom_duration', 'duration_seconds_custom', 'custom_seconds'], form)
    if (custom) {
      const n = Number(custom)
      if (Number.isFinite(n) && n >= 4 && n <= 15) return n
    }
    return 10 // custom 无数值 → 官方默认档 10s
  }
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 4 && n <= 15) return n
  return null
}

function genericToShots(scenario: MiniMaxScenario, form: Record<string, unknown>, _lang?: string): H3ShotsInput | null {
  const duration = parseDuration(form)
  if (duration == null) return null

  // 内容字段映射：what 优先内容键；声景/配乐/台词独立键
  const what = pickFirst(WHAT_KEYS, form)
  const ambient = pickFirst(AMBIENT_KEYS, form)
  const music = pickFirst(MUSIC_KEYS, form)
  const dialogue = pickFirst(DIALOGUE_KEYS, form)

  // what 缺失时的兜底：把所有非元数据、未归类字段拼成一镜内容（不臆造——全部来自用户表单值）
  let whatFinal = what
  if (!whatFinal) {
    const parts: string[] = []
    for (const [k, v] of Object.entries(form)) {
      if (META_KEYS.includes(k)) continue
      if (k === 'what' || AMBIENT_KEYS.includes(k) || MUSIC_KEYS.includes(k) || DIALOGUE_KEYS.includes(k) || WHAT_KEYS.includes(k)) continue
      if (v == null || String(v).trim() === '') continue
      parts.push(`${k}: ${String(v).trim()}`)
    }
    whatFinal = parts.join('；') || undefined
  }
  if (!whatFinal) return null // 缺内容字段 → null

  const shot: H3Shot = { what: whatFinal }
  if (ambient) shot.ambient = ambient
  if (music) shot.music = music
  if (dialogue) shot.dialogue = dialogue
  const out: H3ShotsInput = { duration_seconds: duration, shots: [shot] }
  // T13 F2：form_fields.references → H3ShotsInput.references（ref2va 引用映射，存储层原样透传）
  if (Array.isArray(form['references'])) out.references = form['references'] as unknown[]
  return out
}

/** 10 场景映射表（与 MINIMAX_SCENARIOS 一一对应；映射语义共用引擎，条目显式声明） */
export const SCENE_MAPPINGS: SceneMap[] = MINIMAX_SCENARIOS.map((scenario) => ({
  scenarioId: scenario.id,
  toShots: (id, formFields, lang) => {
    const sc = getScenarioById(id)
    if (!sc) return null
    return genericToShots(sc, normalizeForm(sc, formFields), lang)
  },
}))

export function sceneToShots(
  scenarioId: string,
  formFields: Record<string, unknown>,
  opts?: { lang?: string },
): H3ShotsInput | null {
  const scenario = getScenarioById(scenarioId)
  if (!scenario) return null
  const map = SCENE_MAPPINGS.find((m) => m.scenarioId === scenarioId)
  if (!map) return null
  return map.toShots(scenarioId, formFields, opts?.lang) ?? genericToShots(scenario, normalizeForm(scenario, formFields), opts?.lang)
}

/**
 * T13 F2（Ruling #10）：sceneToShots + ref2va 语义提示。
 * ref2va 形态场景（outputMode 'full_reference'）缺 references 时：
 * advisory `references_unmapped` + critical gate（提示显式传 references；不静默生成空 subject_definitions）。
 */
export function sceneToShotsChecked(
  scenarioId: string,
  formFields: Record<string, unknown>,
  opts?: { lang?: string },
): { shots: H3ShotsInput | null; advisories: string[]; gates: AuditGate[] } {
  const scenario = getScenarioById(scenarioId)
  const shots = sceneToShots(scenarioId, formFields, opts)
  const advisories: string[] = []
  const gates: AuditGate[] = []
  if (!scenario || !shots) return { shots, advisories, gates }
  const ref2vaShaped = scenario.outputMode === 'full_reference' || scenarioId === 'full_reference'
  if (ref2vaShaped && !Array.isArray(shots.references)) {
    advisories.push('references_unmapped')
    gates.push({
      rule: 'references_unmapped',
      target: 'h3',
      severity: 'critical',
      detail: `${scenarioId}（ref2va 形态）需要显式 references（1 或 3 张图片，含 who 标签）；表单未提供 → 请通过 form_fields.references 传入`,
      source: 'pe-framework/schema/scenes',
    })
  }
  return { shots, advisories, gates }
}