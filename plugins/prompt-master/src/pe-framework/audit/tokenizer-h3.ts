/**
 * H3 官方 tokenizer（BPE）TS 移植（P3，保真最高风险）。
 * 唯一事实源：knowledge/tokenizer.json（BPE vocab 151,643 / merges 151,387 / 26 added tokens(14 special)，
 * normalizer NFC、pre_tokenizer Sequence[Split(GPT2 regex, Isolated), ByteLevel(use_regex:false)]、byte_fallback:false、unk_token:null）
 * 语义锚点：token_counting.py 委托 HuggingFace tokenizers Rust 后端（Tokenizer.from_file + encode(add_special_tokens=False)），
 * 此处按 tokenizer.json 配置复刻同一标准 BPE 流水线（逐 token 精确是唯一验收；T12 双跑）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface H3TokenizerConfig {
  vocab: Map<string, number>
  merges: Map<string, number>
  addedTokens: Array<{ id: number; content: string; special: boolean }>
}

const DEFAULT_SOURCE_DIR = 'C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/skills/minimax-h3-prompt/knowledge'

/** GPT2 split regex（tokenizer.json pre_tokenizer Split pattern，行为 Isolated）——JS 以 i+u 旗标等价 Python (?i:) */
const SPLIT_RE = /'s|'t|'re|'ve|'m|'ll|'d|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/giu

/** 生成 GPT-2 标准 byte→unicode 字母表（ByteLevel）：33-126 与 161-172、174-255（Latin-1 可打印）原样；其余字节按序映射 U+0100..（32→'Ġ' U+0120） */
function buildByteAlphabet(): string[] {
  const alphabet: string[] = new Array(256)
  let special = 0
  for (let b = 0; b < 256; b++) {
    if ((b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255)) {
      alphabet[b] = String.fromCharCode(b)
    } else {
      alphabet[b] = String.fromCharCode(0x100 + special)
      special++
    }
  }
  return alphabet
}

/** split（Isolated）：命中段独立成 token，其余间隙也保留 */
function splitIsolated(re: RegExp, text: string): string[] {
  const out: string[] = []
  let last = 0
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(m[0])
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out.filter((p) => p.length > 0)
}

export class H3Tokenizer {
  readonly vocab: Map<string, number>
  readonly merges: Map<string, number>
  readonly addedTokens: H3TokenizerConfig['addedTokens']
  private readonly byteAlphabet: string[]
  private readonly specialMatcher: Array<{ id: number; content: string; special: boolean }>

  constructor(sourceDir: string = DEFAULT_SOURCE_DIR) {
    const raw = JSON.parse(readFileSync(join(sourceDir, 'tokenizer.json'), 'utf8'))
    const model = raw.model
    if (model.type !== 'BPE') throw new Error(`unsupported tokenizer model type: ${model.type}`)
    this.vocab = new Map<string, number>()
    for (const [k, v] of Object.entries(model.vocab as Record<string, number>)) this.vocab.set(k, v)
    this.merges = new Map<string, number>()
    for (let i = 0; i < (model.merges as string[]).length; i++) this.merges.set((model.merges as string[])[i], i)
    this.addedTokens = (raw.added_tokens ?? []).map((t: { id: number; content: string; special?: boolean }) => ({
      id: t.id,
      content: t.content,
      special: t.special === true,
    }))
    // 最长优先匹配（HF added-token trie 语义：长内容先匹配）
    this.specialMatcher = [...this.addedTokens].sort((a, b) => b.content.length - a.content.length)
    this.byteAlphabet = buildByteAlphabet()
  }

  /** 把非 added-token 段按 added tokens（normalized:false，原始串匹配）切分 */
  private splitAdded(text: string): Array<{ id: number } | { raw: string }> {
    const out: Array<{ id: number } | { raw: string }> = []
    let rest = text
    while (rest.length) {
      let matched: { id: number; content: string } | null = null
      for (const t of this.specialMatcher) {
        if (t.content && rest.startsWith(t.content)) {
          matched = t
          break
        }
      }
      if (matched) {
        out.push({ id: matched.id })
        rest = rest.slice(matched.content.length)
      } else {
        // 找下一个任意 added token 出现位置，把之前文本作为 raw
        let next = -1
        for (const t of this.specialMatcher) {
          if (!t.content) continue
          const idx = rest.indexOf(t.content)
          if (idx !== -1 && (next === -1 || idx < next)) next = idx
        }
        if (next === -1) {
          out.push({ raw: rest })
          rest = ''
        } else {
          out.push({ raw: rest.slice(0, next) })
          rest = rest.slice(next)
        }
      }
    }
    return out.filter((p) => ('raw' in p ? (p.raw as string).length > 0 : true))
  }

