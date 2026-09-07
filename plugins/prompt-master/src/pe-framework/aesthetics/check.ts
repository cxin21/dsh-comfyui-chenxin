/**
 * 具体性自检 + 保真守卫（spec §13 / §6，确定性、纯函数）。
 * - checkConcreteness：禁空泛词扫描（cinematic/beautiful/amazing/stunning/epic/大气/高级/电影感 等）
 *   + 含可感知名词比例下限（非禁词 token / 总 token ≥ 0.5）。
 * - checkFidelity：抽取原文中英名词短语 → 蓝图 JSON 全文包含性检查；缺失即意图丢失，返回缺失实体列表。
 */
import type { BlueprintV1 } from '../blueprint/schema.js'

export interface ConcretenessResult {
  pass: boolean
  issues: string[]
}

export interface FidelityResult {
  pass: boolean
  missingEntities: string[]
}

export interface ShotDensityResult {
  pass: boolean
  issues: string[]
}

/** 禁空泛词表（spec §7.1 / §13）；命中 → 具体性检查失败 */
const VAGUE_WORDS = ['cinematic', 'beautiful', 'amazing', 'stunning', 'epic', '大气', '高级', '电影感', '氛围感', '唯美']

/** 具体名词比例下限 */
const CONCRETE_RATIO_FLOOR = 0.5

/** 抽取蓝图全部文本值（不含字段名），供禁词扫描与比例计算 */
function collectText(bp: BlueprintV1): string {
  const parts: string[] = []
  const core = bp.core
  if (core.concept) parts.push(core.concept)
  if (core.emotion) parts.push(core.emotion)
  if (core.narrative) parts.push(core.narrative)
  if (core.composition) parts.push(...core.composition)
  for (const c of core.characters ?? []) {
    if (c.name) parts.push(c.name)
    parts.push(...(c.appearance_anchors ?? []))
    if (c.outfit) parts.push(c.outfit)
    if (c.distinctive) parts.push(c.distinctive)
    if (c.variant) parts.push(c.variant)
  }
  const scene = core.scene
  if (scene) {
    if (scene.environment) parts.push(scene.environment)
    if (scene.time) parts.push(scene.time)
    if (scene.lighting) parts.push(scene.lighting)
    if (scene.atmosphere) parts.push(scene.atmosphere)
  }
  const style = core.style
  if (style) {
    if (style.base) parts.push(style.base)
    if (style.theme) parts.push(style.theme)
    if (style.palette) parts.push(style.palette)
  }
  for (const n of core.negative ?? []) {
    if (n.target) parts.push(n.target)
    if (n.attribute) parts.push(n.attribute)
  }
  const video = bp.media_layer?.video
  if (video) {
    if (video.pacing) parts.push(video.pacing)
    if (video.audio) parts.push(video.audio)
    for (const s of video.shots ?? []) {
      if (s.beat) parts.push(s.beat)
      if (s.action) parts.push(s.action)
      if (s.camera) parts.push(s.camera)
      if (s.shot_size) parts.push(s.shot_size)
      const dlg = s.dialogue
      if (dlg != null && dlg.trim().length > 0) parts.push(dlg)
      if (s.audio_focus) parts.push(s.audio_focus)
      if (s.music) parts.push(s.music)
      if (s.remark) parts.push(s.remark)
    }
  }
  const image = bp.media_layer?.image
  if (image) {
    if (image.lighting_detail) parts.push(image.lighting_detail)
    if (image.focal_length) parts.push(image.focal_length)
    if (image.depth_of_field) parts.push(image.depth_of_field)
    if (image.camera_angle) parts.push(image.camera_angle)
  }
  return parts.join(' ')
}

/** 切 token：ASCII 词 + CJK 二元组；返回 [tokens, bannedHits] */
function tokenize(text: string): { tokens: string[]; banned: string[] } {
  const tokens: string[] = []
  const banned: string[] = []
  const lower = text.toLowerCase()
  const asciiRe = /[a-z0-9]+/g
  for (const m of text.matchAll(asciiRe)) {
    tokens.push(m[0].toLowerCase())
  }
  const cjkRe = /[\u4e00-\u9fff\u3040-\u30ff]+/g
  for (const m of text.matchAll(cjkRe)) {
    for (let i = 0; i < m[0].length - 1; i++) tokens.push(m[0].slice(i, i + 2))
  }
  for (const w of VAGUE_WORDS) {
    if (/^[a-z]+$/i.test(w)) {
      if (new RegExp(`\\b${w.toLowerCase()}\\b`).test(lower)) banned.push(w)
    } else if (text.includes(w)) {
      banned.push(w)
    }
  }
  return { tokens, banned }
}

export function checkConcreteness(bp: BlueprintV1): ConcretenessResult {
  const issues: string[] = []
  const text = collectText(bp)
  const { tokens, banned } = tokenize(text)
  for (const w of banned) issues.push(`vague_word:${w}`)
  if (tokens.length > 0) {
    const concrete = tokens.filter((t) => !VAGUE_WORDS.includes(t))
    const ratio = concrete.length / tokens.length
    if (ratio < CONCRETE_RATIO_FLOOR) issues.push(`concrete_ratio:${ratio.toFixed(2)}`)
  }
  return { pass: issues.length === 0, issues }
}

