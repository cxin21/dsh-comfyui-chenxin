# Prompt Master MCP Server — Phase 1 实施计划

> **For agentic workers:** 本计划实现 Prompt Master MCP Server 的缺失模块补齐。按子系统分为 4 个 Phase，每个 Phase 产出可独立测试的交付物。

**Goal:** 将 Prompt Master MCP Server 从 24 个文件、简化版 reverse 补齐到与设计文档一致的 42 个文件、1:1 PromptMaster PE 引擎移植。

**架构原则：**
- 每个 PE 模块从 PromptMaster 原生 JS 源码移植为 TypeScript
- 移植过程：去掉所有 Electron / ee-core 依赖，保留纯逻辑
- 保持函数签名和导出名称与原版一致（方便追查差异）
- 新增逻辑只在 resolver/index.ts（路由层）和 tool handlers 层

**Spec:** `D:\Projects\temp\prompt-master-mcp-design.md`

---

## 全局约束

- 所有代码用 TypeScript，严格模式
- 所有文件后缀 `.ts`，import 带 `.js`（ESM）
- 移植自 PromptMaster 的代码保留原注释和出处标记
- 不接受 Electron/ee-core 依赖；如有引用，替换为纯 Node.js 等价物
- 每个 Phase 结束时项目必须 `tsc` 编译通过

---

## 目录结构（目标状态）

所有 `✗` 标记为当前缺失的文件，做即可。

```
src/
├── index.ts                                  # ✓ 已完成
├── config/
│   ├── index.ts                              # ✓ 已完成 [需修复 async bug]
│   ├── defaults.ts                           # ✓ 已完成
│   └── schema.ts                             # ✗ 新建：YAML schema 类型
├── tools/
│   ├── index.ts                              # ✓ 已完成
│   ├── prompt-expand.ts                      # ✓ 已完成 [需补 outputFormat]
│   ├── prompt-reverse.ts                     # ✓ 已完成
│   ├── profile-list.ts                       # ✓ 已完成
│   ├── minimax-scenario.ts                   # ✗ 重写：用 catalog.ts 替换硬编码
│   └── provider-config.ts                    # ✓ 已完成
├── resolver/
│   ├── index.ts                              # ⚠ 修改：resolveReverse 改为路由到模块
│   ├── renderer.ts                           # ✓ 已完成
│   ├── taxonomy.ts                           # ✓ 已完成
│   ├── types.ts                              # ✓ 已完成
│   ├── profiles/
│   │   ├── index.ts                          # ⚠ 修改：劣化、train、torii 改为 import
│   │   ├── expand-rules.ts                   # ✓ 已完成
│   │   ├── expand-mirror.ts                  # ✗ 新建：从 PM expandReverseMirror.js 移植
│   │   ├── reverse/
│   │   │   ├── router.ts                     # ✗ 新建：从 PM captionPromptEngineering.js 移植
│   │   │   ├── descriptive.ts                # ✗ 新建：从 PM descriptivePromptEngineering.js 移植
│   │   │   ├── comfyui.ts                    # ✗ 新建：从 PM comfyuiPromptEngineering.js 移植
│   │   │   ├── danbooru.ts                   # ✗ 新建：从 PM danbooruPromptEngineering.js 移植
│   │   │   ├── anima3.ts                     # ✗ 新建：从 PM anima3PromptEngineering.js 移植
│   │   │   └── prose.ts                      # ✗ 新建：从 PM proseCaptionPromptEngineering.js 移植
│   │   ├── train/
│   │   │   └── index.ts                      # ✗ 新建：从 profiles/index.ts 拆分
│   │   └── torii/
│   │       ├── formats.ts                    # ✗ 新建：从 PM toriiGateFormats.js 移植
│   │       └── prompts.ts                    # ✗ 新建：从 PM torii_prompts_data.js 移植│   │
│   └── minimax/
│       ├── index.ts                          # ✗ 新建：入口 + buildMinimaxScenarioProfiles
│       ├── catalog.ts                        # ✗ 新建：从 PM minimaxScenarios/catalog.js 移植
│       ├── assemble.ts                       # ✗ 新建：从 PM minimaxScenarios/assemble.js 移植
│       └── templates/
│           ├── h3-reference.en.ts            # ✗ 新建：从 PM prompts/h3-full-reference-rewrite.en.js 移植
│           ├── h3-reference.zh.ts            # ✗ 新建：从 PM prompts/h3-full-reference-rewrite.zh.js 移植
│           └── h3-reference.ja.ts            # ✗ 新建：从 PM prompts/h3-full-reference-rewrite.ja.js 移植
├── provider/
│   ├── index.ts                              # ✓ 已完成
│   ├── client.ts                            # ✓ 已完成
│   └── models.ts                             # ⚠ 修改：导出 BUILTIN_PROVIDERS
├── db/
│   ├── index.ts                              # ✓ 已完成
│   └── schema.ts                             # ✓ 已完成
└── utils/
│   └── length.ts                             # ✗ 新建：token/字符计数
```