  private byteEncode(text: string): string {
    let out = ''
    for (const ch of text) {
      // UTF-8 bytes（单一 codeunit 流程；代理对由 TextEncoder 正确处理）
      for (const b of new TextEncoder().encode(ch)) out += this.byteAlphabet[b]
    }
    return out
  }

  private bpe(word: string): number[] {
    if (word.length === 0) return []
    const direct = this.vocab.get(word)
    if (direct !== undefined) return [direct]
    let parts: string[] = [...word]
    while (parts.length > 1) {
      let bestRank = Infinity
      let bestPairKey: string | null = null
      let bestPairText = ''
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i] + ' ' + parts[i + 1]
        const rank = this.merges.get(key)
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank
          bestPairKey = key
          bestPairText = parts[i] + parts[i + 1]
        }
      }
      if (bestPairKey === null) break
      // 合并所有出现的 bestPair（一次替换全部；内部文本为拼接形式，查询键为空格形式）
      const next: string[] = []
      let i = 0
      while (i < parts.length) {
        if (i + 1 < parts.length && parts[i] + ' ' + parts[i + 1] === bestPairKey) {
          next.push(bestPairText)
          i += 2
        } else {
          next.push(parts[i])
          i++
        }
      }
      parts = next
    }
    const ids: number[] = []
    for (const p of parts) {
      const id = this.vocab.get(p)
      if (id === undefined) {
        // byte_fallback:false + unk_token:null —— 理论上不会发生（字节级词表覆盖）；发生即显式失败（防静默偏差）
        throw new Error(`H3 BPE OOV fragment: ${JSON.stringify(p)}`)
      }
      ids.push(id)
    }
    return ids
  }

  /** encode 全流水线：added-token 切分 → NFC → Split(Isolated) → ByteLevel → BPE */
  encode(text: string): number[] {
    const ids: number[] = []
    for (const part of this.splitAdded(text)) {
      if ('id' in part) {
        ids.push(part.id)
        continue
      }
      const raw = (part as { raw: string }).raw
      const normalized = raw.normalize('NFC')
      const pretokens = splitIsolated(SPLIT_RE, normalized)
      for (const token of pretokens) {
        const byteWord = this.byteEncode(token)
        ids.push(...this.bpe(byteWord))
      }
    }
    return ids
  }

  count(text: string): number {
    return this.encode(text).length
  }

  /** count_h3_text_context 移植：官方 user 消息上下文帧（视觉 pads 由 reference_count 展开） */
  countContext(text: string, referenceCount = 0): number {
    if (!Number.isInteger(referenceCount) || referenceCount < 0) throw new Error('reference_count must be a non-negative integer')
    let references = ''
    for (let i = 1; i <= referenceCount; i++) {
      references += `Picture ${i}: <|vision_start|><|image_pad|><|vision_end|>\n`
    }
    return this.count(`<|im_start|>user\n${references}${text}<|im_end|>\n`)
  }
}

let _instance: H3Tokenizer | null = null
let _instanceDir: string | undefined

export function h3Tokenizer(sourceDir?: string): H3Tokenizer {
  const dir = sourceDir ?? process.env.H3_TOKENIZER_DIR ?? DEFAULT_SOURCE_DIR
  if (!_instance || _instanceDir !== dir) {
    _instance = new H3Tokenizer(dir)
    _instanceDir = dir
  }
  return _instance
}

export function countTokensH3(text: string, sourceDir?: string, referenceCount = 0): { tokens: number; ids?: number[] } {
  const t = h3Tokenizer(sourceDir)
  return { tokens: t.countContext(text, referenceCount) }
}

export function encodeTokensH3(text: string, sourceDir?: string): number[] {
  return h3Tokenizer(sourceDir).encode(text)
}

/** tokenizer.json 元数据实测（报告用） */
export function tokenizerMeta(sourceDir?: string): { vocabSize: number; merges: number; addedTokens: number; specialTokens: number } {
  const t = h3Tokenizer(sourceDir)
  return {
    vocabSize: t.vocab.size,
    merges: t.merges.size,
    addedTokens: t.addedTokens.length,
    specialTokens: t.addedTokens.filter((a) => a.special).length,
  }
}