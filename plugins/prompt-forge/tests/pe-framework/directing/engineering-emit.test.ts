import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { emitEngineering } from '../../../src/pe-framework/directing/engineering/emit.js'
import { buildGoodIr } from './ir-schema.test.js'
import type { DirectingIr } from '../../../src/pe-framework/directing/ir-schema.js'

let dir: string | undefined
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function makeIr(overrides?: Partial<DirectingIr>): DirectingIr {
  const ir = buildGoodIr()
  // 给一个 shot 填充 prompt 以测试 prompts/ 输出
  ir.beats[0].shots[0].prompt = { text: 't2va compiled text here', token_count: 42 }
  ir.continuity_ledger = [{ check: 'props', beat_span: 'B01', status: 'ok', note: '' }]
  if (overrides) Object.assign(ir, overrides)
  return ir
}

describe('emitEngineering（spec §4 工程输出物三件套）', () => {
  it('storyboard.json / prompts/*.txt / continuity-ledger.json 全部落盘', () => {
    dir = mkdtempSync(join(tmpdir(), 'emit-test-'))
    const r = emitEngineering(dir, makeIr())
    expect(existsSync(r.storyboardPath)).toBe(true)
    expect(r.promptPaths.length).toBe(1) // 只有 B01-S1 有 prompt
    expect(existsSync(r.promptPaths[0])).toBe(true)
    expect(existsSync(r.ledgerPath)).toBe(true)
    // storyboard 内容 = DirectingIr 序列化
    const sb = JSON.parse(readFileSync(r.storyboardPath, 'utf8'))
    expect(sb.meta.title).toBe('t')
    expect(sb.beats).toHaveLength(2)
  })

  it('幂等重跑覆盖（不追加不残留）', () => {
    const ir = makeIr()
    emitEngineering(dir!, ir)
    const r2 = emitEngineering(dir!, ir)
    const sb = JSON.parse(readFileSync(r2.storyboardPath, 'utf8'))
    expect(sb.beats).toHaveLength(2) // 不翻倍
  })

  it('prompt 为 null 的 shot 不生成 .txt', () => {
    const ir = makeIr()
    const r = emitEngineering(dir!, ir)
    for (const p of r.promptPaths) expect(p).toContain('B01-S1') // 只有一个有 prompt
  })
})
