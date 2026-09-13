/**
 * h3 rating gate 错误串单一来源（M4-T2，spec §5.5 L185）。
 *
 * 背景：t62（minimax_scenario 场景面）与 t71（prompt_author author 面）各自内联构造
 * h3_rating_unsupported 错误——政策文案双份漂移风险。本模块把共享段常量化：
 *  - H3_RATING_UNSUPPORTED_HEAD：错误码 + 政策依据（MiniMax H3 内容政策只支持 safe，spec §5.5）
 *  - 尾段「不做降级猜测。需要 sensitive/explicit 内容分级请改走 prompt_author<指针>。」
 * surface 语境段由消费面注入（两面临场语义不同：场景面自述工具身份；author 面携带
 * target 与定档来源）。文案零变化——逐字节钉死在 tests/tools/h3-gate-error.test.ts，
 * 改文案必先改该断言（消费面子串断言不动）。
 */
export const H3_RATING_UNSUPPORTED_HEAD = 'h3_rating_unsupported: MiniMax H3 内容政策只支持 safe（spec §5.5）'

/** 构造 h3 rating gate 拒收错误（文案与 t62/t71 原文逐字节一致）。
 *  @param detail surface 语境段（以「——」接政策头后，止于「被拒绝」前）
 *  @param pointer 指路尾注（接在「prompt_author」后、句号前，如 '(target=anima)' 或 ' target=anima'） */
export function h3RatingUnsupportedError(detail: string, pointer: string): Error {
  return new Error(
    `${H3_RATING_UNSUPPORTED_HEAD}——${detail}被拒绝，不做降级猜测。需要 sensitive/explicit 内容分级请改走 prompt_author${pointer}。`,
  )
}
