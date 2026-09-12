# 风格预设与美学系统：外部基准调研

- 日期：2026-09-12
- 调研目的：为 prompt-master 设计「完整风格预设库 + 美学分析系统 + NSFW 分级」建立外部基准。
- 方法：抓取各项目 README / 源码树一手资料；受网络环境限制（firecrawl 429、huggingface/civitai/danbooru 连接超时），部分项目以本地可验证数据（Anima tag-catalog、本仓库源码）补齐。
- 结论速览见 §8 对照矩阵；所有「来源」均为实际抓取页面。

---

## 1. ComfyUI-NewBie-LLM-Formatter（点名深挖）

来源：<https://github.com/SuzumiyaAkizuki/ComfyUI-NewBie-LLM-Formatter>（README 全文，107 stars，v1.3.6）

定位：ComfyUI 节点套件，用 LLM API 把自然语言/图片转成 NewBie 模型的 XML 提示词，或 Anima 等模型的纯文本提示词。

核心机制：

| 机制 | 细节 | 对我们的意义 |
|---|---|---|
| Agent 模式（v1.2.9） | LLM 生成中调用 DanbooruSearchOnline MCP 实时搜 Danbooru 标签库验证/补充标签；沿标签共现图谱扩展；4 级努力（Close/Low/Medium/High，Low=单轮批量搜索，Medium=≤8 轮循环，High=宽召回+wiki 释义 ≤10 轮）；MCP 不可用自动降级；重复工具调用 >3 次强制退出 | 与我们 catalog_search / dialect/catalog-recall 同构。它证明了「LLM+实时词表验证」是防 hallucination 的正确路线；我们已有同等能力，差距不在此 |
| Anima 模式输出格式 | `## Prompt`（tag 块 + 2-3 句英文 NL）+ `## 中文解释`（分点设计说明）；正例顺序：质量锚点（masterpiece, best quality, score_7, safe）→ 画师（@kantoku, @tiv, @mika pikazo, @anmi）→ 主体 → 特征 → 服装 → 装备 → 构图（upper body, close-up）→ 姿势表情 → 背景，再接英文 NL 段 | 与我们 dialect/anima.ts 的 SLOT_ORDER 装配完全同构（质量行→@画师→槽位→narrative NL）。说明我们的方言方向与社区实战一致 |
| 风格预设 | LPF_config.json 的 `styles` 对象：数十个预设，每个可标记适用模式（[NewBie]/[Anima]/[Both]）；XML Style Injector 节点注入；Style Preset Saver 节点把当前「画师+风格」组合存回配置 | **预设 = 扁平的 artist 列表 + style 串**（如 nb01：rella/tidsean/wlop/ciloranko/atdan + anime_style/realistic_shading）。没有构图/光影/配色的结构化拆解，没有负向，没有评级 |
| 画师注入清洗 | 删括号/`artist:` 前缀/权重冒号/孤立数字；名称内空格转下划线；加 @ 前缀（`rella → @rella`）；注入位置=质量词行之后整行替换 | 我们的 prompt_form 升级（裸名→@形）已等价；它多出的「artist_max 截断」语义值得吸收（本仓库 nb*.json 已带 `artist_max: 3` 字段但引擎未消费） |
| NSFW | 「深度思考与破限支持：内置 NSFW 提示词破限框架」；`gemini_jailbreaker` 字段；推荐模型表带「NSFW 效果」列（grok-4.1-fast 最好，dolphin-mistral 官方宣称无审查） | **它的 NSFW = LLM 侧破限**（对 API 供应商绕审查）。Anima 是本地模型无需破限；我们需要的是模型侧 rating 标签分层（见 §7），两者解决的是不同问题 |
| 增量修订 | 相同输入直接复用缓存；相似度 ≥0.55 走最小化修订；连续修改防累积偏移 | 我们 continue/ 模块已有同类机制 |

局限：无美学分析层；预设无结构化美学拆解；无确定性审计闸门（只有 XML 语法修复）；无输出侧质量闭环。

## 2. Fooocus（53k stars，LTS）

来源：<https://github.com/lllyasviel/Fooocus>（README + sdxl_styles/ 目录树）

