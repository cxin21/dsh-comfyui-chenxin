/**
 * 语义命中归一化（实测计划 2026-09-17 D1/D2 修订：usage 门改递进式两档，用户裁决）：
 * 实测实证（catalog_search 活体）——向量索引近邻被抓取变体垃圾挤占
 * （"1girl" top-10 全为 `1_female`/`1_girl,`/`standing_female` 类 usage 0 行，
 * 真 wiki 行 id 10768（usage 9.2M）不在 top-10），且 wiki 关联（19.9 万行）
 * 从未浮出语义命中。查询侧修复（用户裁决：不重建向量库）：
 *
 * Stage 0 形状清洗（无条件，任何档位不回收）：prompt_form 含逗号/空白异常 → 丢弃
 * Stage 1 严档：usage ≥ minUsage(默认 100) → 归一化形去重 → wiki 分桶排序 → 幸存数 N
 * 触发：N < minResults(默认 10) 且存在被 usage 门挡掉的候选 → Stage 2 宽档：
 *       回收 usage 门候选（形状清洗/去重不放宽）→ 合并重排序
 * 排序键（两档同）：[score 分桶(0.05) 降序, wiki 降序, usage 降序, score 降序]
 * ——usage 0 变体只垫尾，wiki 真行/主流 tag 居首，质量不倒挂（0.94 fallback > 0.83 wiki：
 *    bge-base 活跑区间 0.6-0.8，盲排 wiki 会引入弱命中）
 * 可观测：放宽 → semantic_usage_relaxed:true；未放宽且有丢弃 → semantic_usage_dropped:N；
 *         另有 semantic_dedupe:N / semantic_malformed_dropped:N 计数。
 * 非 semantic 项（fuzzy/substring/tie-break 晋升）原位透传——既有级联契约零变更。
 * 丢弃槽位压缩收缩（不得写 undefined——回填 bug 纪律）。
 * 纯函数：无 anima-catalog 依赖——默认 lookup（createCatalogTagLookup）由 anima-catalog 侧装配。
 */

export interface TagRow {
  canonical_name: string;
  prompt_form: string;
  category: string;
  usage_count: number;
}

export type TagLookupFn = (recordIds: string[]) => Map<string, TagRow>;

export interface SemanticNormalizeInput {
  match_type?: string;
  record_id?: string;
  score?: number;
  text_source?: string;
}

export interface SemanticNormalizeOpts {
  /** Stage 1 严档 usage 下限（默认 100） */
  minUsage?: number;
  /** 放宽触发阈值（默认 10）：Stage 1 幸存数低于此 → Stage 2 宽档 */
  minResults?: number;
}

const SCORE_BUCKET = 0.05;
/** Stage 1 严档 usage 下限（递进式分档线，不是硬门） */
const MIN_USAGE = 100;
/** 放宽触发阈值：Stage 1 幸存数低于此 → Stage 2 宽档 */
const MIN_RESULTS = 10;

function isMalformedForm(form: string): boolean {
  // danbooru 单 tag 无逗号（抓取脏行实证 'low tied long hair,'）；trim 后为空同样是脏行
  return form.includes(',') || form.trim() === '';
}

