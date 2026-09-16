# 2026-09-12 镜头语言调研 + 外部基准二次对比（用户实测质量差的根因）

> 起因：用户在真实会话中连续两次用 `prompt_author (target=anima)` 出稿（古风美女舞剑），
> 反馈「质量差、没有美学和设计感」，并给出 4 个外部仓库要求对比学习，另要求调研
> 「扩写提示词时怎么设计场景、人物站位等镜头语言」。
> 本文档是对 `2026-09-11-external-benchmark-quality-upgrade.md` 的实测复核 + 镜头语言方法论。

## TL;DR

1. **A–D 期质量升级代码已落地，但在真实会话里从未运行过。** P0 bug：
   enrich / judge 共用的 `createSubagentCriticProvider` 调 `subagents.start` 时**不传 `parent`**，
   host 侧解析子代理直接崩（`Cannot read properties of undefined (reading 'options')`），
   每次调用都静默降级（`enrich_skipped` + `judge_skipped`）。用户看到的一直是
   「intent 单层降级路径」的产出——再好的 persona/卡片库也没上场。
2. 四仓库的核心优势与 9-11 文档结论一致，本次逐条复核属实；
   NewBie 的 `system_prompt_anima`（≈5000 字）仍是四家里最完整的 Anima 规范文本。
3. 镜头语言方法论见 §4：**一个瞬间 + 五个设计决策**（景别/站位/光源/色彩/动势），
   每条都给了 Anima 方言的落地形态（tag 或 NL 句式），并适配本部署的 LIGHTING_BAN。
4. §5 给出用该框架手写的「舞剑 v3」示例，`prompt_audit` 全绿，可直接作为
   「质量层修复前」的手动高质路径。

---

## 1. 四仓库复核结论（对照 9-11 文档，逐条属实）

| 仓库                                | 定位                                                                      | 本次复核补充                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DanbooruSearchOnline (226★)         | 证据层：4 维语义检索 + alias 归一 + **共现 NPMI 关联推荐 + 画师共现推荐** | 「关联推荐」沿真实共现图补全用户想不到的细节——这是「有画面感」 tag 的来源；我们的 catalog 是纯词典（无共现统计），relations overlay 未启用（`catalog_search` 实测返回 `overlay_unavailable`）                                                                                                                 |
| ComfyUI-NewBie-LLM-Formatter (107★) | 规范层 + Agent 检索循环（Low/Medium/High 最多 8–10 轮边搜边写）           | 已取到 `LPF_config.json.example` 里的 `system_prompt_anima` 全文，要点全部属实：Hard Tags/NL 职责分工、景别×主体占比分离（65–85%/45–65%/25–45%）、景别一致性裁剪、光照公式、色彩主次（1 主 + ≤2 辅）、多人物分离 11 规则、冲突清单、标签预算分档（16–30/22–38/30–48）、最终自检 11 条、`## 中文解释` 设计说明 |
| SD-Anima-Prompt-Studio (105★)       | 策展层：12+ 类别 + 互斥防护                                               | 纯静态 UI，无 LLM；价值=人工策展词表 + 冲突规则，已被我们 A4/A5（互斥 12 对 + framing gate）覆盖大半                                                                                                                                                                                                          |
| ComfyUI-Animagine-Prompt (16★)      | 结构层：Animagine-XL-4.0 官方模板 + CSV 角色一致性                        | year/rating 分组是 Animagine 4.0 专属玩法，与 Anima 无关，不迁移                                                                                                                                                                                                                                              |

**可迁移规律的优先级不变**（规范文本 > 证据进回路 > 画师杠杆 > 设计说明 > 冲突进代码），
9-11 的 A–D 期已按此落地。真正的问题不在「没学」，在「学了没跑」。

## 2. P0：质量层（enrich + judge）在真实会话从未运行

### 证据链（本会话两次真实调用）

两次 `prompt_author` 的 envelope 均为：

```
advisories: ["judge_skipped", "enrich_skipped"]
judge.skipped.reason = "critic_error:Cannot read properties of undefined (reading 'options')"
enrichment.skipped.reason = "enrich_llm_error"
```

而 intent 子代理正常执行（141s / 113s），说明 subagent seam 本身可用。

### 源码对照（根因定位）

- `intent/subagent-provider.ts` L126-132（**可用**）：

  ```ts
  run = await ownerCtx.subagents.start(provider, {
    label, prompt: [...],
    parent,                    // ← exec?.agent ?? ownerCtx?.agent，L93
    signal: exec?.signal ?? controller.signal,
  })
  ```