---

## Phase 1：编译修复 + 基础设施补齐（5 个文件，预计 30 分钟）

**交付物：项目 `tsc` 编译通过**

### Task 1.1：修复 `src/config/index.ts` 的 async bug

**Files:**
- Modify: `src/config/index.ts`
- Create: `src/config/schema.ts`

**问题：** `loadConfig` 是同步函数，但内有 `await import('yaml')`。

**Interfaces:**
- Consumes: `McpConfig` from `defaults.ts`
- Produces: 可编译的 `loadConfig()`

- [ ] **Step 1：修改 loadConfig 为 async**

将 `export function loadConfig` 改为 `export async function loadConfig`，所有调用处补 `await`。

- [ ] **Step 2：创建 `src/config/schema.ts`**

```typescript
// YAML 配置结构类型
export interface YamlConfig {
  db_path?: string;
  defaults?: { provider?: string; model?: string; temperature?: number; };
  api_keys?: Record<string, string>;
  logging?: { level?: string; history?: boolean; };
}
```

- [ ] **Step 3：修复 `src/index.ts` 中 `loadConfig` 调用**

```typescript
const cfg = await loadConfig(parseCliArgs());
```

- [ ] **Step 4：验证编译**

Run: `npx tsc --noEmit`
Expected: Exit code 0

- [ ] **Step 5：验证所有引用 `loadConfig` 的地方**

```
grep -r "loadConfig" src/ --include "*.ts"
```

确认 `tools/prompt-expand.ts` 中没有直接调用 `loadConfig`（它不应有）。

---

### Task 1.2：补齐 CLI 参数解析

**Files:**
- Modify: `src/index.ts`
 Called: `parseCliArgs()`

- [ ] **Step 1：补全 switch 分支**

```typescript
// 在 parseCliArgs 函数中添加：
case '--port':        args.port = parseInt(argv[++i], 10); break;
case '--log-level':   args.logLevel = argv[++i]; break;
case '--transport':   args.transport = argv[++i] as 'stdio' | 'sse'; break;
case '-h':
case '--help':        showHelp(); process.exit(0);
```

- [ ] **Step 2：验证编译**

---

### Task 1.3：修复 provider/models.ts 导出

**Files:**
- Modify: `src/provider/models.ts`

- [ ] **Step 1：确认末尾有 `export { BUILTIN_PROVIDERS }`（目前只有定义行，确认导出）**

https://github.com/user-attachments/files/18558279/default.txt


### Task 1.4：在 provider/index.ts 中修复引用

**Files:**
- Modify: `src/provider/index.ts`

- [ ] **Step 1：检查 `getAllProviders` 是否引用 `BUILTIN_PROVIDERS`**

目前是本地定义，改为从 `./models.ts` import

```typescript
import { BUILTIN_PROVIDERS } from './models.js';
// 删掉 getAlProviders 中的硬编码列表
```

- [ ] **Step 3：AST 编译验证**

---

## Phase 2：Reverse PE 管线（7 个文件，预计 2 小时）

**交付物：`resolveReverse()` 功能与 PM 一致**

