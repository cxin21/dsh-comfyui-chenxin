/**
 * audit P1（2026-09-17 第一性原理审计落地）：nl_tag_overlap 向量层生产装配件。
 * spec 2026-09-15 §0 D6：nl 句 × tag 的 bge-base-en-v1.5 余弦 ≥ 阈值判重叠——审计器
 * （compositing/audit.ts）早有注入点，但 prompt-author 装配处一直未传，生产只跑词面。
 *
 * 形状说明：嵌入天然异步，而 auditCompositing 是同步纯函数（13 处既有测试依赖其
 * 同步返回）。因此接缝拆成两半：
 * - prewarm(nl, tags)：审计前异步把全部 NL 句与 tag 嵌入进程内缓存（orchestrate 调）
 * - sim(a, b)：同步查询缓存；任一侧未预热/空串/CJK → undefined（audit 词面降级路径）
 *
 * 两侧统一 kind:'passage'（bge 无前缀；e5 模型同侧同前缀，几何自洽）；不信任 embedder
 * 的 normalize 声明，计算真余弦。本模块不 throw——故障以 undefined/静默跳过表达，
 * 与 anima-vector 的增强层降级纪律一致。嵌入模型默认 Xenova/bge-base-en-v1.5（768 维，
 * PM_EMBED_MODEL 可切），与 tag-vector.sqlite 索引同源。
 */
import { createOnnxEmbedder, type EmbedFn } from '../dialect/anima-vector.js'
import { splitNlSentences } from './audit.js'

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/

export interface BgeVectorSimOpts {
  /** 注入 stub 供测试；缺省用 createOnnxEmbedder()（PM_EMBED_MODEL / PM_EMBED_PROVIDER 生效） */
  embed?: EmbedFn
}

export interface BgeOverlapSim {
  /** 审计前预热：把 nl 的句子与 tags 全部嵌入缓存。只嵌入缺失文本；单条故障静默跳过。 */
  prewarm(nl: string, tags: string[]): Promise<void>
  /** 同步余弦查询；未预热/空串/CJK/维度错配 → undefined */
  sim(a: string, b: string): number | undefined
}

function normalizeDot(a: Float32Array, b: Float32Array): number {
  // 不信任 embedder 的 normalize 声明：对非归一化向量也给出真余弦
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  if (denom === 0) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s / denom
}

const embeddable = (t: string): boolean => t.trim() !== '' && !CJK_RE.test(t)

export function createBgeOverlapSim(opts?: BgeVectorSimOpts): BgeOverlapSim {
  const embed = opts?.embed ?? createOnnxEmbedder()
  const cache = new Map<string, Float32Array>()
  const embedOne = async (text: string): Promise<void> => {
    if (cache.has(text)) return
    try {
      const rows = await embed([text], 'passage')
      const v = rows[0]
      if (v && v.length > 0) cache.set(text, v)
    } catch {
      /* 单条嵌入故障 → 该文本相关对 sim=undefined，audit 保持词面路径 */
    }
  }
  return {
    async prewarm(nl: string, tags: string[]): Promise<void> {
      const texts = [...splitNlSentences(nl), ...tags].filter(embeddable)
      await Promise.all(texts.map(embedOne))
    },
    sim(a: string, b: string): number | undefined {
      if (a.trim() === '' || b.trim() === '') return undefined
      if (CJK_RE.test(a) || CJK_RE.test(b)) return undefined
      const va = cache.get(a)
      const vb = cache.get(b)
      if (!va || !vb || va.length !== vb.length) return undefined
      return normalizeDot(va, vb)
    },
  }
}

let shared: BgeOverlapSim | undefined

/**
 * prompt-author 装配用进程级单例（惰性）。env `PM_VECTOR_OVERLAP=off` 显式关闭 →
 * prewarm 立即完成、sim 恒 undefined（audit 保持词面 + overlap_vector_unavailable，
 * 与未接线时代行为一致）。单例目的：ONNX extractor 与文本缓存跨调用复用——每次
 * prompt_author 新建一份会重复初始化模型并丢缓存。
 */
export function getSharedBgeOverlapSim(): BgeOverlapSim {
  if (shared === undefined) {
    if (process.env.PM_VECTOR_OVERLAP === 'off') {
      shared = {
        prewarm: async () => {},
        sim: () => undefined,
      }
    } else {
      shared = createBgeOverlapSim()
    }
  }
  return shared
}
