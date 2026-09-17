# Task 1 Brief: 资源层 resolveKnowledgePath + setPresetRoot

## 背景
prompt-master DSH 插件重构（方案 A）第 1 个任务：建立知识资产路径的**唯一解析入口**，替换后续要删除的硬编码 `C:/Users/...` 路径。本任务只做资源解析模块 + config 接线，不碰 anima-catalog/tokenizer-h3（那是 Task 2）。

## 工作目录（所有路径相对此根）
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`

## 全局约束（必须遵守）
- 测试命令：`Push-Location <插件根>; npx vitest run <file>`；构建 `npm run build`（tsc）
- git 仓库根 = preset 根 `C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin`；commit 用 `git -C <preset根> add <相对路径>`
- 纯函数层零日志副作用
- TypeScript NodeNext/ES2022；import 带 `.js` 后缀（如 `./resolve.js`）

## Files
- Create: `src/pe-framework/resources/resolve.ts`
- Modify: `src/plugin/config.ts`（加 `presetRoot?: string`）
- Modify: `src/plugin/index.ts`（apply 内 `setPresetRoot(config.presetRoot)`）
- Test: `tests/pe-framework/resources/resolve.test.ts`

## Interfaces（Produces）
- `setPresetRoot(root: string | undefined): void`
- `getPresetRoot(): string | undefined`
- `resolveKnowledgePath(opts: { skillDir: string; asset: string }): string` —— 返回 `<presetRoot>/skills/<skillDir>/knowledge/<asset>`；无 presetRoot 时向插件包上级找 preset 根；找不到 throw 可读错误

## TDD 步骤

### Step 1: 写失败测试
```ts
// tests/pe-framework/resources/resolve.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { setPresetRoot, getPresetRoot, resolveKnowledgePath } from '../../../src/pe-framework/resources/resolve.js'

describe('resolveKnowledgePath', () => {
  beforeEach(() => setPresetRoot('C:/fake-preset'))
  afterEach(() => setPresetRoot(undefined))

  it('joins presetRoot + skillDir + knowledge + asset', () => {
    expect(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' }))
      .toBe('C:\\fake-preset\\skills\\anima-prompt-v1\\knowledge\\tag-catalog.sqlite')
  })

  it('normalizes trailing slash on presetRoot', () => {
    setPresetRoot('C:/fake-preset/')
    expect(resolveKnowledgePath({ skillDir: 'x', asset: 'y.json' })).toBe('C:\\fake-preset\\skills\\x\\knowledge\\y.json')
  })

  it('throws readable error when no presetRoot configured', () => {
    setPresetRoot(undefined)
    expect(() => resolveKnowledgePath({ skillDir: 'x', asset: 'y' })).toThrow(/presetRoot not configured|preset/i)
  })
})
```
注意：`join()` 在 Windows 输出反斜杠 `\`，断言用双反斜杠字符串。若测试环境路径分隔符不同，以实际 join 行为为准调整断言（保持 API 不变）。

### Step 2: 运行确认失败
Run: `npx vitest run tests/pe-framework/resources/resolve.test.ts`
Expected: FAIL（Cannot find module resolve.js）

### Step 3: 实现
```ts
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
```
> 优先级：显式 setPresetRoot > env DSH_COMFYUI_PRESET_ROOT > fallbackPresetRoot（从 import.meta.url 找 plugins/prompt-master 段）。fallback 逻辑：在路径段中找连续 `['plugins','prompt-master']`，取 `plugins` 之前的部分即 preset 根。

### Step 4: 运行确认通过
Run: `npx vitest run tests/pe-framework/resources/resolve.test.ts`
Expected: PASS 3 tests

### Step 5: 改 config + apply 接线
`src/plugin/config.ts`：Config schema 加 `presetRoot: z.string().optional()`（保留现有 temperature）。
`src/plugin/index.ts`：顶部 import `{ setPresetRoot } from '../pe-framework/resources/resolve.js'`；在 `apply(ctx, config)` 内、注册 tools 之前调用 `setPresetRoot(config.presetRoot)`。

### Step 6: 全量构建 + 提交
Run: `npm run build`（exit 0）
Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/resources plugins/prompt-master/src/plugin/config.ts plugins/prompt-master/src/plugin/index.ts plugins/prompt-master/tests/pe-framework/resources
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): add resource path resolution (resolveKnowledgePath/setPresetRoot)"
```

## 验收
- resolve.test.ts 3 用例绿
- npm run build exit 0
- 现有 270 测试不回归（本任务只新增文件 + config 可选字段，不应破坏任何现有测试）