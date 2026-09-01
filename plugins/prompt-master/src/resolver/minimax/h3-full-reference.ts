// H3 Full-Reference 独立入口 — 1:1 移植自 PM config/h3FullReferencePromptEngineering.js（X7）
// system = 指南全文（zh/en 模板）+ 语言附加块；user = 固定 Rewrite 模板 + 参考素材列表

import { resolveExpandMaxTokens } from '../profiles/expand-rules.js';
import { H3_REFERENCE_EN, H3_REFERENCE_ZH } from './templates/index.js';
import { enumerateTaggedMedia, DEFAULT_MEDIA_EXPAND_MIN } from './assemble.js';

export const H3_FULL_REFERENCE_PROFILE_ID = 'pe_expand_h3_full_reference';
export const H3_FULL_REFERENCE_BUILTIN_KEY = 'h3_full_reference';

export const H3_FULL_REFERENCE_USER_PROMPT_TEMPLATE = `Rewrite the user materials below into a MiniMax-H3 Full-Reference Mode standardized 6-section video prompt.

Follow the system instructions exactly.
Output ONLY the six sections, starting with subject_definitions: and ending with non_diegetic_music:.
Do NOT wrap the output in markdown code fences.
Do NOT add greetings, explanations, or notes.

【User materials / brief】
{{user_input}}`;

export function loadH3FullReferenceSystem(lang: string): string {
  const key = String(lang || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';
  let system = key === 'en' ? H3_REFERENCE_EN : H3_REFERENCE_ZH;
  if (key === 'zh') {
    system += '\n\n【输出语言】本模板为中文版。六段标题必须中文：主体定义: / 摘要: / 保留分析: / 详细描述: / 整体声景: / 非叙事配乐:。禁止 subject_definitions: 等英文章节标题。正文必须简体中文。对白/歌词/画面可见文字在 <d> 内保留原语言；参考标签与关系标记保持英文。';
    system += '\n\n【输出契约】绝对纯净输出。以「主体定义:」开头，以「非叙事配乐:」结束。不要 Markdown 代码围栏，不要解释。';
    system += '\n\n【参考素材】可附带真实图片/视频（或关键帧）。标签 <Picture N>/<Video N>/<Audio N> 在六段中保持同一身份。视觉细节以素材为准。';
  } else {
    system += '\n\n【Output language】English edition. Write all six rewrite sections in English. Preserve the original language ONLY for dialogue, lyrics, and visible on-screen text inside <d> tags.';
    system += '\n\n【Output contract】Absolute pure output only. Start with subject_definitions: and end with non_diegetic_music:. No markdown fences, no explanations.';
    system += '\n\n【Reference media】Reference media may be attached as real images/video (or keyframes). Tags <Picture N>, <Video N>, <Audio N> keep stable identity across the six sections. Ground visual details on attached media.';
  }
  return system;
}

export function isH3FullReferenceProfile(profile: any): boolean {
  if (!profile || profile.kind !== 'expand') {
    return false;
  }
  const id = String(profile.id || '').trim();
  const key = String(profile.builtinKey || '').trim();
  return id === H3_FULL_REFERENCE_PROFILE_ID || key === H3_FULL_REFERENCE_BUILTIN_KEY;
}

export function isH3FullReferencePeId(peId: string): boolean {
  const id = String(peId || '').trim();
  return (
    id === H3_FULL_REFERENCE_PROFILE_ID ||
    id === H3_FULL_REFERENCE_BUILTIN_KEY ||
    id === `pe_expand_${H3_FULL_REFERENCE_BUILTIN_KEY}`
  );
}

function renderUserPrompt(shortText: string): string {
  const body = String(shortText || '').trim();
  return H3_FULL_REFERENCE_USER_PROMPT_TEMPLATE.split('{{user_input}}').join(body);
}

/**
 * Full-Reference 改写独立解析：不套用绘图扩写的语言锁 / 篇幅提示 / 待扩写原文守卫。
 * 支持参考素材列表（Minimax 媒体扩写布局）。
 */
export function resolveH3FullReferenceExpand(profile: any, params: any): {
  system: string;
  user: string;
  maxTokens: number;
  ruleId: string;
  mediaExpandLayout: boolean;
} | null {
  const shortText = String((params && params.shortText) || '').trim();
  const expandLen = (params && params.expandLen) || 'long';
  const expandLenChars = params && params.expandLenChars;
  const userExtraPrompt = String((params && params.userExtraPrompt) || '').trim();
  const mediaPaths = Array.isArray(params && params.mediaPaths) ? params.mediaPaths : [];

  const outputLang =
    String((params && params.outputLang) || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';
  let system = loadH3FullReferenceSystem(outputLang);

  if (userExtraPrompt) {
    system += `\n\n【User additional requirements】${userExtraPrompt}`;
  }

  const userParts = [renderUserPrompt(shortText || '(empty)')];
  const mediaLines = enumerateTaggedMedia(mediaPaths).map(
    (item) => `- ${item.tag} ${item.base}（路径：${item.path}）`
  );
  if (mediaLines.length) {
    userParts.push('', '【参考素材 / Reference media】', ...mediaLines);
  }

  const tokenLimits: any = (params && params.tokenLimits) || null;
  const mediaMin =
    (tokenLimits && Number.isFinite(Number(tokenLimits.mediaExpandMin)) && Number(tokenLimits.mediaExpandMin)) ||
    DEFAULT_MEDIA_EXPAND_MIN;
  const maxTokens = Math.max(resolveExpandMaxTokens(expandLen, expandLenChars, tokenLimits), mediaMin);

  return {
    system,
    user: userParts.join('\n'),
    maxTokens,
    ruleId: H3_FULL_REFERENCE_PROFILE_ID,
    mediaExpandLayout: true,
  };
}
