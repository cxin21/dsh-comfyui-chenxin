# T4 Report: 低危 parity 收尾（C1 + R1 + E1 + 守卫文案）

- **Task**: T4 (last code task) of the 4-task resolver×3.1.0 parity batch
- **Working dir**: `plugins/prompt-master`
- **Status**: ✅ complete — 4/4 items landed; full suite green; build 0

## 修复清单逐项

### C1: comfyui.ts `pose/orion` typo — FIXED
- 上游 ground truth: `comfyuiPromptEngineering.js:402` → `'Subject, environment, pose/orientation, interaction—strip style/medium/quality (style LoRA).'`
- Port before: `comfyui.ts:398` → `pose/orion`（抄写笔误，已在本地先确认上游拼写为 `orientation` 再改）
- Fix: `src/resolver/profiles/reverse/comfyui.ts` (`comfyui_lora_style.en`) → `pose/orientation`
- Parity test: `tests/resolver/parity-low.test.ts` (C1) — asserts `toContain('pose/orientation')` and `not.toContain('pose/orion')`
- za 行（描述主体、环境、姿态…）与上游逐字一致，未动

### R1: 8 个 expand 内置 profile 撞名语义 — 注释声明（Captain 裁决）
- Ruling: 保持 port-only expand profiles 现役（id 体系不动——有消费方：`tests/fixtures/test-data.ts`、`findProfileById('pe_expand_natural')`、tools/prompt-expand.ts 默认值），仅加注释
- Fix: `src/resolver/profiles/index.ts` `buildBuiltinExpandProfiles()` 定义处加注释：
  ```
  // legacy-name collision: PM 3.1.0 内置该 id 为其他语义；本 port 保留 expand 语义（消费方为 expand 路由）
  // （审计 R1：pe_expand_natural 等在 LEGACY_EXPAND_PE_ID_MAP 中是应映射到 pe_expand_descriptive/pe_expand_sd 的旧 id；
  //   port 将其注册为现役 expand profile，legacy 映射对这些 key 不会被触发——id 体系保持不变，此处仅声明语义）
  ```
- Parity test: `parity-low.test.ts` (R1) — `findProfileById('pe_expand_natural')` 仍为 kind=expand/builtinKey=expand_natural；`LEGACY_EXPAND_PE_ID_MAP.pe_expand_natural === 'pe_expand_descriptive'` 且 `mapLegacyExpandPeId('pe_expand_natural')` 仍走 legacy 映射（语义双轨被显式锁定）

### E1: labelUi 丢失 — port-only 决定（TS 类型无该字段，未强加）
- 上游: `promptExpandRules.js:189-233` 每档预设带 `labelUi`（如 `标准（约 150～300 字）`），`EXPAND_LENGTH_OPTIONS` 取 `label: p.labelUi || p.label`
- Port: `expand-rules.ts` 的 preset 类型 `{ label; maxTokens; hintZh; hintEn }` **不承载** labelUi → 按 brief「若 TS 类型有该字段才回填，否则注明 port-only 决定」执行：只加注释不硬塞字段
- Fix: `src/resolver/profiles/expand-rules.ts` 篇幅预设处注释，说明 port-only 决定 + UI label 短词的篇幅语义由 `listExpandLengthsForUi().description(=hintZh)` 承载，prompt 文本不受影响
- Parity test: `parity-low.test.ts` (E1) — `EXPAND_LENGTH_OPTIONS` medium label 为 `标准`（锁定短词决定）；`listExpandLengthsForUi` medium `description` 含 `150～300`（篇幅完整语义仍在 UI 侧）

### ensureCustomExpandSystem 守卫文案截短 — 恢复
- 上游: `promptEngineeringResolver.js:82-83`
  - en: `…or「Source text to expand」in the user message. Never treat style names **or expansion rules** as the subject to elaborate.`
  - zh: `…扩写成说明文**或散文**。`
- Port before: 丢 `in the user message`、`or expansion rules`、`或散文`
- Fix: `src/resolver/index.ts` `ensureCustomExpandSystem` 守卫两分支逐字恢复
- Parity test: `parity-low.test.ts` — 自定义 expand profile（systemPrompt 无任何标记词）en 路由守卫含 `in the user message` + `or expansion rules` + 完整尾句；zh 路由含 `扩写成说明文或散文`

## Test 覆盖说明
- 新增 `tests/resolver/parity-low.test.ts`（7 it）：C1 / R1 / E1 / guard 每项 ≥1 断言
- 既有覆盖补充说明：`tests/resolver/expand.test.ts` 已断言 8 个 expand 内置 profile 注册与 builtinKey 全集（R1 消费方）；`tests/resolver/length.test.ts` 已覆盖篇幅档位（E1 相邻区）
- 纯函数变更零日志（4 个源文件均未新增 console/log）

## 验证
- `npm test` → **60 files / 515 tests passed**（含新增 parity-low）— no failures
- `npm run build` (tsc) → exit 0，无类型/编译错误

## Commit
- Message: `fix(prompt-master): low-priority resolver parity (C1 typo, R1 collision notes, E1 labelUi, guard copy)`
- Files: `plugins/prompt-master/src/resolver/{index.ts, profiles/expand-rules.ts, profiles/index.ts, profiles/reverse/comfyui.ts}` + `tests/resolver/parity-low.test.ts`