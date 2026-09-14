/**
 * semantic 层嵌入运行时（spec §3.3）：transformers.js 量化 e5-small（onnxruntime-node，q8）。
 * embed seam：EmbedFn 供测试/调用方注入 stub（spec §6 接缝策略）。
 * 增强层纪律：本模块 throw 不吞——任何故障由调用方（anima-vector.createVectorSearch）捕获降级为空。
 */
import { DatabaseSync, type DatabaseSync as DB } from 'node:sqlite'
import { getLoadablePath } from 'sqlite-vec'
import { statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { getPresetRoot, resolveKnowledgePath } from '../resources/resolve.js'

export const E5_QUERY_PREFIX = 'query: '
export const E5_PASSAGE_PREFIX = 'passage: '

export type EmbedFn = (texts: string[], kind: 'query' | 'passage') => Promise<Float32Array[]>

type Extractor = import('@huggingface/transformers').FeatureExtractionPipeline

/**
 * HF 模型缓存稳定路径（T14-002，spec §3.3）：`<preset>/data/runtime/hf-cache`。
 * 显式 env.cacheDir 钉住缓存位置——transformers.js 缺省缓存目录锚定在包目录
 * （node_modules/@huggingface/transformers/.cache，实测 v4）且随 cwd 漂移：
 * 换 cwd 或重装依赖即丢缓存触发 ~118MB 重下载（本机直连 huggingface.co 被阻断）。
 * 落 data/runtime（持久运行时数据区，与 feedback.sqlite 同区）而非 temp/——
 * temp 是周期清理区，模型缓存被静默清掉后重下载在阻断环境下不可恢复。
 * 解析顺序复用 PRESET 路径解析（setPresetRoot → DSH_COMFYUI_PRESET_ROOT → dist 模块位置推导），
 * 全部与 cwd 无关；解析不出 preset 根时返回 null（保持库缺省，不臆造路径）。
 */
export function resolveHfCacheDir(): string | null {
  const root = getPresetRoot() ?? process.env.DSH_COMFYUI_PRESET_ROOT ?? presetRootFromModulePath()
  if (!root) return null
  return join(root, 'data', 'runtime', 'hf-cache')
}

/** dist 位于 <preset>/plugins/prompt-master/dist/src/... → 定位 plugins 段前为 preset 根（cwd 无关） */
function presetRootFromModulePath(): string | undefined {
  try {
    const here = decodeURIComponent(import.meta.url.replace(/^file:\/\/\/?/, ''))
    const parts = here.split(/[\\/]/)
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === 'plugins' && parts[i + 1] === 'prompt-master') {
        return parts.slice(0, i).join(sep)
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

export function createOnnxEmbedder(opts?: { model?: string }): EmbedFn {
  // bge-m3（默认）：多语言强模型，无 query/passage 前缀、CLS 池化、fp32 权重（官方 onnx 无量化变体）。
  // e5 系列保持旧行为（前缀 + mean 池化 + q8），经 PM_EMBED_MODEL / PM_E5_MODEL 环境变量可切回。
  const model = opts?.model ?? process.env.PM_EMBED_MODEL ?? process.env.PM_E5_MODEL ?? 'BAAI/bge-m3'
  const isE5 = /e5/i.test(model)
  const dtype = (process.env.PM_EMBED_DTYPE ?? (isE5 ? 'q8' : 'fp32')) as 'fp32' | 'q8'
  let extractor: Extractor | null = null
  let failed = false
  return async (texts, kind) => {
    if (failed) throw new Error('embedder permanently failed')
    if (!extractor) {
      try {
        const tf = await import('@huggingface/transformers')
        if (process.env.HF_ENDPOINT) tf.env.remoteHost = process.env.HF_ENDPOINT
        const cacheDir = resolveHfCacheDir()
        if (cacheDir) tf.env.cacheDir = cacheDir
        extractor = (await tf.pipeline('feature-extraction', model, { dtype })) as Extractor
      } catch (e) {
        failed = true
        throw e
      }
    }
    const prefix = isE5 ? (kind === 'query' ? E5_QUERY_PREFIX : E5_PASSAGE_PREFIX) : ''
    const out = await extractor(texts.map((t) => prefix + t), { pooling: isE5 ? 'mean' : 'cls', normalize: true })
    const dim = out.dims[out.dims.length - 1]
    const rows: Float32Array[] = []
    for (let i = 0; i < texts.length; i++) rows.push(new Float32Array(out.data.slice(i * dim, (i + 1) * dim)))
    return rows
  }
}

/** API 嵌入器（OpenAI 兼容 /embeddings，PM_EMBED_PROVIDER=api 时启用）。
 *  env：PM_EMBED_API_BASE / PM_EMBED_API_KEY / PM_EMBED_API_MODEL；输出维度由 API 模型决定，
 *  必须与索引建表时的 PM_EMBED_DIM 一致。查询期需网络——失败由 createVectorSearch 捕获降级为空。 */
export function createApiEmbedder(opts?: { baseUrl?: string; apiKey?: string; model?: string }): EmbedFn {
  const baseUrl = (opts?.baseUrl ?? process.env.PM_EMBED_API_BASE ?? '').replace(/\/+$/, '')
  const apiKey = opts?.apiKey ?? process.env.PM_EMBED_API_KEY ?? ''
  const model = opts?.model ?? process.env.PM_EMBED_API_MODEL ?? ''
  if (!baseUrl || !apiKey || !model) {
    throw new Error('api embedder requires PM_EMBED_API_BASE / PM_EMBED_API_KEY / PM_EMBED_API_MODEL')
  }
  return async (texts) => {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: texts }),
    })
    if (!res.ok) throw new Error(`embeddings API ${res.status}`)
    const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> }
    const rows: Float32Array[] = new Array(texts.length)
    for (const d of json.data) rows[d.index] = new Float32Array(d.embedding)
    return rows
  }
}

