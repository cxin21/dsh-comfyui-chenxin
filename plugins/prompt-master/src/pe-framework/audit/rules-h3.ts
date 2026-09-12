/**
 * H3 文本级硬闸门（TS 移植，逐函数对照 h3_prompt/audit.py + multishot.py）。
 * 每条 H3AuditError → 一条 AuditGate（severity: 'critical'，rule 按 spec §7 分类）。
 */
import { MAX_PROMPT_CHARS, KEYFRAME_STAGES, type Reference, type H3Shot, type H3ShotsInput } from '../schema/h3-shots.js'
import type { AuditGate } from '../types.js'

const SHOT_MARKER = /\[Shot ([1-9][0-9]*)\]/g
const CUT_PREFIX = /^\s*At ([0-9]{2}):([0-9]{2})\.([0-9]{3}),\s*/
const DIALOGUE = /<d>\[([^\]]+)\] ([\s\S]*?)<\/d>/g
const REFERENCE = /<(Subject|Picture|Video|Audio) ([1-9][0-9]*)>/g

const T2VA_FIELDS = ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music'] as const
const KEYFRAME_FIELDS = T2VA_FIELDS
const REF2VA_FIELDS = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
] as const

class H3AuditError extends Error {}

function checkCharBudget(text: string, findings: string[]): void {
  if (text.length > MAX_PROMPT_CHARS) {
    findings.push(
      `prompt length ${text.length} chars exceeds the official ${MAX_PROMPT_CHARS}-character maximum`,
    )
  }
}

function splitFields(text: string, names: readonly string[]): Record<string, string> {
  const positions: [number, string][] = []
  for (const name of names) {
    const index = text.indexOf(`${name}: `)
    if (index === -1) throw new H3AuditError(`field ${JSON.stringify(name)} is missing from the prompt`)
    positions.push([index, name])
  }
  const ordered = [...positions].sort((a, b) => a[0] - b[0])
  if (ordered.map(([, name]) => name).join('\u0000') !== names.join('\u0000')) {
    throw new H3AuditError('fields are not in the required dialect order')
  }
  const fields: Record<string, string> = {}
  ordered.forEach(([start, name], index) => {
    const bodyStart = start + name.length + 2
    const bodyEnd = index + 1 < ordered.length ? ordered[index + 1][0] : text.length
    fields[name] = text.slice(bodyStart, bodyEnd).trim()
  })
  return fields
}

interface Shot {
  number: number
  startSeconds: number
  endSeconds: number
  text: string
}

function parseShots(description: string, durationSeconds: number, declaredShotCount: number): Shot[] {
  if (!(4 <= durationSeconds && durationSeconds <= 15)) {
    throw new H3AuditError('duration_seconds must be between 4 and 15')
  }
  if (declaredShotCount <= 0) throw new H3AuditError('declared_shot_count must be a positive integer')
  if (typeof description !== 'string' || !description.trim()) {
    throw new H3AuditError('description must be non-empty')
  }
  SHOT_MARKER.lastIndex = 0
  const markers: RegExpExecArray[] = []
  let m: RegExpExecArray | null
  while ((m = SHOT_MARKER.exec(description)) !== null) markers.push(m)
  const numbers = markers.map((marker) => parseInt(marker[1], 10))
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) throw new H3AuditError('shot numbers must be sequential starting at 1')
  }
  if (markers.length !== declaredShotCount) {
    throw new H3AuditError('declared shot count does not match shot markers')
  }
  const maxShots = 1 + Math.floor((durationSeconds - 1) / 3)
  if (markers.length > maxShots) throw new H3AuditError(`shot count exceeds max_shots ${maxShots}`)

  const starts: number[] = [0.0]
  const bodies: string[] = []
  markers.forEach((marker, index) => {
    const end = index + 1 < markers.length ? markers[index + 1].index : description.length
    let body = description.slice(marker.index + marker[0].length, end).trim()
    if (index === 0) {
      if (CUT_PREFIX.test(body)) throw new H3AuditError('first shot must not contain a timestamp')
    } else {
      CUT_PREFIX.lastIndex = 0
      const timestamp = CUT_PREFIX.exec(body)
      if (timestamp == null) {
        throw new H3AuditError('every shot after the first requires At MM:SS.mmm')
      }
      const minutes = parseInt(timestamp[1], 10)
      const seconds = parseInt(timestamp[2], 10)
      const milliseconds = parseInt(timestamp[3], 10)
      if (seconds >= 60) throw new H3AuditError('timestamp seconds must be below 60')
      const start = minutes * 60 + seconds + milliseconds / 1000
      if (start >= durationSeconds) throw new H3AuditError('shot timestamp must fall within video duration')
      starts.push(start)
      body = body.slice(timestamp[0].length).trim()
    }
    if (!body) throw new H3AuditError(`Shot ${index + 1} must have executable content`)
    bodies.push(body)
  })
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] <= starts[i - 1]) throw new H3AuditError('shot timestamps must be strictly increasing')
  }

  return bodies.map((body, index) => ({
    number: index + 1,
    startSeconds: starts[index],
    endSeconds: index + 1 < starts.length ? starts[index + 1] : durationSeconds,
    text: body,
  }))
}

