/** MiniMax-H3 方言评审 rubric（spec §2.2，Task 4 逐字落地）：阈值进 rubric 不进代码。 */
import type { DialectRubric } from './contract.js'

export const H3_RUBRIC: DialectRubric = {
  dimensions: [
    { id: 'shot-structure', weight: 0.2, instruction:
      '检查六段式完整性与每镜头语句序「主体→运动/镜头→场景→氛围」。缺段=blocker，句序乱=minor。' },
    { id: 'shot-increment', weight: 0.2, instruction:
      '相邻镜头必须有语义信息增量（新动作/新机位/新信息）。完全重复=blocker，增量弱=major。' },
    { id: 'cross-shot-consistency', weight: 0.3, instruction:
      '同角色跨镜头的描述与 ref 引用必须一致（外貌/服装/身份标签）。任何矛盾=blocker（本方言最高价值维度）。' },
    { id: 'duration-fit', weight: 0.1, instruction:
      '镜头时长与内容量匹配：塞过满（>1 动作/秒）=major，空镜超时=minor。' },
    { id: 'pacing', weight: 0.1, instruction:
      '分镜节奏：镜头时长曲线是否有设计感（等长单调=major，张弛有度=佳）。' },
    { id: 'atmosphere-coupling', weight: 0.1, instruction:
      '氛围段与画面段呼应：氛围词必须在画面中有对应视觉锚点。无锚点的氛围=major。' },
  ],
  severityRules: 'blocker=视频必然穿帮或严重偏离；major=明显降低质量但不致命；minor=可改进瑕疵。',
  evidenceTools: ['tokenizer', 'aesthetics'],
  passThreshold: 75,
}
