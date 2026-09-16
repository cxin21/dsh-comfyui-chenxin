/**
 * S3 成文引擎（spec 2026-09-17 agentic-pipeline-redesign §3，A1/A2）：
 * 把语义蓝图翻译为最终 prompt 的 tag 区与 NL 尾。
 * tag 形式合法性由 writer 用 catalog_search 工具现场查字典验证（A2）——
 * 检索包证据层已废除（A1）；未验证形式由机审 fabricated_tag（catalog 直查）兜底拦截。
 * 本模块只做 persona/prompt 装配与输出契约解析；机器审计在 audit.ts。
 */
import { buildTaskText } from '../llm/task-text.js';
import { extractFirstJsonObject } from '../llm/json-extract.js';
import type { SemanticBlueprint } from '../blueprint/semantic-schema.js';

/** task_persona 块：角色定位 + few-shot（同构即模板）；硬性规则在 WRITER_RULES（§2.1 拆分） */
export const WRITER_PERSONA = `角色：你是 Anima 提示词成文引擎。输入 = 画面语义蓝图 v1。你把蓝图翻译为最终提示词的 tag 区与 NL 尾。
你有一个工具：catalog_search（tag 字典查询）。tag 区的一切形式必须先经字典验证。

【工具协议】
- 对每个准备进 tag 区的概念，先调用 catalog_search（{"tag":"<英文短语>","mode":"auto","limit":5}）。
- 只采用返回 hits[] 中 match_type 为 canonical 或 alias 的 prompt_form（原样，不改单复数/下划线）。
- 查不到 canonical/alias 的概念：换更简单的英文说法再查一次；仍查不到 → 该概念不进 tag 区（写进 NL 尾）。
- artist：仅当蓝图 style_hints 有明确画风暗示，用 "@画师名" 形式查询验证后取 1-3 位。
- 工具调用预算 ≤20 次；高频常识 tag（1girl、long hair 等）无需逐个验证。

【信息密度基准（few-shot——示例的结构/粒度/句数即目标形态）】
例 1（单人雨夜霓虹；查不到的概念进 NL）：
<blueprint_v1>
{"schema_version":1,"media":"image","core":{"concept":"a white-haired girl glances back under neon lights on a rain-soaked night street","scene":{"environment":"night city street","time_of_day":"night","weather":"rain","lighting_idea":"neon signage glows from both sides"},"style_hints":[]},"subjects":[{"id":"S1","count":1,"identity":"a girl","appearance":"white hair, black leather jacket","pose":"standing, looking back","expression":"parted lips"}],"composition":{"framing":"seen from the knees up","camera_angle":"slightly low","placement":"right of center"},"mood":"nocturnal, confident","negative_hints":["no modern vehicles"]}
</blueprint_v1>
输出（假设工具验证了 white hair / black leather jacket / looking back / cowboy shot；"neon signage glows from both sides" 无 canonical）：
{"tags":[{"text":"1girl","source_concept":"S1.count"},{"text":"solo","source_concept":"S1.count"},{"text":"white hair","source_concept":"S1.appearance"},{"text":"black leather jacket","source_concept":"S1.appearance"},{"text":"standing","source_concept":"S1.pose"},{"text":"looking back","source_concept":"S1.pose"},{"text":"parted lips","source_concept":"S1.expression"},{"text":"cowboy shot","source_concept":"composition.framing"},{"text":"from below","source_concept":"composition.camera_angle"},{"text":"night","source_concept":"core.scene.time_of_day"},{"text":"rain","source_concept":"core.scene.weather"},{"text":"neon lights","source_concept":"core.scene.environment"}],"nl":"She stands on the right of center while neon signage glows from both sides behind her. Wet street reflections stay secondary on the ground. Signboard glow keeps her face clearly exposed with no silhouette.","negative":["no modern vehicles"]}`;

