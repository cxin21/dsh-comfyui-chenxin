/** Anima 方言评审 rubric（spec §2.2，Task 4 逐字落地）：阈值进 rubric 不进代码。 */
import type { DialectRubric } from './contract.js'

export const ANIMA_RUBRIC: DialectRubric = {
  dimensions: [
    { id: 'tag-order', weight: 0.2, instruction:
      '检查 tag 顺序是否符合权重序：质量→主体→角色→特征→动作→构图→背景。顺序错=minor，整体混乱=major。' },
    { id: 'contradiction', weight: 0.25, instruction:
      '检测 tag 自相矛盾（如 1girl+multiple boys、smile+crying）、正负面提示词互相冲突。任何矛盾=blocker。' },
    { id: 'tag-evidence', weight: 0.2, instruction:
      '抽查非通用 tag 在 catalog 的证据（用 catalog 工具）；miss 的 tag 给出 canonical 替代。无证据 tag>2 个=blocker。' },
    { id: 'negative-template', weight: 0.15, instruction:
      '负面提示词须含标准模板 + 针对本图主体的排除项；缺模板=major，缺主体排除=minor。' },
    { id: 'aesthetics', weight: 0.2, instruction:
      '风格/氛围词的具体性（用 aesthetics 工具）：抽象词（beautiful）占比过高=major；正面具体化建议写进 requiredFix。' },
  ],
  severityRules: 'blocker=出图必然错误或严重偏离；major=明显降低质量但不致命；minor=可改进瑕疵。',
  evidenceTools: ['catalog', 'aesthetics'],
  passThreshold: 80,
}