function semanticShot(text: string): string {
  // CJK 感知：抽中文二元组 + ASCII 词，中文正文不再判空
  const norm = text.toLowerCase()
  const ascii = (norm.match(/[a-z0-9]+/g) ?? []).join(' ')
  const cjkChars = norm.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []
  const bigrams: string[] = []
  for (let i = 0; i + 1 < cjkChars.length; i++) bigrams.push(cjkChars[i] + cjkChars[i + 1])
  return [ascii, ...bigrams].filter(Boolean).join(' ')
}

function auditShotExecution(shots: Shot[]): void {
  for (const shot of shots.slice(1)) {
    if (
      /^(?:the camera|the shot|camera|shot)\s+(?:cuts|transitions|changes|switches)\s+to\b/i.test(shot.text) === false
    ) {
      throw new H3AuditError(
        `Shot ${shot.number} cut must declare a model-native transition and new view`,
      )
    }
  }
  for (let i = 1; i < shots.length; i++) {
    if (semanticShot(shots[i - 1].text) === semanticShot(shots[i].text)) {
      throw new H3AuditError(`Shot ${shots[i].number} cut adds no new information or state`)
    }
  }
}

function auditDialogue(text: string): void {
  DIALOGUE.lastIndex = 0
  const malformed = text.replace(DIALOGUE, '')
  if (malformed.includes('<d>') || malformed.includes('</d>')) {
    throw new H3AuditError('dialogue blocks must use <d>[Language] exact text</d>')
  }
}

function auditSoundMusicSeparation(soundscape: string, music: string): void {
  if (soundscape.includes('<d>') || soundscape.includes('</d>')) {
    throw new H3AuditError('dialogue must not be repeated in overall_soundscape')
  }
  if (/\bnon[- ]diegetic\b|\bbackground music\b/i.test(soundscape)) {
    throw new H3AuditError('non-diegetic music must not appear in overall_soundscape')
  }
  if (music.includes('<d>') || music.includes('</d>')) {
    throw new H3AuditError('dialogue must not appear in non_diegetic_music')
  }
}

