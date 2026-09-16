import { describe, expect, it } from 'vitest';
import {
  normalizeSemanticHits,
  type TagLookupFn,
  type TagRow,
} from '../../../src/pe-framework/dialect/semantic-normalize.js';

/** lookup stub：record_id → TagRow */
function makeLookup(rows: Record<string, Partial<TagRow>>): TagLookupFn {
  return (ids) => {
    const m = new Map<string, TagRow>();
    for (const id of ids) {
      const r = rows[id];
      if (r)
        m.set(id, {
          canonical_name: r.canonical_name ?? id,
          prompt_form: r.prompt_form ?? id,
          category: r.category ?? 'general',
          usage_count: r.usage_count ?? 0,
        });
    }
    return m;
  };
}

interface Hit {
  match_type?: string;
  record_id?: string;
  score?: number;
  text_source?: string;
}

const WIKI_1GIRL: TagRow = { canonical_name: '1girl', prompt_form: '1girl', category: 'general', usage_count: 9259271 };
const JUNK_VARIANT_1: TagRow = {
  canonical_name: '1 female',
  prompt_form: '1 female',
  category: 'general',
  usage_count: 0,
};
const JUNK_VARIANT_2: TagRow = {
  canonical_name: '1 girl,',
  prompt_form: '1 girl,',
  category: 'general',
  usage_count: 0,
};

