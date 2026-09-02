// src/pe-framework/resources/resolve.ts
import { join, sep } from 'node:path'
import { existsSync } from 'node:fs'

let _presetRoot: string | undefined

export function setPresetRoot(root: string | undefined): void { _presetRoot = root }
export function getPresetRoot(): string | undefined { return _presetRoot }

/** 插件 dist 位于 <preset>/plugins/prompt-master/dist/src/... → 定位 plugins 段前为 preset 根 */
function fallbackPresetRoot(): string | undefined {
  try {
    const here = decodeURIComponent(import.meta.url.replace(/^file:\/\/\/?/, ''))
    const parts = here.split(/[\\/]/)
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === 'plugins' && parts[i + 1] === 'prompt-master') {
        return parts.slice(0, i).join(sep)
      }
    }
    return undefined
  } catch { return undefined }
}

/**
 * 知识资产双路径解析（Stage 2 skill-merge）：
 * 1) 优先 <root>/assets/knowledge/<skillDir>/<asset>（迁移后的新位置）
 * 2) 不存在且旧位置 <root>/skills/<skillDir>/knowledge/<asset> 存在 → 回退旧路径
 *    （Graceful migration：Stage 3 删除 skills/ 之前两者皆可用；删除后新路径为唯一来源）
 * 3) 两处都不存在 → 返回新路径（调用方错误处理兜底，见 assertAnimaCatalog / assertH3Tokenizer）
 */
export function resolveKnowledgePath(opts: { skillDir: string; asset: string }): string {
  const root = _presetRoot?.replace(/[\\/]+$/, '') || process.env.DSH_COMFYUI_PRESET_ROOT || fallbackPresetRoot()
  if (!root) throw new Error('resolveKnowledgePath: presetRoot not configured (config.presetRoot / DSH_COMFYUI_PRESET_ROOT / preset layout); cannot resolve knowledge asset')
  const newPath = join(root, 'assets', 'knowledge', opts.skillDir, opts.asset)
  if (existsSync(newPath)) return newPath
  const oldPath = join(root, 'skills', opts.skillDir, 'knowledge', opts.asset)
  if (existsSync(oldPath)) return oldPath
  return newPath
}