function auditReferenceLabels(subjectDefinitions: string, usageText: string, references: Reference[]): void {
  if (references.some((ref) => !ref.who || !ref.who.trim())) {
    throw new H3AuditError('every ordered input reference requires an owner')
  }
  const combined = `${subjectDefinitions}\n${usageText}`
  REFERENCE.lastIndex = 0
  const labels = new Set<string>()
  let rm: RegExpExecArray | null
  while ((rm = REFERENCE.exec(combined)) !== null) labels.add(`${rm[1]}:${rm[2]}`)
  const pictureNumbers = [...labels].filter((l) => l.startsWith('Picture:')).map((l) => parseInt(l.split(':')[1], 10))
  const expectedNumbers = new Set(Array.from({ length: references.length }, (_, i) => i + 1))
  if (!pictureNumbers.every((n) => expectedNumbers.has(n))) {
    throw new H3AuditError('reference label does not resolve to an ordered input image')
  }
  const definitionLabels = [...subjectDefinitions.matchAll(/^\s*<(Subject|Picture|Video|Audio) ([1-9][0-9]*)>\s+is\b/gm)]
  const defKeys = definitionLabels.map((dm) => `${dm[1]}:${dm[2]}`)
  if (defKeys.length !== new Set(defKeys).size) {
    throw new H3AuditError('reference definition collision')
  }
  if (![...expectedNumbers].every((n) => pictureNumbers.includes(n))) {
    throw new H3AuditError('every ordered input image must be referenced')
  }
  const definedSubjects = new Set(definitionLabels.filter((d) => d[1] === 'Subject').map((d) => parseInt(d[2], 10)))
  REFERENCE.lastIndex = 0
  const usedSubjects = new Set<number>()
  let um: RegExpExecArray | null
  while ((um = REFERENCE.exec(usageText)) !== null) if (um[1] === 'Subject') usedSubjects.add(parseInt(um[2], 10))
  for (const used of usedSubjects) {
    if (!definedSubjects.has(used)) {
      throw new H3AuditError('used Subject label is not defined in subject_definitions')
    }
  }
}

function auditTimeline(description: string, durationSeconds: number, shotCount: number): void {
  const shots = parseShots(description, durationSeconds, shotCount)
  auditShotExecution(shots)
  auditDialogue(description)
}

/* ── Keyframe preamble audits ── */

function auditI2vaPreamble(preamble: string): void {
  if (!preamble.includes('<Picture 1>')) throw new H3AuditError('i2va preamble must reference <Picture 1>')
  if (!preamble.includes('0.00 seconds')) throw new H3AuditError('i2va preamble must anchor at 0.00 seconds')
}

function auditFl2vaPreamble(preamble: string, durationSeconds: number, shotCount: number): void {
  const expected = `${durationSeconds.toFixed(2)}-second`
  if (!preamble.includes('Picture 1') || !preamble.includes('Picture 2')) {
    throw new H3AuditError('fl2va preamble must reference both Picture 1 and Picture 2')
  }
  if (!preamble.includes('0.00-second')) throw new H3AuditError('fl2va preamble must anchor Picture 1 at 0.00 seconds')
  if (!preamble.includes(expected)) {
    throw new H3AuditError(`fl2va preamble must end at ${expected} (two decimal places)`)
  }
  if (!preamble.includes(`Shot ${shotCount}`)) {
    throw new H3AuditError(`fl2va preamble must place Picture 2 at Shot ${shotCount}`)
  }
}

function auditL2vaPreamble(preamble: string, durationSeconds: number, shotCount: number): void {
  const expected = `${durationSeconds.toFixed(2)}-second`
  if (!preamble.includes('<Picture 1>')) throw new H3AuditError('l2va preamble must reference <Picture 1>')
  if (!preamble.includes(expected)) {
    throw new H3AuditError(`l2va preamble must end at ${expected} (two decimal places)`)
  }
  if (!preamble.includes(`[Shot ${shotCount}]`)) {
    throw new H3AuditError(`l2va preamble must place Picture 1 at Shot ${shotCount}`)
  }
}

/* ── Stage dispatchers（audit.py audit_* 移植，findings → 归类 rule）── */

/* ── Phase 4（h3-director-depth）：constraints 尾块审计 ──
 * 可选特性：文本含 `constraints: ` 块时校验——至多一个、必须是最后一个字段（其后不得再出现已知字段头）、
 * body 非空且不含 [Shot N] 标记。校验通过后把块从正文剥离再跑字段/时间线审计，避免块体污染字段切分。 */

const CONSTRAINTS_MATCHER = /(^|\n)constraints: /g
const KNOWN_FIELD_HEADERS: ReadonlySet<string> = new Set([...T2VA_FIELDS, ...REF2VA_FIELDS])

