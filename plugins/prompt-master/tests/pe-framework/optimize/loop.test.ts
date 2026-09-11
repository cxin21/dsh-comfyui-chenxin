/**
 * Task 8（二期）: optimize-loop 驱动器（spec §10.3-A9）。
 * 行为规格 4 条逐条覆盖（brief）：冷启动闸门 / mock 迭代 / 报告落盘 / 失败不删报告。
 * live 模式用注入 mock provider/runWith 验证装配路径，不真调 LLM。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  recordGeneration,
  recordFeedback,
  type GenerationRow,
} from '../../../src/pe-framework/feedback/store.js'
import {
  runOptimizeLoop,
  runIterations,
  type LoopOptions,
  type LoopDeps,
} from '../../../src/pe-framework/optimize/loop.js'

const dir = mkdtempSync(join(tmpdir(), 'optimize-loop-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const PERSONA_FILE = join(dir, 'persona.txt')
writeFileSync(PERSONA_FILE, '你是 Anima 提示词作者。', 'utf8')

function dbPath(name: string): string {
  return join(dir, name + '.sqlite')
}

let seq = 0
function gen(overrides: Partial<GenerationRow> = {}): GenerationRow {
  seq += 1
  return {
    id: `gen_t8_${String(seq).padStart(4, '0')}`,
    created_at: Date.now() + seq,
    target: 'anima',
    judge_mode: 'fast',
    input_digest: 'a'.repeat(64),
    final_output: 'masterpiece, 1girl',
    enrich: 0,
    ...overrides,
  }
}

/** 造一个跨过冷启动门槛（L1=50）的 db。 */
function makeReadyDb(name: string): string {
  const p = dbPath(name)
  for (let i = 0; i < 50; i++) {
    const g = gen({ judge_score: 70 + (i % 10) })
    recordGeneration(p, g)
    recordFeedback(p, { generation_id: g.id, rating: i % 5 === 0 ? 2 : 4 })
  }
  return p
}

function opts(over: Partial<LoopOptions>): LoopOptions {
  return {
    target: 'anima',
    dbPath: dbPath('empty'),
    personaFile: PERSONA_FILE,
    mode: 'mock',
    outDir: join(dir, 'out-' + Math.random().toString(36).slice(2, 8)),
    ...over,
  }
}

// ---------- 1. 冷启动闸门 ----------
describe('runOptimizeLoop 冷启动闸门', () => {
  it('未达标 → ready:false + 落盘冷启动报告 + 不跑迭代', async () => {
    const low = dbPath('low') // 空 db：0 条 L1
    const o = opts({ dbPath: low })
    const r = await runOptimizeLoop(o)
    expect(r.ready).toBe(false)
    expect(r.candidateId).toBeUndefined()
    expect(r.evalsetSize).toBe(0)
    expect(r.reportPath).toBeTruthy()
    expect(existsSync(r.reportPath!)).toBe(true)
    const text = readFileSync(r.reportPath!, 'utf8')
    expect(text).toContain('冷启动未达标')
    expect(text).not.toContain('pairedDelta') // 没跑迭代
  })

  it('达标 → ready:true 走 mock 迭代并产报告', async () => {
    const p = makeReadyDb('ready')
    const o = opts({ dbPath: p })
    const r = await runOptimizeLoop(o)
    expect(r.ready).toBe(true)
    expect(r.candidateId).toMatch(/^cand_/)
    expect(r.evalsetSize).toBe(50) // 缺省 limit=20 在迭代内生效；evalsetSize=载入全量
    expect(r.reportPath).toBeTruthy()
    expect(existsSync(r.reportPath!)).toBe(true)
    const text = readFileSync(r.reportPath!, 'utf8')
    expect(text).toContain('pairedDelta')
    expect(text).toContain(r.candidateId!)
  })
})

// ---------- 2. mock 迭代行为 ----------
describe('runIterations mock', () => {
  it('固定评分 incumbent=70/candidate=82 + 固定变异；报告落盘 outDir/<target>-<timestamp>.md', async () => {
    const p = makeReadyDb('mock')
    const o = opts({ dbPath: p, limit: 3, outDir: join(dir, 'out-mock') })
    const r = await runIterations(o)
    expect(r.ready).toBe(true)
    expect(r.candidateId).toMatch(/^cand_/)
    expect(r.reportPath).toBeTruthy()
    // 文件名模式 <target>-<timestamp>.md（路径分隔符用 join 构造，不硬编码 \\，POSIX 也成立）
    expect(r.reportPath!.endsWith('.md')).toBe(true)
    expect(r.reportPath!.startsWith(join(o.outDir, 'anima-'))).toBe(true)
    const text = readFileSync(r.reportPath!, 'utf8')
    expect(text).toContain('mock diff')
    expect(text).toContain('casesRun=3') // limit 生效
    expect(text).toContain('| 维度 | incumbent | candidate |')
  })

  it('outDir 不存在时自动创建', async () => {
    const p = makeReadyDb('mkdir')
    const nested = join(dir, 'a', 'b', 'c')
    const r = await runIterations(opts({ dbPath: p, outDir: nested }))
    expect(existsSync(r.reportPath!)).toBe(true)
  })
})

