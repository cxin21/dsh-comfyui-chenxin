// src/pe-framework/resources/resolve.ts
import { join, sep } from 'node:path'

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

export function resolveKnowledgePath(opts: { skillDir: string; asset: string }): string {
  const root = _presetRoot?.replace(/[\\/]+$/, '') || process.env.DSH_COMFYUI_PRESET_ROOT || fallbackPresetRoot()
  if (!root) throw new Error('resolveKnowledgePath: presetRoot not configured (config.presetRoot / DSH_COMFYUI_PRESET_ROOT / preset layout); cannot resolve knowledge asset')
  return join(root, 'skills', opts.skillDir, 'knowledge', opts.asset)
}