export function extractTrailingConstraints(text: string): { core: string; errors: string[]; body: string | null } {
  const matches = [...text.matchAll(CONSTRAINTS_MATCHER)]
  if (matches.length === 0) return { core: text, errors: [], body: null }
  const errors: string[] = []
  if (matches.length > 1) {
    errors.push(`multiple constraints blocks (${matches.length}): only one trailing constraints block is allowed`)
  }
  const first = matches[0]
  const body = text.slice((first.index ?? 0) + first[0].length)
  if (!body.trim()) errors.push('constraints block must have a non-empty body')
  const laterField = [...body.matchAll(/(^|\n)([a-z_]+): /g)].find((m) => KNOWN_FIELD_HEADERS.has(m[2]))
  if (laterField) {
    errors.push(`constraints must be the final field (found field ${JSON.stringify(laterField[2])} after it)`)
  }
  if (body.includes('[Shot ')) {
    errors.push('constraints block must not contain [Shot N] markers')
  }
  return { core: text.slice(0, first.index), errors, body }
}

function findingsToGates(stage: string, findings: string[], ruleOf?: (msg: string) => string): AuditGate[] {
  return findings.map((msg) => {
    const rule = ruleOf ? ruleOf(msg) : 'h3_audit'
    return {
      rule,
      target: 'h3',
      // 语义闸门分层（spec §10.1）：shot_execution 是启发式（不可判定），降级 important；确定性闸门保持 critical
      severity: rule === 'shot_execution' ? 'important' : 'critical',
      detail: msg,
      source: 'audit/rules-h3',
    }
  })
}

/* ── T13 F1（Ruling #10）：compile 前置官方契约闸门（对齐 contracts.py parseRequest 语义）── */

export function contractGatesH3(stage: string, shots: { duration_seconds: number; shots: unknown[] }, refs: unknown[]): AuditGate[] {
  const gates: AuditGate[] = []
  const d = shots.duration_seconds
  if (!(4 <= d && d <= 15)) {
    gates.push({
      rule: 'parse_request', target: 'h3', severity: 'critical',
      detail: `duration_seconds must be between 4 and 15 (MiniMax H3 official envelope), got ${d}`,
      source: 'audit/rules-h3',
    })
  }
  const cap = 1 + Math.floor((d - 1) / 3)
  if (shots.shots.length === 0) {
    gates.push({ rule: 'parse_request', target: 'h3', severity: 'critical', detail: 'shots must be a non-empty array', source: 'audit/rules-h3' })
  } else if (shots.shots.length > cap) {
    gates.push({
      rule: 'parse_request', target: 'h3', severity: 'critical',
      detail: `${shots.shots.length} shots exceed the maximum ${cap} for ${d}s (1 + floor((duration-1)/3))`,
      source: 'audit/rules-h3',
    })
  }
  // Phase 2（h3-director-depth）：per-shot duration 契约——全部显式或全部缺省；显式时总和 ≡ duration_seconds
  const rawShotList = shots.shots as Array<Record<string, unknown> | null>
  const durVals = rawShotList.map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>)['duration'] : undefined))
  const explicitDurs = durVals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)
  if (explicitDurs.length > 0 && explicitDurs.length < durVals.length) {
    gates.push({
      rule: 'shot_duration_mixed', target: 'h3', severity: 'critical',
      detail: `per-shot duration: 全部镜头显式或全部缺省，禁止混合（当前 ${explicitDurs.length}/${durVals.length} 显式；非正数/非数值视同缺省）`,
      source: 'audit/rules-h3',
    })
  } else if (explicitDurs.length > 0 && explicitDurs.length === durVals.length) {
    const sum = explicitDurs.reduce((a, b) => a + b, 0)
    if (Math.abs(sum - d) > 1e-6) {
      gates.push({
        rule: 'shot_duration_sum', target: 'h3', severity: 'critical',
        detail: `Σ per-shot duration (${sum}s) must equal duration_seconds (${d}s)`,
        source: 'audit/rules-h3',
      })
    }
    for (const v of explicitDurs) {
      if (v < 0.4) {
        gates.push({
          rule: 'shot_duration_short', target: 'h3', severity: 'minor',
          detail: `per-shot duration ${v}s < 0.4s：H3 单镜过短，建议合并镜头或加长该镜`,
          source: 'audit/rules-h3',
        })
      }
    }
  }
  const refCount = refs.length
  if (stage === 'ref2va') {
    if (refCount !== 1 && refCount !== 3) {
      gates.push({
        rule: 'ref_count', target: 'h3', severity: 'critical',
        detail: `ref2va requires 1 or 3 picture references, got ${refCount}`,
        source: 'audit/rules-h3',
      })
    }
  } else if (stage === 't2va') {
    if (refCount > 0) {
      gates.push({
        rule: 'refs_on_stage_rejected', target: 'h3', severity: 'critical',
        detail: `t2va takes no references; route to ref2va / i2va / fl2va / l2va`,
        source: 'audit/rules-h3',
      })
    }
  } else {
    // keyframe（i2va/fl2va/l2va）：1-2 图片引用
    if (refCount === 0) {
      gates.push({ rule: 'ref_count', target: 'h3', severity: 'critical', detail: `${stage} requires at least one picture reference`, source: 'audit/rules-h3' })
    } else if (refCount > 2) {
      gates.push({ rule: 'ref_count', target: 'h3', severity: 'critical', detail: `${stage} requires 1 or 2 picture references, got ${refCount}`, source: 'audit/rules-h3' })
    }
  }
  return gates
}