- `eval/critic.ts` L465-469（**崩**）：enrich 与 judge 共用
  （`prompt-author.ts` L719 enrichProvider、L759 criticProvider 都来自 `createProductionCriticProvider(ctx)`）：

  ```ts
  run = await ownerCtx.subagents.start(providerName, {
    label: `pm-critic-...`,
    prompt: [{ type: 'text', text: taskText }],
    signal: controller.signal,
    // ← 没有 parent 字段
  });
  ```

host 侧装配子代理读取 `parent.options`（`llm/route.ts` L14 的 `exec.agent?.options` 是安全读，
崩点在 host 的 child-agent 装配路径，非插件 src）→ `parent` 为 undefined → TypeError →
runEnrich/judgeReview 按降级铁律 catch 成 skipped。

### 影响

- enrich 不跑 → 艺术指导卡片（perspective/composition/lighting/color/motion 36 张）、
  七维度 brief、风格库、B7 catalog 候选召回全链路失效。
- judge 不跑 → 7 维 rubric（composition/lighting-color/aesthetic-vocabulary）无评审。
- **用户在真实会话里看到的永远是降级稿**；「正确但平庸」的评价完全符合降级路径的预期产出。

### 修复方向（P0，实施时遵守插件 AGENTS.md：改 src → npm run build → vitest）

1. `createSubagentCriticProvider` 增加 parent 解析：与 intent 同款
   `exec?.agent ?? ownerCtx?.agent`——需要把调用时的 `exec` 线穿进
   `prompt-author.ts` L719/L759 的 provider 装配（当前只在定义时绑 ctx）。
2. 回归验证：本环境跑一次 `prompt_author`，断言 advisories 不含
   `enrich_skipped`/`judge_skipped`。
3. 补一条 e2e 测试钉死「provider 请求体必须含 parent」。

## 3. 次级差距（修 P0 之外仍值得做）

| #   | 差距                                              | 现状                                           | 修法                                                                                                                           |
| --- | ------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 无共现证据（DanbooruSearchOnline 的「关联推荐」） | catalog 纯词典 + relations overlay 未启用      | overlay 需真实统计源（cooccurrence 关系拒收 LLM 提案）；可从 Danbooru 公开数据灌共现对，或接 DanbooruSearch MCP 作为外部证据源 |
| 2   | art-direction 卡片只有 LIGHTING_BAN 一致性约束    | 36 张卡、每类至多 1 张，舞剑类 motion 卡已内置 | 卡片选择目前是 enrich LLM 的自由决策；可在 `clarify=ask` 的澄清问题里让用户/agent 显式选卡（P1）                               |
| 3   | catalog 无 usage 加权的画师推荐                   | 13 位画师白名单（persona 内）                  | 共现数据落地后顺带解决                                                                                                         |

## 4. 镜头语言方法论：扩写提示词时的场景与人物站位设计

> 综合来源：NewBie `system_prompt_anima` 全文、本插件 art-direction 卡片库、
> ANIMA_PERSONA（2026-09 A1 版）、影视摄影通用语言（staging/blocking/depth staging）。
> 每条都标注 Anima 落地形态；本部署的光效词禁令（LIGHTING_BAN）已适配。

### 4.0 前提：只写「一个可见瞬间」

有剧情时选动作的**峰值帧**（peak action：剑势最满、衣袂最展、花瓣最散的那一帧），
不描述连续过程。动作、视线、道具接触、环境关系必须过物理逻辑检查。
（NewBie：「有剧情时，只选择一个可见瞬间，不描述连续事件」）

### 4.1 决策一：景别与主体占比（分离决策，各自落地）

- **景别**管可见范围 → Hard Tag：`close-up / upper body / cowboy shot / full body`。
- **主体占比**管人物多大 → NL 句：`dominates the frame` / `occupies about two-thirds of the frame height`。
- 数字基准（NewBie 实证）：人物主导 65–85% 画面高 / 人景平衡 45–65% / 环境主导 25–45%。
- **实证行为**：`full body` 只保证身体完整可见，不保证人物大；背景 NL 过多会把镜头拉远——
  所以占比必须显式写，不能指望 tag。
- **景别一致性裁剪**（tag 层硬规则，audit 已有 `framing_tag_mismatch` gate）：
  close-up 删下装/腿/鞋袜；cowboy shot 删鞋袜；只有 full body 保留全身。
- 落地 NL 句式：`A ... fills the frame in a full-body side view, her figure occupying about
two-thirds of the frame height slightly right of center, while ... stay secondary behind her.`