// ---------------------------------------------------------------------------
// 量化与 fixture 工具（spec §3.1 int8 口径）：per-vector max-abs 缩放到**有符号**
// int8，127 为满幅（二进制补码，无偏移，clamp [-127,127]）—— 建库（Python
// build_tag_vector.py quantize_int8）与查询（Node 查询期）共用同一口径，量化不对称即
// 向量错配。导出供测试 fixture 复用。
// ---------------------------------------------------------------------------

/** LCG 确定性伪随机（fixture 专用） */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** 确定性单位向量（fixture 专用；seed 相同 → 向量相同） */
export function unitVec(seed: number, dim = 384): Float32Array {
  const rnd = lcg(seed)
  const v = new Float32Array(dim)
  let norm = 0
  for (let i = 0; i < dim; i++) {
    v[i] = rnd()
    norm += v[i] * v[i]
  }
  norm = Math.sqrt(norm)
  for (let i = 0; i < dim; i++) v[i] /= norm
  return v
}

/**
 * float32 → 有符号 int8 量化（存为 uint8 字节，负值经二进制补码回绕）。
 * 口径（controller ruling + impl-build t5 实测定案，依据 temp/sdd-t7/probe_quant5.py）：
 * per-vector max-abs 缩放，127 满幅，**有符号 int8（二进制补码）**，clamp [-127,127]，
 * 无 +128 偏移——sqlite-vec 的 int8 列按有符号解释，偏移编码破坏 cosine 几何
 * （probe 实测距离误差 1.6 vs 补码 ≤0.005）。
 * 建库侧（Python build_tag_vector.py quantize_int8）使用逐字节一致（byte-exact）的同一
 * 公式（显式 clamp [-127,127] + & 0xFF 落盘）；SQL 绑定一律 vec_int8(?)。
 * 注：Math.round 为 half-up，Python round 为 banker's——仅在缩放值恰为 x.5 时可 diverge，
 * 真实嵌入向量与 LCG fixture 向量上经 byte-exact 交叉验证一致（见 Task3-report.md）。
 */
