/**
 * H3 预算表（TS 移植，逐字段对照 h3_prompt/budget.py + references/budget-policy.json）。
 * 计数单元：官方上下文帧（含 vision pads）；T12 起默认走官方 tokenizer 精确计数（counter='official-tokenizer'），
 * tokenizer 加载失败时显式回退 estimate（counter='estimate'，契约②投影仍成立）。
 */
import { MAX_PROMPT_CHARS, type Reference } from '../schema/h3-shots.js'
import type { Budget } from '../types.js'
import { countTokensH3 } from './tokenizer-h3.js'

export const H3_CONTEXT_LIMIT = 262_144
export const H3_MIN_PIXELS = 65_536
export const H3_MAX_PIXELS = 16_777_216
export const H3_SPATIAL_STRIDE = 32
export const DEFAULT_REFERENCE_WIDTH = 1024
export const DEFAULT_REFERENCE_HEIGHT = 1024
export const DEFAULT_RUNTIME_SAFETY_MARGIN = 256

/** budget-policy.json limits.quality_cap 逐 stage（depth=quick，缺省——golden 基线口径） */
export const STAGE_QUALITY_CAPS: Record<string, number> = {
  t2va: 1200,
  i2va: 1500,
  fl2va: 1700,
  l2va: 1700,
  ref2va: 2400,
}

/** depth=director 档（h3-director-depth Phase 7）：导演级内容（表演肌理/声音编排/constraints）需要更大写作空间；
 *  仍远低于 MAX_PROMPT_CHARS=7000 官方硬上限。qualityCap 只影响 budget 投影（advisory），不产生 critical gate。 */
export const STAGE_QUALITY_CAPS_DIRECTOR: Record<string, number> = {
  t2va: 2800,
  i2va: 3200,
  fl2va: 3600,
  l2va: 3600,
  ref2va: 4800,
}

export type H3BudgetDepth = 'quick' | 'director'

/** 官方上下文帧的视觉 token 计算（visual_tokens 移植；估算口径，像素面积约束不变） */
export function visualTokens(reference: Reference, assumptions: string[]): number {
  let width = reference.width
  let height = reference.height
  if (width == null || height == null) {
    width = width ?? DEFAULT_REFERENCE_WIDTH
    height = height ?? DEFAULT_REFERENCE_HEIGHT
    assumptions.push(`reference_dimensions_assumed:${reference.who || 'Picture'}=${width}x${height}`)
  }
  const pixels = width * height
  if (!(H3_MIN_PIXELS <= pixels && pixels <= H3_MAX_PIXELS)) {
    throw new Error(
      `reference ${JSON.stringify(reference.who)} pixel area must be within ${H3_MIN_PIXELS}..${H3_MAX_PIXELS}`,
    )
  }
  return Math.ceil(width / H3_SPATIAL_STRIDE) * Math.ceil(height / H3_SPATIAL_STRIDE)
}

/**
 * 估算 token 数（counter: 'estimate'）：字符数 / 4 粗估（非官方 tokenizer，T11 前唯一口径）。
 * text_tokens 投影以 golden 官方数值为基准，此处 estimate 仅用于 over 判定语义。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface H3BudgetProjection {
  counter: 'official-tokenizer' | 'estimate'
  textTokens: number
  charCount: number
  charLimit: number
  qualityCap: number
  chatTemplateTokens: number
  effectiveCap: number
  over: boolean
  tokenOver: boolean
  charOver: boolean
}

/** budget.py build_budget 投影（contracts.md ② 保真字段集；放弃字段不入投影）。T12：精确计数为唯一口径，estimate 仅显式回退 */
export function buildH3Budget(
  stage: string,
  text: string,
  references: Reference[] = [],
  options?: { textTokensOverride?: number; tokenizerSourceDir?: string; depth?: H3BudgetDepth },
): H3BudgetProjection {
  const caps = options?.depth === 'director' ? STAGE_QUALITY_CAPS_DIRECTOR : STAGE_QUALITY_CAPS
  const qualityCap = caps[stage] ?? caps.t2va
  const assumptions: string[] = []
  const visual = references.reduce((sum, ref) => sum + visualTokens(ref, assumptions), 0)
  // chat 帧底（T14 精确口径：官方 user 上下文帧全量 BPE，text="" + vision pads 展开；
  // tokenizer 不可载 → 显式回退旧估算 5+2N，与 textTokens 的 estimate 回退相互独立）
  let chatTemplateTokens: number
  try {
    chatTemplateTokens = countTokensH3('', options?.tokenizerSourceDir, references.length).tokens
  } catch {
    chatTemplateTokens = references.length === 0 ? 5 : Math.ceil(5 + references.length * 2)
  }
  const available = H3_CONTEXT_LIMIT - visual - chatTemplateTokens - DEFAULT_RUNTIME_SAFETY_MARGIN
  if (available < 0) throw new Error('multimodal inputs exceed the physical H3 context limit')
  const effectiveCap = Math.min(qualityCap, available)
  const charCount = text.length
  const charOver = charCount > MAX_PROMPT_CHARS
  let counter: H3BudgetProjection['counter'] = 'official-tokenizer'
  let textTokens: number
  if (options?.textTokensOverride !== undefined) {
    textTokens = options.textTokensOverride
  } else {
    try {
      // 官方上下文帧精确计数（含 vision pads 展开 + im_start/im_end 帧）
      textTokens = countTokensH3(text, options?.tokenizerSourceDir, references.length).tokens
    } catch {
      // 显式回退：tokenizer 源缺失/不可载 → estimate（仅计数口径退级，其余投影不变）
      counter = 'estimate'
      textTokens = estimateTokens(text)
    }
  }
  const tokenOver = textTokens > effectiveCap
  return {
    counter,
    textTokens,
    charCount,
    charLimit: MAX_PROMPT_CHARS,
    qualityCap,
    chatTemplateTokens,
    effectiveCap,
    over: tokenOver || charOver,
    tokenOver,
    charOver,
  }
}

/** 对齐 AuditReport.budget（T1 类型）——counter 随精确/回退口径 */
export function h3BudgetToReport(budget: H3BudgetProjection): Budget {
  return {
    counter: budget.counter,
    tokens: budget.textTokens,
    max: budget.effectiveCap,
    over: budget.over,
  }
}