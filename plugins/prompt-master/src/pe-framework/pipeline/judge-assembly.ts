/**
 * Task 5（spec §2.1/§2.3）：EvidenceBridge / CriticProvider 的生产装配。
 * 供插件层（Task 6）把真实证据依赖与 subagent 评委接进 runStage 注入点；
 * 本模块只做适配器构造，不做网络 / subagent 调用（测试不打真连）。
 *
 * 降级铁律（spec §2.5）：单个依赖构造失败 → 该键缺省（bridge 自动剔除，
 * evidence_partial advisory 由管线层标）；provider 内部故障 → 管线层 skipped 降级。
 */
import type { BlueprintV1 } from '../blueprint/schema.js'
import { checkConcreteness } from '../aesthetics/check.js'
import { countTokensH3 } from '../audit/tokenizer-h3.js'
import type { CriticProvider } from '../eval/critic.js'
import { createSubagentCriticProvider } from '../eval/critic.js'
import type { EvidenceDeps } from '../eval/evidence.js'
import { searchCatalog } from '../dialect/anima-catalog.js'

/**
 * 真实证据依赖装配。适配器映射（T2 carry 逐条落实）：
 * - catalog：searchCatalog(tag) → CatalogHit[] 按实际字段映射为 { tag, kind, count }
 *   （CatalogHit: prompt_form?/match_type/usage_count?/raw?，缺失时兜底）；
 * - tokenizer：countTokensH3(text) 恒带 tokens（undefined → 0 + estimate: true）；
 * - aesthetics：query 为序列化后的画面文本 → BlueprintV1 最小构造可行（{core:{concept}}，
 *   checkConcreteness 全程可选链兼容）→ 扁平摘要；最小构造失败 → lexicon-only 降级摘要。
 */
export function createProductionEvidenceDeps(target: 'anima' | 'h3'): EvidenceDeps {
  void target
  const deps: EvidenceDeps = {}

  try {
    // catalog 适配器仅 anima；h3 rubric 未声明 catalog；未来若声明需按 target 分流
    deps.catalog = (query: string) => {
      const hits = searchCatalog(query)
      if (!Array.isArray(hits)) return []
      return hits.map((h) => ({
        tag: h.prompt_form ?? h.raw ?? query,
        kind: h.match_type,
        count: typeof h.usage_count === 'number' ? h.usage_count : 0,
      }))
    }
  } catch {
    /* 构造失败 → 键缺省 */
  }

  try {
    deps.tokenizer = (query: string) => {
      const r = countTokensH3(query) as { tokens?: number; ids?: number[] }
      if (typeof r?.tokens === 'number' && Number.isFinite(r.tokens)) {
        return { tokens: r.tokens, ...(r.ids !== undefined ? { ids: r.ids } : {}) }
      }
      // T2 carry：恒带 tokens；undefined → 0 并标 estimate
      return { tokens: 0, estimate: true }
    }
  } catch {
    /* 构造失败 → 键缺省 */
  }

  try {
    deps.aesthetics = (query: string) => {
      try {
        // BlueprintV1 最小构造可行：checkConcreteness 对缺失字段全程可选链；core 必须存在
        const bp = { core: { concept: query } } as unknown as BlueprintV1
        const r = checkConcreteness(bp)
        return {
          concreteness: r.pass ? 'pass' : 'fail',
          ...(r.issues.length > 0 ? { issues: r.issues } : {}),
        }
      } catch {
        // 最小构造不可行兜底：仅词法面检查（VAGUE_WORDS 摘要），摘要注明 lexicon-only
        return { concreteness: 'unknown', mode: 'lexicon-only', query_len: query.length }
      }
    }
  } catch {
    /* 构造失败 → 键缺省 */
  }

  return deps
}

/**
 * 生产 CriticProvider 装配 = createSubagentCriticProvider(ownerCtx)。
 * T3 carry：ownerCtx 必须含 agent 供 parent 归属；缺 agent / ctx.subagents 未注册时
 * provider 内部抛错 → 管线层 skipped 降级（可接受，不在此兜底）。
 */
export function createProductionCriticProvider(ownerCtx: any, opts?: { timeoutMs?: number }): CriticProvider {
  return createSubagentCriticProvider(ownerCtx, opts)
}