function ruleForMessage(msg: string): string {
  // 顺序即优先级：先特异性后通用
  if (msg.includes('constraints')) return 'constraints_block'
  if (msg.includes('fields are not in the required')) return 'field_order'
  if (msg.includes('overall_soundscape') || msg.includes('non_diegetic_music')) return 'soundscape_dialogue'
  if (msg.includes('reference') || msg.includes('Subject') || msg.includes('Picture')) return 'label_resolution'
  if (msg.includes('preamble') || msg.includes('alignment')) return 'alignment_preamble'
  if (msg.includes('dialogue')) return 'dialogue_markup'
  if (msg.includes('sequential') || msg.includes('timestamp') || msg.includes('MM:SS')) return 'cut_timestamps'
  if (msg.includes('declared shot count')) return 'shot_count'
  if (msg.includes('max_shots') || msg.includes('exceed the maximum')) return 'max_shots'
  if (msg.includes('field')) return 'field_order'
  if (msg.includes('executable content') || msg.includes('transition and new view') || msg.includes('no new information')) return 'shot_execution'
  if (msg.includes('prompt length') || msg.includes('character maximum')) return 'char_budget'
  return 'h3_audit'
}

function auditT2va(text: string, durationSeconds: number, shotCount: number): string[] {
  const findings: string[] = []
  checkCharBudget(text, findings)
  const { core, errors } = extractTrailingConstraints(text)
  findings.push(...errors)
  try {
    const fields = splitFields(core, T2VA_FIELDS)
    auditTimeline(fields['integrated_multimodal_description'], durationSeconds, shotCount)
    auditSoundMusicSeparation(fields['overall_soundscape'], fields['non_diegetic_music'])
  } catch (e) {
    if (e instanceof H3AuditError) findings.push(e.message)
    else throw e
  }
  return findings
}

function auditKeyframe(text: string, stage: string, durationSeconds: number, shotCount: number): string[] {
  const findings: string[] = []
  checkCharBudget(text, findings)
  const { core, errors } = extractTrailingConstraints(text)
  findings.push(...errors)
  try {
    const parts = core.split('\n\n')
    if (parts.length < 2) {
      throw new H3AuditError(
        `${stage} prompt must start with the alignment preamble, followed by a blank line and the three core fields`,
      )
    }
    const preamble = parts[0]
    const body = parts.slice(1).join('\n\n')
    if (stage === 'i2va') auditI2vaPreamble(preamble)
    else if (stage === 'fl2va') auditFl2vaPreamble(preamble, durationSeconds, shotCount)
    else if (stage === 'l2va') auditL2vaPreamble(preamble, durationSeconds, shotCount)
    else throw new H3AuditError(`unknown keyframe stage: ${JSON.stringify(stage)}`)
    const fields = splitFields(body, KEYFRAME_FIELDS)
    auditTimeline(fields['integrated_multimodal_description'], durationSeconds, shotCount)
    auditSoundMusicSeparation(fields['overall_soundscape'], fields['non_diegetic_music'])
  } catch (e) {
    if (e instanceof H3AuditError) findings.push(e.message)
    else throw e
  }
  return findings
}

