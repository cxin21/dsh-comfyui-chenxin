import { describe, expect, it } from 'vitest'
import { resolveJoyExtraOptions, buildJoyExtraSystemBlock, buildJoyExtraUserTail, filterJoyExtraClauses } from '../../../src/pe-framework/sanitize/joy-extra.js'

describe('resolveJoyExtraOptions', () => {
  it('array mode: explicit ids win', () => {
    expect(resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] }).options).toContain('no_glasses_headwear')
  })
  it('text sniff mode: standard sentence in extra_prompt detected', () => {
    const r = resolveJoyExtraOptions({ extraPrompt: 'Do not mention glasses, goggles, hats or any headwear.' })
    expect(r.options).toContain('no_glasses_headwear')
  })
  it('character_name captured from param', () => {
    const r = resolveJoyExtraOptions({ characterName: '小明' })
    expect(r.characterName).toBe('小明')
  })
  it('character_name sniffed from refer-to pattern', () => {
    const r = resolveJoyExtraOptions({ extraPrompt: 'refer to them as star_girl' })
    expect(r.characterName).toBe('star_girl')
  })
  it('unknown array ids filtered out', () => {
    expect(resolveJoyExtraOptions({ joyExtraOptions: ['bogus', 'no_artistic_style'] }).options).toEqual(['no_artistic_style'])
  })
})

describe('filterJoyExtraClauses', () => {
  it('removes glasses/headwear clauses', () => {
    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
    const out = filterJoyExtraClauses('一位少女，戴着红色贝雷帽，穿白色连衣裙，站在树下', r)
    expect(out).not.toContain('贝雷帽')
    expect(out).toContain('白色连衣裙')
  })
  it('keeps original separator style', () => {
    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
    const out = filterJoyExtraClauses('1girl, red beret, white dress', r)
    expect(out).not.toContain('beret')
    expect(out).toContain('white dress')
    expect(out).toContain(', ')   // 英文逗号分隔保留
  })
  it('all clauses filtered → return original (anti-extinction)', () => {
    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
    const src = '戴着墨镜和帽子'
    expect(filterJoyExtraClauses(src, r)).toBe(src)
  })
  it('no options → text unchanged', () => {
    expect(filterJoyExtraClauses('戴着墨镜的少女', resolveJoyExtraOptions({}))).toBe('戴着墨镜的少女')
  })
})

describe('buildJoyExtraSystemBlock', () => {
  it('contains priority declaration + conflict override for glasses option', () => {
    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
    const block = buildJoyExtraSystemBlock(r, 'zh')
    expect(block).toContain('硬约束')
    expect(block).toContain('眼镜')
  })
  it('user tail lists per-option pledge', () => {
    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_artistic_style'], characterName: '小明' })
    const tail = buildJoyExtraUserTail(r, 'zh')
    expect(tail).toContain('小明')
    expect(tail).toContain('风格')
  })
})
