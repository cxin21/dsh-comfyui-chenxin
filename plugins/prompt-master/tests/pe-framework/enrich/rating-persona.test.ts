import { describe, expect, it, vi } from 'vitest'
import { buildEnrichPersona } from '../../../src/pe-framework/enrich/personas.js'
import { runEnrich } from '../../../src/pe-framework/enrich/engine.js'
import type { CriticProvider } from '../../../src/pe-framework/eval/critic.js'

function validBriefJson(): string {
  const item = { text: '1girl', source: 'user' }
  return JSON.stringify({
    outputLang: 'en',
    subject: [item],
    scene: [{ text: 'rainy neon street', source: 'enriched' }],
    composition: [{ text: 'medium shot', source: 'enriched' }],
    lighting: [{ text: 'soft ambient shading', source: 'enriched' }],
    color: [{ text: 'teal and orange', source: 'enriched' }],
    style: [{ text: 'cel shading', source: 'enriched' }],
    mood: [{ text: 'melancholic', source: 'enriched' }],
    nameAnchors: [],
  })
}

const captured: { persona: string; schema: string; user: string }[] = []
function capturing(inner: CriticProvider): CriticProvider {
  return async (req) => {
    captured.push(req)
    return inner(req)
  }
}

describe('enrich persona rating blocks (spec §7 P2)', () => {
  it('anima persona carries explicit-tier vocabulary instruction', () => {
    const p = buildEnrichPersona('anima', { rating: 'explicit' })
    expect(p).toContain('【内容分级】')
    expect(p).toContain('Danbooru 成人内容 tag 词表')
    expect(p).toContain('禁止委婉语')
  })
  it('defaults to safe block; h3 has no rating block', () => {
    expect(buildEnrichPersona('anima')).toContain('本请求内容分级：safe')
    expect(buildEnrichPersona('h3')).not.toContain('【内容分级】')
  })
  it('rating block is inserted before the output contract section', () => {
    const p = buildEnrichPersona('anima', { rating: 'explicit' })
    expect(p.indexOf('【内容分级】')).toBeGreaterThan(-1)
    expect(p.indexOf('【内容分级】')).toBeLessThan(p.indexOf('【输出契约（硬性）】'))
  })
  it('runEnrich threads rating into the anima persona', async () => {
    captured.length = 0
    const res = await runEnrich({ target: 'anima', userInput: 'x', provider: capturing(async () => validBriefJson()), rating: 'sensitive' })
    expect('brief' in res).toBe(true)
    expect(captured[0].persona).toContain('本请求内容分级：sensitive')
  })
})

describe('recommendation prior injection (spec §6.2/§7 P2)', () => {
  it('recommendation prior is rendered into user text when provided', async () => {
    captured.length = 0
    const res = await runEnrich({
      target: 'anima',
      userInput: 'a girl in rain',
      provider: capturing(async () => validBriefJson()),
      recommendations: [
        { field: 'lighting', cardId: 'golden_hour', reason: 'lighting gate triggered' },
        { field: 'perspective', cardId: 'close_up', reason: 'portrait close-up intent' },
      ],
    })
    expect('brief' in res).toBe(true)
    const user = captured[0].user
    expect(user).toContain('【推荐先验】艺术指导推荐器建议（你仍做最终设计决策，每类至多 1 张）：')
    expect(user).toContain('- lighting: golden_hour（lighting gate triggered）')
    expect(user).toContain('- perspective: close_up（portrait close-up intent）')

    captured.length = 0
    await runEnrich({ target: 'anima', userInput: 'x', provider: capturing(async () => validBriefJson()) })
    expect(captured[0].user).not.toContain('【推荐先验】')
  })
})
