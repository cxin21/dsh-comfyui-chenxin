import { describe, expect, it, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { readGolden } from './harness.js'
import { compileAnima, auditAnima } from '../../src/pe-framework/dialect/anima.js'
import { searchCatalog, closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'

const realSearch = (t: string) => searchCatalog(t, { limit: 5 })

const BRIEFS = ['ex1-minimal', 'ex2-veteran', 'ex3-miku', 'ex4-advisories', 'ex5-explicit', 'ex6-lora']

/** skill brief JSON → AnimaSlots */
function toSlots(brief: any): any {
  return {
    ...(brief.slots ?? {}),
    narrative: brief.narrative,
    explicit: brief.explicit === true,
    qualityPrefix: brief.quality_prefix !== false,
    exclusions: brief.exclusions,
    subject: brief.subject,
  }
}

/** golden advisory "[severity] code: msg" → code 集合 */
function goldenCodes(advisories: string[]): string[] {
  return advisories.map((a) => {
    const m = /^\[[^\]]+\]\s+([a-z_]+):/.exec(a)
    return m ? m[1] : a
  }).sort()
}

describe('anima brief golden double-run (positive/negative 逐字节 + 投影)', () => {
  for (const name of BRIEFS) {
    it(`${name}: positive/negative byte-exact against CLI author output`, () => {
      const entry = readGolden(`anima-brief-${name}`)
      const brief = entry.input as any
      const goldenPrompt = (entry.pythonOutput as any).result.prompt
      const compiled = compileAnima(toSlots(brief), { variant: brief.variant ?? 'base', search: realSearch })
      expect(compiled.positive).toBe(goldenPrompt.positive)
      expect(compiled.negative).toBe(goldenPrompt.negative)
    })
  }

  for (const name of BRIEFS) {
    it(`${name}: assumptions and advisory-code projection align with golden`, () => {
      const entry = readGolden(`anima-brief-${name}`)
      const brief = entry.input as any
      const goldenPrompt = (entry.pythonOutput as any).result.prompt
      const slots = toSlots(brief)
      const compiled = compileAnima(slots, { variant: brief.variant ?? 'base', search: realSearch })
      expect(compiled.assumptions.sort()).toEqual([...(goldenPrompt.assumptions ?? [])].sort())
      const gates = auditAnima(compiled.positive, compiled.negative, { variant: brief.variant ?? 'base', search: realSearch, slots })
      // catalog_miss 在源码中经 assumptions 透出（上面已比）；此处比 advisory 投影（inspection 派生代码）
      // tag_budget_exceeded（Round 8 F7）为 TS 原生软预算 gate，无 Python 对应规则——与 catalog_miss
      // 同一排除口径（ex2-veteran 43 段 > 预算 40 属真实触发，gate 行为由 anima-f7.test.ts 覆盖）
      // aesthetic_*_missing（M1 Task 9，spec §6.1）同为 TS 原生确定性美学 gate，Python 时代无对应——
      // 同一排除口径（哨兵测试在 tests/pe-framework/aesthetics/audit.test.ts）
      expect(gates.filter((g) => g.rule !== 'catalog_miss' && g.rule !== 'tag_budget_exceeded' && !g.rule.startsWith('aesthetic_')).map((g) => g.rule).sort()).toEqual(goldenCodes(goldenPrompt.advisories ?? []))
    })
  }

  it('goldens are sha256-self-consistent (M5)', () => {
    for (const name of BRIEFS) {
      const entry = readGolden(`anima-brief-${name}`)
      const sha = createHash('sha256').update(JSON.stringify(entry.pythonOutput)).digest('hex')
      expect(sha, `anima-brief-${name}`).toBe(entry.sha256)
    }
  })

  afterAll(() => closeCatalog())
})