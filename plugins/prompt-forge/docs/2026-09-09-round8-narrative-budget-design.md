# Round 8 设计：narrative 排除 + anima 软预算闸门 + 空泛词拦截

> 输入：用户提供的实战 prompt（古风剑舞/anima base）暴露三个硬伤：①narrative 改写段整段冗余（known-edge B1 实战复现）；②tag 区语义重复+空泛词（atmosphere/stunningly beautiful）；③总长超预算无闸门（~260 tokens 权重稀释）。
> 方案取舍：语义级改写重复检测（embedding/LLM judge）被否——成本高且不确定；「源头排除 + 预算闸门」确定性零 LLM，直接消除问题面。

## F6 narrative 段默认排除

- `compileAnima` 装配时 narrative 段（slot=null/origin=narrative）**默认不进 positive**
- 新增选项 `allowNarrative?: boolean`（默认 false）显式开启（保留合法用途出口）
- 排除时 advisory `narrative_excluded`（可追溯，附被排除内容长度）；第一轮去重逻辑保留（allowNarrative=true 时仍生效）
- assumptions 不动；golden 受影响更新并列清单

## F7 anima tag 软预算闸门

- audit 新增 `tag_budget_exceeded` gate（important，纳入修正闭环）：positive 按逗号分段计数，**tags > 40 或 chars > 1200** 触发，detail 给出当前计数与阈值
- 阈值进 dialect capabilities（`max_tags`/`max_prompt_chars` 已有 max_prompt_chars=7000 是 H3 概念；anima 侧新增独立字段或常量，报告说明落点）
- feedback 指令模板：「删除空泛词与语义重复 tag、合并同类场景词，保留主体与核心动作」——修正闭环靠 intent 重拆消费
- 现状核实：一期会话产物 ~60 tags 已超标，本 gate 会让这类出稿进入裁剪修正而非带病交付

## F8 空泛词拦截

- anima audit 新增 `vague_tag` gate（minor，advisory 性质不强制）：命中空泛词表（atmosphere, beautiful, stunningly beautiful, amazing, gorgeous, masterpiece 白名单豁免）→ 逐词一条 minor，detail 给「建议替换为具象描述或删除」
- 词表常量 `VAGUE_TAGS` 放 dialect/anima.ts，可扩展

## 验收

一期同款 slots + 本实战 slots 实测：narrative 不出现、超预算触发 gate、空泛词被标；全量基线只升不降（golden 按新行为更新列清单）；修剪版对照 prompt（手工按闸门标准裁剪）作为附录证据。

## 自审

- F6 排除 narrative 是否丢信息：narrative 的增量（新句）极少且实战 2/2 为伪增量；排除后 advisory 可追溯，allowNarrative 有出口——可接受
- F7 阈值 40/1200 是经验值：首版定值，实战反馈再调；阈值常量化即调
- F8 minor 级不进闭环：空泛词删除属优化非硬伤，避免与 F7 修正竞争
