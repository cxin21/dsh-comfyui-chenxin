import { describe, expect, it, vi } from 'vitest'
import { proposeMutation, type PersonaCandidate } from '../../../src/pe-framework/optimize/mutate.js'
import type { EvalCase } from '../../../src/pe-framework/optimize/harness.js'
import type { CriticProvider } from '../../../src/pe-framework/eval/critic.js'

const NEGATIVE_CASE: EvalCase = {
  id: 'l2-gen-1',
  tier: 'L2',
  input: '一只赛博朋克风格的猫在霓虹街头行走',
  target: 'anima',
  sourceGenerationId: 'gen-1',
}

const FINDINGS = [
  { generationId: 'gen-1', findings: [{ dimension: 'specificity', problem: '主体细节不足', requiredFix: '补材质与光照描述' }] },
]

const CURRENT_PERSONA = '你是 Anima 提示词作者，遵循字段顺序与 tag 预算。'

function baseInput(provider: CriticProvider) {
  return {
    negativeCases: [NEGATIVE_CASE],
    debates: FINDINGS,
    currentPersona: CURRENT_PERSONA,
    provider,
  }
}

describe('proposeMutation', () => {
  it('user payload 含负例 input、findings 文本、currentPersona', async () => {
    const provider = vi.fn(async (_req: { persona: string; schema: string; user: string }) =>
      '{"diff":"x","rationale":"r","targetsFailures":[]}',
    )
    await proposeMutation(baseInput(provider))
    expect(provider).toHaveBeenCalledTimes(1)
    const req = provider.mock.calls[0][0]
    expect(req.user).toContain('一只赛博朋克风格的猫在霓虹街头行走')
    expect(req.user).toContain('主体细节不足')
    expect(req.user).toContain('补材质与光照描述')
    expect(req.user).toContain(CURRENT_PERSONA)
    expect(req.schema).toContain('diff')
  })

  it('合法 JSON → PersonaCandidate 字段完整、id 格式 cand_<ts>_<rand>', async () => {
    const provider = vi.fn(async () =>
      '```json\n{"diff":"--- a/persona\\n+++ b/persona\\n@@ -1 +1,2 @@\\n+强调材质与光照","rationale":"负例普遍缺材质描述","targetsFailures":["specificity:主体细节不足"]}\n```',
    )
    const cand: PersonaCandidate = await proposeMutation(baseInput(provider as unknown as CriticProvider))
    expect(cand.diff).toContain('强调材质与光照')
    expect(cand.rationale).toBe('负例普遍缺材质描述')
    expect(cand.targetsFailures).toEqual(['specificity:主体细节不足'])
    expect(cand.id).toMatch(/^cand_\d+_[0-9a-z]+$/)
  })

  it('坏 JSON / 缺字段 → 抛 Error（不静默）', async () => {
    const bad = vi.fn(async () => '这不是 JSON')
    await expect(proposeMutation(baseInput(bad as unknown as CriticProvider))).rejects.toThrow(Error)
    const missing = vi.fn(async () => '{"diff":"x"}')
    await expect(proposeMutation(baseInput(missing as unknown as CriticProvider))).rejects.toThrow(Error)
  })
})
