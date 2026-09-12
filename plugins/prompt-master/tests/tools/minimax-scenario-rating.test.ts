/**
 * M3-T1（t62）：minimax_scenario 通道 rating 输入源（spec §7 P4 / §5.5 L185）。
 *
 * T13 四接线点最后两处的「工具流激活」（t40 scope note 269df7a：continue/mutate 属
 * 各自流程，非 prompt_author 可达）：
 * - continue：engine 的 declaredRating 参数面早已就绪（P4 评级行），但其唯一生产调用方
 *   minimax-scenario 无任何 rating 输入源——本任务给工具 +rating?: Rating（safe 缺省），
 *   解析后恒透传 continueUntilComplete({declaredRating})，P4 行从工具流可达（e2e 捕获）。
 * - mutate：T13 P5 契约是静态行（MUTATION_PERSONA 恒含硬边界约束，无 rating 参数——
 *   计划原文「透传 mutate 的 declaredRating」按 T13 静态契约与本任务 Files（工具定义 +
 *   continue/mutate 调用链测试，不含 mutate.ts）裁定为流级证据：经 runIterations live
 *   装配链捕获 persona 断言硬边界行在 mutate 流可达。给 proposeMutation 加无生产调用方
 *   的死参数属 cargo cult，不做（偏差备案进任务 output）。
 * - h3 硬约束（spec §5.5 L185，本任务首次落地语义）：minimax_scenario 即 H3 场景面
 *   （target=h3 等价面），rating ≠ safe → argument error（可操作错误信息：政策依据 +
 *   指路 prompt_author(target=anima)），不做降级猜测；枚举非法同样 fail-fast；两道
 *   校验都在任何 LLM 调用之前（0 token 语义与 prompt_author 预检同源）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerMinimaxTool } from '../../src/tools/minimax-scenario.js'
import { runIterations } from '../../src/pe-framework/optimize/loop.js'
import { recordGeneration, recordFeedback } from '../../src/pe-framework/feedback/store.js'
import { stubCtx, runTool, textStream, type StubContext, type ToolDefLike } from '../plugin/helpers.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

const P4_SAFE_LINE = '当前内容分级：safe——修订不得降档、不得清洗或委婉化已声明内容、不得触碰硬边界负向。'

function def(ctx: unknown = stubCtx()): ToolDefLike {
  // 工具的 complete() 走注册时闭包捕获的 ctx（非 exec 参数）——捕获与调用必须同一个 ctx
  return registerMinimaxTool(ctx as never, { temperature: 0.7 } as never) as unknown as ToolDefLike
}

/** stubCtx 的 stream 是固定脚本；continue 链路需要「首次截断 + 续写轮」的多次调用，
 *  这里按调用序出队脚本（超出部分重复末一个）。GenerateOptions 形状与 stubCtx 一致。 */
function scriptedCtx(scripts: StreamChunk[][]): StubContext {
  const calls: GenerateOptions[] = []
  let i = 0
  const ctx = {
    tools: { registered: [], register() { return () => {} } },
    llm: {
      calls,
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls.push(options)
        const script = scripts[Math.min(i, scripts.length - 1)]
        i++
        for (const chunk of script) yield chunk
      },
    },
    effect() {},
  }
  return ctx as unknown as StubContext
}

/** stubCtx 捕获的是 dsh-llm GenerateOptions：system 直挂顶层，user 文本在 messages[0].content[] 块内 */
function userTextOf(c: unknown): string {
  const msgs = (c as { messages?: Array<{ content?: unknown }> })?.messages ?? []
  const blocks = msgs[0]?.content
  if (typeof blocks === 'string') return blocks
  return Array.isArray(blocks) ? blocks.map((b) => (b as { text?: string })?.text ?? '').join('\n') : ''
}

