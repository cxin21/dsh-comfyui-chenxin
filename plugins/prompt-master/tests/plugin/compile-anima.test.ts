import { describe, expect, it, afterAll } from 'vitest'
import { registerCompileTool, compileAnimaEnvelope } from '../../src/tools/prompt-compile.js'
import { stubCtx, runTool } from './helpers.js'
import { closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'

const def = () => registerCompileTool()

describe('prompt_compile (target=anima)', () => {
  it('slots → positive/negative text + audit envelope', async () => {
    const ctx = stubCtx()
    const raw = JSON.parse(String(await runTool(ctx, def(), {
      target: 'anima',
      slots: { count_gender: ['1girl'], appearance: ['long hair'] },
    })))
    expect(raw.ok).toBe(true)
    expect(raw.result.positive).toBe('masterpiece, best quality, score_7, safe, 1girl, long hair')
    expect(raw.result.negative).toBe('worst quality, low quality, score_1, score_2, score_3')
    expect(raw.audit.passed).toBe(true)
  })

  it('variant injection: aesthetic drops score terms', async () => {
    const raw = JSON.parse(compileAnimaEnvelope({ count_gender: ['1girl'] }, 'aesthetic'))
    expect(raw.result.positive).toBe('masterpiece, best quality, safe, 1girl')
  })

  it('slots missing → param error', async () => {
    await expect(runTool(stubCtx(), def(), { target: 'anima' })).rejects.toThrow(/slots/)
  })

  it('h3-only params rejected under anima target', async () => {
    await expect(runTool(stubCtx(), def(), { target: 'anima', scenario_id: 'full_reference' })).rejects.toThrow(/scenario_id\/form_fields\/shots/)
  })

  it('Envelope carries audit gates and no budget field', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'anima',
      slots: { scene: ['moonlight', 'backlighting'] },
    })))
    expect(raw.audit.gates.some((g: any) => g.rule === 'lighting_term_banned')).toBe(true)
    expect('budget' in raw.audit).toBe(false)
  })

  it('h3 params rejected under h3 target when anima-only fields passed', async () => {
    await expect(runTool(stubCtx(), def(), { target: 'h3', slots: { count_gender: ['1girl'] } })).rejects.toThrow(/slots\/variant/)
  })

  it('unknown target still errors DIALECT_NOT_AVAILABLE', async () => {
    await expect(runTool(stubCtx(), def(), { target: 'sd' })).rejects.toThrow(/DIALECT_NOT_AVAILABLE/)
  })

  it('unknown variant errors (R1/strict params)', async () => {
    await expect(runTool(stubCtx(), def(), { target: 'anima', slots: { count_gender: ['1girl'] }, variant: 'bogus' })).rejects.toThrow(/未知 variant/)
  })

  afterAll(() => closeCatalog())
})