import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { h3RatingUnsupportedError } from './h3-rating-gate.js'
import { listScenarios, getScenarioById, resolveMinimaxScenarioExpand } from '../resolver/minimax/index.js'
import { countChars } from '../utils/length.js'
import { complete } from '../llm/complete.js'
import { resolveRoute, type ExecLike } from '../llm/route.js'
import { sceneOutputContract } from '../pe-framework/schema/scenes.js'
import { continueUntilComplete } from '../pe-framework/continue/engine.js'
import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'

const STAGE_BUDGETS: Record<string, { text_tokens: number; char_limit: number }> = {
  t2va: { text_tokens: 1200, char_limit: 7000 },
  i2va: { text_tokens: 1500, char_limit: 7000 },
  fl2va: { text_tokens: 1700, char_limit: 7000 },
  l2va: { text_tokens: 1700, char_limit: 7000 },
  ref2va: { text_tokens: 2400, char_limit: 7000 },
}

function pickStage(outputMode: string, scenarioId: string): string {
  if (outputMode === 'full_reference' || outputMode === 'director_segments') {
    return scenarioId === 'full_reference' ? 'ref2va' : 't2va'
  }
  return 't2va'
}

function splitSections(prompt: string, outputMode: string): Record<string, string> {
  if (outputMode !== 'full_reference') return { full: prompt }
  const sections: Record<string, string> = {}
  const sectionRegex = /(主体定义:|摘要:|保留分析:|详细描述:|整体声景:|非叙事配乐:)/g
  const parts = prompt.split(sectionRegex)
  for (let i = 1; i < parts.length; i += 2) {
    sections[parts[i].replace(/:$/, '')] = (parts[i + 1] ?? '').trim()
  }
  return sections
}

