// 中危 parity 项测试（审计 2026-08-31-resolver-3.1.0-diff.md §2/§6/§10）
// M1/M2 expandMirror 非结构化分支 · A1 anima3 custom 字数档 · V1 resolveReverse 长度块 · D1 字数表述
import { describe, it, expect } from 'vitest';
import { resolveExpandFromReverseMirror } from '../../src/resolver/profiles/expand-mirror.js';
import { resolveReverse } from '../../src/resolver/index.js';
import * as Anima3PE from '../../src/resolver/profiles/reverse/anima3.js';
import { resolveWordCountHint } from '../../src/resolver/profiles/reverse/descriptive.js';

const mirrorProfile = {
  id: 'pe_expand_descriptive',
  kind: 'expand',
  builtinKey: 'Descriptive',
} as any;

describe('M1: expandMirror 非结构化分支走 CaptionPE 路由', () => {
  it('Descriptive 镜像 system 含五点框架/极致还原路线（非 ComfyUI 检查表硬编码）', () => {
    const r = resolveExpandFromReverseMirror(mirrorProfile, {
      outputLang: 'zh',
      expandLen: 'medium',
      shortText: 'a girl in a garden',
    });
    // 上游 CaptionPE.buildSystemPrompt 对 Descriptive 走 descriptivePromptEngineering：
    // 含「视觉取证式」总则与五点结构框架（旧硬编码 ComfyUI 双块无这两块）
    expect(r.system).toContain('视觉取证式');
    expect(r.system).toContain('【五点结构框架·极致还原】');
    expect(r.system).toContain('【极致还原总则】');
  });

  it('Descriptive 镜像 system 叠加长度 addon（buildSystemAddons）', () => {
    const r = resolveExpandFromReverseMirror(mirrorProfile, {
      outputLang: 'zh',
      expandLen: 'long',
      shortText: 'a girl in a garden',
    });
    expect(r.system).toContain('【篇幅】');
  });
});

describe('M2: expandMirror tokenLimits 透传', () => {
  it('非结构化分支 maxTokens 尊重 tokenLimits.expandMax', () => {
    const r = resolveExpandFromReverseMirror(mirrorProfile, {
      outputLang: 'zh',
      expandLen: 'long',
      shortText: 'a girl in a garden',
      tokenLimits: { expandMax: 256 },
    });
    expect(r.maxTokens).toBeLessThanOrEqual(256);
    expect(r.maxTokens).toBeGreaterThan(0);
  });
});

describe('A1: anima3 custom 字数档', () => {
  it('custom 字数 400 → band 40（round(chars/10)，此前恒按 medium 22-38）', () => {
    const cap = { caption_lang: 'zh', len: 'custom', caption_len_chars: 400 };
    const c = Anima3PE.buildOutputConstraints(cap);
    expect(c).toContain('约 40 个');
    expect(c).not.toContain('22-38');
    expect(c).not.toContain('约 22');
  });

  it('custom 字数 clamp 到 [16, 80]', () => {
    const lo = Anima3PE.buildOutputConstraints({ caption_lang: 'zh', len: 'custom', caption_len_chars: 50 });
    const hi = Anima3PE.buildOutputConstraints({ caption_lang: 'zh', len: 'custom', caption_len_chars: 9999 });
    expect(lo).toContain('约 16 个');
    expect(hi).toContain('约 80 个');
  });
});

describe('V1: resolveReverse 自定义分支恢复长度块', () => {
  const customProfile = { id: 'custom_rev', builtin: false, systemPrompt: '自定义反推提示。' } as any;

  it('system 追加 CaptionLen.buildCaptionLengthBlock（【篇幅】+ 档位文案）', () => {
    const r = resolveReverse(customProfile, {
      caption_lang: 'zh',
      len: 'long',
      media_target: 'image',
    } as any);
    expect(r.system).toContain('自定义反推提示');
    expect(r.system).toContain('【篇幅】');
    expect(r.system).toContain('300～500');
  });

  it('长度块不再被 router workflow 块顶替（无 ComfyUI 还原检查表）', () => {
    const r = resolveReverse(customProfile, {
      caption_lang: 'zh',
      len: 'medium',
      media_target: 'image',
    } as any);
    expect(r.system).not.toContain('还原检查表·有则必写');
  });
});

describe('D1: descriptive/prose 字数表述走 CaptionLen 档位文案', () => {
  it('medium → 「150～300」（非 maxTokens×0.75 裸数字）', () => {
    expect(resolveWordCountHint({ caption_lang: 'zh', len: 'medium' })).toBe('150～300');
  });

  it('custom 字数 → 具体数字字符串', () => {
    expect(resolveWordCountHint({ caption_lang: 'zh', len: 'custom', caption_len_chars: 200 })).toBe('200');
  });

  it('descriptive 五点框架正文引用档位文案', async () => {
    const { buildSystemPrompt } = await import('../../src/resolver/profiles/reverse/descriptive.js');
    const sys = buildSystemPrompt({ caption_lang: 'zh', len: 'short', type: 'Descriptive' }, 'image');
    expect(sys).toContain('80～150');
  });
});