- 风格库落在根目录 `sdxl_styles/`：6 个 JSON 包（`sdxl_styles_fooocus.json` / `_sai` / `_twri` / `_diva` / `_mre` / `_marc_k3nt3l`）+ `samples/`。合计约 200 个风格（跨 6 包，按文件清单核实；单包内条数未逐一统计）。
- 模板机制与 twri/sdxl_prompt_styler 同构（Fooocus 早期内嵌 py，后迁 JSON，twri 即其上游同款格式）：`{name, prompt(含 {prompt} 占位符), negative_prompt}`，正向=模板包用户文本，负向=模板负向+用户负向合并。
- 三个启动预设（default/anime/realistic）各自绑定模型+默认参数+风格默认值——「风格预设可以下沉到模型/采样配置层」的思想值得借鉴。
- GPT-2 离线 prompt 扩写引擎：短 prompt 自动补写质量词（「不依赖用户 prompt 功力」的产品思路）。

## 3. twri/sdxl_prompt_styler（920 stars）

来源：<https://github.com/twri/sdxl_prompt_styler>（README 全文）

- 模板 JSON 结构（原文示例）：

```json
[
  { "name": "base", "prompt": "{prompt}", "negative_prompt": "" },
  { "name": "sai-enhance",
    "prompt": "breathtaking {prompt}. award-winning, professional, highly detailed",
    "negative_prompt": "ugly, deformed, noisy, blurry, distorted, grainy" }
]
```

- 组装语义：正向=`模板.prompt.replace('{prompt}', 用户正向)`；负向=模板 `negative_prompt` 与用户负向合并（用户提供则拼在模板负向后）。
- 工程要点：**多 JSON 文件目录式加载**（目录内全部 .json，重名自动加后缀去重）；正/负/双向 bypass 开关；Advanced 变体支持 G/L token 拆分与负向切分行为选择。
- 对我们的意义：这是 ComfyUI 生态风格模板的事实标准 schema；「目录式加载 + 重名消解 + 正负成对」三件事直接抄。

## 4. InvokeAI（28.2k stars）

来源：<https://github.com/invoke-ai/InvokeAI>（README；docs 站 style_presets 页 404 未深入）

- 产品级生成引擎；style preset 是 UI 一等公民（预设库管理、从既有生成元数据一键保存为 preset、board/gallery 元数据回流）。
- 对我们的意义：**preset 的生命周期管理**（创建→应用→从成功产物反存→分享）比 preset 本身更稀缺；我们 feedback.sqlite（generations 90 天 + 反馈永久）已是天然的反存数据源。

## 5. LAION aesthetic-predictor（736 stars）

来源：<https://github.com/LAION-AI/aesthetic-predictor>（README 全文）

- 机制：CLIP embedding + 单层线性头（ViT-L/14: `nn.Linear(768, 1)`；ViT-B/32: 512→1），权重 `sa_0_4_*_linear.pth`；对图片打 1-10 美学分（人类评分训练）。
- 用途：LAION 数据集美学过滤（LAION-Aesthetics 子集）、clip-retrieval 集成。
- 对我们的意义：输出侧美学打分的**最简可用基线**——一个线性头 + CLIP，CPU 都能跑。适合做 camera-* 产物的事后打分（可选第二期）。

## 6. ImageReward（zai-org，1.7k stars，NeurIPS 2023）

来源：<https://github.com/THUDM/ImageReward>（README 全文；重定向 zai-org/ImageReward）

- 机制：137k 专家对比对训练的人类偏好奖励模型；对「(prompt, image)」打分，分数近似标准正态（μ=0, σ=1）；实验上理解人类偏好显著优于 CLIP（+38.6%）、Aesthetic（+39.6%）、BLIP（+31.6%）。
- 产品化用法（SD-WebUI 集成）：打分并写入图片元信息 → 低分自动过滤（设分数下限）→ 多图 inference_rank 排名；ReFL 用分数直接微调扩散模型。
- 对我们的意义：输出侧闭环的完整形态——**打分→过滤→排名→记录**四件事；与我们 prompt_feedback（1-5 分 + 负反馈词表 + actual_output_path）天然互补：RM 分数可自动填充 feedback 的客观半边。

## 7. 模型侧 rating 体系（Pony / NoobAI / Anima 本体）

网络限制：civitai（Pony V6 XL）、huggingface（NoobAI-X）连接超时，未取到一手页面。以**本地 Anima tag-catalog 实测**为准（2026-09-12，catalog_search）：

| tag | catalog 状态 | 备注 |
|---|---|---|
| `rating_explicit` | **canonical**（record 964555，prompt_form "rating explicit"） | 露骨档，可用 |
| `rating_sensitive` | **canonical**（record 964556，prompt_form "@rating sensitive"） | 敏感档（性暗示/泳装等），可用 |
| `rating:questionable` | fuzzy 候选（record 964548，usage_count=0） | 存疑档，弱 |
| `rating_general` | **无 canonical**（仅 fuzzy `ratings:general` usage=0） | 全年龄档缺失 |
| `safety` | canonical（record 1014547，usage_count=4） | 现行安全种子 tag |
| `score_7` / `score_1..3` | 方言 POLICIES 内建（anima.ts） | Pony 系质量梯度已被 Anima 内化：正向 score_7，负向 score_1..3 |

