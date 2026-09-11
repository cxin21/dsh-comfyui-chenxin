import { describe, it, expect, vi } from 'vitest'
import { createEvidenceBridge } from '../../../src/pe-framework/eval/evidence.js'
import type { EvidenceDeps, EvidenceToolId } from '../../../src/pe-framework/eval/evidence.js'

function deps(partial: Partial<EvidenceDeps>): EvidenceDeps {
  return partial
}

describe('EvidenceBridge', () => {
  it('list(): 只返回 available 且 deps 里存在对应函数的工具，按 available 声明序', () => {
    const bridge = createEvidenceBridge({
      target: 'anima',
      available: ['tokenizer', 'catalog', 'aesthetics'],
      deps: deps({ catalog: vi.fn(), aesthetics: vi.fn() }), // tokenizer 未提供
    })
    expect(bridge.list()).toEqual<EvidenceToolId[]>(['catalog', 'aesthetics'])
  })

  it('query(catalog): 分发到 deps.catalog 并把 CatalogHit[] 摘要成 tag(canonical,n=N) 列表', async () => {
    const catalog = vi.fn().mockResolvedValue([
      { tag: 'science fiction', kind: 'canonical', count: 3 },
      { tag: 'sci-fi', kind: 'alias', count: 1 },
    ])
    const bridge = createEvidenceBridge({
      target: 'anima',
      available: ['catalog'],
      deps: deps({ catalog }),
    })
    const r = await bridge.query('catalog', 'science fiction')
    expect(catalog).toHaveBeenCalledWith('science fiction')
    expect(r.tool).toBe('catalog')
    expect(r.query).toBe('science fiction')
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('science fiction(canonical,n=3); sci-fi(alias,n=1)')
  })

  it('query(tokenizer): 空结果摘要为 miss；tokenizer 数值摘要为 tokens=N(estimate) / tokens=N', async () => {
    const catalog = vi.fn().mockResolvedValue([])
    const tokenizer = vi.fn().mockResolvedValue({ tokens: 42, estimate: true })
    const bridge = createEvidenceBridge({
      target: 'h3',
      available: ['catalog', 'tokenizer'],
      deps: deps({ catalog, tokenizer }),
    })
    const miss = await bridge.query('catalog', 'zzz-no-hit')
    expect(miss.ok).toBe(true)
    expect(miss.summary).toBe('miss')
    const tok = await bridge.query('tokenizer', 'a b c')
    expect(tokenizer).toHaveBeenCalledWith('a b c')
    expect(tok.summary).toBe('tokens=42(estimate)')
    const tokenizerExact = vi.fn().mockResolvedValue({ tokens: 7 })
    const bridge2 = createEvidenceBridge({
      target: 'h3',
      available: ['tokenizer'],
      deps: deps({ tokenizer: tokenizerExact }),
    })
    expect((await bridge2.query('tokenizer', 'x')).summary).toBe('tokens=7')
  })

  it('query: deps 函数抛错 → ok:false + 错误消息前200字符，绝不抛出（含 async rejection）', async () => {
    const catalog = vi.fn().mockRejectedValue(new Error('e:'.padEnd(250, 'x')))
    const tokenizer = vi.fn(() => {
      throw new Error('sync boom')
    })
    const bridge = createEvidenceBridge({
      target: 'anima',
      available: ['catalog', 'tokenizer'],
      deps: deps({ catalog, tokenizer }),
    })
    const r1 = await bridge.query('catalog', 'q')
    expect(r1.ok).toBe(false)
    expect(r1.summary.length).toBe(200)
    expect(r1.summary).toMatch(/^e:x+/)
    const r2 = await bridge.query('tokenizer', 'q')
    expect(r2.ok).toBe(false)
    expect(r2.summary).toBe('sync boom')
  })

  it('query: deps 里没有该工具 → ok:false + tool unavailable', async () => {
    const bridge = createEvidenceBridge({
      target: 'anima',
      available: ['catalog', 'aesthetics'],
      deps: deps({}), // 全缺
    })
    const r = await bridge.query('catalog', 'q')
    expect(r).toEqual({ tool: 'catalog', query: 'q', summary: 'tool unavailable', ok: false })
    expect(bridge.list()).toEqual([])
  })

  it('query: 摘要超 300 字符截断为 299 + …', async () => {
    const aesthetics = vi.fn().mockResolvedValue({
      score: 0.7,
      issues: ['i'.repeat(400)],
    })
    const bridge = createEvidenceBridge({
      target: 'anima',
      available: ['aesthetics'],
      deps: deps({ aesthetics }),
    })
    const r = await bridge.query('aesthetics', 'bp text')
    expect(aesthetics).toHaveBeenCalledWith('bp text')
    expect(r.summary.length).toBe(300)
    expect(r.summary.endsWith('…')).toBe(true)
    expect(r.ok).toBe(true)
  })
})