function auditRef2va(text: string, durationSeconds: number, shotCount: number, references: Reference[]): string[] {
  const findings: string[] = []
  checkCharBudget(text, findings)
  const { core, errors } = extractTrailingConstraints(text)
  findings.push(...errors)
  try {
    const fields = splitFields(core, REF2VA_FIELDS)
    auditReferenceLabels(
      fields['subject_definitions'],
      `${fields['retention_analysis']}\n${fields['detailed_description']}`,
      references,
    )
    auditTimeline(fields['detailed_description'], durationSeconds, shotCount)
    auditSoundMusicSeparation(fields['overall_soundscape'], fields['non_diegetic_music'])
  } catch (e) {
    if (e instanceof H3AuditError) findings.push(e.message)
    else throw e
  }
  return findings
}

export type H3AuditMeta = { stage: string; duration: number; shotCount: number }

/** brief 接口：auditH3(text, meta) → AuditGate[]（无引用输入时跳过 ref2va 标签闸门） */
export function auditH3(text: string, meta: H3AuditMeta): AuditGate[] {
  const stage = meta.stage
  let findings: string[]
  if (stage === 't2va') {
    findings = auditT2va(text, meta.duration, meta.shotCount)
  } else if (KEYFRAME_STAGES.has(stage)) {
    findings = auditKeyframe(text, stage, meta.duration, meta.shotCount)
  } else if (stage === 'ref2va') {
    // 标签闸门需要真实引用（T7 接线时传入）；此处无引用时仅跑结构/时间线/声景闸门
    findings = []
    const local: string[] = []
    checkCharBudget(text, local)
    try {
      const fields = splitFields(text, REF2VA_FIELDS)
      auditTimeline(fields['detailed_description'], meta.duration, meta.shotCount)
      auditSoundMusicSeparation(fields['overall_soundscape'], fields['non_diegetic_music'])
    } catch (e) {
      if (e instanceof H3AuditError) local.push(e.message)
      else throw e
    }
    findings = local
  } else {
    throw new Error(`unknown stage: ${JSON.stringify(stage)}`)
  }
  return findingsToGates(stage, findings, ruleForMessage)
}

/** 完整闸门（含 ref2va 引用标签解析）。references 兼容两种传法：meta.references（T6 旧式）或第三参（新式，raw 形状） */
export function auditH3Full(
  text: string,
  meta: H3AuditMeta & { references?: Reference[] },
  refs?: unknown[],
): AuditGate[] {
  const stage = meta.stage
  if (stage === 'ref2va') {
    const combined: Reference[] = refs
      ? refs.map((r) => {
          const raw = r as Record<string, unknown>
          return {
            who: raw['who'] != null ? String(raw['who']) : null,
            image: String(raw['image'] ?? ''),
            width: typeof raw['width'] === 'number' ? raw['width'] : null,
            height: typeof raw['height'] === 'number' ? raw['height'] : null,
          }
        })
      : (meta.references ?? [])
    const findings = auditRef2va(text, meta.duration, meta.shotCount, combined)
    return findingsToGates(stage, findings, ruleForMessage)
  }
  return auditH3(text, meta)
}

/* ── multishot.py 移植（compile_plan 校验 → gates）── */

export interface ShotDraft {
  shot: number
  content: string
  camera: string
  transition: string
  soundFocus: string
  composition: string
  action: string
  entryState: string
  exitState: string
  narrativeFunction: string
  shotSize: string
  activeReferences: string[]
  start: number | null
  end: number | null
}

export interface MultishotPlan {
  totalDuration: number
  shotCount: number
  editRhythm: string
  continuityStrategy: string
  shots: ShotDraft[]
  continuityLedger: Record<string, string>
}

