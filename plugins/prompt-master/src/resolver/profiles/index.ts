// Profile registry — 内置 Profile 集合
// 8 种扩写 / 3 种内置反推 / 10 Torii 反推 / 12 训练 / 10 MiniMax 场景
// 也支持运行时从 SQLite custom_profiles 加载用户 Profile

import { PEProfile } from '../types.js';
import {
  REVERSE_TAGS,
  ALL_SUBJECT_DOMAIN_IDS,
  enrichProfileTaxonomy,
} from '../taxonomy.js';
import { buildToriiReverseProfiles } from './torii/formats.js';
import { buildExpandProfilesFromReverseCatalog } from './expand-mirror.js';
import { buildBuiltinTrainCaptionProfiles } from './train/index.js';
import { MINIMAX_SCENARIOS } from '../minimax/catalog.js';
import { EXPAND_RULES } from './expand-rules.js';
import { getCustomProfileSource } from './source.js';

// ========== 内置反推 Profile（3 种）==========
const BUILTIN_REVERSE_PROFILES: PEProfile[] = [
  {
    id: 'pe_reverse_descriptive',
    kind: 'reverse',
    builtin: true,
    builtinKey: 'Descriptive',
    name: '自然语言 · 五点结构式',
    category: '反推',
    description: '单段连贯自然语言，按五点结构（构图、主体、环境、文字、风格）极致还原画面。',
    enabled: true, sort: 10,
    outputFormat: 'prose',
    tags: REVERSE_TAGS.Descriptive,
    subjectDomains: ALL_SUBJECT_DOMAIN_IDS,
  },
  {
    id: 'pe_reverse_sd',
    kind: 'reverse',
    builtin: true,
    builtinKey: 'Stable_Diffusion_Prompt',
    name: 'SD 标签 · Stable Diffusion 提示词格式',
    category: '反推',
    description: '一行逗号分隔 SD 正向标签，含完整还原检查表。',
    enabled: true, sort: 20,
    outputFormat: 'sd_tags',
    tags: REVERSE_TAGS.Stable_Diffusion_Prompt,
    subjectDomains: ALL_SUBJECT_DOMAIN_IDS,
  },
  {
    id: 'pe_reverse_danbooru',
    kind: 'reverse',
    builtin: true,
    builtinKey: 'Danbooru_tag_list',
    name: 'Danbooru 标签 · 标准前缀式',
    category: '反推',
    description: '一行英文 Danbooru 风格 tag（短语内空格）。',
    enabled: true, sort: 30,
    outputFormat: 'danbooru_tags',
    tags: REVERSE_TAGS.Danbooru_tag_list,
    subjectDomains: ['general', 'portrait'],
  },
];

// ========== 8 种内置扩写 Profile（来自 expand-rules.ts 的 EXPAND_RULES）==========
// legacy-name collision: PM 3.1.0 内置该 id 为其他语义；本 port 保留 expand 语义（消费方为 expand 路由）
// （审计 R1：pe_expand_natural 等在 LEGACY_EXPAND_PE_ID_MAP 中是应映射到 pe_expand_descriptive/pe_expand_sd 的旧 id；
//   port 将其注册为现役 expand profile，legacy 映射对这些 key 不会被触发——id 体系保持不变，此处仅声明语义）
function buildBuiltinExpandProfiles(): PEProfile[] {
  return EXPAND_RULES.map((r, i) => ({
    id: `pe_${r.id}`,
    kind: 'expand',
    builtin: true,
    builtinKey: r.id,
    name: r.name,
    category: r.category,
    description: r.description,
    enabled: true,
    sort: i + 1,
    outputFormat: (
      r.id === 'expand_danbooru' ? 'danbooru_tags' :
      r.id === 'expand_compact' || r.id === 'expand_cinematic' ? 'sd_tags' :
      r.id === 'expand_structured_md' ? 'structured_md' :
      r.id === 'expand_structured_json' ? 'structured_json' :
      'prose'
    ) as any,
    tags: [r.category],
    subjectDomains: ALL_SUBJECT_DOMAIN_IDS,
  }));
}

