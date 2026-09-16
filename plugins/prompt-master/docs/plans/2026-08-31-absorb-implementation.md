# Prompt Master 吸收增强（五项全做）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 吸收 PromptMaster 3.1.0 的五项优秀设计——模型能力矩阵、结构感知续写引擎、JoyExtra 三段式硬约束、模型分流净化链、媒体身份映射（S 子集）、Profile 双层存储——全部按"注册表/声明制"挂进现有 runStage 架构。

**Architecture:** B0 能力矩阵是 B1 续写/B3 净化的公共路由底座；B1/B3 挂模型交互循环与输出后处理；B2 挂 sanitize 链；B4 挂 prompt_reverse 多图；B5 重做 profile_list 存储底座。全部纯函数 + 边界注入（logger/signal），延续现有方言注册表模式。

**Tech Stack:** TypeScript（NodeNext/ES2022）、vitest、@deepseek-ai/{cordis,dsh-llm,dsh-tools,dsh-settings}、node:sqlite（已有）。

**Spec:** `docs/2026-08-31-absorb-spec.md`（同目录；§8 DSH 接口真实性清单是红线）

## Global Constraints

- 插件根 `$P` = `C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`
- 测试：`Push-Location $P; npx vitest run <file>`；全量 `npx vitest run`（315 基线，vitest.config.ts testTimeout=30s）；构建 `npm run build`
- git 根 = preset 根 `C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin`；commit 用 `git -C <根> add plugins/prompt-master/<相对>`
- **接口红线（spec §8）**：只允许使用已验证的 DSH 接口（llm.stream/BlockAssembler/createUserMessage/FinishReason/tools.register/settings.register/ctx.logger/exec.agent/exec.signal/session.events）；需要未列接口 → 停下验证再改 spec
- **schemastery 禁止 `.optional()`**（无 default 即可选；Task 1 教训）
- 纯函数层零日志；日志走 `ctx.logger?.info?.(...)`（可选链），摘要级不含正文
- fidelity 52 测试任何批次后必须保持全绿
- 不向后兼容：B5 旧形态数据不迁移；工具新参数均为可选添加（不破坏现有调用）
- B1 契约声明制：无契约不续写；expand 不挂续写（spec D2）
- B3 定界封套不做；垃圾分类器完整表不做（spec D8）
- **日志红线（spec §9）**：任何日志行不得包含 prompt 正文/图片数据/API key/完整 profile JSON；超 1KB 对象只打键名列表

---

### Task 1: B0 模型能力矩阵

**Files:**

- Create: `src/pe-framework/model-capabilities/families.ts`
- Create: `src/pe-framework/model-capabilities/capabilities.ts`
- Create: `src/pe-framework/model-capabilities/index.ts`（re-export）
- Modify: `src/tools/prompt-expand.ts`、`src/tools/prompt-reverse.ts`、`src/tools/minimax-scenario.ts`（接入 temperature 兜底）
- Test: `tests/pe-framework/model-capabilities/model-capabilities.test.ts`

**Interfaces:**

- Produces:
  - `export type ModelFamily = 'deepseek' | 'glm' | 'qwen-vl' | 'qwen-text' | 'gemma' | 'openai' | 'generic'`
  - `export function inferModelFamily(provider: string, model: string): ModelFamily`
  - `export interface ModelCapabilities { family; proneToTruncation: boolean; sanitizeLevel: 'none'|'generic'; mediaTargets: ReadonlyArray<'image'|'video'|'mixed'>; lockedOutputLang?: 'zh'|'en'; defaultTemperature?: number; defaultTopP?: number }`
  - `export function getCapabilities(family: ModelFamily): ModelCapabilities`
  - `export function applyCapabilities<T extends { temperature?: number }>(caps: ModelCapabilities, params: T): T`
  - `export const FAMILY_RULES: Array<{ family: ModelFamily; modelPatterns: RegExp[]; providerPatterns?: RegExp[] }>`
  - `export const FAMILY_CAPABILITIES: Record<ModelFamily, ModelCapabilities>`

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/model-capabilities/model-capabilities.test.ts
import { describe, expect, it } from 'vitest';
import {
  inferModelFamily,
  getCapabilities,
  applyCapabilities,
  FAMILY_CAPABILITIES,
} from '../../../src/pe-framework/model-capabilities/index.js';

describe('inferModelFamily', () => {
  const cases: Array<[string, string, string]> = [
    ['deepseek-official', 'deepseek-v4-flash', 'deepseek'],
    ['deepseek-official', 'deepseek-r2', 'deepseek'],
    ['zhipu', 'glm-5.3-flash', 'glm'],
    ['zhipu', 'glm-4.5v', 'glm'],
    ['ollama', 'qwen3-vl-8b-instruct', 'qwen-vl'],
    ['ollama', 'Qwen3-VL-8B', 'qwen-vl'], // 大小写/连字符变体
    ['openai', 'qwen3.5-27b', 'qwen-text'], // qwen 非 vl → qwen-text
    ['ollama', 'gemma4-12b', 'gemma'],
    ['openai', 'gpt-5', 'openai'],
    ['unknown-provider', 'mystery-model-9000', 'generic'],
    ['ollama', 'llama3', 'generic'], // 未注册家族 → generic
  ];
  for (const [provider, model, expected] of cases) {
    it(`infer(${provider}, ${model}) → ${expected}`, () => {
      expect(inferModelFamily(provider, model)).toBe(expected);
    });
  }
});

describe('capabilities table', () => {
  it('every family has a capabilities entry', () => {
    for (const family of Object.keys(FAMILY_CAPABILITIES)) {
      expect(FAMILY_CAPABILITIES[family as keyof typeof FAMILY_CAPABILITIES]).toBeTruthy();
    }
  });

  it('qwen-vl is prone to truncation and needs generic sanitize', () => {
    const caps = getCapabilities('qwen-vl');
    expect(caps.proneToTruncation).toBe(true);
    expect(caps.sanitizeLevel).toBe('generic');
    expect(caps.mediaTargets).toContain('image');
  });

  it('deepseek is clean (no truncation, no sanitize)', () => {
    const caps = getCapabilities('deepseek');
    expect(caps.proneToTruncation).toBe(false);
    expect(caps.sanitizeLevel).toBe('none');
  });
});

