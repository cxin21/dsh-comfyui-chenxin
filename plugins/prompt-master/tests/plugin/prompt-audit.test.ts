import { describe, expect, it } from 'vitest'
import { registerAuditTool, auditContentEnvelope } from '../../src/tools/prompt-audit.js'
import { stubCtx, runTool } from './helpers.js'

const cfg = { temperature: 0.7 }
const def = () => registerAuditTool(null as never, cfg as never)

describe('prompt_audit (pure audit gate)', () => {
  it('h3 text audit returns envelope with official-tokenizer budget', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'h3',
      text: 'integrated_multimodal_description: [Shot 1] A cat stretches.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A',
      stage: 't2va', duration: 6, shotCount: 1,
    })))
    expect(raw.ok).toBe(true)
    expect(raw.audit.passed).toBe(true)
    expect(raw.audit.budget.counter).toBe('official-tokenizer')
  })

  it('anima positive/negative audit (with slots) works with no budget', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'anima',
      positive: 'masterpiece, best quality, score_7, safe, 1girl',
      negative: 'worst quality, low quality',
      slots: { count_gender: ['1girl'] },
    })))
    expect(raw.ok).toBe(true)
    expect('budget' in raw.audit).toBe(false)
    expect(raw.audit.gates.some((g: any) => g.rule === 'tag_count_out_of_range')).toBe(true)
  })

  it('unknown target errors', async () => {
    await expect(runTool(stubCtx(), def(), { target: 'sd', text: 'x' })).rejects.toThrow(/未知 target/)
  })

  it('h3 critical gate surfaces (ref2va 2 refs)', () => {
    const raw = JSON.parse(auditContentEnvelope({
      target: 'h3',
      text: 'subject_definitions: <Subject 1> is A from <Picture 1>.\n\nsummary: x\n\ndetailed_description: [Shot 1] a.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A',
      stage: 'ref2va', duration: 8, shotCount: 1,
      references: [{ who: 'A', image: 'a.png' }, { who: 'B', image: 'b.png' }],
    }))
    expect(raw.audit.gates.some((g: any) => g.rule === 'ref_count' && g.severity === 'critical')).toBe(true)
  })
})