/**
 * MiniMax-H3 story contract (TS 移植).
 * 来源：h3_prompt/contracts.py（1:1 对照移植，不臆造）
 * - parse_request / max_shots / OFFICIAL_INPUT_LIMITS 等逐函数对应
 */
export const STAGES: string[] = ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va']
export const KEYFRAME_STAGES: ReadonlySet<string> = new Set(['i2va', 'fl2va', 'l2va'])
export const REFERENCE_STAGE = 'ref2va'

export const MAX_DURATION_SECONDS = 15.0
export const MIN_DURATION_SECONDS = 4.0 // MiniMax H3 official manual, revision 1241
export const MAX_PROMPT_CHARS = 7000 // MiniMax H3 official manual, revision 1241

export const MAX_SHOT_FORMULA = '1 + floor((duration - 1) / 3)'
export const ALLOWED_REFERENCE_COUNTS_REF2VA: number[] = [1, 3]
export const ALLOWED_PICTURE_COUNTS_KEYFRAME: number[] = [1, 2]

export const OFFICIAL_INPUT_LIMITS: Record<string, number> = {
  max_images: 9,
  max_videos: 3,
  max_audios: 3,
  max_mixed_files: 12,
  min_video_seconds: 2.0,
  max_video_seconds: 15.0,
  min_audio_seconds: 2.0,
  max_audio_seconds: 15.0,
  max_combined_video_seconds: 15.0,
  max_combined_audio_seconds: 15.0,
  max_image_bytes: 30 * 1024 * 1024,
  max_video_bytes: 50 * 1024 * 1024,
  max_audio_bytes: 15 * 1024 * 1024,
}

/* ── 类型（对应 contracts.py dataclasses）── */

export interface H3Shot {
  what: string
  who?: string
  /** 可选：本镜时长（秒）。显式时必须全部镜头都给且总和 = duration_seconds（contractGatesH3 硬校验）；
   *  缺省时编译器回退官方等分切点（golden 兼容）。 */
  duration?: number
  ambient?: string
  music?: string
  dialogue?: string | { text: string; language?: string }
  language?: string
}

/** 供 T7/E2E 消费的扁平输入形状（brief 接口） */
export interface H3ShotsInput {
  duration_seconds: number
  shots: H3Shot[]
  references?: unknown[]
}

export interface Reference {
  who: string | null
  image: string
  width: number | null
  height: number | null
  /** 可选：主体设计描述（身份/服装/材质/风格签名），编译进 subject_definitions（<Subject N> is ... — desc.） */
  description?: string
}

export interface VideoReference {
  label: string
  path: string
  duration_seconds: number | null
}

export interface AudioReference {
  label: string
  path: string
  duration_seconds: number | null
}

export interface StoryRequest {
  stage: string
  duration_seconds: number
  shots: H3Shot[]
  references: Reference[]
  videos: VideoReference[]
  audios: AudioReference[]
}

export class OfficialEnvelopeError extends Error {}
export class ContractError extends Error {}

/* ── contracts.py 移植 ── */

export function max_shots(durationSeconds: number): number {
  return 1 + Math.floor((durationSeconds - 1) / 3)
}

