/**
 * Structure-aware continue engine: type contracts.
 * Pure type definitions only — no runtime behavior.
 */

/** One expected output field: matched by any of its label patterns. */
export interface OutputFieldContract {
  key: string
  patterns: RegExp[]
}

/** Declares the expected structure of a long-form model output. */
export interface OutputContract {
  id: string
  fields: OutputFieldContract[]
  /** Optional separator between repeated groups (e.g. per-scene blocks). */
  groupSeparator?: RegExp
  /** Optional expected group count, derived from the request form fields. */
  expectedGroups?: (formFields: Record<string, unknown>) => number
}

/** Result of inspecting a text against an OutputContract. */
export interface StructureInspection {
  /** Missing items, reported as `field:<key>` entries. */
  missing: string[]
  /** True when nothing is missing. */
  complete: boolean
}

/** Seed context used to build continuation prompts. */
export interface ContinueSeed {
  system?: string
  userText: string
  outputLang: 'zh' | 'en'
}

/** Final outcome of continueUntilComplete. */
export interface ContinueOutcome {
  text: string
  rounds: number
  complete: boolean
  warnings: string[]
}