describe('applyCapabilities', () => {
  it('user-explicit temperature wins', () => {
    const caps = getCapabilities('qwen-vl');
    expect(applyCapabilities(caps, { temperature: 0.9 }).temperature).toBe(0.9);
  });

  it('family default fills undefined temperature', () => {
    const caps = getCapabilities('qwen-vl');
    const withDefault = { ...caps, defaultTemperature: 0.5 };
    expect(applyCapabilities(withDefault, { temperature: undefined }).temperature).toBe(0.5);
  });

  it('no default → temperature stays undefined', () => {
    const caps = getCapabilities('deepseek'); // deepseek 无 defaultTemperature
    expect(applyCapabilities(caps, { temperature: undefined }).temperature).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/pe-framework/model-capabilities/model-capabilities.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/pe-framework/model-capabilities/families.ts
export type ModelFamily = 'deepseek' | 'glm' | 'qwen-vl' | 'qwen-text' | 'gemma' | 'openai' | 'generic';

export interface FamilyRule {
  family: ModelFamily;
  modelPatterns: RegExp[];
  providerPatterns?: RegExp[];
}

/** 表驱动：新家族 = 加一行。顺序即优先级（先匹配先得）。 */
export const FAMILY_RULES: FamilyRule[] = [
  { family: 'qwen-vl', modelPatterns: [/qwen.*vl/i] },
  { family: 'qwen-text', modelPatterns: [/qwen/i] },
  { family: 'gemma', modelPatterns: [/gemma/i] },
  { family: 'glm', modelPatterns: [/^glm/i], providerPatterns: [/zhipu/i] },
  { family: 'deepseek', modelPatterns: [/deepseek/i] },
  { family: 'openai', modelPatterns: [/^gpt/i, /^o\d/i], providerPatterns: [/^openai$/i] },
];

export function inferModelFamily(provider: string, model: string): ModelFamily {
  for (const rule of FAMILY_RULES) {
    if (rule.modelPatterns.some((re) => re.test(model))) return rule.family;
    if (rule.providerPatterns?.some((re) => re.test(provider))) return rule.family;
  }
  return 'generic';
}
```

```ts
// src/pe-framework/model-capabilities/capabilities.ts
import type { ModelFamily } from './families.js';

export interface ModelCapabilities {
  family: ModelFamily;
  proneToTruncation: boolean;
  sanitizeLevel: 'none' | 'generic';
  mediaTargets: ReadonlyArray<'image' | 'video' | 'mixed'>;
  lockedOutputLang?: 'zh' | 'en';
  defaultTemperature?: number;
  defaultTopP?: number;
}

export const FAMILY_CAPABILITIES: Record<ModelFamily, ModelCapabilities> = {
  deepseek: { family: 'deepseek', proneToTruncation: false, sanitizeLevel: 'none', mediaTargets: ['image'] },
  glm: { family: 'glm', proneToTruncation: false, sanitizeLevel: 'none', mediaTargets: ['image', 'video', 'mixed'] },
  'qwen-vl': {
    family: 'qwen-vl',
    proneToTruncation: true,
    sanitizeLevel: 'generic',
    mediaTargets: ['image', 'video', 'mixed'],
    defaultTemperature: 0.5,
  },
  'qwen-text': { family: 'qwen-text', proneToTruncation: true, sanitizeLevel: 'generic', mediaTargets: [] },
  gemma: { family: 'gemma', proneToTruncation: true, sanitizeLevel: 'generic', mediaTargets: ['image'] },
  openai: { family: 'openai', proneToTruncation: false, sanitizeLevel: 'none', mediaTargets: ['image'] },
  generic: { family: 'generic', proneToTruncation: false, sanitizeLevel: 'none', mediaTargets: [] },
};

export function getCapabilities(family: ModelFamily): ModelCapabilities {
  return FAMILY_CAPABILITIES[family] ?? FAMILY_CAPABILITIES.generic;
}

/** 只填 undefined 字段——用户显式值永远赢 */
export function applyCapabilities<T extends { temperature?: number }>(caps: ModelCapabilities, params: T): T {
  return {
    ...params,
    ...(params.temperature === undefined && caps.defaultTemperature !== undefined
      ? { temperature: caps.defaultTemperature }
      : {}),
  };
}
```

```ts
// src/pe-framework/model-capabilities/index.ts
export * from './families.js';
export * from './capabilities.js';
```

- [ ] **Step 4: 运行确认通过**（全部用例 PASS；注意 `qwen3.5-27b` 用例——`/qwen/i` 命中 qwen-text，`/qwen.*vl/i` 不命中）

- [ ] **Step 5: 接入三个工具的 temperature 兜底**

每个工具（prompt-expand/prompt-reverse/minimax-scenario）在 `resolveRoute(exec)` 之后：

```ts
import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js';
// route 解析后：
const caps = getCapabilities(inferModelFamily(route.provider, route.model));
const effectiveParams = applyCapabilities(caps, { temperature: config.temperature });
// 后续 complete() 调用用 effectiveParams.temperature
```

- [ ] **Step 6: 全量回归 + 构建 + 提交**

Run: `npm run build`（exit 0）；`npx vitest run`（全绿）
Commit:

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/model-capabilities plugins/prompt-master/tests/pe-framework/model-capabilities plugins/prompt-master/src/tools
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): model capability matrix (family inference + defaults)"
```

---

### Task 2: B1 续写引擎（contract/inspect/merge/engine）

**Files:**

- Create: `src/pe-framework/continue/contract.ts`
- Create: `src/pe-framework/continue/inspect.ts`
- Create: `src/pe-framework/continue/merge.ts`
- Create: `src/pe-framework/continue/engine.ts`
- Create: `src/pe-framework/continue/index.ts`（re-export）
- Test: `tests/pe-framework/continue/continue-engine.test.ts`

**Interfaces:**

- Consumes: `FinishReason['kind']`（dsh-llm 类型，含 'max-tokens'）；`complete(ctx, {provider, model, system?, user, maxTokens, temperature?, signal})`（llm/complete.js 现有——由调用方封装为 generate）
- Produces:
  - `export interface OutputFieldContract { key: string; patterns: RegExp[] }`
  - `export interface OutputContract { id: string; fields: OutputFieldContract[]; groupSeparator?: RegExp; expectedGroups?: (formFields: Record<string, unknown>) => number }`
  - `export interface StructureInspection { missing: string[]; complete: boolean }`
  - `export function inspectOutput(text: string, contract: OutputContract): StructureInspection`
  - `export function mergeContinuedText(previous: string, continued: string): string`
  - `export interface ContinueSeed { system?: string; userText: string; outputLang: 'zh' | 'en' }`
  - `export interface ContinueOutcome { text: string; rounds: number; complete: boolean; warnings: string[] }`
  - `export async function continueUntilComplete(params: { contract: OutputContract; initialText: string; finishKind: 'stop'|'tool-calls'|'max-tokens'|'aborted'|'error'; seed: ContinueSeed; generate: (req: { system?: string; user: string }) => Promise<{ text: string; finishKind: 'stop'|'tool-calls'|'max-tokens'|'aborted'|'error' }>; maxRounds?: number; signal: AbortSignal; onContinue?: (round: number, maxRounds: number) => void }): Promise<ContinueOutcome>`

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/continue/continue-engine.test.ts
import { describe, expect, it } from 'vitest';
import { inspectOutput, type OutputContract } from '../../../src/pe-framework/continue/inspect.js';
import { mergeContinuedText } from '../../../src/pe-framework/continue/merge.js';
import { continueUntilComplete } from '../../../src/pe-framework/continue/engine.js';

const sixSegment: OutputContract = {
  id: 'minimax-full-reference',
  fields: [
    { key: 'subject_definitions', patterns: [/subject_definitions\s*[:：]/i] },
    { key: 'summary', patterns: [/summary\s*[:：]/i, /摘要\s*[:：]/] },
    { key: 'retention_analysis', patterns: [/retention_analysis\s*[:：]/i] },
    { key: 'detailed_description', patterns: [/detailed_description\s*[:：]/i] },
    { key: 'overall_soundscape', patterns: [/overall_soundscape\s*[:：]/i] },
    { key: 'non_diegetic_music', patterns: [/non_diegetic_music\s*[:：]/i] },
  ],
};

describe('inspectOutput', () => {
  it('complete text → complete=true, missing=[]', () => {
    const text =
      'subject_definitions: X\nsummary: Y\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B';
    expect(inspectOutput(text, sixSegment)).toEqual({ missing: [], complete: true });
  });

  it('missing field reported as field:<key>', () => {
    const text = 'subject_definitions: X\nsummary: Y'; // 只有 2/6
    const r = inspectOutput(text, sixSegment);
    expect(r.complete).toBe(false);
    expect(r.missing).toContain('field:retention_analysis');
  });

  it('label with empty body (<2 chars) counts as missing', () => {
    const text =
      'subject_definitions: X\nsummary:\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B';
    expect(inspectOutput(text, sixSegment).missing).toContain('field:summary');
  });
});

describe('mergeContinuedText', () => {
  it('model parrots full text → take continued only', () => {
    expect(mergeContinuedText('ABC', 'ABCDEF')).toBe('ABCDEF');
  });
  it('suffix-prefix overlap 12+ chars → dedupe join', () => {
    const prev = 'A'.repeat(200) + 'TAIL-COMMON-SEGMENT-XXXX';
    const cont = 'TAIL-COMMON-SEGMENT-XXXX' + 'B'.repeat(50);
    const merged = mergeContinuedText(prev, cont);
    expect(merged).toBe(prev + 'B'.repeat(50));
  });
  it('no overlap → newline join; strips greeting prefix', () => {
    expect(mergeContinuedText('AAA', '好的，BBB')).toBe('AAA\nBBB');
  });
});

describe('continueUntilComplete', () => {
  const seed = { system: 'sys', userText: '写六段', outputLang: 'zh' as const };

  it('no truncation + complete → returns immediately (rounds=0)', async () => {
    const full =
      'subject_definitions: X\nsummary: Y\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B';
    let genCalls = 0;
    const r = await continueUntilComplete({
      contract: sixSegment,
      initialText: full,
      finishKind: 'stop',
      seed,
      generate: async () => {
        genCalls++;
        return { text: full, finishKind: 'stop' as const };
      },
      signal: new AbortController().signal,
    });
    expect(r.complete).toBe(true);
    expect(r.rounds).toBe(0);
    expect(genCalls).toBe(0);
  });

  it('max-tokens + incomplete → continues with accumulated text in user message', async () => {
    const part1 = 'subject_definitions: X\nsummary: Y';
    const cont = 'retention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B';
    let capturedUser = '';
    const r = await continueUntilComplete({
      contract: sixSegment,
      initialText: part1,
      finishKind: 'max-tokens',
      seed,
      generate: async (req) => {
        capturedUser = req.user;
        return { text: cont, finishKind: 'stop' as const };
      },
      signal: new AbortController().signal,
    });
    expect(r.complete).toBe(true);
    expect(r.rounds).toBe(1);
    expect(capturedUser).toContain('已写出');
    expect(capturedUser).toContain(part1);
    expect(r.text).toContain('subject_definitions');
    expect(r.text).toContain('non_diegetic_music');
  });

  it('abort mid-round → partial text + CONTINUE_ABORTED_PARTIAL warning', async () => {
    const ctl = new AbortController();
    const r = await continueUntilComplete({
      contract: sixSegment,
      initialText: 'subject_definitions: X',
      finishKind: 'max-tokens',
      seed,
      generate: async (req) => {
        ctl.abort();
        return { text: 'summary: Y', finishKind: 'stop' as const };
      },
      signal: ctl.signal,
    });
    expect(r.complete).toBe(false);
    expect(r.warnings).toContain('CONTINUE_ABORTED_PARTIAL');
  });

  it('max rounds exhausted → INCOMPLETE_AFTER_MAX_ROUNDS', async () => {
    let n = 0;
    const r = await continueUntilComplete({
      contract: sixSegment,
      initialText: 'x',
      finishKind: 'max-tokens',
      seed,
      maxRounds: 2,
      generate: async () => {
        n++;
        return { text: `chunk${n}`, finishKind: 'max-tokens' as const };
      },
      signal: new AbortController().signal,
    });
    expect(r.complete).toBe(false);
    expect(r.warnings).toContain('INCOMPLETE_AFTER_MAX_ROUNDS');
    expect(r.rounds).toBe(2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现（spec §3.1/3.2 逐条）**

`contract.ts`：类型定义（见 Interfaces）。
`inspect.ts`：

```ts
import type { OutputContract, StructureInspection } from './contract.js';
export function inspectOutput(text: string, contract: OutputContract): StructureInspection {
  const missing: string[] = [];
  for (const f of contract.fields) {
    const hit = f.patterns.some((re) => re.test(text));
    if (!hit) {
      missing.push(`field:${f.key}`);
      continue;
    }
    // 标签体非空检查：取命中标签之后到下一个换行/下一标签的文本段
    for (const re of f.patterns) {
      const m = re.exec(text);
      if (m && m.index !== undefined) {
        const body = text.slice(
          m.index + m[0].length,
          text.indexOf('\n', m.index) === -1 ? undefined : text.indexOf('\n', m.index),
        );
        if (body.trim().length < 2) {
          missing.push(`field:${f.key}`);
        }
        break;
      }
    }
  }
  return { missing, complete: missing.length === 0 };
}
```

`merge.ts`：

```ts
const GREETING = /^(好的[，,。！!]?|继续输出[：:]?|如下[：:]?)\s*/;
export function mergeContinuedText(previous: string, continued: string): string {
  let cont = continued.replace(GREETING, '').trim();
  if (!cont) return previous;
  if (cont.startsWith(previous.trim())) return cont; // 复读
  // 后缀-前缀重叠探测：窗口 12..240
  const maxWin = Math.min(240, previous.length, cont.length);
  for (let win = maxWin; win >= 12; win--) {
    const tail = previous.slice(-win);
    const idx = cont.indexOf(tail);
    if (idx !== -1) return previous + cont.slice(idx + win);
  }
  return previous + '\n' + cont;
}
```

`engine.ts`：

```ts
import { inspectOutput } from './inspect.js';
import { mergeContinuedText } from './merge.js';
import type { OutputContract, ContinueSeed, ContinueOutcome } from './contract.js';

type FinishKind = 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error';

export async function continueUntilComplete(params: {
  contract: OutputContract;
  initialText: string;
  finishKind: FinishKind;
  seed: ContinueSeed;
  generate: (req: { system?: string; user: string }) => Promise<{ text: string; finishKind: FinishKind }>;
  maxRounds?: number;
  signal: AbortSignal;
  onContinue?: (round: number, maxRounds: number) => void;
}): Promise<ContinueOutcome> {
  const max = params.maxRounds ?? 3;
  const warnings: string[] = [];
  let text = params.initialText;
  let finish = params.finishKind;
  let rounds = 0;
  while (rounds < max) {
    const inspection = inspectOutput(text, params.contract);
    const shouldContinue = !inspection.complete || finish === 'max-tokens';
    if (!shouldContinue) break;
    params.signal.throwIfAborted();
    rounds++;
    params.onContinue?.(rounds, max);
    const missingList = inspection.missing.length > 0 ? inspection.missing.join(', ') : '(结构未知，可能有暗截断)';
    const instruction =
      params.seed.outputLang === 'en'
        ? `Already written (do NOT rewrite; continue from it): -----\n${text}\n-----\n\nMissing: ${missingList}. Continue from where it stops.`
        : `已写出（不要重写，基于它继续）：-----\n${text}\n-----\n\n缺失内容：${missingList}。请从缺失处继续输出，不要重复已有内容。`;
    let piece: string;
    try {
      const gen = await params.generate({ system: params.seed.system, user: instruction });
      piece = gen.text;
      finish = gen.finishKind;
    } catch (error) {
      if (text !== params.initialText) warnings.push('CONTINUE_ABORTED_PARTIAL');
      throw error;
    }
    text = mergeContinuedText(text, piece);
    if (params.signal.aborted) {
      warnings.push('CONTINUE_ABORTED_PARTIAL');
      return { text, rounds, complete: false, warnings };
    }
  }
  const final = inspectOutput(text, params.contract);
  if (!final.complete || finish === 'max-tokens') warnings.push('INCOMPLETE_AFTER_MAX_ROUNDS');
  return { text, rounds, complete: final.complete && finish !== 'max-tokens', warnings };
}
```

> 注意 abort 语义：signal.throwIfAborted 在轮首；generate 内部 abort 由调用方 signal 传播；轮后 `signal.aborted` 检查返回部分结果。engine 的 contract import 路径以实际文件组织为准（contract.ts 存类型）。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 构建 + 提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/continue plugins/prompt-master/tests/pe-framework/continue
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): structure-aware continue engine (contract/inspect/merge)"
```

---

### Task 3: B1 接入 minimax 场景（契约声明 + generate 封装）

**Files:**

- Modify: `src/pe-framework/schema/scenes.ts`（场景 catalog 条目加可选 `outputContract`；full_reference 与 director_segments 场景声明契约）
- Modify: `src/tools/minimax-scenario.ts`（场景带契约时 complete 后走 continueUntilComplete；日志打点）
- Test: `tests/plugin/minimax-continue.test.ts`（新增，mock complete 不发真请求——**注意**：minimax_scenario 现有测试 mock 的是 ctx.llm.stream（complete 底层），续写多轮 = 多次 stream，mock 需按调用次序返回截断/续写两段）

**Interfaces:**

- Consumes: `continueUntilComplete`（Task 2）；`complete(ctx, opts)`（现有）；现有场景 catalog 结构（read `src/pe-framework/schema/scenes.ts` 确认条目形状后加字段）
- Produces: 场景条目新可选字段 `outputContract?: OutputContract`；minimax_scenario 在带契约场景上的续写行为

- [ ] **Step 1: read scenes.ts 确认场景条目类型与 full_reference/director_segments 条目；确认 minimax-scenario.ts 的 complete 调用点**

- [ ] **Step 2: 写失败测试**

```ts
// tests/plugin/minimax-continue.test.ts
// mock ctx.llm.stream：第一次调用返回半截六段（finish=max-tokens chunk），第二次返回余下段（finish=stop）
// 断言：minimax_scenario 返回的 Envelope result.text 含全部六段；advisories 或日志含续写轮次
// （mock 模式参考 tests/plugin/minimax.test.ts 现有 stream mock 写法——read 后复用）
```

（测试代码以现有 minimax.test.ts 的 mock 模式为准编写——Task 3 执行者先 read 该文件。断言点：合并后六段齐全、rounds≥1。）

- [ ] **Step 3: scenes.ts 契约声明**

```ts
// 场景条目类型加：outputContract?: OutputContract（import from '../continue/contract.js'）
// full_reference 条目：六段 fields（Task 2 测试里的 sixSegment 表——字段 key 与 compileH3 输出实际段名核对，read src/pe-framework/dialect/h3.ts 的 build_ref2va_text 段名定稿）
// director_segments 条目：groupSeparator: /={3,}\s*提示词组\s*(\d+)\s*={3,}/, expectedGroups: (ff) => Number(ff?.segment_count ?? 4)
```

> **契约字段名以实际模板为准**：Task 3 执行者必须 read `src/pe-framework/dialect/h3.ts` 中六段的实际英文段名（subject_definitions/summary/retention_analysis/detailed_description/overall_soundscape/non_diegetic_music）并让 patterns 与之逐字对齐——这是契约有效性的根。

- [ ] **Step 4: minimax-scenario.ts 挂接**

```ts
// complete 调用后：
const contract = scenario.outputContract;
let text = rawText,
  rounds = 0;
if (contract) {
  const outcome = await continueUntilComplete({
    contract,
    initialText: text,
    finishKind: finish.kind,
    seed: { system, userText: user, outputLang: 'zh' },
    generate: async (req) => {
      const g = await complete(ctx, {
        provider,
        model,
        system: req.system,
        user: req.user,
        maxTokens,
        temperature: config.temperature,
        signal: exec.signal,
      });
      return { text: g.text, finishKind: g.finish.kind };
    },
    signal: exec.signal,
    onContinue: (n, max) => ctx.logger?.info?.(`[prompt-master] continue round=${n}/${max}`),
  });
  text = outcome.text;
  rounds = outcome.rounds;
  ctx.logger?.info?.(`[prompt-master] minimax_scenario → continue complete=${outcome.complete} rounds=${rounds}`);
}
```

> **B0 接入**：此处 temperature 已在 Task 1 接 applyCapabilities——保持。

- [ ] **Step 5: 测试 + 全量 + 构建 + 提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/schema/scenes.ts plugins/prompt-master/src/tools/minimax-scenario.ts plugins/prompt-master/tests/plugin/minimax-continue.test.ts
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): wire continue engine into minimax scenarios (contract-declared)"
```

---

### Task 4: B2 JoyExtra 三段式

**Files:**

- Create: `src/pe-framework/sanitize/joy-extra.ts`
- Modify: `src/tools/prompt-reverse.ts`（参数 + 注入 + 过滤）
- Modify: `src/tools/prompt-author.ts`（form_fields 透传 + anima 输出过滤）
- Test: `tests/pe-framework/sanitize/joy-extra.test.ts`

**Interfaces:**

- Produces:
  - `export type JoyExtraOptionId = 'no_glasses_headwear' | 'scene_only_no_character_appearance' | 'no_artistic_style' | 'character_name'`
  - `export function resolveJoyExtraOptions(input: { joyExtraOptions?: unknown; extraPrompt?: string; characterName?: unknown }): JoyExtraResolution`（`interface JoyExtraResolution { options: JoyExtraOptionId[]; characterName?: string }` 同文件导出）
  - `export function buildJoyExtraSystemBlock(res: JoyExtraResolution, outputLang: 'zh'|'en'): string`
  - `export function buildJoyExtraUserTail(res: JoyExtraResolution, outputLang: 'zh'|'en'): string`
  - `export function filterJoyExtraClauses(text: string, res: JoyExtraResolution): string`

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/sanitize/joy-extra.test.ts
import { describe, expect, it } from 'vitest';
import {
  resolveJoyExtraOptions,
  buildJoyExtraSystemBlock,
  filterJoyExtraClauses,
} from '../../../src/pe-framework/sanitize/joy-extra.js';

describe('resolveJoyExtraOptions', () => {
  it('array mode: explicit ids win', () => {
    expect(resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] }).options).toContain(
      'no_glasses_headwear',
    );
  });
  it('text sniff mode: standard sentence in extra_prompt detected', () => {
    const r = resolveJoyExtraOptions({ extraPrompt: 'Do not mention glasses, goggles, hats or any headwear.' });
    expect(r.options).toContain('no_glasses_headwear');
  });
  it('character_name captured from refer-to pattern', () => {
    const r = resolveJoyExtraOptions({ characterName: '小明' });
    expect(r.characterName).toBe('小明');
  });
  it('unknown array ids filtered out', () => {
    expect(resolveJoyExtraOptions({ joyExtraOptions: ['bogus', 'no_artistic_style'] }).options).toEqual([
      'no_artistic_style',
    ]);
  });
});

describe('filterJoyExtraClauses', () => {
  it('removes glasses/headwear clauses', () => {
    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] });
    const out = filterJoyExtraClauses('一位少女，戴着红色贝雷帽，穿白色连衣裙，站在树下', r);
    expect(out).not.toContain('贝雷帽');
    expect(out).toContain('白色连衣裙');
  });
  it('keeps original separator style', () => {
    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] });
    const out = filterJoyExtraClauses('1girl, red beret, white dress', r);
    expect(out).not.toContain('beret');
    expect(out).toContain('white dress');
    expect(out).toContain(', '); // 英文逗号分隔保留
  });
  it('all clauses filtered → return original (anti-extinction)', () => {
    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] });
    const src = '戴着墨镜和帽子';
    expect(filterJoyExtraClauses(src, r)).toBe(src);
  });
  it('no options → text unchanged', () => {
    expect(filterJoyExtraClauses('戴着墨镜的少女', resolveJoyExtraOptions({}))).toBe('戴着墨镜的少女');
  });
});

