// minimax assemble parity — upstream 3.1.0 对照断言（X1-X8）
import { describe, expect, it } from 'vitest'
import {
  resolveMinimaxScenarioExpand,
  isMinimaxScenarioProfile,
  enumerateTaggedMedia,
  classifyMediaPath,
  buildSystem,
} from '../../src/resolver/minimax/assemble.js'
import {
  isH3FullReferenceProfile,
  isH3FullReferencePeId,
  resolveH3FullReferenceExpand,
  H3_FULL_REFERENCE_PROFILE_ID,
  H3_FULL_REFERENCE_USER_PROMPT_TEMPLATE,
} from '../../src/resolver/minimax/h3-full-reference.js'
import { H3_REFERENCE_ZH, H3_REFERENCE_EN } from '../../src/resolver/minimax/templates/index.js'
import { getScenarioById } from '../../src/resolver/minimax/catalog.js'

const expand = (scenarioId: string, params: any = {}, profile: any = {}) =>
  resolveMinimaxScenarioExpand(
    { id: scenarioId, minimaxScenarioId: scenarioId, kind: 'expand', ...profile },
    params,
  )!

// === X5：resolveMinimaxScenarioExpand ===
describe('X5 resolveMinimaxScenarioExpand', () => {
  it('maxTokens >= 4096 (mediaExpandMin floor, was 768)', () => {
    const r = expand('full_reference', {})
    expect(r.maxTokens).toBeGreaterThanOrEqual(4096)
  })

  it('tokenLimits.mediaExpandMin override respected', () => {
    const r = expand('full_reference', { tokenLimits: { expandMax: 8192, mediaExpandMin: 5000 } })
    expect(r.maxTokens).toBeGreaterThanOrEqual(5000)
  })

  it('userExtraPrompt appended to system', () => {
    const r = expand('full_reference', { userExtraPrompt: '加一段彩蛋镜头' })
    expect(r.system).toContain('【User additional requirements】加一段彩蛋镜头')
  })

  it('accepts params.minimaxForm direct form (upstream) AND nested form_fields (tool surface)', () => {
    const direct = expand('full_reference', { minimaxForm: { aspect_ratio: '9:16' } })
    const nested = expand('full_reference', { minimaxForm: { form_fields: { aspect_ratio: '9:16' }, output_lang: 'zh' } })
    expect(direct.user).toContain('9:16')
    expect(nested.user).toContain('9:16')
  })

  it('scenario resolution falls back to params.peId / params.ruleId', () => {
    const r1 = resolveMinimaxScenarioExpand(null as any, { peId: 'pe_expand_minimax_coop_game' })
    const r2 = resolveMinimaxScenarioExpand({ kind: 'expand' } as any, { ruleId: 'pe_expand_minimax_coop_game' })
    expect(r1?.minimaxScenarioId).toBe('coop_game')
    expect(r2?.minimaxScenarioId).toBe('coop_game')
  })

  it('returns minimaxScenarioId + mediaExpandLayout + upstream ruleId', () => {
    const r = expand('full_reference', {})
    expect(r.minimaxScenarioId).toBe('full_reference')
    expect(r.mediaExpandLayout).toBe(true)
    expect(r.ruleId).toBe('pe_expand_h3_full_reference')
  })

  it('isMinimaxScenarioProfile matches upstream semantics', () => {
    expect(isMinimaxScenarioProfile({ kind: 'expand', minimaxScenarioId: 'full_reference' })).toBe(true)
    expect(isMinimaxScenarioProfile({ kind: 'expand', outputFormat: 'minimax' })).toBe(true)
    expect(isMinimaxScenarioProfile({ kind: 'expand', id: 'pe_expand_minimax_coop_game' })).toBe(true)
    expect(isMinimaxScenarioProfile({ kind: 'reverse', minimaxScenarioId: 'x' })).toBe(false)
  })
})

