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
 *   英文 brief 文本做召回（enrich 缺省开启；关闭时降级为拉丁 token 直查）；
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
  return out
}
