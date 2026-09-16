# PromptMaster 提示词大师 3.1.0 — 第二轮深度吸收分析（被首轮遗漏的设计与机制）

> 分析日期：2026-08-31
> 源码根：`temp/pm-promptmaster-src/unpacked/public/electron/`（javascript-obfuscator 混淆，本次已全部还原为可读源码，`*.deob.js` 与源文件同目录）
> 首轮已覆盖内容（48 个 profile 家族、captionLength、tagLineSanitize、taxonomy、renderer、FIDELITY_CHECKLIST、anima3 §1-§5、minimax 模板）**不再重复**。
> 本轮聚焦：service 层驱动机制、controller API 面、首轮欠分析的 config、utils 里的跨切面管线。

---

## 0. 源码状态说明（重要前提）

全仓库 Electron 主进程代码经 javascript-obfuscator 字符串数组混淆。本次用 Node 探针还原了每个文件的解码表并把 `_0xABCD(0x123)` 内联为明文字符串，产物为同目录 `*.deob.js`。下文引用行号均指 `*.deob.js`。

---

## 1. 结构感知续写引擎 `continueExpandUntilComplete` ⭐ 本轮最核心发现

**位置**：`utils/expandOutputContinue.js`（全文，入口 `continueExpandUntilComplete` :132-156）

**它是什么**：所有扩写路径（本地 llama 与在线 zhipu/ollama/xflow）共用的"生成 → 结构校验 → 断点续写 → 合并"循环。PromptMaster 对"模型输出被 max_tokens 截断"和"模型漏写章节"不是简单重试，而是**结构化验收 + 定向续写**。

**机制拆解**：

1. **输出契约（contract）**（`resolveExpandOutputContract` :54-66）：按 peId 从 minimax 场景目录解析出三种契约——`none`/`loose`（不检查）、`full_reference`（六段：subject_definitions + 5 组字段）、`director_segments`（N 组「提示词组」，N 来自表单 `segment_count`，默认 4）。契约带语言（zh/en）。
2. **结构验收器**（`inspectExpandOutput` :81-101）：用中英双标签正则（`labelRegex` :25-27，匹配 `摘要:`/`summary:`/`### 摘要`/`**summary**:` 等）逐字段检查"标签是否存在 + 标签体是否非空"（`labelBodyLen` <2 字符视为空，末段正文为空会补报 `music_body` 缺失）。director 模式还用 `={3,} 提示词组 N ={3,}` 分隔符正则切组（`splitDirectorGroups` :67-80），逐组验收，缺失项报告成精确清单（如 `2:detailed`、`groups:3/4`）。
3. **续写触发**（`shouldContinueExpand` :102-105）：结构不完整 **或** finish_reason ∈ {length, max_tokens, max_token, limit}（`isLengthFinish` :45-47，四种写法全兼容）即续写，上限 `EXPAND_CONTINUE_MAX=3`。
4. **续写消息构造**（`buildContinueUserMessage` :121-131）：把**已写全文**包进 `已写出（不要重写）：----- ... -----`，并按契约追加定向指令（"需要恰好 N 组…目前已有 M 组"/"请补全六段…"），中英双语各一套。历史消息 = 原始 messages + assistant(累计全文) + user(续写指令)。
5. **重叠感知合并**（`mergeContinuedText` :106-120）：续写片段先剥寒暄前缀（`好的，`/`继续输出：`/`如下：`），若新文以旧文开头（模型复读）直接取新文；再做**后缀-前缀重叠匹配**（旧文尾部 12–240 字符在新文头部的位置探测），命中则去重拼接；否则换行拼接。
6. **健壮性**：每轮前查 `shouldAbort()`（用户手动停止即时退出，:137-141）；中途 generate 报错但已有部分文本时**保留部分结果**并附 `INCOMPLETE_EXPAND_WARNING`（:142-146）；每轮经 `strip` 回调剥离 `<think>` 标签后再合并（由调用方注入 `_stripThinkingTags`）；`onContinue(n,max)` 回调驱动 UI 进度提示。

**调用方证据**：

- 本地：`service/pm_text_expand.js.deob.js` :108-123（contract + `userRequestedStop` + thinking 剥离注入）
- 在线：`service/prompt_master.js.deob.js` :892-903（同一循环复用于 zhipu/ollama）

**为什么有价值**：这是 PromptMaster 输出质量的兜底引擎，直接解决 DSH prompt-master 插件在长模板（minimax full-reference、director 多组）下"输出截断/漏段"问题。且它是引擎无关的（generate 函数注入），可原样移植到任何 LLM 路由。

