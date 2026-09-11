/**
 * Round7 T3（brief B）：detectLanguage 假名优先——文本含任何假名
 * （ひらがな \u3040-\u309f 或 カタカナ \u30a0-\u30ff）→ '日本語'（优先于汉字判定）；
 * 纯汉字 → '中文'（既有行为）；无 CJK → 'English'（既有行为）。
 * 背景：此前汉字判定在前，混合日文「雨の夜の江南园林」被误判为中文 → enrich outputLang 误锁 zh。
 */
import { describe, expect, it } from 'vitest'
import { detectLanguage } from '../../../src/pe-framework/dialect/h3.js'

describe('detectLanguage 假名优先（Round7 T3）', () => {
  it('混合日文（汉字+假名：雨の夜の江南园林）→ 日本語（假名优先于汉字判定）', () => {
    expect(detectLanguage('雨の夜の江南园林')).toBe('日本語')
  })

  it('纯平假名 → 日本語', () => {
    expect(detectLanguage('さくらがあめのよるをはしる')).toBe('日本語')
  })

  it('纯片假名 → 日本語', () => {
    expect(detectLanguage('カタカナのみのテキスト')).toBe('日本語')
  })

  it('纯汉字 → 中文（既有行为回归）', () => {
    expect(detectLanguage('雨夜街道上奔跑的少女')).toBe('中文')
  })

  it('英文 → English（既有行为回归）', () => {
    expect(detectLanguage('a girl running on a rainy street')).toBe('English')
  })
})
