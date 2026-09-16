# H3 参照项目深度分析（文件级）与 spec 增量提案

- 日期：2026-09-17
- 方法：raw 文件级精读（非 README 级）。已读文件清单见各节「证据范围」。
- 关联：`docs/specs/2026-09-17-h3-agentic-directing-pipeline-design.md`（本文件 §4 提出对它的修订）

---

## A. minimax-h3-director-suite（精读 3 份核心文档）

**证据范围**：README + `references/workflow-routing.md` + `runner/references/director-schema-v2.md` + `runner/references/director-playbook.md`（未读：setup-guide/api-and-mcp——执行向，D-U3 范围外）。

### A1 workflow-routing.md —— 路由与参数契约

- **路由优先级链**：`segments[].template` > `meta.workflow_map[段号]` > `meta.workflow_map[模式名]` > 内置模式推断（有 refs → ref2va；有首尾帧 → i2v；否则 t2v）
- **参数覆盖按 class_type 而非节点 ID**：`PrimitiveStringMultiline.value`=提示词、H3 视频节点 `length`=时长×24 帧、`ResolutionSelector`=画幅/MP——工作流模板可换，字段映射规则不变
- **后端校验范围**：duration 5-15s、steps 4-40、参考图本地存在性、提示词非空——校验在提交侧不做前端侧
- **断点恢复**：job 文件持久化 prompt_id/status/attempt，重跑跳过已完成段

### A2 director-schema-v2.md —— ★对我们 DirectingIR 最有价值的数据契约

- **creative_intent 四件套**：`state_before` / `trigger` / `state_after` / `audience_takeaway`——每 Beat 的戏剧状态机必须可观察、非空
- **shot_intents 与镜头数严格相等**：每 shot 必须声明 `new_information`（无新信息的 cut 应删除或改为运镜）+ `narrative_subject` + `contains_reaction`；对白 Beat 必须至少一个 `contains_reaction: true`
- **continuity_handoff 四通道**：`positions` / `emotion` / `props` / `audio`——Beat 间显式交接（比我 spec 里的单 `anchor` 字段强一个量级）
- **reference roles 六类与 H3 标签绑定**：`identity_subject`/`location_subject`/`prop_subject` → H3 `Subject N`；`composition_picture` → `Picture N`；`motion_video` → `Video N`；`audio_reference` → `Audio N`。**关键原则：runner 不支持的 schema-only 角色，编译器拒绝——"提示词不得引用到不了模型的参考"**
- **V1/V2 共存策略**：meta.director_schema_version=2 显式启用；禁止为凑校验填占位符

### A3 director-playbook.md —— 导演纪律与 QC 矩阵（S2/S4 persona 的规则金矿）

- **受众结论先行**：先写"本 Beat 结束时观众必须理解/感受什么"，再选镜头；shot purpose 六分类 **`{dialogue}/{mixed}/{action}/{establish}/{insert}/{reaction}`——编译器强制每个镜头以其开头**并校验时长区间
- **时长 taxonomy（机检可校验）**：对白/微表演 2-4s；混合叙事 1.5-3s；高动态 0.4-1.5s；空间建立 2-4s；道具/证据插入 0.5-2s；对白反应后效 1-2s。生成单元 4-10s 优先，10-15s 仅当拆分会打断连续表演；**H3 4s 下限**，不足 4s 的素材合并而非凑数
- **双锚点铁律**：身份锚 + 空间锚缺一不可；空间参考必须是单一连续空间（禁拼贴）；一 Beat 至多绑一个空间参考；道具参考仅在叙事必需时加（且不得引入竞争环境）
- **失效模式库**：Ref2VA 末态泄漏（请求的结束状态泄漏进前帧）→ 改用 FL2VA 字面首尾帧；**次级角色/道具首尾帧无 endpoint delta → FL2VA 冻结该角色**（每 movers 需约束内微差异）
- **空间连续性先于运镜多样性**：180° 轴线；屏幕方位不足——还要站/坐/蹲、相对肩线高低、相对地标前后；同侧 master 覆盖优先；cutaway = 同几何的 temporal pickup；拒绝瞬移/空间重置/发明房间
- **对白契约**：稳定 speaker ID `(S1)(S2)`；`<d>[Language] ...</d>` 标签**只装口语**（禁角色名/冒号/旁白标注）；说话前建立指向关系；反应后效 1-2s；显式反字幕约束
- **道具因果几何**：初态 → 物理触发 → 末态 + 手部接触点/朝向（实例：手机 黑屏→亮屏通知→阅读→侧键锁屏→黑屏，禁止替代成聊天列表）
- **QC 八维矩阵**：Story/Identity/Location/Blocking/Interaction/Dialogue/Text/Rhythm × 通过条件 × 典型修复；**单维失败只修该维**；**两次同类失败 → 改结构/锚点而非换 seed**

## B. leos 六部门（精读 SKILL.md + prompt-director.md + video-prompt-template.txt）

**证据范围**：3 份（references/ 共 11 份，其余为目录级——role-council/output-contracts 等标注为后续按需）。

### B1 SKILL.md —— 组织协议

