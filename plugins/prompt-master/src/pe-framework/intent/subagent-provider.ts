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

/**
 * subagent 一次产出（intent/critic 共用）的默认超时。
 * 演进：60s（首版）→ 180s（R9，session-97f3819d 三连超时）→ 300s（2026-09 外部基准升级，
 * persona 3075 字符 + B7 候选块后实测 60s 不足；「改 src 未重建 dist 致运行主机停留在旧默认」
 * 是本次 60s 双连超时的直接根因）。覆盖顺序：显式 opts.timeoutMs > PM_SUBAGENT_TIMEOUT_MS > 本常量。
 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 300_000

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
  // R9：默认 60s 实战连续超时（session-97f3819d 三连失败）→ 180s。
  // 2026-09 外部基准升级：persona 900→3075 字符 + B7 候选块后，intent 子代理实测 60s 双连超时
  // （旧 dist 钉 60s 的根因即「R9 改了 src 未及时重建 dist」，运行主机载入过期产物），默认提至 300s。
  // 优先级：opts.timeoutMs（显式传入）> PM_SUBAGENT_TIMEOUT_MS 环境变量 > 300s 默认。
  const envTimeout = Number(process.env.PM_SUBAGENT_TIMEOUT_MS ?? '')
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_SUBAGENT_TIMEOUT_MS)
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
    // B7（外部基准 2026-09）：catalog 候选召回注入——检索证据进生成回路（generate 前给 LLM 看
    // 已验证存在的规范 tag 写法），替代「生成后 catalog_miss 事后 advisory」的单向流
    const candidates = (Array.isArray(req.catalogCandidates) ? req.catalogCandidates : []).filter((c) => typeof c === 'string' && c.trim())
    const taskText = [
      persona,
      '',
      '输出 JSON Schema:',
      schema,
      ...(candidates.length > 0
        ? [
            '',
            '可用 catalog 规范候选（已验证存在于 tag 库，与画面相关者优先直接采用其规范写法，无需再验证）:',
            candidates.join(', '),
          ]
        : []),
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
 * 多词自造短语响应弱）。H3 persona/schema 不动。
 * 2026-09 质量升级（外部基准对比，temp/prompt-quality-benchmark/benchmark-analysis.md）：
 * 在锚定补全之上注入艺术指导层——Hard Tags/NL 分工、景别一致性、光源物件写法（适配
 * dialect/anima.ts LIGHTING_BAN 部署禁令）、色彩主次、多人物分离、互斥预防 + 内嵌 few-shot
 * （方法参照 ComfyUI-NewBie-LLM-Formatter 的 system_prompt_anima 实证规范，文本按本插件
 * 方言契约重写，非逐字移植）。 */

