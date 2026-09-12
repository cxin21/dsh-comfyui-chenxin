import type {
  AuthorIntentFn,
  AuthorIntentRequest,
  AuthorDraft,
} from '../../tools/prompt-author.js'
import type { H3ShotsInput } from '../schema/h3-shots.js'
import type { AnimaSlots } from '../dialect/anima.js'
import { BLUEPRINT_SCHEMA, parseBlueprintJson } from '../blueprint/analyzer.js'

/**
 * Task 12 Step 3b（spec §14）：intent 子代理瘦身——蓝图模式注入最小 system，
 * 去掉技能目录/工具说明噪音（子代理 trace 显示它曾纠结「要不要调 skill」）；
 * 旧 slots/shots 请求仍走原 persona（向后兼容）。
 */
export const BLUEPRINT_SUBAGENT_SYSTEM = '你是一个创作蓝图分析引擎。只输出 JSON，不要调用任何工具，不要输出任何解释。'

/**
 * O13（spec §6 澄清接口）：蓝图关键缺失维度 = style/media/negative 边界（与 analyzer.ts 的
 * KEY_MISSING_DIMS 同款规则，spec §6 L230「关键缺失（风格/媒介/负向边界，影响产出方向）」）。
 * 保持与 analyzeIntent 一致，避免 drift。
 */
const KEY_CLARIFY_DIMS = ['style', 'media', 'negative']

/**
 * R2 SubagentIntentProvider：通过 ctx.subagents.start（one-shot seam）创建创作子代理。
 * 关键设计：ownerCtx 在 plugin/apply 闭包里**一次性绑定**（子代理 seam 复用）；
 * fn 签名 = AuthorIntentFn = (req, exec?) => Promise<AuthorDraft>（与 prompt-author.ts 的 seam 完全兼容），
 * parent Agent 取自工具执行上下文 exec.agent（真实运行时），ownerCtx.agent 仅为回退。
 *
 * 驱动（DSH 0.1.2 新 seam）：`ctx.subagents.start(provider, request)` 一次性发布子代理 run，
 * `run.result` 等子代理最终输出（finalAssistantOutput）→ 解析 JSON → normalize → run.dispose()。
 * persona + schema 作为 user message 前缀注入；provider/model 不指定 → 继承 parent 当前会话路由（R1）。
 */

/** DSH 0.1.2 one-shot subagent run 的鸭子类型（测试 mock 与真实 seam 共用）。 */
export interface SubagentLikeRun {
  id: string
  localAgent?: unknown
  result: Promise<{
    output: Array<{ type: string; text?: string }>
    stopReason: string
    diagnostic?: string
  }>
  dispose: () => Promise<unknown> | unknown
}

export interface SubagentProviderOptions {
  persona?: string
  schema?: string
  timeoutMs?: number
  /** ctx.subagents provider 名；缺省 'spawn'（dsh-base 已挂载 spawn/fork）。 */
  provider?: string
  /** 仅测试用：把解析结果强制为指定对象（跳过 JSON 解析） */
  _testOverride?: (rawText: string, req: AuthorIntentRequest) => AuthorDraft | null
}

/**
 * 创建子代理 Intent Provider：ownerCtx 在此一次性绑定，返回可装入 author.ts seam 的 AuthorIntentFn。
 * ownerCtx 应包含 ctx.subagents 服务（plugin inject ['subagents']）。
 */
