export type ModelFamily = 'deepseek' | 'glm' | 'qwen-vl' | 'qwen-text' | 'gemma' | 'openai' | 'generic'

export interface FamilyRule { family: ModelFamily; modelPatterns: RegExp[]; providerPatterns?: RegExp[] }

/** 表驱动：新家族 = 加一行。顺序即优先级（先匹配先得）。 */
export const FAMILY_RULES: FamilyRule[] = [
  { family: 'qwen-vl', modelPatterns: [/qwen.*vl/i] },
  { family: 'qwen-text', modelPatterns: [/qwen/i] },
  { family: 'gemma', modelPatterns: [/gemma/i] },
  { family: 'glm', modelPatterns: [/^glm/i], providerPatterns: [/zhipu/i] },
  { family: 'deepseek', modelPatterns: [/deepseek/i] },
  { family: 'openai', modelPatterns: [/^gpt/i, /^o\d/i], providerPatterns: [/^openai$/i] },
]

export function inferModelFamily(provider: string, model: string): ModelFamily {
  for (const rule of FAMILY_RULES) {
    if (rule.modelPatterns.some((re) => re.test(model))) return rule.family
    if (rule.providerPatterns?.some((re) => re.test(provider))) return rule.family
  }
  return 'generic'
}
