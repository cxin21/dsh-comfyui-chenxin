// 低危 parity 项测试（审计 2026-08-31-resolver-3.1.0-diff.md §10/§12 优先级 4）
// C1 comfyui lora_style typo · R1 expand 内置 profile 撞名语义（保留现役）· E1 labelUi port-only 决定 · ensureCustomExpandSystem 守卫文案
import { describe, it, expect } from 'vitest';
import { COMFYUI_EXTRA_TEMPLATES } from '../../src/resolver/profiles/reverse/comfyui.js';
import { resolveExpand } from '../../src/resolver/index.js';
import { findProfileById } from '../../src/resolver/profiles/index.js';
import { LEGACY_EXPAND_PE_ID_MAP, mapLegacyExpandPeId } from '../../src/resolver/profiles/expand-mirror.js';
import { EXPAND_LENGTH_OPTIONS, listExpandLengthsForUi } from '../../src/resolver/profiles/expand-rules.js';

describe('C1: comfyui lora_style 文案 typo（上游 comfyuiPromptEngineering.js:402 pose/orientation）', () => {
  it('en 文案为 pose/orientation 而非 pose/orion', () => {
    expect(COMFYUI_EXTRA_TEMPLATES.comfyui_lora_style.en).toContain('pose/orientation');
    expect(COMFYUI_EXTRA_TEMPLATES.comfyui_lora_style.en).not.toContain('pose/orion');
  });
});

describe('R1: 8 个 expand 内置 profile 撞名语义（保持现役 + legacy 映射不变）', () => {
  it('pe_expand_natural 仍以 expand 语义注册（消费方为 expand 路由）', () => {
    const p = findProfileById('pe_expand_natural');
    expect(p).toBeTruthy();
    expect(p!.kind).toBe('expand');
    expect(p!.builtinKey).toBe('expand_natural');
  });

  it('legacy 映射仍保留（pe_expand_natural → pe_expand_descriptive），id 体系未动', () => {
    expect(LEGACY_EXPAND_PE_ID_MAP.pe_expand_natural).toBe('pe_expand_descriptive');
    expect(mapLegacyExpandPeId('pe_expand_natural')).toBe('pe_expand_descriptive');
  });
});

describe('E1: labelUi 不承载（port-only 决定，T4 裁决）', () => {
  it('EXPAND_LENGTH_PRESETS 无 labelUi 字段；UI label 保留短词', () => {
    expect(EXPAND_LENGTH_OPTIONS.find((o) => o.value === 'medium')!.label).toBe('标准');
  });

  it('完整篇幅语义由 listExpandLengthsForUi 的 description（= hintZh）承载', () => {
    const medium = listExpandLengthsForUi().find((o) => o.value === 'medium')!;
    expect(medium.description).toContain('150～300');
  });
});

describe('ensureCustomExpandSystem 守卫文案（上游 promptEngineeringResolver.js:82-83 逐字）', () => {
  it('en 守卫含 "in the user message" 与 "or expansion rules"', () => {
    const r = resolveExpand(
      { id: 'custom_expand', kind: 'expand', builtin: false, name: 'x', category: 'x', description: 'x', systemPrompt: '自定义扩写规则。' } as any,
      { outputLang: 'en', expandLen: 'medium', shortText: 'a cat' },
    );
    expect(r.system).toContain('in the user message');
    expect(r.system).toContain('or expansion rules');
    expect(r.system).toContain('Never treat style names or expansion rules as the subject to elaborate.');
  });

  it('zh 守卫含「或散文」', () => {
    const r = resolveExpand(
      { id: 'custom_expand', kind: 'expand', builtin: false, name: 'x', category: 'x', description: 'x', systemPrompt: '自定义扩写规则。' } as any,
      { outputLang: 'zh', expandLen: 'medium', shortText: '一只猫' },
    );
    expect(r.system).toContain('扩写成说明文或散文');
  });
});