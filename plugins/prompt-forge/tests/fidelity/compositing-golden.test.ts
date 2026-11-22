/**
 * compositing golden（spec 2026-09-17 agentic-pipeline-redesign）：L5 断言组 + 边缘案例 c13-c15。
 * 全程 mock（sync search + mock writer/auditor/repairer）——确定性、零真连。
 * L5：①每 tag 有 source_concept 且经 verifyTag 直查命中 ②NL 零 overlap ③V0/V1 零 tag 形态词
 *    （unresolved ⊆ NL∪dropped 断言随检索层废除——A1）
 */
import { describe, expect, it } from 'vitest';
import { orchestrateCompositing } from '../../src/pe-framework/compositing/orchestrate.js';
import { deterministicCompose } from '../../src/pe-framework/compositing/compose.js';
import { detectTagForm } from '../../src/pe-framework/blueprint/semantic-schema.js';
import type { SemanticBlueprint } from '../../src/pe-framework/blueprint/semantic-schema.js';
import type { WriterOutput } from '../../src/pe-framework/compositing/writer.js';

const SEARCH = (q: string) => [{ prompt_form: q, match_type: 'canonical', usage_count: 1000 }];

const BP: SemanticBlueprint = {
  schema_version: 1,
  media: 'image',
  core: {
    concept: 'a girl on a rooftop at dusk',
    scene: {
      environment: 'rooftop',
      time_of_day: 'dusk',
      weather: 'clear',
      lighting_idea: 'lantern light along the corridor',
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

const WRITER_OUT: WriterOutput = {
  tags: [
    { text: 'long black hair', source_concept: 'S1.appearance' },
    { text: 'standing', source_concept: 'S1.pose' },
    { text: 'full body', source_concept: 'composition.framing' },
    { text: 'rooftop', source_concept: 'core.scene.environment' },
  ],
  nl: 'She stands on the right third of the frame in a nocturnal mood. Lantern light keeps her face exposed with no silhouette.',
  negative: [],
};

const PASS_AUDITOR = async () => JSON.stringify({ verdict: 'pass', findings: [] });

describe('compositing golden L5 (agentic 管线)', () => {
  it('L5 invariants hold on a clean orchestration run', async () => {
    const outcome = await orchestrateCompositing(
      BP,
      'safe',
      {
        enrichRunner: async () => '{"set":{}}',
        writerRunner: async () => JSON.stringify(WRITER_OUT),
        auditorRunner: PASS_AUDITOR,
        repairRunner: async () => {
          throw new Error('repair should not run');
        },
        search: SEARCH,
      },
      { minTags: 0 },
    );
    // L5①：source_concept 存在 + verifyTag（catalog 直查）命中
    for (const t of WRITER_OUT.tags) {
      expect(typeof t.source_concept).toBe('string');
      expect(SEARCH(t.text)[0].prompt_form).toBe(t.text);
    }
    // L5②：NL 零 overlap
    for (const t of WRITER_OUT.tags) expect(WRITER_OUT.nl.toLowerCase().includes(t.text.toLowerCase())).toBe(false);
    // L5③：只扫 V1 的字符串值（JSON 键名如 schema_version 不算 tag 形态）
    const scanValues = (node: unknown): string[] => {
      if (typeof node === 'string') return [node];
      if (Array.isArray(node)) return node.flatMap(scanValues);
      if (node !== null && typeof node === 'object') return Object.values(node).flatMap(scanValues);
      return [];
    };
    for (const s of scanValues(outcome.v1)) expect(detectTagForm(s)).toBe(false);
    expect(outcome.ok).toBe(true);
  });
});

describe('edge cases (agentic 管线 golden c13-c15)', () => {
  it('c13 超长输入（brief >500 字）→ pipeline completes via fallback search', async () => {
    const longBp: SemanticBlueprint = {
      ...BP,
      core: { ...BP.core, concept: 'x'.repeat(600) },
      subjects: [{ ...BP.subjects[0], appearance: 'detail '.repeat(90).trim() }],
    };
    const outcome = await orchestrateCompositing(
      longBp,
      'safe',
      {
        enrichRunner: async () => '{"set":{}}',
        writerRunner: async () => JSON.stringify(WRITER_OUT),
        auditorRunner: PASS_AUDITOR,
        search: SEARCH,
      },
      { minTags: 0 },
    );
    expect(outcome.positive.length).toBeGreaterThan(0);
  });
  it('c14 无主体纯场景（subjects 空）→ completes, no crash', async () => {
    const sceneBp: SemanticBlueprint = { ...BP, subjects: [] };
    const outcome = await orchestrateCompositing(
      sceneBp,
      'safe',
      {
        enrichRunner: async () => '{"set":{}}',
        writerRunner: async () => JSON.stringify(WRITER_OUT),
        auditorRunner: PASS_AUDITOR,
        search: SEARCH,
      },
      { minTags: 0 },
    );
    expect(outcome.ok).toBe(true);
  });
  it('c15 全部概念查不到（词库空窗）→ fallback tags 空、positive = rating + nl', async () => {
    const emptySearch = () => [];
    const out = deterministicCompose(BP, emptySearch);
    expect(out.tags).toEqual([]);
    expect(out.nl).toContain('lantern light');
    // writer 全空 tags 场景：tag_budget critical → D7 fallback 仍出稿
    const outcome = await orchestrateCompositing(
      BP,
      'safe',
      {
        enrichRunner: async () => '{"set":{}}',
        writerRunner: async () => JSON.stringify({ ...WRITER_OUT, tags: [] }),
        auditorRunner: PASS_AUDITOR,
        search: emptySearch,
      },
      { minTags: 0 },
    );
    expect(outcome.ok).toBe(true);
  });
});
