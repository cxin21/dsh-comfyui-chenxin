/**
 * Anima 编译/审计/关系覆盖 TS 归化（P2 核心）。
 * 逐函数对照：composition.py / grounding.py / output.py / inspection.py / types.py（facets.normalize 经 anima-catalog）。
 * A14 修正：canonical/alias → 直用 catalog.prompt_form；fuzzy/miss → 保留原文 + catalog_miss advisory/assumption（不自动替换）。
 */
import { SLOT_ORDER } from '../anima.js'
import { normalizeTag, searchCatalog, overlayStatus, queryCatalogInternal, type CatalogHit } from './anima-catalog.js'
import { registerDialect } from './registry.js'
import type { DialectContract } from './contract.js'
import { ANIMA_PERSONA, ANIMA_SCHEMA } from '../intent/subagent-provider.js'
import { ANIMA_RUBRIC } from '../eval/rubrics/anima.js'
import type { AuditGate } from '../types.js'

export interface AnimaSlots {
  count_gender?: string[]
  character?: string[]
  appearance?: string[]
  clothing?: string[]
  pose_action?: string[]
  expression?: string[]
  camera?: string[]
  scene?: string[]
  detail_mood?: string[]
  narrative?: string
  explicit?: boolean
  /** 扩展（brief 接口之外的官方 brief 字段） */
  qualityPrefix?: boolean
  exclusions?: string[]
  subject?: string
}

export interface CompileAnimaOptions {
  variant?: 'base' | 'aesthetic' | 'turbo'
  search?: (tag: string) => CatalogHit[]
}

export interface CompileAnimaResult {
  positive: string
  negative: string
  notes: string[]
  assumptions: string[]
  /** G2：author 载荷投影（segments/phase_status/metadata 为附加投影，positive/negative 逐字节不变） */
  segments: AnimaSegment[]
  phase_status: { policy: 'PASS'; grounding: 'PASS' | 'ADVISORY'; composition: 'PASS'; inspection: 'PASS' | 'ADVISORY' }
  metadata: { variant: string; subject?: string }
}

/** G2：segment 溯源条目（对照 cli.py _segments_payload） */
export interface AnimaSegment {
  segment_id: string
  text: string
  channel: 'positive' | 'negative'
  origin: 'policy' | 'grounded' | 'user-fuzzy' | 'narrative' | 'exclusion'
  priority: number
  slot: string | null
  citation: AnimaCitation | null
}

export interface AnimaCitation {
  text: string
  record_id: string | null
  canonical: string | null
  prompt_form: string | null
  source: string | null
  match_type: 'canonical' | 'alias' | 'fuzzy' | 'miss'
}

const GROUNDED = new Set(['canonical', 'alias'])

/** G2：citations.source 溯源（实测真库 schema：sources 无 value 列；golden 的 source 字符串即
 *  sources.source_id 本身（如 `gelbooru_canonical:4dd8…`），records.source_ids 是 JSON 数组字符串，
 *  故经 json_each 展开 join。查询失败/无行 → null（不阻断编译）。 */
const SOURCE_SQL =
  'SELECT s.source_id AS value FROM sources s JOIN records r ON r.record_id=? JOIN json_each(r.source_ids) je ON je.value=s.source_id LIMIT 1'

function lookupSource(recordId: string): string | null {
  try {
    const rows = queryCatalogInternal(SOURCE_SQL, [recordId]) as Array<{ value?: string }>
    return rows[0]?.value ?? null
  } catch {
    return null
  }
}

interface Policy {
  variant: string
  mandatoryPositive: string[]
  mandatoryNegative: string[]
  safetySeed: string[]
}

/** types.py ModelPolicy.for_variant 移植（variant 策略表） */
const POLICIES: Record<string, Policy> = {
  base: {
    variant: 'base',
    mandatoryPositive: ['masterpiece', 'best quality', 'score_7'],
    mandatoryNegative: ['worst quality', 'low quality', 'score_1', 'score_2', 'score_3'],
    safetySeed: ['safe'],
  },
  aesthetic: {
    variant: 'aesthetic',
    mandatoryPositive: ['masterpiece', 'best quality'],
    mandatoryNegative: ['worst quality', 'low quality'],
    safetySeed: ['safe'],
  },
  turbo: {
    variant: 'turbo',
    mandatoryPositive: ['masterpiece', 'best quality'],
    mandatoryNegative: ['worst quality', 'low quality'],
    safetySeed: ['safe'],
  },
}

