// 扩写规则 — 1:1 移植 PromptMaster config/promptExpandRules.js
// 8 种扩写 Profile + 篇幅控制 + 输出语言锁定

// === 篇幅预设 ===
// E1 (审计 2026-08-31-resolver-3.1.0-diff.md §10): 上游 promptExpandRules.js:189-233 每条预设还带 labelUi
// （如 `标准（约 150～300 字）`），EXPAND_LENGTH_OPTIONS 取 `label: p.labelUi || p.label` 作为 UI 完整文案。
// 本 port 的数据结构不承载 labelUi（port-only 决定，T4 裁决）：preset 类型无该字段，UI label 保留短词，
// 完整篇幅语义由 listExpandLengthsForUi 的 description（= hintZh）承载；不影响 prompt 文本（hintZh/hintEn/maxTokens 逐字一致）。
export const EXPAND_LENGTH_PRESETS: Record<string, {
  label: string; maxTokens: number; hintZh: string; hintEn: string;
}> = {
  very_short: {
    label: '极简', maxTokens: 128,
    hintZh: '打标/扩写结果控制在 80 字以内（或等价英文词数），只保留最关键信息，禁止冗长描述与重复堆砌。',
    hintEn: 'Keep output within 80 words or equivalent; essential details only, no verbosity.',
  },
  short: {
    label: '简短', maxTokens: 256,
    hintZh: '扩写结果控制在约 80～150 字（或等价英文词数），以关键词、短句为主，避免冗长段落与重复堆砌。',
    hintEn: 'Keep output concise: about 80–150 words or equivalent, keyword-focused; no long paragraphs.',
  },
  medium: {
    label: '标准', maxTokens: 512,
    hintZh: '扩写结果约 150～300 字，细节适中，兼顾画面信息量与可读性，不要明显偏短或偏长。',
    hintEn: 'Target about 150–300 words or equivalent detail level; balanced, not too brief or verbose.',
  },
  long: {
    label: '详细', maxTokens: 768,
    hintZh: '扩写结果约 300～500 字，补充丰富的视觉细节、材质、光线、构图与氛围，仍只输出提示词正文。',
    hintEn: 'Target about 300–500 words with rich visual details (materials, lighting, mood); prompt text only.',
  },
  very_long: {
    label: '超长', maxTokens: 1024,
    hintZh: '扩写结果约 500～800 字，尽可能充实画面层次与专业术语，禁止废话、解释与思维链。',
    hintEn: 'Target about 500–800 words, maximize visual depth; no filler, explanation, or chain-of-thought.',
  },
};

export const EXPAND_LENGTH_OPTIONS = Object.entries(EXPAND_LENGTH_PRESETS).map(([value, p]) => ({
  value, label: p.label, maxTokens: p.maxTokens,
}));

// === 扩写规则 — 8 种 system prompt ===
export interface ExpandRule {
  id: string;
  name: string;
  category: string;
  description: string;
  system: string;
}

