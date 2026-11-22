import { describe, expect, it } from 'vitest';
import { auditCompositing, type AuditOptions } from '../../../src/pe-framework/compositing/audit.js';
import type { WriterOutput } from '../../../src/pe-framework/compositing/writer.js';
import type { SemanticBlueprint } from '../../../src/pe-framework/blueprint/semantic-schema.js';

const BP: SemanticBlueprint = {
  schema_version: 1,
  media: 'image',
  core: {
    concept: 'a girl on a rooftop at dusk',
    scene: {
      environment: 'rooftop',
      time_of_day: 'dusk',
      weather: 'clear',
      lighting_idea: 'paper lanterns along the corridor keep her face exposed',
    },
    style_hints: [],
  },
  subjects: [
    {
      id: 'S1',
      count: 1,
      identity: 'a girl',
      appearance: 'long black hair',
      pose: 'standing',
      expression: 'soft smile',
    },
  ],
  composition: { framing: 'full body', camera_angle: 'eye level', placement: 'right third' },
  mood: 'nocturnal',
  negative_hints: [],
};

/** 合法满额产物：22 tags（verifyTag 全过）+ 3 句 NL（无复述） */
const OUT: WriterOutput = {
  tags: [
    { text: 'long hair', source_concept: 'S1.appearance' },
    { text: 'black hair', source_concept: 'S1.appearance' },
    { text: 'standing', source_concept: 'S1.pose' },
    { text: 'paper lanterns', source_concept: 'core.scene.lighting_idea' },
    ...Array.from({ length: 18 }, (_, i) => ({
      text: `filler${String(i).padStart(2, '0')}`,
      source_concept: 'fillers',
    })),
  ],
  nl: 'The girl sits on the right third of the frame. Lantern light along the corridor keeps her face exposed with no silhouette. The mood is nocturnal and confident.',
  negative: [],
};
const OPTS: AuditOptions = { rating: 'safe', minTags: 0, verifyTag: () => true };

