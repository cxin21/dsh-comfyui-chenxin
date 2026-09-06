import { describe, expect, it } from 'vitest'
import { createBlueprintRepo } from '../../../src/pe-framework/blueprint/repo.js'

function stubSettings() {
  let data: Record<string, string> = {}
  return {
    get: () => ({ ...data }),
    update: async (p: object) => { data = { ...data, ...(p as any) } },
    replace: async (s: object) => { data = { ...(s as any) } },
  } as any
}

describe('blueprint repo', () => {
  it('round-trips save/load', () => {
    const repo = createBlueprintRepo({ settings: stubSettings() } as any)
    const bp = { schema_version: 1, media: 'image', core: { concept: 'x', negative: [] } }
    repo.save('b1', bp as any)
    expect(repo.load('b1')?.core.concept).toBe('x')
    expect(repo.list()).toContain('b1')
  })
  it('load missing → undefined', () => {
    const repo = createBlueprintRepo({ settings: stubSettings() } as any)
    expect(repo.load('missing')).toBeUndefined()
  })
  it('incremental edit: load → change one field → save (spec §5.3 增量修改前提)', () => {
    const repo = createBlueprintRepo({ settings: stubSettings() } as any)
    const bp = { schema_version: 1, media: 'video', core: { concept: '剑客决斗', aspect_ratio: '16:9', negative: [] }, media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] } } }
    repo.save('fight', bp as any)
    const loaded = repo.load('fight')!
    loaded.core.aspect_ratio = '9:16'          // 只改一个字段
    loaded.media_layer.video!.shots = loaded.media_layer.video!.shots.slice(0, 2)  // 删一镜
    repo.save('fight', loaded)
    const after = repo.load('fight')!
    expect(after.core.aspect_ratio).toBe('9:16')
    expect(after.media_layer.video!.shots).toHaveLength(2)
  })
})