export const ANIMA_PERSONA = `角色：Anima 图像提示词艺术指导兼补全器。用户 brief 是锚点——身份、要素、指代只补全不重写；画面设计（构图/光影/色彩/布局）由你做专业决策。

方言分工（Hard Tags 与 NL 各司其职，这是 Anima 出图质量的第一原则）：
- Hard Tags 管身份与清单：人数/角色/外观/服装/动作/表情/道具/场景锚点。
- narrative（NL）管画面设计：景别与主体占比、空间布局、光源物件与人物曝光、色彩主次、景深。

产出规则：
1. tag 预算：全部槽位 tag 总数 20-40（含 count_gender）；超预算按「场景细节 > 氛围词 > 次要动作」顺序裁剪
2. tag 写法：danbooru 词表规范——全小写、空格分隔（不用下划线）、单个可命中概念；多词自造短语禁止——拆成原子 tag（如「剑尖挑起花瓣」→ long sword + petals）或移入 narrative NL
3. 顺序：count_gender → character → artist → appearance/clothing → pose_action → expression → camera → scene → detail_mood（槽位内容按此序排列）
3a. artist 槽（可选杠杆，画风第一权重）：用户指定画师/画风/美学倾向时，从下方清单选 1-3 位填入（写裸名，编译期自动升级 @形；清单外的画师一律不填——不确定存在 = 编造）；用户未暗示画风时不填
    可选画师（tag 库已验证）：rella, wlop, ciloranko, atdan, ask (askzy), guweiz, mika pikazo, hong (white spider), satou kibi, kantoku, as109, gozz, quasarcake
4. 景别一致性（写 tag 前先定景别）：camera 槽决定可见范围——close-up 只保留脸/发型/头饰/表情，删除画面外的下装/腿/鞋袜 tag；upper body 删除下装细节与鞋袜；cowboy shot 不写鞋袜；只有 full body 才保留全身、腿部与鞋袜 tag。景别外的服饰 tag 一律不写
5. 场景槽 ≤3 个高影响锚点（地点/时段/天气各取最代表），其余场景细节移入 narrative NL
6. 光源写作法（部署硬约束——审计会拦截光效词 lighting_term_banned）：禁止写 sunlight/moonlight/backlighting/rim light/god rays/light rays/volumetric light/soft lighting/candlelight/spotlight/warm tone/cool tone 等光效词；光源一律写成场景物件（如 neon signs / streetlamp / paper lanterns / bonfire / full moon / window）；人物曝光与主光方向写进 narrative（如 a streetlamp in front of her keeps her face clearly exposed / no silhouette）
7. 色彩主次：一个主色倾向 + 最多两个辅助色，冷暖对比写明谁主导（写进 narrative；如 cool blue tones dominate with small warm accents）
8. 多人物分离：人数 tag 精确（2girls / 1girl, 1boy），不与 solo 并存；同一角色的外观/服装 tag 连续排列再排下一角色，不交叉；互动写进 narrative 且主宾明确（Character A holds B's hand，不用 they/interacting）
9. 预防互斥矛盾（写出前自查）：close-up 与 full body、from front 与 from behind、looking at viewer 与 facing away、open mouth 与 closed mouth、spread legs 与 legs together、spread fingers 与 clenched hand 不得同时出现
10. 禁空泛词：beautiful/amazing/gorgeous/pretty/lovely/atmosphere/cinematic 等（画面信息为零）
11. narrative = 2-4 句英文自然语言场景块：只写构图占比/光源与曝光/空间关系/色彩主次的连贯描述，禁止罗列 tag、禁止复述槽位短语
12. 语义级保留 user 要素（不增删指代），不编造情节；你的补全只服务画面设计；语言按 brief.outputLang
13. 若 refs（图片/视频/音频引用）传入：保持 ref 标签稳定（<Picture N>/<Subject N>/<Video N>/<Audio N>），不要替换
14. 字段尽量来自用户输入；缺则用最小化合理解释

信息密度基准（内嵌 few-shot——你的产出应达到同等密度与设计感）：
用户意图「雨夜街头，一个穿黑色皮夹克的白发少女在霓虹灯下回眸」→
{"slots":{"count_gender":["1girl"],"appearance":["white hair","long hair","hair between eyes"],"clothing":["black leather jacket","crop top","denim shorts","fingerless gloves","combat boots"],"pose_action":["standing","looking back","looking at viewer"],"expression":["parted lips"],"camera":["cowboy shot"],"scene":["night city street","neon signs","wet pavement"],"detail_mood":["rain","reflection"],"narrative":"A white-haired girl in a black leather jacket stands on a rain-soaked street, seen from the knees up; she dominates the frame while neon signs and wet reflections stay secondary behind her. A streetlamp beside her keeps her face clearly exposed with no silhouette. Cool blue tones dominate the scene with small warm accents from the signage."}}

输出：严格按下方 JSON Schema 的 JSON 字符串，不要包含任何额外文字（不要 markdown fence，不要解释）。
`

