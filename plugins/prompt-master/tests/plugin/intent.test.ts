import { describe, expect, it } from 'vitest'
import { assembleExpandIntent, assembleReverseIntent } from '../../src/pe-framework/intent/index.js'
import { resolveExpand, resolveReverse } from '../../src/resolver/index.js'
import { findProfileById } from '../../src/resolver/profiles/index.js'

describe('intent thin wrappers (equivalence)', () => {
  it('assembleExpandIntent === resolveExpand (same profile+params)', () => {
    const profile = findProfileById('pe_expand_natural')!
    const params = { shortText: '一只猫', outputLang: 'zh', expandLen: 'medium' }
    expect(assembleExpandIntent(profile, params)).toEqual(resolveExpand(profile, { ...params } as any))
  })

  it('assembleReverseIntent === resolveReverse (media_target default image)', () => {
    const profile = findProfileById('pe_reverse_descriptive')!
    const p = { captionLang: 'zh', len: 'medium' }
    expect(assembleReverseIntent(profile, p)).toEqual(resolveReverse(profile, { caption_lang: 'zh', len: 'medium', media_target: 'image' } as any))
  })

  it('media_target anima/h3 accepted without changing image-path equivalence', () => {
    const profile = findProfileById('pe_reverse_descriptive')!
    const a = assembleReverseIntent(profile, { mediaTarget: 'anima' })
    const i = assembleReverseIntent(profile, { mediaTarget: 'image' })
    expect(a.captionType).toBe(i.captionType)   // 编译阶段差异，resolver 输出结构一致
    expect(a.system).toBeTruthy()
  })
})