移植的 7 个 PM 模块都在 `electron/config/` 下已有 JS 源码。

### 反向 PE 模块说明
- `reverse/router.ts`：caption type → 具体 PE 模块
- `reverse/descriptive.ts`：五点结构自然语言反推
- `reverse/comfyui.ts`：SD/ComfyUI 标签式反推（20000行，最大）
- `reverse/danbooru.ts`：Danbooru 风格标签反推
- `reverse/anima3.ts`：Anima3 增强（system prompt + sanitize）
- `reverse/prose.ts`：其他散文类反推


各文件需输出：
```typescript
export function buildSystemPrompt(cap: any, mediaTarget: string): string;
export function buildSystemAddons(cap: any, mediaTarget: string): string;
export function buildUserTaskLead(cap: any, mediaTarget: string): string;
export function buildUserTaskBody(cap: any): string | null;
export function buildOutputConstraints(cap: any): string;
export function buildUserTailAddon(cap: any): string;
export function sanitizeFinalCapton(text: string, cap: any): string;
```

### Task 2.1：`reverse/comfyui.ts` — SD/ComfyUI 反推模块

**Files:**
- Create: `src/resolver/profiles/reverse/comfyui.ts`
- Source: `D:\Projects\temp\prompt-master-dump\electron\config\comfyuiPromptEngineering.js` (20.2K)

- [ ] **Step 1：从 PM 源码复制，改为 TypeScript（去掉 `require()`，改为 `import`）**
- [ ] **Step 2：去掉所有 Electron 依赖（`window.electron` 路径等）**
  - PM 源码中有一处 `sanitizeOutput` 检查 electron window，改成纯文本操作
- [ ] **Sep 3：将 `module.exports` 改为 named exports**
- [ ] **Sep 4：验证通过 `tsc --noEmit`**

### Task 2.2：`reverse/descriptive.ts` — 五点结构反推模块

**Files:**
- Create: `src/resolver/profiles/reverse/desriptive.ts`
- Source: `D:\Projects\temp\prompt-master-dump\electron\config\descriptivePromptEngineering.js` (11.4K)

- Same 移植步骤：复→改 import → 删 Electron → 改 exports

### Task 2.3：`reverse/danbooru.ts`

**Files:**
- Creat: `src/resolver/profiles/reverse/danbooru.ts`
- Source: `D:\Projets\temp\promt-master-dump\electron\config\danbooruPromptEngineering.js` (6.3K)

### Task 2.4：`reverse/anima3.ts`

**Files:**
- Create: `src/resolver/profiles/revers/anima3.ts`
- Source: `D:\Projet\temp\prompt-mster-dump\electron\config` (13.5K)

### Task 2.5：`reverse/prose.ts`

- Source: `proseCaptionPromptEngineering.js` (5.6K)

### Task 2.6：`reverse/router.ts` — 路由引擎

**Files:**
- Crte: `src/resover/profiles/reverse/router.ts`
- Source: `D:\Projets\temp\prompt-master-ump\electron\config\captionPromptEngineering.js` (11.0K)

- [ ] *Step 1：复制，改为 import*
- [ ] **Step 2：删掉 Electron 依赖**
  - `sanitizeFinalCaption()` 中有一处设置 `window.x`，去掉
  - joyCaption 相关引用目前先注释掉（后续 phase 补充也
  - manifest.json / workspacePath 引用改成直接传参
- [ ] **Step 3：改写运行**
  - 之前 `resolveReverse()` 通过 `getPromptEngine()` 找到对应模块
  - 改为 `import { comfyui, desriptive, danbooru, anima3, pose }` 然后调用

### Task 2.7：重写 `resolveer/index.ts` 中的 `resolveReverse`

**Files:**
- Modify: `src/resolver/index.ts`

- [ ] **Step 1：删掉硬编码的3个 system prompt，改为路由到 reverse/router**