function stringOf(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContractError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function coerceShot(raw: unknown, index: number): H3Shot {
  const label = `shots[${index}]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ContractError(`${label} must be an object`)
  }
  const r = raw as Record<string, unknown>
  const unknown = Object.keys(r)
    .filter((k) => !['what', 'who', 'duration', 'ambient', 'music', 'dialogue', 'language'].includes(k))
    .sort()
  if (unknown.length) throw new ContractError(`${label} has unsupported field(s): ${unknown.join(', ')}`)
  const what = stringOf(r['what'], `${label}.what`)
  const who = r['who'] != null ? stringOf(r['who'], `${label}.who`) : undefined
  const durationRaw = r['duration']
  if (durationRaw != null) {
    if (typeof durationRaw === 'boolean' || typeof durationRaw !== 'number' || !Number.isFinite(durationRaw) || durationRaw <= 0) {
      throw new ContractError(`${label}.duration must be a positive number of seconds (got ${JSON.stringify(durationRaw)})`)
    }
  }
  const ambient = r['ambient'] != null ? stringOf(r['ambient'], `${label}.ambient`) : undefined
  const musicVal = r['music']
  if (musicVal != null && typeof musicVal !== 'string') {
    throw new ContractError(`${label}.music must be a string describing the score; omit it for no music`)
  }
  const music = musicVal != null ? (musicVal as string) : undefined
  const dialogueRaw = r['dialogue']
  let dialogue: string | undefined
  let language: string | undefined
  if (dialogueRaw != null) {
    if (typeof dialogueRaw === 'object' && !Array.isArray(dialogueRaw)) {
      const d = dialogueRaw as Record<string, unknown>
      dialogue = stringOf(d['text'], `${label}.dialogue.text`)
      language = d['language'] != null ? stringOf(d['language'], `${label}.dialogue.language`) : undefined
    } else {
      dialogue = stringOf(dialogueRaw, `${label}.dialogue`)
    }
    if (dialogue.includes('<d>') || dialogue.includes('</d>')) {
      throw new ContractError(`${label}.dialogue must not contain <d> markup`)
    }
  }
  if (r['language'] != null) language = stringOf(r['language'], `${label}.language`)
  const duration = durationRaw != null ? (durationRaw as number) : undefined
  return { what, who, duration, ambient, music, dialogue, language }
}

function coercePixels(width: unknown, height: unknown, label: string): [number, number] {
  if (typeof width === 'boolean' || typeof width !== 'number' || width <= 0) {
    throw new ContractError(`${label}.width must be a positive integer`)
  }
  if (typeof height === 'boolean' || typeof height !== 'number' || height <= 0) {
    throw new ContractError(`${label}.height must be a positive integer`)
  }
  return [width, height]
}

function coerceReference(raw: unknown, index: number): Reference {
  const label = `references[${index}]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ContractError(`${label} must be an object`)
  }
  const r = raw as Record<string, unknown>
  const unknown = Object.keys(r).filter((k) => !['kind', 'who', 'image', 'width', 'height', 'description'].includes(k)).sort()
  if (unknown.length) throw new ContractError(`${label} has unsupported field(s): ${unknown.join(', ')}`)
  const kind = r['kind'] ?? 'picture'
  if (kind !== 'picture') {
    throw new ContractError(`${label}.kind must be 'picture' (videos / audios use top-level fields); got ${JSON.stringify(kind)}`)
  }
  const whoRaw = r['who']
  const who = whoRaw != null ? stringOf(whoRaw, `${label}.who`) : null
  const image = stringOf(r['image'], `${label}.image`)
  const description = r['description'] != null ? stringOf(r['description'], `${label}.description`) : undefined
  const widthRaw = r['width']
  const heightRaw = r['height']
  let width: number | null = null
  let height: number | null = null
  if (widthRaw != null || heightRaw != null) {
    ;[width, height] = coercePixels(widthRaw, heightRaw, label)
  }
  return { who, image, width, height, ...(description !== undefined ? { description } : {}) }
}

function coerceDurationSeconds(value: unknown, label: string): number | null {
  if (value == null) return null
  if (typeof value === 'boolean' || typeof value !== 'number') {
    throw new ContractError(`${label}.duration_seconds must be a JSON number`)
  }
  return value
}