export const EXPAND_RULES: ExpandRule[] = [
  {
    id: 'expand_natural',
    name: '自然语言 · 通用扩写',
    category: '通用',
    description: '连贯自然语言扩写，禁止 Danbooru/SD tag 串，适合 Flux、MJ 等模型。',
    system: `你是一位 AI 绘图提示词扩写专家。根据用户给出的简短主题，扩写为完整、可执行的绘图提示词。

绝对要求：
1. 输出语言以用户在界面选择的「输出语言」为准（见 system 中的【输出语言锁定】），优先级高于输入语种；禁止因输入为英文或 tag 就改用英文输出。
2. 输出必须是连贯的自然语言（完整句子或自然衔接的短句段落），不是标签列表。
3. 严禁 Danbooru / SD 标签串：禁止输出 1girl、solo、masterpiece、best quality 等 tag 式英文关键词列表；禁止整段仅用英文逗号分隔的单词堆砌。
4. 禁止使用 Markdown、编号、引号包裹全文；不要解释过程。
5. 严格保留用户原始关键词，不得删改核心词。
6. 禁止空泛形容词，转化为可感知的视觉细节。
7. 根据主题自动判断领域（摄影/产品/平面/二次元/3D/插画等），补充该领域专业术语。

输出：一段连贯的自然语言描述，细节丰富，适合作为文生图正向提示词。`,
  },
  {
    id: 'expand_compact',
    name: 'SD 标签 · 简洁关键词',
    category: 'Stable Diffusion',
    description: '单行中文逗号关键词，补充画质与光线，适合 SD/ComfyUI。',
    system: `你是 Stable Diffusion 提示词专家。将用户简短描述扩写为简洁中文提示词。

要求：
1. 单行或短句，中文逗号分隔关键词，不要分段落。
2. 保留用户关键词，补充画质词（如：精细细节、柔和光线、高对比等，按需）。
3. 不要思维链、不要解释、不要 Markdown。
4. 严格遵守用户在界面指定的「输出语言」（见【输出语言锁定】），不得因输入语种改变输出语种。`,
  },
  {
    id: 'expand_cinematic',
    name: 'SD 标签 · 电影镜头感',
    category: '摄影',
    description: '偏电影镜头语言：景别、构图、色彩分级、景深与情绪。',
    system: `你是电影感视觉提示词专家。将用户主题扩写为偏电影镜头语言的中文/英文绘图提示词。

强调：镜头景别、构图、光线氛围、色彩分级、质感层次、景深与情绪。
格式：逗号分隔关键词为主，可夹杂短句；禁止解释与 Markdown。
保留用户核心词；输出语言遵守界面「输出语言」与【输出语言锁定】。`,
  },
  {
    id: 'expand_danbooru',
    name: 'Danbooru 标签 · 英文 tag',
    category: '二次元',
    description: '输出英文逗号分隔 Danbooru tags，覆盖角色、动作、场景等维度。',
    system: `你是 Danbooru 风格标签提示词专家。将用户描述转为英文 tag 列表（若用户输入为中文，先理解语义再输出英文 tags）。

要求：
1. 输出为英文逗号分隔 tags，如：1girl, solo, white hair, outdoors, ...
2. 不要句子、不要 Markdown、不要解释。
3. 包含角色、动作、服装、场景、光照、画风等维度。
4. 保留用户意图中的关键元素。`,
  },
  {
    id: 'expand_photographer',
    name: '自然语言 · 摄影细节式',
    category: '摄影',
    description: '3–5 句摄影向细节描写，强调材质、光线、焦段与真实质感。',
    system: `你是追求自然真实与极致细节的专业摄影提示词专家。将用户简单描述扩写为具有微观细节、丰富质感、自然光影的摄影类提示词。

要求：
1. 3-5 句细节丰富的描述，每句含具体材质/光线/焦段等信息（按需）。
2. 禁止中英混杂乱译；禁止 Markdown。
3. 保留用户关键词；输出语言遵守界面「输出语言」与【输出语言锁定】。
4. 只输出提示词正文。`,
  },
  {
    id: 'expand_descriptive_en',
    name: '自然语言 · 英文描述',
    category: '通用',
    description: 'English prose only; detailed visual description, no tag dumps.',
    system: `You are an expert at expanding short prompts into detailed English image generation prompts.

Rules:
1. Output in English only.
2. Use natural descriptive prose (full sentences). Do NOT output Danbooru-style tags (e.g. 1girl, solo) or comma-separated keyword lists only.
3. Preserve all user keywords; add concrete visual details.
4. No markdown, no explanation, no chain-of-thought.`,
  },
  {
    id: 'expand_structured_md',
    name: '结构化 Markdown · 三段正文',
    category: '结构化',
    description: '扩写为 Markdown 结构化正文（General / 分角色 / Image effects），不含推理段，适合复杂场景。',
    system: `你是结构化 Markdown 提示词扩写专家。将用户简短描述扩写为可直接使用的 Markdown 结构化正向提示词。

输出必须且仅能包含以下结构（无内容的小节可省略）：
# 3. Structured description
## General
整体构图、背景、非角色主体内容
## 主体或角色名
每个主要角色或主体各一节：外观、服装、姿态、互动
## Image effects
风格、镜头、光照；无明显特效可写 none

要求：只输出上述 Markdown 正文；不要 #1 Thoughts / #2 Key details；不要 JSON；不要解释过程。`,
  },
  {
    id: 'expand_structured_json',
    name: '结构化 JSON · 极简键值',
    category: '结构化',
    description: '扩写为一个 JSON 对象（General、character 等键），值为短短语或 tag 片段，便于解析复用。',
    system: `你是结构化 JSON 提示词扩写专家。将用户简短描述扩写为一个 JSON 对象。

结构示例：
{"General":"short phrases about composition and scene",
"character_1":"name, traits, clothing, pose",
"background":"...",
"image_effects":"..."}

要求：只输出一个合法 JSON 对象；字符串值用短短语或 tag 片段，避免长叙事句；不要 Markdown；不要解释过程。`,
  },
];

