/**
 * style_save 预设写工具（M3 T2，spec §13）——本地预设入库，零 LLM、不碰 git。
 * ① validateStylePreset fail-fast（复用既有校验器，零新校验逻辑）
 * ② 重复 id 与现有库冲突即拒（advisory 族语义 style_preset_id_conflict——改写既有预设走 git）
 * ③ 原子写入 assets/style-presets/<id>.json（tmp+rename；写入即仓库工作树内容，
 *    git 提交由用户完成——工具不执行任何 git 命令）
 * ④ 返回写入摘要 + stylePresetCount 新值（投射值，见缓存语义）
 *
 * 安全：id 白名单 ^[a-z0-9_]+$（语义由本工具定夺——schema 侧仅约束非空字符串；
 * 仅约束新保存，库内既有 nb* CJK id 不受影响）+ 解析路径包含校验（防穿越纵深防御，
 * 白名单硬校验目录 = stylePresetsDir 本身，目录外零写入）。
 *
 * registry 缓存语义（M1 t15 _cache，二选一之「重启提示」分支，测试钉死）：
 * 写入后模块缓存不失效——同进程 listStylePresets/getStylePreset 不见新预设，
 * 计数取「现值+1」投射；输出 advisory 明示重启后可见（不改动 registry.ts，
 * 进程内热失效留给未来按需演进）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { validateStylePreset, type StylePresetV2 } from '../pe-framework/styles/schema.js'
import { getStylePreset, stylePresetCount } from '../pe-framework/styles/registry.js'
import { getPresetRoot } from '../pe-framework/resources/resolve.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'

/** 新保存 id 白名单：小写字母/数字/下划线（防穿越第一层；语义与既有库命名约定一致） */
const ID_RE = /^[a-z0-9_]+$/

/** 风格预设目录：与 registry.ts stylePresetsDir 同一解析链（setPresetRoot → env → 布局回溯）。
 *  刻意本地复制而非改 registry.ts 导出（M3 T2 Files 清单不含 registry.ts；两处逻辑同源，
 *  漂移风险由 resolve 链自身测试与 registry.test 兜底）。 */
function stylePresetsDir(): string {
  const configured = getPresetRoot()?.replace(/[\\/]+$/, '') || process.env.DSH_COMFYUI_PRESET_ROOT
  if (configured) return join(configured, 'plugins', 'prompt-master', 'assets', 'style-presets')
  try {
    const here = decodeURIComponent(import.meta.url.replace(/^file:\/\/\/?/, ''))
    const parts = here.split(/[\\/]/)
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === 'plugins' && parts[i + 1] === 'prompt-master') {
        return join(parts.slice(0, i + 2).join(sep), 'assets', 'style-presets')
      }
    }
  } catch { /* fall through */ }
  throw new Error('style_save: cannot locate plugins/prompt-master/assets/style-presets (setPresetRoot / DSH_COMFYUI_PRESET_ROOT / preset layout)')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 只写工具（无 LLM）：style_save → JSON 摘要 */
export function registerStyleSaveTool(_ctx: Context, _config: Config) {
  return defineTool({
    name: 'style_save',
    description:
      '风格预设入库（spec §13，M3 T2）：输入完整 StylePresetV2 JSON，validateStylePreset fail-fast 复用校验（零新校验逻辑）；' +
      'id 白名单 ^[a-z0-9_]+$、与现有库重复 id 即拒（style_preset_id_conflict 语义，改写走 git）；' +
      '原子写入 assets/style-presets/<id>.json（tmp+rename，写入即工作树内容，git 提交由用户完成）；零 LLM。',
    parameters: {
      preset: { type: 'object', additionalProperties: true, description: '完整 StylePresetV2 JSON 对象（id/name/category/rating/fragments/negative_hints/artist_hints/artist_max/applies_to/source）' },
    },
    output: {
      schema: { type: 'string', description: 'JSON {saved,id,name,path,diff,presetCount,advisories}' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { preset?: unknown }) {
      if (!isPlainObject(args?.preset)) throw new Error('style_save: preset must be a JSON object (StylePresetV2)')
      const raw = args.preset
      const checked = validateStylePreset(raw)
      if (!checked.ok) throw new Error(`style_save: preset invalid — ${checked.errors.join('; ')}`)
      const preset = checked.value as StylePresetV2
      const id = preset.id
      if (!ID_RE.test(id)) {
        throw new Error(`style_save: id "${id}" fails whitelist ^[a-z0-9_]+$ (new-save naming contract; existing library ids unaffected)`)
      }
      if (getStylePreset(id) !== undefined) {
        throw new Error(`style_save: id conflict — "${id}" already exists in the library (style_preset_id_conflict:${id}); rewriting existing presets is out of scope, use git`)
      }
      const dir = resolve(stylePresetsDir())
      const finalPath = resolve(join(dir, `${id}.json`))
      if (!finalPath.startsWith(dir + sep)) {
        throw new Error(`style_save: resolved path escapes the style-presets whitelist dir (id="${id}")`)
      }
      const diff = {
        id: preset.id,
        name: preset.name,
        category: preset.category,
        rating: preset.rating,
        fragmentsChars: preset.fragments.image.length,
        negativeCount: preset.negative_hints.length,
        artistCount: preset.artist_hints.length,
      }
      const tmpPath = join(dir, `.${id}.${randomBytes(4).toString('hex')}.tmp`)
      writeFileSync(tmpPath, JSON.stringify(preset, null, 2) + '\n', 'utf8')
      try {
        renameSync(tmpPath, finalPath)
      } catch (e) {
        rmSync(tmpPath, { force: true })
        throw new Error(`style_save: atomic rename failed (${(e as Error)?.message ?? 'unknown'})`)
      }
      const body = {
        saved: true,
        id,
        name: preset.name,
        path: `plugins/prompt-master/assets/style-presets/${id}.json`,
        diff,
        presetCount: stylePresetCount() + 1,
        advisories: [
          'style_preset_registry_cache: preset written to the working tree, in-process registry cache not invalidated — restart the plugin process (重启) for style_list/applyStyleV2 to see it; git commit is left to the user (工具不碰 git)',
        ],
      }
      return JSON.stringify(body)
    },
  })
}