### 4.2 决策二：站位与视线（blocking）

- **屏幕方位**：人物放三分位/黄金位（`off-center placement`），写明
  `slightly right of center` / `on the left side of the image`——用画面方位，不用角色自身左右。
- **朝向**：人物朝向与镜头轴线的夹角决定叙事感。正脸=肖像感、45°（three-quarter view）=
  自然人像、90°（from side）=剪影与动势、背身（from behind）=悬念。舞剑类选侧位+回身，
  配 `looking back at viewer` 制造张力。
- **视线**：有动作对象时视线服从动作（盯剑尖、看花瓣）；无对象可默认看观众
  （`looking at viewer`）。禁止 `looking at viewer` 与 `facing away` 并存（互斥清单）。
- **引导线与纵深**：用环境元素（回廊、石板缝、灯笼串）做 leading lines，把视线引向人物：
  NL 写 `the corridor's columns lead the eye to her`。
- **多层人物**（多人时）：人数 tag 精确 → 每角色独立锚定句（方位+身份+代表性特征）→
  互动句明确主宾（`A holds B's right hand`，不用 they/interacting）。tag 按角色分组不交叉。

### 4.3 决策三：光源与曝光（本部署：光源写作物）

- LIGHTING_BAN 禁光效词（sunlight/moonlight/rim light/soft lighting/candlelight/warm tone…）。
  **光源一律写成场景物件**：`paper lanterns`（catalog 已验证：record 900427）、
  `neon signs` / `streetlamp` / `bonfire` / `window` / `full moon`。
- **曝光责任**：物件只负责「存在」，人物亮不亮必须 NL 显式写：
  `Paper lanterns under the eaves keep her face and shoulders clearly exposed with no silhouette.`
- 背光/夜景防意外剪影：明写 `no silhouette` / `visible facial features`。
- 光的方向写进 NL（`in front of her` / `from the left`），tag 层不写。

### 4.4 决策四：色彩主次（色彩脚本）

- 一个主色倾向 + ≤2 辅助色，冷暖必须写明谁主导：
  `Cool blue night tones dominate the courtyard, with the red gauze dress and the warm lantern glow as the main accents.`
- 高饱和背景不得压过人物肤色/服装——主色给环境，强调色给人物主体（红裙、剑光）。
- 禁止堆叠互相竞争的调色词。

### 4.5 决策五：动势设计（动作场面的专用层）

| 手段          | 落地                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------- |
| 峰值定格      | NL：`caught mid-turn` / `frozen at the peak of the sweep`                                          |
| 布料/发丝     | tag：`floating hair` + `wide sleeves`；NL：`her long hair and wide sleeves whirl through the turn` |
| 武器轨迹      | 卡片 `weapon_trail`：`sword trail` / `gleaming blade`（NL 或 tag，需 catalog 验证后用）            |
| 粒子/环境响应 | `falling petals` + `wind`；花瓣要和剑势呼应（`petals scatter ... around her leading foot`）        |
| 空间呼应      | 动势方向与站位朝向一致：剑指向画面空侧（负空间），衣袂甩向画框边缘                                 |

### 4.6 空间三层与前景禁令

- 前景/中景/背景各司其职：前景只做引导（石板、花瓣），**不得遮挡脸/手/主要动作**；
  无要求不自动加前景遮挡、暗角、隧道构图。
- 背景：一个主要锚点（`courtyard` + 回廊），高亮元素（月亮、灯笼）不得抢人物；
  背景保持次要 ≠ 缺失/纯色/整体虚化。

### 4.7 输出前自检（合并 NewBie 11 条，压缩为 8 条）

1. 只有一个明确景别？景别与 tag 集一致（取景外 tag 已删）？
2. 主体占比与画面主次写了吗？
3. 光源是物件吗？人物曝光明确吗（夜景/背光防剪影）？
4. 色彩有主次吗（1 主 + ≤2 辅）？
5. 动作/视线/道具/环境物理一致？只写一个瞬间？
6. 互斥清单过一遍（open/closed mouth、from front/behind、solo×多人…）？
7. 空泛词清零（beautiful/cinematic/atmosphere…）？
8. 多人物：人数准确、按角色分组、锚定句+互动句主宾明确？

## 5. 舞剑 v3（按 §4 框架手写，prompt_audit 全绿）