**吸收建议**：

- 移植 `continueExpandUntilComplete` 全套（contract/inspect/merge/continue-message 四件套），generate 回调对接 DSH 的模型路由；`labelRegex` 的中英双标签表按插件现有模板字段名扩展。
- 工作量：**M**（核心 ~200 行，无外部依赖；主要是字段标签表要与插件模板对齐）。
- 依赖风险：低。minimax 场景 peId → contract 的映射若不移植场景目录，可改为插件配置里声明契约。

---

## 2. PE Profile 存储模型：内置不可变基座 + 用户覆盖层 + 单条导入导出

**位置**：

- `service/pm_prompt_engineering.js.deob.js`（`loadStore` :92-107、`saveStore` :123-128、`mergeWithBuiltins` :59-67、导入导出 :225-313）
- `config/peImportValidation.js.deob.js`（全文）

**机制拆解**：

1. **双层存储**（`prompt_engineering.json`，位于 `<workspace>/promptmaster/data/`）：
   - `profiles`：只存**用户自建**工程（`saveStore` 落盘时把 `builtin:true` 的条目剔除，:124-125）；
   - `builtinOverrides`：内置工程只持久化 `{id, enabled, sort}` 三个字段（:125-126）——内置 prompt 正文**只活在代码里**（`promptEngineeringRegistry`），升级即全量更新，用户不会钉死在旧版提示词上。
2. **读取时合并**（`mergeWithBuiltins` :59-67）：代码内置全表 + 磁盘覆盖层 + 用户工程 → 按 sort/name 排序输出。还带"自愈"：`sanitizePeFilePayload` 发现磁盘上有过期的 builtin 全量元数据（旧版本残留）会清理重写并打 dirty 日志（:103-107）。
3. **导入验证**（`peImportValidation.js`）：导出格式打标 `format: "prompt-master-prompt-engineering"`（`PE_EXPORT_FORMAT`）；四种 payload 形态（export-single / export-legacy / bare 单对象 / single 数组取一）；`isPeProfileLike` 白名单校验（kind ∈ {expand,reverse,train} + name + systemPrompt 非空 + 拒绝 builtin）；**单条策略**——多于一律拒绝（"仅支持导入单条"）；`pickSingleImportableProfile` 还拒绝 id 与内置冲突的条目。
4. **导入即重铸**（`importProfilesFromPath` :285-313）：导入条目一律 `pe_custom_+randomUUID()` 重新赋 id、重置 createdAt/updatedAt，杜绝 id 碰撞与内置伪装；`validateImportFile`（:254-273）提供**导入前预检**，向 UI 返回人话结论（"可导入至「反推」：xxx"）。
5. **normalizeProfile**（peImportValidation :1 区段）：每个字段做类型收敛 + 默认值兜底（未命名/999 排序/缺 category 推断），保证进库数据形状统一。
6. 附加：`filterProfilesList`（service :72-87）按 kind/启用/输出格式/主体域/全文关键词过滤；`toUiProfile`（:137-141）把内部 profile 富化成 UI 视图（toriiFormat/structuredFormat/minimaxScenarioId/formFields 等能力位透出）。

**为什么有价值**：DSH 插件的 prompt 工程库迟早要面对"内置随插件升级 + 用户自定义 + 分享导入"三件事。PromptMaster 的"内置只存覆盖、导入重铸 id、导出打 format 标"是经过产品化打磨的最小方案。

**吸收建议**：

- 采用同样的双层存储（插件 data 内 JSON：`profiles` + `builtinOverrides`），merge 函数照搬；
- 若做 profile 分享/导入，移植 `validatePeImportPayload` + `pickSingleImportableProfile` + 导入重铸 id 全套；
- 工作量：**M**；依赖风险：低（纯文件逻辑）。

---

## 3. JoyCaption「附加选项」真实实现：三段式硬约束体系（可复活）

**位置**：

- `config/joyCaptionExtraOptions.js.deob.js`（全文）
- `config/joyCaptionExtraPromptEngineering.js.deob.js`（全文）
- `config/captionExtraOptionSanitize.js.deob.js`（全文）
- 生效点：`service/joycaption.js.deob.js` :494（`applyJoyExtraOptionCaptionSanitize`）与 :508（system 注入）、:531（user 尾巴）

**首轮记录为 "no-op" 是误判**。真实实现是**提示注入 + 输出后处理**双保险：

