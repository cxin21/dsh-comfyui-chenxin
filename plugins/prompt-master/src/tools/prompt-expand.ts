import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveExpand } from '../resolver/index.js'
import { findProfileById } from '../resolver/profiles/index.js'
import { complete } from '../llm/complete.js'
import { resolveRoute, type ExecLike } from '../llm/route.js'
import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js'
import { sanitizeModelSpecific } from '../pe-framework/sanitize/model-specific.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'

export interface ExpandArgs {
  text: string
  profile?: string
  output_lang?: string
  length?: string
  extra_prompt?: string
  dry_run?: boolean
}

export function registerExpandTool(ctx: Context, config: Config) {
  return defineTool({
    name: 'prompt_expand',
    description: '将一段简短描述按所选 profile 扩写为可直接用于 AI 绘图/MiniMax 的完整提示词。可选 dry_run 查看组装结果而不调用模型。',
    parameters: {
      text: { type: 'string', description: '待扩写的简短描述（必填）' },
      profile: { type: 'string', default: 'pe_expand_natural', description: '扩写 profile id（可先用 profile_list 查询）' },
      output_lang: { type: 'string', default: 'zh', description: '输出语言 zh/en' },
      length: { type: 'string', default: 'medium', description: '篇幅 short/medium/long' },
      extra_prompt: { type: 'string', default: '', description: '附加要求' },
      dry_run: { type: 'boolean', default: false, description: '只返回组装好的 system/user/maxTokens，不调用模型' },
    },
    output: {
      schema: { type: 'string', description: '扩写正文；dry_run 时返回含 debug 的 JSON 字符串' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: ExpandArgs, exec: ToolRunContext) {
      type LogCtx = { logger?: { info?: (msg: string) => void } }
      const logInfo = (msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)
      const text = String(args.text || '').trim()
      if (!text) throw new Error('text is required')
      const profile = findProfileById(String(args.profile || 'pe_expand_natural').trim())
      if (!profile) throw new Error(`Profile not found: ${String(args.profile || 'pe_expand_natural')}`)
      logInfo(`[prompt-master] prompt_expand profile=${profile.id} length=${String(args.length || 'medium')}${args.dry_run ? ' dry_run=true' : ''}`)
      const expanded = resolveExpand(profile, {
        outputLang: String(args.output_lang || 'zh') as 'zh' | 'en' | 'auto',
        expandLen: String(args.length || 'medium'),
        userExtraPrompt: String(args.extra_prompt || ''),
        shortText: text,
      })
      if (args.dry_run) {
        const debug = JSON.stringify({
          debug: { system: expanded.system, user: expanded.user, maxTokens: expanded.maxTokens },
          profile_meta: { id: profile.id, name: profile.name, outputFormat: profile.outputFormat },
        })
        logInfo(`[prompt-master] prompt_expand → ok=true dry_run=true chars=${debug.length}`)
        return debug
      }
      const { provider, model } = resolveRoute(exec as ExecLike)
      const caps = getCapabilities(inferModelFamily(provider, model))
      const effectiveParams = applyCapabilities(caps, { temperature: config.temperature })
      const { text: result } = await complete(ctx, {
        provider, model,
        system: expanded.system,
        user: expanded.user,
        maxTokens: expanded.maxTokens,
        temperature: effectiveParams.temperature,
        signal: exec.signal,
      })
      const family = inferModelFamily(provider, model)
      const sanitized = sanitizeModelSpecific(result, { family, outputLang: String(args.output_lang || 'zh') })
      logInfo(`[prompt-master] prompt_expand sanitize family=${family} changed=${sanitized !== result}`)
      logInfo(`[prompt-master] prompt_expand → ok=true chars=${sanitized.length}`)
      return sanitized || ''
    },
  })
}