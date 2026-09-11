import { describe, it, expect, vi } from 'vitest'
import { runEnrich } from '../../../src/pe-framework/enrich/engine.js'
import type { CriticProvider } from '../../../src/pe-framework/eval/critic.js'
import type { EnrichedBrief } from '../../../src/pe-framework/enrich/brief.js'

function validBriefJson(over: Record<string, unknown> = {}): string {
  const item = { text: '1girl', source: 'user' }
  return JSON.stringify({
    outputLang: 'en',
    subject: [item],
    scene: [{ text: 'rainy neon street', source: 'enriched' }],
    composition: [{ text: 'medium shot', source: 'enriched' }],
    lighting: [{ text: 'rim light', source: 'enriched' }],
    color: [{ text: 'teal and orange', source: 'enriched' }],
    style: [{ text: 'cinematic', source: 'enriched' }],
    mood: [{ text: 'melancholic', source: 'enriched' }],
    nameAnchors: [],
    ...over,
  })
}

function providerReturning(json: string): CriticProvider {
  return vi.fn(async () => json)
}

function providerThrowing(): CriticProvider {
  return vi.fn(async () => {
    throw new Error('subagent down')
  })
}

const captured: { persona: string; schema: string; user: string }[] = []
function capturing(inner: CriticProvider): CriticProvider {
  return async (req) => {
    captured.push(req)
    return inner(req)
  }
}

/* 规格 1：正常路径 */
describe('runEnrich 正常路径', () => {
  it('provider 返回带 fence 的合法 JSON → strip fence → { brief }', async () => {
    const fenced = '```json\n' + validBriefJson() + '\n```'
    const res = await runEnrich({ target: 'anima', userInput: 'a girl in rain', provider: providerReturning(fenced) })
    if ('brief' in res) {
      expect(res.brief.outputLang).toBe('en')
      expect(res.brief.scene[0]).toEqual({ text: 'rainy neon street', source: 'enriched' })
    } else { expect.unreachable() }
  })
})

/* 规格 2：三类故障 → skipped，永不抛出 */
describe('runEnrich 降级', () => {
  it('provider 抛错 → skipped enrich_llm_error', async () => {
    const res = await runEnrich({ target: 'anima', userInput: 'x', provider: providerThrowing() })
    expect(res).toEqual({ skipped: true, reason: 'enrich_llm_error' })
  })

  it('JSON parse 失败 / schema 不合 → skipped enrich_invalid_schema', async () => {
    const bad1 = await runEnrich({ target: 'anima', userInput: 'x', provider: providerReturning('not json at all {') })
    expect(bad1).toEqual({ skipped: true, reason: 'enrich_invalid_schema' })
    const bad2 = await runEnrich({ target: 'anima', userInput: 'x', provider: providerReturning(JSON.stringify({ outputLang: 'en' })) })
    expect(bad2).toEqual({ skipped: true, reason: 'enrich_invalid_schema' })
  })

  it('大小超限 → skipped brief_too_large', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ text: `t${i}`, source: 'enriched' }))
    const res = await runEnrich({ target: 'h3', userInput: 'x', provider: providerReturning(validBriefJson({ subject: many })) })
    expect(res).toEqual({ skipped: true, reason: 'brief_too_large' })
  })
})

/* 规格 3：outputLang 锁定 */
describe('runEnrich outputLang', () => {
  it('anima 显式传 zh 也强制 en', async () => {
    const res = await runEnrich({ target: 'anima', userInput: '雨中的少女', outputLang: 'zh', provider: providerReturning(validBriefJson({ outputLang: 'zh' })) })
    if ('brief' in res) expect(res.brief.outputLang).toBe('en')
    else expect.unreachable()
  })

  it('anima 未指定 → en', async () => {
    const res = await runEnrich({ target: 'anima', userInput: '雨中的少女', provider: providerReturning(validBriefJson()) })
    if ('brief' in res) expect(res.brief.outputLang).toBe('en')
    else expect.unreachable()
  })

  it('h3 显式优先（ja）', async () => {
    const res = await runEnrich({ target: 'h3', userInput: 'any', outputLang: 'ja', provider: providerReturning(validBriefJson()) })
    if ('brief' in res) expect(res.brief.outputLang).toBe('ja')
    else expect.unreachable()
  })

  it('h3 未指定：中文输入 → zh，英文输入 → en', async () => {
    const zh = await runEnrich({ target: 'h3', userInput: '雨夜街道上奔跑的少女', provider: providerReturning(validBriefJson()) })
    const en = await runEnrich({ target: 'h3', userInput: 'a girl running on a rainy street', provider: providerReturning(validBriefJson()) })
    if ('brief' in zh) expect(zh.brief.outputLang).toBe('zh')
    else expect.unreachable()
    if ('brief' in en) expect(en.brief.outputLang).toBe('en')
    else expect.unreachable()
  })
})

/* 规格 5：persona / user 组装 */
describe('runEnrich persona', () => {
  it('anima persona 含「画面」「视觉」；h3 含「镜头」「分镜」与「不新增镜头数」', async () => {
    captured.length = 0
    await runEnrich({ target: 'anima', userInput: 'u1', provider: capturing(providerReturning(validBriefJson())) })
    await runEnrich({ target: 'h3', userInput: 'u2', provider: capturing(providerReturning(validBriefJson())) })
    expect(captured).toHaveLength(2)
    expect(captured[0].persona).toContain('画面')
    expect(captured[0].persona).toContain('视觉')
    expect(captured[1].persona).toContain('镜头')
    expect(captured[1].persona).toContain('分镜')
    expect(captured[1].persona).toContain('不新增镜头数')
  })

  it('user 含原始输入', async () => {
    captured.length = 0
    await runEnrich({ target: 'anima', userInput: '一只戴帽子的猫', provider: capturing(providerReturning(validBriefJson())) })
    expect(captured[0].user).toContain('一只戴帽子的猫')
  })
})

/* 规格 4 + 7：nameAnchors 透传、user 来源保真 */
describe('runEnrich 保真', () => {
  it('nameAnchors 原样透传；空数组合法', async () => {
    const anchors = [{ original: '小明', anchored: 'XiaoMing' }]
    const withA = await runEnrich({ target: 'h3', userInput: 'x', provider: providerReturning(validBriefJson({ nameAnchors: anchors })) })
    const noA = await runEnrich({ target: 'h3', userInput: 'x', provider: providerReturning(validBriefJson()) })
    if ('brief' in withA) expect(withA.brief.nameAnchors).toEqual(anchors)
    else expect.unreachable()
    if ('brief' in noA) expect(noA.brief.nameAnchors).toEqual([])
    else expect.unreachable()
  })

  it("source='user' 的 item 原样保留（引擎不改写）", async () => {
    const userItems = [
      { text: '红色连衣裙', source: 'user' },
      { text: '微笑', source: 'user' },
    ]
    const res: EnrichedBrief | null = await runEnrich({ target: 'h3', userInput: 'x', provider: providerReturning(validBriefJson({ subject: userItems })) }).then((r) => ('brief' in r ? r.brief : null))
    expect(res).not.toBeNull()
    expect(res!.subject).toEqual(userItems)
  })
})
