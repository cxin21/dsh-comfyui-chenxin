import { afterAll, describe, expect, it } from 'vitest'
import { auditContentEnvelope, reconcileSemanticFallback } from '../../src/tools/prompt-audit.js'
import { setVectorSearch, closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'
import type { AuditGate } from '../../src/pe-framework/types.js'

afterAll(() => {
  setVectorSearch(null)
  closeCatalog()
})

describe('prompt-audit boundary: catalog_miss → semantic_fallback reconciliation (T11-001)', () => {
  it('semantic 可解（子串召回 + tie-breaker：selafuku→serafuku）的 miss gate 被转换为 semantic_fallback', async () => {
    setVectorSearch(async () => []) // KNN miss → 依赖真实子串召回 + tie-breaker 产出 serafuku
    const gates: AuditGate[] = [
      { rule: 'catalog_miss', target: 'anima', severity: 'minor', detail: 'catalog_miss:selafuku（保留原文未替换）', source: 'dialect/anima' },
    ]
    const reconciled = await reconcileSemanticFallback(gates)
    expect(reconciled).toHaveLength(1)
    expect(reconciled[0].rule).toBe('semantic_fallback')
    expect(reconciled[0].detail).toContain('semantic_fallback:selafuku→serafuku（保留原文未替换）')
    expect(reconciled[0].severity).toBe('minor')
  })

  it('不可解查询（无子串命中、无 KNN 命中）的 miss gate 保持原样', async () => {
    setVectorSearch(async () => [])
    const gates: AuditGate[] = [
      { rule: 'catalog_miss', target: 'anima', severity: 'minor', detail: 'catalog_miss:qqqqwwww（保留原文未替换）', source: 'dialect/anima' },
    ]
    const reconciled = await reconcileSemanticFallback(gates)
    expect(reconciled).toHaveLength(1)
    expect(reconciled[0].rule).toBe('catalog_miss')
  })

  it('非 catalog_miss 的 gate 原样透传', async () => {
    setVectorSearch(async () => [])
    const gates: AuditGate[] = [
      { rule: 'field_order', target: 'h3', severity: 'critical', detail: 'x', source: 't' },
      { rule: 'catalog_miss', target: 'anima', severity: 'minor', detail: 'catalog_miss:selafuku（保留原文未替换）', source: 'dialect/anima' },
    ]
    const reconciled = await reconcileSemanticFallback(gates)
    expect(reconciled.some((g) => g.rule === 'field_order')).toBe(true)
    expect(reconciled.some((g) => g.rule === 'semantic_fallback' && g.detail.includes('selafuku→serafuku'))).toBe(true)
    expect(reconciled.some((g) => g.rule === 'catalog_miss')).toBe(false)
  })

  it('端到端：auditContentEnvelope（slots 含 selafuku）产出的 miss gate 被 reconcile 转换', async () => {
    setVectorSearch(async () => [])
    const out = auditContentEnvelope({ target: 'anima', positive: '1girl', negative: '', slots: { clothing: ['selafuku'] } })
    const env = JSON.parse(out) as { audit?: { gates?: AuditGate[] } }
    const missGates = (env.audit?.gates ?? []).filter((g) => g.rule === 'catalog_miss')
    expect(missGates.some((g) => g.detail.includes('selafuku'))).toBe(true) // 前置：同步审计确实报了 miss
    const reconciled = await reconcileSemanticFallback(env.audit!.gates!)
    expect(reconciled.some((g) => g.rule === 'semantic_fallback' && g.detail.includes('selafuku→serafuku'))).toBe(true)
    expect(reconciled.some((g) => g.rule === 'catalog_miss' && g.detail.includes('selafuku'))).toBe(false)
  })
})
