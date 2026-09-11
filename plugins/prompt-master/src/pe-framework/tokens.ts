/**
 * 实词词元集（T1/F1 共用）：≥2 字符词/词元（规范化小写）；CJK/假名连串以 2 字符 bigram 为最小单元。
 * 语义与原 eval/critic.ts tokensOf / tools/prompt-author.ts patchTokens 逐字节一致（三期 F1 抽公共 util）。
 */
export function tokensOf(s: string): Set<string> {
  const out = new Set<string>()
  for (const m of String(s).toLowerCase().matchAll(/[a-z0-9\u4e00-\u9fff\u3040-\u30ff\uff66-\uff9f]+/g)) {
    const run = m[0]
    if (/[a-z0-9]/.test(run[0]) && /[a-z0-9]/.test(run[run.length - 1])) {
      if (run.length >= 2) out.add(run)
    } else {
      // CJK/假名连串：无空格分词 → 以 2 字符词元（bigram）为最小单元，单字符不成词元
      for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
    }
  }
  return out
}

/** 词元集合包含判定：b 的每个词元都在 a 中（b 为空集时视为包含） */
export function tokensCoveredBy(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const t of b) if (!a.has(t)) return false
  return true
}