/** types.py EXPLICIT_SAFETY_MARKERS 逐字 */
const EXPLICIT_SAFETY_MARKERS = [
  'explicit', 'nude', 'nudity', 'genitals', 'genital', 'vulva', 'penis',
  '乳头', '乳房', '生殖器', '阴部', '阴茎', '阴道', '隐私部位', '裸露', '露骨', '色情', 'pornographic', 'nsfw',
]

/** types.py is_explicit_request 移植 */
export function isExplicitRequest(slots: AnimaSlots): boolean {
  if (slots.explicit === true) return true
  const pieces: string[] = [slots.subject ?? '', slots.narrative ?? '']
  for (const key of SLOT_ORDER) {
    pieces.push(...(slotOf(slots, key) ?? []).map((t) => String(t)))
  }
  pieces.push(...(slots.exclusions ?? []).map((e) => String(e)))
  const corpus = pieces.join(' ').toLowerCase()
  return EXPLICIT_SAFETY_MARKERS.some((m) => corpus.includes(m))
}

export function slotOf(slots: AnimaSlots, key: string): string[] | undefined {
  return (slots as Record<string, string[] | undefined>)[key]
}

/** grounding.py ground 移植：canonical/alias → Citation；fuzzy/miss → match_type 'miss'（原文保留主体在 compile 层） */
export function groundSlotTags(slots: AnimaSlots, search: (tag: string) => CatalogHit[]): Map<string, AnimaCitation> {
  const citations = new Map<string, AnimaCitation>()
  for (const key of SLOT_ORDER) {
    for (const raw of slotOf(slots, key) ?? []) {
      const text = String(raw)
      if (!text.trim()) continue
      const nkey = normalizeTag(text)
      if (citations.has(nkey)) continue
      const hits = search(text) // 默认 limit 1（T8 searchCatalog 缺省 20 → 调用方传 {limit:1}）
      const top = hits[0]
      if (!top || !top.match_type || !GROUNDED.has(top.match_type)) {
        citations.set(nkey, { text, record_id: null, canonical: null, prompt_form: null, source: null, match_type: 'miss' })
        continue
      }
      citations.set(nkey, {
        text,
        record_id: top.record_id ?? null,
        canonical: top.prompt_form ?? top.raw ?? null,
        prompt_form: top.prompt_form ?? null,
        source: top.record_id ? lookupSource(top.record_id) : null,
        match_type: top.match_type as 'canonical' | 'alias',
      })
    }
  }
  return citations
}

/** 取 fuzzy 候选（详细 advisory 用）：顶层 fuzzy hits 的 prompt_form（≤3） */
export function fuzzyCandidates(tag: string, search: (tag: string) => CatalogHit[]): string[] {
  return search(tag).filter((h) => h.match_type === 'fuzzy').slice(0, 3).map((h) => h.prompt_form ?? h.raw ?? '').filter(Boolean)
}

