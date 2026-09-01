/**
 * JoyExtra 三段式硬约束（移植自 PromptMaster joyCaption extra-option 系统）：
 * 1) resolveJoyExtraOptions —— 显式数组 > 标准句嗅探（extra_prompt），解析 character_name
 * 2) buildJoyExtraSystemBlock / buildJoyExtraUserTail —— prompt 侧注入（优先级声明 + 冲突仲裁）
 * 3) filterJoyExtraClauses —— 输出侧子句过滤（防灭绝兜底：全被滤掉 → 返回原文）
 *
 * 纯函数模块：零日志、零 IO（工具层负责日志）。
 * 标准句逐字移植自 temp/pm-promptmaster-src .../joyCaptionExtraOptions.js.deob.js；
 * 子句切分/过滤正则移植自 captionExtraOptionSanitize.js.deob.js（裁掉生僻条目）。
 */

export type JoyExtraOptionId =
  | 'no_glasses_headwear'
  | 'scene_only_no_character_appearance'
  | 'no_artistic_style'
  | 'character_name'

export interface JoyExtraResolution {
  options: JoyExtraOptionId[]
  characterName?: string
}

/* ── 标准句（PromptMaster deob 逐字移植，嗅探 + 展示共用）── */

export const JOY_SCENE_ONLY_NO_CHARACTER_APPEARANCE_EN =
  'Do NOT describe any character appearance traits or clothing. Do not write any visible physical appearance features—such as face, facial features, body, skin, hair, body shape, or similar traits—or any garments, outfits, or clothing items.'
export const JOY_NO_GLASSES_HEADWEAR_EN =
  'Do NOT describe any glasses, goggles, eyewear, sunglasses, or headwear on the person/character (including hats, helmets, headbands, crowns, and hair accessories worn on the head).'
export const JOY_NO_ARTISTIC_STYLE_EN =
  'Do NOT describe artistic style, rendering style, image medium, quality tags, aesthetic terms, or visual style labels. Do not mention anime, cartoon, realistic, painting, illustration, 3D render, cinematic, digital art, concept art, or similar style-related terms.'

/* ── 选项注册表：标准句 + 嗅探正则 + 中文变体 ── */

interface JoyExtraOptionDef {
  id: JoyExtraOptionId
  en: string
  zh: string
  sniff: RegExp[]
}

const OPTION_DEFS: JoyExtraOptionDef[] = [
  {
    id: 'no_glasses_headwear',
    en: JOY_NO_GLASSES_HEADWEAR_EN,
    zh: '不要写眼镜/头饰：即使画面中有眼镜、面饰或任何头戴物，也必须完全省略，不得提及。',
    sniff: [
      /Do NOT describe any glasses, goggles, eyewear/i,
      /Do not mention glasses/i,
      /不要(?:写|提|提及|描述).{0,6}(?:眼镜|头饰|帽子)/,
    ],
  },
  {
    id: 'scene_only_no_character_appearance',
    en: JOY_SCENE_ONLY_NO_CHARACTER_APPEARANCE_EN,
    zh: '只写场景，不写任何角色外貌或服装：面部、五官、身体、皮肤、头发、体型及一切衣着类描述都必须省略。',
    sniff: [
      /Do NOT describe any character appearance traits or clothing/i,
      /Do NOT describe any character appearance or clothing/i,
      /Do not describe any character appearance/i,
      /只写场景.{0,8}不写.{0,10}(?:外貌|外观|长相)/,
    ],
  },
  {
    id: 'no_artistic_style',
    en: JOY_NO_ARTISTIC_STYLE_EN,
    zh: '不要写艺术风格：不提及画风、渲染风格、媒介、质量词或任何风格标签（anime/cartoon/realistic/painting 等）。',
    sniff: [
      /Do NOT describe artistic style/i,
      /不要(?:写|提|提及|描述).{0,6}(?:画风|艺术风格|风格)/,
    ],
  },
  {
    id: 'character_name',
    en: 'Refer to the person/character by the given name only; do not invent or mention any other name.',
    zh: '用指定名字称呼该角色；不要提及或杜撰其他名字。',
    sniff: [/refer to them as/i, /(?:称呼|称作|名叫)为?["'「『]?[\w\u4e00-\u9fff]+["'」』]?/],
  },
]

const OPTION_BY_ID = new Map(OPTION_DEFS.map((d) => [d.id, d]))

const CHARACTER_NAME_SNIFF = /refer to them as ([A-Za-z0-9_\u4e00-\u9fff]+)/i

/* ── resolve ── */

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x ?? '').trim()).filter(Boolean)
}