describe('buildJoyExtraSystemBlock', () => {
  it('contains priority declaration + conflict override for glasses option', () => {
    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] });
    const block = buildJoyExtraSystemBlock(r, 'zh');
    expect(block).toContain('硬约束');
    expect(block).toContain('眼镜');
  });
});
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**

实现要点（对照 absorb-analysis §3）：

- `GLASSES_HEADWEAR_PATTERNS`：/眼镜|护目镜|墨镜|太阳镜|帽子|帽|头盔|发箍|头巾|面罩|贝雷帽|beret|hat|glasses|goggles|headwear|头戴.{0,6}镜|佩戴.{0,6}镜/i
- `APPEARANCE_CLOTHING_PATTERNS`：/肤色|胎记|疤痕|雀斑|妆容|五官|发型|发色|服装|连衣裙|身材|胸|背|肩|腰|skin|freckle|scar|makeup|hairstyle|clothing|outfit/i（按 PromptMaster deob 版裁剪核心条目）
- `splitClauses`：按 `[，,；;。.!！?？\n]` 切 + 记录原分隔符数组，拼回时逐一还原
- 子句过滤：命中任一启用选项的正则组 → 剔除；全部被剔除 → 返回原文
- system 块含：优先级声明句 + 每选项豁免令（如"不写眼镜/头饰：即使面部检查表要求写眼镜、面具或头饰，也必须完全省略"）+ 冲突仲裁（no_character_appearance 优先级高于 no_glasses_headwear 的"不可变属性"分支时以后者为准——按 PromptMaster 原版仲裁句移植）
- 标准句（嗅探用）：no_glasses_headwear = 'Do not mention glasses, goggles, hats or any headwear.'；其余三个选项各写英文标准句 + 中文变体（执行者按 PromptMaster deob `joyCaptionExtraOptions.js.deob.js` 的标准句移植——**read 该文件取逐字文本**）