- **角色权限负面清单**：每角色一张"不得擅自改动"表（表演指导不得暗改剧情/blocking；摄影指导不得炫技改写场次重点；场记不得以小穿帮否定核心表演但硬连续性问题可提**生成门禁**）
- **11 步联合导演流**：场次包 → 总导演澄清 → 场记建连续性基线 → 三部门简报 → 合并确认 → **生成授权门** → v001 → 版本登记 → 多岗逐镜审稿 → 修订 v002 → 审片学习
- **不可破坏原则**（节选）：先导演后提示词；空间可行性先行（多人场面无共享空间关系不进镜头细化）；一资产一职责；关键道具三态（初态/变化/结果）；相邻镜头共享可核对出口/入口状态；失败第二次必须含人类诊断且一次只改一个变量；时长/画幅等未明确时**不得自动补默认值**
- **P/O/C 知识分级**：P 跨项目原则 / O 当前操作参数 / C 项目设定——通用经验需证据门槛才回写

### B2 prompt-director.md —— 编译职位契约

- **身份**：编译与整合职位，**不是第二个总导演**——冲突不擅自折中，交裁决
- **输入合同**：七方输入（总导演/表演/镜内/摄影/场记/用户/项目配置）收齐或标明不适用
- **字数预算分配**：资产+空间 ≤20%、逐镜 ≥65%、环境+风格 ~15%；超限 → 拆多 package，**不得截断镜头或省略连续性**
- **输出前 11 项校验清单** + 两个 validate 脚本（提示词结构 / 审稿覆盖矩阵）——**校验未通过不得交付**

### B3 video-prompt-template.txt —— 镜头文本骨架

```
资产声明（@imageN 场景/角色/道具，各一行职责限定）
→ ⚠️空间布局（MAIN VIEW=从[方向]看；位置A/B 相对锚点/距离/朝向/遮挡）
→ ⚠️对白规则 → ⚠️本视频严格只有 N 个镜头（禁止加镜）
→ 【镜头N】构图参考/机位/摄影机运动/摄影机位置/背景/动作/微表演①刺激②重音③余波
→ 环境活动 → 风格
```

## C. short-drama-factory（精读 SKILL.md）

- **唯一执行顺序 + 冲突裁决顺序**：用户明确要求 > 本文件 > 权威 reference > 其他——干净的优先级链
- **台账先行**："无台账不开写"；每集写前读台账、写后更新（伏笔/人物/道具状态机/规则）
- **机检纪律**：`validate_episode` / `validate_series` FAIL 必须修复重跑，**不得裸交**；机检验证结构不评价艺术
- 8 绝对红线（硬帽/断章/复读检测等）——单句硬上限、体量区间全是**可机检谓词**而非形容词

---

## §4 对 spec 的增量提案（修订 `h3-agentic-directing-pipeline-design.md`）

| Δ | 内容 | 影响节 |
|---|---|---|
| Δ1 | **DirectingIR 吸收 director-schema-v2**：Beat 增 `creative_intent`（state_before/trigger/state_after/audience_takeaway）+ `shot_intents[]`（new_information/narrative_subject/contains_reaction，**与镜头数严格相等**——与 rules-h3 信息增量审计同源）；`anchor` 单字段升级为 `continuity_handoff` 四通道（positions/emotion/props/audio） | §4 |
| Δ2 | **shot purpose 六分类强制标签**（dialogue/mixed/action/establish/insert/reaction）+ 各类时长区间机检谓词（对白 2-4s/动作 0.4-1.5s/插入 0.5-2s/反应后效 1-2s/建立 2-4s；生成单元 4-10s 优先、H3 4s 下限）——rules-h3 新增机检 | §4/§6 |
| Δ3 | **双锚点 + reference roles 绑定 H3 标签语法**（identity/location/prop → Subject N；composition → Picture N；motion → Video N；audio → Audio N）+ **"提示词不得引用到不了模型的参考"编译拒绝原则**（stage 路由不支持的引用角色 = 机检 critical） | §4/§6 |
| Δ4 | **对白契约**：稳定 speaker ID `(S1)(S2)` + `<d>[Language]</d>` 只装口语 + 说话前指向关系 + 反应后效 1-2s + 反字幕约束——注入 S2/S3 persona 纪律 + 机检谓词（`<d>` 标签内禁角色名冒号） | §5 |
| Δ5 | **S4 审计维度升级为八维矩阵**（Story/Identity/Location/Blocking/Interaction/Dialogue/Text/Rhythm × 通过条件 × 典型修复）——替换原三维度；findings 逐镜 | §5 |
| Δ6 | **S5 repairer 增纪律**：单维失败只修该维；两次同类失败 → 改结构/锚点而非换参数；好表演是稀缺资产——局部修不整镜重写 | §5 |
| Δ7 | **两段式确认沿用 leos 授权门语义**（已有 await_user_approval）+ 版本状态机：方案确认→授权→v001→逐镜审稿→v002（每版登记进 continuity_ledger） | §5 |
| Δ8 | **道具因果几何三态**（初态→物理触发→末态+接触点）写入 S2 persona + 台账机检谓词（props.state_by_beat 与逐镜 prompt 的状态词匹配已有，补触发词） | §5/§6 |

**明确不采纳**：workflow JSON 构建/参数覆盖/提交监控（D-U3 执行闭环范围外）；剧本生成层；六独立 agent（D-U2 已裁）；5000 非空白字符限（我们用官方 tokenizer 精确 token 计数，强于字符估算）；角色×镜头全覆盖审稿矩阵（单审计 LLM 架构下收敛为逐镜 findings）。

**证据覆盖声明**：director-suite 精读 3 份核心文档（routing/schema/playbook）；leos 精读 3 份（SKILL/prompt-director/template），references 另 8 份目录级；short-drama-factory 精读 SKILL.md（11 references/scripts 目录级）。足以支撑上述 Δ；leos `output-contracts.md` / `role-council.md` 若实施期需要可再补读。
