// Torii Gate-0.5 结构化格式定义 — 1:1 移植自 PM toriiGateFormats.js

export interface ToriiGateFormat {
  cType: string;
  name: string;
  description: string;
  category: string;
  useNamesDefault: boolean;
  extractMode: string;
  cTypeRuntime?: string;
  sort: number;
}

export const TORII_OUTPUT_FORMAT_BY_CTYPE: Record<string, string> = {
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

export const ALL_SUBJECT_DOMAIN_IDS = [
  'general', 'portrait', 'landscape', 'architecture',
  'animal', 'product', 'still_life',
];

export const TORII_GATE_FORMATS: ToriiGateFormat[] = [
  {
    cType: 'long_thoughts_v2',
    name: '结构化 MD · 四段详述',
    description: '4 段 Markdown：① 角色思考 ② Key details ③ Long description ④ 分角色详述（## 角色名）。',
    category: '详细结构化',
    useNamesDefault: true,
    extractMode: 'full',
    sort: 110,
  },
  {
    cType: 'long_thoughts',
    name: '结构化 MD · 六段完整式',
    description: '6 段 Markdown：① 思考 ② General description ③ 分角色 ④ Individual Parts ⑤ Texts on image ⑥ Background and effects。',
    category: '详细结构化',
    useNamesDefault: true,
    extractMode: 'full',
    sort: 120,
  },
  {
    cType: 'min_structured_md',
    name: '结构化 MD · 极简三段',
    description: '短结构化 Markdown；含前两段推理，成品提示词请用「仅结构化正文」变体或自行去掉 §1–2。',
    category: '即用提示词',
    useNamesDefault: true,
    extractMode: 'full',
    sort: 140,
  },
  {
    cType: 'min_structured_md_body',
    name: '结构化 MD · 仅正文三段',
    description: '同 min_structured_md，自动去掉 §1 Thoughts 与 §2 Key details。',
    category: '即用提示词',
    useNamesDefault: true,
    extractMode: 'min_md_body',
    cTypeRuntime: 'min_structured_md',
    sort: 145,
  },
  {
    cType: 'min_structured_json',
    name: '结构化 JSON · 极简键值',
    description: '按角色/General 等键的 JSON。',
    category: '即用提示词',
    useNamesDefault: false,
    extractMode: 'json_raw',
    sort: 150,
  },
  {
    cType: 'json',
    name: '结构化 JSON · 标准字段',
    description: 'character/background/atmosphere 等字段。',
    category: '即用提示词',
    useNamesDefault: false,
    extractMode: 'json_raw',
    sort: 160,
  },
  {
    cType: 'long',
    name: '自然语言 · 多段长描述',
    description: '2–5 段自然语言长描述，无 Markdown 结构。',
    category: 'Legacy',
    useNamesDefault: false,
    extractMode: 'full',
    sort: 170,
  },
  {
    cType: 'short',
    name: '自然语言 · 短描述',
    description: '简短扼要，覆盖主要对象与细节。',
    category: 'Legacy',
    useNamesDefault: false,
    extractMode: 'full',
    sort: 180,
  },
  {
    cType: 'md_comic',
    name: '结构化 MD · 漫画分镜',
    description: '漫画/分镜专用 Markdown。',
    category: '漫画',
    useNamesDefault: true,
    extractMode: 'full',
    sort: 190,
  },
  {
    cType: 'json_comic',
    name: '结构化 JSON · 漫画分帧',
    description: '按帧与角色的 JSON 漫画描述。',
    category: '漫画',
    useNamesDefault: false,
    extractMode: 'json_raw',
    sort: 200,
  },
];

export function buildToriiReverseProfiles(): any[] {
  const now = Date.now();
  return TORII_GATE_FORMATS.map((f, i) => ({
    id: `pe_torii_${f.cType.replace(/[^a-z0-9]+/gi, '_')}`,
    kind: 'reverse',
    builtin: true,
    structuredFormat: true,
    toriiFormat: true,
    builtinKey: f.cTypeRuntime || f.cType,
    toriiExtractMode: f.extractMode,
    toriiUseNamesDefault: f.useNamesDefault,
    name: f.name,
    category: `结构化 / ${f.category}`,
    description: f.description,
    enabled: true,
    sort: f.sort != null ? f.sort : (i + 1) * 10 + 100,
    outputFormat: TORII_OUTPUT_FORMAT_BY_CTYPE[f.cType] || 'structured_md',
    tags: ['结构化', f.category].filter(Boolean),
    subjectDomains: ALL_SUBJECT_DOMAIN_IDS,
    createdAt: now,
    updatedAt: now,
  }));
}

export function isStructuredReverseProfileId(profileId: string): boolean {
  const id = String(profileId || '');
  return id.startsWith('pe_torii_') || id.startsWith('pe_expand_torii_');
}

export function isStructuredTemplateProfile(profile: any): boolean {
  return !!(
    profile &&
    (profile.structuredFormat ||
      profile.toriiFormat ||
      isStructuredReverseProfileId(profile.id))
  );
}