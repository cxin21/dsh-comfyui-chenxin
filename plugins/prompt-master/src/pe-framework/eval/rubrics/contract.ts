/** 评审 rubric 契约（spec §2.2）：阈值进 rubric 不进代码。 */
export interface DialectRubricDimension {
  id: string          // 如 'tag-order' | 'cross-shot-consistency'
  weight: number      // 归一化权重（Σ=1），score 加权用
  instruction: string // 注入评委 persona 的评审指令
  evidenceOptional?: boolean // true = 该维度 finding 无证据也放行（加 evidenceAssumed 标记；spec §10.2-A5）
}

export interface DialectRubric {
  dimensions: ReadonlyArray<DialectRubricDimension>
  severityRules: string   // blocker/major/minor 判定标准文本
  evidenceTools: ReadonlyArray<'catalog' | 'tokenizer' | 'aesthetics'>
  passThreshold: number   // 0-100；≥ 此值且无 blocker 才 verdict=pass
  /** 2026-09-12：方言评审边界（拼接进 persona 尾部）——声明修复层能力边界，
   *  约束 findings 只出「修复层可执行」的操作（如 anima：只能改槽位与 narrative） */
  boundary?: string
}
