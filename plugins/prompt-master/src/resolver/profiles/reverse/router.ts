// 反推 PE 路由 — 按 caption.type 路由到 Comfyui/Descriptive/Danbooru/Anima3/Prose 等 PE 模块

import * as ComfyuiPE from './comfyui.js';
import * as NaturalLanguagePE from './descriptive.js';
import * as AltProsePE from './prose.js';
import * as DanbooruPE from './danbooru.js';
import * as Anima3PE from './anima3.js';
import { cleanTagLineBody } from './tagLineSanitize.js';
import { buildCaptionLengthBlock, resolveDanbooruLenHint, resolveCaptionMaxNewTokens } from './length.js';

export const SUPPORTED_TYPES = new Set([
  'Descriptive',
  'Stable_Diffusion_Prompt',
  'Danbooru_tag_list',
]);

/** SD / Danbooru 且用户勾选「强化 ANIMA」时为 true */
export function useAnima3Enhance(caption: any): boolean {
  const t = caption.type || '';
  if (t !== 'Stable_Diffusion_Prompt' && t !== 'Danbooru_tag_list') return false;
  const v = caption.anima3_enhance;
  return v === true || v === 1 || v === '1' || v === 'true';
}

export function isTagLineCaptionType(caption: any): boolean {
  const t = caption.type || '';
  return t === 'Stable_Diffusion_Prompt' || t === 'Danbooru_tag_list';
}