- [ ] **Step 4: 确认通过 + 挂接工具**

prompt-reverse.ts：

```ts
// 参数：joy_extra_options?: string[], character_name?: string（schema 加两个可选字段）
// resolveJoyExtraOptions({ joyExtraOptions: a.joy_extra_options, extraPrompt: a.extra_prompt, characterName: a.character_name })
// res.options.length > 0 时：system += '\n\n' + buildJoyExtraSystemBlock(res, lang)；user += '\n' + buildJoyExtraUserTail(res, lang)
// 输出：sanitized = filterJoyExtraClauses(sanitized, res)
// 日志：joy_extra options=... filtered=yes/no
```

prompt-author.ts：

```ts
// runDraftStage 后（anima 分支）：res = resolveJoyExtraOptions({ joyExtraOptions: a.form_fields?.joy_extra_options, extraPrompt: '' })
// res.options.length > 0 → stage.result.positive/negative 各过 filterJoyExtraClauses
```

- [ ] **Step 5: 全量 + 构建 + 提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/sanitize plugins/prompt-master/src/tools plugins/prompt-master/tests/pe-framework/sanitize
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): JoyExtra three-stage hard constraints (inject + tail + clause filter)"
```

---

### Task 5: B3 输出净化链（通用层）

**Files:**

- Create: `src/pe-framework/sanitize/model-specific.ts`
- Modify: `src/tools/prompt-reverse.ts`、`src/tools/prompt-expand.ts`（sanitizeModelSpecific 前置）
- Test: `tests/pe-framework/sanitize/model-specific.test.ts`

**Interfaces:**

- Consumes: `getCapabilities`/`inferModelFamily`（Task 1）；`sanitizeLevel: 'generic'`
- Produces: `export function sanitizeModelSpecific(text: string, ctx: { family: ModelFamily; outputLang: string }): string`

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/sanitize/model-specific.test.ts
import { describe, expect, it } from 'vitest';
import { sanitizeModelSpecific } from '../../../src/pe-framework/sanitize/model-specific.js';

describe('sanitizeModelSpecific', () => {
  it('sanitizeLevel none → unchanged (deepseek)', () => {
    const src = '<think>internal</think>输出文本';
    expect(sanitizeModelSpecific(src, { family: 'deepseek', outputLang: 'zh' })).toBe(src);
  });

  it('strips think tags for generic family', () => {
    expect(sanitizeModelSpecific('<think>reasoning</think>正文内容', { family: 'qwen-vl', outputLang: 'zh' })).toBe(
      '正文内容',
    );
  });

  it('extracts polished tail (last marker wins)', () => {
    const src = '初稿内容\n润色与精简:\n最终精修文本';
    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).toBe('最终精修文本');
  });

  it('strips instruction echo lines', () => {
    const src = '这张图片展示了一个女孩\n实际的描述内容';
    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).not.toContain('这张图片');
    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).toContain('实际的描述内容');
  });

  it('normal output untouched (negative case)', () => {
    const src = '一位穿红裙的少女站在樱花树下，阳光柔和';
    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).toBe(src);
  });
});
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**

```ts
// src/pe-framework/sanitize/model-specific.ts
import { getCapabilities, type ModelFamily } from '../model-capabilities/index.js';