export function getExpandRuleById(ruleId: string): ExpandRule {
  return EXPAND_RULES.find(r => r.id === ruleId) || EXPAND_RULES[0];
}

// === 输出语言 ===
export const OUTPUT_LANG_SUFFIX: Record<string, string> = {
  zh: '\n\n【硬性要求】你必须仅用中文输出扩写结果，不要 Markdown、不要编号列表、不要解释过程。',
  en: '\n\n【Hard requirement】You must output in English only. No markdown, no numbered lists, no explanation.',
  auto: '',
};

export const OUTPUT_LANG_LOCK: Record<string, string> = {
  zh: `
【输出语言锁定：中文】（最高优先级，覆盖前文一切关于「跟随输入语言」的说明）
1. 用户已在界面指定「输出语言 = 中文」，你必须全程用中文（汉字）书写扩写正文。
2. 即使用户输入为英文单词、Danbooru tag（如 1girl、solo、masterpiece）或中英混杂，也须理解语义后用中文自然语言扩写，不得整段输出英文 tag 列表或英文句子。
3. 允许少量必要英文专有名词（如 Stable Diffusion、LoRA），但描写主体必须是中文。
4. 禁止用「输入是英文所以用英文输出」为由切换语种。`,
  en: `
【Output language lock: English】（Highest priority; overrides any "match input language" rule above）
1. User selected English output; write the entire expanded prompt in English.
2. Even if input is Chinese or mixed, output must be English prose or phrases, not Chinese characters as main content.
3. Do not switch to Chinese because the input is Chinese.
4. For natural-language rules: no Danbooru tag dumps unless the active rule explicitly requires tags.`,
};

// === 工具函数 ===
export function resolveUseEnglishOutput(outputLang: string, shortText: string): boolean {
  const lang = String(outputLang || 'zh').toLowerCase();
  if (lang === 'en') return true;
  if (lang === 'zh') return false;
  return !/[\u4e00-\u9fff]/.test(String(shortText || ''));
}

export function getOutputLangUserLock(outputLang: string): string {
  const lang = String(outputLang || '').toLowerCase();
  if (lang === 'zh') {
    return '【输出语言】已锁定为中文（最高优先级）。即使用户输入是英文单词或 tag（如 1girl、solo），' +
      '也必须用中文自然语言扩写；禁止输出英文 tag 串、禁止整段英文逗号关键词列表。';
  }
  if (lang === 'en') {
    return '【Output language】Locked to English (highest priority). Even if input is Chinese, ' +
      'output must be English only; no Chinese sentences as main content.';
  }
  return '';
}

// === 篇幅控制 ===
const STRUCTURED_EXPAND_RULE_IDS = new Set(['expand_structured_md', 'expand_structured_json']);

function resolveExpandLengthKey(expandLen: string): string {
  const k = String(expandLen || 'medium').trim().toLowerCase();
  if (k === 'custom' || /^\d+$/.test(k)) return k;
  return EXPAND_LENGTH_PRESETS[k] ? k : 'medium';
}

export function parseCustomCharCount(expandLen: string, expandLenChars?: number): number | null {
  if (expandLenChars != null && expandLenChars > 0) return expandLenChars;
  const k = String(expandLen || '').trim();
  if (/^\d+$/.test(k)) return parseInt(k, 10);
  return null;
}

