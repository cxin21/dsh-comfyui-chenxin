import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-tools';

export function textStream(text: string, usage?: TokenUsage): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...(usage ? [{ type: 'usage' as const, usage }] : []),
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

export function errorStream(message: string, code = 'E_TEST'): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: { message, code } } }];
}

export function abortedStream(message: string, code = 'E_TEST'): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'aborted', failure: { message, code } } }];
}

export interface ToolDefLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: { schema: unknown; render: (args: unknown, value: JsonValue) => unknown[] };
  execute(args: unknown, exec: unknown): Promise<unknown>;
}

export interface StubContext {
  tools: { registered: ToolDefLike[]; register(def: ToolDefLike): () => void };
  llm: { calls: GenerateOptions[]; stream(options: GenerateOptions): AsyncIterable<StreamChunk> };
  settings?: { get(): Record<string, string>; update(p: object): Promise<void>; replace(s: object): Promise<void> };
  effect(): void;
}

export function stubCtx(opts: { stream?: StreamChunk[]; settings?: StubContext['settings'] } = {}): StubContext {
  const calls: GenerateOptions[] = [];
  const llm = {
    calls,
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options);
      for (const chunk of opts.stream ?? textStream('ok')) yield chunk;
    },
  };
  const ctx: StubContext = {
    tools: {
      registered: [],
      register(def) {
        this.registered.push(def);
        return () => {};
      },
    },
    llm,
    settings: opts.settings,
    effect() {},
  };
  return ctx;
}

export interface ExecOverrides {
  events?: unknown[];
  options?: { provider?: string; model?: string };
}

export function stubExec(overrides: ExecOverrides = {}) {
  return {
    signal: new AbortController().signal,
    agent: {
      session: { events: overrides.events ?? [], requestHeader: () => undefined },
      // R1：agent 模型走 options（默认已配置，模拟 DSH 会话；route/抛错语义由 complete.test 显式 exec 覆盖）
      options: overrides.options ?? { provider: 'p', model: 'm' },
    },
  };
}

export async function runTool(
  ctx: StubContext,
  def: ToolDefLike,
  args: unknown,
  exec: unknown = stubExec(),
): Promise<unknown> {
  return def.execute(args, exec);
}

// ── directing 管线 e2e fixtures（新管线契约测试共用，spec 2026-09-17 §3/§7）──

export const D_SCRIPT_IR = {
  characters: [{ id: 'S1', name: 'A', appearance_lock: 'tall', wardrobe: 'coat', notes: '' }],
  locations: [{ id: 'L1', name: 'street', spatial_landmarks: 'gate' }],
  props: [],
  info_cuts: [],
};

export function dShot(id: string, duration: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    purpose_tag: 'establish',
    time: '00:00',
    duration_seconds: duration,
    what: 'wide establishing shot',
    who: 'S1',
    shot_size: '全景',
    camera: 'wide slow push in', // R5 G-cameramotion：需含运动语汇
    stage: 't2va',
    route_reason: 'text only',
    sound: 'hum',
    tags: [],
    transition: '硬切',
    technique: null,
    shot_intent: { new_information: 'she appears', narrative_subject: 'her', contains_reaction: false },
    reference_plan: [],
    direction: { performance: 'stands tall', staging: 'center', cinematography: 'wide', dialogue: null, micro_performance: 'calm' },
    continuity_handoff: { positions: 'center', emotion: 'composed', props: 'none', audio: 'hum' },
    ...extra,
  };
}

export function dBeat(id: string, shots: unknown[]) {
  return {
    id,
    purpose: 'establish',
    creative_intent: { state_before: 'calm', trigger: 'enters', state_after: 'alert', audience_takeaway: 'danger' },
    location_id: 'L1',
    character_ids: ['S1'],
    shots,
  };
}

/** 标准五槽位 runner mock（happy path：1 Beat × 1 镜 × 4s，零 critical）；overrides 覆盖任意 runner */
export function dDeps(overrides: Record<string, unknown> = {}) {
  return {
    scriptAnalystRunner: async () => JSON.stringify(D_SCRIPT_IR),
    beatDirectorRunner: async () => JSON.stringify({ beats: [dBeat('B01', [dShot('B01-S1', 4)])] }),
    shotWriterRunner: async () => JSON.stringify({ shots: [{ what: 'wide establishing shot', who: 'S1', duration: 4 }] }),
    auditorRunner: async () => JSON.stringify({ verdict: 'pass', findings: [] }),
    repairerRunner: async () => JSON.stringify({}),
    ...overrides,
  };
}