// ---------- 3. live 装配（注入 mock，不真调 LLM） ----------
describe('runIterations live 装配', () => {
  it('live 无注入 → 明确抛错（离线 CLI 不支持 live）', async () => {
    const p = makeReadyDb('live-no')
    await expect(runIterations(opts({ dbPath: p, mode: 'live' }))).rejects.toThrow(/live/)
  })

  it('live + 注入 provider/runWith → 走真装配形状产出报告', async () => {
    const p = makeReadyDb('live')
    const calls: string[] = []
    const deps: LoopDeps = {
      provider: async (req) => {
        calls.push('provider:' + req.user.length)
        return JSON.stringify({ diff: 'live diff', rationale: 'live', targetsFailures: ['x'] })
      },
      runWith: async (candidateId, c) => {
        calls.push(`runWith:${candidateId}:${c.id}`)
        return { judgeScore: candidateId === 'incumbent' ? 60 : 75, rulePass: true }
      },
    }
    const r = await runIterations(opts({ dbPath: p, mode: 'live', limit: 2 }), deps)
    expect(r.ready).toBe(true)
    // 每 case 先 incumbent 后 candidate
    expect(calls.filter((x) => x.startsWith('runWith:incumbent:')).length).toBe(2)
    expect(calls.filter((x) => x.startsWith('runWith:cand_')).length).toBe(2)
    const text = readFileSync(r.reportPath!, 'utf8')
    expect(text).toContain('live diff')
  })
})

// ---------- 4. 失败不删已产出报告 ----------
describe('失败行为', () => {
  it('迭代中 provider 抛错 → 异常上抛，已产出文件不被删除', async () => {
    const p = makeReadyDb('fail')
    // 先跑一次成功产出报告
    const ok = await runIterations(opts({ dbPath: p, outDir: join(dir, 'out-fail') }))
    expect(existsSync(ok.reportPath!)).toBe(true)
    // 再跑一次 live 注入抛错的 provider：异常上抛，但上一份报告仍在
    const deps: LoopDeps = {
      provider: async () => {
        throw new Error('provider boom')
      },
      runWith: async () => ({ judgeScore: 60, rulePass: true }),
    }
    await expect(runIterations(opts({ dbPath: p, mode: 'live', outDir: join(dir, 'out-fail') }), deps)).rejects.toThrow(
      'provider boom',
    )
    expect(existsSync(ok.reportPath!)).toBe(true)
  })
})

// ---------- 5. Round7 T5 卫生包：同秒覆盖回归 + 后缀重试上限 ----------
describe('同秒同名报告不覆盖（回归钉住）', () => {
  /** 与 src writeReport 的 timestamp() 同格式的时刻串（YYYYMMDD-HHMMSS）。 */
  function nowTs(): string {
    const d = new Date()
    const q = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${q(d.getMonth() + 1)}${q(d.getDate())}-${q(d.getHours())}${q(d.getMinutes())}${q(d.getSeconds())}`
  }

  it('预写同名报告（OLD）→ runOptimizeLoop 保留旧文件，新报告落随机后缀新文件（防回退）', async () => {
    const p = makeReadyDb('collide')
    const o = opts({ dbPath: p, outDir: join(dir, 'out-collide') })
    // 测试取时刻与循环落盘可能跨秒边界：跨秒时循环落的是新秒基名（正常路径，非覆盖），
    // 未命中同名碰撞就重试，直到命中 writeReport 的 existsSync 分支
    for (let i = 0; i < 10; i++) {
      mkdirSync(o.outDir, { recursive: true })
      const collidePath = join(o.outDir, `anima-${nowTs()}.md`)
      writeFileSync(collidePath, 'OLD', 'utf8')
      const r = await runOptimizeLoop(o)
      // 命中碰撞的判据：reportPath 带 4 位随机后缀（跨秒未命中时落的是新秒基名，无后缀 → 重试）
      const base = basename(r.reportPath!)
      if (!/^anima-\d{8}-\d{6}-[0-9a-z]{4}\.md$/.test(base)) continue
      expect(readFileSync(collidePath, 'utf8')).toBe('OLD') // 旧报告内容未被覆盖
      return
    }
    throw new Error('10 次尝试均未命中同秒同名碰撞（不应发生）')
  })

  it('随机后缀重试超上限 → 显式抛错，不静默覆盖既有报告', async () => {
    const p = makeReadyDb('cap')
    const o = opts({ dbPath: p, outDir: join(dir, 'out-cap') })
    const fixedRand = 0.123456789
    const suffix = fixedRand.toString(36).slice(2, 6)
    // 固定 Math.random：每次后缀重试都生成同一后缀 → 必撞同一已存在文件名 → 必然触及重试上限
    const spy = vi.spyOn(Math, 'random').mockReturnValue(fixedRand)
    try {
      for (let i = 0; i < 10; i++) {
        mkdirSync(o.outDir, { recursive: true })
        const ts = nowTs() // 基名与后缀名必须同一秒，一次计算
        writeFileSync(join(o.outDir, `anima-${ts}.md`), 'OLD', 'utf8')
        const sfxPath = join(o.outDir, `anima-${ts}-${suffix}.md`)
        writeFileSync(sfxPath, 'OLD', 'utf8')
        try {
          await runOptimizeLoop(o)
        } catch (e) {
          expect((e as Error).message).toMatch(/随机后缀重试/)
          return
        }
        // 成功返回：跨秒未命中（sfxPath 未被动 → 重试）或被静默覆盖（→ 断言失败）
        if (readFileSync(sfxPath, 'utf8') === 'OLD') continue
        throw new Error('后缀重试应设上限抛错：既有报告被静默覆盖')
      }
      throw new Error('10 次尝试均未命中同秒同名碰撞（不应发生）')
    } finally {
      spy.mockRestore()
    }
  })
})
