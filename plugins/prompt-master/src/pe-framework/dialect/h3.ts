/**
 * H3 authoring dialect（TS 移植，逐字符对照 h3_prompt/dialect.py）。
 */
import { KEYFRAME_STAGES, type Reference, type H3Shot, type StoryRequest, type H3ShotsInput, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS, MAX_PROMPT_CHARS, MAX_SHOT_FORMULA } from '../schema/h3-shots.js'
import { registerDialect } from './registry.js'
import type { DialectContract, DialectLicense } from './contract.js'
import { contractGatesH3, auditH3Full } from '../audit/rules-h3.js'
import { buildH3Budget, h3BudgetToReport, STAGE_QUALITY_CAPS } from '../audit/budget.js'
import { resolveKnowledgePath } from '../resources/resolve.js'
import { readFileSync } from 'node:fs'
import { H3_PERSONA, H3_SCHEMA } from '../intent/subagent-provider.js'
import { H3_RUBRIC } from '../eval/rubrics/h3.js'

const CJK = /[\u4e00-\u9fff]/
const KANA = /[\u3040-\u30ff]/
// F3：中文标点也剥（用户输入结尾为中文句号/问号/叹号时，不应输出「推进。。」式双标点）
const END_PUNCT = '.!?…。！？'

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
  // Round7 T3：假名优先于汉字判定——含任何假名（ひらがな/カタカナ）即日文，混合日文「雨の夜の江南园林」不再误判中文
  if (KANA.test(text)) return '日本語'
  if (CJK.test(text)) return '中文'
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

/** 供 T7/E2E 消费（brief 接口）：输入扁平 story → {text, text_zh}（Task 6 键桥接：result 键直接匹配 golden text_zh） */
export function compileH3(
  input: { duration_seconds: number; shots: H3Shot[]; references?: unknown[] },
  opts?: { stage?: string },
): { text: string; text_zh: string } {
  const stage = opts?.stage ?? 't2va'
  // F2：shot 结构前置校验——非法字段（如把 content 当 what 传）给可读错误，而不是 trimPunct(undefined) 裸崩溃
  if (!Array.isArray(input.shots)) {
    throw new Error('compileH3: shots 需为数组（H3ShotsInput.shots: Shot[]，每镜含 what 文本）')
  }
  input.shots.forEach((shot, i) => {
    if (!shot || typeof shot !== 'object' || typeof (shot as { what?: unknown }).what !== 'string' || !(shot as { what: string }).what.trim()) {
      const keys = shot && typeof shot === 'object' ? Object.keys(shot).join(',') : String(shot)
      throw new Error(`compileH3: 第 ${i + 1} 镜缺少 what 字段（当前字段: ${keys || '无'}）；H3 shot 契约键为 what（镜头内容文本），不是 content/what 之类——请参照 prompt_compile 的 shots schema`)
    }
  })
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
  const pair = buildTextPair(stage, request)
  return { text: pair.text, text_zh: pair.textZh }
}

/* ── Task 5：方言注册（normalize 收敛 inferH3Stage/refs 归一；工具侧副本 Task 6 删）── */

/** refs 归一单点（prompt-author/prompt-compile/prompt-audit 的 toRefs 收敛）：who/image 字符串化 + width/height 仅接受 number（否则 null） */
export function normalizeRefs(raw: unknown[]): Reference[] {
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
  const references = normalizeRefs(refs.length > 0 ? refs : formRefs)
  // F1：当 shots.references 为空时，把 formFields.references 合并进编译入参 value.shots.references——
  // 否则 normalize.exit references 只喂给 audit/budget，compileH3 仍看到 refs=[] → subject_definitions 空 → 审计必炸
  const mergedShots: H3ShotsInput = refs.length > 0 ? shots : { ...shots, references }
  // 优先级与现 prompt-author.ts inferH3Stage 一致：显式 stage > references 存在 > scenarioId==='full_reference' > t2va
  const stage = opts.stage || (references.length > 0 ? 'ref2va' : opts.scenarioId === 'full_reference' ? 'ref2va' : 't2va')
  return { value: mergedShots, stage, references }
}

/**
 * H3 许可证声明：读 assets/knowledge/minimax-h3-prompt/manifest.json 的 license 字段（spec §9）。
 * 读取失败（资产缺失/路径不可用）→ undefined，不阻断注册。
 */
function h3License(): DialectLicense | undefined {
  try {
    const path = resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'manifest.json' })
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      license?: { id?: string; url?: string; conditions?: string }
    }
    if (!raw.license?.id) return undefined
    return {
      id: raw.license.id,
      url: raw.license.url ?? '',
      ...(raw.license.conditions ? { territory_restrictions: raw.license.conditions } : {}),
    }
  } catch {
    return undefined
  }
}

export function registerH3Dialect(): void {
  const contract: DialectContract<H3ShotsInput, { text: string; text_zh: string }> = {
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
    budget: (compiled, ctx) => h3BudgetToReport(buildH3Budget(ctx.stage ?? 't2va', compiled.text, ctx.references ?? [])),
    targetSlotHint: 't2v.prompt',
    rubric: H3_RUBRIC,
    intent: { persona: H3_PERSONA, schema: H3_SCHEMA },
    // 方言包声明（spec §9，Task 4）：能力/约束/审美/许可证
    capabilities: {
      native_negative: false,          // spec §5.2-3 档 2：H3 无 native negative（正向改写 + advisory）
      supports_audio: true,            // overall_soundscape / shot.ambient
      supports_dialogue: true,         // <d>[语言] 文本</d>
      camera_axes: 3,                  // 运镜在 what 文本中三维描述（dolly/pan/tracking/orbit/crane/handheld）
      media_targets: ['video'],
      aspect_ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],  // 与现有 ASPECT_COMMON / blueprint ASPECT_RATIOS 一致
      duration_range: [MIN_DURATION_SECONDS, MAX_DURATION_SECONDS],
      max_shots_formula: MAX_SHOT_FORMULA,
      max_prompt_chars: MAX_PROMPT_CHARS,
      budget_quality_cap: Math.max(...Object.values(STAGE_QUALITY_CAPS)),  // 各 stage 上限的上界（ref2va=2400）
    },
    constraints: {
      // 对 contractGatesH3 的薄封装（不迁移代码，audit 层继续直接引用原函数）
      validate: (input) => contractGatesH3(input.stage, input.shots, input.refs ?? []),
    },
    aesthetics: {
      forbidden_words: [],       // Phase 2 内容化治理
      few_shot_examples: [],
      style_hints: [],           // 风格库 Phase 2
    },
    license: h3License(),
  }
  registerDialect(contract)
}

// 模块级副作用注册：plugin/index.ts import 本模块即完成装配
registerH3Dialect()