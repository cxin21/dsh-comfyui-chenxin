# M5 候选与立项骨架：蓝图形态迁移 + 运行时可观测性（style-aesthetics 续）

**日期**：2026-09-13　**来源**：真实会话验尸（session-824d2f22 / 8e31ff2a）+ M4-FINAL 台账 + 全面审计备案
**前置**：P0 修复（slots.rating 确定性写入）先行落地；本文件是 M5 的立项依据，非执行计划。

## 立项一：默认路径蓝图形态迁移（本里程碑主体）

### 问题定性（真实会话实证）
spec §8 字面流「LLM① 意图分析 → validateBlueprint(core.rating 校验) → 投影 → 编译」在**标准 anima 路径未落地**：
- 现行默认路径 = ANIMA_PERSONA slots 直译（subagent-provider.ts ANIMA_PERSONA「忠实落成 slots JSON」），parseIntentJson 返回 `{slots}`（L237）——**无蓝图**
- core.rating 确定性注入挂 `if (draft.blueprint)`（prompt-author.ts L905）→ 标准路径永不触发 → 声明档位只能靠 slots 层确定性写入（P0 修复）兜底
- 蓝图形态（BLUEPRINT_SUBAGENT_SYSTEM + BLUEPRINT_SCHEMA + core.rating 校验 + enrichBlueprint 扩展层 + 增量锚定）当前仅 blueprint_id 增量入口可达

### 迁移设计要点
1. **provider 层**：target='anima' 时 intent 子代理切换为蓝图模式（isBlueprint 分支已存在于 subagent-provider.ts L101——差一个路由决策）；parseBlueprintJson 产出 `AuthorDraft{blueprint}`
2. **投影层**：projectToAnima 补齐 core.rating → slots.rating 映射（P0 修复验收④会给出现状结论；若投影已映射则 blueprint 路径天然带档）
3. **兼容双态**：`AuthorDraft.blueprint` 缺省时 slots 直译路径保留（架构现成，L1003 注释「向后兼容」）——迁移 = 改默认路由，不是删旧路
4. **收益**：spec §8 全字面对齐（validateBlueprint 进默认流）；默认路径与 blueprint_id 增量路径统一（修复轮蓝图锚定防整图重解释）；core.rating 校验层生效；enrichBlueprint 扩展层覆盖默认流
5. **成本与风险**：intent 子代理输出形状变化（slots JSON → blueprint JSON，token 画像变化）；golden 对照（迁移前后 slots 等价性抽样）；e2e 全量重放；NSFW 档端到端回归

### 验收草案
- 默认 anima 路径 envelope 出现 blueprint 痕迹（trace/observability 字段）
- rating=explicit → 产物 rating_explicit 种子 + explicit 负向组（蓝图投影链）
- 既有 82 预设 / 词表 / envelope 契约零变化；全量绿

## 立项二：运行时版本戳（可观测性）

### 问题定性
真实会话 824d2f22：DSH 长驻进程（09-12 20:37 启动）持有 pre-M1 镜像，dist 磁盘重建不热更——**静默失效 18 小时**，文档（AGENTS.md 描述 rating/escalated）与运行时行为矛盾时 agent 无从归因，绕 4 轮 + 现场翻源码才定位。

### 设计要点
1. 插件启动时打构建戳：git short hash + 构建时间（构建脚本注入或读取 dist 内嵌常量）
2. 呈现面：每 envelope 顶层 `meta.runtime`（或 advisories 首条一次性 `runtime_build:<hash>`）+ logger 启动行
3. AGENTS.md 路由补条目：「工具行为与文档不符 → 先查运行时构建戳，再怀疑代码」
4. 顺带：提示词工程契约锚（compileAnima 关键常量指纹）可选

## 立项一附带缺口（impl-2 P0 修复期备案，t2-f1 核实）

1. **strict 模式 patchAnima 档位回落**：judge strict 修订的稿内编辑重建 slots 不带 rating——audit maxTier（normalized.value 含 rating）兜住终检档位，但修订稿文本的种子档位可能回落关键词档
2. **蓝图修复轮 core.rating 未重注入**（t2 代码核实 L949-957 为真实残留缺口）：L905 只覆盖首轮 provider 返回，修复轮 `d2.blueprint` 未重注入——若修复轮 LLM 产出覆盖/丢失 core.rating，投影档位回落
3. **enrichBlueprint deepMerge 理论覆写**：enrich 扩展层 deepMerge 理论上可被 LLM patch 覆写 core.rating（安全数据信任边界）

## 既有 M5 候选台账（继承，不动）
- SD 方言实现（设计稿先行——M4 已裁定暂缓）
- 多生成（**需求待用户补全**，全仓无出处不可规划）
- catalog overlay 生态延伸（listArtists / maintain 工具化）
- mutate 流评级行（persona 契约演进时）
- prompt_audit 顶层 rating 输入（审计 #2 备案补全）
- envelope aesthetics.gates 形态对齐（审计 #4 备案）

## 优先级建议
P0 修复（进行中）→ 立项二（小，半天级，直接消根因类）→ 立项一（里程碑级，需独立设计评审）→ 其余按需。
