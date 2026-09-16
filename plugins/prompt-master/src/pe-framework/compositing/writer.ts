/**
 * S3 成文引擎（spec §6，2026-09-15 管线重设计）：
 * 把语义蓝图 V1 + 检索包翻译为最终 prompt 的 tag 区与 NL 尾。
 * 词表证据是唯一事实来源（T1）；LLM 自由度仅剩「同概念多命中取舍」与「NL 措辞」。
 * 本模块只做 persona/prompt 装配与输出契约解析；机器审计在 audit.ts（T8）。
 */
import { buildTaskText } from '../llm/task-text.js'
import { extractFirstJsonObject } from '../llm/json-extract.js'
import type { RetrievalPack } from '../dialect/retrieval-pack.js'
import type { SemanticBlueprint } from '../blueprint/semantic-schema.js'

/** task_persona 块：角色定位 + few-shot（同构即模板）；硬性规则在 WRITER_RULES（§2.1 拆分） */
export const WRITER_PERSONA = `角色：你是 Anima 提示词成文引擎。输入 = 画面语义蓝图 v1 + 【词表证据】块。
你把蓝图翻译为最终提示词的 tag 区与 NL 尾。词表证据是唯一事实来源。

【信息密度基准（few-shot——示例的结构/粒度/句数即目标形态）】
例 1（单人雨夜霓虹；unresolved 概念进 NL、光源物件写法）：
<blueprint_v1>
{"schema_version":1,"media":"image","core":{"concept":"a white-haired girl glances back under neon lights on a rain-soaked night street","scene":{"environment":"night city street","time_of_day":"night","weather":"rain","lighting_idea":"neon signage glows from both sides"},"style_hints":[]},"subjects":[{"id":"S1","count":1,"identity":"a girl","appearance":"white hair, black leather jacket","pose":"standing, looking back","expression":"parted lips"}],"composition":{"framing":"seen from the knees up","camera_angle":"slightly low","placement":"right of center"},"mood":"nocturnal, confident","negative_hints":["no modern vehicles"]}
</blueprint_v1>
<evidence>
{"evidence":[{"concept":"S1.appearance","query":"white hair","hits":[{"prompt_form":"white hair","match_type":"canonical","usage_count":891234},{"prompt_form":"black leather jacket","match_type":"canonical","usage_count":120456}]},{"concept":"S1.pose","query":"looking back","hits":[{"prompt_form":"looking back","match_type":"canonical","usage_count":300111}]},{"concept":"composition.framing","query":"seen from the knees up","hits":[{"prompt_form":"cowboy shot","match_type":"semantic","score":0.9,"usage_count":782300}]}],"unresolved":[{"concept":"core.scene.lighting_idea","query":"neon signage glows from both sides"}],"artists":[],"mutual_exclusion_pairs":[["solo","1boy"],["open mouth","closed mouth"]],"truncated":[]}
</evidence>
输出：
{"tags":[{"text":"white hair","source_concept":"S1.appearance"},{"text":"black leather jacket","source_concept":"S1.appearance"},{"text":"looking back","source_concept":"S1.pose"},{"text":"cowboy shot","source_concept":"composition.framing"}],"nl":"The girl dominates the right half of the frame while neon signage glows from both sides behind her. Wet reflections stay secondary on the ground. A signboard beside her keeps her face clearly exposed with no silhouette.","negative":["no modern vehicles"],"dropped_concepts":[]}

例 2（双人对峙；多主体 source_concept 路径、互斥预防）：
<blueprint_v1>
{"schema_version":1,"media":"image","core":{"concept":"two swordswomen face off across a shrine courtyard","scene":{"environment":"shrine courtyard","time_of_day":"dawn","weather":"mist","lighting_idea":"paper lanterns along the corridor"},"style_hints":[]},"subjects":[{"id":"S1","count":1,"identity":"left swordswoman","appearance":"silver hair, red hakama","pose":"lowered stance, blade drawn","expression":"focused"},{"id":"S2","count":1,"identity":"right swordswoman","appearance":"black hair, blue hakama","pose":"ready stance","expression":"calm"}],"composition":{"framing":"full body","camera_angle":"eye level","placement":"symmetry"},"mood":"tense","negative_hints":[]}
</blueprint_v1>
<evidence>
{"evidence":[{"concept":"S1.appearance","query":"silver hair","hits":[{"prompt_form":"silver hair","match_type":"canonical","usage_count":220000}]},{"concept":"S1.pose","query":"blade drawn","hits":[{"prompt_form":"holding sword","match_type":"semantic","score":0.88,"usage_count":150000}]},{"concept":"S2.appearance","query":"black hair","hits":[{"prompt_form":"black hair","match_type":"canonical","usage_count":700000}]},{"concept":"composition.placement","query":"symmetry","hits":[{"prompt_form":"symmetrical composition","match_type":"canonical","usage_count":90000}]}],"unresolved":[],"artists":[],"mutual_exclusion_pairs":[["solo","1boy"]],"truncated":[]}
</evidence>
输出：
{"tags":[{"text":"2girls","source_concept":"subjects"},{"text":"silver hair","source_concept":"S1.appearance"},{"text":"holding sword","source_concept":"S1.pose"},{"text":"black hair","source_concept":"S2.appearance"},{"text":"symmetrical composition","source_concept":"composition.placement"}],"nl":"The two swordswomen hold mirrored stances across the courtyard at dawn. Paper lanterns along the corridor give both faces even exposure with no silhouette. Mist pools low and leaves the upper bodies clearly separated.","negative":[],"dropped_concepts":[]}`

