import { describe, expect, it } from 'vitest'
import { auditH3Full } from '../../../src/pe-framework/audit/rules-h3.js'

const zhShots =
  'integrated_multimodal_description: [Shot 1] 黄昏荒原，两名持刀武者相隔十步相向而立，镜头缓慢推近，风吹起衣摆与沙尘，剑拔弩张. [Shot 2] At 00:02.500, the camera cuts to 两人同时爆发冲刺，双刀猛烈碰撞溅出火花，写实的刀身震颤与受击反馈. [Shot 3] At 00:05.000, the camera cuts to 决定性一击：青年武者一刀崩开对手的刀，刀锋停在对方颈侧，胜负已分.\n\noverall_soundscape: 荒原风卷沙尘，写实光影\n\nnon_diegetic_music: 低沉鼓点渐强'

describe('H3 audit: CJK multi-shot should NOT false-positive', () => {
  it('three distinct Chinese shots produce no shot_execution gate', () => {
    const gates = auditH3Full(zhShots, { stage: 't2va', duration: 7.5, shotCount: 3 }, [])
    const se = gates.filter((g) => g.rule === 'shot_execution')
    expect(se).toHaveLength(0)
  })
})