// === X1：buildUser 五块结构 ===
describe('X1 buildUser five-block structure', () => {
  const r = expand('full_reference', { shortText: '银色手机悬浮旋转', mediaPaths: ['refs/phone.png'] })

  it('contains 【场景】【输出语言】 blocks', () => {
    expect(r.user).toContain('【场景】Minimax六段式通用提示词')
    expect(r.user).toContain('【输出语言】中文 — 这是强制要求')
  })

  it('contains 【表单参数】 block with form lines', () => {
    expect(r.user).toContain('【表单参数】')
    expect(r.user).toMatch(/- 画幅比例: .+16:9/)
  })

  it('contains 【创作需求 / User request】 block with shortText', () => {
    expect(r.user).toContain('【创作需求 / User request】')
    expect(r.user).toContain('银色手机悬浮旋转')
  })

  it('contains 【参考素材】 list + <Picture 1> anchoring block + 【任务】 tail', () => {
    expect(r.user).toContain('【参考素材 / Reference media】')
    expect(r.user).toContain('<Picture 1> phone.png')
    expect(r.user).toContain('【强制·素材标签】主体定义必须以如下标签逐条起笔')
    expect(r.user).toContain('<Picture 1> …')
    expect(r.user).toContain('【任务】根据场景硬约束 + 表单参数 + 创作需求 + 参考素材')
  })

  it('no-media path forbids inventing tags', () => {
    const r = expand('full_reference', {})
    expect(r.user).toContain('本次无参考素材附件：输出中不得出现 <Picture N>/<Subject N>')
  })
})

// === X2：buildMediaTagLock 文案 + 扩展名分类 ===
describe('X2 media tag lock + extension classification', () => {
  it('zh lock contains forbidden-variant sentence and reuse sentence', () => {
    const r = expand('full_reference', { mediaPaths: ['a.png'] })
    expect(r.system).toContain('禁止写成 Picture 1 / picture1 / 图1 等变体')
    expect(r.system).toContain('在「保留分析」「详细描述」中引用同一套 <Picture N>/<Subject N>')
  })

  it('classifyMediaPath maps extensions to <Video N>/<Audio N>/<Picture N>', () => {
    expect(classifyMediaPath('a.MP4')).toBe('video')
    expect(classifyMediaPath('b.wav')).toBe('audio')
    expect(classifyMediaPath('c.jpg')).toBe('image')
    const items = enumerateTaggedMedia(['c.jpg', 'a.MP4', 'b.wav'])
    expect(items.map((i) => i.tag)).toEqual(['<Picture 1>', '<Video 1>', '<Audio 1>'])
  })

  it('system lock enumerates mixed-media tags', () => {
    const r = expand('full_reference', { mediaPaths: ['c.jpg', 'a.MP4'] })
    expect(r.system).toContain('<Picture 1>、<Video 1>')
  })
})

// === X3：输出格式四分支 ===
describe('X3 output format four branches', () => {
  it('timeline_template branch emits timeline prompt rules (coop_game)', () => {
    const r = expand('coop_game', {})
    expect(r.system).toContain('时间轴/事件框架视频提示词')
    expect(r.system).toContain('不要 Markdown 代码围栏，不要闲聊')
  })

  it('plain branch appends prose anchoring constraint when mediaPaths present (handdrawn)', () => {
    const withMedia = expand('handdrawn_live', { mediaPaths: ['c.jpg'] })
    expect(withMedia.system).toContain('自然语言段落')
    expect(withMedia.system).toContain('禁止只列标签名、禁止 XML/空壳结构而无正文')
  })

  it('full_reference branch contains 4–12 字 copy rule and [reference generation] keep-English line', () => {
    const r = expand('full_reference', {})
    expect(r.system).toContain('画面广告文案：约 4–12 字、单行、Apple 风')
    expect(r.system).toContain('任务前缀 [reference generation] 保持英文')
  })

  it('director_segments branch emits six-group rules (continuous_story)', () => {
    const r = expand('continuous_story', { minimaxForm: { segment_count: '3' } })
    expect(r.system).toContain('===== 提示词组 k =====')
    expect(r.system).toContain('无硬切。紧接上一段。')
    expect(r.system).toContain('不要乱说话')
    expect(r.system).toContain('除最后一组外段末不要淡出')
    expect(r.user).toContain('【智能分段】不要等待「第 N 段在干什么」')
  })
})

