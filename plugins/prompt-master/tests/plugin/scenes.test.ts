import { describe, expect, it } from 'vitest'
import { sceneToShots, SCENE_MAPPINGS } from '../../src/pe-framework/schema/scenes.js'

describe('scene → H3 shots mapping (scenes.ts)', () => {
  it('full_reference maps subject/scene content into a shot with duration', () => {
    const shots = sceneToShots('full_reference', {
      subject: '短发女武士',
      scene: '雨夜天守阁顶层',
      duration_seconds: '10',
      ambient: '雨声、风声',
      music: '低沉弦乐',
    })
    expect(shots).not.toBeNull()
    expect(shots!.duration_seconds).toBe(10)
    expect(shots!.shots.length).toBe(1)
    expect(shots!.shots[0].what).toContain('短发女武士')
    expect(shots!.shots[0].ambient).toBe('雨声、风声')
    expect(shots!.shots[0].music).toBe('低沉弦乐')
  })

  it('unknown scenario id → null', () => {
    expect(sceneToShots('no_such_scenario', { subject: 'x' })).toBeNull()
  })

  it('missing content fields → null', () => {
    // full_reference 表单只有 duration/aspect/expand 元字段；无内容键 → null
    expect(sceneToShots('full_reference', {})).toBeNull()
    expect(sceneToShots('full_reference', { duration_seconds: '10' })).toBeNull()
  })

  it('SCENE_MAPPINGS covers the ten catalog scenarios', () => {
    expect(SCENE_MAPPINGS.length).toBe(10)
    const ids = SCENE_MAPPINGS.map((m) => m.scenarioId)
    for (const expected of ['full_reference', 'continuous_story', 'product_ad', 'handdrawn_live', 'coop_game', 'paper_collage', 'brand_promo', 'mv_subtitle', 'papercraft', 'anim_3d']) {
      expect(ids).toContain(expected)
    }
  })

  it('non-full_reference scenario maps its content fields', () => {
    const shots = sceneToShots('brand_promo', { subject: '咖啡新品', duration_seconds: '5', music: '轻快' })
    expect(shots).not.toBeNull()
    expect(shots!.duration_seconds).toBe(5)
  })
})