const THINK_RE = /<think>[\s\S]*?<\/think>/gi;
const THINK_UNCLOSED_RE = /<think>[\s\S]*$/i;
const THINK_ZH_RE = /思考[：:][\s\S]*?(?=\n|$)/g;
const TAIL_MARKERS = [
  '润色与精简:',
  '精简后:',
  '最终输出:',
  'Final polished caption:',
  'Polished:',
  '最终答案:',
  '优化后:',
  'Refined:',
];
const ECHO_LINE_RE = /^(这张图片|这是|我需要|关键词构思|整合|组合成|精简并优化|答案[:：])/;

function stripThinkingTags(text: string): string {
  return text.replace(THINK_RE, '').replace(THINK_UNCLOSED_RE, '').replace(THINK_ZH_RE, '').trim();
}
function extractPolishedTail(text: string): string {
  let lastIdx = -1;
  let lastLen = 0;
  for (const marker of TAIL_MARKERS) {
    const idx = text.lastIndexOf(marker);
    if (idx > lastIdx) {
      lastIdx = idx;
      lastLen = marker.length;
    }
  }
  if (lastIdx === -1) return text;
  const tail = text.slice(lastIdx + lastLen).trim();
  return tail.length >= 2 ? tail : text;
}
function stripInstructionEchoLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !ECHO_LINE_RE.test(line.trim()))
    .join('\n')
    .trim();
}