// === X4：hardConstraints zh 改写 ===
describe('X4 hardConstraints zh rewrite', () => {
  const scenario: any = {
    ...getScenarioById('full_reference')!,
    hardConstraints: ['In-frame copy: English, 3-5 words only.', 'Keep tags stable.'],
  }

  it('rewrites "In-frame copy: English" entry in zh output', () => {
    const sys = buildSystem(scenario, {}, 'zh', [])
    expect(sys).toContain('In-frame copy: concise Simplified Chinese (约 4–12 字), single line only')
    expect(sys).not.toContain('In-frame copy: English, 3-5 words only.')
    expect(sys).toContain('- Keep tags stable.')
  })

  it('keeps original entry in en output', () => {
    const sys = buildSystem(scenario, {}, 'en', [])
    expect(sys).toContain('- In-frame copy: English, 3-5 words only.')
  })
})

// === X7：h3FullReference 独立入口 ===
describe('X7 h3FullReference independent entry', () => {
  it('profile/peId judgments match upstream', () => {
    expect(isH3FullReferenceProfile({ kind: 'expand', id: H3_FULL_REFERENCE_PROFILE_ID })).toBe(true)
    expect(isH3FullReferenceProfile({ kind: 'expand', builtinKey: 'h3_full_reference' })).toBe(true)
    expect(isH3FullReferenceProfile({ kind: 'expand', id: 'other' })).toBe(false)
    expect(isH3FullReferencePeId('h3_full_reference')).toBe(true)
    expect(isH3FullReferencePeId('pe_expand_h3_full_reference')).toBe(true)
    expect(isH3FullReferencePeId('nope')).toBe(false)
  })

  it('user = fixed Rewrite template with {{user_input}} filled; system = guide + language appendix', () => {
    const r = resolveH3FullReferenceExpand(null as any, { shortText: '雨夜霓虹街道' })!
    expect(r.user).toContain(H3_FULL_REFERENCE_USER_PROMPT_TEMPLATE.split('{{user_input}}')[0])
    expect(r.user).toContain('雨夜霓虹街道')
    expect(r.system).toContain('【输出语言】本模板为中文版')
    expect(r.system).toContain('【输出契约】绝对纯净输出')
    expect(r.maxTokens).toBeGreaterThanOrEqual(4096)
    expect(r.mediaExpandLayout).toBe(true)
    expect(r.ruleId).toBe(H3_FULL_REFERENCE_PROFILE_ID)
  })

  it('en edition appends English appendices; media list lands in user', () => {
    const r = resolveH3FullReferenceExpand(null as any, { outputLang: 'en', mediaPaths: ['c.jpg'] })!
    expect(r.system).toContain('【Output language】English edition')
    expect(r.user).toContain('【参考素材 / Reference media】')
    expect(r.user).toContain('<Picture 1> c.jpg')
  })

  it('mapping: scenario path keeps priority; independent entry used as fallback in resolver', async () => {
    // upstream electron resolver: isMinimaxScenarioProfile 分支在 resolveExpandPrompts 最前，
    // pe_expand_h3_full_reference 同时在 minimax catalog → 场景路径优先（buildSystem + guide 全文）。
    // 独立入口在场景未命中时兜底。此处断言场景路径对该 peId 可命中（优先）且独立入口可兜底。
    const viaScenario = expand('full_reference', {})
    expect(viaScenario.system).toContain('场景：Minimax六段式通用提示词')
    const viaIndependent = resolveH3FullReferenceExpand(
      { kind: 'expand', id: H3_FULL_REFERENCE_PROFILE_ID },
      { shortText: 'x' },
    )
    expect(viaIndependent).not.toBeNull()
  })
})

// === X8：官方模板细则 ===
describe('X8 official rewrite template rules', () => {
  it('zh template carries strict-vs-expand / image-order / dialogue language-code rules', () => {
    expect(H3_REFERENCE_ZH).toContain('严格改写 vs 扩写')
    expect(H3_REFERENCE_ZH).toContain('图片顺序一致')
    expect(H3_REFERENCE_ZH).toContain('<d>[Chinese]')
    expect(H3_REFERENCE_ZH).toContain('主体定义:')
  })

  it('en template carries the six-section contract rules', () => {
    expect(H3_REFERENCE_EN).toContain('subject_definitions')
    expect(H3_REFERENCE_EN).toContain('non_diegetic_music')
  })
})
