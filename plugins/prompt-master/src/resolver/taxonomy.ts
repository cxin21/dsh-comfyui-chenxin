// 提示词分类法 — 1:1 移植 PromptMaster config/promptEngineeringTaxonomy.js

import { OutputFormat, PEProfile } from './types.js';

interface FormatDef {
  id: OutputFormat;
  label: string;
  kinds: string[];
}

export const OUTPUT_FORMATS: FormatDef[] = [
  { id: 'prose' as OutputFormat,          label: '自然语言',        kinds: ['expand', 'reverse', 'train'] },
  { id: 'sd_tags' as OutputFormat,        label: 'SD 标签列表',    kinds: ['expand', 'reverse', 'train'] },
  { id: 'danbooru_tags' as OutputFormat,  label: 'Danbooru 标签',  kinds: ['expand', 'reverse', 'train'] },
  { id: 'structured_md' as OutputFormat,  label: '结构化 Markdown', kinds: ['expand', 'reverse'] },
  { id: 'structured_json' as OutputFormat,label: '结构化 JSON',    kinds: ['expand', 'reverse'] },
  { id: 'minimax' as OutputFormat,        label: 'MiniMax H3',      kinds: ['expand'] },
];

export const SUBJECT_DOMAINS = [
  { id: 'general',      label: '通用' },
  { id: 'portrait',     label: '人物' },
  { id: 'landscape',    label: '风景' },
  { id: 'architecture', label: '建筑' },
  { id: 'animal',       label: '动物' },
  { id: 'product',      label: '产品' },
  { id: 'still_life',   label: '静物' },
];

export const ALL_SUBJECT_DOMAIN_IDS = SUBJECT_DOMAINS.map(d => d.id);

const EXPAND_FORMAT_MAP: Record<string, OutputFormat> = {
  expand_natural: 'prose',
  expand_compact: 'sd_tags',
  expand_cinematic: 'sd_tags',
  expand_danbooru: 'danbooru_tags',
  expand_photographer: 'prose',
  expand_descriptive_en: 'prose',
  expand_structured_md: 'structured_md',
  expand_structured_json: 'structured_json',
};

const REVERSE_FORMAT_MAP: Record<string, OutputFormat> = {
  Descriptive: 'prose',
  Descriptive_Casual: 'prose',
  Straightforward: 'prose',
  Stable_Diffusion_Prompt: 'sd_tags',
  MidJourney: 'sd_tags',
  Danbooru_tag_list: 'danbooru_tags',
  e621_tag_list: 'danbooru_tags',
  Rule34_tag_list: 'danbooru_tags',
  Booru_tag_list: 'danbooru_tags',
  Art_Critic: 'prose',
  Product_Listing: 'prose',
  Social_Media_Post: 'prose',
};

const TORII_FORMAT_MAP: Record<string, OutputFormat> = {
  long_thoughts_v2: 'structured_md',
  long_thoughts: 'structured_md',
  min_structured_md: 'structured_md',
  min_structured_md_body: 'structured_md',
  md_comic: 'structured_md',
  json: 'structured_json',
  min_structured_json: 'structured_json',
  json_comic: 'structured_json',
  long: 'prose',
  short: 'prose',
};

export const EXPAND_TAGS: Record<string, string[]> = {
  expand_natural: ['扩写', '自然语言', '通用'],
  expand_compact: ['扩写', 'SD', '简洁'],
  expand_cinematic: ['扩写', '电影感', 'SD'],
  expand_danbooru: ['扩写', 'Danbooru'],
  expand_photographer: ['扩写', '摄影', '自然语言'],
  expand_descriptive_en: ['扩写', '英文', '自然语言'],
  expand_structured_md: ['扩写', '结构化', 'Markdown'],
  expand_structured_json: ['扩写', '结构化', 'JSON'],
};

export const REVERSE_TAGS: Record<string, string[]> = {
  Descriptive: ['五点结构', '极致还原', '自然语言'],
  Descriptive_Casual: ['口语化', '自然语言'],
  Straightforward: ['直述', '自然语言'],
  Stable_Diffusion_Prompt: ['ComfyUI', 'SD', '还原检查表'],
  MidJourney: ['MidJourney', '关键词'],
  Danbooru_tag_list: ['Danbooru', '标准前缀'],
  e621_tag_list: ['e621', '兽系'],
  Rule34_tag_list: ['Rule34', 'Booru'],
  Booru_tag_list: ['Booru', '标签'],
  Art_Critic: ['艺术评论', '自然语言'],
  Product_Listing: ['商品', '自然语言'],
  Social_Media_Post: ['社媒', '自然语言'],
};

