/**
 * M4-T2：h3 rating gate 错误串共享常量（t62 minimax_scenario + t71 prompt_author 双面消费）。
 * 单一来源 = src/tools/h3-rating-gate.ts（政策头段 + 「不做降级猜测」段常量化，surface 语境
 * 与指路尾注由消费面注入）；文案零变化——本测试逐字节钉死两面错误串（改文案必先改此处
 * 断言），既有消费面子串断言（minimax-scenario-rating / orchestration M3-T1b）保持不动。
 */
import { describe, expect, it } from 'vitest'
import { H3_RATING_UNSUPPORTED_HEAD, h3RatingUnsupportedError } from '../../src/tools/h3-rating-gate.js'

describe('M4-T2 shared h3 gate error constant (single source, zero text change)', () => {
  it('policy head is the shared constant and both surfaces assemble byte-identical messages', () => {
    expect(H3_RATING_UNSUPPORTED_HEAD).toBe('h3_rating_unsupported: MiniMax H3 内容政策只支持 safe（spec §5.5）')
    // minimax_scenario 面（t62 原文逐字节）
    expect(
      h3RatingUnsupportedError('本工具为 H3 场景面，rating=sensitive ', '(target=anima)').message,
    ).toBe(
      'h3_rating_unsupported: MiniMax H3 内容政策只支持 safe（spec §5.5）——本工具为 H3 场景面，rating=sensitive 被拒绝，不做降级猜测。需要 sensitive/explicit 内容分级请改走 prompt_author(target=anima)。',
    )
    // prompt_author 面（t71 原文逐字节，显式声明分支）
    expect(
      h3RatingUnsupportedError('target=h3 且 rating=explicit（显式声明）', ' target=anima').message,
    ).toBe(
      'h3_rating_unsupported: MiniMax H3 内容政策只支持 safe（spec §5.5）——target=h3 且 rating=explicit（显式声明）被拒绝，不做降级猜测。需要 sensitive/explicit 内容分级请改走 prompt_author target=anima。',
    )
    // prompt_author 面（关键词升档分支）
    expect(
      h3RatingUnsupportedError('target=h3 且 rating=sensitive（关键词升档）', ' target=anima').message,
    ).toBe(
      'h3_rating_unsupported: MiniMax H3 内容政策只支持 safe（spec §5.5）——target=h3 且 rating=sensitive（关键词升档）被拒绝，不做降级猜测。需要 sensitive/explicit 内容分级请改走 prompt_author target=anima。',
    )
  })
})
