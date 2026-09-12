/**
 * style_save 预设写工具测试（M3 T2，spec §13）——TDD 先行。
 * 夹具：mkdtemp 临时 preset 根 + plugins/prompt-master/assets/style-presets 播种 1 条
 * 合法 v2 预设；setPresetRoot 注入（与 registry.ts 加载链同源），用后还原。
 * 缓存语义钉死（二选一之「重启提示」分支）：写入后 registry 模块缓存不失效，
 * 新预设重启进程后才可见——工具输出 advisory 明示（测试断言钉死该行为）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerStyleSaveTool } from '../../src/tools/style-save.js'
import { runTool } from '../plugin/helpers.js'
import { setPresetRoot } from '../../src/pe-framework/resources/resolve.js'
import { getStylePreset, listStylePresets, stylePresetCount } from '../../src/pe-framework/styles/registry.js'
import { validateStylePreset } from '../../src/pe-framework/styles/schema.js'

const VALID_PRESET = {
  id: 'test_save_alpha',
  name: '测试保存甲',
  category: 'photography',
  rating: 'safe',
  theme: 'unit test fixture',
  palette: 'grey box palette',
  fragments: {
    image: 'fixture concrete phrase one, fixture concrete phrase two',
    video: 'fixture concrete phrase one, fixture concrete phrase two',
  },
  negative_hints: ['fixture negative'],
  artist_hints: [],
  artist_max: 3,
  applies_to: ['anima', 'h3', 'sd'],
  source: 'hand-authored',
}

/** 库内既有 id（播种文件用），用于重复 id 冲突用例 */
const SEEDED_ID = 'seeded_existing'

let root = ''
let dir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'style-save-test-'))
  dir = join(root, 'plugins', 'prompt-master', 'assets', 'style-presets')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${SEEDED_ID}.json`), JSON.stringify({ ...VALID_PRESET, id: SEEDED_ID, name: '播种既有' }, null, 2) + '\n', 'utf8')
  setPresetRoot(root)
})

afterEach(() => {
  setPresetRoot(undefined)
  rmSync(root, { recursive: true, force: true })
})

const def = () => registerStyleSaveTool(null as never, {} as never)

describe('style_save (M3 T2, spec §13)', () => {
  it('fail-fast: invalid preset rejected by validateStylePreset before any write', async () => {
    const bad = { ...VALID_PRESET, fragments: { image: 'only image', video: '' } }
    await expect(runTool({} as never, def(), { preset: bad })).rejects.toThrow(/invalid/)
    expect(existsSync(join(dir, `${VALID_PRESET.id}.json`))).toBe(false)
  })
  it('non-object / missing preset rejected', async () => {
    await expect(runTool({} as never, def(), {})).rejects.toThrow(/preset/)
    await expect(runTool({} as never, def(), { preset: 'not-an-object' })).rejects.toThrow(/preset/)
  })
  it('duplicate id rejected with style_preset_id_conflict semantics; existing file untouched', async () => {
    const before = readFileSync(join(dir, `${SEEDED_ID}.json`), 'utf8')
    await expect(runTool({} as never, def(), { preset: { ...VALID_PRESET, id: SEEDED_ID } })).rejects.toThrow(/style_preset_id_conflict/)
    expect(readFileSync(join(dir, `${SEEDED_ID}.json`), 'utf8')).toBe(before)
  })
  it('path traversal / whitelist violations all rejected; nothing written outside the whitelist dir', async () => {
    const evilIds = ['../evil', 'sub/dir/evil', 'sub\\dir\\evil', 'C:\\abs\\evil', '/abs/path', 'white space', 'dash-dash', 'UPPER']
    for (const id of evilIds) {
      await expect(runTool({} as never, def(), { preset: { ...VALID_PRESET, id } }), id).rejects.toThrow()
    }
    // 白名单目录内只有播种文件，目录外（root 其它位置）零新增文件
    expect(existsSync(join(dir, `${SEEDED_ID}.json`))).toBe(true)
    expect(existsSync(join(root, 'evil.json'))).toBe(false)
    expect(existsSync(join(root, 'plugins', 'prompt-master', 'assets', 'evil.json'))).toBe(false)
  })
  it('atomic write: valid preset lands as loadable JSON + summary with projected count', async () => {
    const out = JSON.parse(String(await runTool({} as never, def(), { preset: VALID_PRESET })))
    const file = join(dir, `${VALID_PRESET.id}.json`)
    expect(existsSync(file)).toBe(true)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const checked = validateStylePreset(raw)
    expect(checked.ok).toBe(true)
    expect(out.id).toBe(VALID_PRESET.id)
    expect(out.path).toContain('style-presets')
    expect(out.presetCount).toBe(stylePresetCount() + 1)
  })
  it('registry cache semantics pinned: written preset NOT visible until restart, advisory disclosed', async () => {
    const before = listStylePresets().length // 先行触发缓存填充（夹具态）
    const out = JSON.parse(String(await runTool({} as never, def(), { preset: VALID_PRESET })))
    // 缓存未失效：同进程读取不见新预设、计数不变
    expect(getStylePreset(VALID_PRESET.id)).toBeUndefined()
    expect(stylePresetCount()).toBe(before)
    // 重启提示 advisory 必须在输出中披露（二选一分支钉死）
    expect(JSON.stringify(out)).toMatch(/restart|重启|cache|缓存/)
    expect(Array.isArray(out.advisories)).toBe(true)
    expect(out.advisories.length).toBeGreaterThanOrEqual(1)
  })
})