export function sanitizeModelSpecific(text: string, ctx: { family: ModelFamily; outputLang: string }): string {
  const caps = getCapabilities(ctx.family);
  if (caps.sanitizeLevel !== 'generic') return text;
  let out = stripThinkingTags(text);
  out = extractPolishedTail(out);
  out = stripInstructionEchoLines(out);
  return out;
}
```

- [ ] **Step 4: 确认通过 + 挂接**

prompt-reverse.ts / prompt-expand.ts：`complete()` 返回后、sanitizeFinalCaption（reverse）/返回（expand）之前：

```ts
const family = inferModelFamily(route.provider, route.model);
text = sanitizeModelSpecific(text, { family, outputLang: lang });
```

日志：`sanitize family=${family} changed=${before !== after}`。

- [ ] **Step 5: 全量 + 构建 + 提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/sanitize/model-specific.ts plugins/prompt-master/src/tools plugins/prompt-master/tests/pe-framework/sanitize/model-specific.test.ts
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): model-family output sanitize pipeline (generic level)"
```

---

### Task 6: B4 媒体身份映射（S 子集）

**Files:**

- Create: `src/pe-framework/media/identity.ts`
- Modify: `src/tools/prompt-reverse.ts`（多图时注入声明块）
- Test: `tests/pe-framework/media/identity.test.ts`

**Interfaces:**

- Consumes: `ImageBlock`（dsh-llm 类型）；`collectRecentImages`（prompt-reverse.ts 现有）
- Produces:
  - `export interface TaggedMedia { n: number; tag: string }`
  - `export function enumerateTaggedMedia(count: number): TaggedMedia[]`
  - `export function buildIdentityDeclarations(media: TaggedMedia[], outputLang: 'zh' | 'en'): string`

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/media/identity.test.ts
import { describe, expect, it } from 'vitest';
import { enumerateTaggedMedia, buildIdentityDeclarations } from '../../../src/pe-framework/media/identity.js';

