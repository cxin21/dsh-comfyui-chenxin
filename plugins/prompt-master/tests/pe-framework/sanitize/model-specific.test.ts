import { describe, expect, it } from 'vitest'
import { sanitizeModelSpecific } from '../../../src/pe-framework/sanitize/model-specific.js'

describe('sanitizeModelSpecific', () => {
  it('sanitizeLevel none → unchanged (deepseek)', () => {
    const src = '<think>internal</think>输出文本'
    expect(sanitizeModelSpecific(src, { family: 'deepseek', outputLang: 'zh' })).toBe(src)
  })

  it('strips think tags for generic family', () => {
    expect(sanitizeModelSpecific('<think>reasoning</think>正文内容', { family: 'qwen-vl', outputLang: 'zh' })).toBe('正文内容')
  })

  it('extracts polished tail (last marker wins)', () => {
    const src = '初稿内容\n润色与精简:\n最终精修文本'
    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).toBe('最终精修文本')
  })

  it('strips instruction echo lines', () => {
    const src = '这张图片展示了一个女孩\n实际的描述内容'
    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).not.toContain('这张图片')
    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).toContain('实际的描述内容')
  })

  it('normal output untouched (negative case)', () => {
    const src = '一位穿红裙的少女站在樱花树下，阳光柔和'
    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).toBe(src)
  })
})