describe('M3-T1 minimax_scenario rating input source (spec §7 P4 / §5.5 L185)', () => {
  it('schema: rating param with three-tier enum defaulting safe', () => {
    const props = (def().parameters as { properties?: Record<string, unknown> }).properties ?? {}
    const rating = props['rating'] as { type?: string; enum?: string[]; default?: string }
    expect(rating?.type).toBe('string')
    expect(rating?.enum).toEqual(['safe', 'sensitive', 'explicit'])
    expect(rating?.default).toBe('safe')
  })

  it('h3 hard gate (spec L185): rating=sensitive/explicit → argument error before any LLM call, no downgrade guessing', async () => {
    for (const rating of ['sensitive', 'explicit'] as const) {
      const ctx = stubCtx()
      await expect(
        runTool(ctx, def(), { scenario_id: 'full_reference', rating }),
      ).rejects.toThrow(/h3_rating_unsupported/)
      await expect(
        runTool(ctx, def(), { scenario_id: 'full_reference', rating }),
      ).rejects.toThrow(/只支持 safe/)
      await expect(
        runTool(ctx, def(), { scenario_id: 'full_reference', rating }),
      ).rejects.toThrow(/prompt_author\(target=anima\)/)
      // 0 token：拒收发生在任何 LLM 调用之前（与 prompt_author 预检同源语义）
      expect(ctx.llm.calls.length).toBe(0)
    }
  })

  it('enum validation: non-tier rating → fail-fast argument error (0 LLM)', async () => {
    const ctx = stubCtx()
    await expect(
      runTool(ctx, def(), { scenario_id: 'full_reference', rating: 'bogus' }),
    ).rejects.toThrow(/rating/)
    expect(ctx.llm.calls.length).toBe(0)
  })

  it('continue threading: default rating (safe) reaches continueUntilComplete — P4 line captured on the first continue round', async () => {
    // full_reference → ref2va 六段契约；首轮返回不含任何段名 → 结构不完整 → 至少一轮续写
    const ctx = scriptedCtx([textStream('ok')])
    const v = JSON.parse(String(await runTool(ctx, def(ctx), { scenario_id: 'full_reference' })))
    // call#0 = 首次生成；call#1 = continue 第 1 轮——P4 评级行必须在场（safe 缺省恒透传）
    expect(userTextOf((ctx.llm as { calls: unknown[] }).calls[1])).toContain(P4_SAFE_LINE)
    expect(v.prompt).toBeDefined()
    expect(v.budget).toBeDefined()
  })

  it('mutate flow persona capture: hard-boundary constraint line rides the runIterations live assembly chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-m3t1-'))
    try {
      const personaFile = join(dir, 'persona.txt')
      writeFileSync(personaFile, '你是 Anima 提示词作者。', 'utf8')
      const dbPath = join(dir, 'fb.sqlite')
      // 3 条 L1（一条负例）——负例走 negatives 过滤进 buildUser，persona 恒为 MUTATION_PERSONA
      for (let i = 0; i < 3; i++) {
        const g = {
          id: `gen_m3t1_${i}`, created_at: Date.now() + i, target: 'anima' as const,
          judge_mode: 'fast', input_digest: 'a'.repeat(64), final_output: 'masterpiece, 1girl', enrich: 0 as const,
        }
        recordGeneration(dbPath, g)
        recordFeedback(dbPath, { generation_id: g.id, rating: i === 0 ? 2 : 4 })
      }
      const captured: Array<{ persona: string }> = []
      const r = await runIterations(
        { target: 'anima', dbPath, personaFile, mode: 'live', outDir: join(dir, 'out') },
        {
          provider: async (req) => {
            captured.push({ persona: req.persona })
            return JSON.stringify({ diff: 'd', rationale: 'r', targetsFailures: ['x'] })
          },
          runWith: async () => ({ judgeScore: 82, rulePass: true }),
        },
      )
      expect(r.ready).toBe(true)
      expect(captured).toHaveLength(1)
      // T13 P5 静态契约行在 mutate 流（loop → proposeMutation → provider）可达
      expect(captured[0]?.persona).toContain(
        '变异候选不得修改内容分级语义与硬边界规则（safety/boundaries 词表与策略表为常量）。',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
