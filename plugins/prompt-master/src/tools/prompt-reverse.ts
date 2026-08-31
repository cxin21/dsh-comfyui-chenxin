import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, ImageBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { resolveReverse } from '../resolver/index.js'
import { findProfileById } from '../resolver/profiles/index.js'
import { sanitizeFinalCaption } from '../resolver/profiles/reverse/router.js'
import { completeWithBlocks } from '../llm/complete.js'
import { resolveRoute, type ExecLike } from '../llm/route.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'

export interface ReverseArgs {
  image_description?: string
  profile?: string
  output_lang?: string
  length?: string
  extra_prompt?: string
  anima3_enhance?: boolean
  quality_prompt_enabled?: boolean
  quality_prompt_prefix?: string
  media_target?: string
  dry_run?: boolean
}

/** 反向找最近一个 'user/message' 事件中的全部 image block */
export async function collectRecentImages(exec: ToolRunContext): Promise<ImageBlock[]> {
  const events = (exec.agent as any)?.session?.events
  if (!Array.isArray(events)) return []
  const images: ImageBlock[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev?.type !== 'user/message') continue
    const msg = ev.data as UserMessage
    if (!Array.isArray(msg?.content)) continue
    for (const block of msg.content) if (block.type === 'image') images.push(block as ImageBlock)
    if (images.length > 0) return images
  }
  return images
}

export function registerReverseTool(ctx: Context, config: Config) {
  return defineTool({
    name: 'prompt_reverse',
    description: '根据图片描述（或会话中的图片附件）反推生成可直接用于 AI 绘图的提示词。output_lang/length/profile 决定输出风格。可选 dry_run 查看组装结果而不调用模型。',
    parameters: {
      image_description: { type: 'string', description: '对画面的描述（必填；若会话最近有图片附件可省略，以图片为准）' },
      profile: { type: 'string', default: 'pe_reverse_descriptive', description: '反推 profile id：pe_reverse_descriptive / pe_reverse_sd / pe_reverse_danbooru 或自定义' },
      output_lang: { type: 'string', default: 'zh', description: '输出语言 zh/en' },
      length: { type: 'string', default: 'medium', description: '篇幅 short/medium/long' },
      extra_prompt: { type: 'string', default: '', description: '附加要求' },
      anima3_enhance: { type: 'boolean', default: false, description: 'Anima3 增强' },
      quality_prompt_enabled: { type: 'boolean', default: false, description: '启用质量词前缀' },
      quality_prompt_prefix: { type: 'string', default: '', description: '自定义质量词前缀' },
      media_target: { type: 'string', default: 'image', description: 'image（默认，兼容现有）/ anima / h3——anima=产出可槽位化的丰富描述，h3=产出分镜素材' },
      dry_run: { type: 'boolean', default: false, description: '只返回组装好的 system/text/maxTokens，不调用模型' },
    },
    output: {
      schema: { type: 'string', description: '反推提示词正文；dry_run 时返回含 debug 的 JSON 字符串' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: ReverseArgs, exec: ToolRunContext) {
      const desc = String(args.image_description || '').trim()
      const images = await collectRecentImages(exec)
      if (!desc && images.length === 0) throw new Error('image_description is required, or attach an image to the session')
      const profile = findProfileById(String(args.profile || 'pe_reverse_descriptive').trim())
      if (!profile) throw new Error(`Profile not found: ${String(args.profile || 'pe_reverse_descriptive')}`)
      const reverseResult = resolveReverse(profile, {
        caption_lang: String(args.output_lang || 'zh') as 'zh' | 'en' | 'auto',
        len: String(args.length || 'medium'),
        media_target: String(args.media_target || 'image') as 'image' | 'video',
        extra_prompt: String(args.extra_prompt || ''),
        anima3_enhance: args.anima3_enhance === true,
      })
      const user = [reverseResult.userLead, reverseResult.userBody, reverseResult.outputConstraints, reverseResult.userTail]
        .filter(Boolean).join('\n')
      // 文本路径修复：画面描述必须进入 LLM 上下文。user 是组装指令，desc 是用户对画面的描述；
      // user 开头非空时也要并入 desc，否则模型只收到指令、看不到画面内容（历史 bug：
      // builtin reverse profiles 四段拼接恒非空 → `user || desc` 永远取 user，desc 被静默丢弃）。
      const text = user
        ? (desc ? `${user}\n\n[${String(args.output_lang || 'zh') === 'en' ? 'Scene description' : '画面描述'}]\n${desc}` : user)
        : desc
      if (args.dry_run) {
        return JSON.stringify({
          debug: {
            system: reverseResult.system,
            text,
            imageBlocks: images.length,
            maxTokens: 512,
          },
          profile_meta: { id: profile.id, name: profile.name, outputFormat: profile.outputFormat },
        })
      }
      const { provider, model } = resolveRoute(exec as ExecLike)
      const blocks: ContentBlock[] = [
        ...images.map((b) => ({ ...b })),
        ...(text ? [{ type: 'text' as const, text }] : []),
      ]
      if (images.length > 0) {
        const info = await (ctx.llm as any).resolveModelInfo?.(provider, model, exec.signal)
        if (!info || !info.inputModalities?.includes('image')) {
          throw new Error(`当前模型 ${model} 不支持图片输入，请在 Web UI Settings→Models 切换到支持图片输入的模型（如 deepseek-v4-flash-vision-exp），或在参数中提供 image_description 文本描述`)
        }
      }
      const { text: raw } = await completeWithBlocks(ctx, {
        provider, model,
        system: reverseResult.system,
        blocks,
        maxTokens: 512,
        temperature: config.temperature,
        signal: exec.signal,
      })
      const sanitized = sanitizeFinalCaption(raw, {
        type: reverseResult.captionType,
        caption_lang: String(args.output_lang || 'zh'),
        len: String(args.length || 'medium'),
        anima3_enhance: args.anima3_enhance === true,
        quality_prompt_enabled: args.quality_prompt_enabled === true,
        quality_prompt_prefix: String(args.quality_prompt_prefix || ''),
      })
      return sanitized
    },
  })
}