/** Anima 方言评审 rubric（spec §2.2，Task 4 逐字落地）：阈值进 rubric 不进代码。
 *  D10（外部基准 2026-09）：aesthetics 单维拆为 composition / lighting-color /
 *  aesthetic-vocabulary 三维，与 ANIMA_PERSONA 的设计规范同源（构图占比/景别一致、
 *  光源物件写法与色彩主次、词表信息密度），使评委从「查结构」升级为「评设计」。 */
import type { DialectRubric } from './contract.js'

export const ANIMA_RUBRIC: DialectRubric = {
  dimensions: [
    { id: 'tag-order', weight: 0.10, instruction:
      '检查 tag 顺序是否符合权重序：质量→人数→角色→画师→特征→动作→构图→背景。顺序错=minor，整体混乱=major。' },
    { id: 'contradiction', weight: 0.20, instruction:
      '检测 tag 自相矛盾（如 1girl+multiple boys、smile+crying、open mouth+closed mouth、solo+多人）、正负面提示词互相冲突。任何矛盾=blocker。' },
    { id: 'tag-evidence', weight: 0.15, instruction:
      '抽查非通用 tag 在 catalog 的证据（用 catalog 工具）；miss 的 tag 给出 canonical 替代。无证据 tag>2 个=blocker。' },
    { id: 'negative-template', weight: 0.10, instruction:
      '负面提示词须含标准模板 + 针对本图主体的排除项；缺模板=major，缺主体排除=minor。' },
    { id: 'composition', weight: 0.15, instruction:
      '评构图设计（用 aesthetics 工具）：是否有唯一明确景别；景别与 tag 一致（close-up 不得残留鞋袜/全身 tag）；主体占比/布局/背景层级是否在 NL 说明。缺景别=minor；景别与内容矛盾=major；无任何布局描述=major。' },
    { id: 'lighting-color', weight: 0.15, instruction:
      '评光影与色彩设计（用 aesthetics 工具）：光源是否写作场景物件且无光效禁词（sunlight/moonlight/rim light 等）；人物曝光是否明确；色彩是否有主次（一个主色+≤2 辅助）。出现禁用光效词=major；无光源描述=minor；色彩堆叠无主次=major。' },
    { id: 'aesthetic-vocabulary', weight: 0.15, instruction:
      '评词表信息密度（用 aesthetics 工具）：抽象词（beautiful/cinematic 等）占比过高=major；多词自造短语未拆原子 tag=major；正面具体化建议写进 requiredFix。' },
  ],
  severityRules: 'blocker=出图必然错误或严重偏离；major=明显降低质量但不致命；minor=可改进瑕疵。',
  evidenceTools: ['catalog', 'aesthetics'],
  passThreshold: 80,
}
