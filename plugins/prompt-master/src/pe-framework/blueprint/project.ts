/**
 * 方言投影器（spec §8）：BlueprintV1 → H3ShotsInput / AnimaSlots，确定性纯函数（非 LLM）。
 * - §8.1 IR→H3 映射表 / §8.2 IR→Anima 映射表
 * - §5.2-3 负向三档：H3 无 native negative → soft 正向改写进 what 末句 + advisory；hard → throw
 * - §5.2-5 角色引用：Shot.who(角色 id) → <Subject N>（按 core.characters 顺序编号）；continuity_lock
 *   角色锚点强制注入每个涉及镜头的 what 首句（防漂移）
 * - §11 Level 1 确定性预修：preflightRepair 用方言包约束合法化 duration / shots 数（零 LLM）
 *
 * what 组装（计划 Task 8 Step 3）：锚点首句 + beat/景别/运镜 + 动作 + soft 负向改写末句。
 * overall_soundscape / non_diegetic_music 由 compileH3 从 shots[].ambient / shots[].music 派生，
 * 故投影器只需映射 audio_focus→ambient、music→music。
 */
import type { BlueprintV1, Character, NegativeConstraint } from './schema.js'
import type { H3ShotsInput, H3Shot } from '../schema/h3-shots.js'
import { max_shots, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS } from '../schema/h3-shots.js'
import type { AnimaSlots } from '../dialect/anima.js'
import { getDialectPackage } from '../dialect/package.js'

/** hard 负向（内容安全类）在投影前应由调用方过滤；投影器遇 hard 直接拒绝（spec §8.1 档 3） */
export class BlueprintHardNegativeError extends Error {
  constructor(target: string) {
    super(`hard negative constraint found during projection: ${target}`)
    this.name = 'BlueprintHardNegativeError'
  }
}

/** 模块级 advisory：每次投影前清空；soft 负向改写等写入（spec §8.1 档 2 advisory 标记） */
export let projectAdvisories: string[] = []

function resetAdvisories(): void {
  projectAdvisories = []
}

/** 最近一次投影的 advisory 文案快照（返回拷贝，避免外部引用被下次投影清空） */
export function lastProjectAdvisories(): string[] {
  return [...projectAdvisories]
}

function subjectLabelsOf(bp: BlueprintV1): Map<string, number> {
  const m = new Map<string, number>()
  ;(bp.core.characters ?? []).forEach((c, i) => m.set(c.id, i + 1))
  return m
}

/** soft 负向 → 正向改写短语：例 {target:'文字', attribute:'字幕'} → 「无字幕纯净画面」；无 attribute 用 target */
function softRewriteOf(n: NegativeConstraint): string {
  return `无${n.attribute ?? n.target}纯净画面`
}

function continuityAnchorsOf(bp: BlueprintV1, who: string[] | undefined): string[] {
  const characters = bp.core.characters ?? []
  return (who ?? [])
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is Character => c !== undefined && c.continuity_lock === true)
    .flatMap((c) => c.appearance_anchors)
}

export function projectToH3(bp: BlueprintV1): H3ShotsInput {
  resetAdvisories()
  const hard = (bp.core.negative ?? []).find((n) => n.severity === 'hard')
  if (hard) throw new BlueprintHardNegativeError(hard.target)

  const video = bp.media_layer.video
  const labels = subjectLabelsOf(bp)
  const softNegatives = (bp.core.negative ?? []).filter((n) => n.severity === 'soft')
  for (const n of softNegatives) {
    projectAdvisories.push(`soft_negative_rewritten:${n.attribute ?? n.target}`)
  }

  const duration_seconds =
    video?.total_duration_seconds ??
    (video?.shots ?? []).reduce((sum, s) => sum + (s.duration_seconds ?? 0), 0) ??
    0

  const shots: H3Shot[] = (video?.shots ?? []).map((shot) => {
    const anchors = continuityAnchorsOf(bp, shot.who).join('，')
    const who =
      (shot.who ?? []).length > 0
        ? (shot.who ?? []).map((id) => (labels.has(id) ? `<Subject ${labels.get(id)}>` : id)).join('，')
        : undefined
    const beatPart = [shot.beat, shot.shot_size, shot.camera].filter(Boolean).join('，')
    // 组装：锚点首句 + beat/景别/运镜 + 动作 + soft 负向改写末句；action 空时 beat 兜底保证 what 非空
    let what = [anchors, beatPart, shot.action].filter(Boolean).join('，')
    for (const n of softNegatives) {
      what = `${what}，${softRewriteOf(n)}`
    }
    if (!what) what = shot.beat
    return {
      what,
      ...(who !== undefined ? { who } : {}),
      ...(shot.audio_focus && shot.audio_focus.trim() ? { ambient: shot.audio_focus } : {}),
      ...(shot.music && shot.music.trim() ? { music: shot.music } : {}),
      ...(shot.dialogue != null ? { dialogue: shot.dialogue } : {}),
    }
  })

  // spec §8.1：media_layer.video.audio（全局声景）→ 并入首镜 ambient（compileH3 的 soundscapeOf
  // 从 shots[].ambient 派生 overall_soundscape）；无首镜则丢弃并记 advisory（O9）
  const globalAudio = video?.audio
  if (globalAudio && globalAudio.trim()) {
    if (shots.length > 0) {
      const first = shots[0]
      first.ambient = first.ambient && first.ambient.trim() ? `${first.ambient}；${globalAudio}` : globalAudio
    } else {
      projectAdvisories.push('audio_dropped:no_shots')
    }
  }

  return { duration_seconds, shots }
}

