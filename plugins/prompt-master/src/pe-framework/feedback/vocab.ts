/**
 * 二期 spec §10.2-A7：负反馈词表常量（按 target 划分）。
 * prompt_feedback record 时 tags 含词表外条目 → 接受 + advisory `tag_not_in_vocab`（不强制）。
 */
export const FEEDBACK_TAG_VOCAB: Record<'anima' | 'h3', readonly string[]> = {
  anima: ['构图', '肢体', '风格偏差', '颜色', '细节崩坏', '与描述不符', '比例', '背景'],
  h3: ['角色不一致', '镜头冗余', '节奏', '运镜', '穿帮', '与描述不符', '口型', '转场'],
}
