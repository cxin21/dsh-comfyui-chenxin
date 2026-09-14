import { describe, expect, it } from 'vitest'
import { enrichBlueprint } from '../../../src/pe-framework/enrichment/engine.js'
import { textStream, errorStream, stubCtx } from '../../plugin/helpers.js'

const ctx = {
  llm: { async *stream() { for (const c of textStream('{"core":{"concept":"黄昏荒原上的剑客","negative":[{"target":"现代元素"}]}}')) yield c } },
} as any

const v0 = { schema_version: 1, media: 'video', core: { concept: '剑客决斗', negative: [] }, media_layer: { video: { total_duration_seconds: 10, shots: [{ beat: '对峙' }] } } } as any

describe('enrichBlueprint', () => {
  it('returns expanded blueprint + expansions audit trail', async () => {
    const out = await enrichBlueprint(ctx, { provider: 'p', model: 'm' }, v0, { styleId: 'cinematic_real', conformity: 0.6 })
    expect(out.blueprint.core.concept.length).toBeGreaterThan(0)
    expect(Array.isArray(out.expansions)).toBe(true)
  })

  it('injects all six CINEMA_LEXICON categories into the expansion persona (spec §7.1 ROI 补全)', async () => {
    const patch = '{"set":{"core":{"concept":"黄昏荒原上的剑客"}},"expansions":[]}'
    const stb = stubCtx({ stream: textStream(patch) })
    await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    const system = stb.llm.calls[0]?.system ?? ''
    for (const label of ['景别', '焦段', '运镜', '光线', '色彩分级', '构图']) {
      expect(system).toContain(label)
    }
    // t2 深化词也注入候选词库（可被 LLM 引用补全）
    expect(system).toContain('16mm')
    expect(system).toContain('背光')
    expect(system).toContain('胶片颗粒')
  })

  it('appends field_completeness advisory (non-blocking) when key dimension style|scene|emotion missing (spec §7.1)', async () => {
    const patch = '{"set":{"core":{"concept":"黄昏荒原上的剑客"}},"expansions":[]}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    expect(out.expansions).toContain('field_completeness:missing:style|scene|emotion')
    // 不阻断：patch 仍被应用
    expect(out.blueprint.core.concept).toBe('黄昏荒原上的剑客')
  })

  it('does not flag field_completeness when style is present', async () => {
    const patch = '{"set":{"core":{"concept":"黄昏荒原上的剑客"}},"expansions":[]}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, { styleId: 'cinematic_real', conformity: 0.6 })
    expect(out.expansions.some((e) => e.startsWith('field_completeness'))).toBe(false)
  })

  // M2-T2（spec §4.3 备注）：h3 通道 negative_hints 忽略必须可观测——advisory 由 engine 层补
  //（applyStyle 不感知展示通道，与 style_preset_unknown 同一口径）。
  it('emits style_negative_hints_h3_ignored:<id> advisory for video blueprints with styled negative_hints', async () => {
    const patch = '{"set":{"core":{"concept":"黄昏荒原上的剑客"}},"expansions":[]}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, { styleId: 'cinematic_real', conformity: 0.6 })
    expect(out.advisories).toContain('style_negative_hints_h3_ignored:cinematic_real')
    // 仍不注入：core.negative 保持原样（空）
    expect(out.blueprint.core.negative ?? []).toEqual([])
  })

  it('emits no h3-ignored advisory for image blueprints (negative_hints merged as usual)', async () => {
    const imageV0 = { schema_version: 1, media: 'image', core: { concept: '剑客肖像', negative: [] }, media_layer: { image: {} } } as any
    const patch = '{"set":{"core":{"concept":"黄昏荒原上的剑客"}},"expansions":[]}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, imageV0, { styleId: 'cinematic_real', conformity: 1 })
    expect(out.advisories ?? []).not.toContain('style_negative_hints_h3_ignored:cinematic_real')
    expect((out.blueprint.core.negative ?? []).map((n: { target: string }) => n.target)).toContain('over-sharpened')
  })
})

