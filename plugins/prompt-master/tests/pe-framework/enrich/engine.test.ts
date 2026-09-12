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

/* 规格 4（2026-09-12 P1）：调用方显式指定艺术指导卡（prompt_author.art_direction → runEnrich.artDirection） */
describe('runEnrich artDirection 指定卡注入', () => {
  it('anima + artDirection → user 段含「调用方已指定」硬要求块（id/name/tags）；h3 目标不注入', async () => {
    captured.length = 0
    const fenced = '```json\n' + validBriefJson() + '\n```'
    const res = await runEnrich({ target: 'anima', userInput: '古风美女舞剑', provider: capturing(providerReturning(fenced)), artDirection: { motion: 'weapon_trail', perspective: 'three_quarter_view' } })
    expect('brief' in res).toBe(true)
    const user = captured[0].user
    expect(user).toContain('调用方已指定的艺术指导卡片')
    expect(user).toContain('- motion=weapon_trail（武器轨迹）: sword trail, gleaming blade, weapon arc')
    expect(user).toContain('- perspective=three_quarter_view（三分之二视角）')
    captured.length = 0
    await runEnrich({ target: 'h3', userInput: 'x', provider: capturing(providerReturning(fenced)), artDirection: { motion: 'weapon_trail' } })
    expect(captured[0].user).not.toContain('调用方已指定的艺术指导卡片')
  })

  it('未指定 artDirection → user 段不含指定卡块（仅卡片菜单）', async () => {
    captured.length = 0
    await runEnrich({ target: 'anima', userInput: 'x', provider: capturing(providerReturning(validBriefJson())) })
    expect(captured[0].user).not.toContain('调用方已指定的艺术指导卡片')
    expect(captured[0].user).toContain('艺术指导卡片菜单')
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

  it('h3 未指定：日本語输入（纯假名，detectLanguage ja 分支）→ ja（T5 carry④）', async () => {
    const ja = await runEnrich({ target: 'h3', userInput: 'さくらがあめのよるをはしる', provider: providerReturning(validBriefJson()) })
    if ('brief' in ja) expect(ja.brief.outputLang).toBe('ja')
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

  it('Round7 T3：两方言 persona 含 source=user 语义级保留 + 语言改写指令（不再字面「原样保留」），user 段同步', async () => {
    captured.length = 0
    await runEnrich({ target: 'anima', userInput: 'u1', provider: capturing(providerReturning(validBriefJson())) })
    await runEnrich({ target: 'h3', userInput: 'u2', provider: capturing(providerReturning(validBriefJson())) })
    expect(captured).toHaveLength(2)
    for (const req of captured) {
      // 语义级保留规则在位：语义指代不变 + 不得增删要素 + 语言必须改写为 outputLang
      expect(req.persona).toContain('语义与指代必须保留')
      expect(req.persona).toContain('不得增删要素')
      expect(req.persona).toContain('语言必须改写为 outputLang')
      // 不冲突硬约束保留（只放宽语言维度）
      expect(req.persona).toContain('不得与用户显式指定的内容冲突')
      // 字面级「原样保留」退出 persona（改写为语义级）
      expect(req.persona).not.toContain('原样保留')
      // user 段同步：不再出现与 persona 矛盾的「不改写」字面指令
      expect(req.user).not.toContain('不改写')
    }
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

/* Round8 T3Q：艺术指导卡片内置——persona 课程 / user 卡片清单 / artDirection 校验降级 */
describe('runEnrich 艺术指导（Round8 T3Q）', () => {
  const ART = { perspective: 'low_angle', composition: 'diagonal_dynamics', lighting: 'rim_backlight', color: 'warm_cool_contrast', motion: 'flowing_dress' }

  it('anima persona 含「艺术指导」「设计决策」「五件套」课程关键词；h3 persona 不含（h3 不做美学升级）', async () => {
    captured.length = 0
    await runEnrich({ target: 'anima', userInput: 'u1', provider: capturing(providerReturning(validBriefJson())) })
    await runEnrich({ target: 'h3', userInput: 'u2', provider: capturing(providerReturning(validBriefJson())) })
    expect(captured[0].persona).toContain('艺术指导')
    expect(captured[0].persona).toContain('设计决策')
    expect(captured[0].persona).toContain('五件套')
    expect(captured[1].persona).not.toContain('艺术指导')
  })

  it('anima user 段附五类卡片清单（id+name+tags）与 schema 的 artDirection 字段；h3 user/schema 无卡片清单', async () => {
    captured.length = 0
    await runEnrich({ target: 'anima', userInput: 'u1', provider: capturing(providerReturning(validBriefJson())) })
    await runEnrich({ target: 'h3', userInput: 'u2', provider: capturing(providerReturning(validBriefJson())) })
    // anima：菜单 + 代表性卡片 id/tag + schema artDirection 形状
    expect(captured[0].user).toContain('艺术指导卡片菜单')
    expect(captured[0].user).toContain('low_angle 低角度仰拍')
    expect(captured[0].user).toContain('from below')
    expect(captured[0].user).toContain('flowing_dress 衣袂飘飞')
    expect(captured[0].schema).toContain('artDirection')
    // h3：不加卡片清单（范围钉死：T3Q 只做 anima 美学升级）
    expect(captured[1].user).not.toContain('艺术指导卡片菜单')
    expect(captured[1].schema).not.toContain('artDirection')
  })

  it('mock brief 含合法 artDirection → brief.artDirection 原样透传', async () => {
    const res = await runEnrich({ target: 'anima', userInput: '持剑舞者的少女', provider: providerReturning(validBriefJson({ artDirection: ART })) })
    if ('brief' in res) expect(res.brief.artDirection).toEqual(ART)
    else expect.unreachable()
  })

  it('未知卡片 id → skipped invalid_art_direction（reason 不被归并为 enrich_invalid_schema）', async () => {
    const res = await runEnrich({ target: 'anima', userInput: 'x', provider: providerReturning(validBriefJson({ artDirection: { lighting: 'no_such_card' } })) })
    expect(res).toEqual({ skipped: true, reason: 'invalid_art_direction' })
  })
})
