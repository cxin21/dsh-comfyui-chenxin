import { describe, expect, it, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCatalogSearchTool } from '../../src/tools/catalog-search.js';
import { stubCtx, runTool } from './helpers.js';
import { closeCatalog, searchCatalogSync, setVectorSearch } from '../../src/pe-framework/dialect/anima-catalog.js';
import { setOverlayPath } from '../../src/pe-framework/anima-knowledge/relations.js';

const cfg = { temperature: 0.7 };
const def = () => registerCatalogSearchTool(null as never, cfg as never);

let tmp: string;

beforeEach(() => {
  // O2 隔离：overlay-status 断言不依赖环境残留——注入保证不存在的临时 overlay 路径
  tmp = mkdtempSync(join(tmpdir(), 'pm-ovl-'));
  setOverlayPath(join(tmp, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite'));
});

afterEach(() => {
  setOverlayPath('');
  rmSync(tmp, { recursive: true, force: true });
});

describe('catalog_search', () => {
  it('canonical tag returns canonical hit with prompt_form', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silvery hair' })));
    expect(raw.hits[0].match_type).toBe('canonical');
    expect(raw.hits[0].prompt_form).toBe('silvery hair');
  });

  it('alias tag resolves canonical waving', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'wave' })));
    expect(raw.hits[0].match_type).toBe('alias');
    expect(raw.hits[0].prompt_form).toBe('waving');
  });

  it('fuzzy tag cascades without auto-substitution', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair' })));
    expect(raw.hits.length).toBeGreaterThan(0);
    expect(raw.hits[0].match_type).toBe('fuzzy');
  });

  it('miss tag returns empty hits with overlay status', async () => {
    // 级联 miss 专测：semantic 增强层钉死禁用（真实向量库在 miss tag 上的命中属 semantic 行为，另测）
    setVectorSearch(null);
    try {
      const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'zzzzzzzzq' })));
      expect(raw.hits).toEqual([]);
      expect(raw.overlay.status).toBe('unavailable');
      expect(raw.overlay.advisory).toContain('overlay_unavailable');
    } finally {
      setVectorSearch(null);
    }
  });

  it('limit respected and clamped to 1..20', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair', limit: 1 })));
    expect(raw.hits.length).toBe(1);
    const raw2 = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair', limit: 99 })));
    expect(raw2.hits.length).toBe(5);
  });

  it('unknown mode tolerates as auto', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silvery hair', mode: 'bogus' })));
    expect(raw.hits[0].match_type).toBe('canonical');
  });

  it('G5: fuzzy hits carry candidate=true; canonical without', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair', limit: 3 })));
    for (const h of raw.hits) expect(h.candidate).toBe(h.match_type === 'fuzzy');
  });

  it('G5: fuzzy_below_threshold advisory when usage_count < 1000', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair', limit: 5 })));
    const lowUse = (raw.hits ?? []).some((h: any) => h.match_type === 'fuzzy' && (h.usage_count ?? 0) < 1000);
    if (lowUse) expect((raw.advisories ?? []).some((a: string) => a.includes('fuzzy_below_threshold'))).toBe(true);
  });

  it('G4: manifest status surfaced in output', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: '1girl' })));
    expect(raw.manifest).toBeDefined();
    expect(typeof raw.manifest.ok).toBe('boolean');
  });

  it('semantic passthrough: score/text_source flow into result.hits (spec §3.2)', async () => {
    // 真实 catalog 必 miss 的 tag + stub 向量层指向真实 record（JOIN 一定成功）
    const seed = searchCatalogSync('twintails', { mode: 'canonical', limit: 1 })[0]; // usage 1.31M——语义 usage 门后存活种子
    if (!seed?.record_id) throw new Error('fixture seed missing: twintails');
    const seedId: string = seed.record_id;
    setVectorSearch(async (q) =>
      q === 'zzzzzzzzq' ? [{ record_id: seedId, score: 0.82, text_source: 'wiki' as const }] : [],
    );
    try {
      const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'zzzzzzzzq' })));
      expect(raw.hits[0].match_type).toBe('semantic');
      expect(raw.hits[0].score).toBe(0.82);
      expect(raw.hits[0].text_source).toBe('wiki');
      expect(raw.hits[0].prompt_form).toBe('twintails');
      expect(raw.hits[0].candidate).toBe(false); // candidate 标记仍只认 fuzzy
    } finally {
      setVectorSearch(null);
    }
  });

  it('semantic passthrough: mode values unchanged — exact never reaches semantic level (YAGNI: no semantic mode)', async () => {
    let semanticQueried = false;
    setVectorSearch(async () => {
      semanticQueried = true;
      return [];
    });
    try {
      const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'zzzzzzzzq', mode: 'exact' })));
      expect(raw.hits).toEqual([]);
      expect(semanticQueried).toBe(false);
    } finally {
      setVectorSearch(null);
    }
  });

  afterAll(() => closeCatalog());
});
