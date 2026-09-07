import { describe, expect, it } from 'vitest'
import { projectToH3, projectToAnima, projectAdvisories, lastProjectAdvisories, preflightRepair, BlueprintHardNegativeError } from '../../../src/pe-framework/blueprint/project.js'
import { applyStyle } from '../../../src/pe-framework/enrichment/style.js'
import type { BlueprintV1 } from '../../../src/pe-framework/blueprint/schema.js'
// 副作用注册 h3 方言包（getDialectPackage 供 preflightRepair 约束）
import '../../../src/pe-framework/dialect/h3.js'

// 计划 fixture（含 hard 负向 → 供 throw 用例）
const h3Bp: BlueprintV1 = {
  schema_version: 1, media: 'video',
  core: {
    concept: '剑客决斗', aspect_ratio: '16:9',
    characters: [{ id: 'c1', name: '银发剑客', appearance_anchors: ['银白长发', '灰色披风', '反手持刀'], continuity_lock: true }],
    scene: { environment: '黄昏荒原' }, emotion: '紧张', composition: ['三分法'],
    negative: [{ target: '字幕', severity: 'soft' }, { target: '血腥', severity: 'hard' }],
  },
  media_layer: {
    video: {
      total_duration_seconds: 15,
      shots: [
        { beat: '对峙', shot_size: 'MS', camera: 'dolly', who: ['c1'], audio_focus: '风声', music: '低鼓' },
        { beat: '交锋', shot_size: 'CU', who: ['c1'] },
        { beat: '决胜', shot_size: 'WS', who: ['c1'] },
      ],
    },
  },
}

// 仅 soft 负向的变体（hard → throw 用例独立于基础投影断言）
const h3BpSoft: BlueprintV1 = {
  ...h3Bp,
  core: { ...h3Bp.core, negative: [{ target: '字幕', severity: 'soft' }] },
}

// 快照 fixture（spec §8.3 防漂移；无 hard，含 continuity 锁 + soft 负向）
const fightBp: BlueprintV1 = {
  schema_version: 1, media: 'video',
  core: {
    concept: '剑客决斗', aspect_ratio: '16:9',
    characters: [
      { id: 'c1', name: '银发剑客', appearance_anchors: ['银白长发', '灰色披风', '反手持刀'], continuity_lock: true },
      { id: 'c2', name: '黑袍武士', appearance_anchors: ['黑色兜帽', '双刀'], outfit: '黑色劲装' },
    ],
    scene: { environment: '黄昏荒原', lighting: '侧逆光' }, emotion: '紧张', composition: ['三分法'],
    negative: [{ target: '字幕', severity: 'soft' }],
  },
  media_layer: {
    video: {
      total_duration_seconds: 15,
      shots: [
        { beat: '对峙', shot_size: 'MS', camera: 'dolly', who: ['c1', 'c2'], audio_focus: '风声', music: '低鼓' },
        { beat: '交锋', shot_size: 'CU', who: ['c1'] },
        { beat: '决胜', shot_size: 'WS', who: ['c1', 'c2'] },
      ],
    },
  },
}

describe('projectToH3', () => {
  it('maps duration to total and preserves 3 shots', () => {
    const s = projectToH3(h3BpSoft)
    expect(s.duration_seconds).toBe(15)
    expect(s.shots).toHaveLength(3)
  })
  it('injects continuity-locked anchors into every shot what', () => {
    const s = projectToH3(h3BpSoft)
    for (const shot of s.shots) expect(shot.what).toContain('银白长发')
  })
  it('who resolves to <Subject N> stable labels by character order', () => {
    const s = projectToH3(fightBp)
    expect(s.shots[0].who).toBe('<Subject 1>，<Subject 2>')
  })
  it('soft negative → positive rewrite in what tail + advisory recorded', () => {
    const s = projectToH3(h3BpSoft)
    for (const shot of s.shots) expect(shot.what).toContain('无字幕纯净画面') // 末句正向改写
    const advisories = lastProjectAdvisories()
    expect(advisories.some((a) => a.includes('字幕'))).toBe(true)
  })
  it('action empty falls back to beat (what stays non-empty)', () => {
    const bp: BlueprintV1 = {
      schema_version: 1, media: 'video',
      core: { concept: 'x', negative: [] },
      media_layer: { video: { total_duration_seconds: 4, shots: [{ beat: '对峙' }] } },
    }
    const s = projectToH3(bp)
    expect(s.shots[0].what.length).toBeGreaterThan(0)
    expect(s.shots[0].what).toContain('对峙')
  })
  it('injects scene.lighting + emotion into every shot what (spec §8.1 ROI)', () => {
    const s = projectToH3(fightBp)
    for (const shot of s.shots) {
      expect(shot.what).toContain('侧逆光')
      expect(shot.what).toContain('紧张')
    }
  })
  it('merges core.style base/theme into every shot what (spec §8.1 core.style→what, any conformity)', () => {
    const bp: BlueprintV1 = {
      ...fightBp,
      core: { ...fightBp.core, style: { base: '写实电影', theme: '暗黑史诗' } },
    }
    const s = projectToH3(bp)
    for (const shot of s.shots) {
      expect(shot.what).toContain('写实电影')
      expect(shot.what).toContain('暗黑史诗')
    }
  })
  it('default conformity 0.6: H3 what carries core.style reference AND ~60% style phrases (no reference-only fake tier)', () => {
    const bp: BlueprintV1 = {
      ...fightBp,
      core: { ...fightBp.core, style: { base: '写实电影', theme: '暗黑史诗' } },
    }
    const enriched = applyStyle(bp, 'cinematic_real', 0.6)
    expect(enriched.core.style?.base).toContain('写实')
    const s = projectToH3(enriched)
    for (const shot of s.shots) {
      // 风格引用进 what（第 1 级）
      expect(shot.what).toContain('写实电影')
      // 约 60% 风格短语进 what（第 2 级，不再仅引用）——cinematic_real video fragment 5 短语 → round(0.6×5)=3 短语注入
      expect(shot.what).toContain('IMAX 胶片质感')
      expect(shot.what).toContain('Panavision C 系 35mm f4')
      expect(shot.what).toContain('伦勃朗光')
    }
  })
  it('hard negative → throws BlueprintHardNegativeError', () => {
    expect(() => projectToH3(h3Bp)).toThrow(/hard negative/)
    expect(() => projectToH3(h3Bp)).toThrow(BlueprintHardNegativeError)
  })
  it('projection snapshot (spec §8.3 防漂移)', () => {
    expect(JSON.stringify(projectToH3(fightBp))).toMatchSnapshot()
  })
})

