/**
 * semantic 层嵌入运行时（spec §3.3）：transformers.js 量化 e5-small（onnxruntime-node，q8）。
 * embed seam：EmbedFn 供测试/调用方注入 stub（spec §6 接缝策略）。
 * 增强层纪律：本模块 throw 不吞——任何故障由调用方（anima-vector.createVectorSearch）捕获降级为空。
 */
export const E5_QUERY_PREFIX = 'query: '
export const E5_PASSAGE_PREFIX = 'passage: '

export type EmbedFn = (texts: string[], kind: 'query' | 'passage') => Promise<Float32Array[]>

type Extractor = import('@huggingface/transformers').FeatureExtractionPipeline

export function createOnnxEmbedder(opts?: { model?: string }): EmbedFn {
  const model = opts?.model ?? process.env.PM_E5_MODEL ?? 'Xenova/multilingual-e5-small'
  let extractor: Extractor | null = null
  let failed = false
  return async (texts, kind) => {
    if (failed) throw new Error('embedder permanently failed')
    if (!extractor) {
      try {
        const tf = await import('@huggingface/transformers')
        extractor = (await tf.pipeline('feature-extraction', model, { dtype: 'q8' })) as Extractor
      } catch (e) {
        failed = true
        throw e
      }
    }
    const prefix = kind === 'query' ? E5_QUERY_PREFIX : E5_PASSAGE_PREFIX
    const out = await extractor(texts.map((t) => prefix + t), { pooling: 'mean', normalize: true })
    const dim = out.dims[out.dims.length - 1]
    const rows: Float32Array[] = []
    for (let i = 0; i < texts.length; i++) rows.push(new Float32Array(out.data.slice(i * dim, (i + 1) * dim)))
    return rows
  }
}
