// Resolver 扩写管线测试 — 不调用 LLM（纯 assemble 层）
import { describe, it, expect } from 'vitest';
import { resolveExpand } from '../../src/resolver/index.js';
import { findProfileById, getDefaultBuiltinProfiles } from '../../src/resolver/profiles/index.js';
import { expandInputs, expandProfileIds } from '../fixtures/test-data.js';

describe('resolveExpand', () => {
  it('内置 expand_natural 生成合理 system/user 且含输入文本', () => {
    const profile = findProfileById(expandProfileIds.natural)!;
    expect(profile).toBeTruthy();
    const r = resolveExpand(profile, {
      outputLang: 'zh',
      expandLen: 'medium',
      shortText: expandInputs.natural,
    });
    expect(r.system.length).toBeGreaterThan(100);
    expect(r.user).toContain(expandInputs.natural);
    expect(r.maxTokens).toBeGreaterThan(0);
    expect(r.ruleId).toBe('expand_natural');
  });

  it('不同篇幅预设影响 maxTokens', () => {
    const profile = findProfileById(expandProfileIds.natural)!;
    const short = resolveExpand(profile, { outputLang: 'zh', expandLen: 'very_short', shortText: 'x' });
    const long = resolveExpand(profile, { outputLang: 'zh', expandLen: 'very_long', shortText: 'x' });
    expect(short.maxTokens).toBeLessThan(long.maxTokens);
  });

  it('8 种内置扩写 profile 全部可解析', () => {
    const all = getDefaultBuiltinProfiles();
    const exp = all.filter((p) => p.kind === 'expand' && p.builtinKey && String(p.builtinKey).startsWith('expand_'));
    expect(exp.length).toBe(8);
    expect(exp.map((p) => p.builtinKey).sort()).toEqual([
      'expand_cinematic', 'expand_compact', 'expand_danbooru', 'expand_descriptive_en',
      'expand_natural', 'expand_photographer', 'expand_structured_json', 'expand_structured_md',
    ]);
  });

  it('SD/结构化 profile 返回对应 outputFormat', () => {
    const md = findProfileById(expandProfileIds.structuredMd)!;
    expect(md.outputFormat).toBe('structured_md');
    const sdc = findProfileById(expandProfileIds.compact)!;
    expect(sdc.outputFormat).toBe('sd_tags');
  });
});