// ─── M5-T3（设计稿 D6/R7）deepMerge 硬化：core.rating 信任边界 ───
// 契约：patch 应用前 strip patch.core.rating（set/裸部分蓝图/additions 全通道、嵌套全形态），
// 覆写企图出 advisory enrich_rating_overwrite_blocked；无覆写企图零行为变化。
describe('enrichBlueprint core.rating trust boundary (M5-T3 R7/D6)', () => {
  const ratedV0 = {
    schema_version: 1,
    media: 'image',
    core: { concept: '剑客肖像', rating: 'explicit', negative: [] },
    media_layer: { image: {} },
  } as any

  it('set 通道嵌套形态：恶意 set.core.rating 被 strip——v1 仍 explicit + advisory；同 patch 良性字段照常应用', async () => {
    const patch = '{"set":{"core":{"rating":"safe","concept":"被覆写概念"}},"expansions":[]}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, ratedV0, {})
    expect(out.blueprint.core.rating).toBe('explicit')
    expect(out.advisories).toContain('enrich_rating_overwrite_blocked')
    // 只 strip rating 键：同 patch 的良性 core 扩写不受影响
    expect(out.blueprint.core.concept).toBe('被覆写概念')
  })

  it('裸部分蓝图形态（无 set 键，整个对象视为 set）：core.rating 覆写被 strip + advisory', async () => {
    const patch = '{"core":{"rating":"sensitive"}}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, ratedV0, {})
    expect(out.blueprint.core.rating).toBe('explicit')
    expect(out.blueprint.core.concept).toBe('剑客肖像')
    expect(out.advisories).toContain('enrich_rating_overwrite_blocked')
  })

  it('additions 通道：additions.core 写入按覆写企图整键阻断 + advisory（rating 载体节点不信任 additions 通道）', async () => {
    const patch = '{"set":{},"additions":{"core":{"rating":"safe"}}}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, ratedV0, {})
    expect(out.blueprint.core.rating).toBe('explicit')
    expect(out.blueprint.core.concept).toBe('剑客肖像')
    expect(out.advisories).toContain('enrich_rating_overwrite_blocked')
  })

  it('set.core 非对象（标量）：整键 strip + advisory（防整体顶掉 core 节点连带 rating）', async () => {
    const patch = '{"set":{"core":"generic"}}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, ratedV0, {})
    expect(out.blueprint.core.rating).toBe('explicit')
    expect(out.blueprint.core.concept).toBe('剑客肖像')
    expect(out.advisories).toContain('enrich_rating_overwrite_blocked')
  })

  it('无覆写企图零行为变化：良性 patch 无 advisory 且照常应用', async () => {
    const patch = '{"set":{"core":{"concept":"良性扩写"}},"expansions":[]}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, ratedV0, {})
    expect(out.blueprint.core.concept).toBe('良性扩写')
    expect(out.blueprint.core.rating).toBe('explicit')
    expect(out.advisories ?? []).not.toContain('enrich_rating_overwrite_blocked')
  })
})

// ─── M5-T3（V8）buildExpansionPersona media 分支 ───
describe('enrichBlueprint persona media branch (M5-T3 V8)', () => {
  const patch = '{"set":{},"expansions":[]}'

  it('video 蓝图：video shot 五维密度规则保持原文', async () => {
    const stb = stubCtx({ stream: textStream(patch) })
    await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    const system = stb.llm.calls[0]?.system ?? ''
    expect(system).toContain('每个 video shot 的 action 必须完整覆盖 5 个维度')
  })

  it('image 蓝图：video shot 五维规则退场，改用 image 画面密度纪律（防诱导编造 video.shots）', async () => {
    const imageV0 = { schema_version: 1, media: 'image', core: { concept: '剑客肖像', negative: [] }, media_layer: { image: {} } } as any
    const stb = stubCtx({ stream: textStream(patch) })
    await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, imageV0, {})
    const system = stb.llm.calls[0]?.system ?? ''
    expect(system).not.toContain('每个 video shot 的 action')
    expect(system).toContain('画面细节密度（硬性，image）')
  })
})