1. **选项定义与兼容识别**（joyCaptionExtraOptions）：四个选项 id（`no_glasses_headwear` / `scene_only_no_character_appearance` / `no_artistic_style` / `character_name`）+ 每个选项的英文标准句；`hasJoyExtraOption`（:18-27）优先读结构化 `joy_extra_options` 数组，**回退用正则去嗅探自由文本 `extra_prompt` 里是否已含标准句**（同一选项历史写法三种变体都认），`resolveJoyCharacterName`（:43-47）从 `refer to them as XXX` 里抓角色名。
2. **System 端最高优先级强制块**（joyCaptionExtraPromptEngineering :50-58）：`buildJoyExtraSystemEnforcementBlock` 生成中/英双语块，明确宣告"附加要求是硬约束，**优先于还原检查表、还原框架、'有则必写'清单及任何冲突的工程默认指令**"；`buildConflictOverrides`（:42-49）为每个启用选项生成一句"冲突豁免令"——例如"不写眼镜/头饰：即使面部检查表要求写眼镜、面具或头饰，也必须完全省略"，并内置选项间冲突仲裁（"不写不可变属性"与"不写外貌"冲突时以不写外貌为准）。`character_name` 选项生成"统一称呼：只能用「名」，禁止 person/character/人物/角色 等泛称"。
3. **User 端优先级尾巴**（`buildJoyExtraUserEnforcementTail` :58-64）：在用户消息末尾再钉一次"附加要求与上文任务句冲突时附加要求获胜"。
4. **输出端子句过滤**（captionExtraOptionSanitize）：`splitCaptionClauses`（:26 区段，按 中英标点/换行 切句，`pickClauseSeparator` 记住原文用的分隔符）；两组正则——`GLASSES_HEADWEAR_CLAUSE_PATTERNS`（眼镜/护目镜/墨镜/帽子/头盔/发箍/皇冠/面具/头巾…含 `头戴.*镜`、`佩戴.*镜` 组合式）与 `APPEARANCE_CLOTHING_CLAUSE_PATTERNS`（肤色/胎记/疤痕/妆容/五官/发型/服装/身材…含 "胸/背/肩/腰 + 0-12 字 + 痣/斑/痕" 的位置组合式与英文词表）；`filterCaptionClauses`（:70 区段）把命中禁选主题的**子句整句剔除**再按原分隔符拼回；若无子句幸存则原样返回（防全灭）。对外暴露 `sanitizeNoGlassesHeadwearCaption` / `sanitizeNoCharacterAppearanceCaption`。

**为什么有价值**：这是"用户禁选主题"问题的完整闭环：prompt 端声明优先级 → 模型仍泄漏 → 输出端兜底切除。DSH 插件的 FIDELITY_CHECKLIST 是"必须写"方向，这套是"必须不写"方向，二者互补。

**吸收建议**：

- 移植三件套；`captionExtraOptionSanitize` 的子句过滤可直接作为 prompt-master 输出后处理管线的一级（与已移植 tagLineSanitize 并列）；
- "标准句 + 正则嗅探"的兼容识别模式可用于插件已有的自由文本附加要求解析；
- 工作量：**S**（三个文件合计 ~300 行，纯字符串/正则）；依赖风险：低。正则面向中文打标语料，需按插件场景微调模式表。

---

## 4. 打标输出净化链：按模型家族分流的最终文本提取器

**位置**：`service/joycaption.js.deob.js`

- 分流入口 `extractFinalCaptionText` :482-494
- Qwen 定界符封套：`extractQwenDelimitedCaption` / `stripQwenCaptionDelimiterArtifacts` :131-141、强限定格式块 `buildQwenStrictDelimiterBlock` :495-499
- "润色尾巴"提取 `extractQwen35PolishedTail` :142-157（`润色与精简:`/`精简后:`/`最终输出:`/`Final polished caption:` 等 8 种正则，取**最后一次**命中之后的文本）
- 教程行过滤 `isEnglishInstructionEchoLine` :158-167、结构化标题剥离 `normalizeQwen35EnglishSectionLines` :168-192（把 `Style / Aesthetic:`、`Draft:`、`Keywords:` 等标题行剥掉并合并、全英文逗号行去重合并）
- 中文混合垃圾净化 `sanitizeQwen35ZhMixedGarbage` :299-320（剔除 `核心词:`/`光影/质感:`/`第 N 层`/`草稿 N`/`*优化` 结构行、英文逗号 tag 行）+ `sanitizeZhStableDiffusionKeywords` :236-292（逐子句垃圾分类器 ~30 条规则：括号英译、`- 解释`、`参考示例「…」`、问句、"似乎"、超长子句……先取最后一个垃圾子句之后的段、再取最长合法子串回救、再全局去重）
- **格式示例块** `buildQwen35FormatExampleBlock` :346-377：给模型一个"严格示例"，并明示契约"**只准复刻结构骨架（分隔符/单行/前缀标签），禁止复述示例中的词**"（中英双语两版，e621/Danbooru/SD/MidJourney 各有示例）。
- 防思维链输出契约：`buildQwenSystemOutputConstraints` :376-452 区域，FORBIDDEN 清单极细（"这张图片/我需要/关键词构思/整合/组合成/精简并优化/答案：" 全列名禁止）。

