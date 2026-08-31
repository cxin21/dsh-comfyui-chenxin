// 测试共享 fixtures — 复用于 resolver / tool / provider 测试
import type { PEProfile } from '../../src/resolver/types.js';

export const expandInputs = {
  natural: '1girl, sunset, beach',
  shortZh: '一只猫坐在窗台上',
  danbooru: 'anime girl, white hair',
};

/** 常用 expand profile id（内置） */
export const expandProfileIds = {
  natural: 'pe_expand_natural',
  compact: 'pe_expand_compact',
  danbooru: 'pe_expand_danbooru',
  structuredMd: 'pe_expand_structured_md',
  structuredJson: 'pe_expand_structured_json',
  photographer: 'pe_expand_photographer',
};

/** 常用 reverse profile id（内置） */
export const reverseProfileIds = {
  descriptive: 'pe_reverse_descriptive',
  sd: 'pe_reverse_sd',
  danbooru: 'pe_reverse_danbooru',
};

export const minimaxInputs = {
  fullReference: {
    scenario_id: 'full_reference',
    form_fields: { duration_seconds: '10', aspect_ratio: '16:9', expand_mode: 'strict' },
  },
};

/** 内置供应商 id */
export const builtinProviderIds = ['deepseek', 'openai', 'siliconflow'];

/** 说明：以下 PEProfile 仅供类型展示，实际断言用 findProfileById 拉取内置对象 */
export const sampleProfilePick: Record<string, string> = {
  id: 'pe_expand_natural',
  kind: 'expand',
  name: '自然语言 · 通用扩写',
  outputFormat: 'prose',
};