export function registerMinimaxTool(ctx: Context, config: Config) {
  return defineTool({
    name: 'minimax_scenario',
    description: '按 MiniMax H3 官方场景模板生成视频提示词（场景结构预览/探索用途）。注意分工：正式出提示词请走 prompt_author(target=h3) 或 prompt_compile(target=h3)（含完整审计与精确 token 预算）；本工具用于场景选择与 dry_run 预览。空 scenario_id 返回全部场景。',
    parameters: {
      scenario_id: { type: 'string', description: '场景 id（如 full_reference；留空返回场景列表）', default: '' },
      form_fields: { type: 'object', description: '场景表单字段（随场景而异）', default: {}, additionalProperties: true },
      output_lang: { type: 'string', default: 'zh', description: '输出语言 zh/en/ja' },
      dry_run: { type: 'boolean', default: false, description: '只返回组装+审计结果' },
      rating: { type: 'string', enum: ['safe', 'sensitive', 'explicit'], default: 'safe', description: '内容分级声明（spec §5.2）；本工具为 H3 场景面——MiniMax 政策只支持 safe（spec §5.5），声明 sensitive/explicit 将被 argument error 拒绝（不做降级猜测）' },
    },
    output: {
      schema: { type: 'string', description: 'JSON 字符串：{prompt, sections, scenario, budget, dry_run?}' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { scenario_id?: string; form_fields?: Record<string, unknown>; output_lang?: string; dry_run?: boolean; rating?: string }, exec: ToolRunContext) {
      // M3-T1（spec §5.5 L185 / §7 P4）：rating 输入源——枚举 fail-fast + h3 硬约束
      // （target=h3 等价面：本工具即 H3 场景工具，MiniMax 政策只支持 safe），两道校验
      // 都在任何 LLM 调用之前（0 token，与 prompt_author 预检同源语义）。
      const RATING_TIERS = ['safe', 'sensitive', 'explicit'] as const
      const ratingArg = String(args.rating ?? 'safe')
      if (!(RATING_TIERS as readonly string[]).includes(ratingArg)) {
        throw new Error(`invalid rating: ${ratingArg}（枚举 safe|sensitive|explicit，缺省 safe）`)
      }
      const rating = ratingArg as (typeof RATING_TIERS)[number]
      if (rating !== 'safe') {
        // M4-T2：错误串共享常量（h3-rating-gate.ts 单一来源，文案零变化）
        throw h3RatingUnsupportedError(`本工具为 H3 场景面，rating=${rating} `, '(target=anima)')
      }
      const scenarioId = String(args.scenario_id || '').trim()
      if (!scenarioId) return JSON.stringify({ scenarios: listScenarios(), hint: '请指定 scenario_id 选择一个场景' })
      const scenario = getScenarioById(scenarioId)
      if (!scenario) throw new Error(`Scenario not found: ${scenarioId}`)
      const language = String(args.output_lang || 'zh')
      const expanded = resolveMinimaxScenarioExpand(
        { id: scenario.peId, minimaxScenarioId: scenario.id, kind: 'expand' },
        { outputLang: language, minimaxForm: { form_fields: args.form_fields || {}, output_lang: language } },
      )
      if (!expanded) throw new Error('Failed to assemble scenario prompt')
      const stageKey = pickStage(scenario.outputMode || 'full_reference', scenario.id)
      const budgetCfg = STAGE_BUDGETS[stageKey] || STAGE_BUDGETS.t2va
      if (args.dry_run) {
        const char_count = countChars(expanded.user)
        return JSON.stringify({
          prompt: expanded.user,
          sections: splitSections(expanded.user, scenario.outputMode || 'full_reference'),
          scenario: { id: scenario.id, name: scenario.name, outputMode: scenario.outputMode },
          budget: { text_tokens: budgetCfg.text_tokens, char_count, char_limit: budgetCfg.char_limit, over: char_count > budgetCfg.char_limit },
          dry_run: true,
        })
      }
      const { provider, model } = resolveRoute(exec as ExecLike)
      const caps = getCapabilities(inferModelFamily(provider, model))
      const effectiveParams = applyCapabilities(caps, { temperature: config.temperature })
      const { text: rawText, usage, finish } = await complete(ctx, {
        provider, model, system: expanded.system, user: expanded.user,
        maxTokens: expanded.maxTokens, temperature: effectiveParams.temperature, signal: exec.signal,
      })
      // T14 Task 3：场景声明输出契约 → 截断/缺段时走 continueUntilComplete 定向续写
      const contract = sceneOutputContract(scenario.id, scenario.outputMode)
      let text = rawText
      let continueRounds = 0
      let continueComplete = true
      if (contract) {
        const outcome = await continueUntilComplete({
          contract,
          initialText: text,
          finishKind: finish.kind,
          seed: { system: expanded.system, userText: expanded.user, outputLang: language === 'en' ? 'en' : 'zh' },
          generate: async (req) => {
            const g = await complete(ctx, {
              provider, model, system: req.system ?? expanded.system, user: req.user,
              maxTokens: expanded.maxTokens, temperature: effectiveParams.temperature, signal: exec.signal,
            })
            return { text: g.text, finishKind: g.finish.kind }
          },
          signal: exec.signal,
          formFields: args.form_fields || {},
          // M3-T1（spec §7 P4）：T13 四接线点最后两处之一从工具流激活——declaredRating
          // 恒透传（safe 缺省），续写修订轮携带评级行（不得降档/清洗/委婉化）。
          declaredRating: rating,
          onContinue: (n, max) => ctx.logger?.info?.(`[prompt-master] continue round=${n}/${max}`),
        })
        text = outcome.text
        continueRounds = outcome.rounds
        continueComplete = outcome.complete
        ctx.logger?.info?.(`[prompt-master] minimax_scenario → continue complete=${outcome.complete} rounds=${continueRounds}`)
      }
      const char_count = countChars(text)
      return JSON.stringify({
        prompt: text,
        sections: splitSections(text, scenario.outputMode || 'full_reference'),
        scenario: { id: scenario.id, name: scenario.name, outputMode: scenario.outputMode },
        budget: {
          text_tokens: usage?.outputTokens || budgetCfg.text_tokens,
          char_count, char_limit: budgetCfg.char_limit, over: char_count > budgetCfg.char_limit,
        },
      })
    },
  })
}