**机制总结**：模型无关的"打标产物清洗流水线"——模型家族判定（见 §5）→ 定界符封套提取 → 润色尾巴提取 → 教程行/标题行剥离 → 语言×类型相关的关键词净化 → 专用引擎（CaptionPE/tagLineSanitize）或通用（质量前缀 + JoyExtra 过滤）。**prompt 端与 parse 端成对设计**：system 里要模型输出 `<<<DELIM>>>` 封套，解析端按封套提取；要"润色尾巴"，解析端就抓尾巴。这是对付小模型"话痨/教程体/复述示例"的系统化解法。

**为什么有价值**：DSH 插件目前只有 tagLineSanitize 链；这套"按模型家族 + 按输出语言 + 按 caption 类型"三维度分流的净化树，以及"prompt 端约定标记 → 解析端提取"的成对设计，可直接嫁接到插件 renderer 输出侧，显著提升本地小模型（Qwen/Gemma）产物可用率。

**吸收建议**：

- 先移植与模型无关的通用层：润色尾巴提取 + 教程行/标题行剥离 + 定界符封套（配套一个可选的 system 块）；
- 中文 SD 关键词垃圾分类器按需裁剪移植；
- 工作量：**M→L**（通用层 S，中文垃圾分类器规则表大，需回归测试）；依赖风险：中（正则与插件 prompt 文案要联动，单移 parse 不移 prompt 端标记会失效）。

---

## 5. 模型能力矩阵：家族推断 + 能力默认值合并

**位置**：

- `config/captionModels.js.deob.js`（全文）
- `config/captionModelCapabilities.js.deob.js`（全文）

**机制拆解**：

1. **家族推断**（`inferCaptionModelFamily` captionModels :39-51）：单一函数把任意 model key 收敛到 `joycaption | torii | qwen3vl | qwen35 | gemma4 | hymt | zhipu | ollama | generic`，规则 = 精确匹配 + 名称正则（`/qwen3[._-]?vl/i`、`/^qwen3_5_(9b|4b|27b)(_abliterated)?$/`）+ **子目录名反查递归**（`CAPTION_MODEL_SUBDIR_MAP` 把磁盘目录名 `Qwen3-VL-8B-Instruct-abliterated` 映射回 key 再递归推断）。配套 `isLikelyVisionCaptionModel`（qwen35/qwen3vl/gemma4/torii 算视觉系，:61-63）。
2. **能力记录**（`getCaptionModelCapabilities` capabilities :28-35）：每家族一条 `{mediaTargets, lockedOutputLang, defaultTemperature, defaultTopP}`——torii 只吃图、输出锁英文、默认 temp 0.5/top_p 0.8；joycaption 无媒体目标、锁英文；qwen35 系吃 image/video/mixed、语言不锁。
3. **能力合并**（`applyModelCapabilitiesToCaption` :42-45）：**只填用户未显式指定的字段**（temperature/top_p 为 null 才用家族默认；caption_lang 被锁则强制覆盖）。
4. `isMediaTargetAllowed`（:36-38）在任务入口做媒体类型守门（视频打标任务不会被路由到 torii）。

**为什么有价值**：插件已移植 48 profile 但模型侧只有静态假设；这层把"模型能干什么、该用什么默认采样参数、输出语言锁什么"收敛成一个纯函数矩阵，新增模型 = 加一行映射。它同时是 §4 净化分流的**路由依据**。

**吸收建议**：移植两个文件（合并成一个 capability 模块），把插件的模型路由（本地 GGUF / 在线）接入；工作量 **S**；风险低。

---

## 6. 多媒体身份映射的 Multimodal User 消息构造器

**位置**：`service/prompt_master.js.deob.js` :756-828（`_buildMediaExpandMultimodalUser`）+ `utils/expandMedia.js.deob.js`（`enumerateTaggedMedia` :20-37）

**机制拆解**：