function coerceVideo(raw: unknown, index: number): VideoReference {
  const label = `videos[${index}]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ContractError(`${label} must be an object`)
  }
  const r = raw as Record<string, unknown>
  const unknown = Object.keys(r).filter((k) => !['kind', 'label', 'path', 'duration_seconds'].includes(k)).sort()
  if (unknown.length) throw new ContractError(`${label} has unsupported field(s): ${unknown.join(', ')}`)
  const kind = r['kind'] ?? 'video'
  if (kind !== 'video') throw new ContractError(`${label}.kind must be 'video'`)
  const plabel = stringOf(r['label'], `${label}.label`)
  const path = stringOf(r['path'], `${label}.path`)
  const duration = coerceDurationSeconds(r['duration_seconds'], label)
  if (duration != null) {
    const lo = OFFICIAL_INPUT_LIMITS.min_video_seconds
    const hi = OFFICIAL_INPUT_LIMITS.max_video_seconds
    if (!(lo <= duration && duration <= hi)) {
      throw new OfficialEnvelopeError(`${label}.duration_seconds must be within [${lo}, ${hi}], got ${duration}`)
    }
  }
  return { label: plabel, path, duration_seconds: duration }
}

function coerceAudio(raw: unknown, index: number): AudioReference {
  const label = `audios[${index}]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ContractError(`${label} must be an object`)
  }
  const r = raw as Record<string, unknown>
  const unknown = Object.keys(r).filter((k) => !['kind', 'label', 'path', 'duration_seconds'].includes(k)).sort()
  if (unknown.length) throw new ContractError(`${label} has unsupported field(s): ${unknown.join(', ')}`)
  const kind = r['kind'] ?? 'audio'
  if (kind !== 'audio') throw new ContractError(`${label}.kind must be 'audio'`)
  const plabel = stringOf(r['label'], `${label}.label`)
  const path = stringOf(r['path'], `${label}.path`)
  const duration = coerceDurationSeconds(r['duration_seconds'], label)
  if (duration != null) {
    const lo = OFFICIAL_INPUT_LIMITS.min_audio_seconds
    const hi = OFFICIAL_INPUT_LIMITS.max_audio_seconds
    if (!(lo <= duration && duration <= hi)) {
      throw new OfficialEnvelopeError(`${label}.duration_seconds must be within [${lo}, ${hi}], got ${duration}`)
    }
  }
  return { label: plabel, path, duration_seconds: duration }
}

function checkEnvelope(pictures: number, videos: VideoReference[], audios: AudioReference[]): void {
  const limits = OFFICIAL_INPUT_LIMITS
  if (pictures > limits.max_images) {
    throw new OfficialEnvelopeError(`references exceeds the official image limit: ${pictures} > ${limits.max_images}`)
  }
  if (videos.length > limits.max_videos) {
    throw new OfficialEnvelopeError(`videos exceeds the official video limit: ${videos.length} > ${limits.max_videos}`)
  }
  if (audios.length > limits.max_audios) {
    throw new OfficialEnvelopeError(`audios exceeds the official audio limit: ${audios.length} > ${limits.max_audios}`)
  }
  const mixedTotal = pictures + videos.length + audios.length
  if (mixedTotal > limits.max_mixed_files) {
    throw new OfficialEnvelopeError(`mixed reference count exceeds the official limit: ${mixedTotal} > ${limits.max_mixed_files}`)
  }
  if (audios.length && pictures === 0 && videos.length === 0) {
    throw new OfficialEnvelopeError('audio cannot be the only reference type')
  }
  if (videos.length) {
    const total = videos.reduce((s, v) => s + (v.duration_seconds || 0), 0)
    if (total > limits.max_combined_video_seconds) {
      throw new OfficialEnvelopeError(`combined video duration exceeds the official limit: ${total} > ${limits.max_combined_video_seconds}`)
    }
  }
  if (audios.length) {
    const total = audios.reduce((s, a) => s + (a.duration_seconds || 0), 0)
    if (total > limits.max_combined_audio_seconds) {
      throw new OfficialEnvelopeError(`combined audio duration exceeds the official limit: ${total} > ${limits.max_combined_audio_seconds}`)
    }
  }
}