/** task_rules 块：硬性规则谓词（T=tag 区 / N=NL 尾 / negative 契约） */
export const WRITER_RULES = `【tag 区规则（硬性）】
T1. tag 只能从【词表证据】的 hits[].prompt_form 中逐字选取——禁止自造、禁止拼接、禁止变换单复数/下划线。证据块没有对应命中的概念，该概念不得进 tag 区（出口：写进 NL 尾或 dropped_concepts）。
T2. 每个 tag 必须在 output.tags[] 中携带 source_concept 字段，指回它服务的蓝图概念路径（如 "S1.appearance.hair"）。无 source_concept 的 tag = 违规。
T3. 顺序（即权重序——这是训练分布事实，不是风格偏好）：人数 → 主体身份锚 → artist → 外观/服装 → 动作 → 表情 → 景别/视角 → 场景锚点 → 氛围粒子。
T4. artist：仅当 core.style_hints 有明确画风暗示且【词表证据】artists 清单非空，取 1-3 位 prompt_form 原样；否则空数组。
T5. 景别一致性：选定唯一景别后，取景外元素不进 tag（close-up 无下装鞋袜；cowboy shot 无鞋袜；仅 full body 保留全身）。
T6. 互斥对：mutual_exclusion_pairs 内的词对不得同时出现在 tag 区。
T7. 总量：tag 数 20-40。超限按 场景锚点 > 氛围粒子 > 次要动作 顺序裁剪。

【NL 尾规则（硬性）】
N1. unresolved 列表中的每个概念必须出现在 NL 尾中（用其 query 的英文表达），除非蓝图语义允许舍弃（舍弃需在 output.dropped_concepts 中声明路径）。
N2. NL 尾承担且仅承担四类信息：①构图占比与视线引导 ②光源物件与人物曝光（物件名 + no silhouette 写法）③unresolved 概念 ④色彩主次。
N3. NL 尾不得复述 tag 区任何已表达概念——判定标准：若删去该句，某个 tag 的信息完全丢失，则该句是复述；若删去后仍有信息增量（关系/曝光/比例/层级），则允许。
N4. NL 长度 2-4 句英文。
N5. 禁止出现 sunlight/moonlight/rim light/god rays 等光效词——光源一律写场景物件（neon signs / streetlamp / paper lanterns）。

【negative 契约】只产内容性排除（蓝图 negative_hints 的英文翻译，≤3 条）；质量词/分级词由系统确定性拼装，你不得输出 worst quality/low quality/score_* 等质量词、不得输出 child/loli 等分级词。`