1. **媒体枚举打标**（expandMedia :20-37）：把混排路径列表变成 `{path, kind(image/video/audio/file), n, tag:"<Picture 1>", base}` ——**每份素材获得稳定身份标签**。
2. **按 Provider 分形构造 user content**（prompt_master :756-828）：
   - ollama 原生：images 是**扁平 base64 数组**，无序号语义 → 文本里手工重建映射表："1. The attached image #1 IS <Picture 1> (file: xxx)"；视频抽 6 帧则声明 "#4–#9 是 <Video 2> 的关键帧，视为同一个视频"；音频只给路径行 "(Audio path only)"。
   - zhipu/OpenAI content blocks：每个媒体前插一个 text 块 `"\nThis image IS <Picture 1> (file: xxx):"`，即**身份声明紧贴媒体块**，并统一加 "Do not swap identities" 头。
   - 视频超 API 大小上限（`ZHIPU_REVERSE_VIDEO_MAX_BYTES`）→ 自动降级为 ffmpeg 抽 6 关键帧（`_extractVideoFramesBase64` :144-164，先 `_probeVideoDurationSec` 用 ffprobe 探时长）。
   - 全部媒体不可附 → 优雅降级回纯文本模式。
3. **旧版 Gate 产物还原**（expandMedia :74-129）：识别历史版本用 `<<<SKILL_GATE>>>…<<<END_SKILL_GATE>>>` 包裹的 JSON 问卷；若判定为"最终交付包"（`looksLikeFinalPackageGate`：标题/摘要命中 final package 正则，或 ≥2 个交付字段或 ≥3 个 ≥50 字字段）则序列化回 Markdown 包；否则剥掉 gate 段保留正文。
4. **前言剥离**（expandMedia :129-149 `stripExpandFinalPreamble`）：切掉"根据已确认/问询历史/现在进入/最终交付…"式的开场白块（`---` 分段 + 逐行嗅探）。

**为什么有价值**：多图/图+视频混排时模型"张冠李戴"是插件做 minimax full-reference、多参考扩写的头号痛点。这套"稳定标签 + 贴身身份声明 + 帧-标签区间声明"是目前看到的最完整工程解。Gate 产物还原与前言剥离则属于通用的"模型格式漂移"修复件。

**吸收建议**：

- 移植 `enumerateTaggedMedia` + 两种 provider 的消息构造（可只做 OpenAI-compatible 一种）+ ffmpeg 抽帧降级；
- Gate 还原与前言剥离作为输出后处理可选项；
- 工作量：**M**（ffmpeg 依赖在 DSH 侧可用现有 camera-* 基建）；风险：中（不同 provider 的多模态消息 schema 差异）。

---

## 7. 在线批量反推/打标循环：进度事件 + 逐项计时 + 可取消

**位置**：`service/prompt_master.js.deob.js` :407-487（`_runOnlineBatchReverseLoop` / `startOnlineBatchReverse`）

**机制拆解**：单例锁（`_onlineReverseRunning`）+ 与本地打标互斥（`joycaption.getIsRunning()`）；前置连通性检查（zhipu 查 key、ollama ping `/api/tags`）；`AbortController` 挂批次；每项：发 `pm_reverse_progress {stage,path,index,total}` → 构造 prompt → 调用（signal 传入 axios）→ `extractFinalCaptionText` 统一净化 → 可选 sidecar 落盘 → 发 `pm_reverse_result {success}`；异常分类（axios 取消 → 静默终止批次；其它 → provider 定制错误格式化，zhipu 的 `_formatZhipuApiError` 会按错误特征**追加模型选型建议**，如"当前模型为思考型视觉模型，建议 glm-4.5v"，:732-737）；每项/整批计时写日志。**逐项隔离**：单个失败不终止批次，错误记录在结果事件里。

**为什么有价值**：插件的批量能力（若做数据集打标/批量扩写）可直接复用这套"互斥锁 + AbortController + 每项双事件 + 计时 + 单项失败不塌方"的骨架。

**吸收建议**：作为模式吸收（不必移植代码）；工作量 **S**；风险无。

---

## 8. 本地推理编排：后端探测缓存 + 人话错误分类学 + 自动卸载

**位置**：

- `service/inference/backend_resolver.js.deob.js`（全文）
- `service/inference/inference_messages.js.deob.js`（`formatInferenceStartupFailure` :31-49、`formatInferenceRuntimeError` :56-66）
- `service/inference/gpu_model_lifecycle.js.deob.js`（全文，40 行）
- `service/pm_text_expand.js.deob.js` :64-71（推理后自动卸载挂钩）

**机制拆解**：

