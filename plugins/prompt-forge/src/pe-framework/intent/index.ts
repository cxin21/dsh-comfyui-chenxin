/**
 * R2: intent seam 导出（plugin 装入 + 测试 mock 使用）。
 * AuthorIntentFn 契约复用 author.ts 的 AuthorIntentFn（避免重复定义）。
 */

export type { AuthorIntentFn, AuthorIntentRequest, AuthorDraft } from '../../tools/prompt-author.js';

import {
  type SubagentProviderOptions,
} from './subagent-provider.js';
import { createDirectIntentProvider } from './direct-provider.js';
import type { Context } from '@deepseek-ai/cordis';
import type { AuthorIntentFn } from '../../tools/prompt-author.js';

export type { SubagentLikeRun, SubagentProviderOptions } from './subagent-provider.js';
export { createSubagentIntentProvider } from './subagent-provider.js';

/* ── 2026-11-22：transport 抽象 ──
 * intent core（persona/schema/taskText/parse）已从 subagent-provider 抽出，两条 transport 共用：
 *   - direct（ctx.llm.stream 直连）—— host 0.2.2-rc.5 移除 ctx.subagents.start 后的默认路径；
 *   - subagent（ctx.subagents.start）—— 旧 host 回退。
 * 导出 core 与 direct provider，供 plugin 装配与测试使用。
 */
export {
  createDirectIntentProvider,
  type DirectIntentProviderOptions,
} from './direct-provider.js';
export {
  buildIntentTaskText,
  resolveIntentPersonaSchema,
  parseIntentDraft,
  extractJsonCandidate,
  applyBlueprintClarify,
  dumpIntentRequest,
  normalizeSlots,
  type IntentPromptOptions,
} from './core.js';

/**
 * 默认 Intent Provider：在 plugin/apply 内用 ctx 创建闭包后传入。
 * ownerCtx 在这里一次性绑定；返回的 AuthorIntentFn 可直接 setAuthorIntentProvider 装入。
 *
 * 2026-11-22：默认走 direct transport（host 0.2.2-rc.5 的 subagents 只有 startActivation，
 * 没有 start → 旧实现会在 apply 期硬接线就抛错，整包 14 个工具拒载）。
 * transport 本身在**调用期**按能力解析：direct 优先，`PM_TRANSPORT=subagent` 可切回旧形态，
 * direct 不可用时自动回退 subagent（老 host 行为不变）。
 * 若需显式指定某一条形态，请直接用 createDirectIntentProvider / createSubagentIntentProvider。
 */
export function createDefaultIntentProvider(ctx: Context, opts: SubagentProviderOptions = {}): AuthorIntentFn {
  return createDirectIntentProvider(ctx, opts);
}

/* ── T4: intent 薄包装（resolver 组装，PE 引擎复用）── */

import { resolveExpand } from '../../resolver/index.js';
import { resolveReverse } from '../../resolver/index.js';
import type { PEProfile } from '../../resolver/types.js';

export interface ExpandIntentParams {
  outputLang?: string;
  expandLen?: string;
  userExtraPrompt?: string;
  shortText: string;
}

export interface ReverseIntentParams {
  captionLang?: string;
  len?: string;
  mediaTarget?: 'image' | 'anima' | 'h3';
  extraPrompt?: string;
  anima3Enhance?: boolean;
}

/** 薄包装：等价于 resolver 的 resolveExpand */
export function assembleExpandIntent(profile: PEProfile, params: ExpandIntentParams) {
  return resolveExpand(profile, {
    outputLang: (params.outputLang || 'zh') as 'zh' | 'en' | 'auto',
    expandLen: params.expandLen || 'medium',
    userExtraPrompt: params.userExtraPrompt || '',
    shortText: params.shortText,
  });
}

/** 薄包装：等价于 resolver 的 resolveReverse（media_target 扩展） */
export function assembleReverseIntent(profile: PEProfile, params: ReverseIntentParams) {
  return resolveReverse(profile, {
    caption_lang: params.captionLang || 'zh',
    len: params.len || 'medium',
    media_target: params.mediaTarget || 'image',
    extra_prompt: params.extraPrompt || '',
    anima3_enhance: params.anima3Enhance === true,
  } as any);
}