/** 原文 → 名词短语候选：CJK 在虚词处切分 + ASCII 词；过滤长度 < 2 */
const CJK_SPLIT = /[在于是和与及上下里中之内外的前后左右的的地得着了过很最，。、；：！？,.!;:\s]+/
const ASCII_SPLIT = /[^a-z0-9]+/i

export function extractEntities(original: string): string[] {
  const entities = new Set<string>()
  for (const seg of original.split(CJK_SPLIT)) {
    const cjk = seg.trim()
    if (cjk.length >= 2) entities.add(cjk)
  }
  for (const seg of original.split(ASCII_SPLIT)) {
    const word = seg.trim()
    if (word.length >= 2 && /[a-z0-9]/i.test(word)) entities.add(word)
  }
  return [...entities]
}

export function checkFidelity(original: string, bp: BlueprintV1): FidelityResult {
  const haystack = JSON.stringify(bp) ?? ''
  const missingEntities = extractEntities(original).filter((e) => !haystack.includes(e))
  return { pass: missingEntities.length === 0, missingEntities }
}

/** 镜头细节密度维度（spec §7.1 ROI 补全顺序映射）；命中词表可扩展 */
export interface ShotDensityDim {
  id: string
  label: string
  /** 在 action 文本中的命中提示词 */
  hints: string[]
  /** 蓝图级兜底字段（scene.lighting / atmosphere 等）*/
  sceneFallback?: (keyof NonNullable<NonNullable<BlueprintV1['core']>['scene']>)[]
  /** 镜头级兜底字段（camera / shot_size 等）*/
  shotFallback?: (keyof NonNullable<NonNullable<NonNullable<BlueprintV1['media_layer']>['video']>['shots']>[number])[]
}

const SHOT_DENSITY_DIMS: ShotDensityDim[] = [
  {
    id: 'subject',
    label: '主体',
    hints: ['剑客', '角色', '人物', '人', '机械', '车', '建筑', '主角', '两人', '武士', '战士', 'robot', 'character', 'subject', 'knight', 'swordsman'],
    shotFallback: ['who', 'beat'],
  },
  {
    id: 'environment',
    label: '环境',
    hints: ['废墟', '都市', '战场', '街道', '荒野', '沙漠', '森林', '室内', '天空', '大海', '山', '城', '废墟都市', 'room', 'city', 'street', 'field'],
    sceneFallback: ['environment'],
  },
  {
    id: 'lighting',
    label: '光影',
    hints: ['光', '逆光', '黄昏', '月光', '火光', '阴影', '伦勃朗', '金色', '暖光', '冷光', '霓虹', '暮光', 'light', 'golden hour', 'backlit', 'shadow'],
    sceneFallback: ['lighting'],
  },
  {
    id: 'camera',
    label: '运镜',
    hints: ['环绕', '推进', '跟随', '特写', '拉远', '俯拍', '仰拍', '环绕推进', '手持', '轨道', '变焦', '慢镜', 'orbit', 'track', 'dolly', 'pan', 'close-up', 'zoom', 'push'],
    shotFallback: ['camera', 'shot_size', 'camera_angle'],
  },
  {
    id: 'emotion',
    label: '情绪',
    hints: ['紧张', '凝滞', '肃杀', '悲壮', '激昂', '压抑', '孤独', '壮丽', '恐惧', '希望', '沉寂', '紧迫', 'tense', 'somber', 'epic-mood'],
    sceneFallback: ['atmosphere'],
  },
]

/**
 * 镜头细节密度校验（确定性、纯函数；spec §7.1 镜头 what 应覆盖主体/环境/光影/运镜/情绪）。
 * 逐镜头检查 media_layer.video.shots[]：action 文本是否命中各维度的提示词（命中词表），
 * 或该维度由蓝图级 scene.* / 镜头级 camera/shot_size 等兜底。缺失维度 → advisory issue（非阻断）。
 * image 媒体（无 shots）→ pass。
 */
export function checkShotDensity(bp: BlueprintV1): ShotDensityResult {
  const issues: string[] = []
  const video = bp.media_layer?.video
  if (!video || !Array.isArray(video.shots) || video.shots.length === 0) {
    return { pass: true, issues: [] }
  }
  const scene = bp.core?.scene
  video.shots.forEach((shot, i) => {
    const action = (shot.action ?? '').toLowerCase()
    const shotText = [shot.action, shot.camera, shot.shot_size, shot.camera_angle, shot.who]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    for (const dim of SHOT_DENSITY_DIMS) {
      // 1) action 文本命中词表
      let covered = dim.hints.some((h) => action.includes(h.toLowerCase()))
      // 2) 蓝图级 scene 兜底
      if (!covered && dim.sceneFallback && scene) {
        covered = dim.sceneFallback.some((k) => {
          const v = scene[k]
          return typeof v === 'string' && v.trim().length > 0
        })
      }
      // 3) 镜头级兜底
      if (!covered && dim.shotFallback) {
        covered = dim.shotFallback.some((k) => {
          const v = (shot as unknown as Record<string, unknown>)[k]
          return typeof v === 'string' && v.trim().length > 0
        })
      }
      if (!covered) issues.push(`shot_density:shot${i + 1}:missing_${dim.id}(${dim.label})`)
    }
  })
  return { pass: issues.length === 0, issues }
}
