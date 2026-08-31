// Resolver 反推管线 + 最终清洗测试 — 不调用 LLM
import { describe, it, expect } from 'vitest';
import { resolveReverse } from '../../src/resolver/index.js';
import { findProfileById } from '../../src/resolver/profiles/index.js';
import { sanitizeFinalCaption, resolveMaxNewTokens } from '../../src/resolver/profiles/reverse/router.js';
import { reverseProfileIds } from '../fixtures/test-data.js';

describe('resolveReverse', () => {
  it('Descriptive 反推返回五点结构 system + captionType', () => {
    const profile = findProfileById(reverseProfileIds.descriptive)!;
    const r = resolveReverse(profile, {
      caption_lang: 'zh',
      len: 'medium',
      media_target: 'image',
    });
    expect(r.captionType).toBe('Descriptive');
    expect(r.system.length).toBeGreaterThan(50);
    expect(r.userLead).toBeTruthy();
  });

  it('SD 反推返回标签式 system，含输出契约', () => {
    const profile = findProfileById(reverseProfileIds.sd)!;
    const r = resolveReverse(profile, {
      caption_lang: 'en',
      len: 'medium',
      media_target: 'image',
    });
    expect(r.captionType).toBe('Stable_Diffusion_Prompt');
    expect(r.outputConstraints).toContain('CONTRACT');
  });

  it('resolveMaxNewTokens 随篇幅与类型变化', () => {
    const base = { type: 'Stable_Diffusion_Prompt', len: 'medium', caption_lang: 'en' };
    const maxCaps = 1024;
    const short = resolveMaxNewTokens({ ...base, len: 'short' }, { reverseMax: maxCaps });
    const long = resolveMaxNewTokens({ ...base, len: 'long' }, { reverseMax: maxCaps });
    expect(short).toBeLessThan(long);
    expect(long).toBeLessThanOrEqual(maxCaps);
  });
});

describe('sanitizeFinalCaption', () => {
  it('散文类去除 Markdown / 列表 / 数字编号并合并为一段', () => {
    const out = sanitizeFinalCaption('**标题**\n- 点1\n- 点2\n3) 点3', {
      type: 'Descriptive',
      caption_lang: 'zh',
    });
    expect(out).not.toContain('**');
    expect(out).not.toContain('- 点');
    expect(out).not.toContain('3)');
    expect(out).toContain('点1');
    expect(out).toContain('点3');
  });

  it('Danbooru 展开方括号、去 hex 垃圾、去下划线、去重', () => {
    const out = sanitizeFinalCaption(
      'artist:unknown, copyright:original, character:none, 1girl, [long hair], 1f1f3b, long_hair, 1girl',
      { type: 'Danbooru_tag_list', caption_lang: 'en', len: 'medium' }
    );
    expect(out).toContain('long hair');
    expect(out).not.toContain('[long hair]');
    expect(out).not.toContain('long_hair');
    expect(out).not.toContain('1f1f3b');
    expect(out.split(', ').filter((t) => t === '1girl').length).toBe(1);
  });

  it('SD + 质量词前缀只出现一次（不重复前置）', () => {
    const out = sanitizeFinalCaption('best quality, 1girl, solo', {
      type: 'Stable_Diffusion_Prompt',
      caption_lang: 'en',
      quality_prompt_enabled: true,
      quality_prompt_prefix: 'best quality',
    });
    expect(out.startsWith('best quality')).toBe(true);
    expect((out.match(/best quality/g) || []).length).toBe(1);
  });
});
