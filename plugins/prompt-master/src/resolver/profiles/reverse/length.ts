// 反推篇幅 — 1:1 移植自 PromptMaster config/captionLength.js
// 与扩写（promptExpandRules）共用 very_short / short / medium / long / very_long / custom
// 纯函数；PM 的 Settings 读取（readLocalTokenLimitsFromSettingsService）为 Electron 依赖，不移植，
// 默认 token 上限内联 DEFAULT_LOCAL_TOKEN_LIMITS.reverseMax = 1024（与 PM localTokenLimits.js 一致）。

import {
  resolveExpandLengthSpec,
  parseCustomCharCount,
  EXPAND_LENGTH_PRESETS,
} from '../expand-rules.js';

const DEFAULT_REVERSE_MAX = 1024;

const LEGACY_LEN_MAP: Record<string, string> = {
  'very short': 'very_short',
  very_short: 'very_short',
  short: 'short',
  'medium length': 'medium',
  medium: 'medium',
  long: 'long',
  'very long': 'very_long',
  any: 'medium',
};

const WORD_COUNT_RANGE: Record<string, string> = {
  very_short: '80以内',
  short: '80～150',
  medium: '150～300',
  long: '300～500',
  very_long: '500～800',
};

const TYPE_TOKEN_SCALE: Record<string, number> = {
  Descriptive: 1.25,
  Stable_Diffusion_Prompt: 1,
  Danbooru_tag_list: 0.75,
};

function capTokens(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** @returns {{ lenKey: string, lenChars: number|null }} */
export function normalizeCaptionLenKeys(caption: any): { lenKey: string; lenChars: number | null } {
  let len = caption.len == null || caption.len === '' ? 'medium' : String(caption.len).trim();
  const charsFromField = parseCustomCharCount(len, caption.caption_len_chars);

  if (charsFromField != null) {
    return { lenKey: 'custom', lenChars: charsFromField };
  }
  if (/^\d+$/.test(len)) {
    return { lenKey: 'custom', lenChars: parseInt(len, 10) };
  }
  if (len === 'custom') {
    return { lenKey: 'custom', lenChars: null };
  }
  const mapped = LEGACY_LEN_MAP[len] || (EXPAND_LENGTH_PRESETS[len] ? len : 'medium');
  return { lenKey: mapped, lenChars: null };
}

export function resolveCaptionLengthSpec(caption: any): any {
  const { lenKey, lenChars } = normalizeCaptionLenKeys(caption);
  const lang = caption.caption_lang || 'zh';
  const spec = resolveExpandLengthSpec(lenKey, lenChars ?? undefined, lang);
  return { ...spec, lenKey };
}

export function resolveCaptionLengthLabel(caption: any): string {
  const spec = resolveCaptionLengthSpec(caption);
  if (spec.custom && spec.chars != null) {
    return String(spec.chars);
  }
  return WORD_COUNT_RANGE[spec.lenKey] || WORD_COUNT_RANGE.medium;
}

export function resolveCaptionWordCountHint(caption: any): string {
  return resolveCaptionLengthLabel(caption);
}

function buildCaptionLengthHint(caption: any): string {
  const spec = resolveCaptionLengthSpec(caption);
  const zh = (caption.caption_lang || 'en') === 'zh';
  return zh ? spec.hintZh : spec.hintEn;
}

export function buildCaptionLengthBlock(caption: any): string {
  const hint = buildCaptionLengthHint(caption);
  const zh = (caption.caption_lang || 'en') === 'zh';
  return `\n\n【${zh ? '篇幅' : 'Length'}】${hint}`;
}

export function resolveReverseMaxCap(limits: any): number {
  const n = limits && limits.reverseMax;
  if (n == null || Number.isNaN(Number(n))) {
    return DEFAULT_REVERSE_MAX;
  }
  return Number(n);
}

export function resolveCaptionMaxNewTokens(caption: any, limits?: any): number {
  const reverseMax = resolveReverseMaxCap(limits);
  const type = caption.type || 'Stable_Diffusion_Prompt';
  const spec = resolveCaptionLengthSpec(caption);
  const scale = TYPE_TOKEN_SCALE[type] || 1;

  if (spec.custom && spec.chars != null) {
    const n = spec.chars;
    if (type === 'Descriptive') return capTokens(Math.ceil(n * 2.2), 256, reverseMax);
    if (type === 'Danbooru_tag_list') {
      return capTokens(Math.ceil(n * 1.6), 192, Math.min(512, reverseMax));
    }
    return capTokens(Math.ceil(n * 1.8), 128, Math.min(768, reverseMax));
  }

  return capTokens(Math.ceil(spec.maxTokens * scale), 128, reverseMax);
}

export function resolveAnima3TagCountBand(caption: any): { band: string; tier: string } {
  const spec = resolveCaptionLengthSpec(caption);
  if (spec.custom && spec.chars != null) {
    const n = Math.min(80, Math.max(16, Math.round(spec.chars / 10)));
    return { band: String(n), tier: 'custom' };
  }
  const map: Record<string, { band: string; tier: string }> = {
    very_short: { band: '10-18', tier: 'minimal' },
    short: { band: '16-30', tier: 'simple' },
    medium: { band: '22-38', tier: 'standard' },
    long: { band: '30-48', tier: 'complex' },
    very_long: { band: '36-55', tier: 'complex' },
  };
  return map[spec.lenKey] || map.medium;
}

export function resolveDanbooruLenHint(caption: any): string {
  const spec = resolveCaptionLengthSpec(caption);
  const zh = (caption.caption_lang || 'en') === 'zh';
  if (spec.custom && spec.chars != null) {
    return zh
      ? `标签总量约 ${spec.chars} 个以内，仍须一行逗号分隔。`
      : `About ${spec.chars} tags max, still one comma-separated line.`;
  }
  const preset = EXPAND_LENGTH_PRESETS[spec.lenKey];
  if (!preset) {
    return '';
  }
  const band: Record<string, string> = {
    very_short: zh ? '约 8～15 个 tag' : 'about 8–15 tags',
    short: zh ? '约 15～25 个 tag' : 'about 15–25 tags',
    medium: zh ? '约 25～40 个 tag' : 'about 25–40 tags',
    long: zh ? '约 35～55 个 tag' : 'about 35–55 tags',
    very_long: zh ? '约 45～70 个 tag' : 'about 45–70 tags',
  };
  return zh
    ? `标签量 ${band[spec.lenKey] || band.medium}，仍须一行输出。`
    : `Tag count ${band[spec.lenKey] || band.medium}, one line only.`;
}
