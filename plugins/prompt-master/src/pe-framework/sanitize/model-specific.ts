import { getCapabilities, type ModelFamily } from '../model-capabilities/index.js'

const THINK_RE = /<think>[\s\S]*?<\/think>/gi
const THINK_UNCLOSED_RE = /<think>[\s\S]*$/i
const THINK_ZH_RE = /思考[：:][\s\S]*?(?=\n|$)/g
const TAIL_MARKERS = ['润色与精简:', '精简后:', '最终输出:', 'Final polished caption:', 'Polished:', '最终答案:', '优化后:', 'Refined:']
const ECHO_LINE_RE = /^(这张图片|这是|我需要|关键词构思|整理|组合成|精简并优化|答案[:：])/

function stripThinkingTags(text: string): string {
  return text.replace(THINK_RE, '').replace(THINK_UNCLOSED_RE, '').replace(THINK_ZH_RE, '').trim()
}

function extractPolishedTail(text: string): string {
  let lastIdx = -1
  let lastLen = 0
  for (const marker of TAIL_MARKERS) {
    const idx = text.lastIndexOf(marker)
    if (idx > lastIdx) {
      lastIdx = idx
      lastLen = marker.length
    }
  }
  if (lastIdx === -1) return text
  const tail = text.slice(lastIdx + lastLen).trim()
  return tail.length >= 2 ? tail : text
}

function stripInstructionEchoLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !ECHO_LINE_RE.test(line.trim()))
    .join('\n')
    .trim()
}

/** 模型家族级输出净化（generic 级）：清 think 标签、提取润色尾段、去指令回声。'none' 级家族原样透传。 */
export function sanitizeModelSpecific(text: string, ctx: { family: ModelFamily; outputLang: string }): string {
  const caps = getCapabilities(ctx.family)
  if (caps.sanitizeLevel !== 'generic') return text
  let out = stripThinkingTags(text)
  out = extractPolishedTail(out)
  out = stripInstructionEchoLines(out)
  return out
}