describe('auditCompositing (agentic 管线：bp + verifyTag 直查)', () => {
  it('clean fixture → zero critical gates', () => {
    const gates = auditCompositing(OUT, BP, OPTS);
    expect(gates.filter((g) => g.severity === 'critical')).toEqual([]);
  });

  it('A5 fabricated_tag：verifyTag 拒绝 → critical（catalog 直查语义）', () => {
    const bad = {
      ...OUT,
      tags: [...OUT.tags.slice(0, 5), { text: 'neon glow', source_concept: 'S1.pose' }, ...OUT.tags.slice(5)],
    };
    const gates = auditCompositing(bad, BP, { ...OPTS, verifyTag: (t) => t !== 'neon glow' });
    const g = gates.find((x) => x.rule === 'fabricated_tag');
    expect(g?.severity).toBe('critical');
    expect(g?.detail).toContain('neon glow');
    expect(g?.detail).toContain('not verified in catalog');
  });

  it('verifyTag 缺省 → fabricated_tag 门跳过（降级语义）', () => {
    const bad = {
      ...OUT,
      tags: [...OUT.tags.slice(0, 5), { text: 'neon glow', source_concept: 'S1.pose' }, ...OUT.tags.slice(5)],
    };
    const gates = auditCompositing(bad, BP, { rating: 'safe', minTags: 0 });
    expect(gates.some((g) => g.rule === 'fabricated_tag')).toBe(false);
  });

  it('duplicate_tag → critical', () => {
    const bad = {
      ...OUT,
      tags: [
        { text: 'long hair', source_concept: 'S1.appearance' },
        { text: 'Long Hair', source_concept: 'S1.appearance' },
        ...OUT.tags.slice(2),
      ],
    };
    const gates = auditCompositing(bad, BP, OPTS);
    expect(gates.some((g) => g.rule === 'duplicate_tag' && g.severity === 'critical')).toBe(true);
  });

  it('tag_budget：数量下限 critical（writer 可查字典，20 恢复硬门）', () => {
    const few = { ...OUT, tags: OUT.tags.slice(0, 3) };
    expect(
      auditCompositing(few, BP, { rating: 'safe', verifyTag: () => true }).some(
        (g) => g.rule === 'tag_budget' && g.severity === 'critical',
      ),
    ).toBe(true);
  });

  it('tag_budget：字符超限 critical', () => {
    const long = { ...OUT, nl: 'x'.repeat(1300) };
    expect(auditCompositing(long, BP, OPTS).some((g) => g.rule === 'tag_budget' && g.detail.includes('chars'))).toBe(
      true,
    );
  });

  it('nl_tag_overlap：词面复述 → critical', () => {
    const bad = { ...OUT, nl: 'Her long black hair flows in the wind.' };
    const gates = auditCompositing(bad, BP, OPTS);
    expect(gates.some((g) => g.rule === 'nl_tag_overlap' && g.severity === 'critical')).toBe(true);
  });

  it('nl_tag_overlap：向量层注入（sim ≥ 阈值）→ critical；无向量层 → advisory 留痕', () => {
    const bad = { ...OUT, nl: 'Her hair flows in the wind while she poses.' };
    const gatesVec = auditCompositing(bad, BP, {
      ...OPTS,
      vectorSim: (s: string, t: string) => (t === 'long hair' && s.includes('hair flows') ? 0.92 : 0.1),
    });
    expect(gatesVec.some((g) => g.rule === 'nl_tag_overlap' && g.detail.includes('semantically'))).toBe(true);
    const gatesNoVec = auditCompositing(bad, BP, OPTS);
    expect(gatesNoVec.some((g) => g.rule === 'overlap_vector_unavailable')).toBe(true);
  });

  it('unresolved_dropped 门已废除（A1 检索层拆除）', () => {
    const gates = auditCompositing(OUT, BP, OPTS);
    expect(gates.some((g) => g.rule === 'unresolved_dropped')).toBe(false);
  });

  it('mutual_exclusion → important（solo + 1boy 并存）', () => {
    const bad = {
      ...OUT,
      tags: [
        { text: 'solo', source_concept: 'S1.count' },
        { text: '1boy', source_concept: 'S1.count' },
        ...OUT.tags.slice(0, 3),
      ],
    };
    const gates = auditCompositing(bad, BP, { ...OPTS, verifyTag: () => true });
    expect(gates.some((g) => g.rule === 'mutual_exclusion')).toBe(true);
  });

  it('lighting_term_banned → critical', () => {
    const bad = { ...OUT, nl: 'Rim light wraps her silhouette.' };
    const gates = auditCompositing(bad, BP, OPTS);
    expect(gates.some((g) => g.rule === 'lighting_term_banned' && g.severity === 'critical')).toBe(true);
  });

  it('cjk_in_positive → critical', () => {
    const bad = { ...OUT, nl: '她站在屋顶。' };
    const gates = auditCompositing(bad, BP, OPTS);
    expect(gates.some((g) => g.rule === 'cjk_in_positive' && g.severity === 'critical')).toBe(true);
  });

  it('rating_seed：结构恒真（assemblePositive 恒前置档位种子）——文档化死门', () => {
    // assemblePositive(out, rating) 恒以 rating_<档位> 开头 → 本门对组装产物恒过。
    // 保留为防御性谓词（若未来拼装层变更，此门是最后防线）。
    const gates = auditCompositing(OUT, BP, { ...OPTS, rating: 'explicit' });
    expect(gates.some((g) => g.rule === 'rating_seed')).toBe(false);
  });

  it('artist_whitelist：@tag 未验证 → critical', () => {
    const bad = {
      ...OUT,
      tags: [...OUT.tags.slice(0, 5), { text: '@as109', source_concept: 'core.style_hints[0]' }, ...OUT.tags.slice(5)],
    };
    const gates = auditCompositing(bad, BP, { ...OPTS, verifyTag: (t) => t !== '@as109' });
    expect(gates.some((g) => g.rule === 'artist_whitelist' && g.severity === 'critical')).toBe(true);
  });

  it('tag_in_blueprint：蓝图字段含 tag 形态词 → critical', () => {
    const bpClose = { ...BP, subjects: [{ ...BP.subjects[0], appearance: '1girl, long hair' }] };
    const gates = auditCompositing(OUT, bpClose, OPTS);
    expect(gates.some((g) => g.rule === 'tag_in_blueprint' && g.severity === 'critical')).toBe(true);
  });
});
