/**
 * R2: intent seam 导出（plugin 装入 + 测试 mock 使用）。
 * AuthorIntentFn 契约复用 author.ts 的 AuthorIntentFn（避免重复定义）。
 */

export type { AuthorIntentFn, AuthorIntentRequest, AuthorDraft } from '../../tools/prompt-author.js'

import { createSubagentIntentProvider, type SubagentProviderOptions, type SubagentLikeRun } from './subagent-provider.js'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorIntentFn } from '../../tools/prompt-author.js'

export type { SubagentLikeRun, SubagentProviderOptions } from './subagent-provider.js'
export { createSubagentIntentProvider } from './subagent-provider.js'

/**
 * 默认 Intent Provider：在 plugin/apply 内用 ctx 创建闭包后传入。
 * ownerCtx 在这里一次性绑定；返回的 AuthorIntentFn 可直接 setAuthorIntentProvider 装入。
 */
export function createDefaultIntentProvider(ctx: Context, opts: SubagentProviderOptions = {}): AuthorIntentFn {
  return createSubagentIntentProvider(ctx, opts)
}

/* ── T4: intent 薄包装（resolver 组装，PE 引擎复用）── */

import { resolveExpand } from '../../resolver/index.js'
import { resolveReverse } from '../../resolver/index.js'
import type { PEProfile } from '../../resolver/types.js'

export interface ExpandIntentParams {
  outputLang?: string
  expandLen?: string
  userExtraPrompt?: string
  shortText: string
}

export interface ReverseIntentParams {
  captionLang?: string
  len?: string
  mediaTarget?: 'image' | 'anima' | 'h3'
  extraPrompt?: string
  anima3Enhance?: boolean
}

/** 薄包装：等价于 resolver 的 resolveExpand */
export function assembleExpandIntent(profile: PEProfile, params: ExpandIntentParams) {
  return resolveExpand(profile, {
    outputLang: (params.outputLang || 'zh') as 'zh' | 'en' | 'auto',
    expandLen: params.expandLen || 'medium',
    userExtraPrompt: params.userExtraPrompt || '',
    shortText: params.shortText,
  })
}

/** 薄包装：等价于 resolver 的 resolveReverse（media_target 扩展） */
export function assembleReverseIntent(profile: PEProfile, params: ReverseIntentParams) {
  return resolveReverse(profile, {
    caption_lang: params.captionLang || 'zh',
    len: params.len || 'medium',
    media_target: params.mediaTarget || 'image',
    extra_prompt: params.extraPrompt || '',
    anima3_enhance: params.anima3Enhance === true,
  } as any)
}
