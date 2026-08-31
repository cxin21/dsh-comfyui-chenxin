// Danbooru 标签列表反推 — 1:1 移植自 PM danbooruPromptEngineering.js

import { resolveDanbooruLenHint } from './length.js';

const DANBOORU_TYPE = 'Danbooru_tag_list';

export function applies(caption: any): boolean {
  return (caption.type || '') === DANBOORU_TYPE;
}

function isZhCaption(caption: any): boolean {
  return (caption.caption_lang || 'en') === 'zh';
}

export function buildSystemPrompt(caption: any, media_target: string): string {
  const video = (media_target || caption.media_target || 'image') === 'video';
  if (!isZhCaption(caption)) {
    const media = video ? 'video key frame' : 'image';
    return (
      ' You are a Danbooru-style TAG LIST annotator for this ' +
      media +
      '. Your entire reply MUST be exactly ONE line of comma-separated English tags—never sentences, never paragraphs, never JSON, never main_text.' +
      ' Format: artist:unknown, copyright:original, character:none, meta:none, 1girl, solo, long hair, blue eyes, white shirt, outdoors' +
      ' Rules: lowercase; comma+space between tags; spaces inside multi-word tags (long hair)—NOT underscores; order artist:/copyright:/character:/meta: then general tags.' +
      ' Include counts (1girl), appearance, clothing, pose, expression, background. Visible facts only.'
    );
  }
  const media = video ? '视频关键帧' : '图像';
  return (
    ' 你是 Danbooru 标签标注专家，须为当前' +
    media +
    '输出可直接用于动漫类图库检索与 LoRA/SD 训练的英文标签。' +
    ' 【标签规则】仅一行；英文小写；逗号+空格分隔；短语内用空格连接多词（如 long hair, brown hair, looking at viewer），勿用 long_hair 式下划线。' +
    ' 严格顺序：artist:、copyright:、character:、meta:（若有）→ 通用标签。' +
    ' 通用标签须覆盖：人数(1girl/1boy等)、外观、发型、服装、配饰、姿态、表情、动作、背景、镜头景别、风格媒介。' +
    ' 只写画面中可见事实；禁止叙事句、禁止 Markdown、禁止中文（角色名等专有名词可用英文或罗马音）。' +
    ' 不确定的 artist/copyright 用 artist:unknown、copyright:original；无角色用 character:none。' +
    ' 禁止输出自检、分析或小标题，只输出一行 tag。' +
    ' 禁止用方括号包裹标签（勿写 [girl]、[black hair]，应写 1girl, black hair）。'
  );
}

export function buildOutputConstraints(caption: any): string {
  if (!isZhCaption(caption)) {
    return ' [CONTRACT] Exactly one Danbooru tag line with required prefix tokens; no self-check, chain-of-thought, or markdown headings.';
  }
  return ' 【输出契约】有且仅有一行 Danbooru 标签；含必需前缀 token；禁止分步说明、思维链与 Markdown 标题。';
}

/** 模型泄漏自然语言 caption 时返回 true（非 tag 行） */
export function looksLikeTagProse(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^(artist|copyright|character|meta):/i.test(t)) return false;
  const commas = (t.match(/,/g) || []).length;
  if (commas >= 3 && /\b(1girl|1boy|solo|long hair|short hair)\b/i.test(t)) return false;
  if (
    /\b(she|he|they|the image|features a|stands|standing|wearing|dressed in|portrait of|a young)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\. [a-z]/.test(t)) return true;
  if (!t.includes(',') && t.length > 90) return true;
  return false;
}

export function buildTypeOutputAddon(caption: any): string {
  const zh = isZhCaption(caption);
  return zh
    ? ' 【Danbooru】直接输出一行标签正文，勿写分析过程。'
    : ' [Danbooru] ONE tag line only—NO sentences, NO JSON, NO main_text, NO analysis.';
}

export function buildUserTaskLead(caption: any, media_target: string): string {
  const video = (media_target || caption.media_target || 'image') === 'video';
  if (!isZhCaption(caption)) {
    return video
      ? 'List Danbooru-style tags for this video key frame as ONE line.'
      : 'List Danbooru-style tags for this image as ONE line.';
  }
  return video
    ? '请为当前视频画面输出一行 Danbooru 英文标签。'
    : '请为当前图像输出一行 Danbooru 英文标签。';
}

export function buildUserTaskBody(caption: any): string {
  const lenHint = resolveDanbooruLenHint(caption) || 'Keep tags complete but concise.';
  if (!isZhCaption(caption)) {
    const hintEn = /[\u4e00-\u9fff]/.test(lenHint)
      ? 'Include enough tags for appearance, clothing, pose, and background.'
      : lenHint;
    return `Start with artist:unknown, copyright:original, character:none, meta:none, then general tags. ${hintEn} Example shape: artist:unknown, copyright:original, character:none, meta:none, 1girl, solo, long hair, blue eyes, outdoors. Tags only—no sentences.`;
  }
  return `按 artist:/copyright:/character:/meta: 顺序，再写通用标签；${lenHint}仅一行，英文逗号+空格分隔（如 1girl, long hair, outdoors）。`;
}

export function buildUserTailAddon(caption: any): string {
  if (!isZhCaption(caption)) {
    return ' Output ONLY the tag line. Do NOT describe the image in prose.';
  }
  return ' 输出前确认：仅一行、全英文小写、短语内空格（勿下划线）、含前缀、无多余解释。';
}

export function sanitizeTagOutput(text: string): string {
  let s = String(text || '').trim();
  if (!s) return s;

  const lines = s.split(/\r?\n/).map((l) => l.replace(/^\*\*|\*\*$/g, '').trim());
  const isTagLine = (l: string) =>
    !!l &&
    !/^#{1,6}\s/.test(l) &&
    !/^(?:tags?|danbooru)\s*:/i.test(l) &&
    !/self[- ]?check|fidelity\s*analysis/i.test(l) &&
    !looksLikeTagProse(l) &&
    (/^(artist|copyright|character|meta):/i.test(l) ||
      ((l.match(/,/g) || []).length >= 2 &&
        /\b(1girl|1boy|solo|long hair|short hair)\b/i.test(l)));

  const line =
    lines.find(isTagLine) ||
    lines.find(
      (l) => !!l && /^(artist|copyright|character|meta):/i.test(l) && !looksLikeTagProse(l)
    );

  s = line || '';
  if (!s && lines[0] && !looksLikeTagProse(lines[0])) {
    s = lines[0];
  }
  s = s.replace(/^[`'"]+|[`'"]+$/g, '').trim();
  if (looksLikeTagProse(s)) return '';
  return s;
}