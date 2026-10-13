import { defineConfig } from 'vitest/config';

/**
 * testTimeout: anima catalog 的 manifest 校验（~783 MiB sha256）在首次 db() 打开时
 * 同步执行（spec §4.2 运行时对账），真实库上耗时秒级——默认 5s per-test 会在
 * 并行 IO 下随机超时（历史 flake：catalog-search / anima-brief-golden / compile-anima）。
 * 30s 给足冗余；其余测试不受影响（正常用例毫秒级）。
 *
 * setupFiles（P2-1 对抗审查）：全局注入 feedback db 临时路径——author-loop 等
 * 成功路径用例不注入会写 tracked 的 data/runtime/feedback.sqlite，每次全量
 * +86KB 二进制 diff 噪音。显式自管路径的测试（author-judge.e2e / prompt-feedback）
 * 在用例内再 set 即覆盖本注入（seam 语义：后写胜）。
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    setupFiles: ['tests/setup-global.ts'],
  },
});
