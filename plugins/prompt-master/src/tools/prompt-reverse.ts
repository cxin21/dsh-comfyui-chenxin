import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, ImageBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { resolveReverse } from '../resolver/index.js'
import { findProfileById } from '../resolver/profiles/index.js'
import { sanitizeFinalCaption } from '../resolver/profiles/reverse/router.js'
import { completeWithBlocks } from '../llm/complete.js'
import { resolveRoute, type ExecLike } from '../llm/route.js'
import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js'
import { resolveJoyExtraOptions, buildJoyExtraSystemBlock, buildJoyExtraUserTail, filterJoyExtraClauses } from '../pe-framework/sanitize/joy-extra.js'
import { sanitizeModelSpecific } from '../pe-framework/sanitize/model-specific.js'
import { enumerateTaggedMedia, buildIdentityDeclarations } from '../pe-framework/media/identity.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'

export interface ReverseArgs {
  image_description?: string
  profile?: string
  output_lang?: string
  length?: string
  extra_prompt?: string
  joy_extra_options?: string[]
  character_name?: string
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
      joy_extra_options: { type: 'array', default: [], description: 'JoyExtra 硬约束选项（no_glasses_headwear / scene_only_no_character_appearance / no_artistic_style / character_name）；硬约束优先级高于检查表' },
      character_name: { type: 'string', default: '', description: '角色称呼（配合 joy_extra_options=character_name 使用）' },
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
      type LogCtx = { logger?: { info?: (msg: string) => void } }
      const logInfo = (msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)
      const desc = String(args.image_description || '').trim()
      const images = await collectRecentImages(exec)
      if (!desc && images.length === 0) throw new Error('image_description is required, or attach an image to the session')
      const profile = findProfileById(String(args.profile || 'pe_reverse_descriptive').trim())
      if (!profile) throw new Error(`Profile not found: ${String(args.profile || 'pe_reverse_descriptive')}`)
      logInfo(`[prompt-master] prompt_reverse profile=${profile.id} media_target=${String(args.media_target || 'image')} images=${images.length}${args.dry_run ? ' dry_run=true' : ''}`)
      const reverseResult = resolveReverse(profile, {
        caption_lang: String(args.output_lang || 'zh') as 'zh' | 'en' | 'auto',
        len: String(args.length || 'medium'),
        media_target: String(args.media_target || 'image') as 'image' | 'video',
        extra_prompt: String(args.extra_prompt || ''),
        anima3_enhance: args.anima3_enhance === true,
      })
      const joyExtra = resolveJoyExtraOptions({
        joyExtraOptions: args.joy_extra_options,
        extraPrompt: String(args.extra_prompt || ''),
        characterName: args.character_name,
      })
      const outputLang = (String(args.output_lang || 'zh') === 'en' ? 'en' : 'zh') as 'zh' | 'en'
      const joySystemBlock = joyExtra.options.length > 0 ? buildJoyExtraSystemBlock(joyExtra, outputLang) : ''
      const system = joySystemBlock ? `${reverseResult.system}\n\n${joySystemBlock}` : reverseResult.system
      const joyUserTail = joyExtra.options.length > 0 ? buildJoyExtraUserTail(joyExtra, outputLang) : ''
      const user = [reverseResult.userLead, reverseResult.userBody, reverseResult.outputConstraints, reverseResult.userTail, joyUserTail]
        .filter(Boolean).join('\n')
      // 文本路径修复：画面描述必须进入 LLM 上下文。user 是组装指令，desc 是用户对画面的描述；
      // user 开头非空时也要并入 desc，否则模型只收到指令、看不到画面内容（历史 bug：
      // builtin reverse profiles 四段拼接恒非空 → `user || desc` 永远取 user，desc 被静默丢弃）。
      const text = user
        ? (desc ? `${user}\n\n[${String(args.output_lang || 'zh') === 'en' ? 'Scene description' : '画面描述'}]\n${desc}` : user)
        : desc
      if (args.dry_run) {
        const debug = JSON.stringify({
          debug: {
            system,
            text,
            imageBlocks: images.length,
            maxTokens: 512,
          },
          profile_meta: { id: profile.id, name: profile.name, outputFormat: profile.outputFormat },
        })
        logInfo(`[prompt-master] prompt_reverse → ok=true dry_run=true chars=${debug.length}`)
        return debug
      }
      const { provider, model } = resolveRoute(exec as ExecLike)
      const caps = getCapabilities(inferModelFamily(provider, model))
      const effectiveParams = applyCapabilities(caps, { temperature: config.temperature })
      // 多图身份映射（B4 S 子集）：≥2 张图时在媒体块之前注入身份声明，防止模型混淆哪张图是哪张
      const media = enumerateTaggedMedia(images.length)
      const declarations = buildIdentityDeclarations(media, outputLang)
      const blocks: ContentBlock[] = []
      if (declarations) {
        blocks.unshift({ type: 'text', text: declarations })   // 声明块置于媒体块之前
        logInfo(`[prompt-master] multi-image identity declarations injected (n=${images.length})`)
      }
      blocks.push(
        ...images.map((b) => ({ ...b })),
        ...(text ? [{ type: 'text' as const, text }] : []),
      )
      if (images.length > 0) {
        const info = await (ctx.llm as any).resolveModelInfo?.(provider, model, exec.signal)
        if (!info || !info.inputModalities?.includes('image')) {
          throw new Error(`当前模型 ${model} 不支持图片输入，请在 Web UI Settings→Models 切换到支持图片输入的模型（如 deepseek-v4-flash-vision-exp），或在参数中提供 image_description 文本描述`)
        }
      }
      const { text: raw } = await completeWithBlocks(ctx, {
        provider, model,
        system,
        blocks,
        maxTokens: 512,
        temperature: effectiveParams.temperature,
        signal: exec.signal,
      })
      const family = inferModelFamily(provider, model)
      const modelSanitized = sanitizeModelSpecific(raw, { family, outputLang: String(args.output_lang || 'zh') })
      logInfo(`[prompt-master] prompt_reverse sanitize family=${family} changed=${modelSanitized !== raw}`)
      const sanitized = sanitizeFinalCaption(modelSanitized, {
        type: reverseResult.captionType,
        caption_lang: String(args.output_lang || 'zh'),
        len: String(args.length || 'medium'),
        anima3_enhance: args.anima3_enhance === true,
        quality_prompt_enabled: args.quality_prompt_enabled === true,
        quality_prompt_prefix: String(args.quality_prompt_prefix || ''),
      })
      const joyFilteredBefore = sanitized
      const finalCaption = joyExtra.options.length > 0 ? filterJoyExtraClauses(sanitized, joyExtra) : sanitized
      logInfo(`[prompt-master] prompt_reverse → ok=true chars=${finalCaption.length} joy_extra options=${joyExtra.options.join('|') || 'none'} filtered=${finalCaption !== joyFilteredBefore ? 'yes' : 'no'}`)
      return finalCaption
    },
  })
}