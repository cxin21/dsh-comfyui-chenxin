# 调研笔记：官方 MiniMax-AI/MiniMax-H3 的 h3-prompt-writing skill 现状（issue #19 首次基线）

- 调研日期：2026-11-22（Asia/Shanghai）
- 调研范围：GitHub 公开仓 [MiniMax-AI/MiniMax-H3](https://github.com/MiniMax-AI/MiniMax-H3)
  （main 分支，抓取时 HEAD = `199b7d0e1fd95e7b3eafa8c15eca692534142427`）。
- 本笔记只记录事实；与本仓 `plugins/prompt-forge/src/pe-framework/audit/rules-h3.ts`
  （该文件在本仓存在，路径经 `ls` 确认）的逐条对照、采纳裁决不在本笔记范围内。
- verbatim 快照已落盘：[docs/rules-h3-upstream/_snapshot/2026-11-22-first-baseline/](../../rules-h3-upstream/_snapshot/2026-11-22-first-baseline/SOURCE.md)
  （4 文件 git hash-object 与上游 blob SHA 逐一致；`python scripts/check_h3_upstream.py
  --baseline 2026-11-22-first-baseline` 实测 exit 0，identical=4）。

## 1. 事实速览

| 项 | 事实 |
| --- | --- |
| 官方仓存在性 | 存在，`full_name=MiniMax-AI/MiniMax-H3`，created 2026-07-30，default branch `main`，12121 stars，最近 push 2026-10-28。来源：https://api.github.com/repos/MiniMax-AI/MiniMax-H3 |
| h3-prompt-writing skill | 存在，仓内共 **3 份目录镜像**（`skills/`、`.claude/skills/`、`.agents/skills/`），各 4 文件。来源：https://api.github.com/repos/MiniMax-AI/MiniMax-H3/git/trees/main?recursive=1 |
| 官方 release | **0 个**（releases API 返回空数组）。来源：https://api.github.com/repos/MiniMax-AI/MiniMax-H3/releases |
| 官方 tag | **0 个**（tags API 返回空数组）。来源：https://api.github.com/repos/MiniMax-AI/MiniMax-H3/tags |
| main 分支 | 46 个 commit，首个 commit 2026-08-05，HEAD 2026-10-28。来源：https://api.github.com/repos/MiniMax-AI/MiniMax-H3/commits?per_page=100 |
| skill 最新一次内容变更 | 2026-08-15 合入的 PR #44（分支头 commit `a107547fa6`，2026-08-11），给顶层 `skills/h3-prompt-writing/SKILL.md` 加 5 行 "Tips for Better Results"。来源：https://github.com/MiniMax-AI/MiniMax-H3/pull/44 |
| 本仓 drift 检测脚本适配 | 基线按 `scripts/check_h3_upstream.py` 契约落盘后实测通过（exit 0）。来源：本仓 `scripts/check_h3_upstream.py` |

## 2. skill 的确切位置

官方 tree API（main HEAD，recursive）列出 3 份 h3-prompt-writing 目录，各含同构的 4 个文件
`SKILL.md` / `agents/openai.yaml` / `references/base-en.txt` / `references/ref-en.txt`：

| 路径 | SKILL.md blob SHA | 其他 3 文件 blob SHA |
| --- | --- | --- |
| `skills/h3-prompt-writing/` | `b6d9b2839384a588763a9c24315225dd8ce19d56` | openai.yaml `8151bd25e3dc29bdb67c8049e39c34c60c3f08f8`；base-en.txt `40cf586a634d677d6b7107b367cf0ec9621be728`；ref-en.txt `7ae1b2d07d743fd2392258a96449be9e9e322d35` |
| `.claude/skills/h3-prompt-writing/` | `066429d78f72b080a52350a5b165e52cb31b0bca` | 同上（三份镜像的这 3 个文件 blob SHA 互相同） |
| `.agents/skills/h3-prompt-writing/` | `066429d78f72b080a52350a5b165e52cb31b0bca`（与 .claude 份一致） | 同上 |

来源：https://api.github.com/repos/MiniMax-AI/MiniMax-H3/git/trees/main?recursive=1

差异事实：`.claude` 份与 `.agents` 份互为字节一致；它们的 `SKILL.md` 比顶层
`skills/h3-prompt-writing/SKILL.md` **少末尾 5 行 "## Tips for Better Results" 小节**
（PR #44 只改了顶层副本，patch 见 §4）。实测 `diff` 两份 SKILL.md 原文，唯一差异即这 5 行。

哪份是"官方入口"的事实记录：

- 顶层 `README.md` 安装命令：`npx skills add https://github.com/MiniMax-AI/MiniMax-H3 --skill h3-prompt-writing`。来源：https://github.com/MiniMax-AI/MiniMax-H3#prompt-writing-skill
- `skills-lock.json` 记录 `"skillPath": "skills/h3-prompt-writing/SKILL.md"`。来源：https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills-lock.json
- 本快照基线因此取顶层 `skills/h3-prompt-writing/`（`official_dir` 契约要求单目录 1:1 镜像，见 `scripts/check_h3_upstream.py` 的 `official_files()`）。

## 3. 版本信息

### 3.1 release / tag：未找到

- `gh api repos/MiniMax-AI/MiniMax-H3/releases` → `[]`（0 条）。
- `gh api repos/MiniMax-AI/MiniMax-H3/tags` → `[]`（0 条）。
- 结论性事实：**官方未使用 GitHub Releases/Tag 发布版本**；"官方每次发布"这一触发条件目前
  在 GitHub 侧无对应载体，演进只体现在 main 分支 commit 上。
- 试过的路径（均空）：https://api.github.com/repos/MiniMax-AI/MiniMax-H3/releases 、
  https://api.github.com/repos/MiniMax-AI/MiniMax-H3/tags 、
  https://github.com/MiniMax-AI/MiniMax-H3/releases （页面侧同样无条目）。

### 3.2 main 分支概览（46 commits）

- 仓库创建：2026-07-30（https://api.github.com/repos/MiniMax-AI/MiniMax-H3 ）
- 首个 commit：`3834811bb9` "Initial MiniMax H3 repository"，2026-08-05T12:07:40Z
- HEAD：`199b7d0e1fd95e7b3eafa8c15eca692534142427` "Merge pull request #83 from SammanthaLLM/main"，2026-10-28T10:13:57Z
  （https://api.github.com/repos/MiniMax-AI/MiniMax-H3/commits/main ）
- 近 10 个非 merge commit（commit 列表，非 release）：

| commit | 日期 (UTC) | message（首行） |
| --- | --- | --- |
| `36bddece8e` | 2026-09-25 | Add files via upload |
| `9176a26ae7` | 2026-08-11 | Support local image paths in image loader |
| `a107547fa6` | 2026-08-11 | docs(h3-prompt-writing): add tips for better results（PR #44 分支头） |
| `ed3cda4e66` | 2026-08-11 | Update README.md |
| `96ae5d4448` | 2026-08-11 | Fix dependency versions and Diffusers links |
| `37866ed990` | 2026-08-11 | docs: fix logical issue in README.md (section_name_hyphen_inconsistent) |
| `ca38d0f073` | 2026-08-10 | docs: remove unnecessary backslash escaping in README |
| `743d51e833` | 2026-08-10 | docs(skills): add compatibility fields to Hub-native skills, sync i18n READMEs |
| `3f192aa37f` | 2026-08-10 | Merge pull request #14 …（此行本身为 merge，列出以保持窗口连续） |
| `c22aafa307` | 2026-08-09 | Fix init_weights in dac_utils.py for weight_norm Conv1d layers |

来源：https://api.github.com/repos/MiniMax-AI/MiniMax-H3/commits?per_page=100 （全 46 条见 §4）

## 4. skill 变更历史（全量，按 commit detail API 逐条核实）

h3-prompt-writing 相关文件的全部变更（"变更历史"以 per-commit files 列表为准；
注：GitHub `commits?path=` 列表接口会漏掉经由 merge commit 进入的变更，
故下表用 commit detail + compare + PR API 交叉核实）：

| # | 时间 (UTC) | commit / PR | 动作 | 触及文件 |
| --- | --- | --- | --- | --- |
| 1 | 2026-08-05T12:23:48Z | `35491cdba2`（直推 main，作者 yuanhe） | 初次加入 skill：`skills/h3-prompt-writing/` 4 文件 + `bin/minimax-h3-prompt-skill.js` + `package.json` | "Add MiniMax H3 prompt writing skill"。来源：https://api.github.com/repos/MiniMax-AI/MiniMax-H3/commits/35491cdba2adfe62a510f725e8619f8e58783ea2 |
| 2 | 2026-08-05T12:28:28Z | `fbcabbc056`（直推 main，yuanhe） | 删除 `bin/` 与 `package.json`，README 改为 skills CLI 安装（"Use skills CLI for prompt writing skill"）。skill 文件本身无改动 | 同上 commit 链接 |
| 3 | 2026-08-07T19:38:02Z（PR #8 分支头；2026-08-09T08:34:27Z 以 `b0175e5274` 合入） | `1ce88e916d`（作者 Copilot App） | 安装镜像：新增 `.claude/skills/h3-prompt-writing/` 4 文件 + `.agents/skills/h3-prompt-writing/` 4 文件 + `skills-lock.json`，全部 status=added | PR：https://github.com/MiniMax-AI/MiniMax-H3/pull/8 |
| 4 | 2026-08-07T19:31:18Z（PR #7 分支头；2026-08-09T10:05:54Z 以 `fbe95f7fcb` 合入） | `12ebd6bd8c`（作者 Copilot App） | 同类安装：新增 `.agents/` 4 文件 + `skills-lock.json`（与 #8 内容同 blob，两 PR 均已合入 main） | PR：https://github.com/MiniMax-AI/MiniMax-H3/pull/7 |
| 5 | 2026-08-09T15:27:52Z | `b731d8846c`（JoeVenner） | "docs(skills): clarify h3-prompt-writing is agent-portable, not OpenAI-only"：改 3 份镜像的 `SKILL.md` frontmatter（加 `compatibility:` 行）+ `README.md` | https://api.github.com/repos/MiniMax-AI/MiniMax-H3/commits/b731d8846cf789f284d538013d5caea053c511c8 |
| 6 | 2026-08-11T11:25:43Z（分支头；2026-08-15T08:31:17Z 以 `d21241f0a4` 合入） | `a107547fa6`（GAGAN YADAV，PR #44） | **skill 最新一次内容变更**：仅顶层 `skills/h3-prompt-writing/SKILL.md` +5 行（"## Tips for Better Results" 小节：时长 4–15 s、引用标签一致、具体细节优于抽象词、关键帧与时间线衔接）；patch 实测 additions=5, deletions=0。`.claude`/`.agents` 镜像**未同步** | PR：https://github.com/MiniMax-AI/MiniMax-H3/pull/44 |
| 7 | 2026-08-15 之后 | — | 至抓取日（2026-11-22）无任何 h3-prompt-writing 文件再变更（`commits?path=` 三路径均止于上表条目） | https://api.github.com/repos/MiniMax-AI/MiniMax-H3/commits?path=skills/h3-prompt-writing |

佐证（ancestry 核实）：
- `compare main...a107547fa6` → status=behind（该 commit 在 main 历史内）。来源：https://api.github.com/repos/MiniMax-AI/MiniMax-H3/compare/main...a107547fa669c509b8e6363fe18378d46ab3066c
- `commit a107547fa6` 的 pulls API → PR #44，merge_commit_sha=`d21241f0a4…`，merged_at=2026-08-15T08:31:17Z。来源：https://api.github.com/repos/MiniMax-AI/MiniMax-H3/commits/a107547fa669c509b8e6363fe18378d46ab3066c/pulls

结论性事实（非裁决）：**skill 是否随"模型发布"更新——官方无 release 事件可比对；skill 内容
自 2026-08-15 后未再变动，而仓库模型侧文件（权重 index、脚本等）在 2026-09-25、2026-10-28
仍有 commit。**

## 5. skill 内容要点清单（提示词写法规则相关）

以下要点为内容提炼，原文位置以 `文件 §章节` 标注；全文以快照为准
（[docs/rules-h3-upstream/_snapshot/2026-11-22-first-baseline/](../../rules-h3-upstream/_snapshot/2026-11-22-first-baseline/SOURCE.md)）。

### 5.1 `SKILL.md`（顶层副本，含 Tips 节；快照 SKILL.md）

- frontmatter：`name: h3-prompt-writing`；`description` 列出五种输入模式（T2VA/I2VA/FL2VA/L2VA/Ref2VA）
  与三个核心字段名（`integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`）；
  `compatibility:` 声明可移植到任意能读本地文件的 agent（无外部 API）。（frontmatter）
- 工作流 4 步：识别输入模式 → 按 base/ref 读对应 reference 文件 → 按 guide 的最终 prompt
  结构改写 → **原样保留字段名、章节顺序、标签、时间记法**。（§Workflow）
- Base 模式语义：T2VA 纯文本建完整时间线；I2VA 从首帧起向前发展；FL2VA 描述首末帧之间的
  连续路径；L2VA 推断开场并收敛到给定末帧。（§Base Modes）
- Ref2VA 六节固定顺序：`subject_definitions` → `summary` → `retention_analysis` →
  `detailed_description` → `overall_soundscape` → `non_diegetic_music`；引用标签跨节一致。（§Full-Reference Mode）
- 输出规则：改写节用英文写；对话/歌词/画面可见文字保留原语言；每个镜头要交代构图、主体、
  环境、动作、镜头、声音、以及引用内容出现的确切时间点；禁止情节摘要、未消解的引用标签、
  与请求时长不符的时间线。（§Output Rules）
- **仅顶层副本有**的 "Tips for Better Results" 4 条：描述总时长须匹配请求视频时长（**4–15 秒**）；
  `<Picture N>`/`<Video N>`/`<Audio N>` 标签跨节一致；用具体视听细节替代 "cinematic"/"beautiful"
  类抽象词；用关键帧（I2VA/FL2VA/L2VA）时须明说首/末帧如何接入时间线。（§Tips for Better Results）

### 5.2 `references/base-en.txt`（T2VA/I2VA/FL2VA/L2VA 写法指南；快照 references/base-en.txt）

- 最终 prompt 两段式：第一段=对齐指令（固定英文句式），第二段=三个核心字段；指令必须是
  首行，后接一个空行。（§2 Final Prompt Structure）
- 各模式对齐指令的**精确句式模板**：I2VA `For the target video, at 0.00 seconds into the target
  video, <Picture 1> (from [Shot 1]) is fully referenced.`；FL2VA/L2VA 用 "How the reference
  pictures align with the target video — …" 句式；时间一律 `S.SS` 两位小数；`[Shot N]` 的 N
  取实际末镜头号。（§2.1）
- 三字段定义：`integrated_multimodal_description`（视觉/动作/镜头/说话人/对白/歌声/画内音的
  时间线主体）；`overall_soundscape`（全片环境音+动作音+非语言人声综述）；`non_diegetic_music`
  （角色听不到、只有观众听到的配乐）。（§2.2）
- 关键帧融入写法（各模式推荐四段式结构）：I2VA 首帧锚点→动作起始→连续发展→结果/反应，
  且人物身份/服装/颜色/关键物件/空间关系保持一致（§3.1）；FL2VA 首帧状态→可见中间变化→
  差异逐渐收窄→末帧状态，**默认单镜头**，多镜头仅限用户明示，末帧须由末镜头在片尾到达
  （§3.2）；L2VA 合理前态→明确动作与过渡路径→末镜头逐渐收敛→末帧落位（§3.3）。
- 镜头记法：`[Shot 1]` 不带时间戳；后续镜头 `[Shot N] At MM:SS.mmm`，切点时间**严格递增**且
  落在时长内。（§4.2）
- 切换动词白名单：普通切用 `the camera cuts to` / `the shot cuts to` / `the shot transitions to` /
  `the shot changes to` / `the shot switches to`；cross-dissolve/fade/wipe 仅在用户明示时可用；
  切镜应带来新信息（主体/空间/状态/视点/时间）；仅距离或微角度变化优先用运镜。（§4.2）
- 运镜三维表达：**12 种 motion type**（Zoom In/Out、Push In/Out、Pan Left/Right、Truck Left/Right、
  Tilt Up/Down、Pedestal Up/Down、Arc Shot、Tracking Shot、Static Shot、Shake Slightly/Strongly、
  POV、Roll Clockwise/Counterclockwise）× 幅度（`with small/large amplitude`）× 速度
  （`at slow/fast speed`）；中幅度/常速通常省略；运镜写成镜头内的自然英文动作句而非句尾标签堆叠。
  （§4.3，含逐项表格）
- 说话人规则：发声主体用稳定 ID `(S1)`/`(S2)`；同发用复合 ID `(S1,S2)`；ID 跨镜头不变；
  不发声的角色不给 ID；首次出现须给足身份信息（类型/年龄/性别/是否在画/音高/音色/语速/口音）。
  （§4.4）
- 对白格式：身份短语、ID、动作、语气放在 `<d>` 外；`<d>` 内**只有**语言 tag 与用户原文，
  逐字保留不翻译不改写，如 `<d>[English] I get off at the next station.</d>`。（§4.4）
- 画外音固定短语 `says in an off-screen voiceover`，且紧随其后必须声明对应在画角色嘴唇闭合。
  （§4.4）
- 跨切对白：同一句跨切点在两段各用 `<scenetrans>` 并明说音频跨切延续；片尾截断用 `<cutoff>`；
  延续措辞给出固定短语集（`continues seamlessly across the cut` 等）。（§4.4）
- 画面内文字（横幅/招牌/字幕/霓虹字）用英文双引号包裹，原文逐字保留不翻译。（§4.5）
- `overall_soundscape`：1–4 句连续段落，只写环境音/动作音/非语言人声；对白/歌声/画内音乐不
  重复于此；`N/A` 仅当用户明示全片静音。（§4.6）
- `non_diegetic_music`：1–3 句，写配器/速度/节奏/力度变化，**禁用抽象情绪词**、禁解释配乐的
  情感功能；无配乐写 `N/A`。（§4.7）
- 风格词建议列表：`Cinematic`、`live-action`、`2D-animated`、`3D CG`、`claymation`、`watercolor`、
  `vintage film`；关键帧任务从参考图取风格，T2VA 从用户文本取。（§4.1）
- 附 4 个完整范例（T2VA / I2VA / FL2VA 8 秒单镜 / L2VA 6 秒单镜）。（§5 Cases 1–4）

### 5.3 `references/ref-en.txt`（Ref2VA 全引用模式写法指南；快照 references/ref-en.txt)

- 六节结构总表及各自用途（subject_definitions / summary / retention_analysis /
  detailed_description / overall_soundscape / non_diegetic_music）。（§1）
- 四类引用标签：`<Subject N>`（可复用的可见内容单元：人/物/场景/服装/道具/界面/特效/风格/动作/
  表情/姿态）、`<Picture N>`（作为具体目标帧或分镜锚点的参考图）、`<Video N>`（整片级关系：剪辑/
  续接/结构引用）、`<Audio N>`（被复制或被引用的音频信号）；标签一经分配跨节含义不变。
  （§2 标签表 + 固定含义声明）
- `<Subject N>` 细则：表示"将被目标视频实际使用的内容单元"而非源文件本身；一个 subject 可由
  多资产合成、一个资产可提供多 subject；仅作来源引用的图/视频不单独建行，写进所属定义内。
  （§2.1）
- `<Picture N>` 细则：仅当图像充当首帧/关键帧/末帧/剪辑关键帧/构图锚点时独立建行；分镜参考图
  须写明映射的镜头与提供的规划信息。（§2.2）
- `<Video N>` 细则：保留给整片关系；复用其中可见内容仍归 `<Subject N>`。（§2.3）
- `<Audio N>` 细则：常见用途（复制信号/音乐风格/音色语气/引用原对白歌词/节拍连续性）；显式绑定
  目标说话人时复用全局 `(Sx)`，音频定义不独立编号；同一资产多角色一句话写全；`<Video N>` 与
  `<Audio N>` **独立编号**，序号不编码配对关系；普通带声参考视频不因含声而自动产生 `<Audio N>`。
  （§2.4、§2.5）
- `summary` 节：一段英文短综述，以方括号任务类型前缀开头；六种任务类型（keyframe completion /
  reference generation / video editing / video continuation / audio reuse / audio reference）及
  各自判定条件表；多类型用 ` + ` 连接且不重复；"仅提供运镜/切点/节奏"的视频归 reference
  generation 而非 video editing/continuation；剪辑任务综述固定起始句 `The target video is an
  edited version of <Video 1>.`；本节不得引入新标签。（§3）
- `retention_analysis` 节：每个标签一行。可见内容四种固定关系标记 `fully_preserved` /
  `partially_preserved` / `attribute_transfer` / `weak_reference`；音频四种固定标记 `fully_copy` /
  `partially_copy` / `reference` / `weak_reference`；给出三类条目的书写格式样例；关系标记只能在
  subject_definitions 已定义的角色范围内选；不得把目标视频新增内容当作引用保真损失。（§4）
- `detailed_description` 节：基础格式沿用 base 指南（英文主体、`[Shot 1]` 无时间戳、后续
  `At MM:SS.mmm` 递增、运镜自然英文、`(Sx)` + `<d>[Language]…</d>`、`<scenetrans>`/`<cutoff>`）。
  （§5.1）
- 全引用模式与 T2VA 的差异表：主字段为 `detailed_description`；风格在 `[Shot 1]` **之前**用
  1–2 句英文确立；在首次出现处与作用点插入四类标签；音频关系在对应镜头/阶段引用 `<Audio N>`
  并写明复制或引用。（§5.2）
- 篇幅事实：生成任务 `detailed_description` 常规 **350–500 英文词**；对白密集内容优先完整口语
  时间线而非凑词数；剪辑任务随源视频复杂度伸缩；单镜头不自动缩短。（§5.2）
- 标签落镜写法：重要 `<Subject N>` 首次清晰出现时写引用特征+画内位置+当前动作；后续镜头复用
  同标签不重定义；帧锚点固定短语（`the shot begins from <Picture 1>` 等）。（§5.3）
- 说话人细化：主体开口写 `<Subject N> (Sx)`；同一主体画外说话保持同形并标 `off-screen`；说话人
  不对应已定义主体时用稳定声音描述 + `(Sx)`；`(Sx)` 按目标视频实际发声事件顺序**一次性分配**，
  全文复用，音频定义绑定的 `(Sx)` 复用同号不新分配，`retention_analysis` 里不写 `(Sx)`；仅存在于
  直接复用 BGM/完整音轨里的口播提示以 `<Audio N>` 为声源、不得虚构 `(Sx)`；复用参考音频的原话时
  `<d>` 内逐字保留原语言，听不清处写 `[unclear]`，标点规范化（`,` `.` `?` `!`，去波浪号/emoji/装饰
  标点），完整句以 `.` `?` `!` 收尾。（§5.4）
- 两音频节：定义沿用 base 指南；引用音频时在**与可听层匹配的节**写复制/引用关系（环境/音效→
  overall_soundscape，观众专属配乐→non_diegetic_music）；同一音频双内容时两节各写对应关系；完整
  对白歌词只出现在 detailed_description 的 `<d>` 内，两节不重复。（§6）
- 附 1 个完整六节范例（咖啡馆/萨摩耶/罐头笑声，3 镜头，含全部四类标签与 retention 标记）。（§7）

### 5.4 `agents/openai.yaml`（快照 agents/openai.yaml）

- 仅 5 行 UI 元数据：display_name "MiniMax H3 Prompt Writing"、short_description、default_prompt
  （`Use $h3-prompt-writing to rewrite this multimodal request into a MiniMax H3 generation
  prompt.`）。来源：https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/agents/openai.yaml
- README 声明该文件只是 ChatGPT/Codex skills UI 的可选元数据，不构成运行时依赖。来源：
  https://github.com/MiniMax-AI/MiniMax-H3#prompt-writing-skill

### 5.5 周边事实（非 skill 文件本体）

- `skills-lock.json`：`sourceType=github`，`skillPath=skills/h3-prompt-writing/SKILL.md`，
  `computedHash=3d01859464bc9438585c8fdbf7fcd4b4c54404fadd3f1a64ab7970ae8877d086`（与当前两个
  SKILL.md 变体的 sha256 均不同——为 2026-08-07 安装时旧内容的哈希，此后 skill 又改过；如实记录）。
  来源：https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills-lock.json
- `README.md`：skill 章节称其为仓内九个 skill 之一、唯一可移植到通用 agent 的（其余八个为
  MiniMax Hub canvas 工作流专用）；agent 兼容性声明列出 Claude Code / Claude Agent SDK /
  Cursor / Windsurf / OpenAI agents / LangChain 等。来源：https://github.com/MiniMax-AI/MiniMax-H3#prompt-writing-skill
- `skills/README.md`：skills 目录说明（该目录 2026-08-06 曾声明 WIP 状态与贡献奖励）。来源：
  https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/README.md 、commit `319e2008f4`
  https://api.github.com/repos/MiniMax-AI/MiniMax-H3/commits/319e2008f4

## 6. 查不到 / 未找到的项（如实记录）

| 项 | 状态 | 试过的路径 |
| --- | --- | --- |
| GitHub Releases | 未找到（0 个） | https://api.github.com/repos/MiniMax-AI/MiniMax-H3/releases |
| Git tags | 未找到（0 个） | https://api.github.com/repos/MiniMax-AI/MiniMax-H3/tags |
| skill 的中文版指南 | 未找到。references 仅 `base-en.txt` / `ref-en.txt` 两个文件，tree API 全量列出无其他 reference 文件 | https://api.github.com/repos/MiniMax-AI/MiniMax-H3/git/trees/main?recursive=1 |
| 官方"模型发布"事件锚点 | 未找到。官方无 release；仓库 README/HF 链接即入口，无版本号字段被读到 | https://github.com/MiniMax-AI/MiniMax-H3 |
| `skills-lock.json` computedHash 与当前内容对齐 | 不对齐（哈希为 2026-08-07 旧内容）。已作为事实记录，未做更多解释 | 同上 skills-lock.json |

## 7. 抓取命令记录（全部经 `gh` CLI，账号已登录）

```bash
# 1) 仓库元数据
gh api repos/MiniMax-AI/MiniMax-H3 --jq '{full_name, default_branch, description, html_url, pushed_at, created_at, stargazers_count}'

# 2) 全量文件树（定位 skill 三份镜像与 blob SHA）
gh api "repos/MiniMax-AI/MiniMax-H3/git/trees/main?recursive=1" --jq '.tree[] | select(.type=="blob") | "\(.sha)  \(.path)"'

# 3) skill 四文件原文抓取（对三份镜像中目标目录重复执行；快照取 skills/ 顶层副本）
gh api "repos/MiniMax-AI/MiniMax-H3/contents/skills/h3-prompt-writing/SKILL.md" -H "Accept: application/vnd.github.raw" > SKILL.md
gh api "repos/MiniMax-AI/MiniMax-H3/contents/skills/h3-prompt-writing/agents/openai.yaml" -H "Accept: application/vnd.github.raw" > agents/openai.yaml
gh api "repos/MiniMax-AI/MiniMax-H3/contents/skills/h3-prompt-writing/references/base-en.txt" -H "Accept: application/vnd.github.raw" > references/base-en.txt
gh api "repos/MiniMax-AI/MiniMax-H3/contents/skills/h3-prompt-writing/references/ref-en.txt" -H "Accept: application/vnd.github.raw" > references/ref-en.txt

# 4) 三份 SKILL.md 差异（顶层 vs .claude 镜像）
diff <(gh api "repos/MiniMax-AI/MiniMax-H3/contents/skills/h3-prompt-writing/SKILL.md" -H "Accept: application/vnd.github.raw") \
     <(gh api "repos/MiniMax-AI/MiniMax-H3/contents/.claude/skills/h3-prompt-writing/SKILL.md" -H "Accept: application/vnd.github.raw")

# 5) release / tag（均返回空数组）
gh api repos/MiniMax-AI/MiniMax-H3/releases --paginate --jq 'length'
gh api repos/MiniMax-AI/MiniMax-H3/tags --jq 'if length == 0 then "NONE" else . end'

# 6) 分支提交全量与 HEAD
gh api "repos/MiniMax-AI/MiniMax-H3/commits?per_page=100" --jq '.[] | "\(.sha[0:10])  \(.commit.author.date)  \(.commit.message | split("\n")[0])"'
gh api repos/MiniMax-AI/MiniMax-H3/commits/main --jq '{sha, date: .commit.author.date, message: (.commit.message | split("\n")[0])}'

# 7) skill 相关路径的变更历史（注意：path 过滤会漏经 merge 进入的变更，需与 per-commit detail 交叉核实）
gh api "repos/MiniMax-AI/MiniMax-H3/commits?path=skills/h3-prompt-writing/SKILL.md&per_page=50" --jq '.[] | "\(.sha[0:10])  \(.commit.author.date)  \(.commit.message | split("\n")[0])"'
gh api "repos/MiniMax-AI/MiniMax-H3/commits?path=.claude/skills/h3-prompt-writing/SKILL.md&per_page=50" --jq '...'
gh api "repos/MiniMax-AI/MiniMax-H3/commits?path=.agents/skills/h3-prompt-writing&per_page=50" --jq '...'
gh api "repos/MiniMax-AI/MiniMax-H3/commits?path=skills-lock.json&per_page=20" --jq '...'

# 8) 关键 commit 的逐文件明细与 patch（含 additions/deletions 与 patch 正文）
gh api "repos/MiniMax-AI/MiniMax-H3/commits/35491cdba2adfe62a510f725e8619f8e58783ea2" --jq '{files: [.files[].filename]}'
gh api "repos/MiniMax-AI/MiniMax-H3/commits/1ce88e916de7c15b63cbaf347642503f9bc21d3d" --jq '.files[] | "\(.status)  \(.filename)"'
gh api "repos/MiniMax-AI/MiniMax-H3/commits/b731d8846cf789f284d538013d5caea053c511c8" --jq '.files[] | {filename, status}'
gh api "repos/MiniMax-AI/MiniMax-H3/commits/d21241f0a4b3acbb34c97dae47fa417b7065e438" --jq '.files[0] | {filename, additions, deletions, patch}'

# 9) ancestry / PR 归属核实
gh api "repos/MiniMax-AI/MiniMax-H3/compare/main...a107547fa669c509b8e6363fe18378d46ab3066c" --jq '{status, ahead_by, behind_by}'
gh api "repos/MiniMax-AI/MiniMax-H3/commits/a107547fa669c509b8e6363fe18378d46ab3066c/pulls" --jq '.[] | {number, title, state, merged_at, merge_commit_sha}'
gh api "repos/MiniMax-AI/MiniMax-H3/pulls/44" --jq '{number, title, state, merged_at, head: .head.sha[0:10]}'
gh api "repos/MiniMax-AI/MiniMax-H3/pulls/8"  --jq '{number, title, merged_at}'
gh api "repos/MiniMax-AI/MiniMax-H3/pulls/7"  --jq '{number, title, merged_at}'

# 10) verbatim 校验（落盘后 git hash-object 应等于上游 blob SHA）
git hash-object docs/rules-h3-upstream/_snapshot/2026-11-22-first-baseline/SKILL.md   # == b6d9b283…d56
sha256sum docs/rules-h3-upstream/_snapshot/2026-11-22-first-baseline/*

# 11) 本仓 drift 检测脚本对基线的自检
python scripts/check_h3_upstream.py --baseline 2026-11-22-first-baseline   # 实测 exit 0, identical=4
```

## 8. 产出物落点

- 研究笔记（本文件）：`plugins/prompt-forge/docs/research/2026-11-22-issue-19-h3-official-skill-snapshot.md`
- verbatim 快照（4 文件 + SOURCE.md）：
  [docs/rules-h3-upstream/_snapshot/2026-11-22-first-baseline/](../../rules-h3-upstream/_snapshot/2026-11-22-first-baseline/SOURCE.md)
  - `SKILL.md`（sha256 `a7000443588ca3f145e3b3fd8900f14e0325dc460bd811268fac89a9dc8e56d0`）
  - `agents/openai.yaml`（sha256 `7770c9d784b7251ab882ee29a738219a3f01811e57ba7fc7822fa83eb8438c1a`）
  - `references/base-en.txt`（sha256 `2cfebc096a6e08370f288d468d90b60f7f9bcb938f94bf090816e910e48e75fc`）
  - `references/ref-en.txt`（sha256 `1e574f356716ad55612247ffb7bbccbcdb484ad96599d63c7dca1af186b1fab7`）
  - `SOURCE.md`（溯源 + 哈希表 + 机器可读契约行）
- 快照目录与官方 `skills/h3-prompt-writing/` 子树严格 1:1（含 `scripts/check_h3_upstream.py`
  对 SOURCE.md 键名 `official_dir:`/`source_url:`/`commit:`/`tag:` 的行首解析契约）。
