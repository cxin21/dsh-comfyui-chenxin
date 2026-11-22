// 反推篇幅模块（reverse/length.ts）单元测试 — 1:1 对齐 PM captionLength.js
import { describe, it, expect } from 'vitest';
import {
  resolveCaptionMaxNewTokens,
  resolveCaptionLengthLabel,
  buildCaptionLengthBlock,
  resolveDanbooruLenHint,
  normalizeCaptionLenKeys,
} from '../../src/resolver/profiles/reverse/length.js';

describe('reverse/length — resolveCaptionMaxNewTokens', () => {
  it('SD medium = ceil(512*1) = 512', () => {
    const n = resolveCaptionMaxNewTokens({ type: 'Stable_Diffusion_Prompt', len: 'medium' }, { reverseMax: 1024 });
    // resolveExpandLengthSpec(medium).maxTokens = 512
    expect(n).toBe(512);
  });

  it('Descriptive medium 乘以 1.25 比例', () => {
    const n = resolveCaptionMaxNewTokens({ type: 'Descriptive', len: 'medium' }, { reverseMax: 1024 });
    expect(n).toBe(640);
  });

  it('自定义字符数走 special 分支并用 reverseMax 封顶', () => {
    const n = resolveCaptionMaxNewTokens({ type: 'Stable_Diffusion_Prompt', len: '600' }, { reverseMax: 768 });
    // custom chars=600 → ceil(600*1.8)=1080 → cap min(768, reverseMax)=768
    expect(n).toBe(768);
  });

  it('Danbooru 上限 512（受 Math.min(512, reverseMax) 约束）', () => {
    const n = resolveCaptionMaxNewTokens({ type: 'Danbooru_tag_list', len: '500' }, { reverseMax: 1024 });
    // chars=500 → ceil(500*1.6)=800 → cap(192..min(512,1024)) = 512
    expect(n).toBe(512);
  });
});

describe('reverse/length — label & block', () => {
  it('resolveCaptionLengthLabel 返回字数区间', () => {
    expect(resolveCaptionLengthLabel({ len: 'medium', caption_lang: 'zh' })).toBe('150～300');
  });

  it('buildCaptionLengthBlock 含【篇幅】标题', () => {
    const block = buildCaptionLengthBlock({ len: 'short', caption_lang: 'zh' });
    expect(block).toContain('【篇幅】');
  });

  it('resolveDanbooruLenHint 返回标签量提示', () => {
    const hint = resolveDanbooruLenHint({ len: 'medium', caption_lang: 'zh' });
    expect(hint).toContain('25～40');
  });

  it('normalizeCaptionLenKeys 数字 len 映射 custom', () => {
    const k = normalizeCaptionLenKeys({ len: '300' });
    expect(k.lenKey).toBe('custom');
    expect(k.lenChars).toBe(300);
  });
});
