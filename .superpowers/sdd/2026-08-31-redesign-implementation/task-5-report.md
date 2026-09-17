# Task 5 Report: anima / h3 注册为方言模块

**Status: COMPLETE** · Commit `84ea750` · 8/8 new tests green · build exit 0 · full suite 301/301 green

## runStage variant finding（关键核实）

`runStage.ts` L47 audit ctx **已经包含 `variant: input.variant`** — brief 预期的 variant 内核修补**不需要**。实际 audit ctx：

```ts
d.audit(compiled, { stage: input.stage, references: normalized.references, shots: input.shots, variant: input.variant })
```

但发现第二个偏差：audit ctx 的 `shots` 传的是 **raw `input.shots`**，不是归一化后的 value。brief Step C 注释明确预期 "ctx.shots = 归一化 value"（anima.audit 需要 slots 才能产出 catalog_miss 与精确 contentCount 审计；compiled 结果不携带 slots，无法从 dialect 侧补救）。已做一行内核修补（Task 4/5 契约语义对齐，非新行为）：

```ts
shots: normalized.value ?? input.shots
```

对 h3 同样成立（normalizeH3Input 的 value 即 shots）。runStage 现有 6 个测试用 fake dialect，不断言 ctx 内容，全部保持绿。

## 实际使用的签名（与 brief 差异）

| brief 假设 | 实际 | 适配 |
|---|---|---|
| `rules-h3.js` | `rules-h3.ts`（TS 文件） | import 路径不变 |
| `compileH3` 返回 `{text, text_zh}` | 返回 `{text, textZh}` | contract 泛型改 `{ text: string; textZh: string }` |
| `auditH3Full(text, meta, refs)` | 一致（`H3AuditMeta & {references?}` + 第三参 raw refs） | 按 brief 传法 |
| `contractGatesH3(stage, shots{duration_seconds,shots}, refs)` | 一致 | — |
| `buildH3Budget(stage, text, refs)` | 一致（refs 默认 `[]`） | — |
| `auditAnima(positive, negative, {variant, slots})` | 一致（slots 可选） | — |
| `compileAnima(slots, {variant})` | 一致（opts 可选） | — |
| `compileH3(shots, {stage})` stage 更宽 | `opts.stage?: string` 缺省 `t2va`，任意 STAGES 合法 | `opts.stage ?? 't2va'`，不收窄 |
| `DialectContract` 位置 | 从 `./contract.js` 直接 import | — |

## persona/schema 拆分决策

- `ANIMA_PERSONA` / `H3_PERSONA`：把统一 persona 的规则 1（anima slots）/ 规则 2（h3 shots）各自提为目标专属首规则，公共规则（ref 标签稳定、尊重原文、最小解释、输出格式）逐条保留进两者。
- `ANIMA_SCHEMA` / `H3_SCHEMA`：DEFAULT_SCHEMA 中 `"anima"` / `"h3"` 键整段分别提为顶层对象（去掉了外层键包裹），尾部输出规则段两者都保留。
- **`DEFAULT_PERSONA` / `DEFAULT_SCHEMA` 原文未动**（兜底路径 `opts.persona ?? DEFAULT_*` 不变；现有 subagent-provider 测试全绿）。
- 四个常量均 `export`（方言文件 import；外部不消费）。

## TDD 过程

1. 先写 `tests/pe-framework/dialect/{anima,h3}-register.test.ts`（brief Step E 原文）
2. 首跑：**2 files failed, 8/8 FAIL**（`registerH3Dialect is not a function` 等）
3. 实现 A→B→C→D + runStage 补丁
4. 复跑：**8/8 PASS**
5. `npm run build`：**exit 0**
6. 全量 `npx vitest run`：第 1 次 300/301（1 个 flake，日志被覆写未捕获名字）；第 2、3 次连续 **41 files / 301 tests 全绿**。registry.test.ts 与 plugin import 副作用注册无冲突。

## Deviations

1. **runStage 第二处一行修补**（`shots: normalized.value ?? input.shots`）— brief 只预告了 variant 修补；此修补是 brief 自身注释（"runStage 传 norm.value 进 ctx.shots"）的落地，已在上面详述。
2. 无其他偏离。tools/*.ts 未触碰（inferH3Stage/toRefs 工具侧副本留给 Task 6 删）。DEFAULT_* 未改。现有导出全部保留，零日志。

## 自审

- `getDialect('anima')/('h3')` 经模块级副作用注册（两方言文件底部各一行 `register*Dialect()`），plugin/index.ts 顶部 import 即装配 ✓
- 重复注册安全：registerDialect throw；测试 beforeEach 先 `__resetDialectsForTests()` ✓
- 无循环 import 风险：subagent-provider 对 anima.ts 仅 type-only import（运行时无环）✓
- normalizeH3Input 与工具侧 inferH3Stage/toRefs 语义逐行对齐（stage 优先级、width/height 仅 number 否则 null、formFields.references 回退）✓
- validateAnimaSlots：narrative string、白名单 9 槽位 string[]、未知键报错 — 与 composition.py `_coerce_brief` 校验面对齐 ✓

## Files

- M `src/pe-framework/intent/subagent-provider.ts`
- M `src/pe-framework/dialect/anima.ts`
- M `src/pe-framework/dialect/h3.ts`
- M `src/pe-framework/pipeline/runStage.ts`（1 行 ctx.shots 修补）
- M `src/plugin/index.ts`（2 行 import）
- A `tests/pe-framework/dialect/anima-register.test.ts`
- A `tests/pe-framework/dialect/h3-register.test.ts`
