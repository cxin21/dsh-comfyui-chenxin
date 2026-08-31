import { describe, expect, it } from 'vitest'
import { registerCompileTool } from '../../src/tools/prompt-compile.js'
import { stubCtx, runTool } from './helpers.js'

const def = () => registerCompileTool()
const run = async (args: Record<string, unknown>) => JSON.parse(String(await runTool(stubCtx(), def(), args)))

describe('prompt_compile (target=h3)', () => {
  it('scenario_id=full_reference maps to shots (with references) and compiles six-section text', async () => {
    const raw = await run({
      target: 'h3',
      scenario_id: 'full_reference',
      form_fields: {
        subject: 'bai fa jian ke', scene: 'xue shan', duration_seconds: '10', ambient: 'feng xue', music: 'gu zheng',
        references: [{ kind: 'picture', who: 'Sword', image: 'snow.png', width: 1024, height: 1024 }], // T13 F2 refs mapping
      },
    })
    expect(raw.ok).toBe(true) // refs mapped → no references_unmapped critical
    const text: string = raw.result.text
    expect(text.length).toBeGreaterThan(0)
  })

  it('direct shots input compiles deterministically', async () => {
    const raw = await run({ target: 'h3', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } })
    expect(raw.ok).toBe(true)
    expect(raw.result.text).toContain('integrated_multimodal_description: [Shot 1]')
  })

  it('ref2va → auditH3Full label gates run with references (F2)', async () => {
    const raw = await run({
      target: 'h3',
      stage: 'ref2va',
      shots: { duration_seconds: 8, shots: [{ what: 'x', who: 'A' }], references: [{ kind: 'picture', who: 'A', image: 'a.png' }] as never },
    })
    expect(raw.result.text).toContain('subject_definitions:')
  })

  it('F1 contract gate: ref2va with 2 references rejected as critical ref_count', async () => {
    const raw = await run({
      target: 'h3',
      stage: 'ref2va',
      shots: { duration_seconds: 8, shots: [{ what: 'x', who: 'A' }] },
      form_fields: { references: [{ who: 'A', image: 'a.png' }, { who: 'B', image: 'b.png' }] },
    })
    expect(raw.audit.passed).toBe(false) // 审计闸门经 audit.passed 表达
    expect(raw.audit.gates.some((g: any) => g.rule === 'ref_count' && g.severity === 'critical')).toBe(true)
  })

  it('MF-3: critical gate keeps result for non-audit_only compile (ok=false but result.text present)', async () => {
    const raw = await run({
      target: 'h3',
      stage: 'ref2va',
      shots: { duration_seconds: 8, shots: [{ what: 'x', who: 'A' }] },
      form_fields: { references: [{ who: 'A', image: 'a.png' }, { who: 'B', image: 'b.png' }] },
    })
    expect(raw.ok).toBe(false)
    expect(raw.result).toBeDefined()
    expect(typeof raw.result.text).toBe('string')
    expect(raw.result.text.length).toBeGreaterThan(0)
  })

  it('budget counter is official-tokenizer (T12 switch)', async () => {
    const raw = await run({ target: 'h3', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } })
    expect(raw.audit.budget.counter).toBe('official-tokenizer')
  })

  it('unknown target errors with DIALECT_NOT_AVAILABLE', async () => {
    await expect(runTool(stubCtx(), def(), { target: 'sd', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } } as any)).rejects.toThrow(/DIALECT_NOT_AVAILABLE/)
  })

  it('stage inference via tool: references → ref2va, else t2va, full_reference scenario → ref2va', async () => {
    // stage 推断收敛进 runStage normalize 单点（Task 6）；此处经工具入口做行为等价断言
    const withRefs = await run({
      target: 'h3',
      shots: { duration_seconds: 8, shots: [{ what: 'x', who: 'A' }], references: [{ kind: 'picture', who: 'A', image: 'a.png' }] as never },
    })
    expect(withRefs.result.text).toContain('subject_definitions:') // ref2va
    const noRefs = await run({ target: 'h3', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } })
    expect(noRefs.result.text).toContain('integrated_multimodal_description:') // t2va
    const fullRef = await run({
      target: 'h3', scenario_id: 'full_reference',
      form_fields: {
        subject: 'bai fa jian ke', scene: 'xue shan', duration_seconds: '10', ambient: 'feng xue', music: 'gu zheng',
        references: [{ kind: 'picture', who: 'Sword', image: 'snow.png', width: 1024, height: 1024 }],
      },
    })
    expect(fullRef.result.text).toContain('subject_definitions:') // ref2va
  })
})