describe('normalizeSemanticHits（递进式两档：D1 去重/形状清洗 + D2 wiki 优先）', () => {
  it('递进放宽：严档幸存 1 < minResults → 宽档回收 usage 门候选，wiki 真行居首、变体垫尾', () => {
    const hits: Hit[] = [
      { match_type: 'semantic', record_id: '10466', score: 0.765, text_source: 'fallback' }, // usage 0
      { match_type: 'semantic', record_id: '10768', score: 0.75, text_source: 'wiki' }, // 真行
      { match_type: 'semantic', record_id: '10470', score: 0.74, text_source: 'fallback' }, // 带逗号（永不回收）
    ];
    const lookup = makeLookup({ '10466': JUNK_VARIANT_1, '10768': WIKI_1GIRL, '10470': JUNK_VARIANT_2 });
    const { items, advisories } = normalizeSemanticHits(hits, lookup);
    expect(items).toHaveLength(2); // 形状脏行仍被丢弃，usage 门候选被宽档回收
    expect(items[0].record_id).toBe('10768'); // wiki 真行居首
    expect(items[1].record_id).toBe('10466'); // 变体垫尾
    expect(advisories).toContain('semantic_usage_relaxed:true');
    expect(advisories).toContain('semantic_malformed_dropped:1');
    expect(advisories.some((a) => a.startsWith('semantic_usage_dropped'))).toBe(false); // 放宽时无 dropped 计数
  });

  it('严档充足（≥ minResults）→ usage 门保持，变体不回收', () => {
    const hits: Hit[] = Array.from({ length: 12 }, (_, i) => ({
      match_type: 'semantic',
      record_id: `hi${i}`,
      score: 0.9 - i * 0.01,
      text_source: 'fallback',
    }));
    hits.push({ match_type: 'semantic', record_id: 'junk', score: 0.7, text_source: 'fallback' }); // usage 0
    const lookup = makeLookup({
      ...Object.fromEntries(
        hits
          .filter((h) => h.record_id !== 'junk')
          .map((h) => [
            h.record_id!,
            { canonical_name: h.record_id!, prompt_form: h.record_id!, category: 'general', usage_count: 500 },
          ]),
      ),
      junk: { canonical_name: 'junk', prompt_form: 'junk', category: 'general', usage_count: 0 },
    });
    const { items, advisories } = normalizeSemanticHits(hits, lookup);
    expect(items).toHaveLength(12); // junk 被丢，严档 12 个足够
    expect(items.some((h) => h.record_id === 'junk')).toBe(false);
    expect(advisories).toContain('semantic_usage_dropped:1');
    expect(advisories.some((a) => a.startsWith('semantic_usage_relaxed'))).toBe(false);
  });

  it('minResults 可注入：minResults=1 时严档幸存 1 即不放宽', () => {
    const hits: Hit[] = [
      { match_type: 'semantic', record_id: '10768', score: 0.75, text_source: 'wiki' },
      { match_type: 'semantic', record_id: '10466', score: 0.765, text_source: 'fallback' }, // usage 0
    ];
    const lookup = makeLookup({ '10768': WIKI_1GIRL, '10466': JUNK_VARIANT_1 });
    const { items, advisories } = normalizeSemanticHits(hits, lookup, { minResults: 1 });
    expect(items).toHaveLength(1);
    expect(items[0].record_id).toBe('10768');
    expect(advisories).toContain('semantic_usage_dropped:1');
  });

  it('归一化形去重：`1girl,` 类变体与真行同键合并（strip 非字母数字）', () => {
    const CLEAN: TagRow = { canonical_name: '1girl', prompt_form: '1girl', category: 'general', usage_count: 9259271 };
    const COMMA_VARIANT: TagRow = {
      canonical_name: '1girl',
      prompt_form: '1girl,',
      category: 'general',
      usage_count: 0,
    };
    const hits: Hit[] = [
      { match_type: 'semantic', record_id: 'a', score: 0.8, text_source: 'fallback' },
      { match_type: 'semantic', record_id: 'b', score: 0.75, text_source: 'wiki' },
    ];
    const lookup = makeLookup({ a: COMMA_VARIANT, b: CLEAN });
    const { items } = normalizeSemanticHits(hits, lookup);
    // 逗号变体在 Stage 0 被形状清洗丢弃（无条件），真行存活
    expect(items).toHaveLength(1);
    expect(items[0].record_id).toBe('b');
  });

  it('形状清洗：prompt_form 含逗号 → 丢弃 + advisory 计数（无 usage 候选可回收 → 保持空）', () => {
    const hits: Hit[] = [{ match_type: 'semantic', record_id: '10470', score: 0.74, text_source: 'fallback' }];
    const lookup = makeLookup({ '10470': JUNK_VARIANT_2 });
    const { items, advisories } = normalizeSemanticHits(hits, lookup);
    expect(items).toHaveLength(0);
    expect(advisories).toContain('semantic_malformed_dropped:1');
  });

  it('D2 wiki 优先：同 0.05 分桶内 wiki 排在 fallback 前', () => {
    const hits: Hit[] = [
      { match_type: 'semantic', record_id: 'fb1', score: 0.735, text_source: 'fallback' },
      { match_type: 'semantic', record_id: 'wk1', score: 0.721, text_source: 'wiki' },
    ];
    const lookup = makeLookup({
      fb1: { canonical_name: 'alpha', prompt_form: 'alpha', category: 'general', usage_count: 500 },
      wk1: { canonical_name: 'beta', prompt_form: 'beta', category: 'general', usage_count: 500 },
    });
    const { items } = normalizeSemanticHits(hits, lookup);
    expect(items[0].record_id).toBe('wk1'); // 同桶 wiki 优先
  });

  it('D2 限幅：跨桶严格按分数（0.94 fallback > 0.83 wiki，盲排 wiki 不得引入弱命中）', () => {
    const hits: Hit[] = [
      { match_type: 'semantic', record_id: 'wk_strong_gap', score: 0.83, text_source: 'wiki' },
      { match_type: 'semantic', record_id: 'fb_strong', score: 0.94, text_source: 'fallback' },
    ];
    const lookup = makeLookup({
      wk_strong_gap: { canonical_name: 'weak wiki', prompt_form: 'weak wiki', category: 'general', usage_count: 100 },
      fb_strong: { canonical_name: 'strong fb', prompt_form: 'strong fb', category: 'general', usage_count: 100 },
    });
    const { items } = normalizeSemanticHits(hits, lookup);
    expect(items[0].record_id).toBe('fb_strong');
  });

  it('非 semantic 项（fuzzy/tie-break 晋升）原位透传，不参与 wiki 重排', () => {
    const hits: Hit[] = [
      { match_type: 'fuzzy', record_id: 'fz', score: 0.7 },
      { match_type: 'semantic', record_id: 'wk1', score: 0.721, text_source: 'wiki' },
      { match_type: 'semantic', record_id: 'fb1', score: 0.735, text_source: 'fallback' },
    ];
    const lookup = makeLookup({
      wk1: { canonical_name: 'beta', prompt_form: 'beta', category: 'general', usage_count: 500 },
      fb1: { canonical_name: 'alpha', prompt_form: 'alpha', category: 'general', usage_count: 500 },
      fz: { canonical_name: 'fz', prompt_form: 'fz', category: 'general', usage_count: 10 },
    });
    const { items } = normalizeSemanticHits(hits, lookup);
    expect(items[0].match_type).toBe('fuzzy'); // fuzzy 原位保留
    expect(items[0].record_id).toBe('fz');
    expect(items.slice(1).map((h) => h.record_id)).toEqual(['wk1', 'fb1']); // 语义项内部 wiki 优先
  });

  it('lookup 缺行 → grace 保留原样（不丢命中）', () => {
    const hits: Hit[] = [{ match_type: 'semantic', record_id: 'unknown-id', score: 0.8, text_source: 'fallback' }];
    const { items, advisories } = normalizeSemanticHits(hits, makeLookup({}));
    expect(items).toHaveLength(1);
    expect(items[0].record_id).toBe('unknown-id');
    expect(advisories).toEqual([]);
  });
});