export function resolveExpandLengthSpec(expandLen: string, expandLenChars?: number, outputLang = 'auto', limits?: { expandMax?: number } | null) {
  const expandMax = limits && Number.isFinite(Number(limits.expandMax)) ? Number(limits.expandMax) : 8192;
  const chars = parseCustomCharCount(expandLen, expandLenChars);
  const useEn = resolveUseEnglishOutput(outputLang, '');

  if (chars != null) {
    return {
      custom: true,
      chars,
      maxTokens: Math.min(expandMax, Math.max(128, Math.ceil(chars * 1.8))),
      hintZh: `扩写结果目标约 ${chars} 字（按中文字符计）或等价英文篇幅，请尽量接近该长度，不要明显过短或远超。`,
      hintEn: `Target output length about ${chars} characters/words; match this scale closely.`,
    };
  }

  if (String(expandLen || '').trim() === 'custom') {
    return resolveExpandLengthSpec('medium', undefined, outputLang, limits);
  }

  const key = resolveExpandLengthKey(expandLen);
  const preset = EXPAND_LENGTH_PRESETS[key];
  return {
    custom: false,
    chars: null,
    maxTokens: preset.maxTokens,
    hintZh: preset.hintZh,
    hintEn: preset.hintEn,
  };
}

export function resolveExpandMaxTokens(expandLen: string, expandLenChars?: number, limits?: { expandMax?: number } | null): number {
  let maxTokens = resolveExpandLengthSpec(expandLen, expandLenChars).maxTokens;
  // 默认上限 8192（与 PM DEFAULT_LOCAL_TOKEN_LIMITS.expandMax 对齐）
  const defaultMax = 8192;
  const upper = limits && Number.isFinite(Number(limits.expandMax)) ? Number(limits.expandMax) : defaultMax;
  maxTokens = Math.min(maxTokens, upper);
  return Math.max(128, maxTokens);
}

export function applyExpandLength(systemText: string, expandLen: string, outputLang: string, expandLenChars?: number): string {
  const spec = resolveExpandLengthSpec(expandLen, expandLenChars, outputLang);
  const useEn = resolveUseEnglishOutput(outputLang, '');
  const hint = useEn ? spec.hintEn : spec.hintZh;
  const title = useEn ? 'Length requirement' : '篇幅要求';
  return String(systemText || '').trim() + `\n\n【${title}】${hint}`;
}

export function applyOutputLanguage(systemText: string, outputLang: string, ruleId?: string): string {
  const lang = String(outputLang || 'zh').toLowerCase();
  if (lang !== 'zh' && lang !== 'en') return systemText;
  const rid = String(ruleId || '').trim();

  if (STRUCTURED_EXPAND_RULE_IDS.has(rid)) {
    const lock = lang === 'zh'
      ? '\n\n【输出语言锁定：中文】Markdown 小节标题可按模板英文（如 ## General）；描述正文用简体中文。'
      : '\n\n【Output language lock: English】Keep JSON keys as specified; string values in English.';
    const suffix = lang === 'zh'
      ? '\n\n只输出要求的 Markdown 或 JSON 结构正文，不要解释过程。'
      : '\n\nOutput only the required Markdown or JSON body; no explanation.';
    return String(systemText || '').trim() + lock + suffix;
  }

  return String(systemText || '').trim() + (OUTPUT_LANG_LOCK[lang] || '') + (OUTPUT_LANG_SUFFIX[lang] || '');
}

export function applyUserExtraPrompt(text: string, userExtraPrompt: string, outputLang: string): string {
  const extra = String(userExtraPrompt || '').trim();
  if (!extra) return text;
  const useEn = resolveUseEnglishOutput(outputLang, '');
  const title = useEn ? 'User additional requirements' : '用户附加要求';
  return `${String(text || '').trim()}\n\n【${title}】${extra}`;
}

export function resolveExpandSystemMessage(
  ruleId: string,
  customRuleContent: string,
  outputLang: string,
  expandLen: string,
  expandLenChars: number | undefined,
  userExtraPrompt: string
): string {
  const custom = String(customRuleContent || '').trim();
  let base: string;
  if (custom) {
    base = custom;
  } else {
    const rule = getExpandRuleById(ruleId);
    base = rule ? rule.system : EXPAND_RULES[0].system;
  }
  base = applyOutputLanguage(base, outputLang, ruleId);
  base = applyExpandLength(base, expandLen, outputLang, expandLenChars);
  return applyUserExtraPrompt(base, userExtraPrompt, outputLang);
}

