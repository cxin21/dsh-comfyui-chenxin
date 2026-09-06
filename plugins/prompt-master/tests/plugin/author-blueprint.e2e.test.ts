import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { registerAuthorTool, setAuthorIntentProvider } from '../../src/tools/prompt-author.js'
import { createBlueprintRepo } from '../../src/pe-framework/blueprint/repo.js'
import { stubCtx, runTool, textStream } from './helpers.js'
import type { AuthorIntentFn } from '../../src/tools/prompt-author.js'

// 注入蓝图 provider：第一轮产出 v0，后续轮只补 duration
const fakeProvider: AuthorIntentFn = async (req: any) => {
  if (req.round === 0) return {
    blueprint: {
      schema_version: 1, media: 'video',
      core: { concept: '三镜头打斗CG', negative: [] },
      media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] } },
    } as any, missing: ['style'],
  }
  return {} as any
}

describe('prompt_author blueprint pipeline', () => {
  beforeEach(() => setAuthorIntentProvider(fakeProvider as any))
  afterEach(() => setAuthorIntentProvider(null))

  it('runs analyze→enrich→project→stage and returns ok envelope with next_action', async () => {
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    const def = registerAuthorTool(ctx as any, { temperature: 0.7 })
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'h3', input: '三镜头打斗CG', style_id: 'cinematic_real' })))
    expect(v.next_action).toBeDefined()
    expect(v.audit).toBeDefined()
  })
})

// 预存蓝图到 repo（stub settings 作为 repo 后端），再传 blueprint_id 走增量路径
function settingsRepo() {
  const store: Record<string, string> = {}
  return {
    settings: {
      get: () => ({ ...store }),
      async update(p: Record<string, string>) { Object.assign(store, p) },
      async replace(s: Record<string, string>) { Object.assign(store, s) },
    },
  }
}

describe('prompt_author blueprint_id incremental path', () => {
  it('reload by blueprint_id skips analyzeIntent (provider not called)', async () => {
    const { settings } = settingsRepo()
    const repo = createBlueprintRepo({ settings } as any)
    repo.save('fight-15s', {
      schema_version: 1, media: 'video',
      core: { concept: '三镜头打斗CG', aspect_ratio: '9:16', negative: [] },
      media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] } },
    } as any)

    let providerCalls = 0
    const countingProvider: AuthorIntentFn = async (req: any) => { providerCalls++; return {} as any }
    setAuthorIntentProvider(countingProvider as any)

    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') }) as any
    ctx.settings = settings
    const def = registerAuthorTool(ctx, { temperature: 0.7 })
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'h3', blueprint_id: 'fight-15s' })))

    expect(providerCalls).toBe(0)              // 跳过 analyzeIntent
    expect(v.next_action).toBeDefined()
    setAuthorIntentProvider(null)
  })
})
