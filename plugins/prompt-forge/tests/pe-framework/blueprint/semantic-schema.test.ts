import { describe, expect, it } from 'vitest';
import { validateSemanticBlueprint, detectTagForm } from '../../../src/pe-framework/blueprint/semantic-schema.js';

const GOOD = {
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
    style_hints: ['retro anime cel shading'],
  },
  subjects: [
    {
      id: 'S1',
      count: 1,
      identity: 'a girl',
      appearance: 'long black hair, school uniform',
      pose: 'standing, looking back',
      expression: 'soft smile',
    },
  ],
  composition: { framing: 'cowboy shot', camera_angle: 'from below', placement: 'right third' },
  mood: 'nocturnal, confident',
  negative_hints: [],
};

describe('validateSemanticBlueprint (spec §3)', () => {
  it('valid blueprint passes with empty missing', () => {
    const r = validateSemanticBlueprint(GOOD);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.missing).toEqual([]);
  });
  it('media!=image rejected', () => {
    expect(validateSemanticBlueprint({ ...GOOD, media: 'video' }).ok).toBe(false);
  });
  it('empty subjects tolerated (pure-scene c14) with missing advisory', () => {
    const r = validateSemanticBlueprint({ ...GOOD, subjects: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.missing).toContain('subjects');
  });
  it('duplicate subject id rejected', () => {
    const bp = { ...GOOD, subjects: [GOOD.subjects[0], { ...GOOD.subjects[0] }] };
    expect(validateSemanticBlueprint(bp).ok).toBe(false);
  });
  it('missing mood tolerated as empty missing advisory, not error', () => {
    const { mood: _mood, ...rest } = GOOD;
    const r = validateSemanticBlueprint(rest);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.missing).toContain('mood');
  });
  it('non-object rejected', () => {
    expect(validateSemanticBlueprint('x').ok).toBe(false);
  });
});

describe('envelope 形状漂移归一化（spec §3 修订 2026-09-16 活跑实证）', () => {
  it('schema_version 缺失 → 补 1', () => {
    const { schema_version: _schema_version, ...rest } = GOOD;
    const r = validateSemanticBlueprint(rest);
    expect(r.ok).toBe(true);
  });
  it('media 缺失 → 补 image', () => {
    const { media: _media, ...rest } = GOOD;
    const r = validateSemanticBlueprint(rest);
    expect(r.ok).toBe(true);
  });
  it('subjects 为对象（按 id 键控）→ 归一化为数组', () => {
    const r = validateSemanticBlueprint({ ...GOOD, subjects: { S1: GOOD.subjects[0] } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bp.subjects[0].id).toBe('S1');
  });
  it('subject 缺 id/count → 自动编号与缺省 count', () => {
    const r = validateSemanticBlueprint({
      ...GOOD,
      subjects: [{ identity: 'a girl', appearance: 'long black hair', pose: 'standing', expression: 'smile' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bp.subjects[0].id).toBe('S1');
      expect(r.bp.subjects[0].count).toBe(1);
    }
  });
  it('mood/negative_hints 缺失 → 补空缺省', () => {
    const r = validateSemanticBlueprint({ ...GOOD, mood: undefined, negative_hints: undefined });
    expect(r.ok).toBe(true);
  });
  it('media 错误值（video）仍拒绝——语义方向不归一化', () => {
    expect(validateSemanticBlueprint({ ...GOOD, media: 'video' }).ok).toBe(false);
  });
});

describe('detectTagForm (spec §3 D3)', () => {
  it('plain english phrases pass', () => {
    expect(detectTagForm('long black hair')).toBe(false);
    expect(detectTagForm('warm sunset glow from the west')).toBe(false);
  });
  it('tag forms flagged', () => {
    expect(detectTagForm('long_hair')).toBe(true);
    expect(detectTagForm('1girl')).toBe(true);
    expect(detectTagForm('2girls')).toBe(true);
    expect(detectTagForm('@as109')).toBe(true);
    expect(detectTagForm('score_9')).toBe(true);
  });
  it('flagged inside longer text', () => {
    expect(detectTagForm('she has long_hair and a hat')).toBe(true);
  });
});
