/**
 * B7（外部基准 2026-09）：catalog 候选召回纯函数回归。
 * 证据进生成回路：intent 前置召回已验证规范 tag 注入 persona；本文件用 mock search 钉死
 * n-gram 召回/去重/上限/过滤语义（不连实库——实库行为由 anima-external-benchmark.test.ts 覆盖）。
 */
import { describe, expect, it } from 'vitest'
import { catalogCandidatesForText, type CatalogRecallOptions } from '../../../src/pe-framework/dialect/catalog-recall.js'

type Hit = { match_type?: string; prompt_form?: string; raw?: string }

function mockSearch(table: Record<string, Hit>): NonNullable<CatalogRecallOptions['search']> {
  return (tag: string) => (table[tag] ? [table[tag]] : [])
}

describe('catalogCandidatesForText', () => {
  it('长 n-gram 优先命中并吞并短 n-gram（white hair 命中后不再重复注入 white/hair）', () => {
    const search = mockSearch({
      'white hair': { match_type: 'canonical', prompt_form: 'white hair' },
      white: { match_type: 'canonical', prompt_form: 'white' },
      hair: { match_type: 'canonical', prompt_form: 'hair' },
    })
    const out = catalogCandidatesForText('A girl with white hair', { search })
    expect(out).toEqual(['white hair'])
  })

  it('CJK-only 输入返回空（catalog 无中文别名，召回依赖 enrich 英文 brief）', () => {
    const search = mockSearch({ 街道: { match_type: 'canonical', prompt_form: 'street' } })
    expect(catalogCandidatesForText('雨夜的街道', { search })).toEqual([])
  })

  it('fuzzy 与 miss 不注入（只收 canonical/alias）', () => {
    const search = mockSearch({
      rain: { match_type: 'fuzzy', prompt_form: 'rainy day' },
      night: { match_type: 'miss' },
      neon: { match_type: 'alias', prompt_form: 'neon signs' },
    })
    const out = catalogCandidatesForText('neon rain night', { search })
    expect(out).toEqual(['neon signs'])
  })

  it('@画师型候选跳过（画师是风格层决策，不从文本猜）', () => {
    const search = mockSearch({ rella: { match_type: 'canonical', prompt_form: '@rella' } })
    expect(catalogCandidatesForText('rella style artwork', { search })).toEqual([])
  })

  it('候选去重（同一 prompt_form 命中两次只注一次）+ maxCandidates 上限', () => {
    const search = mockSearch({
      'white hair': { match_type: 'canonical', prompt_form: 'white hair' },
      'long white hair': { match_type: 'canonical', prompt_form: 'white hair' },
      'blue eyes': { match_type: 'canonical', prompt_form: 'blue eyes' },
    })
    const out = catalogCandidatesForText('long white hair, blue eyes', { search, maxCandidates: 1 })
    expect(out).toEqual(['white hair'])
  })

  it('检索抛错返回已收集部分（增强层不阻塞）', () => {
    let calls = 0
    const search = (tag: string): Hit[] => {
      if (tag.includes('first')) return [{ match_type: 'canonical', prompt_form: 'first hit' }]
      calls++
      if (calls >= 4) throw new Error('db gone')
      return []
    }
    // 'first hit then' 命中后覆盖吞并 0-2 词位，后续未覆盖词位继续检索至第 4 次抛错
    const out = catalogCandidatesForText('first hit then boom crash', { search })
    expect(out).toEqual(['first hit'])
  })

  it('maxLookups 截断检索次数', () => {
    let calls = 0
    const search = (): Hit[] => {
      calls++
      return []
    }
    catalogCandidatesForText('one two three four five six seven eight', { search, maxLookups: 3 })
    expect(calls).toBe(3)
  })
})
