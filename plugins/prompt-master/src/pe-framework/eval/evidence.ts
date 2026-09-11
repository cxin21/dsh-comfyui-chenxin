/**
 * 证据工具桥（spec §2.1）：把 catalog / tokenizer / aesthetics 三个底层证据依赖
 * 包成统一 EvidenceBridge 接口，供 LLM 评委在评审中查询证据。
 *
 * 本模块纯函数化，不 import 任何真实依赖文件；真实装配（searchCatalog /
 * countTokensH3 / checkConcreteness 等）由 Task 5 runStage 注入 deps。
 *
 * 降级铁律：任何证据工具故障不得抛出到调用方（spec §2.1）。
 */

export type EvidenceToolId = 'catalog' | 'tokenizer' | 'aesthetics'

export interface EvidenceResult {
  tool: EvidenceToolId
  query: string
  summary: string // ≤300 字符的证据摘要（给 LLM 评委看的）
  ok: boolean
}

export interface EvidenceDeps {
  // 真实装配（Task 5 runStage 做）分别接：
  // catalog → dialect/anima-catalog.ts 的 searchCatalog(tag, opts?): CatalogHit[]
  // tokenizer → audit/tokenizer-h3.ts 的 countTokensH3(text, sourceDir?, referenceCount?): { tokens: number; ids?: number[] }
  // aesthetics → aesthetics/check.ts 的 checkConcreteness(bp: BlueprintV1) / checkFidelity(original, bp)
  //   aesthetics 适配器入参用 string（query），内部构造最小 BlueprintV1 或只取词法面检查——以能产出具体性摘要为准
  catalog?: (query: string) => Promise<unknown> | unknown
  tokenizer?: (query: string) => Promise<unknown> | unknown
  aesthetics?: (query: string) => Promise<unknown> | unknown
}

export interface EvidenceBridge {
  list(): EvidenceToolId[]
  query(tool: EvidenceToolId, q: string): Promise<EvidenceResult>
}

const MAX_SUMMARY = 300

function truncate(s: string): string {
  if (s.length <= MAX_SUMMARY) return s
  return s.slice(0, MAX_SUMMARY - 1) + '…'
}

function summarizeCatalog(raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return 'miss'
  const parts = raw.map((hit: unknown) => {
    const h = hit as Record<string, unknown>
    const tag = String(h?.tag ?? '')
    const kind = h?.kind === undefined ? '' : String(h.kind)
    const n = h?.count ?? h?.n
    return `${tag}(${kind},n=${String(n)})`
  })
  return parts.join('; ')
}

function summarizeTokenizer(raw: unknown): string {
  const obj = (raw ?? {}) as Record<string, unknown>
  const tokens = obj.tokens
  const estimate = obj.estimate === true
  return `tokens=${String(tokens)}${estimate ? '(estimate)' : ''}`
}

function summarizeAesthetics(raw: unknown): string {
  const obj = (raw ?? {}) as Record<string, unknown>
  const parts: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'number') parts.push(`${key}=${value}`)
    else if (typeof value === 'string') parts.push(`${key}=${value}`)
    else if (Array.isArray(value)) parts.push(`${key}:[${value.map(String).join(', ')}]`)
  }
  return parts.join('; ')
}

function summarize(tool: EvidenceToolId, raw: unknown): string {
  switch (tool) {
    case 'catalog':
      return summarizeCatalog(raw)
    case 'tokenizer':
      return summarizeTokenizer(raw)
    case 'aesthetics':
      return summarizeAesthetics(raw)
  }
}

export function createEvidenceBridge(opts: {
  target: 'anima' | 'h3'
  available: ReadonlyArray<EvidenceToolId>
  deps: EvidenceDeps
}): EvidenceBridge {
  const { target, available, deps } = opts
  void target // 装配方用于校验 target 与 available 匹配；桥本身不依赖

  return {
    list(): EvidenceToolId[] {
      return available.filter((id) => typeof deps[id] === 'function')
    },

    async query(tool: EvidenceToolId, q: string): Promise<EvidenceResult> {
      const base = { tool, query: q }
      const fn = deps[tool]
      if (typeof fn !== 'function') {
        return { ...base, summary: 'tool unavailable', ok: false }
      }
      try {
        const raw = await fn(q)
        return { ...base, summary: truncate(summarize(tool, raw)), ok: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ...base, summary: truncate(message.slice(0, 200)), ok: false }
      }
    },
  }
}
