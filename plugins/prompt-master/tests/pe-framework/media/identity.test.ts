// tests/pe-framework/media/identity.test.ts
import { describe, expect, it } from 'vitest'
import { enumerateTaggedMedia, buildIdentityDeclarations } from '../../../src/pe-framework/media/identity.js'

describe('enumerateTaggedMedia', () => {
  it('tags are consecutive 1-based <Picture N>', () => {
    expect(enumerateTaggedMedia(3)).toEqual([
      { n: 1, tag: '<Picture 1>' }, { n: 2, tag: '<Picture 2>' }, { n: 3, tag: '<Picture 3>' },
    ])
  })
  it('zero media → empty', () => {
    expect(enumerateTaggedMedia(0)).toEqual([])
  })
})

describe('buildIdentityDeclarations', () => {
  it('multi-image → declaration block with do-not-swap header', () => {
    const decl = buildIdentityDeclarations(enumerateTaggedMedia(2), 'zh')
    expect(decl).toContain('<Picture 1>')
    expect(decl).toContain('<Picture 2>')
    expect(decl).toContain('不要混淆')   // do-not-swap 语义
  })
  it('single image → empty string (no injection)', () => {
    expect(buildIdentityDeclarations(enumerateTaggedMedia(1), 'zh')).toBe('')
  })
})
