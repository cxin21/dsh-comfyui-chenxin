/**
 * 创作蓝图 IR（BlueprintV1）schema + 校验（spec §5.1）。
 * 纯类型 + 纯函数：validateBlueprint 为 deterministic 校验器，
 * 输出 { ok: true; value } | { ok: false; errors }。
 * 字段顺序即优先级（spec §5.1）。
 */
import type { Rating } from '../types.js'

export type BlueprintMedia = 'image' | 'video' | 'mixed'

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const
export type AspectRatio = (typeof ASPECT_RATIOS)[number]

export interface NegativeConstraint {
  target: string                // 负向对象（"文字"/"现代元素"/"血腥"）
  attribute?: string            // 属性限定（如 "文字：字幕/水印/LOGO"）
  severity?: 'soft' | 'hard'    // hard=内容安全类（直接过滤/拒绝）；soft=美学类（折进正向或映射 negative）
}

export interface StyleRef {
  base?: string                 // 基底风格：媒介/画风（写实电影/赛璐璐/厚涂）
  theme?: string                // 主题风格：赛博朋克/和风/废土（影响场景+配色）
  palette?: string              // 情绪配色：青橙对比/低饱和/高饱和
  artist_hints?: string[]       // B8（外部基准 2026-09）：画师候选（裸名，catalog 已验证存在；投影 → anima artist 槽）
}

export interface Character {
  id: string
  name?: string
  appearance_anchors: string[]  // 识别锚点（脸型/发型/瞳色/体型/肤色）— 必须"可见、可生成、可比较"
  outfit?: string
  props?: string[]
  distinctive?: string          // 标志物（胎记/伤疤/纹身/特征配饰）
  reference_slots?: string[]    // 参考图槽位（正脸/全身/表情 → <Picture N> 绑定）
  variant?: string              // 变体状态（服装换装/伤势/时段变化）
  continuity_lock?: boolean     // 连续性锁（该角色跨镜头必须严格一致，禁止漂移）
}

export interface Scene {
  environment: string           // 环境（具体名词）
  time?: string                 // 时间（黄昏/夜晚/正午）
  lighting?: string             // 光线基调
  atmosphere?: string           // 氛围
}

export interface Shot {
  beat: string                  // 情节节拍（这镜在干什么）
  shot_size?: string            // 景别（CU/MCU/MS/FS/WS，对齐影视 shot list 标准）
  camera_angle?: string         // 机位角度（高/低/平/过肩/俯拍）
  camera?: string               // 运镜（dolly/pan/tracking/orbit/crane/handheld）
  action?: string               // 动作细节（具体名词，识别锚点须可生成可比较）
  dialogue?: string             // 对白（可空）
  audio_focus?: string          // 音效焦点
  music?: string                // 音乐情绪
  duration_seconds?: number     // 分镜时长（视频总时长 = Σ shots 或显式 total）
  who?: string[]                // 涉及角色 id（→ <Subject N> 稳定标签，见 §5.2-5）
  remark?: string               // 备注（连续性要求/特效/特殊说明，对齐影视 shot list 备注列）
}

export interface BlueprintV1 {
  schema_version: 1
  media: BlueprintMedia
  core: {
    concept: string          // 一句话主题（必填，用户原意压缩）
    /** spec §5.1：内容分级档位（序 safe<sensitive<explicit）。缺省视为 safe；
     *  不要求 LLM 产出——Task 14 在意图分析后确定性写入（LLM 产物不可信于安全数据，spec §7 P1 偏差记录）。 */
    rating?: Rating
    aspect_ratio?: AspectRatio
    characters?: Character[] // 角色卡（可空；支撑跨镜头/跨次一致性；spec §6 蓝图字段可空，缺失维度由分析器显式标记）
    scene?: Scene            // 场景（环境/时间/光线/氛围）
    style?: StyleRef         // 风格引用（基底/主题/情绪/配色）
    emotion?: string         // 情绪基调（冷峻/温暖/压抑…）
    composition?: string[]   // 构图语言（三分法/对称/负空间/前景引导）
    negative: NegativeConstraint[]  // 负向意图（结构化约束：对象+属性）
    narrative?: string       // 自由叙事文本（保留用户原话）
  }
  media_layer: {
    video?: {
      total_duration_seconds?: number  // 视频总时长（H3 官方契约 4–15s，唯一权威值）
      shots: Shot[]          // 分镜序列（结构对齐影视 shot list 标准列，见 Shot）
      pacing?: string        // 节奏（渐强/平缓/骤停）
      audio?: string         // 全局声景（非 diegetic 音乐基调）
    }
    image?: {
      lighting_detail?: string  // 光照细节（伦勃朗光/黄金时刻/体积光）
      focal_length?: string     // 焦段（24/35/85mm）
      depth_of_field?: string   // 景深
      camera_angle?: string     // 机位角度
    }
  }
}

export type ValidateResult =
  | { ok: true; value: BlueprintV1 }
  | { ok: false; errors: string[] }

const MEDIA_VALUES = ['image', 'video', 'mixed'] as const
const RATINGS = ['safe', 'sensitive', 'explicit'] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** 校验必填（media、core.concept）、类型、aspect_ratio 枚举、total_duration 4–15、shots 非空数组。错误信息含字段路径。 */
export function validateBlueprint(bp: unknown): ValidateResult {
  const errors: string[] = []
  if (!isRecord(bp)) {
    errors.push('blueprint must be an object')
    return { ok: false, errors }
  }

  // media：必填 + 枚举
  if (bp['media'] == null) {
    errors.push('media is required')
  } else if (!MEDIA_VALUES.includes(bp['media'] as (typeof MEDIA_VALUES)[number])) {
    errors.push('media must be one of image|video|mixed')
  }

  // core：必填对象
  if (bp['core'] == null) {
    errors.push('core is required')
  } else if (!isRecord(bp['core'])) {
    errors.push('core must be an object')
  } else {
    const core = bp['core']
    // concept：必填非空字符串
    if (core['concept'] == null || !isNonEmptyString(core['concept'])) {
      errors.push('core.concept must be a non-empty string')
    }
    // rating：可选，存在时校验枚举（缺省视为 safe，不报错——spec §5.1）
    if (core['rating'] != null && !(RATINGS as readonly string[]).includes(core['rating'] as string)) {
      errors.push('core.rating must be one of safe|sensitive|explicit')
    }
    // aspect_ratio：可选，存在时校验枚举
    if (core['aspect_ratio'] != null && !(ASPECT_RATIOS as readonly string[]).includes(core['aspect_ratio'] as string)) {
      errors.push('core.aspect_ratio must be one of 16:9|9:16|1:1|4:3|3:4')
    }
  }

  // media_layer：可选；video 分支校验
  const mediaLayer = bp['media_layer']
  if (mediaLayer != null) {
    if (!isRecord(mediaLayer)) {
      errors.push('media_layer must be an object')
    } else {
      const video = mediaLayer['video']
      if (video != null) {
        if (!isRecord(video)) {
          errors.push('media_layer.video must be an object')
        } else {
          // total_duration_seconds：可选，存在时校验 4–15
          if (video['total_duration_seconds'] != null) {
            const d = video['total_duration_seconds']
            if (typeof d !== 'number' || !(4 <= d && d <= 15)) {
              errors.push('media_layer.video.total_duration_seconds must be a number in [4, 15]')
            }
          }
          // shots：非空数组
          if (!Array.isArray(video['shots']) || (video['shots'] as unknown[]).length === 0) {
            errors.push('media_layer.video.shots must be a non-empty array')
          }
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: bp as unknown as BlueprintV1 }
}
