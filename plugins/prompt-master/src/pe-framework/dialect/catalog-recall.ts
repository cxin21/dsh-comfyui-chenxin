/**
 * catalog 候选召回（外部基准 2026-09，B 期 B7）：检索证据进生成回路。
 *
 * 问题（generate→事后校验的证据流反了）：intent LLM 凭记忆写 tag，catalog 只在编译期做
 * catalog_miss 事后 advisory——LLM 全程看不到词库里有什么。本模块在 intent 调用前从
 * brief 文本确定性召回「已验证存在」的规范 tag 候选，注入 persona（见 subagent-provider
 * taskText 候选块），让 LLM 在写 tag 前看到可用词表（对标 DanbooruSearchOnline /
 * NewBie-LLM-Formatter Agent 模式的 search→compose 证据流；这里是零成本单轮近似）。
 *
 * 设计约束：
 * - 只注入 exact 级联（canonical/alias）命中——fuzzy 噪声不进 prompt（F3 过滤也不够强）；
 * - 跳过 '@' 画师型候选（画师是风格层决策，见 MINIMAL_STYLES.artistHints，不从文本猜）；
 * - CJK token 跳过（catalog 无中文别名，实测 水手服 miss）——中文输入依赖 enrich 产出的
 *   英文 brief 文本做召回（enrich 缺省开启）；enrich 失败/关闭的降级路径由 ZH_CONCEPT_BRIDGE
 *   中文概念桥接兜底（2026-09-12：实测纯中文意图 catalogCandidates=[]，召回完全空转）；
 * - 纯确定性、零 LLM；searchCatalog 故障由调用方兜底（本模块只做 try/catch 后返回空）。
 */

import { searchCatalog } from './anima-catalog.js'

/** 功能词停用表：只滤虚词与代词，不滤内容词（wearing/serving 等实义动词保留交由 catalog 判定） */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'with', 'in', 'on', 'at', 'to', 'and', 'or', 'for',
  'her', 'his', 'she', 'he', 'they', 'them', 'their', 'is', 'are', 'was', 'were',
  'it', 'its', 'as', 'by', 'from', 'into', 'over', 'under', 'this', 'that',
])

const LATIN_TOKEN_RE = /[a-z0-9']+/g

/**
 * 中文概念桥接表（2026-09-12，降级路径兜底）：enrich 失败/关闭时 intentInput 是中文原文，
 * 拉丁 n-gram 召回空转。本表把高频「具体名词/动作」概念桥接为 EN 检索词，走同一 exact 级联——
 * 只有 catalog 真实命中 canonical/alias 的规范形式才进候选，不引入编造。
 * 维护约束：值必须是 catalog 中可能以 exact 形式存在的单一概念（多词概念整体检索）；
 * 只收具体概念，抽象词（美/唯美/意境/气质…）画面信息为零，不桥接。
 * 匹配顺序：长键优先（模块加载时排序），命中即消费文本防子串重复（雨夜 → 雨+夜）。
 */
const ZH_CONCEPT_BRIDGE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['雨夜', ['rain', 'night']],
  ['花瓣', ['petals']],
  ['霓虹', ['neon signs']],
  ['灯笼', ['paper lanterns']],
  ['月亮', ['full moon']],
  ['明月', ['full moon']],
  ['舞剑', ['dancing', 'sword']],
  ['连衣裙', ['dress']],
  ['猫耳朵', ['cat ears']],
  ['雪', ['snow']],
  ['雨', ['rain']],
  ['夜', ['night']],
  ['月', ['full moon']],
  ['花', ['flower']],
  ['舞', ['dancing']],
  ['剑', ['sword']],
  ['街道', ['street']],
  ['森林', ['forest']],
  ['海滩', ['beach']],
  ['沙滩', ['beach']],
  ['天空', ['sky']],
  ['云', ['clouds']],
  ['海', ['ocean']],
  ['火', ['fire']],
  ['伞', ['umbrella']],
  ['马', ['horse']],
  ['猫', ['cat']],
  ['汉服', ['hanfu']],
  ['和服', ['kimono']],
  ['盔甲', ['armor']],
  ['翅膀', ['wings']],
  ['长发', ['long hair']],
  ['短发', ['short hair']],
  ['白发', ['white hair']],
  ['黑发', ['black hair']],
  ['银发', ['silver hair']],
  ['裙', ['skirt']],
  ['制服', ['uniform']],
  ['泳装', ['swimsuit']],
  ['眼镜', ['glasses']],
  ['猫耳', ['cat ears']],
]
const ZH_BRIDGE_SORTED = [...ZH_CONCEPT_BRIDGE].sort((a, b) => b[0].length - a[0].length)