export function quantizeInt8(v: Float32Array): Uint8Array {
  let max = 0
  for (const x of v) max = Math.max(max, Math.abs(x))
  const out = new Uint8Array(v.length)
  for (let i = 0; i < v.length; i++) {
    const q = Math.round((v[i] / (max || 1)) * 127)
    out[i] = Math.min(127, Math.max(-127, q))
  }
  return out
}

// ---------------------------------------------------------------------------
// 向量库句柄 + KNN 查询（spec §3.1/§3.3/§5）
// ---------------------------------------------------------------------------

export interface SemanticHit {
  record_id: string
  score: number
  text_source: 'wiki' | 'fallback'
}

const DEFAULT_THRESHOLD = 0.55

export function createVectorSearch(opts?: {
  dbPath?: string
  embed?: EmbedFn
  threshold?: number
}): (query: string, k: number) => Promise<SemanticHit[]> {
  const threshold = opts?.threshold ?? (process.env.PM_SEMANTIC_THRESHOLD ? Number(process.env.PM_SEMANTIC_THRESHOLD) : DEFAULT_THRESHOLD)
  // 惰性解析（对齐 anima-catalog MF-1）：dbPath 在首次查询时才求值，避免模块求值期触碰文件系统
  let resolvedPath: string | null = null
  const resolvePath = (): string => {
    if (resolvedPath === null) {
      resolvedPath = opts?.dbPath ?? process.env.ANIMA_VECTOR_PATH
        ?? resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-vector.sqlite' })
    }
    return resolvedPath
  }
  // 嵌入器选择：PM_EMBED_PROVIDER=api 走 OpenAI 兼容 /embeddings（在线，查询期需网络），
  // 否则本地 ONNX（零网络）。env 不全时 api 创建即 throw → 语义层降级为空 + 一次性 warn。
  let embedFn: EmbedFn | null = null
  if (opts?.embed) {
    embedFn = opts.embed
  } else if (process.env.PM_EMBED_PROVIDER === 'api') {
    try {
      embedFn = createApiEmbedder()
    } catch (e) {
      console.warn(`[prompt-master] semantic layer degraded: ${String(e)}`)
    }
  } else {
    embedFn = createOnnxEmbedder()
  }
  let db: DB | null = null
  let mtime = 0
  let warned = false
  const warn = (msg: string) => {
    if (!warned) {
      warned = true
      console.warn(`[prompt-master] semantic layer degraded: ${msg}`)
    }
  }
  /** 打开（缓存）句柄；文件缺失 → null。G4：mtime 变化 → 关闭陈旧句柄重开（向量库为可重建派生产物）。 */
  const open = (): DB | null => {
    const path = resolvePath()
    let m = 0
    try {
      m = statSync(path).mtimeMs
    } catch {
      return null
    }
    if (db && m !== mtime) {
      try { db.close() } catch { /* 陈旧句柄关闭失败不阻塞重开 */ }
      db = null
    }
    if (!db) {
      db = new DatabaseSync(path, { readOnly: true, allowExtension: true })
      db.loadExtension(getLoadablePath())
      mtime = m
    }
    return db
  }
  return async (query: string, k: number): Promise<SemanticHit[]> => {
    if (!query || k < 1) return []
    try {
      const d = open()
      if (!d) {
        warn(`vector db missing at ${resolvePath()} (run build_tag_vector.py)`)
        return []
      }
      if (!embedFn) {
        warn('api embedder unavailable (check PM_EMBED_API_BASE/KEY/MODEL)')
        return []
      }
      const q = await embedFn([query], 'query')
      const qv = quantizeInt8(q[0])
      const rows = d.prepare(
        `SELECT payload.record_id, payload.text_source, vec_items.distance
         FROM vec_items JOIN payload ON payload.rowid = vec_items.rowid
         WHERE vec_items.embedding MATCH vec_int8(?) AND k = ?`,
      ).all(qv, BigInt(k)) as Array<{ record_id: string; text_source: 'wiki' | 'fallback'; distance: number }>
      return rows
        .map((r) => ({ record_id: r.record_id, score: 1 - r.distance, text_source: r.text_source }))
        .filter((h) => h.score >= threshold)
        .slice(0, k)
    } catch (e) {
      warn(String(e))
      return []
    }
  }
}