```typescript
import { buildSystemPrompt, buildSystemAddons, buildOutputConstraints, buildUserTaskLead, buildUserTaskBody, buildUserTailAddon } from './profiles/reverse/router.js';

export function resolveReverse(profile: PEProfile, params: ReverseParams): ReverseResult {
  const cap = { ...params, type: captionTypeFromProfile(profile) };

  // builtin — 走 PE 模块
  if (profile.builtin) {
    return {
      system: buildSystemPrompt(cap,  params.edia_target) + buildSystemAddons(cap, params.media_target),
      uerLead: buildUserTaskLead(cap, params.media_target),
      userBody: buildUseTaskBody(cap) || '',
      outputConstraints: buildOututConstraints(cap),
      userTail: buildUserTailAddon(cap),
      captionType: cap.type,
    };
  }

  // custom — 走模板系统
  // ... (后续实现
  return { ... };h (params);
}
```

- [ ] **Step 2：编译验证**

---

## Phase 3：MinMax H3 场景（5 个文件，预计 2 小时）

**交什物：`tools/minimax-scenrio.ts` 使用完整 catalog，输出 H3 方言 prompt**

### Task 3.1`resolver/minimax/catalog.ts` — 10 个场景定义

**Files:**
- Crate: `src/resolver/minimax/catalog.ts`
- Source: `D:\Projets\temp\prompt-master-ump\electron\config\minimaxScenarios\catalog.js` (38.7K)

移植要点：
- 保留 `MINMAX_SCENARIOS` 数组全部内容（包含每个场景的 formFields、harConstraints、assembleHints）
- 保留 `getScenarioById()`、`getScenarioByPeId()`、`listScenarios()`
- 删除 `ASEPCT_COMMON` 等 UI 专用常量之前确认 Tools 层不用