/** composition.py _build 移植：策略→安全→槽(权重)→narrative→exclusions 组装 */
export function compileAnima(slots: AnimaSlots, opts?: CompileAnimaOptions): CompileAnimaResult {
  const variant = opts?.variant ?? 'base'
  const search: (t: string) => CatalogHit[] = opts?.search ?? ((t: string) => searchCatalog(t, { limit: 1 }))
  const policy = POLICIES[variant] ?? POLICIES.base
  const qualityPrefix = slots.qualityPrefix ?? true
  const citations = groundSlotTags(slots, search)

  let positive: string[] = []
  let negative: string[] = []
  const notes: string[] = []
  const assumptions: string[] = []
  const missedKeys = new Set<string>()
  /** G2：段级溯源投影（与 positive/negative push 同序，join 后逐字节等价——由 fidelity golden 把关） */
  const segments: AnimaSegment[] = []
  const pushSeg = (text: string, channel: 'positive' | 'negative', origin: AnimaSegment['origin'], priority: number, slot: string | null = null, citation: AnimaCitation | null = null): void => {
    segments.push({ segment_id: `seg${segments.length + 1}`, text, channel, origin, priority, slot, citation })
    if (channel === 'positive') positive.push(text)
    else negative.push(text)
  }

  // 3a: 策略质量词（quality_prefix 门控）
  if (qualityPrefix) {
    for (const t of policy.mandatoryPositive) pushSeg(t, 'positive', 'policy', 100)
    for (const t of policy.mandatoryNegative) pushSeg(t, 'negative', 'policy', 100)
  }
  // 3b: 安全种子（explicit 关断）
  if (!isExplicitRequest(slots)) {
    for (const t of policy.safetySeed) pushSeg(t, 'positive', 'policy', 99)
    assumptions.push('safety_seed_injected:default_for_non_explicit_request')
  }
  // 3c: 槽固定 SLOT_ORDER（权重即顺序）——不跨槽去重：忠实复刻上游 composition.py（无去重），
  // 跨槽重复由审计稿 duplicate_segment gate 标记（闭环里模型据 `[duplicate_segment]` 自修正）
  SLOT_ORDER.forEach((slotName, slotIndex) => {
    const tags = slotOf(slots, slotName)
    if (!tags || !tags.length) return
    const base = 200 + slotIndex * 50
    tags.forEach((raw, tagIndex) => {
      const tag = String(raw)
      const citation = citations.get(normalizeTag(tag))
      let text: string
      if (citation && citation.match_type && GROUNDED.has(citation.match_type)) {
        text = citation.prompt_form ?? tag
      } else {
        text = tag
        if (citation && citation.match_type === 'miss') {
          const nkey = normalizeTag(tag)
          if (!missedKeys.has(nkey)) {
            missedKeys.add(nkey)
            assumptions.push(`catalog_miss:${tag}`)
          }
        }
      }
      pushSeg(text, 'positive', citation && citation.match_type && GROUNDED.has(citation.match_type) ? 'grounded' : 'user-fuzzy', base + tagIndex, slotName, citation ?? null)
    })
  })
  // 3d: narrative 最后
  if (slots.narrative && slots.narrative.trim()) {
    pushSeg(slots.narrative.trim(), 'positive', 'narrative', 2000)
  }
  // 3e: exclusions → negative（原样）
  for (const e of slots.exclusions ?? []) pushSeg(String(e), 'negative', 'exclusion', 900)

  // 3f: grounded 引用 notes
  for (const citation of citations.values()) {
    if (citation.match_type && GROUNDED.has(citation.match_type) && citation.record_id) {
      notes.push(`citation:${citation.record_id}:match=${citation.match_type}:canonical=${citation.canonical}`)
    }
  }

  // 派生字符串（与 segments 同源）：等价性证明 = fidelity golden 13 用例逐字节比对
  const positiveText = segments.filter((s) => s.channel === 'positive').map((s) => s.text).join(', ')
  const negativeText = segments.filter((s) => s.channel === 'negative').map((s) => s.text).join(', ')

  // G2 phase_status：policy/composition 恒 PASS；grounding = 存在 record_id citation；
  // inspection = 审计 gates 有 important+（本插件 Severity 联合为 critical|important|minor，
  // 无独立 'conflict' 值）→ ADVISORY。tag_count_out_of_range 例外不计：
  // 工作区间 12-50 之外的短 brief（含本规范自测用例 count_gender:['1girl']）是常规合法输入，
  // 该软性计数 advisory（闭环内自修正项）不降级 inspection 阶段。
  const gates = auditAnima(positiveText, negativeText, { variant, slots, search })
  const grounding: 'PASS' | 'ADVISORY' = [...citations.values()].some((c) => c.record_id) ? 'PASS' : 'ADVISORY'
  const inspection: 'PASS' | 'ADVISORY' = gates.some((g) => g.severity === 'critical' || (g.severity === 'important' && g.rule !== 'tag_count_out_of_range')) ? 'ADVISORY' : 'PASS'

  const metadata: CompileAnimaResult['metadata'] = { variant }
  if (slots.subject !== undefined) metadata.subject = slots.subject

  return {
    positive: positiveText,
    negative: negativeText,
    notes,
    assumptions,
    segments,
    phase_status: { policy: 'PASS', grounding, composition: 'PASS', inspection },
    metadata,
  }
}

