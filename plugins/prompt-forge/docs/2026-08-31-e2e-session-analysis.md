# 端到端验证会话分析（session-20b627ba · 2026-08-31 吸收增强后）

> 会话：全新 comfyui-chenxin 预设会话；用户指令"测试一下prompt-master-mcp这个插件吧"
> 工具调用 6/6 全部 ok，0 ERROR。一个 subagent（prompt_author intent）成功运行。

## ✅ 通过项（6 工具全绿）

| 工具                    | 验证内容                                                                    | 结果                     |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------ |
| `profile_list` list     | 60+ profile（merge 后含 expand/reverse/train 三族）                         | ✅                       |
| `catalog_search` 1girl  | canonical 命中（record 10768, usage 925万）                                 | ✅                       |
| `prompt_author` anima   | subagent intent → slots → 编译 → 审计全链                                   | ✅ ok=true, audit passed |
| `prompt_audit` h3       | 裸文本 fail-closed（field_order critical 正确拦截）+ tokenizer 预算 47/1200 | ✅ 符合设计              |
| `prompt_expand` dry_run | system/user 组装正确（语言锁/格式约束在位）                                 | ✅                       |
| `prompt_compile` anima  | 12 tags 全 canonical 命中带 citation                                        | ✅                       |

**吸收增强的证据**：prompt_author 的 subagent 会话产出结构化 slots（符合新 dialect 契约）；`assumptions`（safety_seed + catalog_miss）进入 Envelope（MF-2 修复生效）；audit gates 抓到 duplicate_segment（审计闸门工作）。

## 🚫 阻塞项

**无。** 全部工具调用成功，无 mount 失败，无 UNKNOWN_TOOL，无 INVALID_TOOL_OUTPUT。

## ⚠️ 可优化项（按优先级）

### P1（功能缺陷）：编译层跨槽去重缺失

- **证据**：`prompt_compile` slots 同时含 `count_gender:["1girl"]` + `character:["1girl"]` → positive 输出 `safe, 1girl, 1girl, red hair`
- **现状**：审计闸门抓到了（`duplicate_segment: 1girl`, important 级）——但只报告不修复
- **修法**：compileAnima 的 composition 阶段加跨槽去重（同 normalized tag 只保留首次出现；上游 anima skill 的 composition.py 有无此逻辑需核对——若无则属上游行为，需上游修）
- **量级**：S

### P2（规则过宽）：`lighting_term_banned` 误伤

- **证据**：`neon lights` / `neon light reflections` 被判为 LoRA 光照词——但这是场景内容（霓虹灯是画面主体）而非光照 LoRA 触发词
- **修法**：检查 rules-h3 的光照禁词表（应该是 h3 审计的 21 项照明词）——`neon` 类词需上下文判定（作为 scene 名 vs 作为光照修饰）或在 anima audit 的禁词表中区分
- **量级**：S-M（规则细化 + 回归）

### P3（首次使用预期）：catalog overlay 不可用

- **证据**：`catalog_search` 返回 `overlay_unavailable` advisory——relation-overlay.sqlite 还没建
- **修法**：非缺陷——跑一次 `anima-prompt-v1 relation.submit` 即建。可选优化：advisory 文案里直接给修复指令（"run relation.submit to enable"）
- **量级**：S（文案）

### P4（日志可见性）：会话内 0 条 `[prompt-master]` 日志

- **证据**：会话日志里没有插件的 info 打点——`ctx.logger` 输出走**进程日志**（DSH host console），不进会话事件流。这是 DSH 架构使然（日志与会话日志分离），但用户在 GUI 里看不到
- **可选优化**：把关键摘要（续写轮次/净化触发/joy_extra 过滤）也写入 Envelope 的 advisories 或独立 `observability` 字段，让模型和用户可见
- **量级**：S

### P5（体验）：prompt_audit 裸文本 fail-closed 的引导不足

- **证据**：裸文本（非六段式）投喂 prompt_audit 得 critical `field_order`——行为正确但错误信息没有告诉模型"该用 prompt_compile 或六段式格式"
- **修法**：field_order gate 的 detail 加引导："input 需为六段式结构；裸文本请改用 prompt_author 或先经 prompt_compile"
- **量级**：S

## 总结

**阻塞项：零。** 吸收增强后插件在真实会话全链路健康（含 subagent intent、assumptions 进 Envelope、审计闸门、tokenizer 预算）。5 个可优化项中 P1 是真实功能缺陷（S 级），P2 是规则精度问题，P3/P5 是文案级，P4 是可见性增强。
