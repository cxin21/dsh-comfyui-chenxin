// Resolver types

export type PEKind = 'expand' | 'reverse' | 'train';
export type OutputFormat = 'prose' | 'sd_tags' | 'danbooru_tags' | 'structured_md' | 'structured_json' | 'minimax';

export interface PEProfile {
  id: string;
  kind: PEKind;
  builtin: boolean;
  builtinKey?: string;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  sort: number;
  outputFormat: OutputFormat;
  tags: string[];
  subjectDomains: string[];
  systemPrompt?: string;
  userPromptTemplate?: string;
  // expand mirror
  expandMirrorOf?: string;
  // torii
  toriiFormat?: boolean;
  structuredFormat?: boolean;
  toriiExtractMode?: string;
  toriiUseNamesDefault?: boolean;
  // minimax
  minimaxScenarioId?: string;
  formFields?: any[];
  outputMode?: string;
  mediaExpandLayout?: boolean;
  // train
  captionType?: string;
  // quality prompt prefix (PM 持久化字段)
  quality_prompt_enabled?: boolean;
  quality_prompt_prefix?: string;
  // meta
  createdAt?: number;
  updatedAt?: number;
}

export interface ExpandParams {
  outputLang: 'zh' | 'en' | 'auto';
  expandLen: string;
  expandLenChars?: number;
  userExtraPrompt?: string;
  shortText: string;
  tokenLimits?: { expandMax: number };
  mediaPaths?: string[];
  minimaxForm?: Record<string, any>;
}

export interface ExpandResult {
  system: string;
  user: string;
  maxTokens: number;
  ruleId: string;
}

export interface ReverseParams {
  caption_lang: 'zh' | 'en' | 'auto';
  len: string;
  caption_len_chars?: number;
  media_target: 'image' | 'video';
  extra_prompt?: string;
  anima3_enhance?: boolean;
  [key: string]: any;
}

export interface ReverseResult {
  system: string;
  userLead?: string;
  userBody?: string;
  outputConstraints: string;
  userTail?: string;
  captionType: string;
  // PM 1:1 兼容性：builtin 分支附加 builtin: true
  builtin?: boolean;
}