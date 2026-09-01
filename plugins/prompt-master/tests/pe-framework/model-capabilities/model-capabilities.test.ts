import { describe, expect, it } from 'vitest'
import { inferModelFamily, getCapabilities, applyCapabilities, FAMILY_CAPABILITIES } from '../../../src/pe-framework/model-capabilities/index.js'

describe('inferModelFamily', () => {
  const cases: Array<[string, string, string]> = [
    ['deepseek-official', 'deepseek-v4-flash', 'deepseek'],
    ['deepseek-official', 'deepseek-r2', 'deepseek'],
    ['zhipu', 'glm-5.3-flash', 'glm'],
    ['zhipu', 'glm-4.5v', 'glm'],
    ['ollama', 'qwen3-vl-8b-instruct', 'qwen-vl'],
    ['ollama', 'Qwen3-VL-8B', 'qwen-vl'],
    ['openai', 'qwen3.5-27b', 'qwen-text'],
    ['ollama', 'gemma4-12b', 'gemma'],
    ['openai', 'gpt-5', 'openai'],
    ['unknown-provider', 'mystery-model-9000', 'generic'],
    ['ollama', 'llama3', 'generic'],
  ]
  for (const [provider, model, expected] of cases) {
    it(`infer(${provider}, ${model}) → ${expected}`, () => {
      expect(inferModelFamily(provider, model)).toBe(expected)
    })
  }
})

describe('capabilities table', () => {
  it('every family has a capabilities entry', () => {
    for (const family of Object.keys(FAMILY_CAPABILITIES)) {
      expect(FAMILY_CAPABILITIES[family as keyof typeof FAMILY_CAPABILITIES]).toBeTruthy()
    }
  })

  it('qwen-vl is prone to truncation and needs generic sanitize', () => {
    const caps = getCapabilities('qwen-vl')
    expect(caps.proneToTruncation).toBe(true)
    expect(caps.sanitizeLevel).toBe('generic')
    expect(caps.mediaTargets).toContain('image')
  })

  it('deepseek is clean (no truncation, no sanitize)', () => {
    const caps = getCapabilities('deepseek')
    expect(caps.proneToTruncation).toBe(false)
    expect(caps.sanitizeLevel).toBe('none')
  })
})

describe('applyCapabilities', () => {
  it('user-explicit temperature wins', () => {
    const caps = getCapabilities('qwen-vl')
    expect(applyCapabilities(caps, { temperature: 0.9 }).temperature).toBe(0.9)
  })

  it('family default fills undefined temperature', () => {
    const caps = getCapabilities('qwen-vl')
    const withDefault = { ...caps, defaultTemperature: 0.5 }
    expect(applyCapabilities(withDefault, { temperature: undefined }).temperature).toBe(0.5)
  })

  it('no default → temperature stays undefined', () => {
    const caps = getCapabilities('deepseek')
    expect(applyCapabilities(caps, { temperature: undefined }).temperature).toBeUndefined()
  })
})