/** task_rules 块：硬性规则谓词（T=tag 区 / N=NL 尾 / negative 契约） */
export const WRITER_RULES = `【tag 区规则（硬性）】
T1. tag 只能采用工具查询返回的 canonical/alias prompt_form——禁止自造、禁止拼接、禁止变换单复数/下划线。工具查不到的概念不进 tag 区（出口：写进 NL 尾）。
T2. 每个 tag 必须在 output.tags[] 中携带 source_concept 字段，指回它服务的蓝图概念路径（如 "S1.appearance"）。无 source_concept 的 tag = 违规。
T3. 顺序（即权重序——这是训练分布事实，不是风格偏好）：人数 → 主体身份锚 → artist → 外观/服装 → 动作 → 表情 → 景别/视角 → 场景锚点 → 氛围。
T4. artist：仅当 core.style_hints 有明确画风暗示且经工具验证，取 1-3 位 prompt_form 原样；否则不输出 artist tag。
T5. 景别一致性：选定唯一景别后，取景外元素不进 tag（close-up 无下装鞋袜；cowboy shot 无鞋袜；仅 full body 保留全身）。
T6. 互斥对：互斥词对（如 solo/1boy、open mouth/closed mouth、from front/from behind）不得同时出现在 tag 区。
T7. 总量：tag 数 20-40。验证不足 20 个时如实输出，不得编造凑数；超限按 场景锚点 > 氛围 > 次要动作 顺序裁剪。

【NL 尾规则（硬性）】
N2. NL 尾承担且仅承担四类信息：①构图占比与视线引导 ②光源物件与人物曝光（物件名 + no silhouette 写法）③查不到 tag 的概念 ④色彩主次。
N3. NL 尾不得复述 tag 区任何已表达概念——判定标准：若删去该句，某个 tag 的信息完全丢失，则该句是复述；若删去后仍有信息增量（关系/曝光/比例/层级），则允许。
N4. NL 长度 2-4 句英文。
N5. 禁止出现 sunlight/moonlight/rim light/god rays 等光效词——光源一律写场景物件（neon signs / streetlamp / paper lanterns）。

【negative 契约】只产内容性排除（蓝图 negative_hints 的英文翻译，≤3 条）；质量词/分级词由系统确定性拼装，你不得输出 worst quality/low quality/score_* 等质量词、不得输出 child/loli 等分级词。`;

const WRITER_OUTPUT_CONTRACT = `仅输出一个 JSON 对象（裸 JSON：无 markdown fence、无解释、无任何前后缀文字）：
{"tags":[{"text":"…","source_concept":"…"}…],"nl":"…2-4 句英文…","negative":["…"]}`;

export interface WriterTag {
  text: string;
  source_concept: string;
}

export interface WriterOutput {
  tags: WriterTag[];
  nl: string;
  negative: string[];
  dropped_concepts?: string[];
}

/** 禁止 LLM 输出的 negative 词（质量词/分级词——系统确定性拼装，spec §6 negative 契约） */
const FORBIDDEN_NEGATIVE_RE =
  /(^|[\s,])(worst quality|low quality|best quality|score_\d|masterpiece|child|loli|shota|toddler|kid|preteen)(?=$|[\s,])/i;

export function buildWriterPrompt(bp: SemanticBlueprint, opts: { feedback?: string } = {}): string {
  const rules: string[] = [WRITER_RULES];
  if (opts.feedback) {
    rules.push(`【修复反馈（硬性）】\n${opts.feedback}\n逐条执行 requiredFix；未被点名的部分保持原样。`);
  }
  return buildTaskText([
    { tag: 'task_persona', body: WRITER_PERSONA },
    { tag: 'blueprint_v1', body: JSON.stringify(bp, null, 2) },
    { tag: 'rules', body: rules.join('\n\n') },
    { tag: 'output_contract', body: WRITER_OUTPUT_CONTRACT },
  ]);
}

/** 输出契约解析（宽松 JSON 提取沿管线惯例）；契约违规即抛错（错误文案进修复 feedback） */
export function parseWriterOutput(raw: string): WriterOutput {
  const body = extractFirstJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(
      `writer 输出非 JSON：${(e as Error)?.message ?? 'parse failed'}（原始片段：${body.slice(0, 200)}）`,
    );
  }
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o.tags)) throw new Error('writer 契约违规：tags 必须为数组');
  const tags: WriterTag[] = [];
  for (const t of o.tags as unknown[]) {
    if (t === null || typeof t !== 'object') throw new Error('writer 契约违规：tag 项必须为对象');
    const tag = t as Record<string, unknown>;
    if (typeof tag.text !== 'string' || tag.text.trim() === '') throw new Error('writer 契约违规：tag.text 缺失/为空');
    if (typeof tag.source_concept !== 'string' || tag.source_concept.trim() === '') {
      throw new Error(`writer 契约违规：tag "${tag.text}" 缺 source_concept（T2）`);
    }
    tags.push({ text: tag.text, source_concept: tag.source_concept });
  }
  if (typeof o.nl !== 'string') throw new Error('writer 契约违规：nl 必须为字符串');
  const negative = Array.isArray(o.negative)
    ? (o.negative as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const badNegative = negative.find((n) => FORBIDDEN_NEGATIVE_RE.test(n));
  if (badNegative !== undefined) {
    throw new Error(
      `writer 契约违规：negative 含质量词/分级词 "${badNegative}"（negative 契约：质量词/分级词由系统拼装）`,
    );
  }
  const dropped = Array.isArray(o.dropped_concepts)
    ? (o.dropped_concepts as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return { tags, nl: o.nl, negative, ...(dropped.length > 0 ? { dropped_concepts: dropped } : {}) };
}