export function shotDraftFromDict(raw: Record<string, unknown>, index: number): ShotDraft {
  const start = raw['start']
  const end = raw['end']
  return {
    shot: index,
    content: String(raw['content'] ?? ''),
    camera: String(raw['camera'] ?? ''),
    transition: String(raw['transition'] ?? ''),
    soundFocus: String(raw['sound_focus'] ?? ''),
    composition: String(raw['composition'] ?? ''),
    action: String(raw['action'] ?? ''),
    entryState: String(raw['entry_state'] ?? ''),
    exitState: String(raw['exit_state'] ?? ''),
    narrativeFunction: String(raw['narrative_function'] ?? ''),
    shotSize: String(raw['shot_size'] ?? ''),
    activeReferences: Array.isArray(raw['active_references']) ? (raw['active_references'] as string[]).map(String) : [],
    start: typeof start === 'number' && typeof start !== 'boolean' ? start : null,
    end: typeof end === 'number' && typeof end !== 'boolean' ? end : null,
  }
}

function validateTiming(plan: MultishotPlan): string[] {
  const findings: string[] = []
  if (!plan.shots.every((s) => s.start != null && s.end != null)) return findings
  let prevEnd = 0.0
  for (const shot of plan.shots) {
    if (Math.abs(shot.start! - prevEnd) > 1e-6) {
      findings.push(`shot ${shot.shot} start (${shot.start}) does not connect to previous shot end (${prevEnd})`)
    }
    if (shot.end! <= shot.start!) {
      findings.push(`shot ${shot.shot} end (${shot.end}) must be after start (${shot.start})`)
    }
    if (shot.end! > plan.totalDuration) {
      findings.push(`shot ${shot.shot} end (${shot.end}) exceeds total_duration (${plan.totalDuration})`)
    }
    prevEnd = shot.end!
  }
  if (Math.abs(prevEnd - plan.totalDuration) > 1e-6) {
    findings.push(`final shot end (${prevEnd}) does not match total_duration (${plan.totalDuration})`)
  }
  return findings
}

/** multishot.py compile_plan → findings；空数组 = 成功 */
export function compilePlan(plan: MultishotPlan): string[] {
  const findings: string[] = []
  if (!(4 <= plan.totalDuration && plan.totalDuration <= 15)) {
    findings.push(`total_duration ${plan.totalDuration} outside [4, 15]`)
  }
  const cap = 1 + Math.floor((plan.totalDuration - 1) / 3)
  if (plan.shotCount <= 0) findings.push('shot_count must be a positive integer')
  else if (plan.shotCount > cap) {
    findings.push(`shot_count ${plan.shotCount} exceeds max_shots ${cap} for ${plan.totalDuration}s`)
  }
  if (plan.shots.length !== plan.shotCount) {
    findings.push(`shots length ${plan.shots.length} does not match shot_count ${plan.shotCount}`)
  }
  for (const shot of plan.shots) {
    if (!shot.content.trim()) findings.push(`shot ${shot.shot}.content must be non-empty`)
    if (shot.shot < 1 || shot.shot > plan.shotCount) {
      findings.push(`shot index ${shot.shot} out of [1, ${plan.shotCount}]`)
    }
  }
  for (const fieldName of ['identity', 'wardrobe_and_props']) {
    if (!(plan.continuityLedger[fieldName] ?? '').trim()) {
      findings.push(`continuity_ledger.${fieldName} must be non-empty`)
    }
  }
  findings.push(...validateTiming(plan))
  return findings
}

/** multishot.py compile_to_shots 移植：plan shots → H3Shot[]。
 *  Phase 5（h3-director-depth）扩展投影：camera/shotSize/composition → camera；action → action；
 *  entry/exit → carry；narrativeFunction → what 前缀；start/end → 显式 per-shot duration（供累计切点）。
 *  此前仅投影 content + soundFocus，导演字段被静默丢弃。 */