export function getExpandFormatHint(ruleId: string, outputLang: string): string {
  const id = String(ruleId || 'expand_natural').trim();
  const useEn = resolveUseEnglishOutput(outputLang, '');

  if (id === 'Danbooru_tag_list' || id === 'expand_danbooru') {
    return useEn
      ? 'Output format: English comma-separated Danbooru-style tags (artist:/copyright:/… then general tags). No prose paragraphs.'
      : '输出格式：英文 Danbooru 风格 tag 行（含 artist:/copyright:/ 等前缀），不要长段落。';
  }
  if (id === 'Stable_Diffusion_Prompt' || id === 'expand_compact' || id === 'expand_cinematic') {
    return useEn
      ? 'Output format: one line or comma-separated SD prompt tags/phrases; faithful visual detail.'
      : '输出格式：一行或逗号分隔 SD 正向标签/短语，强调可视细节。';
  }
  if (id === 'Descriptive' || id === 'expand_natural' || id === 'expand_photographer' || id === 'expand_descriptive_en') {
    return useEn
      ? 'Output format: natural language prose only (single cohesive description). No tag dumps or markdown headings.'
      : '输出格式：单段自然语言描写，禁止 tag 串与 Markdown 小标题。';
  }
  if (id === 'min_structured_md' || id === 'min_structured_md_body' || id === 'expand_structured_md' || id.startsWith('expand_torii_min_structured_md')) {
    return useEn
      ? 'Output format: Markdown only (# 3. Structured description with ## sections). No JSON, no explanation.'
      : '输出格式：仅 Markdown 结构化正文（## General、分角色节等），不要 JSON、不要解释。';
  }
  if (id === 'min_structured_json' || id === 'json' || id === 'expand_structured_json' || id.startsWith('expand_torii_min_structured_json') || id.startsWith('expand_torii_json')) {
    return useEn
      ? 'Output format: one valid JSON object only. No Markdown wrapper, no explanation.'
      : '输出格式：仅一个 JSON 对象，不要 Markdown、不要解释。';
  }
  return '';
}

export function buildExpandUserPrompt(
  shortText: string,
  expandLen: string,
  outputLang: string,
  expandLenChars: number | undefined,
  ruleId: string,
  userExtraPrompt: string
): string {
  const t = String(shortText || '').trim();
  const extra = String(userExtraPrompt || '').trim();
  const spec = resolveExpandLengthSpec(expandLen, expandLenChars, outputLang);
  const useEn = resolveUseEnglishOutput(outputLang, t);
  const lengthLine = useEn ? spec.hintEn : spec.hintZh;
  const formatHint = getExpandFormatHint(ruleId, outputLang);
  const langLock = getOutputLangUserLock(outputLang);
  const intro = useEn
    ? 'Expand the following brief description into a ready-to-use image generation prompt. Output only the expanded prompt.'
    : '请将以下简短描述扩写为完整、可直接用于 AI 绘图的正向提示词。只输出扩写正文，不要解释。';

  let out = `${intro}\n\n`;
  if (langLock) out += `${langLock}\n\n`;
  out += `【${useEn ? 'Length' : '篇幅'}】${lengthLine}\n\n`;
  if (formatHint) out += `【${useEn ? 'Format' : '格式'}】${formatHint}\n\n`;
  if (extra) out += `【${useEn ? 'User additional requirements' : '用户附加要求'}】${extra}\n\n`;
  out += `【${useEn ? 'User input' : '用户输入'}】\n${t}`;
  return out;
}

export function listExpandRulesForUi() {
  return EXPAND_RULES.map(r => ({
    id: r.id, label: r.category ? `${r.category} / ${r.name}` : r.name,
    name: r.name, category: r.category,
  }));
}

export function listExpandLengthsForUi() {
  const presets = EXPAND_LENGTH_OPTIONS.map(o => ({
    ...o, description: EXPAND_LENGTH_PRESETS[o.value].hintZh,
  }));
  presets.push({ value: 'custom', label: '自定义字数', maxTokens: null as any, description: '在下方输入目标字数（任意正整数）' });
  return presets;
}