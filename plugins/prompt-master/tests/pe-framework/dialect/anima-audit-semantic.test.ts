import { describe, expect, it } from 'vitest';
import { auditAnima, applyCanonicalSubstitutions } from '../../../src/pe-framework/dialect/anima.js';
import type { CatalogHit } from '../../../src/pe-framework/dialect/anima-catalog.js';

const semHit = (pf: string): CatalogHit[] => [
  { match_type: 'semantic', prompt_form: pf, score: 0.8, text_source: 'wiki' },
];

describe('audit semantic fallback (spec §3.2)', () => {
  it('semantic top-hit suppresses catalog_miss and emits semantic_fallback advisory', () => {
    const gates = auditAnima('水手服', '', { slots: { appearance: ['水手服'] }, search: () => semHit('serafuku') });
    expect(gates.some((g) => g.rule === 'catalog_miss' && g.detail.includes('水手服'))).toBe(false);
    expect(gates.some((g) => g.detail.includes('semantic_fallback:水手服→serafuku'))).toBe(true);
  });

  it('true miss (no hits at all) still emits catalog_miss', () => {
    const gates = auditAnima('totallyfaketag', '', { slots: { appearance: ['totallyfaketag'] }, search: () => [] });
    expect(gates.some((g) => g.rule === 'catalog_miss' && g.detail.includes('catalog_miss:totallyfaketag'))).toBe(true);
  });

  it('semantic hit does NOT auto-substitute the original text (F2 unchanged)', () => {
    const r = applyCanonicalSubstitutions('masterpiece, 水手服', '', {
      slots: { appearance: ['水手服'] },
      search: () => semHit('serafuku'),
    });
    expect(r.positive).toContain('水手服');
    expect(r.corrections).toBe(0);
  });
});
