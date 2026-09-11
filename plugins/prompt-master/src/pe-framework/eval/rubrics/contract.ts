/** 评审 rubric 契约（spec §2.2）：阈值进 rubric 不进代码。 */
export interface DialectRubricDimension {
  id: string          // 如 'tag-order' | 'cross-shot-consistency'
  weight: number      // 归一化权重（Σ=1），score 加权用
  instruction: string // 注入评委 persona 的评审指令
}

export interface DialectRubric {
  dimensions: ReadonlyArray<DialectRubricDimension>
  severityRules: string   // blocker/major/minor 判定标准文本
  evidenceTools: ReadonlyArray<'catalog' | 'tokenizer' | 'aesthetics'>
  passThreshold: number   // 0-100；≥ 此值且无 blocker 才 verdict=pass
}
