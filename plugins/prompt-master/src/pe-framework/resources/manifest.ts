// src/pe-framework/resources/manifest.ts — 资产 manifest 对账（校验失败不硬崩，warn 兜底在接线处）
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolveKnowledgePath } from './resolve.js'

export type AssetCheck = { ok: true } | { ok: false; reason: string }

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** anima catalog：manifest.json 的 output.checksum（或顶层 checksum）vs tag-catalog.sqlite 实算 */
export function assertAnimaCatalog(): AssetCheck {
  try {
    const m = JSON.parse(readFileSync(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'manifest.json' }), 'utf8')) as any
    const expected: string | undefined = m?.output?.checksum ?? m?.checksum
    if (!expected) return { ok: false, reason: 'catalog manifest has no checksum field' }
    const actual = sha256File(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' }))
    return expected === actual ? { ok: true } : { ok: false, reason: `catalog checksum mismatch (manifest=${expected} actual=${actual})` }
  } catch (e) {
    return { ok: false, reason: `catalog manifest unreadable: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** h3 tokenizer：manifest.json snapshot_id === 'h3-qwen3-vl' 且 tokenizer.json 存在 */
export function assertH3Tokenizer(): AssetCheck {
  try {
    const tokPath = resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'tokenizer.json' })
    const m = JSON.parse(readFileSync(resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'manifest.json' }), 'utf8')) as any
    const okId = m?.snapshot_id === 'h3-qwen3-vl'
    const tokExists = existsSync(tokPath)
    return okId && tokExists ? { ok: true } : { ok: false, reason: `tokenizer manifest mismatch (snapshot_id=${m?.snapshot_id ?? 'missing'}, tokenizer_exists=${tokExists})` }
  } catch (e) {
    return { ok: false, reason: `tokenizer manifest unreadable: ${e instanceof Error ? e.message : String(e)}` }
  }
}
