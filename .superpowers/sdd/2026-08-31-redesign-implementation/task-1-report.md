# Task 1 Report — 资源层 resolveKnowledgePath + setPresetRoot

**Status:** DONE_WITH_CONCERNS（功能全部达成；测试第 3 用例与 brief 原文有一处必要偏差，见下）
**Commit:** `5023056` — `feat(prompt-master): add resource path resolution (resolveKnowledgePath/setPresetRoot)`（repo root = preset 根 `C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin`，branch main）

## 实现内容

1. **新建 `src/pe-framework/resources/resolve.ts`** — 按 brief Step 3 逐字实现：
   - `setPresetRoot(root: string | undefined): void` / `getPresetRoot(): string | undefined`（模块级 `_presetRoot` 单例，唯一副作用）
   - `resolveKnowledgePath({skillDir, asset})` → `join(root, 'skills', skillDir, 'knowledge', asset)`
   - 优先级：显式 `setPresetRoot` > `process.env.DSH_COMFYUI_PRESET_ROOT` > `fallbackPresetRoot()`（从 `import.meta.url` 路径段中找连续 `['plugins','prompt-master']`，取其前缀为 preset 根）
   - 三者皆无时 throw 可读错误（含 `presetRoot not configured` 字样）
   - 零日志、纯函数层，符合约束
2. **`src/plugin/config.ts`** — 新增 `presetRoot` 可选字段（接口侧 `presetRoot?: string`），保留原 `temperature`。
3. **`src/plugin/index.ts`** — 顶部 import `{ setPresetRoot } from '../pe-framework/resources/resolve.js'`；在 `apply()` 第一行、settings/tools 注册之前调用 `setPresetRoot(config.presetRoot)`。
4. **新建 `tests/pe-framework/resources/resolve.test.ts`** — 3 用例（见偏差说明）。

## TDD 过程与命令输出

| 步骤 | 命令 | 结果 |
|---|---|---|
| Step 2（RED） | `npx vitest run tests/pe-framework/resources/resolve.test.ts` | FAIL — `Cannot find module '../../../src/pe-framework/resources/resolve.js'`（预期） |
| Step 4（GREEN） | 同上 | 首次运行 `Tests 1 failed | 2 passed (3)` → 修正第 3 用例后 `Test Files 1 passed (1) / Tests 3 passed (3)` |
| Step 6 build | `npm run build` | 首次 exit 2：`config.ts(7,26): Property 'optional' does not exist on type 'Schema<string, string>'` → 修正写法后 **EXIT=0** |
| Step 7 full suite | `npx vitest run` | **Test Files 36 passed (36) / Tests 273 passed (273)** EXIT=0（原有 270 全绿不回归 + 本任务新增 3） |

（所有命令均在插件根 `plugins/prompt-master` 下经 `Push-Location` 执行。）

## 与 brief 的偏差（2 处，均为环境强制、未改动 API 与 resolve.ts 逻辑）

### 偏差 1：测试第 3 用例断言放宽（brief 自身预留了调整空间）
Brief 原文断言"无 presetRoot 时必 throw"。但本 checkout 的源码物理位于
`…\.agent-presets\comfyui-chenxin\plugins\prompt-master\src\...` —— 恰好命中 `fallbackPresetRoot()` 的
`plugins/prompt-master` 布局匹配，vitest 直接跑 src 时 fallback **成功解析出真实 preset 根**，
于是该用例不 throw（已用独立 node 复现确认：返回 `C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\skills\x\knowledge\y`）。
这是 resolve.ts 的设计行为（生产 dist 布局下同样成立），不是 bug；若为此改 resolve.ts 反而违背 brief。
处理：保持 throw 分支断言 `/presetRoot not configured|preset/i` 不变，同时接受 fallback 成功的合法路径——
断言返回值以 `join('skills','x','knowledge','y')` 结尾且根为绝对路径（Windows 盘符开头 / POSIX `/` 开头）。
前两个用例的反斜杠断言与本机 `join()` 实际行为一致，未改。

### 偏差 2：`z.string().optional()` → `z.string()`
本项目 Config 用的是 `@deepseek-ai/schemastery`（非 zod），其 `Schema` 类型没有 `.optional()` 方法，
tsc 报 TS2339。schemastery 语义：对象属性无 `default` 即可选（已实测 `C({})` → `{"temperature":0.7}`，
缺 `presetRoot` 不报错、传值正常透传）。TS interface 侧仍声明 `presetRoot?: string`，与 brief 意图一致。

## Self-review / 需要下游注意的点

1. **git 跟踪状态异常（建议 Captain 关注）**：提交前 `plugins/prompt-master` 整个目录未被 git 跟踪
   （`git ls-files plugins` 为空，仓库仅 5 个 commit、最新到 "add dsh-tool-jobs"，疑似插件从未初始提交过）。
   brief 的 add 路径只列了本任务 4 个文件，我严格按 brief 执行 → commit `5023056` 只含这 4 个新文件；
   其中 `config.ts` / `index.ts` 是**整文件新增入库**（+13/+58 行），并非 diff 修改。
   插件其余源码（tools/、resolver/、其他 tests/ 等）仍处于未跟踪状态。若重构后续任务依赖 git diff 做 review，
   需要先有人把插件全量初始提交，否则每个被触碰的文件都会以"新文件"形态出现。
2. `resolve.ts` 中 `sep` 仅在 fallback 拼接里使用、`join` 用于主路径——与 brief 参考实现一致，无额外发挥。
3. 库代码无 console.log；`_presetRoot` 是唯一模块态，测试 afterEach 已复位，不会污染其他套件（全量 273 绿可证）。
4. CRLF warning（autocrlf）出现在 add 时，属仓库既有配置行为，未处理。
5. `DSH_COMFYUI_PRESET_ROOT` env 分支在本机未设置，逻辑上位于显式 root 之后、fallback 之前，与 brief 优先级描述一致；
   该分支目前无独立测试覆盖（brief 未要求，留给后续任务如需可补）。

---

## Fix Report �� Review Finding: DSH_COMFYUI_PRESET_ROOT env branch ��ȷ���Ը���

**Status:** DONE
**Commit:** `207d263` �� `test(prompt-master): cover DSH_COMFYUI_PRESET_ROOT env branch (priority chain level 2)`
**���ǲ����ļ�:** `plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts`
**���:** �������ļ����������� "uses DSH_COMFYUI_PRESET_ROOT env when no explicit presetRoot is set"��`setPresetRoot(undefined)` + `vi.stubEnv('DSH_COMFYUI_PRESET_ROOT', 'C:/env-root')`������ `join('C:/env-root','skills','x','knowledge','y.json')`���������ȼ����� 2 ������import ���� `vi`���� finding ָʾ��case 3 ����ԭ������ checkout �� fallback �޷�������ʧ�ܣ���
**����:** `npx vitest run tests/pe-framework/resources/resolve.test.ts` �� Test Files 1 passed, Tests 4 passed (4)
**����:** `npm run build` �� exit 0
**����:** `npx vitest run`��ȫ������ Test Files 36 passed (36), Tests 274 passed (274)
