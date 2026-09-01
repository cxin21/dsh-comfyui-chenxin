import type { ModelFamily } from './families.js'

export interface ModelCapabilities {
  family: ModelFamily
  proneToTruncation: boolean
  sanitizeLevel: 'none' | 'generic'
  mediaTargets: ReadonlyArray<'image' | 'video' | 'mixed'>
  lockedOutputLang?: 'zh' | 'en'
  defaultTemperature?: number
  defaultTopP?: number
}

export const FAMILY_CAPABILITIES: Record<ModelFamily, ModelCapabilities> = {
  deepseek: { family: 'deepseek', proneToTruncation: false, sanitizeLevel: 'none', mediaTargets: ['image'] },
  glm: { family: 'glm', proneToTruncation: false, sanitizeLevel: 'none', mediaTargets: ['image', 'video', 'mixed'] },
  'qwen-vl': { family: 'qwen-vl', proneToTruncation: true, sanitizeLevel: 'generic', mediaTargets: ['image', 'video', 'mixed'], defaultTemperature: 0.5 },
  'qwen-text': { family: 'qwen-text', proneToTruncation: true, sanitizeLevel: 'generic', mediaTargets: [] },
  gemma: { family: 'gemma', proneToTruncation: true, sanitizeLevel: 'generic', mediaTargets: ['image'] },
  openai: { family: 'openai', proneToTruncation: false, sanitizeLevel: 'none', mediaTargets: ['image'] },
  generic: { family: 'generic', proneToTruncation: false, sanitizeLevel: 'none', mediaTargets: [] },
}

export function getCapabilities(family: ModelFamily): ModelCapabilities {
  return FAMILY_CAPABILITIES[family] ?? FAMILY_CAPABILITIES.generic
}

/** 只填 undefined 字段——用户显式值永远赢 */
export function applyCapabilities<T extends { temperature?: number }>(caps: ModelCapabilities, params: T): T {
  return {
    ...params,
    ...(params.temperature === undefined && caps.defaultTemperature !== undefined
      ? { temperature: caps.defaultTemperature }
      : {}),
  }
}