export function inferOutputFormat(profile: PEProfile): OutputFormat {
  const explicit = String(profile.outputFormat || '').trim() as OutputFormat;
  if (OUTPUT_FORMATS.some(f => f.id === explicit)) return explicit;

  const id = String(profile.id || '');
  const isTorii = profile.toriiFormat || id.startsWith('pe_torii_') || id.startsWith('pe_train_torii_');
  if (isTorii) {
    const key = profile.builtinKey || id.replace(/^pe_(train_)?torii_/, '');
    return TORII_FORMAT_MAP[key] || 'structured_md';
  }

  const bk = String(profile.builtinKey || '').trim();
  if (profile.kind === 'expand') return EXPAND_FORMAT_MAP[bk] || 'prose';
  if (profile.kind === 'reverse' || profile.kind === 'train') return REVERSE_FORMAT_MAP[bk] || 'prose';
  return 'prose';
}

export function inferTags(profile: PEProfile): string[] {
  if (Array.isArray(profile.tags) && profile.tags.length) {
    return profile.tags.map(t => String(t).trim()).filter(Boolean);
  }

  const id = String(profile.id || '');
  const isTorii = profile.toriiFormat || id.startsWith('pe_torii_') || id.startsWith('pe_train_torii_');
  if (isTorii) {
    const key = profile.builtinKey || id.replace(/^pe_(train_)?torii_/, '');
    const fmt = TORII_FORMAT_MAP[key] || 'structured_md';
    if (fmt === 'structured_json') return ['结构化', 'JSON'];
    if (fmt === 'prose') return ['结构化', '自然语言'];
    return ['结构化', 'Markdown'];
  }

  const bk = String(profile.builtinKey || '').trim();
  if (profile.kind === 'expand') return EXPAND_TAGS[bk] || ['扩写'];
  if (profile.kind === 'reverse' || profile.kind === 'train') {
    return REVERSE_TAGS[bk] || (profile.kind === 'train' ? ['训练打标'] : ['反推']);
  }
  return [];
}

export function inferSubjectDomains(profile: PEProfile): string[] {
  if (Array.isArray(profile.subjectDomains) && profile.subjectDomains.length) {
    const set = new Set(ALL_SUBJECT_DOMAIN_IDS);
    const out = profile.subjectDomains.filter(id => set.has(id));
    if (out.length) return out;
  }
  return ['general'];
}

export function enrichProfileTaxonomy(p: PEProfile): PEProfile {
  return {
    ...p,
    outputFormat: inferOutputFormat(p),
    tags: inferTags(p),
    subjectDomains: inferSubjectDomains(p),
  };
}

export function outputFormatsForKind(kind: string): FormatDef[] {
  return OUTPUT_FORMATS.filter((f) => !kind || f.kinds.includes(kind));
}

export function outputFormatLabel(id: string): string {
  return OUTPUT_FORMATS.find((f) => f.id === id)?.label || id || '';
}

export function subjectDomainLabel(id: string): string {
  return SUBJECT_DOMAINS.find((d) => d.id === id)?.label || id || '';
}

export function profileMatchesSubjectDomain(profile: PEProfile, subjectDomain: string): boolean {
  const key = String(subjectDomain || '').trim();
  if (!key) return true;
  const domains = inferSubjectDomains(profile);
  return domains.includes(key) || domains.includes('general');
}

/** 训练打标已移除结构化 Markdown Torii 工程 */
export function isTrainStructuredMdProfile(profile: PEProfile): boolean {
  if (!profile || profile.kind !== 'train') return false;
  const id = String(profile.id || '');
  if (id.startsWith('pe_train_torii_')) return true;
  if (profile.structuredFormat || profile.toriiFormat) {
    const key = (profile as any).builtinKey || id.replace(/^pe_train_torii_/, '');
    const fmt = (profile as any).outputFormat || inferOutputFormat(profile);
    return fmt === 'structured_md';
  }
  return inferOutputFormat(profile) === 'structured_md';
}

export function getTaxonomyMeta() {
  return { outputFormats: OUTPUT_FORMATS, subjectDomains: SUBJECT_DOMAINS };
}