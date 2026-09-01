// 反推→扩写镜像管线 — 1:1 移植自 PM expandReverseMirror.js

import { resolveExpandSystemMessage, buildExpandUserPrompt, resolveExpandMaxTokens, applyExpandLength, applyUserExtraPrompt, applyOutputLanguage } from './expand-rules.js';
import { PROMPTS_B } from './torii/prompts.js';
import { isStructuredTemplateProfile } from './torii/formats.js';
import { PEProfile, ExpandResult } from '../types.js';
import { buildSystemPrompt as routerBuildSystemPrompt, buildSystemAddons as routerBuildSystemAddons } from './reverse/router.js';
import { renderTemplate } from '../renderer.js';

function mirrorProfileForExpand(src: PEProfile): PEProfile {
  let id = String(src.id || '').trim();
  if (id.startsWith('pe_reverse_')) id = id.replace(/^pe_reverse_/, 'pe_expand_');
  else if (id.startsWith('pe_torii_')) id = id.replace(/^pe_torii_/, 'pe_expand_torii_');
  else if (id && !id.startsWith('pe_expand_')) id = `pe_expand_${id.replace(/^pe_/, '')}`;

  return {
    ...src,
    id,
    kind: 'expand',
    category: String(src.category || '').replace(/^反推$/, '扩写').replace(/^结构化 \/ /, '扩写 / ') || '扩写',
    expandMirrorOf: src.id,
    systemPrompt: undefined,
    userPromptTemplate: undefined,
  };
}

export function buildExpandProfilesFromReverseCatalog(reverseProfiles: PEProfile[], toriiProfiles: PEProfile[]): PEProfile[] {
  return [...(reverseProfiles || []), ...(toriiProfiles || [])].map(mirrorProfileForExpand);
}

export function isReverseCatalogExpandProfile(profile: PEProfile | null): boolean {
  if (!profile || profile.kind !== 'expand') return false;
  if ((profile as any).expandMirrorOf) return true;
  const id = String(profile.id || '');
  return id === 'pe_expand_descriptive' || id === 'pe_expand_sd' || id === 'pe_expand_danbooru' || id.startsWith('pe_expand_torii_');
}

function adaptReversePeSystemForExpand(system: string, outputLang: string): string {
  const useEn = String(outputLang || 'zh') === 'en';
  const pre = useEn
    ? 'Expand the user brief text into a ready-to-use image-generation prompt (text expansion—not image captioning).\n\n'
    : '将用户简短描述扩写为完整 AI 绘图正向提示词（文本扩写，非看图反推）。\n\n';
  return (
    pre +
    String(system || '')
      .replace(/反推/g, '扩写')
      .replace(/标注专家/g, '扩写专家')
      .replace(/当前图像|当前视频关键帧|当前视频画面|当前视频/g, '扩写结果')
      .replace(/图像内容|视频画面/g, '扩写内容')
  );
}

function buildStructuredExpandSystem(profile: PEProfile, outputLang: string, expandLen: string, expandLenChars: number | undefined, userExtraPrompt: string): string {
  const fmt = String((profile as any).builtinKey || '').trim();
  const formatBlock = (PROMPTS_B as any)[fmt] || '';
  const useEn = String(outputLang || 'zh') === 'en';
  let system = useEn
    ? `You expand brief user text into a structured image-generation prompt.\n\n# Required output structure\n${formatBlock}\n\nExpand ONLY from the user's short text. Output must follow the structure above.`
    : `将用户简短描述扩写为结构化 AI 绘图正向提示词。\n\n# 输出结构\n${formatBlock}\n\n仅根据用户短文本扩写，输出须符合上述结构。`;
  system = applyExpandLength(system, expandLen, outputLang, expandLenChars);
  system = applyUserExtraPrompt(system, userExtraPrompt, outputLang);
  return applyOutputLanguage(system, outputLang, `expand_torii_${fmt}`);
}