export function compilePlanToShots(plan: MultishotPlan): H3Shot[] {
  return plan.shots.map((draft) => {
    const duration = draft.start != null && draft.end != null && draft.end > draft.start
      ? Math.round((draft.end - draft.start) * 1000) / 1000
      : undefined
    const cameraParts = [draft.camera, draft.shotSize, draft.composition].map((x) => x.trim()).filter(Boolean)
    const carryParts: string[] = []
    if (draft.entryState.trim()) carryParts.push(`Entry: ${draft.entryState.trim()}`)
    if (draft.exitState.trim()) carryParts.push(`Exit: ${draft.exitState.trim()}`)
    const content = draft.content.trim()
    const narrative = draft.narrativeFunction.trim()
    return {
      what: narrative ? `${narrative}. ${content}` : content,
      who: undefined,
      ...(duration != null && duration > 0 ? { duration } : {}),
      ...(cameraParts.length > 0 ? { camera: cameraParts.join('; ') } : {}),
      ...(draft.action.trim() ? { action: draft.action.trim() } : {}),
      ...(carryParts.length > 0 ? { carry: carryParts.join('; ') } : {}),
      ambient: draft.soundFocus || undefined,
      music: undefined,
      dialogue: undefined,
    }
  })
}

/** Phase 5：snake_case plan dict → MultishotPlan（multishot.py plan 输入形状） */
export function multishotPlanFromDict(raw: Record<string, unknown>): MultishotPlan {
  const rawShots = Array.isArray(raw['shots']) ? (raw['shots'] as Record<string, unknown>[]) : []
  const ledger = (raw['continuity_ledger'] ?? {}) as Record<string, unknown>
  return {
    totalDuration: typeof raw['total_duration'] === 'number' ? raw['total_duration'] : Number.NaN,
    shotCount: typeof raw['shot_count'] === 'number' ? raw['shot_count'] : 0,
    editRhythm: String(raw['edit_rhythm'] ?? ''),
    continuityStrategy: String(raw['continuity_strategy'] ?? ''),
    shots: rawShots.map((s, i) => shotDraftFromDict(s, i + 1)),
    continuityLedger: {
      identity: String(ledger['identity'] ?? ''),
      wardrobe_and_props: String(ledger['wardrobe_and_props'] ?? ''),
    },
  }
}

/** Phase 5：形状探测——shot_count/total_duration 存在，或 shots[0] 带 content 而无 what（plan 形状） */
export function looksLikeMultishotPlan(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const r = raw as Record<string, unknown>
  if (r['shot_count'] != null || r['total_duration'] != null) return true
  const shots = r['shots']
  if (Array.isArray(shots) && shots.length > 0 && typeof shots[0] === 'object' && shots[0] !== null) {
    const first = shots[0] as Record<string, unknown>
    return first['content'] != null && first['what'] == null
  }
  return false
}

/** Phase 5：plan → 校验 → shots 转换单点（prompt_compile 的 sceneToShotsChecked 同款契约）。
 *  critical gate 存在时 shots=undefined（调用方以 gates 呈现失败）；否则产出可用 H3ShotsInput。 */
export function planToShotsChecked(raw: unknown): { shots?: H3ShotsInput; gates: AuditGate[]; advisories: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      gates: [{
        rule: 'plan_shape', target: 'h3', severity: 'critical',
        detail: 'plan 输入需为对象 {total_duration, shot_count, shots[], continuity_ledger}',
        source: 'audit/rules-h3',
      }],
      advisories: [],
    }
  }
  const plan = multishotPlanFromDict(raw as Record<string, unknown>)
  const gates = auditMultishotPlan(plan)
  if (gates.some((g) => g.severity === 'critical')) return { gates, advisories: [] }
  return { shots: { duration_seconds: plan.totalDuration, shots: compilePlanToShots(plan) }, gates, advisories: [] }
}

function multishotRuleForMessage(msg: string): string {
  if (msg.includes('total_duration')) return 'plan_duration'
  if (msg.includes('shot_count') || msg.includes('shots length') || msg.includes('shot index')) return 'plan_shot_count'
  if (msg.includes('content must be non-empty')) return 'plan_content'
  if (msg.includes('continuity_ledger')) return 'plan_ledger'
  return 'plan_timing'
}

export function auditMultishotPlan(plan: MultishotPlan): AuditGate[] {
  return compilePlan(plan).map((msg) => ({
    rule: multishotRuleForMessage(msg),
    target: 'h3',
    severity: 'critical',
    detail: msg,
    source: 'audit/rules-h3',
  }))
}