/** 归一化形键：strip 非字母数字 + 小写——`1_girl,`≈`1girl`、`low tied long hair,` 归并到清洁主行 */
function normalizedKey(form: string): string {
  return form.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

interface Entry<T> {
  hit: T;
  row: TagRow | undefined;
  isWiki: boolean;
  usage: number;
  score: number;
}

/** 归一化形去重 + wiki 分桶排序（两档共用；返回代表序列 + 去重计数） */
function dedupeSort<T extends SemanticNormalizeInput>(
  pool: Array<Entry<T>>,
): {
  reps: Array<{ hit: T; isWiki: boolean; usage: number; score: number }>;
  deduped: number;
} {
  const groups = new Map<string, Array<Entry<T>>>();
  const singles: Array<Entry<T>> = [];
  for (const k of pool) {
    const form = k.row?.prompt_form;
    const key = form ? normalizedKey(form) : `id:${k.hit.record_id ?? ''}`;
    const arr = groups.get(key) ?? [];
    arr.push(k);
    groups.set(key, arr);
  }
  const reps: Array<{ hit: T; isWiki: boolean; usage: number; score: number }> = [];
  let deduped = 0;
  for (const [, arr] of groups) {
    if (arr.length > 1) deduped += arr.length - 1;
    const best = [...arr].sort(
      (a, b) => Number(b.isWiki) - Number(a.isWiki) || b.usage - a.usage || b.score - a.score,
    )[0];
    reps.push({ hit: best.hit, isWiki: best.isWiki, usage: best.usage, score: Math.max(...arr.map((k) => k.score)) });
  }
  for (const k of singles) reps.push({ hit: k.hit, isWiki: k.isWiki, usage: k.usage, score: k.score });
  reps.sort(
    (a, b) =>
      Math.floor(b.score / SCORE_BUCKET) - Math.floor(a.score / SCORE_BUCKET) ||
      Number(b.isWiki) - Number(a.isWiki) ||
      b.usage - a.usage ||
      b.score - a.score,
  );
  return { reps, deduped };
}

export function normalizeSemanticHits<T extends SemanticNormalizeInput>(
  items: T[],
  lookup: TagLookupFn,
  opts?: SemanticNormalizeOpts,
): { items: T[]; advisories: string[] } {
  const advisories: string[] = [];
  const minUsage = opts?.minUsage ?? MIN_USAGE;
  const minResults = opts?.minResults ?? MIN_RESULTS;
  const semanticIdx: number[] = [];
  items.forEach((it, i) => {
    if (it.match_type === 'semantic') semanticIdx.push(i);
  });
  if (semanticIdx.length === 0) return { items, advisories };

  const lookupIds = [
    ...new Set(semanticIdx.map((i) => items[i].record_id).filter((id): id is string => typeof id === 'string')),
  ];
  const rows = lookup(lookupIds);

  // Stage 0 形状清洗（无条件，任何档位不回收）：form 缺行 grace 保留
  const clean: Array<Entry<T>> = [];
  let malformed = 0;
  for (const idx of semanticIdx) {
    const hit = items[idx];
    const row = hit.record_id !== undefined ? rows.get(hit.record_id) : undefined;
    if (row && isMalformedForm(row.prompt_form)) {
      malformed++;
      continue;
    }
    clean.push({ hit, row, isWiki: hit.text_source === 'wiki', usage: row?.usage_count ?? 0, score: hit.score ?? 0 });
  }

  // 递进两档（用户裁决）：严档幸存不足 → 宽档回收 usage 门候选（形状清洗/去重不放宽）。
  // lookup 缺行（usage 未知）归严档——grace 语义，缺行不是 junk 证据，不得触发放宽。
  const high = clean.filter((k) => k.row === undefined || k.usage >= minUsage);
  const low = clean.filter((k) => k.row !== undefined && k.usage < minUsage);
  const tier1 = dedupeSort(high);
  let final: { reps: ReturnType<typeof dedupeSort>['reps']; deduped: number };
  if (tier1.reps.length >= minResults || low.length === 0) {
    final = tier1;
    if (low.length > 0) advisories.push(`semantic_usage_dropped:${low.length}`);
  } else {
    // Stage 2 宽档：严档饥饿 → 回收 usage 门候选（排序键保证变体垫尾、wiki 真行居首）
    final = dedupeSort([...high, ...low]);
    advisories.push('semantic_usage_relaxed:true');
  }
  if (final.deduped > 0) advisories.push(`semantic_dedupe:${final.deduped}`);
  if (malformed > 0) advisories.push(`semantic_malformed_dropped:${malformed}`);

  // 语义项重排 + 压缩回填：幸存者按序占据语义槽位；被门丢弃的槽位收缩（不得写 undefined）
  const semanticSet = new Set(semanticIdx);
  const semanticResults = final.reps.map((r) => Object.assign({}, r.hit, { score: r.score }) as T);
  const out: T[] = [];
  let r = 0;
  for (let i = 0; i < items.length; i++) {
    if (semanticSet.has(i)) {
      if (r < semanticResults.length) out.push(semanticResults[r++]);
      // 丢弃槽位：跳过（数组收缩）——KNN 过采样由调用方兜底（D3 k=limit×3）
    } else {
      out.push(items[i]);
    }
  }
  // 极端情形防御：representatives 多于语义槽位（理论不可达）时不得丢代表
  while (r < semanticResults.length) out.push(semanticResults[r++]);
  return { items: out, advisories };
}
