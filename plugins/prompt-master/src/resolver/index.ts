// Resolver 主入口 — resolveExpand  +  resolveReverse
// 移植 PromptMaster  config/promptEngineeringResolver.js
// 核心 PE 引擎：扩写、反推、MiniMax 场景路由

import { PEProfile, ExpandParams, ExpandResult, ReverseParams, ReverseResult } from './types.js';
import {
  resolveExpandSystemMessage,
  buildExpandUserPrompt,
  resolveExpandMaxTokens,
  applyExpandLength,
  applyUserExtraPrompt,
  applyOutputLanguage,
  resolveUseEnglishOutput,
  getOutputLangUserLock,
  resolveExpandLengthSpec,
} from './profiles/expand-rules.js';
import { renderTemplate, blockOrEmpty, userTemplateHasInputPlaceholder, appendExpandSourceBlock } from './renderer.js';
import {
  buildSystemPrompt as routerBuildSystemPrompt,
  buildSystemAddons,
  buildUserTaskLead,
  buildUserTaskBody,
  buildUserTaskTail,
  buildOutputConstraints,
} from './profiles/reverse/router.js';
import { isReverseCatalogExpandProfile, resolveExpandFromReverseMirror } from './profiles/expand-mirror.js';
// V1：自定义反推分支的长度块走 CaptionLen（PM promptEngineeringResolver.js:227 CaptionLen.buildCaptionLengthBlock）
import { buildCaptionLengthBlock } from './profiles/reverse/length.js';
import { isMinimaxScenarioProfile, resolveMinimaxScenarioExpand, isH3FullReferenceProfile, resolveH3FullReferenceExpand } from './minimax/index.js';

// 给 router 函数起别名避免和上面 expand 解析中的 buildSystemPrompt 冲突
const buildSystemPrompt = routerBuildSystemPrompt;

/**
 * 扩写管道：profile + params  →  {system, user, maxTokens}
 * 完全对应 PromptMaster 的 resolveExpandPrompts()
 */
export function resolveExpand(profile: PEProfile, params: ExpandParams): ExpandResult {
  if (!profile) throw new Error('resolveExpand: profile is required');

  const outputLang = params.outputLang || 'zh';
  const expandLen = params.expandLen || 'medium';
  const expandLenChars = params.expandLenChars;
  const userExtraPrompt = params.userExtraPrompt || '';
  const shortText = params.shortText || '';
  const tokenLimits = params.tokenLimits || null;

  // 1) MiniMax 场景 Profile（pm 中 isMinimaxScenarioProfile 分支）
  if (isMinimaxScenarioProfile(profile)) {
    const resolved = resolveMinimaxScenarioExpand(profile, {
      ...params,
      tokenLimits,
      mediaPaths: (params && params.mediaPaths) || [],
      minimaxForm: (params && params.minimaxForm) || {},
    });
    if (resolved) return resolved;
  }

  // 1b) H3 Full-Reference 独立入口（X7 — upstream h3FullReferencePromptEngineering.js）
  // upstream electron resolver 场景路径优先（pe_expand_h3_full_reference 同时在 minimax catalog）；
  // 独立入口在场景解析未命中时兜底，与 upstream「同一 peId 两条路径、场景路径在前」的调用关系一致
  if (isH3FullReferenceProfile(profile)) {
    const resolved = resolveH3FullReferenceExpand(profile, {
      ...params,
      tokenLimits,
      mediaPaths: (params && params.mediaPaths) || [],
    });
    if (resolved) return resolved;
  }

  // 2) 反推镜像 Profile（pe_expand_descriptive / pe_expand_sd / pe_expand_danbooru / pe_expand_torii_*）
  if (isReverseCatalogExpandProfile(profile)) {
    return resolveExpandFromReverseMirror(profile, params);
  }

  // 3) 内置 expand_* 规则（来自 promptExpandRules.js 的 8 种 system prompt）
  if (profile.builtin && profile.builtinKey && String(profile.builtinKey).startsWith('expand_')) {
    const ruleId = profile.builtinKey;
    return {
      system: resolveExpandSystemMessage(ruleId, '', outputLang, expandLen, expandLenChars, userExtraPrompt),
      user: buildExpandUserPrompt(shortText, expandLen, outputLang, expandLenChars, ruleId, userExtraPrompt),
      maxTokens: resolveExpandMaxTokens(expandLen, expandLenChars, tokenLimits),
      ruleId,
    };
  }

  // 4) 自定义 Profile
  const trimmedShort = String(shortText).trim();
  let system = String(profile.systemPrompt || '').trim();
  if (!system) {
    system = resolveExpandSystemMessage('expand_natural', '', outputLang, expandLen, expandLenChars, '');
  }

  system = ensureCustomExpandSystem(system, outputLang, trimmedShort);
  system = applyOutputLanguage(system, outputLang);
  system = applyExpandLength(system, expandLen, outputLang, expandLenChars);
  system = applyUserExtraPrompt(system, userExtraPrompt, outputLang);

  // 长度约束：从 expand-rules 的 spec 取出实际 hint 填入
  const spec = resolveExpandLengthSpec(expandLen, expandLenChars, outputLang);
  const useEn = resolveUseEnglishOutput(outputLang, trimmedShort);
  const lengthLine = useEn ? spec.hintEn : spec.hintZh;
  const langLock = getOutputLangUserLock(outputLang);
  const intro = useEn
    ? 'Expand the following brief description into a ready-to-use image generation prompt. Output only the expanded prompt.'
    : '请将以下简短描述扩写为完整、可直接用于 AI 绘图的正向提示词。只输出扩写正文，不要解释。';

  const userTpl = String(profile.userPromptTemplate || '').trim();
  let user = userTpl;
  if (userTpl.includes('{{')) {
    user = renderTemplate(userTpl, {
      intro,
      lang_lock: langLock ? `${langLock}\n\n` : '',
      length_title: useEn ? 'Length' : '篇幅',
      length_hint: lengthLine,
      format_block: '',
      extra_block: userExtraPrompt
        ? blockOrEmpty(`【${useEn ? 'User additional requirements' : '用户附加要求'}】${userExtraPrompt}`)
        : '',
      user_input_title: useEn ? 'User input' : '用户输入',
      user_input: trimmedShort,
    });
  }
  if (!String(user || '').trim()) {
    user = intro;
  } else if (langLock) {
    user = `${String(user).trim()}\n\n${langLock}`;
  }
  if (!userTemplateHasInputPlaceholder(userTpl)) {
    user = appendExpandSourceBlock(user, trimmedShort, outputLang);
  }

  return {
    system,
    user,
    maxTokens: resolveExpandMaxTokens(expandLen, expandLenChars, tokenLimits),
    ruleId: profile.id,
  };
}

