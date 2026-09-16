import { afterAll, describe, expect, it } from 'vitest';
import {
  searchCatalog,
  searchCatalogSync,
  setVectorSearch,
  closeCatalog,
  queryCatalogInternal,
  prewarmSemanticQueries,
} from '../../../src/pe-framework/dialect/anima-catalog.js';

/** 取一条真实 canonical 记录作为 semantic stub 的 JOIN 目标（record_id 形态不对测试硬编码） */
function seedRecordId(tag: string): { record_id: string; prompt_form: string } {
  const hit = searchCatalogSync(tag, { mode: 'canonical', limit: 1 })[0];
  if (!hit?.record_id) throw new Error(`fixture seed missing: ${tag}`);
  return { record_id: hit.record_id, prompt_form: hit.prompt_form ?? tag };
}

afterAll(() => {
  setVectorSearch(null);
  closeCatalog();
});

describe('semantic level in auto cascade (spec §3.2)', () => {
  it('auto 级联前四级全空 → 落到 semantic 层（stub 向量层，零真库依赖）', async () => {
    const seed = seedRecordId('silvery hair');
    setVectorSearch(async (q) =>
      q === 'zzzzzzzzq' ? [{ record_id: seed.record_id, score: 0.82, text_source: 'wiki' as const }] : [],
    );
    const hits = await searchCatalog('zzzzzzzzq', { mode: 'auto', limit: 5 });
    expect(hits[0]).toMatchObject({
      match_type: 'semantic',
      prompt_form: seed.prompt_form,
      score: 0.82,
      text_source: 'wiki',
    });
  });

  it('字符串 tie-breaker：近 identical 拼写（lev_sim ≥0.8）提位到 semantic 序之前（selafuku 类拼写容错）', async () => {
    // T12-001 根因（模型分布特性）的确定性缓解：'selafuku' 与 'serafuku' 归一化 Levenshtein
    // 相似度 0.875 ≥ 0.8 → 提为第一梯队；'wafuku' 相似度 ~0.5 → 保持 semantic 序（即使分更高）。
    const near = seedRecordId('serafuku');
    const far = seedRecordId('wafuku');
    setVectorSearch(async () => [
      { record_id: far.record_id, score: 0.7359, text_source: 'fallback' as const },
      { record_id: near.record_id, score: 0.72, text_source: 'wiki' as const },
    ]);
    const hits = await searchCatalog('selafuku', { mode: 'auto', limit: 5 });
    expect(hits[0].match_type).toBe('semantic');
    expect(hits[0].prompt_form).toBe('serafuku');
    expect(hits.map((h) => h.prompt_form)).toContain('wafuku');
  });

  it('字符串 tie-breaker 不触发于无近拼写命中的查询（zzzzzzzzq 类）', async () => {
    const seed = seedRecordId('silvery hair');
    setVectorSearch(async () => [{ record_id: seed.record_id, score: 0.82, text_source: 'wiki' as const }]);
    const hits = await searchCatalog('zzzzzzzzq', { mode: 'auto', limit: 5 });
    expect(hits[0].prompt_form).toBe(seed.prompt_form); // 序保持 = 原 semantic 序
  });

  it('子串 FTS 召回：KNN 全空时按三元组 LIKE 召回含查询子串的 tag（selafuku → serafuku）', async () => {
    // KNN 层 miss（selafuku 的近拼写 tag 不在其向量近邻内）→ 子串召回补候选：
    // 'selafuku' 三元组含 'afu'/'fuk'/'uku' → LIKE '%afu%' 等命中 serafuku（含 afu/fuk/uku 子串）
    setVectorSearch(async () => []);
    const hits = await searchCatalog('selafuku', { mode: 'auto', limit: 10 });
    const forms = hits.map((h) => h.prompt_form);
    expect(forms).toContain('serafuku');
    expect(hits.find((h) => h.prompt_form === 'serafuku')?.match_type).toBe('fuzzy');
  });

  it('子串召回 + tie-breaker 组合：KNN 返回高分类似 typo 时，子串召回的 serafuku 被 tie-breaker 提到 #1', async () => {
    const typo = seedRecordId('serfafuku');
    setVectorSearch(async () => [{ record_id: typo.record_id, score: 0.7742, text_source: 'fallback' as const }]);
    const hits = await searchCatalog('selafuku', { mode: 'auto', limit: 10 });
    // 子串召回带进 serafuku（lev_sim 0.875 ≥0.8 提位）+ KNN 的 serfafuku（0.78 <0.8 不提位）
    expect(hits[0].prompt_form).toBe('serafuku');
    expect(hits.map((h) => h.prompt_form)).toContain('serfafuku');
  });

  it('子串召回对 <3 字符查询安全（不触发、不崩溃）且级联行为不变', async () => {
    setVectorSearch(async () => []);
    // 'ab' 在 fuzzy 层命中前缀 → 级联提前返回，semantic 层不触发
    const shortHits = await searchCatalog('ab', { mode: 'auto', limit: 5 });
    expect(Array.isArray(shortHits)).toBe(true);
    // 'a%b_c' 归一化为 'a%b c'，三元组含通配符字符 → LIKE 已转义，安全返回
    const weird = await searchCatalog('a%b_c', { mode: 'auto', limit: 5 });
    expect(Array.isArray(weird)).toBe(true);
  });

  it("mode 'exact' 永不触发 semantic 层", async () => {
    let semanticQueried = false;
    setVectorSearch(async () => {
      semanticQueried = true;
      return [];
    });
    expect(await searchCatalog('zzzzzzzzq', { mode: 'exact', limit: 5 })).toEqual([]);
    expect(semanticQueried).toBe(false);
  });

  it('单级直查永不触发 semantic 层', async () => {
    let semanticQueried = false;
    setVectorSearch(async () => {
      semanticQueried = true;
      return [];
    });
    expect(await searchCatalog('zzzzzzzzq', { mode: 'fuzzy', limit: 5 })).toEqual([]);
    expect(semanticQueried).toBe(false);
  });

  it('前级命中（canonical）遮蔽 semantic 层', async () => {
    let semanticQueried = false;
    setVectorSearch(async () => {
      semanticQueried = true;
      return [];
    });
    const hits = await searchCatalog('silvery hair', { mode: 'auto', limit: 5 });
    expect(hits[0].match_type).toBe('canonical');
    expect(semanticQueried).toBe(false);
  });

  it('semantic 命中 JOIN 不到 records → 丢弃；子串召回候选照常浮现（附录 A1 处置②行为变化）', async () => {
    setVectorSearch(async () => [{ record_id: 'no-such-record-xyz', score: 0.9, text_source: 'fallback' }]);
    const hits = await searchCatalog('zzzzzzzzq', { mode: 'auto', limit: 5 });
    // 悬空 KNN 命中被 JOIN 丢弃；'zzz' 三元组子串召回的真实 catalog 候选以 fuzzy 形态浮现
    expect(hits.every((h) => h.match_type === 'fuzzy')).toBe(true);
    expect(hits.every((h) => h.record_id !== 'no-such-record-xyz')).toBe(true);
  });

  it('semantic 层剔除 @ 画师命中（spec §3.2 补齐，与 fuzzy F3 的 @ 剔除同口径）', async () => {
    // 取真实 @ 画师记录作 JOIN 目标——证明剔除来自 @ 过滤而非 JOIN-miss 巧合
    const atRows = queryCatalogInternal(
      "SELECT record_id, prompt_form FROM records WHERE prompt_form LIKE '@%' LIMIT 1",
    ) as Array<{ record_id: string; prompt_form: string }>;
    if (!atRows.length) throw new Error('fixture missing: no @-prefixed record in catalog');
    expect((atRows[0].prompt_form ?? '').startsWith('@')).toBe(true);
    const seed = seedRecordId('silvery hair');
    setVectorSearch(async () => [
      { record_id: atRows[0].record_id, score: 0.95, text_source: 'wiki' },
      { record_id: seed.record_id, score: 0.82, text_source: 'wiki' },
    ]);
    const hits = await searchCatalog('zzzzzzzzq', { mode: 'auto', limit: 5 });
    expect(hits.some((h) => (h.prompt_form ?? h.raw ?? '').startsWith('@'))).toBe(false);
    // 非 @ 命中保留且前移（@ 命中不再占位）
    expect(hits[0]).toMatchObject({ match_type: 'semantic', prompt_form: seed.prompt_form, score: 0.82 });
  });

  it('向量层故障降级为空，不阻塞级联（增强层纪律）', async () => {
    setVectorSearch(async () => {
      throw new Error('embed boom');
    });
    expect(await searchCatalog('zzzzzzzzq', { mode: 'auto', limit: 5 })).toEqual([]);
  });

  it('searchCatalogSync（同步双入口）永不触发 semantic 层', () => {
    let semanticQueried = false;
    setVectorSearch(async () => {
      semanticQueried = true;
      return [];
    });
    expect(searchCatalogSync('zzzzzzzzq', { mode: 'auto', limit: 5 })).toEqual([]);
    expect(semanticQueried).toBe(false);
  });
});

