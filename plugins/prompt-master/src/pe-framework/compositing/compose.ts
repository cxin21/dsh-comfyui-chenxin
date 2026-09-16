/**
 * S3 确定性后处理 + 回退组装（spec 2026-09-17 agentic-pipeline-redesign §7，A6，零 LLM）：
 * assemblePositive/assembleNegative = 成文产物的机器拼装（rating 种子、质量词/分级词模板）；
 * deterministicCompose = 确定性回退 writer——蓝图概念逐个**同步直查 catalog** 取 canonical/alias
 * 作 tag，永不失败（D7：任何情况下不空手出稿）。
 * A1/A6：检索包已废除——unresolved 碎片倾泻 NL 的旧语义一并删除（查不到的概念静默放弃）。
 */
import type { WriterOutput, WriterTag } from './writer.js';
import { extractConcepts } from '../dialect/retrieval-pack.js';
import type { SemanticBlueprint } from '../blueprint/semantic-schema.js';

export type Rating = 'safe' | 'sensitive' | 'explicit';

/** 回退 NL 字符预算（positive = tags + nl ≤ 1200，tags 最多 40×~10 chars，NL 留 600） */
export const NL_CHAR_BUDGET = 600;
/** audit P2：回退 tag 字符预算——positive 总长数学保证 ≤ 1200：
 *  rating_explicit(15) + 分隔(', '×2=4) + tags(≤560，tag 间分隔已计入) + nl(≤600) = 1179 */
export const TAG_CHAR_BUDGET = 560;
const MAX_FALLBACK_TAGS = 40;

/** 负面模板（spec §7：quality 系列 + 分级守卫；现行 policy 词表沿用） */
export const NEGATIVE_TEMPLATE = [
  'worst quality',
  'low quality',
  'score_1',
  'score_2',
  'score_3',
  'artist name',
  'blurry',
  'jpeg artifacts',
  'chromatic aberration',
  'child',
  'loli',
  'shota',
  'toddler',
  'kid',
  'preteen',
  'extra limbs',
];

export function assemblePositive(out: WriterOutput, rating: Rating): string {
  const parts = [`rating_${rating}`, ...out.tags.map((t) => t.text)];
  if (out.nl.trim() !== '') parts.push(out.nl.trim());
  return parts.join(', ');
}

export function assembleNegative(out: WriterOutput): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const n of [...NEGATIVE_TEMPLATE, ...out.negative]) {
    const key = n.trim().toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    parts.push(n.trim());
  }
  return parts.join(', ');
}

/** 回退检索缝：同步直查 catalog（canonical/alias 才采纳） */
export interface FallbackHit {
  prompt_form?: string;
  match_type?: string;
  usage_count?: number;
}
export type FallbackSearch = (query: string) => FallbackHit[];

/**
 * 确定性回退组装（D7 fail-open + A6 直查）：蓝图概念逐个同步查 catalog，
 * 只采纳 canonical/alias 命中（fuzzy/semantic 未验证形式不进回退产物）；
 * TAG_CHAR_BUDGET 累计裁剪 + 大小写去重（audit P2）；NL = 构图/光源/氛围模板句
 * （NL_CHAR_BUDGET=600 截断）。**无 unresolved 倾泻**——查不到的概念静默放弃。
 */
export function deterministicCompose(bp: SemanticBlueprint, search: FallbackSearch): WriterOutput {
  const seenForms = new Set<string>();
  const tags: WriterTag[] = [];
  let usedChars = 0;
  for (const { query } of extractConcepts(bp)) {
    if (tags.length >= MAX_FALLBACK_TAGS) break;
    if (query.trim() === '') continue;
    const hit = search(query).find((h) => h.match_type === 'canonical' || h.match_type === 'alias');
    const text = hit?.prompt_form ?? '';
    if (text === '') continue;
    const key = text.trim().toLowerCase();
    if (seenForms.has(key)) continue;
    const cost = (tags.length > 0 ? 2 : 0) + text.length;
    if (usedChars + cost > TAG_CHAR_BUDGET) continue;
    seenForms.add(key);
    tags.push({ text, source_concept: 'fallback.catalog' });
    usedChars += cost;
  }

  const sentences: string[] = [];
  const comp = bp.composition;
  const framingBits = [comp.framing, comp.camera_angle, comp.placement].filter((s) => s.trim() !== '');
  if (framingBits.length > 0) sentences.push(`The scene is ${framingBits.join(', ')}.`);
  if (typeof bp.core.scene.lighting_idea === 'string' && bp.core.scene.lighting_idea.trim() !== '') {
    sentences.push(`${bp.core.scene.lighting_idea}, no silhouette.`);
  }
  if (typeof bp.mood === 'string' && bp.mood.trim() !== '') sentences.push(`${bp.mood}.`);

  // audit P2（2026-09-17）：NL 总长截到 NL_CHAR_BUDGET(600)——按句保留，超预算句尾截断。
  const nlJoined = sentences.slice(0, 4).join(' ');
  const nl =
    nlJoined.length > NL_CHAR_BUDGET ? `${nlJoined.slice(0, NL_CHAR_BUDGET).replace(/\s+\S*$/, '')}…` : nlJoined;

  return {
    tags,
    nl,
    negative: [...bp.negative_hints],
  };
}
