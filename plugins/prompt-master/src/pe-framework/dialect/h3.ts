/**
 * H3 authoring dialect（TS 移植，逐字符对照 h3_prompt/dialect.py）。
 */
import { KEYFRAME_STAGES, type Reference, type H3Shot, type StoryRequest, type H3ShotsInput } from '../schema/h3-shots.js'
import { registerDialect } from './registry.js'
import type { DialectContract } from './contract.js'
import { contractGatesH3, auditH3Full } from '../audit/rules-h3.js'
import { buildH3Budget } from '../audit/budget.js'
import { H3_PERSONA, H3_SCHEMA } from '../intent/subagent-provider.js'

const CJK = /[\u4e00-\u9fff]/
const KANA = /[\u3040-\u30ff]/
const END_PUNCT = '.!?…'

export function formatTimestamp(seconds: number): string {
  const totalMs = Math.round(seconds * 1000)
  const minutes = Math.floor(totalMs / 60_000)
  const rem = totalMs % 60_000
  const secs = Math.floor(rem / 1000)
  const ms = rem % 1000
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

export function formatDurationTwoDecimals(seconds: number): string {
  return seconds.toFixed(2)
}

/** Cut instant per shot; the first shot has none. */
export function shotCutTimes(durationSeconds: number, shotCount: number): (number | null)[] {
  return [null, ...Array.from({ length: shotCount - 1 }, (_, i) => (durationSeconds * (i + 1)) / shotCount)]
}

export function detectLanguage(text: string): string {
  if (CJK.test(text)) return '中文'
  if (KANA.test(text)) return '日本語'
  return 'English'
}

function trimPunct(text: string): string {
  let t = text.trim()
  while (t.length && END_PUNCT.includes(t[t.length - 1])) {
    t = t.slice(0, -1).trimEnd()
  }
  return t
}

function subjectLabels(references: Reference[]): Map<string, number> {
  const m = new Map<string, number>()
  references.forEach((ref, i) => {
    if (ref.who) m.set(ref.who, i + 1)
  })
  return m
}

function applySubjectLabels(text: string, shot: H3Shot, labels: Map<string, number>): string {
  if (shot.who && labels.has(shot.who)) {
    return text.replace(shot.who, `<Subject ${labels.get(shot.who)}>`)
  }
  return text
}

function buildDialogue(shot: H3Shot): string {
  const raw = shot.dialogue
  if (!raw) return ''
  const text = typeof raw === 'string' ? raw : raw.text
  const lang = shot.language || (typeof raw === 'object' && raw.language) || detectLanguage(text)
  return ` <d>[${lang}] ${text}</d>`
}

export function buildShotLines(request: StoryRequest, subjectLabelsMap?: Map<string, number>): string[] {
  const labels = subjectLabelsMap ?? new Map<string, number>()
  const times = shotCutTimes(request.duration_seconds, request.shots.length)
  const lines: string[] = []
  request.shots.forEach((shot, i) => {
    const index = i + 1
    let what = trimPunct(shot.what)
    what = applySubjectLabels(what, shot, labels)
    let body: string
    const cut = times[i]
    if (cut == null) {
      body = `[Shot ${index}] ${what}.`
    } else {
      body = `[Shot ${index}] At ${formatTimestamp(cut)}, the camera cuts to ${what}.`
    }
    lines.push(body + buildDialogue(shot))
  })
  return lines
}

function soundscapeOf(shots: H3Shot[]): string {
  const parts = shots
    .filter((s) => s.ambient && s.ambient.trim())
    .map((s) => s.ambient!.trim())
  return parts.length ? parts.join('; ') : 'N/A'
}

function musicOf(shots: H3Shot[]): string {
  const parts = shots
    .filter((s) => s.music && s.music.trim())
    .map((s) => s.music!.trim())
  return parts.length ? parts.join('; ') : 'N/A'
}

export function buildThreeFieldBody(request: StoryRequest): string {
  const description = buildShotLines(request).join(' ')
  return [
    `integrated_multimodal_description: ${description}`,
    '',
    `overall_soundscape: ${soundscapeOf(request.shots)}`,
    '',
    `non_diegetic_music: ${musicOf(request.shots)}`,
  ].join('\n')
}

export function alignmentPreamble(stage: string, request: StoryRequest): string {
  if (stage === 'i2va') {
    return 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.'
  }
  if (stage === 'fl2va') {
    const lastShot = request.shots.length
    const duration = formatDurationTwoDecimals(request.duration_seconds)
    return (
      'How the reference pictures align with the target video — ' +
      `Picture 1 (from Shot 1) aligns with the 0.00-second mark of the ` +
      `target video; Picture 2 (from Shot ${lastShot}) aligns with the ` +
      `${duration}-second mark of the target video.`
    )
  }
  if (stage === 'l2va') {
    const lastShot = request.shots.length
    const duration = formatDurationTwoDecimals(request.duration_seconds)
    return (
      'How the reference pictures align with the target video — ' +
      `<Picture 1> (from [Shot ${lastShot}]) aligns with the ` +
      `${duration}-second mark of the target video.`
    )
  }
  return ''
}

export function buildKeyframeText(stage: string, request: StoryRequest): string {
  const preamble = alignmentPreamble(stage, request)
  const body = buildThreeFieldBody(request)
  return preamble ? `${preamble}\n\n${body}` : body
}

export function buildRef2vaText(request: StoryRequest): string {
  const labels = subjectLabels(request.references)
  const subjectDefinitions = request.references
    .map((ref, i) => `<Subject ${i + 1}> is ${ref.who} from <Picture ${i + 1}>.`)
    .join('\n')
  const cast = request.references
    .map((ref, i) => `${ref.who} (<Picture ${i + 1}>)`)
    .join(', ')
  const duration = request.duration_seconds
  const durationText = String(duration)
  const verb = request.references.length === 1 ? 'appears' : 'appear'
  const summary =
    `[reference generation] ${cast} ${verb} in a ${durationText}-second, ` +
    `${request.shots.length}-shot video with synchronized audio.`
  const retentionAnalysis = request.references
    .map(
      (_, i) =>
        `<Subject ${i + 1}> from <Picture ${i + 1}> remains fully_preserved: ` +
        'identity, face, outfit, and styling unchanged across all shots.',
    )
    .join('\n')
  const detailed = buildShotLines(request, labels).join(' ')
  return [
    `subject_definitions: ${subjectDefinitions}`,
    '',
    `summary: ${summary}`,
    '',
    `retention_analysis: ${retentionAnalysis}`,
    '',
    `detailed_description: ${detailed}`,
    '',
    `overall_soundscape: ${soundscapeOf(request.shots)}`,
    '',
    `non_diegetic_music: ${musicOf(request.shots)}`,
  ].join('\n')
}

export function buildText(stage: string, request: StoryRequest): string {
  if (stage === 't2va') return buildThreeFieldBody(request)
  if (KEYFRAME_STAGES.has(stage)) return buildKeyframeText(stage, request)
  if (stage === 'ref2va') return buildRef2vaText(request)
  throw new Error(`unknown stage: ${JSON.stringify(stage)}`)
}

/* ── Chinese skeleton translation（dialect.py build_text_zh 移植）── */

const FIELD_HEADERS_ZH: Record<string, string> = {
  integrated_multimodal_description: '整合多模态描述',
  overall_soundscape: '整体声音景观',
  non_diegetic_music: '非叙事音乐',
  subject_definitions: '主体定义',
  summary: '摘要',
  retention_analysis: '保持性分析',
  detailed_description: '详细描述',
}

function kindZh(kind: string): string {
  const map: Record<string, string> = { Subject: '主体', Picture: '图片', Video: '视频', Audio: '音频' }
  return map[kind] ?? kind
}

function skeletonTokenize(text: string): string {
  let out = text
  out = out.replace(/\[Shot (\d+)\]/g, (_m, n) => `[镜头 ${n}]`)
  out = out.replace(/At (\d{2}:\d{2}\.\d{3}),/g, (_m, ts) => `在 ${ts}，`)
  out = out.replace(/<(Subject|Picture|Video|Audio) (\d+)>/g, (_m, kind, n) => `<${kindZh(kind)} ${n}>`)
  out = out.replace(/\bPicture (\d+)\b/g, (_m, n) => `图片 ${n}`)
  out = out.replace(/\bShot (\d+)\b/g, (_m, n) => `第 ${n} 镜`)
  out = out.replace(/\bN\/A\b/g, '无')
  out = out.replace(/\[reference generation\]/g, '[参考生成]')
  return out
}

export function buildTextZh(textEn: string): string {
  const outLines: string[] = []
  for (const line of textEn.split('\n')) {
    const stripped = line.trim()
    if (!stripped) {
      outLines.push('')
      continue
    }
    const headerMatch = /^([a-z_]+):\s?(.*)$/.exec(stripped)
    if (headerMatch && headerMatch[1] in FIELD_HEADERS_ZH) {
      const field = headerMatch[1]
      const body = headerMatch[2]
      const translated = body ? skeletonTokenize(body) : ''
      outLines.push(`${FIELD_HEADERS_ZH[field]}: ${translated}`.trimEnd())
      continue
    }
    outLines.push(skeletonTokenize(stripped))
  }
  return outLines.join('\n').trim()
}

export function buildTextPair(stage: string, request: StoryRequest): { text: string; textZh: string } {
  const textEn = buildText(stage, request)
  return { text: textEn, textZh: buildTextZh(textEn) }
}

/** 供 T7/E2E 消费（brief 接口）：输入扁平 story → {text, textZh} */
export function compileH3(
  input: { duration_seconds: number; shots: H3Shot[]; references?: unknown[] },
  opts?: { stage?: string },
): { text: string; textZh: string } {
  const stage = opts?.stage ?? 't2va'
  const refs: Reference[] = Array.isArray(input.references)
    ? (input.references as unknown[]).map((r) => {
        const raw = r as Record<string, unknown>
        return {
          who: raw['who'] != null ? String(raw['who']) : null,
          image: String(raw['image'] ?? ''),
          width: typeof raw['width'] === 'number' ? raw['width'] : null,
          height: typeof raw['height'] === 'number' ? raw['height'] : null,
        }
      })
    : []
  const request: StoryRequest = {
    stage,
    duration_seconds: input.duration_seconds,
    shots: input.shots,
    references: refs,
    videos: [],
    audios: [],
  }
  return buildTextPair(stage, request)
}

/* ── Task 5：方言注册（normalize 收敛 inferH3Stage/toRefs；工具侧副本 Task 6 删）── */

/** toRefs 移植（prompt-author.ts 收敛单点）：who/image 字符串化 + width/height 仅接受 number（否则 null） */
function toRefsNormalized(raw: unknown[]): Reference[] {
  return raw.map((r) => {
    const x = r as Record<string, unknown>
    return {
      who: x['who'] != null ? String(x['who']) : null,
      image: String(x['image'] ?? ''),
      width: typeof x['width'] === 'number' ? x['width'] : null,
      height: typeof x['height'] === 'number' ? x['height'] : null,
    }
  })
}

/** stage 推断 + references 规范化（从 prompt-author.ts inferH3Stage/toRefs 收敛；Task 6 删除工具侧副本） */
export function normalizeH3Input(
  input: unknown,
  opts: { stage?: string; scenarioId?: string; formFields?: unknown },
): { error?: string; value?: H3ShotsInput; stage?: string; references?: Reference[] } {
  const shots = (input as { shots?: H3ShotsInput } | undefined)?.shots
  if (!shots || !Array.isArray(shots.shots) || shots.shots.length === 0) {
    return { error: 'intent 未产出 shots 结构' }
  }
  const formRefs = Array.isArray((opts.formFields as Record<string, unknown> | undefined)?.references)
    ? ((opts.formFields as Record<string, unknown>).references as unknown[]) : []
  const refs = Array.isArray(shots.references) ? shots.references : []
  const references = toRefsNormalized(refs.length > 0 ? refs : formRefs)
  // 优先级与现 prompt-author.ts inferH3Stage 一致：显式 stage > references 存在 > scenarioId==='full_reference' > t2va
  const stage = opts.stage || (references.length > 0 ? 'ref2va' : opts.scenarioId === 'full_reference' ? 'ref2va' : 't2va')
  return { value: shots, stage, references }
}

export function registerH3Dialect(): void {
  const contract: DialectContract<H3ShotsInput, { text: string; textZh: string }> = {
    id: 'h3',
    label: 'MiniMax-H3',
    auditOnlyOk: true,
    normalize: (input, opts) => normalizeH3Input(input, opts),
    compile: (shots, opts) => compileH3(shots, { stage: opts.stage ?? 't2va' }),
    audit: (compiled, ctx) => {
      const stage = ctx.stage ?? 't2va'
      const shots = ctx.shots as H3ShotsInput
      const gates = [
        ...contractGatesH3(stage, shots, ctx.references ?? []),
        ...auditH3Full(compiled.text, { stage, duration: shots.duration_seconds, shotCount: shots.shots.length }, ctx.references),
      ]
      return { gates, assumptions: [] }
    },
    budget: (compiled, ctx) => buildH3Budget(ctx.stage ?? 't2va', compiled.text, ctx.references ?? []),
    targetSlotHint: 't2v.prompt',
    intent: { persona: H3_PERSONA, schema: H3_SCHEMA },
  }
  registerDialect(contract)
}

// 模块级副作用注册：plugin/index.ts import 本模块即完成装配
registerH3Dialect()