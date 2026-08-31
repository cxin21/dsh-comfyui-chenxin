// 非 Descriptive 的散文式反推 — 1:1 移植自 PM proseCaptionPromptEngineering.js

import * as ComfyuiPE from './comfyui.js';
import { sanitizeProseOutput, resolveWordCountHint } from './descriptive.js';

const ALT_PROSE_TYPES: Set<string> = new Set([
  'Descriptive_Casual',
  'Straightforward',
  'Art_Critic',
  'Product_Listing',
  'Social_Media_Post',
]);

function captionType(caption: any): string {
  return caption.type || '';
}

export function applies(caption: any): boolean {
  return ALT_PROSE_TYPES.has(captionType(caption));
}

function isZhCaption(caption: any): boolean {
  return (caption.caption_lang || 'en') === 'zh';
}

const ROLE_ZH: Record<string, string> = {
  Straightforward: '简洁直述式视觉描述专家',
  Descriptive_Casual: '口语化图像描述专家',
  Art_Critic: '艺术评论写作专家',
  Product_Listing: '商品图文案专家',
  Social_Media_Post: '社交媒体配文专家',
};

const STYLE_ZH: Record<string, string> = {
  Straightforward:
    '以主体与媒介起笔；用肯定语气写清关键人物/物体/场景及颜色、形状、质感、空间关系与互动；不写情绪臆测；画面文字照录；有水印/签名/压缩痕迹则注明；勿以「这是一张…」开头。',
  Descriptive_Casual:
    '语气轻松口语化，像向朋友介绍画面；仍只写可见事实，不编造。',
  Art_Critic:
    '从构图、风格、象征、色彩与光影、可能的艺术流派等角度评论；可含审美判断，但须基于画面可见信息。',
  Product_Listing:
    '像电商商品详情描述：突出主体卖点、材质、颜色、规格感与使用场景（仅写图中可见者）。',
  Social_Media_Post:
    '像社交平台发帖配文：自然、有吸引力，仍忠实于画面内容。',
};

const BODY_ZH: Record<string, string> = {
  Straightforward:
    '根据当前图像输出简洁直述式中文描述：{style} 篇幅约 {wc} 字；最终仅一段连贯正文。禁止英文逗号分隔标签行、禁止 ComfyUI 关键词列表、禁止 Markdown 与思维链。',
  Descriptive_Casual:
    '根据当前图像用轻松口语写一段中文描述：{style} 篇幅约 {wc} 字；单段正文，禁止英文标签行与 Markdown。',
  Art_Critic:
    '根据当前图像写一段中文艺术评论：{style} 篇幅约 {wc} 字；单段正文，禁止提纲分点与 Markdown。',
  Product_Listing:
    '根据当前图像写一段中文商品文案：{style} 篇幅约 {wc} 字；单段或短条目式正文，禁止英文标签行。',
  Social_Media_Post:
    '根据当前图像写一段中文社交配文：{style} 篇幅约 {wc} 字；单段正文，禁止英文标签行。',
};

export function buildSystemPrompt(caption: any, media_target: string): string {
  const zh = isZhCaption(caption);
  const t = captionType(caption);
  const wc = resolveWordCountHint(caption);
  const mt = media_target || caption.media_target || 'image';
  const video = mt === 'video';
  const media = video ? (zh ? '视频画面' : 'video') : zh ? '图像' : 'image';

  if (zh) {
    const role = ROLE_ZH[t] || '图像描述专家';
    const style = STYLE_ZH[t] || '客观描写可见事实。';
    return (
      `你是${role}。针对当前${media}输出简体中文连贯正文（约 ${wc} 字，可多句）。${style}` +
      ' 禁止英文 comma-separated tags、禁止 ComfyUI 一行标签、禁止 Markdown 标题与思维链；画面内可见中文照录。' +
      ComfyuiPE.buildFaithfulReproductionBlock(caption, media_target)
    );
  }

  return ComfyuiPE.buildExpertSystemPrefix(caption, media_target);
}

export function buildOutputConstraints(caption: any): string {
  if (!isZhCaption(caption)) return '';
  return ' 【输出契约】仅一段简体中文正文（可多句）；禁止英文逗号分隔关键词列表；禁止 Markdown、自检标题与思维链。';
}

export function buildUserTaskLead(caption: any, media_target: string): string {
  const zh = isZhCaption(caption);
  const t = captionType(caption);
  const wc = resolveWordCountHint(caption);
  const mt = media_target || caption.media_target || 'image';
  const video = mt === 'video';

  if (zh) {
    const media = video ? '视频画面' : '图像';
    const roleHint = ROLE_ZH[t] || '描述';
    return `请观察当前${media}，按系统提示输出约 ${wc} 字的${roleHint}中文正文。`;
  }

  return ComfyuiPE.buildUserTaskFaithfulLead(caption);
}

export function buildUserTaskBody(caption: any): string | null {
  if (!isZhCaption(caption)) return null;
  const t = captionType(caption);
  const template = BODY_ZH[t];
  if (!template) return null;
  const wc = resolveWordCountHint(caption);
  const style = STYLE_ZH[t] || '';
  return template.replace('{wc}', wc).replace('{style}', style);
}

export function buildUserTailAddon(caption: any): string {
  if (!isZhCaption(caption)) {
    return ComfyuiPE.buildUserTailAddon(caption);
  }
  return ' 输出前确认：全文为简体中文连贯段落；无英文逗号标签行；无 Markdown/分节标题；勿复述提示示例。';
}

export { sanitizeProseOutput };