/* ── inspection.py 移植（audit gates）── */

const LIGHTING_BAN = [
  'sunlight', 'moonlight', 'rim light', 'warm lighting', 'cool lighting',
  'golden hour glow', 'soft lighting', 'backlighting', 'god rays',
  'light rays', 'volumetric light', 'spotlight', 'candlelight',
  'warm tone', 'cool tone', 'sepia',
  'light particles', 'backlit',
  // 注：去掉了 'neon light'/'streetlights' —— 它们是场景光源对象（霓虹灯/街灯是画面内容），
  // 不是光照渲染 LoRA 触发词；保留的是 true light-effect 词（Anima3 §2 语义）
]

const MUTUAL_EXCLUSIONS: Array<[string, string]> = [
  ['from front', 'from behind'],
  ['from above', 'from below'],
  ['pov', 'full body'],
  ['close-up', 'full body'],
  ['looking at viewer', 'facing away'],
]

const TAG_COUNT_MIN = 12
const TAG_COUNT_MAX = 50

function normalizeText(value: string): string {
  return normalizeTag(value)
}

/** inspection.py 逐函数移植：advisories → AuditGate[]（severity 映射：warning/conflict→important，info→minor；非阻断） */
export function inspectAnima(positive: string, negative: string, opts?: { variant?: string; qualityPrefix?: boolean; explicit?: boolean; contentCount?: number }): AuditGate[] {
  const gates: AuditGate[] = []
  const policy = POLICIES[opts?.variant ?? 'base'] ?? POLICIES.base
  const qualityPrefix = opts?.qualityPrefix ?? true

  // duplicate segments（channel 内）
  for (const [channel, text] of [['positive', positive], ['negative', negative]] as const) {
    const seen = new Set<string>()
    for (const seg of text.split(', ')) {
      const key = seg.trim().toLowerCase()
      if (key) {
        if (seen.has(key)) {
          gates.push({ rule: 'duplicate_segment', target: 'anima', severity: 'important', detail: `duplicate segment in ${channel}: ${seg}`, source: 'dialect/anima' })
        }
        seen.add(key)
      }
    }
  }
  // positive/negative conflict
  const posSet = new Set(positive.split(', ').map((s) => s.trim().toLowerCase()).filter(Boolean))
  const negSet = new Set(negative.split(', ').map((s) => s.trim().toLowerCase()).filter(Boolean))
  const overlap = [...posSet].filter((x) => negSet.has(x)).sort()
  if (overlap.length) {
    gates.push({ rule: 'positive_negative_conflict', target: 'anima', severity: 'important', detail: `same phrase appears in positive and negative: ${overlap[0]}`, source: 'dialect/anima' })
  }
  // weights
  for (const text of [positive, negative]) {
    if ((text.match(/\(/g) ?? []).length !== (text.match(/\)/g) ?? []).length) {
      gates.push({ rule: 'unbalanced_parentheses', target: 'anima', severity: 'important', detail: 'weight parentheses are unbalanced', source: 'dialect/anima' })
    }
    for (const m of text.matchAll(/:\s*([-+]?\d+(?:\.\d+)?)\s*\)?/g)) {
      if (Math.abs(Number(m[1])) > 4) {
        gates.push({ rule: 'abnormal_weight', target: 'anima', severity: 'important', detail: `weight ${m[1]} is unusually large`, source: 'dialect/anima' })
      }
    }
  }
  // lighting ban
  const lightText = ' ' + normalizeText(positive) + ' '
  const found = LIGHTING_BAN.filter((term) => lightText.includes(term)).sort()
  if (found.length) {
    gates.push({ rule: 'lighting_term_banned', target: 'anima', severity: 'important', detail: `lora-internal lighting term(s) present: ${found.join(', ')}`, source: 'dialect/anima' })
  }
  // mutual exclusion
  for (const [first, second] of MUTUAL_EXCLUSIONS) {
    if (lightText.includes(first) && lightText.includes(second)) {
      gates.push({ rule: 'mutual_exclusion', target: 'anima', severity: 'important', detail: `mutually exclusive tags: ${first} + ${second}`, source: 'dialect/anima' })
    }
  }
  // tag count（F1：segment 语义——调用方按「槽标签逐项 + narrative 整段计 1」提供 contentCount；
  // 缺省才回退 token 拆分估算，仅脱机近似、不进 golden 路径）
  const contentCount =
    opts?.contentCount ??
    positive.split(', ').map((s) => s.trim()).filter(Boolean).filter((t) => !new Set([...(qualityPrefix ? policy.mandatoryPositive : []), 'safe']).has(t)).length
  if (!(TAG_COUNT_MIN <= contentCount && contentCount <= TAG_COUNT_MAX)) {
    gates.push({ rule: 'tag_count_out_of_range', target: 'anima', severity: 'important', detail: `${contentCount} content tags (working range ${TAG_COUNT_MIN}-${TAG_COUNT_MAX})`, source: 'dialect/anima' })
  }

  return gates
}

