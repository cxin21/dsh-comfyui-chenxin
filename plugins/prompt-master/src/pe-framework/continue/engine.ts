import { inspectOutput } from './inspect.js'
import { mergeContinuedText } from './merge.js'
import type { OutputContract, ContinueSeed, ContinueOutcome } from './contract.js'

type FinishKind = 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'

/**
 * Structure-aware continuation loop.
 *
 * Trigger: contract inspection incomplete OR finishKind === 'max-tokens'
 * (max-tokens continues even if structurally complete — dark-truncation guard).
 * Each round sends a SINGLE user message carrying the accumulated full text
 * plus the missing list. Pure async orchestration: zero logging; the caller
 * observes rounds via onContinue.
 *
 * Abort semantics: signal.throwIfAborted at round start; abort inside generate
 * propagates via the caller's signal (generate throws → rethrow, with
 * CONTINUE_ABORTED_PARTIAL warning if some continuation text was already
 * merged); post-round signal.aborted check returns the partial result.
 */
export async function continueUntilComplete(params: {
  contract: OutputContract
  initialText: string
  finishKind: FinishKind
  seed: ContinueSeed
  generate: (req: { system?: string; user: string }) => Promise<{ text: string; finishKind: FinishKind }>
  maxRounds?: number
  signal: AbortSignal
  onContinue?: (round: number, maxRounds: number) => void
}): Promise<ContinueOutcome> {
  const max = params.maxRounds ?? 3
  const warnings: string[] = []
  let text = params.initialText
  let finish = params.finishKind
  let rounds = 0
  while (rounds < max) {
    const inspection = inspectOutput(text, params.contract)
    const shouldContinue = !inspection.complete || finish === 'max-tokens'
    if (!shouldContinue) break
    params.signal.throwIfAborted()
    rounds++
    params.onContinue?.(rounds, max)
    const missingList = inspection.missing.length > 0 ? inspection.missing.join(', ') : '（结构未知，可能有暗截断）'
    const instruction = params.seed.outputLang === 'en'
      ? `Already written (do NOT rewrite; continue from it): -----\n${text}\n-----\n\nMissing: ${missingList}. Continue from where it stops.`
      : `已写出（不要重写，基于它继续）：-----\n${text}\n-----\n\n缺失内容：${missingList}。请从缺失处继续输出，不要重复已有内容。`
    let piece: string
    try {
      const gen = await params.generate({ system: params.seed.system, user: instruction })
      piece = gen.text
      finish = gen.finishKind
    } catch (error) {
      if (text !== params.initialText) warnings.push('CONTINUE_ABORTED_PARTIAL')
      throw error
    }
    text = mergeContinuedText(text, piece)
    if (params.signal.aborted) { warnings.push('CONTINUE_ABORTED_PARTIAL'); return { text, rounds, complete: false, warnings } }
  }
  const final = inspectOutput(text, params.contract)
  if (!final.complete || finish === 'max-tokens') warnings.push('INCOMPLETE_AFTER_MAX_ROUNDS')
  return { text, rounds, complete: final.complete && finish !== 'max-tokens', warnings }
}