// ─── M5-T3（D7）recommendations 推荐先验通道 ───
describe('enrichBlueprint recommendations (M5-T3 D7)', () => {
  const patch = '{"set":{},"expansions":[]}'

  it('recommendations → user 段【推荐先验】块，文案与 enrich/engine.ts buildUser 同源逐字', async () => {
    const stb = stubCtx({ stream: textStream(patch) })
    await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {
      recommendations: [{ field: 'lighting', cardId: 'rim_backlight', reason: '主体轮廓需要与背景分离' }],
    })
    // stubCtx 捕获的是 dsh-llm GenerateOptions：system 直挂顶层，user 文本在 messages[0].content[] 块内
    const user = JSON.stringify(stb.llm.calls[0]?.messages?.[0]?.content ?? '')
    expect(user).toContain('【推荐先验】艺术指导推荐器建议（你仍做最终设计决策，每类至多 1 张）：')
    expect(user).toContain('- lighting: rim_backlight（主体轮廓需要与背景分离）')
  })

  it('无 recommendations：user 段不出现【推荐先验】块', async () => {
    const stb = stubCtx({ stream: textStream(patch) })
    await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    const user = JSON.stringify(stb.llm.calls[0]?.messages?.[0]?.content ?? '')
    expect(user).not.toContain('【推荐先验】')
  })
})