1. **后端探测**：候选后端按平台排序（win: cuda_* → vulkan → cpu；mac: default(Metal)），`backendCache` JSON 带 `platformArch` 校验防换机错用；缓存为 cpu 时**忽略缓存重新探测 GPU**（:61-63）；win 下先 `nvidia-smi --query-gpu=name` 探卡，无 N 卡则直接剔除 cuda 后端返回 `reason:"no_nvidia_gpu"`。
2. **错误翻译学**：把 llama-server 原始 stderr 分类成可行动中文——权限/quarantine（附 macOS chmod/xattr/codesign 具体命令）、启动超时（区分"被安全机制拦截"vs"模型大加载慢"，附换 Q4_K_M 建议）、GPU OOM（附关闭占用程序/换小量化建议）、mmproj 缺失（附"放配套 mmproj 或改用智谱/Ollama 视觉"出路）、**上下文溢出**——用正则从原始错误里抠出 `request (N tokens)` 与 `context size (M tokens)` 两个数字回填到人话消息（:59-63）。stderr 摘要器取**最后一条**含 error/fatal 关键字的行再剥技术术语。
3. **自动卸载**：设置项 `pm_auto_unload_gpu_model` 开启时，每次推理结束 `maybeAutoUnloadGpuAfterInference()` 卸载 llama-server 释放显存（40 行小模块，挂在 expand/caption 收尾处）。

**为什么有价值**：插件若接本地 llama.cpp，这三件（探测缓存、错误翻译、用后卸载）决定"能跑"和"好用"的差距。错误→数字回填的上下文溢出消息尤其实用（用户能直接算出该调多少 ctx）。

**吸收建议**：作为模式与文案库吸收；若插件已用 DSH 的推理基建则只吸收错误分类表；工作量 **S-M**；风险低。

---

## 9. 提示词库：工作区级 SQLite + JSON 迁移 + 默认文件夹不变量

**位置**：`service/pm_library_db.js.deob.js`（:37-233）+ `service/pm_free_limits.js.deob.js`

**机制拆解**：

- 每工作区 `<ws>/promptmaster/data/library.sqlite`（WAL + foreign_keys），四表：folders/tags/prompts/prompt_tags，带三条索引（:46-48）。
- **JSON→SQLite 迁移**：首次打开若表空且存在 legacy `library.json`，事务内全量导入（缺 folder 一律归入默认文件夹、folder sort 缺失按序补），成功后旧文件改名 `.migrated.bak`（:117-120）。
- **默认文件夹不变量**：`DEFAULT_FOLDER_ID` 固定，不可改名/删除（:178、:205），删除文件夹时其下 prompts **回迁默认文件夹**而非删除（:206-209）；默认文件夹在列表中**永远钉在最后**（`pinDefaultFolderLastInRows` :52-56，sort 动态重算）。
- `savePrompt` 用 upsert（`ON CONFLICT DO UPDATE`）且**保留原 created_at**（先 SELECT 再回填，:150-153）；标签关联整删重插于同一事务。
- 免费额度（pm_free_limits）：prompts 50 / tags 5 / custom folders 5，断言式（编辑已有条目不受限，只在新增时拦）。
- `dbCache` 按路径 resolve 后缓存连接。

**为什么有价值**：插件做提示词库/收藏夹时的数据层范式：工作区自治（库跟着工作区走）、迁移留 bak、默认容器不可毁。免费额度断言模式对插件做限额也有参考。

**吸收建议**：按需吸收数据层范式（DSH 侧可用 jsondb 起步，保留迁移+bak 思路）；工作量 **S**（模式）/ **M**（若真上 SQLite）。

---

## 10. SKILL.md 基建（潜伏特性）：Markdown frontmatter 补丁器 + 内置技能包发现

**位置**：

- `config/skillMarkdown.js.deob.js`（全文）
- `config/builtinSkills.js.deob.js`（全文）
- 工作区目录含 `skills/`：`service/prompt_master.js.deob.js` :497（`ensureDirs` 建 `data/covers/uploads/cache/exports/_caption_tmp/datasets/skills`）

**机制拆解**：

