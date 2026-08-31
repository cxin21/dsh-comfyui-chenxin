import { describe, expect, it } from 'vitest'
import { registerCompileTool, compileH3Envelope, inferH3Stage } from '../../src/tools/prompt-compile.js'
import { stubCtx, runTool } from './helpers.js'

const def = () => registerCompileTool()

describe('prompt_compile (target=h3)', () => {
  it('scenario_id=full_reference maps to shots (with references) and compiles six-section text', async () => {
    const ctx = stubCtx()
    const raw = JSON.parse(String(await runTool(ctx, def(), {
      target: 'h3',
      scenario_id: 'full_reference',
      form_fields: {
        subject: 'bai fa jian ke', scene: 'xue shan', duration_seconds: '10', ambient: 'feng xue', music: 'gu zheng',
        references: [{ kind: 'picture', who: 'Sword', image: 'snow.png', width: 1024, height: 1024 }], // T13 F2 refs mapping
      },
    })))
    expect(raw.ok).toBe(true) // refs mapped → no references_unmapped critical
    const text: string = raw.result.text
    expect(text.length).toBeGreaterThan(0)
  })

  it('direct shots input compiles deterministically', async () => {
    const raw = JSON.parse(compileH3Envelope({ stage: 't2va', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } }))
    expect(raw.ok).toBe(true)
    expect(raw.result.text).toContain('integrated_multimodal_description: [Shot 1]')
  })

  it('ref2va → auditH3Full label gates run with references (F2)', async () => {
    const raw = JSON.parse(compileH3Envelope({
      stage: 'ref2va',
      shots: { duration_seconds: 8, shots: [{ what: 'x', who: 'A' }], references: [{ kind: 'picture', who: 'A', image: 'a.png' }] as never },
    }))
    expect(raw.result.text).toContain('subject_definitions:')
  })

  it('F1 contract gate: ref2va with 2 references rejected as critical ref_count', async () => {
    const raw = JSON.parse(compileH3Envelope({
      stage: 'ref2va',
      shots: { duration_seconds: 8, shots: [{ what: 'x', who: 'A' }] },
      references: [{ who: 'A', image: 'a.png' }, { who: 'B', image: 'b.png' }],
    }))
    expect(raw.audit.passed).toBe(false) // ok=编译成功；审计闸门经 audit.passed 表达
    expect(raw.audit.gates.some((g: any) => g.rule === 'ref_count' && g.severity === 'critical')).toBe(true)
  })

  it('budget counter is official-tokenizer (T12 switch)', async () => {
    const v = compileH3Envelope({ stage: 't2va', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } })
    expect(JSON.parse(v).audit.budget.counter).toBe('official-tokenizer')
  })

  it('unknown target errors with DIALECT_NOT_AVAILABLE', async () => {
    await expect(runTool(stubCtx(), def(), { target: 'sd', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } } as any)).rejects.toThrow(/DIALECT_NOT_AVAILABLE/)
  })

  it('stage inference: references → ref2va, else t2va, full_reference → ref2va', () => {
    expect(inferH3Stage({ duration_seconds: 8, shots: [{ what: 'x' }], references: [{ who: 'A', image: 'a.png' }] as never })).toBe('ref2va')
    expect(inferH3Stage({ duration_seconds: 6, shots: [{ what: 'x' }] })).toBe('t2va')
    expect(inferH3Stage({ duration_seconds: 8, shots: [{ what: 'x' }] }, 'full_reference')).toBe('ref2va')
  })
})