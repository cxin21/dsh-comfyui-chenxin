/** MiniMax-H3 方言评审 rubric（spec §2.2，Task 4 逐字落地；h3-director-depth Phase 6 扩维）：
 *  在结构与一致性维度之外引入导演质量维度（动作因果/表演链、出口-入口连续、运镜动机），
 *  权重重配后和仍为 1；每个维度逐镜覆盖（无问题的镜头也要显式标注通过）。 */
import type { DialectRubric } from './contract.js'

const COVERAGE = '逐镜检查：N 镜必须逐镜给出判断，没有问题的镜头也要显式写"通过"，不得只挑问题镜或用整段概评替代逐镜检查。'

export const H3_RUBRIC: DialectRubric = {
  dimensions: [
    { id: 'shot-structure', weight: 0.15, instruction:
      `检查六段式完整性与每镜头语句序「主体→运动/镜头→场景→氛围」。缺段=blocker，句序乱=minor；复核 cut 时间戳与镜头时长匹配（确定性审计之外的人工抽查）。${COVERAGE}` },
    { id: 'shot-increment', weight: 0.1, instruction:
      `相邻镜头必须有语义信息增量（新动作/新机位/新信息）。完全重复=blocker，增量弱=major。${COVERAGE}` },
    { id: 'cross-shot-consistency', weight: 0.2, instruction:
      `同角色跨镜头的描述与 ref 引用必须一致（外貌/服装/身份标签）。任何矛盾=blocker（本方言最高价值维度）。${COVERAGE}` },
    { id: 'duration-fit', weight: 0.05, instruction:
      `镜头时长与内容量匹配：塞过满（>1 动作/秒）=major，空镜超时=minor。${COVERAGE}` },
    { id: 'pacing', weight: 0.1, evidenceOptional: true, instruction:
      `分镜节奏：镜头时长曲线是否有设计感（等长单调=major，张弛有度=佳）；建立镜有信息时间、证据镜短促、末镜见结果落点。${COVERAGE}` },
    { id: 'atmosphere-coupling', weight: 0.1, evidenceOptional: true, instruction:
      `氛围段与画面段呼应：氛围词必须在画面中有对应视觉锚点。无锚点的氛围=major。${COVERAGE}` },
    { id: 'performance-causality', weight: 0.15, instruction:
      `动作因果与表演肌理：动作应有准备→接触→受力→结果（无结果动作=major）；表演应是刺激→压住→泄露→选择→余波的刺激-反应链，抽象情绪形容词堆叠（sadly/angrily 类）替代可演动作=major。${COVERAGE}` },
    { id: 'continuity-exit-entry', weight: 0.1, instruction:
      `跨镜连续性：相邻镜头应有可核对的出口/入口状态或交镜锚点（同一动作方向/视线/光线/道具/受力）。相邻镜完全无锚点交接=major；末镜无结果落点=minor。${COVERAGE}` },
    { id: 'camera-motivation', weight: 0.05, instruction:
      `运镜动机：摄影机移动/切换应有观看理由（靠近确认、退后揭示、横移让出信息、跟随保存连续性），纯术语展示或无动机运镜=minor，重复无信息运镜=major。${COVERAGE}` },
  ],
  severityRules: 'blocker=视频必然穿帮或严重偏离；major=明显降低质量但不致命；minor=可改进瑕疵。',
  evidenceTools: ['tokenizer', 'aesthetics'],
  passThreshold: 75,
}
