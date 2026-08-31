import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { listScenarios, getScenarioById, resolveMinimaxScenarioExpand } from '../resolver/minimax/index.js'
import { countChars } from '../utils/length.js'
import { complete } from '../llm/complete.js'
import { resolveRoute, type ExecLike } from '../llm/route.js'
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
    },
    output: {
      schema: { type: 'string', description: 'JSON 字符串：{prompt, sections, scenario, budget, dry_run?}' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { scenario_id?: string; form_fields?: Record<string, unknown>; output_lang?: string; dry_run?: boolean }, exec: ToolRunContext) {
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
      const { text, usage } = await complete(ctx, {
        provider, model, system: expanded.system, user: expanded.user,
        maxTokens: expanded.maxTokens, temperature: config.temperature, signal: exec.signal,
      })
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