/** auditAnima：audit gates（含 catalog_miss —— 需要 slots+search 时生成） */
export function auditAnima(positive: string, negative: string, opts?: CompileAnimaOptions & { slots?: AnimaSlots }): AuditGate[] {
  const gates: AuditGate[] = []
  const search: (t: string) => CatalogHit[] = opts?.search ?? ((t: string) => searchCatalog(t, { limit: 5 }))
  const variant = opts?.variant ?? 'base'
  // catalog_miss（A14：保留原文 + advisory；候选作建议）
  if (opts?.slots) {
    const missed = new Set<string>()
    for (const key of SLOT_ORDER) {
      for (const raw of slotOf(opts.slots, key) ?? []) {
        const text = String(raw)
        const hits = search(text)
        const top = hits[0]
        if (!top || !top.match_type || !GROUNDED.has(top.match_type)) {
          const nkey = normalizeTag(text)
          if (nkey && !missed.has(nkey)) {
            missed.add(nkey)
            const candidates = fuzzyCandidates(text, search).join(' / ')
            gates.push({
              rule: 'catalog_miss',
              target: 'anima',
              severity: 'minor',
              detail: candidates ? `catalog_miss:${text}（保留原文未替换；catalog 候选可考虑: ${candidates}）` : `catalog_miss:${text}（保留原文未替换）`,
              source: 'dialect/anima',
            })
          }
        }
      }
    }
  }
  gates.push(...inspectAnima(positive, negative, {
    variant,
    qualityPrefix: opts?.slots?.qualityPrefix ?? true,
    explicit: opts?.slots?.explicit,
    contentCount: opts?.slots
      ? SLOT_ORDER.reduce((sum, key) => sum + (slotOf(opts.slots!, key)?.length ?? 0), 0) + (opts.slots.narrative ? 1 : 0)
      : undefined,
  }))
  return gates
}

/** relation_overlay 降级挂载（先查 overlayStatus，缺失 → advisory；void 契约） */
let _overlayAdvisories: string[] = []
export function overlayAdvisory(): string[] {
  return [..._overlayAdvisories]
}

export function applyRelationOverlay(catalog: { overlayStatus(): string }): void {
  if (catalog.overlayStatus() !== 'available') {
    _overlayAdvisories = ['overlay_unavailable']
  }
}

/** 便捷导出：variant 策略表供报告/测试 */
export function variantPolicy(variant: string): Policy {
  return POLICIES[variant] ?? POLICIES.base
}

/* ── Task 5：方言注册（validateAnimaSlots 收敛 _coerce_brief 校验）── */