export function projectToAnima(bp: BlueprintV1): AnimaSlots {
  resetAdvisories()
  const hard = (bp.core.negative ?? []).find((n) => n.severity === 'hard')
  if (hard) throw new BlueprintHardNegativeError(hard.target)

  const characters = bp.core.characters ?? []
  const appearance = characters.flatMap((c) => c.appearance_anchors)
  const clothing = characters.map((c) => c.outfit).filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
  const character = characters.flatMap((c, i) =>
    (c.reference_slots ?? []).map((_slot, j) => `Subject ${i + 1} from <Picture ${j + 1}>`),
  )
  const scene = bp.core.scene?.environment && bp.core.scene.environment.trim() ? [bp.core.scene.environment] : []
  const detailMood = [
    ...(bp.core.scene?.lighting ? [bp.core.scene.lighting] : []),
    ...(bp.media_layer.image?.lighting_detail ? [bp.media_layer.image.lighting_detail] : []),
    ...(bp.core.composition ?? []),
    ...(bp.core.style?.base ? [bp.core.style.base] : []),
    ...(bp.core.style?.theme ? [bp.core.style.theme] : []),
  ]
  const camera = [
    ...(bp.media_layer.image?.focal_length ? [bp.media_layer.image.focal_length] : []),
    ...(bp.media_layer.image?.depth_of_field ? [bp.media_layer.image.depth_of_field] : []),
    ...(bp.media_layer.image?.camera_angle ? [bp.media_layer.image.camera_angle] : []),
  ]
  const exclusions = (bp.core.negative ?? [])
    .filter((n) => n.severity === 'soft')
    .map((n) => n.target)
    .filter((t) => t.trim().length > 0)

  const slots: AnimaSlots = {
    ...(appearance.length > 0 ? { appearance } : {}),
    ...(clothing.length > 0 ? { clothing } : {}),
    ...(character.length > 0 ? { character } : {}),
    ...(scene.length > 0 ? { scene } : {}),
    ...(detailMood.length > 0 ? { detail_mood: detailMood } : {}),
    ...(camera.length > 0 ? { camera } : {}),
    ...(exclusions.length > 0 ? { exclusions } : {}),
    ...(bp.core.narrative ? { narrative: bp.core.narrative } : {}),
  }
  return slots
}

/**
 * §11 Level 1 确定性预修（零 LLM）：投影前用方言包约束合法化蓝图。
 * - total_duration_seconds 越界 → 取最近合法值并记 repair
 * - shots 数超 max_shots → 记录建议（合并分镜/加时长），不自动改结构
 * 返回 { bp（已修复克隆）, repairs[] }；非 video 蓝图原样返回（空 repairs）。
 */
export function preflightRepair(bp: BlueprintV1): { bp: BlueprintV1; repairs: string[] } {
  const repairs: string[] = []
  if (bp.media !== 'video' || !bp.media_layer.video) return { bp, repairs }
  const out: BlueprintV1 = structuredClone(bp)
  const video = out.media_layer.video!
  const pkg = getDialectPackage('h3')
  const [minD, maxD] = pkg?.capabilities?.duration_range ?? [MIN_DURATION_SECONDS, MAX_DURATION_SECONDS]
  const total = video.total_duration_seconds
  if (total != null && !(minD <= total && total <= maxD)) {
    const clamped = Math.min(maxD, Math.max(minD, total))
    video.total_duration_seconds = clamped
    repairs.push(`duration_${total}→${clamped}`)
  }
  const effective = video.total_duration_seconds ?? maxD
  const cap = max_shots(effective)
  if (video.shots.length > cap) {
    repairs.push(`shots_${video.shots.length}>max_${cap}:merge_shots_or_extend_duration`)
  }
  return { bp: out, repairs }
}