describe('prewarmSemanticQueries（audit P4b：同步命中过滤 + 批量预热转发）', () => {
  it('同步级联已命中的 query 跳过；仅语义候选转发 prewarm；query 去重', async () => {
    const prewarmed: string[][] = [];
    setVectorSearch(
      Object.assign(async () => [], {
        prewarm: async (qs: string[]) => {
          prewarmed.push(qs);
        },
      }),
    );
    // 'silvery hair' = 真实 canonical（seedRecordId 同款）；'zzzzzzzzq' 同步全空 → 语义候选
    await prewarmSemanticQueries(['silvery hair', 'zzzzzzzzq', 'zzzzzzzzq']);
    expect(prewarmed).toEqual([['zzzzzzzzq']]);
  });

  it('向量 seam 无 prewarm 方法（旧形态注入）→ no-op 不抛', async () => {
    setVectorSearch(async () => []);
    await expect(prewarmSemanticQueries(['zzzzzzzzq'])).resolves.toBeUndefined();
  });

  it('语义层禁用（null）→ no-op 不抛', async () => {
    setVectorSearch(null);
    await expect(prewarmSemanticQueries(['zzzzzzzzq'])).resolves.toBeUndefined();
  });

  it('prewarm 故障不抛出（best-effort，与向量层降级纪律一致）', async () => {
    setVectorSearch(
      Object.assign(async () => [], {
        prewarm: async () => {
          throw new Error('prewarm boom');
        },
      }),
    );
    await expect(prewarmSemanticQueries(['zzzzzzzzq'])).resolves.toBeUndefined();
  });
});