describe('enumerateTaggedMedia', () => {
  it('tags are consecutive 1-based <Picture N>', () => {
    expect(enumerateTaggedMedia(3)).toEqual([
      { n: 1, tag: '<Picture 1>' },
      { n: 2, tag: '<Picture 2>' },
      { n: 3, tag: '<Picture 3>' },
    ]);
  });
  it('zero media → empty', () => {
    expect(enumerateTaggedMedia(0)).toEqual([]);
  });
});

describe('buildIdentityDeclarations', () => {
  it('multi-image → declaration block with do-not-swap header', () => {
    const decl = buildIdentityDeclarations(enumerateTaggedMedia(2), 'zh');
    expect(decl).toContain('<Picture 1>');
    expect(decl).toContain('<Picture 2>');
    expect(decl).toContain('不要混淆'); // do-not-swap 语义
  });
  it('single image → empty string (no injection)', () => {
    expect(buildIdentityDeclarations(enumerateTaggedMedia(1), 'zh')).toBe('');
  });
});
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**

```ts
// src/pe-framework/media/identity.ts
export interface TaggedMedia {
  n: number;
  tag: string;
}

export function enumerateTaggedMedia(count: number): TaggedMedia[] {
  return Array.from({ length: count }, (_, i) => ({ n: i + 1, tag: `<Picture ${i + 1}>` }));
}

export function buildIdentityDeclarations(media: TaggedMedia[], outputLang: 'zh' | 'en'): string {
  if (media.length < 2) return '';
  const lines = media.map((m) => (outputLang === 'en' ? `${m.tag} = image #${m.n}` : `${m.tag} = 第 ${m.n} 张图`));
  const header = outputLang === 'en' ? 'Identity mapping — do not swap identities:' : '身份映射 — 不要混淆对应关系：';
  return `${header}\n${lines.join('\n')}`;
}
```

- [ ] **Step 4: 确认通过 + 挂接 prompt-reverse**

```ts
// collectRecentImages 之后（images.length >= 2 分支）：
const media = enumerateTaggedMedia(images.length);
const declarations = buildIdentityDeclarations(media, String(a.output_lang || 'zh') === 'en' ? 'en' : 'zh');
if (declarations) {
  blocks.unshift({ type: 'text', text: declarations }); // 声明块置于媒体块之前
}
// 日志：multi-image identity declarations injected (n=${images.length})
```

- [ ] **Step 5: 全量 + 构建 + 提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/media plugins/prompt-master/src/tools/prompt-reverse.ts plugins/prompt-master/tests/pe-framework/media
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): multi-image identity mapping declarations (S subset)"
```

---

### Task 7: B5 双层存储 + 导入导出

**Files:**

- Create: `src/pe-framework/profiles/storage-v2.ts`
- Modify: `src/plugin/index.ts`（注册 overrides namespace + 传入工具）
- Modify: `src/tools/profile-list.ts`（action 扩展：enable/sort/export/import/validate_import；list 改 merged）
- Test: `tests/pe-framework/profiles/storage-v2.test.ts` + `tests/plugin/profile-list-v2.test.ts`

**Interfaces:**

- Consumes: `ctx.settings.register`（已验证）；现有 `getDefaultBuiltinProfiles`/customProfiles 注入源（`src/resolver/profiles/{index,source}.ts`）；现有 ProfileScope
- Produces:
  - `export interface BuiltinOverride { enabled: boolean; sort?: number }`
  - `export function registerOverridesNamespace(ctx: Context): { get(): Record<string, BuiltinOverride>; set(id: string, o: BuiltinOverride | null): Promise<void>; all(): Record<string, BuiltinOverride> }`
  - `export function listProfilesMerged(builtins: PEProfile[], custom: PEProfile[], overrides: Record<string, BuiltinOverride>): PEProfile[]`
  - `export function recastImportedProfile(profile: Record<string, unknown>): Record<string, unknown>`（id → `pe_custom_+randomUUID()`，时间戳重置）
  - `export function validateImportPayload(payload: unknown, builtinIds: string[]): { ok: true; profile: Record<string, unknown> } | { ok: false; reason: string }`

- [ ] **Step 1: 写失败测试（纯函数层）**

```ts
// tests/pe-framework/profiles/storage-v2.test.ts
import { describe, expect, it } from 'vitest';
import {
  listProfilesMerged,
  recastImportedProfile,
  validateImportPayload,
} from '../../../src/pe-framework/profiles/storage-v2.js';

const builtins = [
  { id: 'pe_a', name: 'A', kind: 'reverse', sort: 1 },
  { id: 'pe_b', name: 'B', kind: 'expand', sort: 2 },
];
const custom = [{ id: 'pe_custom_x', name: 'X', kind: 'expand', sort: 5 }];

describe('listProfilesMerged', () => {
  it('disabled builtin excluded', () => {
    const r = listProfilesMerged(builtins, custom, { pe_a: { enabled: false } });
    expect(r.map((p) => p.id)).not.toContain('pe_a');
    expect(r.map((p) => p.id)).toContain('pe_b');
  });
  it('override sort re-orders', () => {
    const r = listProfilesMerged(builtins, custom, { pe_b: { enabled: true, sort: 0 } });
    expect(r[0].id).toBe('pe_b');
  });
  it('stale override pointing to nonexistent builtin ignored', () => {
    const r = listProfilesMerged(builtins, [], { pe_ghost: { enabled: false } });
    expect(r.map((p) => p.id)).toEqual(['pe_a', 'pe_b']);
  });
  it('custom profiles merged after builtins (sort ordered)', () => {
    const r = listProfilesMerged(builtins, custom, {});
    expect(r.map((p) => p.id)).toEqual(['pe_a', 'pe_b', 'pe_custom_x']);
  });
});

describe('validateImportPayload', () => {
  it('rejects builtin id collision', () => {
    const r = validateImportPayload({ id: 'pe_a', name: 'X', kind: 'expand', systemPrompt: 's' }, ['pe_a']);
    expect(r.ok).toBe(false);
  });
  it('rejects missing systemPrompt', () => {
    expect(validateImportPayload({ name: 'X', kind: 'expand' }, []).ok).toBe(false);
  });
  it('rejects bad kind', () => {
    expect(validateImportPayload({ name: 'X', kind: 'bogus', systemPrompt: 's' }, []).ok).toBe(false);
  });
  it('accepts valid single profile', () => {
    const r = validateImportPayload({ name: 'X', kind: 'expand', systemPrompt: 's' }, []);
    expect(r.ok).toBe(true);
  });
});

describe('recastImportedProfile', () => {
  it('recasts id to pe_custom_+uuid and resets timestamps', () => {
    const out = recastImportedProfile({
      id: 'pe_old',
      name: 'X',
      kind: 'expand',
      systemPrompt: 's',
      createdAt: 1,
      updatedAt: 1,
    });
    expect(out.id).toMatch(/^pe_custom_/);
    expect(out.id).not.toBe('pe_old');
    expect(out.createdAt).not.toBe(1);
  });
});
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**

```ts
// src/pe-framework/profiles/storage-v2.ts
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