// ========== MiniMax 场景 Profile（来自 minimaxScenarios）==========
function buildMinimaxScenarioProfiles(): PEProfile[] {
  return MINIMAX_SCENARIOS.map((s) => ({
    id: s.peId,
    kind: 'expand',
    builtin: true,
    builtinKey: s.builtinKey,
    name: s.name,
    category: '视频 / MiniMax',
    description: s.description,
    enabled: true,
    sort: s.sort,
    outputFormat: 'minimax' as any,
    tags: ['扩写', '视频', 'MiniMax', 'H3', s.id],
    subjectDomains: ALL_SUBJECT_DOMAIN_IDS,
    minimaxScenarioId: s.id,
    formFields: s.formFields,
    outputMode: s.outputMode,
    mediaExpandLayout: s.mediaExpandLayout,
  }));
}

// ========== 主入口：所有内置 Profile ==========
let cached: PEProfile[] | null = null;

export function getDefaultBuiltinProfiles(): PEProfile[] {
  if (cached) return cached;

  const torii = buildToriiReverseProfiles();
  const expandMirror = buildExpandProfilesFromReverseCatalog(BUILTIN_REVERSE_PROFILES, torii);
  const expandBuiltin = buildBuiltinExpandProfiles();
  const train = buildBuiltinTrainCaptionProfiles();
  const minimax = buildMinimaxScenarioProfiles();
  const now = Date.now();

  // 合并用户自定义 Profile（从 SQLite custom_profiles 加载）
  const customRecords = safeListCustomProfiles();
  const customs: PEProfile[] = [];
  for (const r of customRecords) {
    try {
      const p = JSON.parse(r.profileJson) as PEProfile;
      customs.push({ ...p, id: p.id || r.id });
    } catch {
      // 跳过损坏的 JSON
    }
  }

  cached = [
    ...minimax,
    ...expandBuiltin,
    ...expandMirror,
    ...BUILTIN_REVERSE_PROFILES,
    ...train,
    ...torii,
    ...customs,
  ].map((p) => enrichProfileTaxonomy({
    ...p,
    createdAt: p.createdAt || now,
    updatedAt: p.updatedAt || now,
  }));

  return cached;
}

/** 从注入源读自定义 profile；未注入或异常时返回 []（与 DB 不可用时行为一致） */
function safeListCustomProfiles(): any[] {
  try {
    return getCustomProfileSource()()
  } catch {
    return []
  }
}

/** 清除缓存以让 custom_profiles 变更生效 */
export function clearProfileCache(): void {
  cached = null;
}

/** 内置 Profile 过滤器（enable=false 时使 findProfileById 对该 id 返回 undefined） */
let builtinFilter: ((id: string) => boolean) | undefined;

export function setBuiltinFilter(filter: ((id: string) => boolean) | undefined): void {
  builtinFilter = filter;
}

export function findProfileById(id: string): PEProfile | undefined {
  if (builtinFilter?.(id)) return undefined;
  return getDefaultBuiltinProfiles().find((p) => p.id === id);
}

export function filterProfilesByKind(kind: string): PEProfile[] {
  const k = String(kind || '').trim();
  return getDefaultBuiltinProfiles().filter((p) => {
    if (!p.enabled) return false;
    // 设计 §3.3 的 kind 枚举含 'minimax'；MiniMax 场景的 kind 为 'expand'，按 minimaxScenarioId 识别
    if (k === 'minimax') return !!p.minimaxScenarioId;
    return p.kind === k;
  });
}

export function searchProfiles(query: string): PEProfile[] {
  const q = query.toLowerCase();
  return getDefaultBuiltinProfiles().filter((p) => {
    if (!p.enabled) return false;
    if (p.id.toLowerCase().includes(q)) return true;
    if (p.name.toLowerCase().includes(q)) return true;
    if (p.description.toLowerCase().includes(q)) return true;
    if (p.tags.some((t) => t.toLowerCase().includes(q))) return true;
    return false;
  });
}