export function resolveJoyExtraOptions(input: {
  joyExtraOptions?: unknown
  extraPrompt?: string
  characterName?: unknown
}): JoyExtraResolution {
  const explicit = asStringArray(input.joyExtraOptions)
  const options: JoyExtraOptionId[] = []
  for (const id of explicit) if (OPTION_BY_ID.has(id as JoyExtraOptionId)) options.push(id as JoyExtraOptionId)

  const extraPrompt = String(input.extraPrompt ?? '')
  if (extraPrompt.trim()) {
    for (const def of OPTION_DEFS) {
      if (options.includes(def.id)) continue
      if (def.id !== 'character_name' && extraPrompt.includes(def.en)) { options.push(def.id); continue }
      if (def.sniff.some((re) => re.test(extraPrompt))) options.push(def.id)
    }
  }

  let characterName = String(input.characterName ?? '').trim()
  if (!characterName && extraPrompt) {
    const m = extraPrompt.match(CHARACTER_NAME_SNIFF)
    if (m) characterName = m[1].trim()
  }
  const res: JoyExtraResolution = { options }
  if (characterName) res.characterName = characterName
  return res
}

/* ── prompt 注入 ── */

/** 冲突仲裁：scene_only（更高优先级）生效时，覆盖 no_glasses_headwear 的"不可变属性"分支表述 */
function pledgeLines(res: JoyExtraResolution, lang: 'zh' | 'en'): string[] {
  const sceneOnly = res.options.includes('scene_only_no_character_appearance')
  return res.options
    .filter((id) => id !== 'character_name' || res.characterName)
    .map((id) => {
      const def = OPTION_BY_ID.get(id)
      if (!def) return ''
      if (lang === 'en') return `- ${sceneOnly && id === 'no_glasses_headwear' ? def.en + ' (subsumed by the scene-only rule above; obey the stricter one.)' : def.en}`
      return `- ${sceneOnly && id === 'no_glasses_headwear' ? def.zh + '（已被上文"只写场景"规则覆盖，以更严格者为准。）' : def.zh}`
    })
    .filter(Boolean)
}

export function buildJoyExtraSystemBlock(res: JoyExtraResolution, outputLang: 'zh' | 'en'): string {
  if (res.options.length === 0) return ''
  const pledges = pledgeLines(res, outputLang)
  const priority =
    outputLang === 'en'
      ? 'These are HARD CONSTRAINTS and take priority over any checklist, style guide, or earlier instruction: every listed exclusion must be fully omitted from the output.'
      : '以下是硬约束，优先级高于任何检查表、风格指南或前文指令：所列每一项禁写内容都必须在输出中完全省略。'
  const nameLine =
    res.characterName
      ? outputLang === 'en'
        ? `- Refer to the person/character strictly as "${res.characterName}".`
        : `- 严格以"${res.characterName}"称呼该角色。`
      : ''
  const conflict =
    outputLang === 'en'
      ? 'Conflict override: when two rules overlap, the stricter (broader exclusion) wins; a forbidden trait must never appear, even if another instruction asks for it.'
      : '冲突仲裁：两条规则重叠时以更严格（覆盖面更广）者为准；被禁特征即使其他指令要求也绝不得出现。'
  return ['[JoyExtra Hard Constraints]', priority, ...pledges, nameLine, conflict].filter(Boolean).join('\n')
}

export function buildJoyExtraUserTail(res: JoyExtraResolution, outputLang: 'zh' | 'en'): string {
  if (res.options.length === 0) return ''
  const head =
    outputLang === 'en'
      ? 'Reminder (hard constraints): do NOT write anything forbidden by the options below.'
      : '再次提醒（硬约束）：输出中不得出现下列选项禁止的任何内容。'
  const lines = pledgeLines(res, outputLang)
  const nameLine = res.characterName
    ? outputLang === 'en'
      ? `- Name: ${res.characterName}.`
      : `- 名字：${res.characterName}。`
    : ''
  return [head, ...lines, nameLine].filter(Boolean).join('\n')
}

/* ── 输出侧子句过滤（captionExtraOptionSanitize 移植）── */