export interface BuiltinOverride {
  enabled: boolean;
  sort?: number;
}
export interface OverridesSection {
  builtinOverrides: Record<string, BuiltinOverride>;
}

/** 注册内置覆盖层 namespace（spec §7.1；schemastery 无 .optional()——无 default 即可选） */
export function registerOverridesNamespace(ctx: Context) {
  const scope = (ctx as any).settings.register(
    'prompt-master-profile-overrides',
    z.object({
      builtinOverrides: z.dict(z.string(), z.object({ enabled: z.boolean(), sort: z.number() })),
    }),
  );
  return {
    all: (): Record<string, BuiltinOverride> => (scope.get() as any)?.builtinOverrides ?? {},
    set: async (id: string, o: BuiltinOverride | null) => {
      const cur = (scope.get() as any)?.builtinOverrides ?? {};
      const next = { ...cur };
      if (o === null) delete next[id];
      else next[id] = o;
      await scope.update({ builtinOverrides: next });
    },
  };
}

export function listProfilesMerged<T extends { id: string; sort?: number }>(
  builtins: T[],
  custom: T[],
  overrides: Record<string, BuiltinOverride>,
): T[] {
  const out: T[] = [];
  for (const b of builtins) {
    const o = overrides[b.id];
    if (o && o.enabled === false) continue;
    out.push(o?.sort !== undefined ? { ...b, sort: o.sort } : b);
  }
  out.push(...custom);
  return out.sort((x, y) => (x.sort ?? 999) - (y.sort ?? 999) || String(x.id).localeCompare(String(y.id)));
}

const IMPORT_KINDS = new Set(['expand', 'reverse', 'train']);
export function validateImportPayload(
  payload: unknown,
  builtinIds: string[],
): { ok: true; profile: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof payload !== 'object' || payload === null) return { ok: false, reason: 'payload 需为对象' };
  const p = payload as Record<string, unknown>;
  const builtinIdsSet = new Set(builtinIds);
  if (typeof p['id'] === 'string' && builtinIdsSet.has(p['id']))
    return { ok: false, reason: `id "${p['id']}" 与内置冲突，导入将重铸 id` };
  if (typeof p['name'] !== 'string' || !(p['name'] as string).trim()) return { ok: false, reason: 'name 必填' };
  if (typeof p['kind'] !== 'string' || !IMPORT_KINDS.has(p['kind']))
    return { ok: false, reason: `kind 需为 expand|reverse|train，得到 ${String(p['kind'])}` };
  if (typeof p['systemPrompt'] !== 'string' || !(p['systemPrompt'] as string).trim())
    return { ok: false, reason: 'systemPrompt 必填' };
  return { ok: true, profile: p };
}

export function recastImportedProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now();
  return { ...profile, id: `pe_custom_${randomUUID()}`, builtin: false, createdAt: now, updatedAt: now };
}
```

> PEProfile 的实际字段（read `src/resolver/types.js`）——`createdAt/updatedAt` 若不存在于类型则 recast 不设这两键（以编译为准）；`builtin` 字段同理核对。

- [ ] **Step 4: profile_list 工具扩展（action: enable/sort/export/import/validate_import；list 改 merged）**

```ts
// profile-list.ts 的 execute switch 加分支（read 现有 action 分派结构后插入）：
// enable: overrides.set(id, { enabled }) —— 内置 id 校验（builtinIds 列表从 getDefaultBuiltinProfiles 取）
// sort: for (ids) overrides.set(id, { enabled: true, sort: idx })
// export: find profile (merged) → JSON.stringify({ format: 'prompt-master-prompt-engineering', profile })
// import: validateImportPayload(payload, builtinIds) → ok → recastImportedProfile → scope.update 存 customProfiles → 返回新 id；fail → serializeReport ok=false
// validate_import: validateImportPayload → 人话结论（不落盘）
// list: 改用 listProfilesMerged(builtins, custom, overrides.all())
```

plugin/index.ts：`const overrides = registerOverridesNamespace(ctx)` → 传入 registerProfileListTool 的现有 options 对象（`{ scope, overrides }`）。

- [ ] **Step 5: 测试 + 全量 + 构建 + 提交**

Run: `npx vitest run tests/pe-framework/profiles/storage-v2.test.ts tests/plugin/profile-list.test.ts tests/plugin/profile-list-v2.test.ts`（现有 profile-list.test.ts 需适配 list merged 语义——read 后修）

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src plugins/prompt-master/tests
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): two-layer profile storage + import/export with id recast"
```

---

### Task 8: 收尾 —— 文档 + 端到端

**Files:**

- Modify: `docs/usage-prompt-engineering.md`（五项能力说明 + intent 决策表补充）
- Modify: `docs/2026-08-31-absorb-spec.md`（标记实施完成批次）

**Steps:**

- [ ] **Step 0: resolver×3.1.0 高优先缺口提醒**（不在本计划，引用 `docs/2026-08-31-resolver-3.1.0-diff.md` 的 4 项清单作为下一计划输入）
- [ ] **Step 1: 全量回归** —— `npm run build`；`npx vitest run`（315+新增全绿）；fidelity 52 绿
- [ ] **Step 2: usage 文档更新** —— 续写引擎（契约声明制）、JoyExtra 参数、净化链（按家族）、多图身份映射、profile_list 新 action
- [ ] **Step 3: 端到端（用户配合）** —— 新会话：① minimax_scenario 长场景验证续写（观察日志 continue round=N/M）；② prompt_reverse 传 joy_extra_options 验证过滤；③ Qwen 系模型验证净化链；④ 多图反推验证身份声明；⑤ profile_list enable/sort/import 验证存储
- [ ] **Step 4: 最终提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/docs
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "docs(prompt-master): absorb feature docs (continue engine, joy-extra, sanitize, media identity, profile storage)"
```
