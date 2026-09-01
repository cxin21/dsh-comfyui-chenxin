// MiniMax H3 场景模块入口 — 汇总 catalog / assemble / templates
export { listScenarios, getScenarioById, getScenarioByPeId, MINIMAX_SCENARIOS, ASPECT_COMMON, CONTINUOUS_STORY_MAX_SEGMENTS } from './catalog.js';
export { resolveMinimaxScenarioExpand, isMinimaxScenarioProfile, fieldVisible, normalizeForm, enumerateTaggedMedia, classifyMediaPath } from './assemble.js';
export {
  H3_FULL_REFERENCE_PROFILE_ID,
  H3_FULL_REFERENCE_BUILTIN_KEY,
  H3_FULL_REFERENCE_USER_PROMPT_TEMPLATE,
  isH3FullReferenceProfile,
  isH3FullReferencePeId,
  resolveH3FullReferenceExpand,
  loadH3FullReferenceSystem,
} from './h3-full-reference.js';
export { H3_REFERENCE_EN } from './templates/h3-reference.en.js';
export { H3_REFERENCE_ZH } from './templates/h3-reference.zh.js';
export { H3_REFERENCE_JA } from './templates/h3-reference.ja.js';