export function createSubagentIntentProvider(
  ownerCtx: any,
  opts: SubagentProviderOptions = {},
): AuthorIntentFn {
  // R9：默认 60s 实战连续超时（session-97f3819d 三连失败）→ 180s，支持 PM_SUBAGENT_TIMEOUT_MS 覆盖
  const envTimeout = Number(process.env.PM_SUBAGENT_TIMEOUT_MS ?? '')
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 180_000)
  const provider = opts.provider ?? 'spawn'

  if (!ownerCtx?.subagents?.start) {
    throw new Error('SubagentIntentProvider 不可用：ctx.subagents 未注册（DSH host 未加载 subagent 服务或 plugin 未注入 "subagents"）。提示：检查 plugin inject 是否含 "subagents"，或稍后重试。')
  }

  return async function subagentIntent(req: AuthorIntentRequest, exec?: any): Promise<AuthorDraft> {
    // persona/schema 解析（Task 7 方言化）：req（author 按 dialect.intent 注入）> opts（插件配置）> 全局 DEFAULT 兜底
    // Task 12 Step 3b：蓝图模式（target='blueprint'）强制 BLUEPRINT_SUBAGENT_SYSTEM + BLUEPRINT_SCHEMA（最小 system，不含技能/工具噪音）
    const isBlueprint = req.target === 'blueprint'
    const persona = isBlueprint ? BLUEPRINT_SUBAGENT_SYSTEM : ((req as { persona?: string }).persona ?? opts.persona ?? DEFAULT_PERSONA)
    const schema = isBlueprint ? BLUEPRINT_SCHEMA : ((req as { schema?: string }).schema ?? opts.schema ?? DEFAULT_SCHEMA)
    // parent 必须是当前调用 Agent：工具执行上下文（exec.agent）优先，
    // 回退到 apply 绑定的 ownerCtx.agent（仅在插件确实在 agent scope 下 apply 时可用）。
    const parent = exec?.agent ?? ownerCtx?.agent
    if (!parent) {
      throw new Error('SubagentIntentProvider 需要调用 Agent 上下文（exec.agent / ownerCtx.agent 均不可用）：请从 Agent 会话内调用 prompt_author')
    }
    const label = `pm-author-${req.target}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const taskText = [
      persona,
      '',
      '输出 JSON Schema:',
      schema,
      '',
      `User Input (target=${req.target}):`,
      JSON.stringify(req, null, 2),
      '',
      '现在按上述 persona + schema 产出 JSON。仅输出 JSON 对象，不要任何额外文字或 markdown fence。',
    ].join('\n')

    const controller = new AbortController()
    const timeoutError = new Error(`SubagentIntentProvider 超时：未在 ${timeoutMs}ms 内收到 assistant 消息`)
    let timer: ReturnType<typeof setTimeout> | undefined

    let run: SubagentLikeRun
    try {
      run = await ownerCtx.subagents.start(provider, {
        label,
        prompt: [{ type: 'text', text: taskText }],
        parent,
        // 不指定 provider/model → resolveChildAgentOptions 继承 parent 会话 route（R1）
        signal: exec?.signal ?? controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError
      throw error
    }

    try {
      const result = await Promise.race([
        run.result,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(timeoutError)
            reject(timeoutError)
          }, timeoutMs)
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
      if (result.stopReason !== 'completed') {
        const detail = result.diagnostic === undefined ? '' : `；diagnostic: ${result.diagnostic}`
        throw new Error(`SubagentIntentProvider 子代理未完成：stopReason=${result.stopReason}${detail}`)
      }
      const text = (result.output ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (text.trim().length === 0) {
        throw new Error('SubagentIntentProvider 子代理未产出 assistant 文本')
      }

      if (opts._testOverride) {
        const o = opts._testOverride(text, req)
        if (o) return applyBlueprintClarify(o, req)
      }
      return applyBlueprintClarify(parseIntentJson(text, req), req)
    } finally {
      try {
        await run.dispose()
      } catch {
        /* 吞掉 dispose 异常 */
      }
    }
  }
}

/**
 * O13（spec §6 澄清接口 / 观察项台账）：蓝图分支读 req.clarify → 按 analyzeIntent 同款规则
 * （关键维度 = style/media/negative，见 KEY_CLARIFY_DIMS）在关键缺失时产出 clarify_questions，
 * 随 draft 完整返回给调用方（不吞不丢）。非蓝图 / clarify 非 'ask' / 无关键缺失 → 原样返回
 * （无 req.clarify 时与现状完全一致，默认不产生 clarify_questions）。
 */
function applyBlueprintClarify(draft: AuthorDraft, req: AuthorIntentRequest): AuthorDraft {
  if (req.target !== 'blueprint' || req.clarify !== 'ask') return draft
  const missing = (draft as { missing?: string[] }).missing ?? []
  const keyMissing = missing.filter((m) => KEY_CLARIFY_DIMS.includes(m))
  if (keyMissing.length === 0) return draft
  const withQuestions: AuthorDraft & { clarify_questions?: string[] } = {
    ...draft,
    clarify_questions: keyMissing.map((dim) => `缺少 <${dim}>：请选择/补充`),
  }
  return withQuestions
}

function parseIntentJson(text: string, req: AuthorIntentRequest): AuthorDraft {
  // Task 12 Step 3b：蓝图模式走 analyzer 的蓝图解析（stripFences + validateBlueprint + missing 计算）
  if (req.target === 'blueprint') {
    return parseBlueprintJson(text)
  }
  // 剥离 markdown code fence 与前后非 JSON 杂质（LLM 常见 ```json ... ``` 包裹）
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const cleaned = ((fenced && fenced[1] !== undefined) ? fenced[1] : text).trim()
  let obj: any
  try {
    obj = JSON.parse(cleaned)
  } catch (e: any) {
    throw new Error(`SubagentIntentProvider 输出非 JSON：${e?.message ?? 'parse failed'}（原始片段：${cleaned.slice(0, 200)}）`)
  }
  if (req.target === 'anima') {
    return { slots: normalizeSlots(obj?.slots) }
  }
  if (req.target === 'h3') {
    const shots: H3ShotsInput = {
      duration_seconds: Number(obj?.duration_seconds ?? 10),
      references: Array.isArray(obj?.references) ? obj.references : [],
      shots: Array.isArray(obj?.shots) ? obj.shots : [],
    } as H3ShotsInput
    return { shots }
  }
  throw new Error(`SubagentIntentProvider 未知 target：${req.target}`)
}

function normalizeSlots(raw: unknown): AnimaSlots {
  if (!raw || typeof raw !== 'object') return {} as AnimaSlots
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === 'narrative') {
      out[k] = typeof v === 'string' ? v : (Array.isArray(v) ? (v as unknown[]).map(String).join(' ') : v == null ? '' : String(v))
    } else {
      out[k] = Array.isArray(v) ? (v as unknown[]).map((x) => String(x))
        : v == null ? [] : [String(v)]
    }
  }
  return out as AnimaSlots
}

/* ── per-target persona/schema 拆分（Task 5）：语义等价拆出，DEFAULT_* 保留原值作兜底 ──
 * Round 8 T2Q（A）：ANIMA_PERSONA 重写为「锚定补全」模式——用户 brief 是锚点，LLM 只补全不重写
 * （DART/DTG/TIPO 三重背书；调研结论：Anima 是 tag+NL 混合方言，tag 预算 20-40，顺序即权重，
 * 多词自造短语响应弱）。H3 persona/schema 不动。 */

export const ANIMA_PERSONA = `角色：Anima 提示词补全器（用户 brief 是锚点，你只补全不重写）。
你的任务：根据用户创作意图，补全与 Anima 方言严格对齐的结构化 slots 与 narrative。

产出规则：
1. tag 块预算：全部槽位 tag 总数 20-40（含 count_gender）；超预算时按「场景细节 > 氛围词 > 次要动作」顺序裁剪
2. 每个 tag 必须是 danbooru 词表内规范写法：全小写、空格分隔（不用下划线）、单个可命中概念；多词自造短语禁止——拆成原子 tag（如「剑尖挑起花瓣」→ long sword + petals）或移入 narrative NL
3. 场景槽 ≤3 个高影响锚点（地点/时段/天气各取最代表），其余场景细节移入 narrative NL
4. 禁用空泛词：beautiful/amazing/gorgeous/pretty/lovely/atmosphere 等（画面信息为零）
5. narrative = 2-4 句英文自然语言场景块：只写场景氛围/光影/动作的连贯描述，禁止罗列 tag、禁止复述槽位短语
6. 顺序规范：count_gender → appearance/clothing → pose_action → expression → camera → scene → detail_mood（槽位内容按此序排列）
7. 语义级保留 user 要素（不增删指代），语言按 brief.outputLang
8. 若 refs（图片/视频/音频引用）传入：保持 ref 标签稳定（<Picture N>/<Subject N>/<Video N>/<Audio N>），不要替换
9. 字段尽量来自用户输入；缺则用最小化合理解释（不编造情节）

输出：严格按下方 JSON Schema 的 JSON 字符串，不要包含任何额外文字（不要 markdown fence，不要解释）。
`

export const H3_PERSONA = `你是一位资深的 MiniMax-H3 视频提示词工程创作者。
你的任务：根据用户的创作意图，产出与 H3 方言严格对齐的结构化输入内容。

规则：
1. 产出 H3 shots（duration_seconds + 每 shot 的 what/ambient/music/dialogue/who）
2. 若 refs（图片/视频/音频引用）传入：保持 ref 标签稳定（<Picture N>/<Subject N>/<Video N>/<Audio N>），不要替换
3. **尊重用户原始意图**：用户给的描述字符串（what/ambient 等）保持原文字面，不要为了更"通顺"而重写或编造
4. 字段尽量来自用户输入；缺则用最小化合理解释（不编造情节）

输出：严格按下方 JSON Schema 的 JSON 字符串，不要包含任何额外文字（不要 markdown fence，不要解释）。
`

export const ANIMA_SCHEMA = `{
  "slots": {
    "count_gender": ["1girl"],
    "character": ["Subject 1 from <Picture 1>"],
    "appearance": ["long hair", "blue eyes"],
    "clothing": ["red dress"],
    "pose_action": ["standing"],
    "expression": ["smile"],
    "camera": ["close-up"],
    "scene": ["sunset rooftop"],
    "detail_mood": ["cinematic"],
    "narrative": "2-4 句英文 NL 场景块（场景氛围/光影/动作的连贯描述；禁止罗列 tag），可空"
  }
}

输出规则：
- 只能输出一个 JSON 对象，不要任何前缀后缀文字
- 必须用 \`\`\`json fence 或纯 JSON；纯 JSON 优先
- 用户提供 references 时保持 ref 标签稳定
`

export const H3_SCHEMA = `{
  "duration_seconds": 10,
  "references": [],
  "shots": [
    { "what": "镜头内容", "who": "<Subject 1>", "ambient": "环境声", "music": "BGM", "dialogue": "对白或省略" }
  ]
}

输出规则：
- 只能输出一个 JSON 对象，不要任何前缀后缀文字
- 必须用 \`\`\`json fence 或纯 JSON；纯 JSON 优先
- 用户提供 references 时保持 ref 标签稳定
`

const DEFAULT_PERSONA = `你是一位资深的提示词工程创作者（Anima / MiniMax-H3 方言）。
你的任务：根据用户的创作意图与目标方言，产出与目标方言严格对齐的结构化输入内容。

规则：
1. 若 target=anima：产出 Anima slots（count_gender / character / appearance / clothing / pose_action / expression / camera / scene / detail_mood 等）与 narrative；不输出方言编译结果
2. 若 target=h3：产出 H3 shots（duration_seconds + 每 shot 的 what/ambient/music/dialogue/who）
3. 若 refs（图片/视频/音频引用）传入：保持 ref 标签稳定（<Picture N>/<Subject N>/<Video N>/<Audio N>），不要替换
4. **尊重用户原始意图**：用户给的描述字符串（narrative/what/ambient 等）保持原文字面，不要为了更"通顺"而重写或编造
5. 字段尽量来自用户输入；缺则用最小化合理解释（不编造情节）

输出：严格按下方 JSON Schema 的 JSON 字符串，不要包含任何额外文字（不要 markdown fence，不要解释）。
`

const DEFAULT_SCHEMA = `{
  "anima": {
    "slots": {
      "count_gender": ["1girl"],
      "character": ["Subject 1 from <Picture 1>"],
      "appearance": ["long hair", "blue eyes"],
      "clothing": ["red dress"],
      "pose_action": ["standing"],
      "expression": ["smile"],
      "camera": ["close-up"],
      "scene": ["sunset rooftop"],
      "detail_mood": ["cinematic"],
      "narrative": "自由文本，可空"
    }
  },
  "h3": {
    "duration_seconds": 10,
    "references": [],
    "shots": [
      { "what": "镜头内容", "who": "<Subject 1>", "ambient": "环境声", "music": "BGM", "dialogue": "对白或省略" }
    ]
  }
}

输出规则：
- 只能输出一个 JSON 对象，不要任何前缀后缀文字
- 必须用 \`\`\`json fence 或纯 JSON；纯 JSON 优先
- 用户提供 references 时保持 ref 标签稳定
`