/** contracts.py parse_request 移植（stage 校验 / 时长 / 镜头上限 / 引用计数 / 信封） */
export function parseRequest(stage: string, payload: Record<string, unknown>): StoryRequest {
  if (!STAGES.includes(stage)) {
    throw new ContractError(`unknown minimax-h3-prompt stage: ${JSON.stringify(stage)}; valid: ${JSON.stringify(STAGES)}`)
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ContractError('request must be a JSON object')
  }
  const allowed = ['duration_seconds', 'shots', 'references', 'videos', 'audios']
  const unknown = Object.keys(payload).filter((k) => !allowed.includes(k)).sort()
  if (unknown.length) {
    throw new ContractError(`unsupported request field(s): ${unknown.join(', ')}; valid fields: ${JSON.stringify([...allowed].sort())}`)
  }
  const durationRaw = payload['duration_seconds']
  if (typeof durationRaw === 'boolean' || typeof durationRaw !== 'number') {
    throw new ContractError(`duration_seconds must be a JSON number (got ${JSON.stringify(durationRaw)})`)
  }
  const duration = Number(durationRaw)
  if (!(MIN_DURATION_SECONDS <= duration && duration <= MAX_DURATION_SECONDS)) {
    throw new ContractError(
      `duration_seconds must be between ${MIN_DURATION_SECONDS} and ${MAX_DURATION_SECONDS} (MiniMax H3 official envelope), got ${duration}`,
    )
  }
  const rawShots = payload['shots']
  if (!Array.isArray(rawShots) || rawShots.length === 0) {
    throw new ContractError('shots must be a non-empty array')
  }
  const shots = rawShots.map((raw, i) => coerceShot(raw, i))
  const limit = max_shots(duration)
  if (shots.length > limit) {
    throw new ContractError(`${shots.length} shots exceed the maximum ${limit} for ${duration}s (${MAX_SHOT_FORMULA})`)
  }

  let references: Reference[] = []
  if (payload['references'] != null) {
    const rawRefs = payload['references']
    if (!Array.isArray(rawRefs)) throw new ContractError('references must be an array')
    references = rawRefs.map((raw, i) => coerceReference(raw, i))
  }
  let videos: VideoReference[] = []
  if (payload['videos'] != null) {
    const rawVideos = payload['videos']
    if (!Array.isArray(rawVideos)) throw new ContractError('videos must be an array')
    videos = rawVideos.map((raw, i) => coerceVideo(raw, i))
  }
  let audios: AudioReference[] = []
  if (payload['audios'] != null) {
    const rawAudios = payload['audios']
    if (!Array.isArray(rawAudios)) throw new ContractError('audios must be an array')
    audios = rawAudios.map((raw, i) => coerceAudio(raw, i))
  }

  if (KEYFRAME_STAGES.has(stage)) {
    if (videos.length || audios.length) {
      throw new ContractError(`${stage} does not accept video / audio references; route to ref2va`)
    }
    if (references.length === 0) throw new ContractError(`${stage} requires at least one picture reference`)
    if (!ALLOWED_PICTURE_COUNTS_KEYFRAME.includes(references.length)) {
      const wanted = ALLOWED_PICTURE_COUNTS_KEYFRAME.join(' or ')
      throw new ContractError(`${stage} requires ${wanted} picture references, got ${references.length}`)
    }
    references.forEach((ref, index) => {
      if (ref.who != null) {
        throw new ContractError(
          `references[${index}].who must be absent for ${stage} (keyframe labels are positional, not identity-bearing)`,
        )
      }
    })
  } else if (stage === REFERENCE_STAGE) {
    if (!ALLOWED_REFERENCE_COUNTS_REF2VA.includes(references.length)) {
      const wanted = ALLOWED_REFERENCE_COUNTS_REF2VA.join(' or ')
      throw new ContractError(`ref2va requires ${wanted} picture references, got ${references.length}`)
    }
    const owners = references.map((ref) => ref.who)
    if (owners.some((o) => o == null)) {
      throw new ContractError("every ref2va picture reference requires a 'who' (identity / role) label")
    }
    if (new Set(owners).size !== owners.length) {
      throw new ContractError("reference 'who' values must be unique")
    }
    shots.forEach((shot, index) => {
      if (shot.who != null && !owners.includes(shot.who)) {
        throw new ContractError(`shots[${index}].who ${JSON.stringify(shot.who)} does not match any reference 'who'`)
      }
    })
    checkEnvelope(references.length, videos, audios)
  } else {
    // t2va
    if (references.length || videos.length || audios.length) {
      throw new ContractError(`${stage} takes no references; route to ref2va / i2va / fl2va / l2va`)
    }
  }

  return { stage, duration_seconds: duration, shots, references, videos, audios }
}