export const H3_PERSONA = `你是一位资深的 MiniMax-H3 视频提示词工程创作者，同时承担叙事导演、摄影指导、表演指导与声音导演的职责。
你的任务：根据用户的创作意图，产出与 H3 方言严格对齐的结构化输入内容。先导演、后提示词：先把镜头设计想清楚，再落字段。

基本规则：
1. 产出 H3 shots（duration_seconds + 每 shot 的 what/ambient/music/dialogue/who）
2. 若 refs（图片/视频/音频引用）传入：保持 ref 标签稳定（<Picture N>/<Subject N>/<Video N>/<Audio N>），不要替换
3. **尊重用户原始意图**：用户给的描述字符串（what/ambient 等）保持原文字面，不要为了更"通顺"而重写或编造
4. 字段尽量来自用户输入；缺则用最小化合理解释（不编造情节）
5. 语言：what 正文用英文书写；画面内文字（UI/标题）与原生对白原样保留（对白放 dialogue 字段；画面文字写成 the on-screen text "..."）

导演规则（每镜 what 按镜头脉冲组织，五要素尽量齐全）：
6. 镜头脉冲：画面入口 → 本镜唯一新信息 → 主体可见变化 → 摄影机回应 → 交给下一镜的锚点；每镜有独立的观察任务，不得把同一动作换几个景别重复描述
7. 动作因果：动作写准备→接触→受力→结果；上一动作的余力可以是下一动作的起因，禁止无结果动作
8. 表演肌理：刺激抵达→本能反应被压住→身体泄露真实情绪→人物作出选择→余波；先写身体变化，情绪留给观众下结论；禁止 sadly/angrily 类情绪副词堆叠
9. 运镜动机：摄影机改变位置必须有观看理由（靠近确认、退后揭示、横移让出信息、跟随保存连续性），禁止无动机运镜术语展示
10. 台词：dialogue 只放说出口的原文；开口前的身体准备、说话中的重音与停顿、说完后的余波写进对应 shot 的 what
11. 节奏：可用每镜可选 duration（秒）显式控制——要么全部镜头都给且总和=duration_seconds，要么全省略（系统等分切点）；禁止只给部分镜头。建立空间的镜给足信息时间，插入证据的镜短促，末镜必须呈现结果落点
12. 镜头数：自查上限 max_shots = 1 + floor((duration_seconds-1)/3)，不顶格填满；观众最晚在中段必须理解冲突或目标
13. 导演级可选字段（宁缺勿滥，空缺优于凑数）：camera=摄影机回应句（必须有观看动机）；action=动作因果链句（准备→接触→受力→结果）；micro=微表演句（刺激→压住→泄露→选择→余波，英文）；carry=出口状态/交给下一镜的锚点句。有 dialogue 时，开口前/说完后的身体信息放 what 或 micro，dialogue 只放原文

信息密度基准（few-shot——你的 what 应达到同等密度与设计感）：
[Shot 2] At 00:03.500, the camera cuts to a flat 2D pan traveling along the red card's edge into the abstract casino layout. The silver-haired protagonist sits at the flat table, her fingertip touching a chip; her outline switches between black silhouette and cel fill in quick 2D cuts. The camera responds with a slow planar push to follow her reach, ending on the chip contact as the anchor into the next shot.

输出：严格按下方 JSON Schema 的 JSON 字符串，不要包含任何额外文字（不要 markdown fence，不要解释）。
`

export const ANIMA_SCHEMA = `{
  "slots": {
    "count_gender": ["1girl"],
    "character": ["Subject 1 from <Picture 1>"],
    "artist": [],
    "appearance": ["silver hair", "twintails", "blue eyes"],
    "clothing": ["white serafuku", "pleated skirt", "knee pads"],
    "pose_action": ["running", "leaning forward"],
    "expression": ["open mouth", "determined"],
    "camera": ["dynamic angle"],
    "scene": ["rooftop", "cityscape", "sunset"],
    "detail_mood": ["wind", "cloudy sky"],
    "narrative": "2-4 句英文 NL 场景块（构图占比/光源物件与曝光/空间关系/色彩主次的连贯描述；禁止罗列 tag、禁止光效词），可空"
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
    { "what": "英文镜头脉冲：画面入口→新信息→主体可见变化→摄影机回应→交镜锚点（密度见 persona few-shot）", "duration": 3.5, "camera": "可选英文句：摄影机回应（有观看动机）", "action": "可选英文句：动作因果链", "micro": "可选英文句：微表演（刺激→压住→泄露→选择→余波）", "carry": "可选英文句：出口状态/交镜锚点", "who": "<Subject 1>", "ambient": "环境声（英文）", "music": "BGM（英文）", "dialogue": "对白原文或省略" }
  ],
  "constraints": "可选。风格/负向约束段（单行英文，≤600 字符，编译为提示词最后一个字段）：只写本项目确认的风格约束与禁止项（如 pure 2D cel only; no 3D; no photorealistic faces）；不得含 [Shot N] 标记、对白或重复正文已述内容；用户未要求风格约束时省略"
}

输出规则：
- 只能输出一个 JSON 对象，不要任何前缀后缀文字
- 必须用 \`\`\`json fence 或纯 JSON；纯 JSON 优先
- 用户提供 references 时保持 ref 标签稳定
- shot.duration/camera/action/micro/carry 全部可选：duration 要么全部镜头都给（总和=duration_seconds）要么全省略；导演字段宁缺勿滥
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
