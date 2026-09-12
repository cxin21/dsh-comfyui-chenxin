import { inspectOutput } from './inspect.js'
import { mergeContinuedText } from './merge.js'
import type { OutputContract, ContinueSeed, ContinueOutcome } from './contract.js'
import type { Rating } from '../types.js'

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
 * propagates via the caller's signal; post-round signal.aborted check returns
 * the partial result. Generate errors: partial merged text is returned with
 * CONTINUE_PARTIAL_BEFORE_ERROR (rethrow only if nothing was merged yet).
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
  /** Request form fields, passed through to contract.expectedGroups (spec §3.2.3). */
  formFields?: Record<string, unknown>
  /** spec §7 P4：declaredRating 存在时，每轮 instruction 尾部追加评级行（修订不得降档/清洗）；
   *  缺省不追加——H3 既有调用方（minimax-scenario）零改动。 */
  declaredRating?: Rating
}): Promise<ContinueOutcome> {
  const max = params.maxRounds ?? 3
  const warnings: string[] = []
  let text = params.initialText
  let finish = params.finishKind
  let rounds = 0
  while (rounds < max) {
    const inspection = inspectOutput(text, params.contract, params.formFields)
    const shouldContinue = !inspection.complete || finish === 'max-tokens'
    if (!shouldContinue) break
    params.signal.throwIfAborted()
    rounds++
    params.onContinue?.(rounds, max)
    const missingList = inspection.missing.length > 0 ? inspection.missing.join(', ') : '（结构未知，可能有暗截断）'
    const baseInstruction = params.seed.outputLang === 'en'
      ? `Already written (do NOT rewrite; continue from it): -----\n${text}\n-----\n\nMissing: ${missingList}. Continue from where it stops.`
      : `已写出（不要重写，基于它继续）：-----\n${text}\n-----\n\n缺失内容：${missingList}。请从缺失处继续输出，不要重复已有内容。`
    const instruction = params.declaredRating !== undefined
      ? `${baseInstruction}\n当前内容分级：${params.declaredRating}——修订不得降档、不得清洗或委婉化已声明内容、不得触碰硬边界负向。`
      : baseInstruction
    let piece: string
    try {
      const gen = await params.generate({ system: params.seed.system, user: instruction })
      piece = gen.text
      finish = gen.finishKind
    } catch (error) {
      // generate 抛错时不丢弃已合并的续写文本：有部分结果则部分返回（spec §3.2.3）
      if (text !== params.initialText) {
        warnings.push('CONTINUE_PARTIAL_BEFORE_ERROR')
        return { text, rounds, complete: false, warnings }
      }
      throw error
    }
    text = mergeContinuedText(text, piece)
    if (params.signal.aborted) { warnings.push('CONTINUE_ABORTED_PARTIAL'); return { text, rounds, complete: false, warnings } }
  }
  const final = inspectOutput(text, params.contract, params.formFields)
  // 最终判定以结构完整性为准：max-tokens 只驱动循环内多续写（暗截断防线在 line ~40），
  // 结构已验证完整时不应再判 false / 告警。
  if (!final.complete) warnings.push('INCOMPLETE_AFTER_MAX_ROUNDS')
  return { text, rounds, complete: final.complete, warnings }
}
