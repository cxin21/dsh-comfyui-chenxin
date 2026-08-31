# 保真粒度契约（fidelity contract）

> PE-Framework P1（H3）双跑保真：TS 归化只对下列承诺字段做**逐字节/记录级相等**；
> 其余为投影或放弃（对抗审查 B5 处置 + spec §8/§9）。golden 由官方 Python CLI
> （`minimax-h3-prompt.exe author --stage <stage> --request <story> --tokenizer-dir <knowledge> --json`）一次性生成，
> 之后 TS 只与 golden 对比，不依赖运行时 Python。

## ① 提示词文本：逐字节一致

- 保真对象：`result.text`（可执行英文 H3 prompt）与 `result.text_zh`（中文骨架）——TS dialect 渲染输出必须与 golden 的 `result.text` 逐字节相等。
- `result.text_zh_meta` 为元数据，投影（不参与逐字节比较），但 `text_zh` 本体保真。
- 断言方式：`assertGolden(actualEnvelope, name)` 对 `{ok, command, stage, result.text, result.text_zh, findings, assumptions, errors.custom?, budget.{text_tokens,char_count,char_limit,quality_cap,effective_cap,over,token_over,char_over}}` 做 JSON 深比较（白名单字段，见 ②）。

## ② budget 投影：只复刻官方上下文帧驱动的确定性字段

Python budget 的 20+ 原始字段**不全搬**。投影映射表（保真 ↔ 投影 ↔ 放弃）：

| 字段 | 处置 | 说明 |
|---|---|---|
| `text_tokens` / `char_count` / `char_limit` / `quality_cap` / `effective_cap` / `over` / `token_over` / `char_over` | **保真** | 确定性预算判定（token 数/上限/over），TS 必须逐一复刻 |
| `verified` / `snapshot_id` / `model_id` / `model_hard_limit` / `reference_count` / `video_count` / `audio_count` / `visual_tokens` / `chat_template_tokens` / `available_tokens` | 放弃 | 上下文帧内部量/环境快照，非提示词可执行面 |
| `mode` / `stage` | 保真 | 路由回显 |
| P1 envelope 外层 `ok` / `command` / `errors[].code` / `advisories` | 保真 | 收敛闭环契约 |

tokenizer 归化（T11）的计数单元 = **官方上下文帧（含 vision pads）**；T11 起对 `text_tokens` 采样逐 token 断言。

## ③ tokenizer：官方上下文帧

- 计数单元 = `knowledge/tokenizer.json` + `chat_template.json` 定义的官方上下文帧（含图片 vision pads 配额）。
- 归化后（T11）`Budget.counter: 'official-tokenizer'`；未归化期间 TS 仅投影 golden 数值（`'estimate'` 不用于 H3）。

## ④ catalog（T8，Anima 侧）：记录集相等

- `record_id` / `prompt_form` / `usage_count` 全字段比较（记录集相等），不做投射。

## Golden 资产与完整性

- 存放：`tests/fidelity/golden/<name>.json`，格式 `{ name, input, inputPlan?, pythonOutput, sha256 }`；
  `sha256 = sha256(JSON.stringify(pythonOutput))`（M5 防篡改），由 `golden-integrity.test.ts` 持续校验。
- 生成命令（沙箱内可用——PowerShell 自身管道不受 Node spawn 限制影响）：
  `& <preset>\.venv\Scripts\minimax-h3-prompt.exe author --stage <stage> --request <fixture> [--plan <plan>] --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge --json`
- 已知失败样例：`fl2va-multishot`（SKILL.md 官方 Example 7 缺图片引用 → `validation_failed: fl2va requires at least one picture reference`）作为**预期失败 golden** 固化（审计闸门行为保真）。

## Fixture 来源声明

`tests/fidelity/fixtures/h3/*.json` 全部逐字抄自官方 skill `minimax-h3-prompt/SKILL.md` 的 Examples 1-7
（t2va 单/多镜头、i2va、fl2va、ref2va 单/三引用+视频源、fl2va multishot plan）——真实官方样本，行号见
`task-5-report.md`。会话历史中真实跑过的 story JSON（如 `story_duel.json`）在会话后被清理（见报告 §fixture 来源），
如需要更丰富的真实样本可待后续会话回填。