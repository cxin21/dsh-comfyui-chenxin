import { describe, expect, it } from 'vitest';
import { parseWriterOutput, buildWriterPrompt, WRITER_PERSONA } from '../../../src/pe-framework/compositing/writer.js';
import {
  assemblePositive,
  assembleNegative,
  deterministicCompose,
} from '../../../src/pe-framework/compositing/compose.js';
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
      lighting_idea: 'warm sunset glow from the west',
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
  composition: { framing: 'cowboy shot', camera_angle: 'from below', placement: 'right third' },
  mood: 'nocturnal',
  negative_hints: ['no modern elements'],
};
const OUT = {
  tags: [{ text: 'long hair', source_concept: 'S1.appearance' }],
  nl: 'The subject sits on the right third of the frame. Warm sunset glow from the west keeps her face exposed with no silhouette.',
  negative: ['no modern elements'],
};

describe('parseWriterOutput (agentic 管线契约)', () => {
  it('valid output parses', () => {
    const r = parseWriterOutput(JSON.stringify(OUT));
    expect(r.tags).toHaveLength(1);
    expect(r.tags[0]).toEqual({ text: 'long hair', source_concept: 'S1.appearance' });
  });
  it('fenced output tolerated', () => {
    expect(parseWriterOutput('```json\n' + JSON.stringify(OUT) + '\n```').nl).toContain('right third');
  });
  it('prose after JSON tolerated（活跑实证：LLM 在 JSON 后追加说明文字）', () => {
    expect(parseWriterOutput(JSON.stringify(OUT) + '\n以上是修复产物。').nl).toContain('right third');
  });
  it('tag without source_concept → contract error citing T2', () => {
    const bad = { ...OUT, tags: [{ text: 'long hair' }] };
    expect(() => parseWriterOutput(JSON.stringify(bad))).toThrow(/source_concept/);
  });
  it('negative with quality word → contract error', () => {
    const bad = { ...OUT, negative: ['worst quality'] };
    expect(() => parseWriterOutput(JSON.stringify(bad))).toThrow(/质量词/);
  });
  it('non-JSON → parse error', () => {
    expect(() => parseWriterOutput('no braces here')).toThrow(/非 JSON/);
  });
  it('dropped_concepts 可缺省（A1：unresolved 出口已废除）', () => {
    const r = parseWriterOutput(JSON.stringify(OUT));
    expect(r.dropped_concepts).toBeUndefined();
  });
});

describe('buildWriterPrompt (agentic：无 evidence 块 + 工具协议)', () => {
  it('sectioned template with blueprint/rules/contract；无 <evidence>（A1）', () => {
    const p = buildWriterPrompt(BP);
    expect(p).toContain('<task_persona>');
    expect(p).toContain('<blueprint_v1>');
    expect(p).toContain('<rules>');
    expect(p).toContain('<output_contract>');
    expect(p).not.toContain('<evidence>');
    expect(p).toContain(WRITER_PERSONA.slice(0, 20));
    expect(p).toContain('catalog_search');
  });
  it('统一格式（spec §1.1）：few-shot 基准块 + 契约三行纪律 + 形状模板', () => {
    const p = buildWriterPrompt(BP);
    expect(p).toContain('【信息密度基准');
    expect(p).toContain('无 markdown fence、无解释、无任何前后缀文字');
    expect(p).toContain('"source_concept"');
  });
});

describe('assemblePositive / assembleNegative (spec §6/§7)', () => {
  it('positive = rating seed + tags + nl', () => {
    const p = assemblePositive(OUT, 'explicit');
    expect(p).toBe(
      'rating_explicit, long hair, The subject sits on the right third of the frame. Warm sunset glow from the west keeps her face exposed with no silhouette.',
    );
  });
  it('negative = template + content negatives, deduped', () => {
    const n = assembleNegative({ ...OUT, negative: ['no modern elements', 'blurry'] });
    expect(n).toContain('worst quality');
    expect(n).toContain('loli');
    expect(n).toContain('no modern elements');
    expect(n.match(/blurry/g)?.length).toBe(1);
  });
});

// A6 回退直查缝
const CANON = (form: string) => [{ prompt_form: form, match_type: 'canonical', usage_count: 1000 }];

describe('deterministicCompose (A6：catalog 直查，无 unresolved 倾泻)', () => {
  it('canonical 命中 → tag；source_concept = fallback.catalog', () => {
    const r = deterministicCompose(BP, (q) => (q === 'long black hair' ? CANON('long hair') : []));
    expect(r.tags).toEqual([{ text: 'long hair', source_concept: 'fallback.catalog' }]);
    expect(r.nl).toContain('right third');
  });
  it('fuzzy/semantic 未验证形式不采纳', () => {
    const r = deterministicCompose(BP, () => [{ prompt_form: 'junk', match_type: 'fuzzy' }]);
    expect(r.tags).toEqual([]);
  });
  it('全查不到 → tags 空、NL 仍由蓝图组装（永不失败）', () => {
    const r = deterministicCompose(BP, () => []);
    expect(r.tags).toEqual([]);
    expect(r.nl.length).toBeGreaterThan(0);
  });
});

describe('deterministicCompose 预算合规（audit P2）', () => {
  const STRESS_BP: SemanticBlueprint = {
    ...BP,
    core: {
      ...BP.core,
      scene: {
        ...BP.core.scene,
        lighting_idea:
          'twin facing storefront neon signs in electric cyan and hot magenta serve as the scene light sources with their glow bouncing off the mirror wet asphalt becoming a second dimmer source lighting her legs from below while a soft cool overhead signage spill keeps her face clearly exposed',
      },
    },
    mood: 'glacial confidence with cinematic nightlife allure and a sense of lonely grandeur under the endless city hum',
  };

  it('positive 总长 ≤ 1200（长词形 tags + 长 NL 压力）', () => {
    let i = 0;
    const r = deterministicCompose(STRESS_BP, () => CANON(`very long tag form number ${i++} with many words here`));
    const p = assemblePositive(r, 'explicit');
    expect(p.length).toBeLessThanOrEqual(1200);
  });

  it('nl 返回截断版本', () => {
    const r = deterministicCompose(STRESS_BP, () => []);
    expect(r.nl.length).toBeLessThanOrEqual(600);
  });

  it('tags 大小写去重', () => {
    let i = 0;
    const r = deterministicCompose(BP, () => CANON(i++ % 2 === 0 ? 'Long Hair' : 'long hair'));
    expect(r.tags).toHaveLength(1);
  });
});