// ─── M5-T3b：applyAdditions 对象分支合并语义修复 ───
// 缺陷（t4 随行报备、captain 立项修复）：对象分支把 deepMerge 的 void 返回值赋给键 →
// 对象值 additions 写入把键覆成 undefined 摧毁节点（additions.media_layer 等，core 已由 t4 wholeCore strip 护住）。
describe('applyAdditions object-branch merge semantics (M5-T3b)', () => {
  const patchOf = (additions: Record<string, unknown>) => JSON.stringify({ set: {}, additions, expansions: [] })

  it('对象值 additions 不再把键写成 undefined：additions.media_layer 正确合并（新增子节点）', async () => {
    const v0 = {
      schema_version: 1,
      media: 'image',
      core: { concept: '剑客肖像', negative: [] },
      media_layer: { image: { lighting_detail: '黄金时刻' } },
    } as any
    const stb = stubCtx({ stream: textStream(patchOf({ media_layer: { video: { pacing: '渐强' } } })) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    // 修复前：v1.media_layer 被覆成 undefined（质量自检异常则整体回退 v0）——两种路径都不是合并
    expect(out.blueprint.media_layer).toEqual({ image: { lighting_detail: '黄金时刻' }, video: { pacing: '渐强' } })
  })

  it('对象值 additions 落在既有对象节点：既有键内容保留、patch 键并入', async () => {
    const v0 = {
      schema_version: 1,
      media: 'image',
      core: { concept: '剑客肖像', negative: [] },
      media_layer: { image: { lighting_detail: '黄金时刻', focal_length: '85mm' } },
    } as any
    const stb = stubCtx({ stream: textStream(patchOf({ media_layer: { image: { depth_of_field: '浅景深' } } })) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    expect(out.blueprint.media_layer.image).toEqual({ lighting_detail: '黄金时刻', focal_length: '85mm', depth_of_field: '浅景深' })
  })

  it('数组/标量通道零行为变化：数组追加、标量覆盖', async () => {
    const v0 = { schema_version: 1, media: 'video', core: { concept: '剑客决斗', negative: [] }, media_layer: { video: { total_duration_seconds: 10, shots: [{ beat: '对峙' }] } }, extraTags: ['a'], extraScalar: 1 } as any
    const stb = stubCtx({ stream: textStream(patchOf({ extraTags: ['b'], extraScalar: 2 })) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    expect((out.blueprint as any).extraTags).toEqual(['a', 'b'])
    expect((out.blueprint as any).extraScalar).toBe(2)
  })

  it('组合专测：t4 wholeCore strip 先行 + 对象合并修复不冲突——恶意 core.rating 与良性 media_layer 对象 additions 同 patch', async () => {
    const ratedV0 = {
      schema_version: 1,
      media: 'image',
      core: { concept: '剑客肖像', rating: 'explicit', negative: [] },
      media_layer: { image: { lighting_detail: '伦勃朗光' } },
    } as any
    const patch = JSON.stringify({
      set: { core: { rating: 'safe' } },
      additions: { core: { rating: 'sensitive' }, media_layer: { image: { depth_of_field: '浅景深' } } },
      expansions: [],
    })
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, ratedV0, {})
    // strip 先行：set.core.rating 删键 + additions.core 整键阻断 → rating 保全 + advisory
    expect(out.blueprint.core.rating).toBe('explicit')
    expect(out.advisories).toContain('enrich_rating_overwrite_blocked')
    // 对象合并修复：良性 media_layer 对象 additions 正确合并，既有内容保留
    expect(out.blueprint.media_layer.image).toEqual({ lighting_detail: '伦勃朗光', depth_of_field: '浅景深' })
  })
})

/* ═══ M5-DIAG：enrich 直连通道真实会话 100% 失败诊断（清单④重放实锤）═══
 * 现象：真实会话 enrichBlueprint 6/6 fallback_to_v0（~10-11s/次，两代 dist、多案例一致），
 * intent 子代理通道同期正常；mock 全绿（stub route 不暴露）。诊断结论（docs/enrich-channel-diagnosis.md）：
 * ①主因 maxTokens=1024 截断——max-tokens finish 是正常终止（非 error），截断文本 JSON.parse 失败
 *   → 三处 catch {} 吞掉真实原因 → generic fallback；~10.4s ≈ 1024 tok @ ~100 tok/s 量化吻合。
 * ②可观测性缺陷：失败原因（auth/timeout/truncation/parse）四类不可区分——本 describe 把 reason
 *   进 expansions（legacy token 保持首位不变 = 既有断言面零漂移）。
 * ③c04 artist 槽丢失（随迁 analyzer.ts，见该文件）：蓝图 persona/schema 零 artist_hints 引导。
 */
describe('M5-DIAG: enrich direct-channel failure observability', () => {
  const LEGACY = 'enrichment_failed:fallback_to_v0'
  const okPatch = '{"set":{"core":{"concept":"黄昏荒原上的剑客"}},"expansions":[]}'

  it('maxTokens 缺省不传（M5-DIAG2 用户裁定：不设上限——reasoning 模型思考预算不可预支，宿主 defaultMaxTokens 语义）', async () => {
    const stb = stubCtx({ stream: textStream(okPatch) })
    await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    expect(stb.llm.calls[0]?.maxTokens).toBeUndefined()
  })

  it('error finish → legacy token 首位不变 + reason entry 携带 failure code/message（不再静默吞掉）', async () => {
    const stb = stubCtx({ stream: errorStream('provider unauthorized', 'AUTH') })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    expect(out.blueprint).toEqual(v0)
    expect(out.expansions[0]).toBe(LEGACY)
    const reason = out.expansions.find((e) => e.startsWith('enrichment_failed_reason:llm:'))
    expect(reason).toBeDefined()
    expect(reason).toContain('AUTH')
    expect(reason).toContain('provider unauthorized')
  })

  it('max-tokens finish（截断）→ parse reason entry 携带 finish kind + 截断文本 head', async () => {
    const truncated = '{"set":{"core":{"concept":"黄昏荒原上的剑客"},' // 刻意截断
    const stream = [...textStream(truncated).slice(0, -1), { type: 'finish', reason: { kind: 'max-tokens' } } as any]
    const stb = stubCtx({ stream })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    expect(out.expansions[0]).toBe(LEGACY)
    expect(out.expansions.some((e) => e.startsWith('enrichment_failed_reason:parse:max-tokens:'))).toBe(true)
  })

  it('非对象 JSON → parse reason entry 标注 non-object + finish kind', async () => {
    const stb = stubCtx({ stream: textStream('"just a string"') })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    expect(out.expansions[0]).toBe(LEGACY)
    expect(out.expansions.some((e) => e.startsWith('enrichment_failed_reason:parse:stop:non-object:string'))).toBe(true)
  })

  it('apply 阶段 throw → apply reason entry 携带错误消息（structuredClone 不可克隆数据触发）', async () => {
    const evilV0 = { ...v0, uncloneable: () => 'fn' } as any // 函数属性 → structuredClone DataCloneError
    const stb = stubCtx({ stream: textStream(okPatch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, evilV0, {})
    expect(out.blueprint).toEqual(evilV0)
    expect(out.expansions[0]).toBe(LEGACY)
    const reason = out.expansions.find((e) => e.startsWith('enrichment_failed_reason:apply:'))
    expect(reason).toBeDefined()
  })

  it('opts.signal 透传：调用方 signal 到达 GenerateOptions（取消可传播；缺省行为不变）', async () => {
    const stb = stubCtx({ stream: textStream(okPatch) })
    const ac = new AbortController()
    await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, { signal: ac.signal })
    expect(stb.llm.calls[0]?.signal).toBe(ac.signal)
  })
})

/* ═══ M5-HOTFIX2：enrichBlueprint 输出纪律 + maxTokens 量化回调 ═══
 * 现象：t16 修复后真实会话 c04 探针（d0a9fe1 dist，gen_1789343516953_l2vs0lav）
 * blueprint_enrich 38.7s 吃满 4096 tok 仍 max-tokens 截断（reason=parse:max-tokens）——
 * 1024→4096 只移天花板：persona 只有形状契约、零收敛纪律，且裸部分蓝图兼容规则（整对象视为 set）
 * 使「完整回显 v0 + 扩写」语义合法，user 段又把完整 JSON.stringify(v0) 递到眼前当模板。
 * 修复 = persona 输出纪律（最小 diff/禁散文/字段白名单/总长上限目标 + 紧凑 few-shot 样板）
 * + maxTokens 4096→1400 量化回调；v0 fallback + reason 透传（M5-DIAG 机制）保持兜底。
 * M5-DIAG2 续：1400 仍打满且文本头恒空（reasoning 预算吞噬指纹）→ 用户裁定不设上限，
 * maxTokens 缺省不传（宿主 defaultMaxTokens 语义）；纪律与兜底保留。
 */
describe('M5-HOTFIX2: expansion output discipline', () => {
  const personaOf = async (media: 'image' | 'video' = 'image'): Promise<string> => {
    const v0bp = {
      schema_version: 1,
      media,
      core: { concept: '剑客决斗', negative: [] },
      media_layer: media === 'image' ? { image: { count_gender: ['1girl'] } } : { video: { total_duration_seconds: 10, shots: [{ beat: '对峙' }] } },
    } as any
    const stb = stubCtx({ stream: textStream('{"set":{},"expansions":[]}') })
    await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0bp, {})
    return stb.llm.calls[0]?.system ?? ''
  }

  it('persona 带最小 diff 输出纪律：禁回显未变更字段 + 禁散文 + 字段白名单 + 总长上限目标', async () => {
    const system = await personaOf('image')
    expect(system).toContain('最小 diff')
    expect(system).toContain('禁止回显')
    expect(system).toContain('增量 patch')
    expect(system).toContain('禁散文')
    expect(system).toContain('白名单')
    expect(system).toContain('1200')
    // 纪律在输出契约段内（形状契约之后），不是孤立的散句
    expect(system.indexOf('输出契约（硬性）')).toBeLessThan(system.indexOf('最小 diff'))
  })

  it('persona 带语言纪律（M5-DIAG2：真实会话 c04 CJK 回流 → loop_exhausted）+ few-shot 样板零 CJK', async () => {
    const system = await personaOf('image')
    expect(system).toContain('语言纪律')
    expect(system).toContain('英文 Anima tag 词汇')
    const m = system.match(/紧凑样板[^\n{]*(\{.*\})/)
    expect(m).not.toBeNull()
    expect(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(m![1])).toBe(false)
  })

  it('persona 带紧凑 few-shot 样板：可解析 JSON、含 set/expansions、体积证明其小（<300 字符）', async () => {
    const system = await personaOf('image')
    const m = system.match(/紧凑样板[^\n{]*(\{.*\})/)
    expect(m).not.toBeNull()
    const sample = JSON.parse(m![1]) as { set?: unknown; expansions?: unknown }
    expect(typeof sample.set).toBe('object')
    expect(Array.isArray(sample.expansions)).toBe(true)
    expect(m![1].length).toBeLessThan(300)
  })

  it('纪律对 video persona 同样在场（media 分支不丢失纪律块）', async () => {
    const system = await personaOf('video')
    expect(system).toContain('最小 diff')
    expect(system).toContain('1200')
  })

  it('mock 重放真实失败形状（截断 → 优雅 fallback + reason）保持绿（纪律不加严解析面）', async () => {
    const truncated = '{"set":{"core":{"concept":"黄昏荒原上的剑客"},' // 刻意截断
    const stream = [...textStream(truncated).slice(0, -1), { type: 'finish', reason: { kind: 'max-tokens' } } as any]
    const stb = stubCtx({ stream })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    expect(out.blueprint).toEqual(v0)
    expect(out.expansions[0]).toBe('enrichment_failed:fallback_to_v0')
    expect(out.expansions.some((e) => e.startsWith('enrichment_failed_reason:parse:max-tokens:'))).toBe(true)
  })
})
