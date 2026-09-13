import { describe, expect, it } from 'vitest'
import { apply } from '../../src/plugin/index.js'

function stubCtx() {
  const registered: Array<{ name: string; parameters: Record<string, unknown>; output: { schema: unknown } }> = []
  const ctx: any = {
    tools: {
      register(def: any) {
        registered.push({ name: def.name, parameters: def.parameters, output: def.output })
        return () => {}
      },
    },
    llm: { stream: async function* () {} },
    subagents: {
      start: async () => ({ id: 'stub', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }),
    },
    agent: { options: {} },
    settings: {
      register(ns: string, schema: unknown) {
        // Task 7 起注册两个 namespace：customProfiles + 内置覆盖层（profile-overrides）
        expect(['prompt-master-custom-profiles', 'prompt-master-profile-overrides']).toContain(ns)
        expect(schema).toBeTruthy()
        return { get: () => ({ customProfiles: {} }), update: async () => {}, replace: async () => {} }
      },
    },
    effect(cb: any) { cb() },   // cordis 4 同步 effect（Task 2 已证）
  }
  return { ctx, registered }
}

describe('plugin registration', () => {
  it('registers exactly the fourteen tools with native names', () => {
    const { ctx, registered } = stubCtx()
    apply(ctx, { temperature: 0.7 })
    const names = registered.map((d) => d.name).sort()
    expect(names).toEqual(['catalog_artist_add', 'catalog_build', 'catalog_relations', 'catalog_search', 'minimax_scenario', 'profile_list', 'prompt_audit', 'prompt_author', 'prompt_compile', 'prompt_expand', 'prompt_feedback', 'prompt_reverse', 'style_list', 'style_save'])
  })

  it('all outputs declare a string schema', () => {
    const { ctx, registered } = stubCtx()
    apply(ctx, { temperature: 0.7 })
    for (const d of registered) expect(d.output.schema).toMatchObject({ type: 'string' })
  })
})