1. `parseSkillMarkdown`（:23-77）：**零依赖 YAML-lite 解析器**——frontmatter 支持：标量（去引号）、内联数组 `[a, "b"]`（`parseInlineList`+`stripQuotes`）、块标量 `|`/`>`（缩进 2 收敛）、**嵌套对象**（空值后缩进键值对收成 map）；跳过注释/纯缩进行。
2. `patchSkillMarkdown`（:136-148）+ `upsertYamlRootKey`（:107-135）：对已有 SKILL.md **外科手术式改写**——只替换/追加指定根键（name/description/body），根键定位用 `^key\s*:` 正则、值域扫描含块标量多行与嵌套缩进的边界判定；description 长于 50 字或含换行自动转块标量（`formatYamlBlock`）；body 整体替换并重建 `---\n…\n---\n` 骨架。
3. `sanitizeSkillFolderName`（:78-82）：小写化 + 非法字符→`-` + 截 50。
4. `builtinSkills.js`：内置技能根目录四级回退探测（extraResources → `vendor/minimax-h3/MiniMax-H3-main/skills`（**PromptMaster 直接 vendored 了 MiniMax-H3 官方技能包**）→ build/extraResources/builtin-skills → 相对 __dirname），并验证子目录里确有 SKILL.md / skill.md / **SKILL.cn.md**（中文版技能文件是一等公民，`findSkillMdFileName` :83-91 优先 zh 变体）。

**为什么有价值**：证实 PromptMaster 在向 **Agent Skills 生态**靠拢：每个提示词工程可物化为带 frontmatter 的 SKILL.md 目录（含中英双版），且拥有完整的"读-改-写不破坏用户手写内容"工具。DSH 本身就是技能生态——插件若提供"把 PE 工程导出为 DSH 可挂载的 skill 目录"，`patchSkillMarkdown` 的 upsert 语义（升级时只动 name/description 不动用户正文）正是需要的。

**吸收建议**：移植 `skillMarkdown.js` 全套（自足无依赖）作为"工程→SKILL.md 导出/升级"的底层；中文变体文件名约定（SKILL.cn.md）照抄；工作量 **S**；风险低。注意主进程当前**没有任何调用方**（仅模块自身），属未接线特性——吸收时按插件需求自行接 UI。

---

## 11. 扩写长度/Token 预算体系

**位置**：`config/promptExpandRules.js.deob.js` :60-109 + `config/localTokenLimits.js.deob.js`

**机制拆解**：

- 五档长度预设（极简→超长），每档三元组：`maxTokens`（128/256/512/768/1024）+ `hintZh/hintEn`（写进 prompt 的篇幅约束文案，如"约 150～300 字，兼顾画面信息量与可读性，不要明显偏短或偏长"）+ `labelUi`。
- **自定义字数**：`resolveExpandLengthSpec`（:84-96 区段）对任意正整数 N 生成 `maxTokens = clamp(ceil(N*1.8), 128, 上限)`——1.8 的中文字符→token 经验系数 + 双侧 clamp，同时生成"目标约 N 字…不要明显过短或远超"的对称约束句。
- 用户可调本地 token 上限（`localTokenLimits`）：expandMax/reverseMax/mediaExpandMin/ctxSize 四键，各带 `BOUNDS` min/max，`parseLimitSetting` 对设置值做 parseInt + clamp 防呆（:28-33）。
- 输出语言锁（`applyOutputLanguage`/`getOutputLangUserLock`，首轮未列）：zh 锁时注入【最高优先级】语言锁定句，且允许"输入是英文 tag 也必须输出中文"级别的强指令（prompt_master.js :867）。

**为什么有价值**：`maxTokens = ceil(chars*1.8)` 系数法与 BOUNDS clamp 是插件可直接复用的 token 预算公式；分档 hint 文案（中英对仗）可直接并入插件模板变量。

**吸收建议**：公式与文案吸收，工作量 **S**。

---

## 12. Controller API 面（产品能力全景，用于对照查缺）

`controller/prompt_master.js.deob.js` :34-148 共 **45 个 action**，分七组：

- 提示词库：listAll / savePrompt / deletePrompts / saveFolder / deleteFolder / reorderFolders / saveTag / deleteTag / saveCover / copyCoverToClipboard / importImageFile / suggestTags（按文本包含匹配自动荐标签，:512-520）
- 反推/打标：reverseImage / checkCaptionModel / startBatchReverse / stopBatchReverse / warmupCaptionPython
- 扩写：expandText / stopTextExpand / listExpandRules / listExpandLengths / getLocalTokenLimits
- 提示词工程：listPromptEngineering / getPromptEngineeringTaxonomy / save / delete / setEnabled / getTemplate / **export / import / pickImportFile / validateImportFile**（预检独立成 API）
- 翻译：translate / testBaiduTranslate / startHyMtTranslate / stopHyMtTranslate（**本地 HY-MT1.5-1.8B 翻译模型**，`service/hy_mt_translate.js`，离线中英互译）
- 本地推理：probeLlamaRuntime / warmupLlamaServer / llamaRuntimeStatus / stopLlamaServer / listGpuLoadedModels / unloadGpuModel / checkGgufModel / listGgufVariants / listWorkspaceModels / getGgufDownloadPlan / initGgufManifest / downloadGgufModel（GGUF 模型下载器带**下载计划**与清单模板初始化，`config/ggufModelManifest.js` 19K）
- 引擎测试：testZhipuApi / testOllamaApi