function ensureCustomExpandSystem(system: string, outputLang: string, shortText: string): string {
  let s = String(system || '').trim();
  const useEn = resolveUseEnglishOutput(outputLang, shortText);
  const guard = useEn
    ? ' Expand ONLY the source text labeled「待扩写原文」or「Source text to expand」in the user message. Never treat style names or expansion rules as the subject to elaborate.'
    : ' 仅扩写用户消息中「待扩写原文」一段为绘图正向提示词；不要把风格名、扩写规则本身扩写成说明文或散文。';
  if (!/待扩写原文|Source text to expand|用户输入|User input/i.test(s)) s += guard;
  return s;
}

/**
 * 反推管道：profile + params  →  {system, userLead, userBody, outputConstraints, userTail}
 * 对应 PromptMaster 的 resolveReversePrompts()
 * 内部走 reverse/router.ts 路由到 Comfyui / Descriptive / Danbooru / Anima3 / Prose 模块
 */
export function resolveReverse(profile: PEProfile, params: ReverseParams): ReverseResult {
  const cap: any = { ...params, type: captionTypeFromProfile(profile) };
  const mediaTarget = cap.media_target || 'image';

  if (profile.builtin) {
    return {
      captionType: cap.type,
      builtin: true,
      system: routerBuildSystemPrompt(cap, mediaTarget) + buildSystemAddons(cap, mediaTarget),
      userLead: buildUserTaskLead(cap, mediaTarget),
      userBody: buildUserTaskBody(cap) || '',
      outputConstraints: buildOutputConstraints(cap),
      userTail: buildUserTaskTail(cap),
    };
  }

  // 自定义 Profile
  const zh = (cap.caption_lang || 'en') === 'zh';
  let system = String(profile.systemPrompt || '').trim();
  system = applyOutputLanguage(system, cap.caption_lang || 'zh');

  // V1：上游此处追加 CaptionLen.buildCaptionLengthBlock(cap)（resolver.js:227）；
  // port 曾误用 routerBuildSystemPrompt 顶替长度块——恢复长度块。JoyExtra enforcement 块
  // （resolver.js:228）按既定裁剪方针维持不移植。
  system += buildCaptionLengthBlock(cap);

  const taskLead = zh
    ? '请根据当前媒体内容，严格按系统提示词要求输出反推结果。只输出正文，不要解释。'
    : 'Analyze the media and output the caption per system instructions. Output body only.';

  // 走模板
  const userTpl = (cap.userPromptTemplate || '{{task_lead}}\n\n{{length_block}}\n\n{{extra_block}}').toString();
  let user = userTpl.includes('{{') ? renderTemplate(userTpl, {
    task_lead: taskLead,
    length_block: '',
    extra_block: cap.extra_prompt
      ? blockOrEmpty(`【附加要求】${String(cap.extra_prompt).trim()}`)
      : '',
  }) : taskLead;

  return {
    captionType: cap.type,
    builtin: false,
    system,
    userLead: '',
    userBody: user,
    outputConstraints: zh
      ? ' 【输出契约】只输出提示词正文，禁止 Markdown、思维链与自检标题。'
      : ' [CONTRACT] Prompt text only; no markdown or chain-of-thought.',
    userTail: '',
  };
}

function captionTypeFromProfile(profile: PEProfile): string {
  if (profile.builtin && profile.builtinKey) return profile.builtinKey;
  return (profile as any).captionType || 'Stable_Diffusion_Prompt';
}