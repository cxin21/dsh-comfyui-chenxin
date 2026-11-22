import { describe, expect, it } from 'vitest';
import { buildCompositingJudgePrompt } from '../../../src/pe-framework/eval/rubrics/compositing.js';
import type { WriterOutput } from '../../../src/pe-framework/compositing/writer.js';
import type { SemanticBlueprint } from '../../../src/pe-framework/blueprint/semantic-schema.js';
import type { RetrievalPack } from '../../../src/pe-framework/dialect/retrieval-pack.js';

const OUT: WriterOutput = {
  tags: [{ text: 'long hair', source_concept: 'S1.appearance' }],
  nl: 'She stands in the right third.',
  negative: [],
  dropped_concepts: [],
};
const BP: SemanticBlueprint = {
  schema_version: 1,
  media: 'image',
  core: {
    concept: 'c',
    scene: { environment: 'e', time_of_day: 'd', weather: 'w', lighting_idea: 'l' },
    style_hints: [],
  },
  subjects: [],
  composition: { framing: 'f', camera_angle: 'a', placement: 'p' },
  mood: 'm',
  negative_hints: [],
};
const PACK: RetrievalPack = { evidence: [], unresolved: [], artists: [], mutual_exclusion_pairs: [], truncated: [] };

describe('buildCompositingJudgePrompt previousFindings（audit P4a：跨轮去重）', () => {
  it('缺省不注入 previous_findings 块（首轮/无 findings 零变化）', () => {
    const p = buildCompositingJudgePrompt(OUT, BP, PACK);
    expect(p.user).not.toContain('<previous_findings>');
  });

  it('非空 previousFindings → prompt 含块 + 去重指令', () => {
    const p = buildCompositingJudgePrompt(OUT, BP, PACK, {
      previousFindings: ['express nocturnal mood in nl', 'replace near-duplicate long hair'],
    });
    expect(p.user).toContain('<previous_findings>');
    expect(p.user).toContain('express nocturnal mood in nl');
    expect(p.user).toContain('replace near-duplicate long hair');
    expect(p.user).toContain('不再报告');
  });
});