export function resolveExpandFromReverseMirror(profile: PEProfile, params: any): ExpandResult {
  const outputLang = params.outputLang || 'zh';
  const expandLen = params.expandLen || 'medium';
  const expandLenChars = params.expandLenChars;
  const userExtraPrompt = params.userExtraPrompt || '';
  const shortText = params.shortText || '';
  const tokenLimits = params.tokenLimits || null;

  if (isStructuredTemplateProfile(profile)) {
    const system = buildStructuredExpandSystem(profile, outputLang, expandLen, expandLenChars, userExtraPrompt);
    const user = buildExpandUserPrompt(
      shortText,
      expandLen,
      outputLang,
      expandLenChars,
      `expand_torii_${(profile as any).builtinKey}`,
      userExtraPrompt
    );
    return {
      system,
      user,
      maxTokens: resolveExpandMaxTokens(expandLen, expandLenChars, tokenLimits),
      ruleId: profile.id,
    };
  }

  const cap = {
    type: (profile as any).builtinKey || 'Descriptive',
    caption_lang: outputLang,
    len: expandLen,
    caption_len_chars: expandLenChars,
    media_target: 'image',
  } as any;

  // M1：上游 expandReverseMirror.js:125-126 走 CaptionPE.buildSystemPrompt + buildSystemAddons
  // （按 type 路由 Descriptive/Danbooru/Anima3，并叠加 workflow/长度 addon），非 ComfyUI 双块硬编码
  let system = routerBuildSystemPrompt(cap, 'image') + routerBuildSystemAddons(cap, 'image');
  system = adaptReversePeSystemForExpand(system, outputLang);
  system = applyExpandLength(system, expandLen, outputLang, expandLenChars);
  system = applyUserExtraPrompt(system, userExtraPrompt, outputLang);

  const user = buildExpandUserPrompt(
    shortText,
    expandLen,
    outputLang,
    expandLenChars,
    (profile as any).builtinKey,
    userExtraPrompt
  );

  return {
    system,
    user,
    maxTokens: resolveExpandMaxTokens(expandLen, expandLenChars, tokenLimits),
    ruleId: profile.id,
  };
}

// 旧 ID → 新 ID 映射（与 PM 中 LEGACY_EXPAND_PE_ID_MAP 对齐）
export const LEGACY_EXPAND_PE_ID_MAP: Record<string, string> = {
  pe_expand_natural: 'pe_expand_descriptive',
  expand_natural: 'pe_expand_descriptive',
  natural: 'pe_expand_descriptive',
  pe_expand_compact: 'pe_expand_sd',
  expand_compact: 'pe_expand_sd',
  compact: 'pe_expand_sd',
  pe_expand_cinematic: 'pe_expand_sd',
  expand_cinematic: 'pe_expand_sd',
  cinematic: 'pe_expand_sd',
  pe_expand_photographer: 'pe_expand_descriptive',
  expand_photographer: 'pe_expand_descriptive',
  photographer: 'pe_expand_descriptive',
  pe_expand_descriptive_en: 'pe_expand_descriptive',
  expand_descriptive_en: 'pe_expand_descriptive',
  descriptive_en: 'pe_expand_descriptive',
  pe_expand_danbooru: 'pe_expand_danbooru',
  expand_danbooru: 'pe_expand_danbooru',
  danbooru: 'pe_expand_danbooru',
  pe_expand_structured_md: 'pe_expand_torii_min_structured_md',
  expand_structured_md: 'pe_expand_torii_min_structured_md',
  pe_expand_structured_json: 'pe_expand_torii_min_structured_json',
  expand_structured_json: 'pe_expand_torii_min_structured_json',
};

export function mapLegacyExpandPeId(peId: string): string {
  const raw = String(peId || '').trim();
  if (!raw) return 'pe_expand_descriptive';
  if (LEGACY_EXPAND_PE_ID_MAP[raw]) return LEGACY_EXPAND_PE_ID_MAP[raw];
  if (raw.startsWith('pe_')) return raw;
  const withPe = `pe_${raw}`;
  return LEGACY_EXPAND_PE_ID_MAP[withPe] || withPe;
}