export function useQualityPromptPrefix(caption: any): boolean {
  if (!isTagLineCaptionType(caption)) return false;
  const v = caption.quality_prompt_enabled;
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** 反推完成后在标签行前追加质量词（脚本侧拼接） */
export function applyQualityPrefixToCaption(text: string, caption: any): string {
  const body = String(text || '').trim();
  if (!useQualityPromptPrefix(caption)) return body;
  const prefix = String(caption.quality_prompt_prefix != null ? caption.quality_prompt_prefix : '').trim();
  if (!prefix) return body;
  if (!body) return prefix;
  const normPrefix = prefix.replace(/[,，]\s*$/, '').trim();
  let normBody = body.replace(/^[,，]\s*/, '').trim();
  const prefixHead = normPrefix.split(/[,，]\s*/)[0]?.trim().toLowerCase();
  const bodyHead = normBody.split(/[,，]\s*/)[0]?.trim().toLowerCase();
  if (prefixHead && bodyHead === prefixHead) return normBody;
  const sep = normBody.includes('，') && !/,/.test(normBody) ? '，' : ', ';
  return `${normPrefix}${sep}${normBody}`;
}

export function getPromptEngine(caption: any): any {
  const t = caption.type || 'Stable_Diffusion_Prompt';
  if (t === 'Descriptive') return NaturalLanguagePE;
  if (t === 'Stable_Diffusion_Prompt') return ComfyuiPE;
  if (t === 'Danbooru_tag_list') return DanbooruPE;
  return null;
}

export function usesDedicatedEngine(caption: any): boolean {
  return SUPPORTED_TYPES.has(caption.type || '');
}

export function isComfyuiSd(caption: any): boolean {
  return (caption.type || '') === 'Stable_Diffusion_Prompt';
}

export function isNaturalLanguage(caption: any): boolean {
  return (caption.type || '') === 'Descriptive';
}

export function isProseCaptionType(caption: any): boolean {
  return ComfyuiPE.PROSE_TYPES.has(caption.type || '');
}

export function isAltProseCaption(caption: any): boolean {
  return isProseCaptionType(caption) && !isNaturalLanguage(caption);
}

export function isDanbooru(caption: any): boolean {
  return (caption.type || '') === 'Danbooru_tag_list';
}

/** 根据提示词格式 + 标签长度推算 max_new_tokens（与 PM captionLength.js 一致） */
export function resolveMaxNewTokens(caption: any, limits?: any): number {
  return resolveCaptionMaxNewTokens(caption, limits);
}

// === Build functions ===

export function buildSystemPrompt(caption: any, media_target: string): string {
  if (isNaturalLanguage(caption)) return NaturalLanguagePE.buildSystemPrompt(caption, media_target);
  if (isAltProseCaption(caption)) return AltProsePE.buildSystemPrompt(caption, media_target);
  if (isDanbooru(caption)) {
    if (useAnima3Enhance(caption)) return Anima3PE.buildPrimarySystemPrompt(caption, media_target, { danbooru: true });
    return DanbooruPE.buildSystemPrompt(caption, media_target);
  }
  if (isComfyuiSd(caption)) {
    if (useAnima3Enhance(caption)) return Anima3PE.buildPrimarySystemPrompt(caption, media_target);
    return ComfyuiPE.buildExpertSystemPrefix(caption, media_target) + ComfyuiPE.buildFaithfulReproductionBlock(caption, media_target);
  }
  return ComfyuiPE.buildExpertSystemPrefix(caption, media_target);
}

export function buildSystemAddons(caption: any, media_target: string): string {
  const lengthBlock = usesDedicatedEngine(caption) ? buildCaptionLengthBlock(caption) : '';
  let out = '';
  if (useAnima3Enhance(caption) && (isComfyuiSd(caption) || isDanbooru(caption))) {
    out = Anima3PE.buildSystemAddons(caption, media_target) + lengthBlock;
  } else if (isComfyuiSd(caption)) {
    out = ComfyuiPE.buildTypeOutputAddon(caption) + ComfyuiPE.buildSystemWorkflowBlock(caption, media_target) + lengthBlock;
  } else if (isDanbooru(caption)) {
    const tagLenHint = resolveDanbooruLenHint(caption);
    const lenBlock = tagLenHint
      ? `\n\n[Tag volume] ${tagLenHint} Output remains ONE comma-separated tag line—not sentences.`
      : '';
    out = DanbooruPE.buildTypeOutputAddon(caption) + lenBlock;
  } else if (isAltProseCaption(caption)) {
    out = ComfyuiPE.buildSystemWorkflowBlock(caption, media_target) + lengthBlock;
  } else {
    out = lengthBlock;
  }
  return out;
}

export function buildOutputConstraints(caption: any): string {
  if (isNaturalLanguage(caption)) return NaturalLanguagePE.buildOutputConstraints(caption);
  if (isAltProseCaption(caption)) return AltProsePE.buildOutputConstraints(caption);
  if (useAnima3Enhance(caption)) return Anima3PE.buildOutputConstraints(caption);
  if (isDanbooru(caption)) return DanbooruPE.buildOutputConstraints(caption);
  if (isComfyuiSd(caption)) {
    const zh = (caption.caption_lang || 'en') === 'zh';
    return zh
      ? ' 【输出契约】仅一行逗号分隔标签（中文用「，」）；短语内可含空格，勿用 woman_角色_描述 式下划线长串；禁止自检、分析、Markdown 标题与思维链。'
      : ' [CONTRACT] One comma-separated SD tag line—short phrases with spaces allowed; do NOT chain descriptions with underscores (woman_..., man_...); no self-check headings or markdown.';
  }
  return '';
}

export function buildUserTaskLead(caption: any, media_target: string): string {
  if (isNaturalLanguage(caption)) return NaturalLanguagePE.buildUserTaskLead(caption, media_target);
  if (isAltProseCaption(caption)) return AltProsePE.buildUserTaskLead(caption, media_target);
  if (useAnima3Enhance(caption) && (isDanbooru(caption) || isComfyuiSd(caption))) {
    return Anima3PE.buildUserTaskLead(caption, media_target);
  }
  if (isDanbooru(caption)) return DanbooruPE.buildUserTaskLead(caption, media_target);
  if (isComfyuiSd(caption)) return ComfyuiPE.buildUserTaskFaithfulLead(caption);
  return ComfyuiPE.buildUserTaskFaithfulLead(caption);
}

export function buildUserTaskBody(caption: any): string | null {
  if (isNaturalLanguage(caption)) return NaturalLanguagePE.buildUserTaskBody(caption);
  if (isAltProseCaption(caption)) return AltProsePE.buildUserTaskBody(caption);
  if (useAnima3Enhance(caption) && isDanbooru(caption)) {
    return Anima3PE.buildUserTaskBody(caption, { danbooru: true });
  }
  if (useAnima3Enhance(caption) && isComfyuiSd(caption)) {
    return Anima3PE.buildUserTaskBody(caption);
  }
  if (isDanbooru(caption)) return DanbooruPE.buildUserTaskBody(caption);
  return null;
}

export function buildUserTaskTail(caption: any): string {
  if (isNaturalLanguage(caption)) return NaturalLanguagePE.buildUserTailAddon();
  if (isAltProseCaption(caption)) return AltProsePE.buildUserTailAddon(caption);
  if (useAnima3Enhance(caption) && (isDanbooru(caption) || isComfyuiSd(caption))) {
    return Anima3PE.buildUserTailAddon();
  }
  if (isDanbooru(caption)) return DanbooruPE.buildUserTailAddon(caption);
  if (isComfyuiSd(caption)) return ComfyuiPE.buildUserTailAddon(caption);
  return '';
}

// === 最终输出清洗（sanitizeFinalCaption）===
// 1:1 移植自 PM captionPromptEngineering.js 的 sanitizeFinalCaption。
//
// JoyCaption 扩展（joyCaptionExtraOptions / joyCaptionExtraPromptEngineering /
// captionExtraOptionSanitize）在 MCP Server 范围内有意裁剪（见 docs/architecture.md），
// 因此 applyJoyExtraOptionCaptionSanitize 与 buildJoyExtraUserEnforcementTail 实现为
// 记录在案的 no-op——保持函数签名以对齐 PM 调用结构，但不再应用这些额外选项。

/** 已裁剪（范围外）：返回原文不变 */
export function applyJoyExtraOptionCaptionSanitize(text: string): string {
  return String(text ?? '');
}

/** 已裁剪（范围外）：返回空字符串，不追加额外 enforcement tail */
export function buildJoyExtraUserEnforcementTail(): string {
  return '';
}

/**
 * 反推最终输出的统一后处理（清洗 + 去重 + 质量前缀）。
 * 调用点：tools/prompt-reverse.ts 在拿到 LLM 原文后调用。
 */
export function sanitizeFinalCaption(text: string, caption: any): string {
  if (isNaturalLanguage(caption) || isAltProseCaption(caption)) {
    const sanitizer = isNaturalLanguage(caption)
      ? NaturalLanguagePE.sanitizeProseOutput
      : AltProsePE.sanitizeProseOutput;
    let out = sanitizer(text);
    out = applyJoyExtraOptionCaptionSanitize(out);
    return applyQualityPrefixToCaption(out, caption);
  }

  const raw = String(text || '').trim();
  let out = raw;

  if (isDanbooru(caption)) {
    const base = DanbooruPE.sanitizeTagOutput(raw);
    if (!base && DanbooruPE.looksLikeTagProse(raw)) {
      out =
        '[未生成有效 Danbooru 标签行；ToriiGate 对 tag 格式遵从有限，建议改用 Qwen3.5，或将「标签量」调为标准后重试]';
    } else if (!useAnima3Enhance(caption)) {
      out = base;
    } else {
      out = Anima3PE.sanitizeTagLine(base) || base;
    }
  } else if (isComfyuiSd(caption)) {
    if (!useAnima3Enhance(caption)) {
      out = raw;
    } else {
      out = Anima3PE.sanitizeTagLine(raw) || raw.replace(/\*\*/g, '').replace(/\r?\n/g, ' ').trim();
    }
  }

  if (isTagLineCaptionType(caption)) {
    if (!String(out).trim().startsWith('[')) {
      out = cleanTagLineBody(out, caption);
    }
  }

  out = applyJoyExtraOptionCaptionSanitize(out);
  return applyQualityPrefixToCaption(out, caption);
}