const ANIMA_SLOT_KEYS = new Set(['count_gender', 'character', 'appearance', 'clothing', 'pose_action', 'expression', 'camera', 'scene', 'detail_mood'])
/** brief 扩展字段（composition.py _coerce_brief 契约）：exclusions string[]；qualityPrefix/explicit boolean */
const ANIMA_BOOL_KEYS = new Set(['qualityPrefix', 'explicit'])

/** composition.py _coerce_brief 移植：槽位键白名单 + 类型校验（narrative string、exclusions string[]、qualityPrefix/explicit boolean、其余槽 string[]） */
export function validateAnimaSlots(slots: unknown): string | undefined {
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return 'anima 需要 slots 对象'
  const s = slots as Record<string, unknown>
  for (const k of Object.keys(s)) {
    if (k === 'narrative') { if (typeof s[k] !== 'string') return 'narrative 需为 string'; continue }
    if (k === 'exclusions') { if (!Array.isArray(s[k]) || (s[k] as unknown[]).some((x) => typeof x !== 'string')) return 'exclusions 需为 string[]'; continue }
    if (k === 'subject') { if (typeof s[k] !== 'string') return 'subject 需为 string'; continue }
    if (ANIMA_BOOL_KEYS.has(k)) { if (typeof s[k] !== 'boolean') return `${k} 需为 boolean`; continue }
    if (!ANIMA_SLOT_KEYS.has(k)) return `未知槽位: ${k}`
    if (!Array.isArray(s[k]) || (s[k] as unknown[]).some((x) => typeof x !== 'string')) return `槽位 ${k} 需为 string[]`
  }
  return undefined
}

export function registerAnimaDialect(): void {
  const contract: DialectContract<Record<string, unknown>, { positive: string; negative: string }> = {
    id: 'anima',
    label: 'Anima',
    auditOnlyOk: true,
    normalize: (input) => {
      const slots = (input as { slots?: Record<string, unknown> } | undefined)?.slots
      const err = validateAnimaSlots(slots)
      if (err) return { error: err }
      return { value: slots as Record<string, unknown> }
    },
    compile: (slots, opts) => {
      const variant = (opts.variant as 'base' | 'aesthetic' | 'turbo') ?? 'base'
      return compileAnima(slots as AnimaSlots, { variant })
    },
    audit: (compiled, ctx) => {
      const variant = (ctx.variant as 'base' | 'aesthetic' | 'turbo') ?? 'base'
      const slots = ctx.shots as unknown as AnimaSlots // runStage audit ctx.shots = 归一化 value（slots）
      return { gates: auditAnima(compiled.positive, compiled.negative, { variant, slots }) }
    },
    targetSlotHint: 't2i.prompt',
    rubric: ANIMA_RUBRIC,
    intent: { persona: ANIMA_PERSONA, schema: ANIMA_SCHEMA },
    // 方言包声明（spec §9，Task 4）：能力/约束/审美（license 无官方资产声明）
    capabilities: {
      native_negative: true,           // anima 有独立 negative 通道
      supports_audio: false,           // anima 无音频语法
      supports_dialogue: false,        // anima 无对白语法
      camera_axes: 0,                  // anima camera 为离散角度标签（camera[] 槽），非轴运镜
      media_targets: ['image'],
      aspect_ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],  // 与现有 ASPECT_COMMON 一致
      duration_range: [0, 0],          // image 方言无时长约束（0 = 不适用）
      max_prompt_chars: 0,             // 无官方字符上限（0 = 不适用）
      budget_quality_cap: 0,           // 无 budget 子系统（0 = 不适用）
    },
    constraints: {
      // anima 输入校验走 validateAnimaSlots（返回 error 字符串，非 AuditGate[]）；无契约闸门表 → 空
      validate: () => [],
    },
    aesthetics: {
      forbidden_words: [],       // Phase 2 内容化治理（现有 LIGHTING_BAN 为审计内部私有列表）
      few_shot_examples: [],
      style_hints: [],           // 风格库 Phase 2
    },
  }
  registerDialect(contract)
}

// 模块级副作用注册：plugin/index.ts import 本模块即完成装配
registerAnimaDialect()