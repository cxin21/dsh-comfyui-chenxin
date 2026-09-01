/** Common LLM continuation greetings to strip before merging. */
const GREETING = /^(好的[，。！!]?|继续输出[：:]?|如下[：:]?)\s*/

/**
 * Merge a continuation piece into the accumulated text:
 * 1. strip greeting prefix,
 * 2. parrot detection (model repeats the full accumulated text → take continued only),
 * 3. suffix-prefix overlap detection (window 12..240 chars) → dedupe join,
 * 4. otherwise newline join.
 */
export function mergeContinuedText(previous: string, continued: string): string {
  const cont = continued.replace(GREETING, '').trim()
  if (!cont) return previous
  if (cont.startsWith(previous.trim())) return cont // 复读
  // 后缀-前缀重叠探测：窗口 12..240
  const maxWin = Math.min(240, previous.length, cont.length)
  for (let win = maxWin; win >= 12; win--) {
    const tail = previous.slice(-win)
    const idx = cont.indexOf(tail)
    if (idx !== -1) return previous + cont.slice(idx + win)
  }
  return previous + '\n' + cont
}