describe('projectToAnima', () => {
  it('maps anchors to appearance + negative to exclusions', () => {
    // 计划原文 `{ ...h3Bp, media: 'image', negative: [...] }` 把 negative 放在顶层——
    // BlueprintV1 的 negative 在 core 下，顶层覆盖不生效导致 h3Bp 的 hard 血腥残留、投影必 throw。
    // 按计划意图（soft-only 蓝图映射 appearance/exclusions）修正覆盖位置为 core.negative。
    const s = projectToAnima({ ...h3Bp, media: 'image', core: { ...h3Bp.core, negative: [{ target: '字幕', severity: 'soft' }] } } as any)
    expect(s.appearance).toContain('银白长发')
    expect(s.exclusions).toContain('字幕')
  })
  it('maps scene/composition/style to detail_mood and outfit to clothing', () => {
    const s = projectToAnima(fightBp as any)
    expect(s.clothing).toContain('黑色劲装')
    expect(s.detail_mood).toContain('三分法')
    expect(s.detail_mood).toContain('侧逆光')
    expect(s.scene).toContain('黄昏荒原')
  })
})

describe('preflightRepair', () => {
  it('clamps out-of-range duration to nearest legal value and records repair', () => {
    const { bp: r, repairs } = preflightRepair({
      ...fightBp,
      media_layer: { video: { ...fightBp.media_layer.video!, total_duration_seconds: 3 } },
    })
    expect(r.media_layer.video!.total_duration_seconds).toBe(4)
    expect(repairs.some((x) => x.startsWith('duration_3→4'))).toBe(true)
  })
  it('records shots-overflow suggestion when shots exceed max_shots', () => {
    const { repairs } = preflightRepair({
      ...fightBp,
      media_layer: { video: { ...fightBp.media_layer.video!, total_duration_seconds: 5, shots: fightBp.media_layer.video!.shots } },
    })
    expect(repairs.some((x) => x.startsWith('shots_3>max_2:merge_shots_or_extend_duration'))).toBe(true)
  })
})

describe('projectToH3 global audio (spec §8.1 O9)', () => {
  it('merges media_layer.video.audio into first-shot ambient', () => {
    const bp: BlueprintV1 = {
      schema_version: 1, media: 'video',
      core: { concept: 'x', negative: [] },
      media_layer: { video: { total_duration_seconds: 4, audio: '雨声与远处雷声', shots: [{ beat: '对峙', audio_focus: '风声' }] } },
    }
    const s = projectToH3(bp)
    expect(s.shots[0].ambient).toContain('雨声与远处雷声')
    expect(s.shots[0].ambient).toContain('风声') // 与 audio_focus 用「；」并入
  })
  it('drops global audio with advisory when no shots', () => {
    const bp: BlueprintV1 = {
      schema_version: 1, media: 'video',
      core: { concept: 'x', negative: [] },
      media_layer: { video: { total_duration_seconds: 4, audio: '环境白噪', shots: [] } },
    }
    const s = projectToH3(bp)
    expect(s.shots).toHaveLength(0)
    const advisories = lastProjectAdvisories()
    expect(advisories.some((a) => a.includes('audio_dropped:no_shots'))).toBe(true)
  })
})