**值得注意的产品设计**：`validateImportFile` 与 `import` 分离（先预检后导入）；`testXxxApi` 三个连通性测试动作；`warmup`/`unload` 显式分离（预热与显存回收都是用户可见操作）；多引擎扩写统一 `expandText` 入口按 `engine` 参数路由（prompt_master.js :995-1052 → `expandTextByLlm(engine)` :841）。

---

## 13. 杂项高价值小件（速览）

| 件              | 位置                                               | 一句话                                                                                                             |
| --------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 思考标签剥离    | pm_text_expand :60-63                              | `[\s\S]*?<\/think>` 全删 + `思考：…` 段删；注入续写循环 strip 回调                                                 |
| 智谱产物清洗    | utils/zhipuChatText.js（stripZhipuModelArtifacts） | 推理/工具占位符、思考型模型无效输出检测 + 带模型建议的错误文案（prompt_master :732-737）                           |
| Caption sidecar | utils/captionSidecar.js                            | 模型输出→JSON 提取（```json 围栏 + 首尾大括号切片）→pretty→随媒体写 sidecar；数据集打标时 caption 文件直接落媒体旁 |
| 工作区路径纪律  | config/workspacePath.js                            | 每级目录名 `[a-zA-Z0-9_-]+`、禁 UNC/非 ASCII——为训练管线兜底                                                       |
| 媒体目标守门    | captionModelCapabilities :36-38                    | 任务入口按 mediaTargets 拒绝不可能的模型×媒体组合                                                                  |
| 服务互斥        | pm_text_expand :140-144 / prompt_master :456-460   | 扩写与打标跨服务互斥（`getIsRunning` 交叉检查），防双任务抢 GPU                                                    |
| 双语文案对      | 全部提示词构造器                                   | 每条系统指令都有中英成对版本，按 caption_lang 切换——移植时保留此约定                                               |

---

## 14. 最终排序：Top 5 吸收候选

| #     | 候选                                                                                          | 预期价值                                                                           | 工作量 | 风险 |
| ----- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ | ---- |
| **1** | **结构感知续写引擎**（§1：contract + inspect + continue + merge）                             | 直接消除长模板截断/漏段；引擎无关、零依赖；是所有长输出场景的质量兜底              | M      | 低   |
| **2** | **JoyExtra 三段式硬约束 + 输出子句过滤**（§3，含 captionExtraOptionSanitize 复活）            | 补齐"必须不写"方向能力；prompt 注入 + 输出兜底闭环，与现有 FIDELITY_CHECKLIST 互补 | S      | 低   |
| **3** | **按模型家族分流的输出净化链**（§4 通用层：润色尾巴/教程行剥离/定界封套 + §5 能力矩阵做路由） | 本地小模型产物可用率显著提升；能力矩阵同时收敛采样参数/语言锁/媒体守门             | M      | 中   |
| **4** | **多媒体身份映射构造器**（§6：tag 枚举 + 贴身身份声明 + 抽帧降级）                            | 解决多参考图"张冠李戴"，minimax/多图扩写直接受益                                   | M      | 中   |
| **5** | **PE Profile 双层存储 + 单条导入导出体系**（§2）                                              | 内置随升级、用户可分享；导入重铸 id + 预检 API 是产品级细节                        | M      | 低   |

次优先（S 级顺手件）：SKILL.md 补丁器（§10，若插件要做工程→技能导出）、token 预算公式（§11）、错误翻译学文案表（§8）。

---

## 附：本轮阅读清单（均已生成 .deob.js）

service/：pm_prompt_engineering、pm_text_expand、prompt_master（1257 行全文结构扫读）、joycaption（结构扫读 + 关键区段精读）、pm_library_db、pm_datasets、pm_free_limits、inference/{backend_resolver,inference_messages,gpu_model_lifecycle}
utils/：expandOutputContinue、expandMedia、captionSidecar
config/：peImportValidation、skillMarkdown、builtinSkills、captionModels、captionModelCapabilities、joyCaptionExtraOptions、joyCaptionExtraPromptEngineering、captionExtraOptionSanitize、promptPaths、workspacePath、localTokenLimits、promptExpandRules（长度/预算区段）
controller/：prompt_master（全 45 action）、tools
