# minimax-h3-prompt 评测集（质量飞轮 §4.4）

由 optimize/harness.loadEvalset 动态加载（L1 人工反馈 / L2 debate 修复案例 / L3 golden 指针）。
本目录当前无静态 case 文件；未来如需人工固化 case，用以下格式（JSON，每文件一个数组或单对象）：

{ "id": "case-001", "tier": "L1", "target": "h3", "input": "<原始创作意图>",
  "humanRating": 4, "sourceGenerationId": "gen_..." }

字段说明见 src/pe-framework/optimize/harness.ts 的 EvalCase。
冷启动门槛：L1>=50 或 L1+L2>=80 才启动自动迭代（§4.4）。