```
masterpiece, best quality, score_7, safe, 1girl, @wlop, @guweiz, mature female, black hair, long hair, floating hair, red dress, bare shoulders, wide sleeves, dancing, holding sword, long sword, outstretched arm, parted lips, full body, from side, courtyard, night, full moon, paper lanterns, falling petals, wind
```

NL（narrative，四句各司其职：占比布局 / 光源曝光 / 动势空间 / 色彩主次）：

```
A mature swordswoman fills the frame in a full-body side view caught mid-turn, her figure occupying about two-thirds of the frame height slightly right of center, while the darkened corridor walls and bluestone paving stay secondary behind her. Paper lanterns under the corridor eaves and the full moon over the courtyard wall keep her face, shoulders and blade clearly exposed with no silhouette. Her long hair and wide sleeves whirl through the turn, and white petals scatter across the stone floor around her leading foot. Cool blue night tones dominate the courtyard, with the red gauze dress and the warm lantern glow as the main accents.
```

相对会话内 v2 的增量：占比显式化（two-thirds + 偏置）、光源物件化（paper lanterns，
catalog 已验证）+ 曝光句、动势与站位呼应（leading foot / mid-turn）、色彩主次显式。
`prompt_audit (target=anima, variant=base)` 结果：`passed=true, gates=[], advisories=[]`。

## 6. 行动清单

| 优先级 | 项                                                   | 说明                                                                    |
| ------ | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| P0     | 修 critic/enrich provider 的 `parent` 缺失           | §2；修完质量层才真正上线，这是所有美学能力的开关                        |
| P0     | 回归：本环境 `prompt_author` 无 enrich/judge skipped | e2e 钉死                                                                |
| P1     | 艺术指导卡选择暴露给调用方                           | clarify 问题或 form_fields 显式选卡；舞剑场景默认建议 motion 卡组       |
| P1     | 质量层修复后用固定 5 条基准 brief 出前后对比         | 单人/多人/特写/场景主导/风格指定（9-11 文档的验证方式，一直没真正跑过） |
| P2     | 共现统计源落地（关联推荐）                           | Danbooru 公开数据灌 relations overlay，或外接 DanbooruSearch MCP        |
| P2     | 画师共现推荐                                         | 依赖上一条                                                              |

## 6A. 实施状态（2026-09-12，P0 + P1 参数面已落地）

| 项       | 内容                                                                                                                                                                                                                                                                                                           | 文件                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| P0-fix   | `createSubagentCriticProvider` 增加 parent 线穿：`opts.parent ?? ownerCtx.agent`，进 `subagents.start` payload；两者均缺 → 抛可操作错误（不再落到 host TypeError）                                                                                                                                             | `src/pe-framework/eval/critic.ts`                                                                                                |
| P0-fix   | `createProductionCriticProvider` 透传 `opts.parent`                                                                                                                                                                                                                                                            | `src/pe-framework/pipeline/judge-assembly.ts`                                                                                    |
| P0-fix   | `prompt_author` execute 内解析 `criticParent = exec.agent ?? ctx.agent`，enrich provider 与 judge criticProvider 装配均传入                                                                                                                                                                                    | `src/tools/prompt-author.ts`                                                                                                     |
| P1-param | 新增 `art_direction` 参数（五类各至多 1 张卡 id）：fail-fast 校验（`validateArtDirectionSpec`，非法字段/id 直接报错不烧 LLM）；enrich user 段注入「调用方已指定卡」硬要求块；brief 校验沿用 invalid_art_direction 路径；忽略路径补 advisory（`art_direction_ignored_enrich_off` / `art_direction_ignored_h3`） | `src/tools/prompt-author.ts` + `src/pe-framework/enrich/art-direction.ts` + `src/pe-framework/enrich/engine.ts`                  |
| tests    | 新增 8 条：critic 装配 3 条（payload 含 parent / opts.parent 优先 / 双缺抛错）、engine 指定卡注入 2 条、e2e art_direction 4 条中 3 条（合法回写 / fail-fast 抛错 / enrich:false 忽略 advisory / h3 忽略 advisory）                                                                                             | `tests/pe-framework/eval/critic.test.ts` + `tests/pe-framework/enrich/engine.test.ts` + `tests/plugin/author-enrich.e2e.test.ts` |
| build    | `npx tsc --noEmit` ✅ → `npm run build` ✅（dist 已含修复：critic.js L376/L396、prompt-author.js L639/642/685）→ `npx vitest run` 940 passed / 1 skipped / 0 failed ✅                                                                                                                                         | dist/（不入 git）                                                                                                                |

### ⚠ 生效条件：需要重启 DSH（本次会话内无法完成最后一步验证）

