import { describe, expect, it } from 'vitest';
import { createBgeOverlapSim } from '../../../src/pe-framework/compositing/vector-sim.js';
import type { EmbedFn } from '../../../src/pe-framework/dialect/anima-vector.js';

function stubEmbed(vectors: Record<string, Float32Array>, fail = false) {
  const calls: string[] = [];
  const embed: EmbedFn = async (texts) => {
    if (fail) throw new Error('embed boom');
    calls.push(...texts);
    return texts.map((t) => vectors[t] ?? new Float32Array([0, 1]));
  };
  return { calls, embed };
}

const PAR_A = new Float32Array([1, 0]);
const PAR_B = new Float32Array([2, 0]); // 与 A 平行（归一化后同向）
const ORTH = new Float32Array([0, 3]); // 与 A 正交

describe('createBgeOverlapSim (audit P1: D6 nl_tag_overlap 向量层，预热+同步查询)', () => {
  it('prewarmed parallel vectors → sim ≈ 1', async () => {
    const { embed } = stubEmbed({ 'Her hair flows in the wind.': PAR_A, 'long hair': PAR_B });
    const o = createBgeOverlapSim({ embed });
    await o.prewarm('Her hair flows in the wind.', ['long hair']);
    expect(o.sim('Her hair flows in the wind.', 'long hair')).toBeCloseTo(1, 5);
  });

  it('prewarmed orthogonal vectors → sim ≈ 0', async () => {
    const { embed } = stubEmbed({ 'Her hair flows in the wind.': PAR_A, 'long hair': ORTH });
    const o = createBgeOverlapSim({ embed });
    await o.prewarm('Her hair flows in the wind.', ['long hair']);
    expect(o.sim('Her hair flows in the wind.', 'long hair')).toBeCloseTo(0, 5);
  });

  it('non-normalized stub vectors still yield true cosine（接缝不信任 normalize 声明）', async () => {
    const { embed } = stubEmbed({ a: PAR_A, b: PAR_B });
    const o = createBgeOverlapSim({ embed });
    await o.prewarm('a', ['b']);
    expect(o.sim('a', 'b')).toBeCloseTo(1, 5); // raw dot 会得 2
  });

  it('embed failure → sim undefined（audit 保持词面检查路径）', async () => {
    const { embed } = stubEmbed({}, true);
    const o = createBgeOverlapSim({ embed });
    await o.prewarm('a', ['b']); // 不得 throw
    expect(o.sim('a', 'b')).toBeUndefined();
  });

  it('prewarm 只嵌入缺失文本（nl 句 × tag 跨轮缓存）', async () => {
    const stub = stubEmbed({ 'sentence one.': PAR_A, tag: PAR_B });
    const o = createBgeOverlapSim({ embed: stub.embed });
    await o.prewarm('sentence one.', ['tag']);
    await o.prewarm('sentence one.', ['tag']);
    expect(stub.calls).toHaveLength(2);
  });

  it('prewarm 跳过 CJK 句与空句（英文单语域，对齐 vector search 拒收语义）', async () => {
    const { embed, calls } = stubEmbed({ b: PAR_B });
    const o = createBgeOverlapSim({ embed });
    await o.prewarm('夜景', ['b', '']);
    expect(calls).toEqual(['b']);
  });

  it('sim 对未预热/空串/CJK 对返回 undefined', async () => {
    const { embed } = stubEmbed({ a: PAR_A, b: PAR_B });
    const o = createBgeOverlapSim({ embed });
    expect(o.sim('never prewarmed', 'b')).toBeUndefined();
    await o.prewarm('a', ['b']);
    expect(o.sim('', 'b')).toBeUndefined();
    expect(o.sim('夜景', 'b')).toBeUndefined();
    expect(o.sim('a', 'b')).toBeCloseTo(1, 5);
  });

  it('PM_VECTOR_OVERLAP=off → getSharedBgeOverlapSim 返回 no-op（sim 恒 undefined，prewarm 立即完成）', async () => {
    process.env.PM_VECTOR_OVERLAP = 'off';
    try {
      const { getSharedBgeOverlapSim } = await import('../../../src/pe-framework/compositing/vector-sim.js');
      const o = getSharedBgeOverlapSim();
      await o.prewarm('a', ['b']);
      expect(o.sim('a', 'b')).toBeUndefined();
    } finally {
      delete process.env.PM_VECTOR_OVERLAP;
    }
  });
});
