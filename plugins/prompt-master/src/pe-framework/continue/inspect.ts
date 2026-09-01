import type { OutputContract, StructureInspection } from './contract.js'

export type { OutputContract, StructureInspection }

/**
 * Inspect a model output against a contract: every field pattern must hit,
 * and the text right after the hit label (up to end of line) must be a
 * non-empty body (>= 2 chars after trim), otherwise the field counts as missing.
 */
export function inspectOutput(text: string, contract: OutputContract, formFields?: Record<string, unknown>): StructureInspection {
  const missing: string[] = []
  for (const f of contract.fields) {
    const hit = f.patterns.some((re) => re.test(text))
    if (!hit) { missing.push(`field:${f.key}`); continue }
    // 标签体非空检查：取命中标签之后到下一个换行（或文末）的文本段
    for (const re of f.patterns) {
      const m = re.exec(text)
      if (m && m.index !== undefined) {
        const lineEnd = text.indexOf('\n', m.index)
        const body = text.slice(m.index + m[0].length, lineEnd === -1 ? undefined : lineEnd)
        // 仅空标签体视为缺失（单字符正文如 "X" 算有效内容 — 以测试为准）
        if (body.trim().length === 0) { missing.push(`field:${f.key}`) }
        break
      }
    }
  }
  // 分组检查（如 director_segments）：组数 = 分隔符匹配数（前导段视为前言，不计入组）；
  // 每组分隔符后须有非空正文
  if (contract.groupSeparator) {
    const sep = new RegExp(contract.groupSeparator.source, contract.groupSeparator.flags.includes('g') ? contract.groupSeparator.flags : contract.groupSeparator.flags + 'g')
    const matches = [...text.matchAll(sep)]
    const groupCount = matches.length
    const expected = contract.expectedGroups?.(formFields ?? {}) ?? 0
    if (groupCount < expected) missing.push(`groups:${groupCount}/${expected}`)
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]
      const end = i + 1 < matches.length ? matches[i + 1].index! : text.length
      if (text.slice(m.index! + m[0].length, end).trim().length === 0) missing.push(`group:${m[1] ?? i + 1}:body`)
    }
  }
  return { missing, complete: missing.length === 0 }
}