真实会话回归调用（gen_1789187638416_dm330uzj）仍返回 `enrich_skipped` + `judge_skipped`
（`critic_error:Cannot read properties of undefined (reading 'options')`，enrich 阶段仅 2.3ms）——
原因是 preset 的 `agent.cordis.yml` 以 `./plugins/prompt-master/dist/src/plugin/index.js`
**静态挂载且无 HMR 插件条目**：宿主进程在会话启动时已把旧模块载入内存，
磁盘上的新 dist 对运行中进程不可见。

**重启 DSH 后的验收标准**（任一 `prompt_author` 调用）：

1. `advisories` 不含 `enrich_skipped` / `judge_skipped`；
2. envelope 顶层出现 `judge`（verdict/score/findings）与 `enrichment.brief`；
3. 舞剑类意图建议带 `art_direction: { motion: 'weapon_trail', ... }` 调用以吃满卡片组合拳。

未完成（依赖重启或外部数据）：P1 的 5 条基准 brief 前后对比；P2 共现统计源。
代码未提交 git（src + tests + docs 在工作区，dist 不入 git），待验收通过后按插件提交规范入库。

### 6B. 第二轮实施（2026-09-12 下午，§7 复盘项）

| 项                                                                                                                              | 文件                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| intent taskText 去重（persona/schema 不再进 User Input JSON；空 candidates 剔除）                                               | `src/pe-framework/intent/subagent-provider.ts`（`dumpIntentRequest`） |
| 输出纪律统一为裸 JSON（ANIMA/H3/DEFAULT schema ×3 + BLUEPRINT analyzer ×1）                                                     | `subagent-provider.ts` + `src/pe-framework/blueprint/analyzer.ts`     |
| critic 证据契约如实化（主张→回查→evidenceUnverified 降权）+ 工具用途说明 + 裸 JSON                                              | `src/pe-framework/eval/critic.ts`                                     |
| 中文概念桥接（`ZH_CONCEPT_BRIDGE`，长键优先防重叠；enrich 降级路径的召回兜底）                                                  | `src/pe-framework/dialect/catalog-recall.ts`                          |
| 新增回归：桥接命中/只收 canonical-alias/与拉丁去重 共 3 条 + 既有一组 pin 不回归                                                | `tests/pe-framework/dialect/catalog-recall.test.ts`                   |
| 验证：tsc ✅ → build ✅（dist 同步）→ vitest 966 passed / 1 skipped / 0 failed ✅；定点复核 intent/eval/recall/e2e 93 passed ✅ | —                                                                     |

## 7. 给 LLM 的提示词契约——真实 session 日志复盘（2026-09-12 第二轮）

复盘样本：session-aaf877be（intent 子代理 one-shot 会话，父会话 fd08dd42，13:16），
taskText 全文 7917 字符已存 `temp/research/session-aaf877be/intent-tasktext.txt`。

### 7.1 「还是 judge_skipped」的第一性原理定位（证据链闭合）

```
宿主进程（dsh web，PID 44672）启动于 11:30:50
P0 修复 build 落盘于 12:22
用户实测（gen_1789187638416 / session fd08dd42）在 12:33 与 13:16
→ 进程未重启，内存里的一直是 11:30 载入的旧模块
```

宿主崩溃链逐行核实（`@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js` L161-186 +
`dsh-subagent/lib/index.js` L145/L446-456）：`subagents.start(req)` → `request.parent` 为
undefined → `resolveChildDepth(undefined)` → `delegationDepthOf` 读 `agent.options.subagentDepth`
→ **TypeError: Cannot read properties of undefined (reading 'options')**——正是 critic_error 的原文。
旧代码 start 请求不带 parent → 必崩；新代码传入 `exec.agent`（intent 已证明可用）→ 不崩。
**结论：修复正确，重启 DSH 后生效；这不是修复无效，是模块未重载。**

### 7.2 intent 子代理 taskText 的四处提示词缺陷（本轮已修 3 处）

