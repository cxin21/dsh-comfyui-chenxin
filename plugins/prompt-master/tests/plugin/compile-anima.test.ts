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

  it('P1: cross-slot duplicate preserved (upstream composition.py has no dedup) but duplicate_segment gate fires', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'anima',
      slots: { count_gender: ['1girl'], character: ['1girl'], appearance: ['red hair'] },
    })))
    // 忠实复刻上游：1girl 出现两次（count_gender + character 各一次）
    const pos = raw.result.positive.split(', ').map((s: string) => s.trim()).filter(Boolean)
    expect(pos.filter((t: string) => t === '1girl').length).toBe(2)
    // 审计稿 duplicate_segment gate 标记（闭环里模型据此自修正）
    expect(raw.audit.gates.some((g: any) => g.rule === 'duplicate_segment')).toBe(true)
  })

  it('P2: scene-source light words (neon lights/streetlights) NOT banned; true light-effect words still banned', async () => {
    // neon/streetlights 是场景光源对象，不再触发 lighting_term_banned
    const scene = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'anima',
      slots: { scene: ['neon lights', 'streetlights'], count_gender: ['1girl'] },
    })))
    expect(scene.audit.gates.some((g: any) => g.rule === 'lighting_term_banned')).toBe(false)
    // 真实光照词仍禁（现有 L34 测试已覆盖 moonlight/backlighting——此处锚定 rim light）
    const light = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'anima',
      slots: { detail_mood: ['rim light'], count_gender: ['1girl'] },
    })))
    expect(light.audit.gates.some((g: any) => g.rule === 'lighting_term_banned')).toBe(true)
  })

  it('G2: segments projection (origin/priority/slot provenance)', async () => {
    const ctx = stubCtx()
    const raw = JSON.parse(String(await runTool(ctx, def(), {
      target: 'anima',
      slots: { count_gender: ['1girl'], appearance: ['long hair'], narrative: '一段描述', exclusions: ['lowres'] },
    })))
    const segs = raw.result.segments as Array<{ text: string; channel: string; origin: string; priority: number; slot?: string }>
    expect(segs.filter((s) => s.origin === 'policy').length).toBeGreaterThan(0)
    expect(segs.some((s) => s.origin === 'grounded' && s.slot === 'count_gender')).toBe(true)
    expect(segs.some((s) => s.origin === 'narrative' && s.channel === 'positive')).toBe(true)
    expect(segs.some((s) => s.origin === 'exclusion' && s.channel === 'negative')).toBe(true)
    expect(segs.every((s) => typeof s.priority === 'number')).toBe(true)
  })

  it('G2: phase_status four stages', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'anima', slots: { count_gender: ['1girl'] },
    })))
    expect(raw.result.phase_status).toEqual({ policy: 'PASS', grounding: 'PASS', composition: 'PASS', inspection: 'PASS' })
  })

  it('G2: phase_status projected at envelope top level', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'anima', slots: { count_gender: ['1girl'] },
    })))
    expect(raw.phase_status).toEqual({ policy: 'PASS', grounding: 'PASS', composition: 'PASS', inspection: 'PASS' })
  })

  it('G2: h3 envelope has no top-level phase_status', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'h3', shots: { duration_seconds: 5, shots: [{ what: '女孩走进便利店', dialogue: ['你好'] }] },
    })))
    expect('phase_status' in raw).toBe(false)
  })

  it('G2: metadata carries variant', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'anima', slots: { count_gender: ['1girl'] }, variant: 'aesthetic',
    })))
    expect(raw.result.metadata).toEqual({ variant: 'aesthetic' })
  })

  afterAll(() => closeCatalog())
})