/** 中文/英文通用：眼镜·头饰类子句模式（deob 版裁剪 + 英文词集补充） */
const GLASSES_HEADWEAR_CLAUSE_PATTERNS: RegExp[] = [
  /眼镜/u, /护目镜/u, /墨镜/u, /太阳镜/u, /镜框/u, /目镜/u,
  /头戴.*镜/u, /佩戴.*镜/u,
  /头饰/u, /发饰/u, /发箍/u, /头箍/u, /头带/u, /发带/u,
  /(?:鸭舌|棒球|贝雷|礼|安全|针织)?帽/u,
  /头盔/u, /皇冠/u, /王冠/u, /头冠/u, /面罩/u, /头套/u,
  /\b(?:glasses|goggles|sunglasses|eyewear)\b/i,
  /\b(?:beret|hat|helmet|headband|crown|headwear)\b/i,
]

/** 外貌·服装类子句模式（deob 版核心条目；scene_only 选项使用） */
const APPEARANCE_CLOTHING_CLAUSE_PATTERNS: RegExp[] = [
  /皮肤/u, /肤色/u, /肤质/u, /斑(?:块|纹|点)/u, /胎记/u, /疤痕/u, /痣/u, /胡须/u,
  /妆容/u, /五官/u, /面部特征/u, /脸型/u,
  /发型/u, /头发/u, /发丝/u, /刘海/u,
  /服装/u, /衣着/u, /穿着/u, /身穿/u, /上衣/u, /下装/u,
  /裤子/u, /裙子/u, /连衣裙/u, /外套/u, /大衣/u,
  /鞋/u, /靴/u, /袜/u, /衣料/u, /布料/u,
  /体型/u, /身材/u,
  /\b(?:skin|complexion|freckle|mole|scar|birthmark)\b/i,
  /\b(?:hair|hairstyle|bangs|beard|mustache|facial features?)\b/i,
  /\b(?:shirt|pants|dress|skirt|outfit|garment|clothing|jacket|shoes?|boots?)\b/i,
]

/** 艺术风格类子句模式（no_artistic_style 选项使用；核心词集） */
const ARTISTIC_STYLE_CLAUSE_PATTERNS: RegExp[] = [
  /画风/u, /艺术风格/u, /风格化/u, /渲染风格/u, /质量词/u,
  /\b(?:anime|cartoon|realistic|painting|illustration|cinematic|digital art|concept art|3d render)\b/i,
]

/** 按分隔符切子句（deob 版同款字符类），去空并 trim */
function splitClauses(text: string): string[] {
  return String(text ?? '')
    .split(/[，,、；;。．.!！?？\n]+/u)
    .map((c) => c.trim())
    .filter(Boolean)
}

/** 原文分隔符风格探测（deob 版同款：中文逗号 > 顿号 > 分号 > 英文逗号+空格） */
function pickClauseSeparator(text: string): string {
  if (text.includes('，')) return '，'
  if (text.includes('、')) return '、'
  if (text.includes(';')) return '; '
  return ', '
}

function clauseMatches(clause: string, patterns: RegExp[]): boolean {
  const c = clause.trim()
  if (!c) return false
  return patterns.some((re) => re.test(c))
}

function patternsForOptions(options: JoyExtraOptionId[]): RegExp[] {
  const patterns: RegExp[] = []
  if (options.includes('no_glasses_headwear')) patterns.push(...GLASSES_HEADWEAR_CLAUSE_PATTERNS)
  if (options.includes('scene_only_no_character_appearance')) patterns.push(...APPEARANCE_CLOTHING_CLAUSE_PATTERNS)
  if (options.includes('no_artistic_style')) patterns.push(...ARTISTIC_STYLE_CLAUSE_PATTERNS)
  return patterns
}

/**
 * 子句过滤：命中任一启用选项的正则组 → 剔除该子句；
 * 拼回时按原文分隔符风格（pickClauseSeparator）逐一还原；
 * 防灭绝兜底：全部子句被剔除 → 返回原文。
 */
export function filterJoyExtraClauses(text: string, res: JoyExtraResolution): string {
  const src = String(text ?? '').trim()
  if (!src) return src
  const patterns = patternsForOptions(res.options)
  if (patterns.length === 0) return src
  const clauses = splitClauses(src)
  if (clauses.length === 0) return src
  const kept = clauses.filter((c) => !clauseMatches(c, patterns))
  if (kept.length === 0) return src // anti-extinction
  return kept.join(pickClauseSeparator(src))
}
