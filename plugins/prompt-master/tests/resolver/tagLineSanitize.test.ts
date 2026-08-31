// tagLineSanitize 单元测试 — 1:1 移植自 PM tagLineSanitize.js
import { describe, it, expect } from 'vitest';
import { cleanTagLineBody, isHexGarbageToken, unwrapBracketNotation } from '../../src/resolver/profiles/reverse/tagLineSanitize.js';

describe('tagLineSanitize.isHexGarbageToken', () => {
  it('纯数字/长 hex 视为垃圾', () => {
    expect(isHexGarbageToken('2')).toBe(true);
    expect(isHexGarbageToken('1f1f3b')).toBe(true);
    expect(isHexGarbageToken('1f1f3b1f1f3b')).toBe(true);
  });
  it('前缀 token 与 count 不是垃圾', () => {
    expect(isHexGarbageToken('artist:unknown')).toBe(false);
    expect(isHexGarbageToken('1girl')).toBe(false);
  });
});

describe('tagLineSanitize.cleanTagLineBody', () => {
  it('去方括号并规范化（danbooru 下划线→空格）', () => {
    const out = cleanTagLineBody('[long hair] 1girl long_hair', { type: 'Danbooru_tag_list' });
    expect(out).toContain('long hair');
    expect(out).not.toContain('long_hair');
    expect(out).not.toContain('[');
  });

  it('去重且丢弃 hex 垃圾', () => {
    const out = cleanTagLineBody('1girl, 1girl, brown hair, brown hair, 1f1f3b, solo');
    expect(out.split(', ').filter((t) => t === '1girl').length).toBe(1);
    expect(out).not.toContain('1f1f3b');
  });

  it('质量词前缀去重', () => {
    const out = cleanTagLineBody('best quality, 1girl, solo', {
      type: 'Stable_Diffusion_Prompt',
      quality_prompt_enabled: true,
      quality_prompt_prefix: 'best quality',
    });
    expect(out).not.toContain('best quality');
  });
});

describe('tagLineSanitize.unwrapBracketNotation', () => {
  it('把 [girl] 展开为 girl 并接续其余 token（SD 保留下划线）', () => {
    const out = unwrapBracketNotation('1girl [solo] long_hair', false);
    expect(out).toContain('solo');
    expect(out).not.toContain('[');
    expect(out).toContain('1girl');
  });

  it('danbooru 模式把下划线改为空格', () => {
    const out = unwrapBracketNotation('1girl [solo] long_hair', true);
    expect(out).toContain('long hair');
    expect(out).not.toContain('[');
  });
});