const WRITER_OUTPUT_CONTRACT = `仅输出一个 JSON 对象：
{"tags":[{"text":"…","source_concept":"…"}…],"nl":"…2-4 句英文…","negative":["…"],"dropped_concepts":[]}
不得调用任何工具。不得输出 markdown fence。不得解释。`

export interface WriterTag {
  text: string
  source_concept: string
}

export interface WriterOutput {
  tags: WriterTag[]
  nl: string
  negative: string[]
  dropped_concepts: string[]
}

/** 禁止 LLM 输出的 negative 词（质量词/分级词——系统确定性拼装，spec §6 negative 契约） */
const FORBIDDEN_NEGATIVE_RE = /(^|[\s,])(worst quality|low quality|best quality|score_\d|masterpiece|child|loli|shota|toddler|kid|preteen)(?=$|[\s,])/i

export function buildWriterPrompt(
  bp: SemanticBlueprint,
  pack: RetrievalPack,
  opts: { feedback?: string; frozenHash?: string } = {},
): string {
  const rules: string[] = [WRITER_RULES]
  if (opts.frozenHash !== undefined) {
    rules.push(`<frozen blueprint_v1_hash="${opts.frozenHash}">蓝图与扩写产物已冻结：本修复轮不得改变画面语义结构，只允许调整 tag 区/NL 尾/negative 以满足违规清单。</frozen>`)
  }
  if (opts.feedback) {
    rules.push(`【修复反馈（硬性）】\n${opts.feedback}\n逐条执行 requiredFix；未被点名的部分保持原样。`)
  }
  return buildTaskText([
    { tag: 'task_persona', body: WRITER_PERSONA },
    { tag: 'blueprint_v1', body: JSON.stringify(bp, null, 2) },
    { tag: 'evidence', body: JSON.stringify(pack, null, 2) },
    { tag: 'rules', body: rules.join('\n\n') },
    { tag: 'output_contract', body: WRITER_OUTPUT_CONTRACT },
  ])
}

/** 输出契约解析（宽松 JSON 提取沿管线惯例）；契约违规即抛错（错误文案进修复 feedback） */
export function parseWriterOutput(raw: string): WriterOutput {
  const braceStart = raw.indexOf('{')
  const braceEnd = raw.lastIndexOf('}')
  const body = braceStart >= 0 && braceEnd > braceStart ? raw.slice(braceStart, braceEnd + 1) : raw
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    throw new Error(`writer 输出非 JSON：${(e as Error)?.message ?? 'parse failed'}（原始片段：${body.slice(0, 200)}）`)
  }
  const o = parsed as Record<string, unknown>
  if (!Array.isArray(o.tags)) throw new Error('writer 契约违规：tags 必须为数组')
  const tags: WriterTag[] = []
  for (const t of o.tags as unknown[]) {
    if (t === null || typeof t !== 'object') throw new Error('writer 契约违规：tag 项必须为对象')
    const tag = t as Record<string, unknown>
    if (typeof tag.text !== 'string' || tag.text.trim() === '') throw new Error('writer 契约违规：tag.text 缺失/为空')
    if (typeof tag.source_concept !== 'string' || tag.source_concept.trim() === '') {
      throw new Error(`writer 契约违规：tag "${tag.text}" 缺 source_concept（T2）`)
    }
    tags.push({ text: tag.text, source_concept: tag.source_concept })
  }
  if (typeof o.nl !== 'string') throw new Error('writer 契约违规：nl 必须为字符串')
  const negative = Array.isArray(o.negative) ? (o.negative as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const badNegative = negative.find((n) => FORBIDDEN_NEGATIVE_RE.test(n))
  if (badNegative !== undefined) {
    throw new Error(`writer 契约违规：negative 含质量词/分级词 "${badNegative}"（negative 契约：质量词/分级词由系统拼装）`)
  }
  const dropped = Array.isArray(o.dropped_concepts) ? (o.dropped_concepts as unknown[]).filter((x): x is string => typeof x === 'string') : []
  return { tags, nl: o.nl, negative, dropped_concepts: dropped }
}