结论：Anima 的 rating 词表**部分存在**（explicit/sensitive 扎实，questionable/general 弱）。NSFW 设计应以 `rating_sensitive` / `rating_explicit` 为主轴 + `safety` 为安全种子，不依赖 rating_general/questionable（可用 overlay/catalog_relations 逐步补全，cooccurrence 类关系按规则拒收）。

当前插件对 NSFW 的全部处理（anima.ts 实测）：
- `AnimaSlots.explicit` 槽 + `EXPLICIT_SAFETY_MARKERS` 关键词扫描（nude/nsfw/乳头/裸露/色情…）→ `isExplicitRequest()`；
- 非 explicit 请求：正向注入 `safety` 种子（priority 99）；explicit 请求：**只是不注入 'safe'**，无分层、无策略差异、无边界闸门。
- 即现状 = 一个布尔开关，不是「支持 NSFW」。

## 8. 对照矩阵（机制 → 来源 → 采纳方式）

| # | 机制 | 成熟来源 | 我们怎么用 |
|---|---|---|---|
| 1 | 统一模板 schema + 正负成对 + 目录式加载/重名消解 | twri, Fooocus | 风格预设 v2 schema 的骨架 |
| 2 | 画师混搭为核心杠杆 + artist_max 截断 + @清洗 | NewBie | 保留 artistHints，消费 nb*.json 的 artist_max；catalog 验证已有 |
| 3 | 预设按模式分档（NewBie/Anima/Both → 我们的 anima/h3/sd） | NewBie | `applies_to` 字段已有，全部预设必须带 |
| 4 | 质量锚点行（masterpiece/best quality/score_7/safe） | NewBie 正例 ≈ 我们 POLICIES | 已有；NSFW 分级时按 rating 替换/追加锚点 |
| 5 | 模型侧 rating 分层（sensitive/explicit 主轴） | NoobAI/Pony（间接） + Anima catalog 实测 | NSFW 三档分级的词表基础 |
| 6 | LLM 侧破限框架 | NewBie | 不采纳：Anima 本地模型，走 rating 标签而非破限 |
| 7 | 美学结构化拆解（构图/光影/配色/动势成卡） | 我们已有的 art-direction 36 卡（外部项目均没有这层） | **领先项**：把「选卡」变成美学分析系统的输出 |
| 8 | 输出侧打分闭环（打分→过滤→排名→记录） | ImageReward, LAION | 第二期可选：camera-* 产物 → RM/CLIP 分 → 回写 feedback |
| 9 | 从成功产物反存预设（preset 一等公民） | InvokeAI | 预设 CRUD 工具面（list/get/save）+ feedback 数据回流 |
| 10 | 短 prompt 自动增补（GPT-2 引擎思想） | Fooocus | 已由 enrich 七维度扩写覆盖，不重复建设 |

## 9. 本地现状盘点（设计输入）

- `src/pe-framework/enrichment/style.ts`：MINIMAL_STYLES 11 个（cinematic_real/game_cg/cel_shading/thick_paint/cyberpunk/wafuu/wasteland/dark_epic/watercolor/concept_art/fairy_tale），字段 id/name/base/theme/palette/prompt_fragments{image,video}/artistHints×3/applies_to/negative_hints；**negative_hints 是死数据（applyStyle 未接线）**；conformity 三档注入语义已实现。
- `assets/style-presets/nb01..nb65`：44 个 JSON（{id,name,rating:"safe",source,artists[],artist_max,style_tags[]}），**grep 证实无任何代码引用，纯死数据**。
- `src/pe-framework/enrich/art-direction.ts`：五类 36 卡（perspective 8 / composition 8 / lighting 8 / color 6 / motion 6），LIGHTING_BAN 审计兼容。
- `src/pe-framework/aesthetics/lexicon.ts`：电影摄影词库 6 类（景别/焦段/运镜/光线/调色/构图）；check.ts 具体性/保真检查。
- `src/pe-framework/eval/rubrics/h3.ts`：H3 评委 9 维加权 rubric（结构/增量/一致性/时长/节奏/氛围耦合/表演因果/出入镜/运镜动机），passThreshold 75。
- NSFW：仅 explicit 布尔关断（§7）。
- 测试基线：831 passed / 1 skipped（plugin AGENTS.md）。
