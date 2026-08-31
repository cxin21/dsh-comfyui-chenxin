import { describe, expect, it, afterAll } from 'vitest'
import { registerAuthorTool, setAuthorIntentProvider, type AuthorIntentRequest } from '../../src/tools/prompt-author.js'
import { stubCtx, runTool } from './helpers.js'
import { closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'

const cfg = { temperature: 0.7 }

function providerFor(drafts: Array<Record<string, unknown> | Error>) {
  let calls = 0
  const fn = async (req: AuthorIntentRequest) => {
    calls++
    const d = drafts[Math.min(calls - 1, drafts.length - 1)]
    if (d instanceof Error) throw d
    return { slots: d.slots as never, shots: d.shots as never }
  }
  return { fn, calls: () => calls }
}

describe('prompt_author full pipeline (P4)', () => {
  const GOOD_SLOTS = { slots: { count_gender: ['1girl'], appearance: ['long hair'] } }
  const GOOD_SHOTS = { shots: { duration_seconds: 6, shots: [{ what: 'A cat stretches.', ambient: 'soft wind' }] } }

  it('anima full chain: intent → compile → audit → Envelope with t2i.prompt hint', async () => {
    const { fn, calls } = providerFor([GOOD_SLOTS])
    setAuthorIntentProvider(fn)
    const raw = JSON.parse(String(await runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), { target: 'anima', input: 'cat portrait' })))
    expect(calls()).toBe(1)
    expect(raw.ok).toBe(true)
    expect(raw.result.positive).toBe('masterpiece, best quality, score_7, safe, 1girl, long hair')
    expect(raw.target_slot_hint).toBe('t2i.prompt')
    expect(raw.audit.gates).toBeDefined()
  })

  it('h3 full chain: intent shots → compile → audit → Envelope with t2v.prompt + budget', async () => {
    const { fn } = providerFor([GOOD_SHOTS])
    setAuthorIntentProvider(fn)
    const raw = JSON.parse(String(await runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), { target: 'h3', input: 'cat stretch' })))
    expect(raw.ok).toBe(true)
    expect(raw.result.text).toContain('integrated_multimodal_description: [Shot 1] A cat stretches.')
    expect(raw.target_slot_hint).toBe('t2v.prompt')
    expect(raw.audit.budget.counter).toBe('official-tokenizer')
  })

  it('audit_only skips the intent LLM (zero provider calls)', async () => {
    const { fn, calls } = providerFor([GOOD_SLOTS])
    setAuthorIntentProvider(fn)
    const raw = JSON.parse(String(await runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), {
      target: 'anima', audit_only: true, input: JSON.stringify({ count_gender: ['1girl'], appearance: ['long hair'] }),
    })))
    expect(calls()).toBe(0)
    expect(raw.ok).toBe(true)
    expect(raw.result.positive).toContain('1girl')
  })

  it('sd/generic still report DIALECT_NOT_AVAILABLE envelope', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), { target: 'sd', input: 'x' })))
    expect(raw.ok).toBe(false)
    expect(raw.audit.gates[0].rule).toBe('dialect_not_available')
  })

  it('LLM/provider failure propagates as thrown error', async () => {
    setAuthorIntentProvider(async () => { throw new Error('llm down') })
    await expect(runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), { target: 'h3', input: 'x' })).rejects.toThrow('llm down')
  })

  it('unknown variant errors at compile stage', async () => {
    setAuthorIntentProvider(async () => ({ slots: { count_gender: ['1girl'] } }))
    await expect(runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), { target: 'anima', input: 'x', variant: 'bogus' })).rejects.toThrow(/未知 variant/)
  })

  afterAll(() => { setAuthorIntentProvider(null); closeCatalog() })
})