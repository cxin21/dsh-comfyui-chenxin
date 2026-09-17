import { describe, expect, it, afterEach } from 'vitest';
import { registerAuthorTool, setDirectingDeps } from '../../src/tools/prompt-author.js';
import { stubCtx, runTool, dDeps, dBeat, dShot } from '../plugin/helpers.js';

// session-34706f38 回归锁（新管线契约改写）：「3 个分镜每个 5 秒」→ 3 Beat × 5s，总时长 15s。
// 每 Beat 生成单元 5s ∈ H3 [4,15]、establish tag [2,4] 边界合规 → G-duration 零违规；
// 中文 input 走 mocked S1 → 无 CJK 假阳性面（门检查 IR 结构而非 prompt 文本）。
describe('eval: fight CG case (session-34706f38 regression, directing)', () => {
  afterEach(() => setDirectingDeps(null));

  it('completes with no CJK false positive, 3×5s duration semantics, non-manual next_action', async () => {
    setDirectingDeps(dDeps({
      beatDirectorRunner: async () => JSON.stringify({
        beats: [
          dBeat('B01', [dShot('B01-S1', 4)]),
          dBeat('B02', [dShot('B02-S1', 4)]),
          dBeat('B03', [dShot('B03-S1', 4)]),
        ],
      }),
      shotWriterRunner: async () => JSON.stringify({ shots: [{ what: 'Fight CG clash in neon streets', who: 'S1', duration: 4 }] }),
    }));
    const ctx = stubCtx();
    const def = registerAuthorTool(ctx as any, { temperature: 0.7 });
    const v = JSON.parse(
      String(
        await runTool(ctx, def, {
          target: 'h3',
          input: '3个分镜每个5秒的打斗CG动画',
          judge_mode: 'off',
        }),
      ),
    );
    expect(v.ok).toBe(true);
    expect(v.next_action).not.toBe('manual');
    // 零 critical（duration 语义回归：3 Beat 各 4s ∈ [4,15]，tag 区间合规）
    expect(v.audit.gates.every((g: any) => g.severity !== 'critical')).toBe(true);
    expect(v.audit.gates.some((g: any) => g.rule === 'G-duration')).toBe(false);
    // 3 镜全部完成 dialect 编译
    expect(v.result.text.match(/\[Shot 1\]/g)?.length).toBe(3);
  });
});