/** 扫描中文概念键（长键优先、命中即消费防重叠），按出现序返回 EN 桥接检索词（未去重）。 */
function bridgeZhConcepts(text: string): string[] {
  let rest = text
  const out: string[] = []
  for (const [zh, ens] of ZH_BRIDGE_SORTED) {
    if (!rest.includes(zh)) continue
    rest = rest.split(zh).join('\u0000')
    for (const en of ens) out.push(en)
  }
  return out
}

export interface CatalogRecallOptions {
  /** 注入候选上限（缺省 24） */
  maxCandidates?: number
  /** 检索调用上限（缺省 40；FTS 单次亚毫秒级，40 次可忽略） */
  maxLookups?: number
  /** 检索函数注入 seam（测试 mock；缺省 searchCatalog exact 级联） */
  search?: (tag: string) => Array<{ match_type?: string; prompt_form?: string; raw?: string }>
}

/**
 * 从 brief 文本召回 catalog 规范 tag 候选。
 * 策略：拉丁词 3-gram → 2-gram → 1-gram（长语料优先，命中即标记词位覆盖——后续更短
 * n-gram 只要有词位被完整覆盖就跳过，避免 white hair 命中后再注 white/hair 碎词）；
 * exact 命中的 prompt_form 去重收集；上限内返回（保序：场景名词先于碎词）。
 */
export function catalogCandidatesForText(text: string, opts?: CatalogRecallOptions): string[] {
  const maxCandidates = opts?.maxCandidates ?? 24
  const maxLookups = opts?.maxLookups ?? 40
  const search = opts?.search ?? ((t: string) => searchCatalog(t, { limit: 1, mode: 'exact' }))
  if (!text || typeof text !== 'string') return []

  const tokens = (text.toLowerCase().match(LATIN_TOKEN_RE) ?? []).filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t))
  // n-gram 候选：3/2/1 长度递减，同层保序；命中后标记词位覆盖
  const phrases: Array<{ text: string; start: number; len: number }> = []
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      phrases.push({ text: tokens.slice(i, i + n).join(' '), start: i, len: n })
    }
  }

  const covered = new Array<boolean>(tokens.length).fill(false)
  const seen = new Set<string>()
  const out: string[] = []
  let lookups = 0
  for (const phrase of phrases) {
    if (out.length >= maxCandidates || lookups >= maxLookups) break
    // 词位覆盖吞并：短语的所有词位都已被更长 n-gram 命中覆盖 → 不再检索
    let fullyCovered = true
    for (let j = phrase.start; j < phrase.start + phrase.len; j++) {
      if (!covered[j]) { fullyCovered = false; break }
    }
    if (fullyCovered) continue
    lookups++
    let hits: Array<{ match_type?: string; prompt_form?: string; raw?: string }>
    try {
      hits = search(phrase.text)
    } catch {
      return out // 检索故障 → 返回已收集部分（增强层不阻塞）
    }
    const top = hits[0]
    if (!top || (top.match_type !== 'canonical' && top.match_type !== 'alias')) continue
    const form = (top.prompt_form ?? top.raw ?? '').trim()
    if (!form || form.startsWith('@')) continue
    if (out.some((c) => c.toLowerCase() === form.toLowerCase())) continue
    out.push(form)
    for (let j = phrase.start; j < phrase.start + phrase.len; j++) covered[j] = true
  }

  // 中文概念桥接（降级路径兜底）：桥接词作为独立短语走同一 exact 召回（去重与上限共享）
  for (const en of bridgeZhConcepts(text)) {
    if (out.length >= maxCandidates || lookups >= maxLookups) break
    if (out.some((c) => c.toLowerCase() === en.toLowerCase())) continue
    lookups++
    let hits: Array<{ match_type?: string; prompt_form?: string; raw?: string }>
    try {
      hits = search(en)
    } catch {
      break // 检索故障 → 返回已收集部分
    }
    const top = hits[0]
    if (!top || (top.match_type !== 'canonical' && top.match_type !== 'alias')) continue
    const form = (top.prompt_form ?? top.raw ?? '').trim()
    if (!form || form.startsWith('@')) continue
    out.push(form)
  }
  return out
}
