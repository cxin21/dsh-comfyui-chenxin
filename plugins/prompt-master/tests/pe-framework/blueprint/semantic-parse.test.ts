import { describe, expect, it } from 'vitest';
import { parseSemanticBlueprint } from '../../../src/pe-framework/blueprint/analyzer.js';

const GOOD = {
  schema_version: 1,
  media: 'image',
  core: {
    concept: 'a girl on a rooftop at dusk',
    scene: { environment: 'rooftop', time_of_day: 'dusk', weather: 'clear', lighting_idea: 'warm sunset glow' },
    style_hints: ['retro anime cel shading'],
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
  negative_hints: [],
};

describe('parseSemanticBlueprint (spec §3)', () => {
  it('valid JSON → { semantic, missing }', () => {
    const r = parseSemanticBlueprint(JSON.stringify(GOOD));
    expect(r.semantic.subjects[0].id).toBe('S1');
    expect(r.missing).toEqual([]);
  });
  it('fenced/wrapped text tolerated (loose brace extraction)', () => {
    const r = parseSemanticBlueprint(`好的，以下是蓝图：\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\`\n以上。`);
    expect(r.semantic.core.concept).toContain('rooftop');
  });
  it('tag-form word in field → throw tag_in_blueprint with paths', () => {
    const bad = { ...GOOD, subjects: [{ ...GOOD.subjects[0], appearance: 'long_hair, blue eyes' }] };
    expect(() => parseSemanticBlueprint(JSON.stringify(bad))).toThrow(/^tag_in_blueprint:1:/);
  });
  it('schema violation → throw with error detail', () => {
    expect(() => parseSemanticBlueprint('{"schema_version":2}')).toThrow(/语义蓝图校验失败/);
  });
  it('non-JSON → throw parse error', () => {
    expect(() => parseSemanticBlueprint('hello world no braces')).toThrow(/语义蓝图输出非 JSON/);
  });
});
