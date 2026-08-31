// Tag 行后处理 — 1:1 移植自 PromptMaster config/tagLineSanitize.js
// 反推 tag 行后处理：剥离 [tag] 方括号、十六进制色值碎片、孤立数字等。
// Danbooru / SD / ComfyUI：均保留短语内空格（如 long hair）；勿压成 long_hair / woman_xxx 长串。
// 纯字符串逻辑，无 Electron 依赖。

const COUNT_TAG_RE = /^\d+(?:girl|girls|boy|boys|other|others)$/i;

export function isDanbooruCaption(caption: any): boolean {
  return caption && (caption.type || '') === 'Danbooru_tag_list';
}

export function isCountTag(t: string): boolean {
  return COUNT_TAG_RE.test(String(t || '').trim());
}

/** 纯十六进制或「数字+十六进制」泄漏（如 1f1f3b、1f1f3b1f1f3b、2） */
export function isHexGarbageToken(t: string): boolean {
  const s = String(t || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return true;
  if (/^(artist|copyright|character|meta|score_):/.test(s)) return false;
  if (isCountTag(s)) return false;
  if (/^\d+$/.test(s)) return true;
  if (/^[0-9a-f]{6,}$/i.test(s)) return true;
  if (/^\d+[0-9a-f]{4,}$/i.test(s)) return true;
  return false;
}

function normalizeBooruValue(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeToken(raw: string, danbooru: boolean): string {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (/^(artist|copyright|character|meta):/i.test(t)) {
    const idx = t.indexOf(':');
    return t.slice(0, idx + 1).toLowerCase() + normalizeBooruValue(t.slice(idx + 1));
  }
  if (danbooru) {
    return normalizeBooruValue(t.replace(/_/g, ' '));
  }
  return t
    .toLowerCase()
    .replace(/\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bracketInnerToTag(inner: string, danbooru: boolean): string {
  const raw = String(inner || '').trim();
  if (!raw) return '';
  if (/^(artist|copyright|character|meta):/i.test(raw)) {
    const idx = raw.indexOf(':');
    return raw.slice(0, idx + 1).toLowerCase() + normalizeBooruValue(raw.slice(idx + 1));
  }
  return normalizeToken(raw, danbooru);
}

/** 仅把「数字/十六进制垃圾」串按空格拆开，勿拆 best quality、anime screenshot 等多词 tag */
function splitLooseTokens(chunk: string): string[] {
  const c = String(chunk || '').trim();
  if (!c) return [];
  if (/^(?:\d+|[0-9a-f]{4,})(?:\s+(?:\d+|[0-9a-f]{4,}))+$/i.test(c)) {
    return c.split(/\s+/).map((w) => w.trim()).filter(Boolean);
  }
  return [c];
}

function dedupeTokens(parts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export function unwrapBracketNotation(text: string, danbooru: boolean): string {
  const s = String(text || '').trim();
  if (!/\[[^\]]+\]/.test(s)) return s;

  const bracketParts: string[] = [];
  const re = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const tag = bracketInnerToTag(m[1], danbooru);
    if (tag && !isHexGarbageToken(tag)) bracketParts.push(tag);
  }

  const remainder = s.replace(re, ' ').replace(/\s+/g, ' ').trim();
  const remParts: string[] = [];
  if (remainder) {
    for (const chunk of remainder.split(/[,，]+/)) {
      for (const raw of splitLooseTokens(chunk)) {
        const tag = normalizeToken(raw, danbooru);
        if (tag && !isHexGarbageToken(tag)) remParts.push(tag);
      }
    }
  }

  return dedupeTokens([...remParts, ...bracketParts]).join(', ');
}

function tokenKey(t: string, danbooru: boolean): string {
  return String(t || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function qualityPrefixTokenSet(caption: any): Set<string> | null {
  const prefix = String(
    caption && caption.quality_prompt_prefix != null ? caption.quality_prompt_prefix : ''
  ).trim();
  if (!prefix) return null;
  const danbooru = isDanbooruCaption(caption);
  const set = new Set<string>();
  for (const t of prefix.split(/[,，]\s*/)) {
    const k = tokenKey(t, danbooru);
    if (k) set.add(k);
  }
  return set.size ? set : null;
}

function useQualityPrefix(caption: any): boolean {
  if (!caption) return false;
  const v = caption.quality_prompt_enabled;
  return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * @param text 原始 tag 行
 * @param caption 可选；用于去掉与质量前缀重复的 tag
 */
export function cleanTagLineBody(text: string, caption?: any): string {
  let s = String(text || '').trim();
  if (!s) return s;

  const danbooru = isDanbooruCaption(caption);

  if (/\[[^\]]+\]/.test(s)) {
    s = unwrapBracketNotation(s, danbooru);
  }

  const parts: string[] = [];
  for (const chunk of s.split(/[,，]+/)) {
    for (const raw of splitLooseTokens(chunk)) {
      const tag = normalizeToken(raw, danbooru);
      if (tag && !isHexGarbageToken(tag)) parts.push(tag);
    }
  }

  let out = dedupeTokens(parts);

  if (caption && useQualityPrefix(caption)) {
    const qset = qualityPrefixTokenSet(caption);
    if (qset) {
      out = out.filter((t) => !qset.has(tokenKey(t, danbooru)));
    }
  }

  return out.join(', ');
}
