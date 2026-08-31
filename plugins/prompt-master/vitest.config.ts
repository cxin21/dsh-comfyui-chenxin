import { defineConfig } from 'vitest/config'

/**
 * testTimeout: anima catalog 的 manifest 校验（~783 MiB sha256）在首次 db() 打开时
 * 同步执行（spec §4.2 运行时对账），真实库上耗时秒级——默认 5s per-test 会在
 * 并行 IO 下随机超时（历史 flake：catalog-search / anima-brief-golden / compile-anima）。
 * 30s 给足冗余；其余测试不受影响（正常用例毫秒级）。
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
})