- [ ] **Step 1：复制全文件，改为 TypeScript**
- [ ] *Step 2：确认 formFields 中的 showIf 逻辑不需要 Electron/UI 依赖*
- [ ] **Step 3：导出 `listScenarios(), getSceanrioById(), getScenarioByPeId()**

### Task 3.2：`resolver/minimax/assemble.ts` — 场景组装

**Files:**
- Create: `src/resolver/minimax/assemble.ts`
- Source: `D:\Projects\temp\prompt-master-dump\electron\config\minimaxScenarios\assemble.js` (27.4K)

- `isMinimxScenarioProfile()` — 是不是 MinMax 场景
- `resolveMinimaxScenarExpand()` — 把场景组装为 prompt
- `nomalizeForm()` — 表单字段标准化
- `fieldVisile()` — showIf 逻辑

- [ ] **Step 1：复制全文件，改为 TypeScrit**
- [ ] **Step 2：删掉对 `toriiGateFormats` 和 `tagLineSanitize` 的引用（当前 Phase 3 不包含 Torii）**

### Task 3.3：`resolver/minimax/templates/h3-reference.*.ts` — H3 模板

**Files:**
- Create: 3 files
- Sources: pmt-master-ump\electron\config\prompts\ (总共 60K)

- h3-full-reference-rewrite.en.js → h3-reference.en.ts
- h3-full-reference-rewrite.zh.js → h3-reference.zh.ts
- h3-full-reference-rewrite.ja.js → h3-reference.ja.ts

每个文件导出为一个大字符串常量。不需要动内容。

```typescript
// h3-reference.zh.ts
export const FULL_REFERENCE_ZH = `...原文件全部内容...`;
```

- [ ] **Step 1：复制 3 个文件改为 .ts**
- [ ] **Step 2：每个文件末尾加 `export const ...`**

### Task 3.4：`resolver/minimax/index.ts` — 入口

**Files:**
- Create: `src/resolver/minimax/index.ts`

```typescript
export { resolveMinimaxScenarioExpand, isMinimaxScenarioProfile, normalizeForm } from './assemble.js';
export { listScenarios, getScenarioById, getScenarioByPeId } from './catalog.js`;
export { FULL_REFERENCE_EN, FULL_REFERENCE_ZH, FULL_REFERENCE_JA } from './templates/h3-reference.en.js';
```

### Task 3.5：重写 `tools/minimax-scenario.ts`

**Files:**
- Modify: `src/tools/minimax-scenario.ts`

- [ ] **Step 1：用 `getScenarioById` 替代硬编码场景列表**
- [ ] **Step 2：调用 `resolveMinimaxScenarioExpand` 替代通用 prompt 生成**
- [ ] **Step 3：输出 H3 六段式格式**

---

## Phase 4：Torii + Train + ExpandMirror（5 个文件，预计 1 小时）

**交付物：Torii 结构化反推/扩写可用，训练打标 Profile 从内联拆为独立文件**

### Task 4.1：`src/resolver/profiles/torii/formats.ts`

- Source: `toriiGateFormats.js` (6.0K)
- 导出：`buildToriiReverseProfiles()`, `isStructuredTemplateProfile()`

### Task 4.2：`src/resolver/profiles/torii/prompts.ts`

- Source: `torii_prompts_data.js` (13.2K)
- 导出：`PROMPTS_B` 常量

### Task 4.3：`src/resolver/profiles/expand-mirror.ts`

- Source: `expandReverseMirror.js` (6.7K)
- 导出：`mirrorProfileForExpand()`, `buildExpandProfilesFromReverseCatalog()`, `isReverseCatalogExpandProfile()`, `resolveExpandFromReverseMirror()`

### Task 4.4：`src/resolver/profiles/train/index.ts`

- 从 `profiles/index.ts` 拆分出 train 定义
- 导出：`TRAIN_CAPTION_TYPE_DEFS`, `buildBuiltinTrainCaptionProfiles()`, `mapTrainCaptionTypeToPeId()`

### Task 4.5：修剪 `profiles/index.ts`

- [ ] 将训定义改为 `import { buildBuiltinTrainCaptionProfiles } from './train/index.js'`
- [ ] 将 Torii 改为 `import { buildToriiReverseProfiles } from './torii/formats.js'`

---

## Phase 5：补齐工具和测试（4 个文件，预计 1 小时）

### Task 5.1：`src/utils/length.ts`

```typescript
// token 估算（中文 1字符≈1 token，英文 1词≈1.3 token）
export function estimateTokens(text: string): number { ... }
export function countChars(text: string): number { return text.length; }
```

### Task 5.2：补齐 `prompt-expand.ts` 返回字段

- [ ] 在 result 中添加 `outputFormat: profile.outputFormat`

### Task 5.3：`src/utils/length.ts` 单元测试

### Task 5.4：reverse router 单元测试（Mock 各 PE 模块输出）

---

## 执行顺序依赖图

```
Phase 1（编译通过）
  ├─ 供 Phase 2–5 的基础
  └─ 阻塞一切 ts 验证
  
Phase 2（Reverse PE）
  ├─ router.ts 依赖：descriptive.ts, comfyui.ts, danbooru.ts, anima3.ts, prose.ts
  ├─ resolver/index.ts 的 resolveReverse 依赖 router.ts
  └─ prompt-reverse.ts 依赖 resolveReverse（已在 Task 2.7 联通）

Phase 3（MiniMax H3）
  ├─ catalog.ts 无依赖（纯数据）
  ├─ assemble.ts 依赖 catalog.ts
  ├─ templates/ 无依赖（纯字符串）
  └─ minimax-scenario.ts 依赖 assemble.ts

Phase 4（Torii + Train + Mirror）
  ├─ 独立于 Phase 2/3，可并行
  └─ profiles/index.ts 在 Phase 4 Task 5 统一 import

Phase 5（工具 + 测试）
  └─ 依赖 Phase 1–4 全部完成
```

---

## 实施建议

**推荐执行顺序：Phase 1 → Phase 2（Task 2.1-2.5 可并行） → Task 2.6-2.7 → Phase 3（Task 3.1-3.4 可并行） → Task 3.5 → Phase 4 → Phase 5**

**总预估：6–8 小时**
- Phase 1：30 分钟
- Phase 2：2 小时
- Phase 3：2 小时
- Phase 4：1 小时
- Phase 5：1 小时
- 修复/测试缓冲：1 小时