| #   | 缺陷                                                                                                               | 证据                 | 处置                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | **persona/schema 在 User Input JSON 里完整重复**（taskText 前缀一次 + JSON 内第二份，~5.5KB/次）                   | taskText L60-61      | ✅ `dumpIntentRequest` 剔除 persona/schema 再序列化；空 catalogCandidates 一并剔除                       |
| 2   | **输出纪律三处自相矛盾**：persona 尾「不要 markdown fence」×2 vs schema 尾「必须用 fence 或纯 JSON；纯 JSON 优先」 | taskText L29/L51/L66 | ✅ 统一为「直接输出裸 JSON（不要 markdown fence）」（ANIMA/H3/DEFAULT/BLUEPRINT 四份 schema + analyzer） |
| 3   | **catalog 召回对纯中文意图空转**（`catalogCandidates: []`——enrich 失败时唯一证据层也失灵）                         | taskText L62         | ✅ `ZH_CONCEPT_BRIDGE` 中文概念桥接表（长键优先防重叠），桥接词走同一 exact 级联，只有真实命中才进候选   |
| 4   | few-shot 只有雨夜街头一例，动作/多人场景无锚                                                                       | taskText L25-27      | 记录不改（成本权衡；enrich 层修好后由 brief 主导设计）                                                   |

### 7.3 critic（judge）persona 的制度性矛盾（本轮已修）

原文铁律：「tool 是**你实际调用过的证据工具名**……没有证据的 finding 一律不要输出」——
但 critic 子代理是 one-shot spawn，**没有工具执行权**；user 段只给了工具名单，没有任何工具结果。
这条契约在真实路径下只有两种结局：findings 全空（评审空转）或编造 evidence（假证据）。
设计意图本来就是「LLM 提证据主张 → 主进程 bridge 回查 → 不可核实标 evidenceUnverified 降权」
（critic.ts L24-25 注释自证），persona 却没如实描述。

已改为如实契约：`evidence 三键 = 证据主张（tool 选自名单 + query 给应检索串 + result 写预期摘要），
主进程逐条回查，无法核实标 evidenceUnverified 并降权`；buildUser 补三类工具的用途说明；
输出纪律同步统一为裸 JSON。rubric 文件（spec 钉死）未动。

### 7.4 方法论：给 LLM 的提示词到底怎么写（本轮复盘提炼）

1. **单一事实源**：persona/schema 每份只出现一次；数据段（User Input）只放数据不放指令。
   重复不是「强调」，是 token 浪费 + 注意力稀释（模型会对两份指令做平均）。
2. **输出契约唯一且全局一致**：JSON-only / fence 与否 / 前后缀禁令，在 persona、schema 尾、
   最终指令三处必须是同一句话——契约打架时模型输出格式随机摇摆。
3. **契约必须符合现实能力**：要求「你实际调用过的工具」就不能不给工具；不给工具就要如实
   描述「主张→回查→降权」的契约。制度性矛盾不会被 LLM 「理解」掉，只会被坏解满足。
4. **禁令给到可判定粒度**：LIGHTING_BAN、互斥对、禁空泛词这类「可判定的禁令」才有约束力；
   「要有美感/要有设计感」这类空话为零信息。
5. **证据流方向**：检索证据（candidates）在生成前注入（B7），而不是生成后事后校验；
   证据给不到就如实说明证据机制，别假装有。
6. **few-shot 锚定信息密度**：一个高质量示例胜过十条形容词规则；示例要覆盖目标任务的主类。
7. **结构可预测**：persona → 输出 schema → 候选证据 → 数据 → 收尾指令，顺序固定；
   LLM 对「数据在哪、规则在哪」的稳定位置敏感。
8. **模型与任务匹配**：本会话路由 fangzhou/ark-code-latest 是**编码模型**在跑美学决策——
   R1 原则（完全跟随会话路由）下这是用户侧决策项：出稿会话切非 code 模型，或未来在
   config 开 per-stage 模型覆盖（与 R1 冲突，需用户裁决）。

## 8. 参考来源

- 外部仓库（一手）：DanbooruSearchOnline README（共现/NPMI/画师推荐章节）；
  ComfyUI-NewBie-LLM-Formatter `LPF_config.json.example` 的 `system_prompt_anima` 全文 + README Agent 模式章节；
  SD-Anima-Prompt-Studio README；ComfyUI-Animagine-Prompt README。
- 本插件（一手）：`src/pe-framework/eval/critic.ts` L437-507、
  `src/pe-framework/intent/subagent-provider.ts` L85-132、`src/pe-framework/pipeline/judge-assembly.ts` L88、
  `src/tools/prompt-author.ts` L717-766、`src/pe-framework/enrich/art-direction.ts`、
  `src/pe-framework/eval/rubrics/anima.ts`、`docs/2026-09-11-external-benchmark-quality-upgrade.md`。
- 会话实测：gen_1789184060750_lpxk0tta、gen_1789185090996_liw9yihj 两次 envelope 的
  advisories/judge/enrichment 字段。
