import { describe, expect, it } from 'vitest';
import { applySemanticPatch } from '../../../src/pe-framework/compositing/enrich.js';
import type { SemanticBlueprint } from '../../../src/pe-framework/blueprint/semantic-schema.js';

// A7（spec 2026-09-17 agentic-pipeline-redesign）：enrich patch 值类型校验
// 活跑实证（会话 158642b0 run1）：additions.core.mood = 对象 → deepMerge 覆写字符串 mood
// → S2.5 `bp.mood.trim()` TypeError → 整个 prompt_author 硬崩（14 秒失败）。

const V0: SemanticBlueprint = {
  schema_version: 1,
  media: 'image',
  core: {
    concept: 'c',
    scene: { environment: 'e', time_of_day: 'd', weather: 'w', lighting_idea: 'l' },
    style_hints: ['cel'],
  },
  subjects: [],
  composition: { framing: 'f', camera_angle: 'a', placement: 'p' },
  mood: 'mood original',
  negative_hints: [],
};

describe('enrich patch 值类型守卫（A7）', () => {
  it('additions.mood（根级白名单路径）对象 → 确定性丢弃 + enrich_type_violation，mood 保持字符串（run1 崩溃场景）', () => {
    const raw = JSON.stringify({
      set: { mood: 'mood original, quietly tense' },
      additions: { mood: { palette: 'warm amber', texture: ['chrome'], particles: ['dust'] } },
    });
    const { v1, advisories } = applySemanticPatch(V0, raw);
    expect(typeof v1.mood).toBe('string');
    expect(v1.mood).toBe('mood original, quietly tense');
    expect(advisories.some((a) => a.startsWith('enrich_type_violation:'))).toBe(true);
  });

  it('additions.core.mood 对象（越权路径）→ prune 剥离（path violation），mood 保持字符串', () => {
    const raw = JSON.stringify({
      set: { mood: 'mood original, quietly tense' },
      additions: { core: { mood: { palette: 'warm amber' } } },
    });
    const { v1, advisories } = applySemanticPatch(V0, raw);
    expect(typeof v1.mood).toBe('string');
    expect(advisories).toContain('enrich_path_violation:1');
  });

  it('set.mood 对象 → 同样丢弃（set 路径同守卫）', () => {
    const raw = JSON.stringify({ set: { mood: { bad: true } } });
    const { v1, advisories } = applySemanticPatch(V0, raw);
    expect(typeof v1.mood).toBe('string');
    expect(advisories.some((a) => a.startsWith('enrich_type_violation:'))).toBe(true);
  });

  it('set.lighting_idea 对象数组 → 丢弃，原字符串保留', () => {
    const raw = JSON.stringify({ set: { core: { scene: { lighting_idea: ['neon', 'lantern'] } } } });
    const { v1, advisories } = applySemanticPatch(V0, raw);
    expect(v1.core.scene.lighting_idea).toBe('l');
    expect(advisories.some((a) => a.startsWith('enrich_type_violation:'))).toBe(true);
  });

  it('合法字符串 patch 正常应用（无 violation）', () => {
    const raw = JSON.stringify({ set: { mood: 'mood original, quietly tense' } });
    const { v1, advisories } = applySemanticPatch(V0, raw);
    expect(v1.mood).toBe('mood original, quietly tense');
    expect(advisories).toEqual([]);
  });

  it('additions-only patch（无 set 键）不产生虚假 path violation（audit F7）', () => {
    // 既有 quirk：set 回退取整个 parsed → prune 把 additions 键本身误计 1 次越权
    const raw = JSON.stringify({ additions: { core: { style_hints: ['flat colors'] } } });
    const { v1, advisories } = applySemanticPatch(V0, raw);
    expect(v1.core.style_hints).toEqual(['cel', 'flat colors']);
    expect(advisories).toEqual([]);
  });

  it('additions.style_hints 数组追加语义保持（concat 去重）', () => {
    const raw = JSON.stringify({
      set: { mood: 'mood original' },
      additions: { core: { style_hints: ['flat colors'] } },
    });
    const { v1, advisories } = applySemanticPatch(V0, raw);
    expect(v1.core.style_hints).toEqual(['cel', 'flat colors']);
    expect(advisories).toEqual([]);
  });
});
