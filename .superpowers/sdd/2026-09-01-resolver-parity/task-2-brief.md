# T2 Brief: torii prompts 回填（T1/T2/T4 — 审计高危项 #2）

## 背景
resolver×3.1.0 parity 批次任务 2。审计报告（`plugins/prompt-master/docs/2026-08-31-resolver-3.1.0-diff.md` §清单#1）认定 torii prompts 为高危缺口：**PROMPTS_B 7/11 键被重写、3 键缺失（chroma-style / danbooru_line / sd_tag_line）、TORII_JSON_FORMATS 与 JSON_OUTPUT_SUFFIX 丢失、SYSTEM_PROMPT 与 makeUserQuery grounding 管线缺失**。若要用上游结构化打标行为，必须回填官方模板。

## 工作目录
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`

## 上游 ground truth（逐字移植源）
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\temp\pm-promptmaster-src\unpacked\electron\config\promptEngineeringTorii.js`（或同名目录/文件——执行者先 glob 定位：搜索 `PROMPTS_B` 关键字定位确切文件）

## 审计原文（§3 表格——先 read 审计报告 §3 获取逐行差异表）
`plugins/prompt-master/docs/2026-08-31-resolver-3.1.0-diff.md` §3

## 修复清单
1. PROMPTS_B：11 键全部按上游回填（7 个重写的恢复官方文案 + 3 个缺失的新增 + 1 个已对齐的保持）
2. TORII_JSON_FORMATS + JSON_OUTPUT_SUFFIX：补回
3. SYSTEM_PROMPT：补回
4. makeUserQuery 的 grounding 管线：按上游移植（若有消费方断裂——read 当前 `src/resolver/torii/prompts.ts` 的消费方 `resolveTrainTorii`/train 工具路径，确认接线）

## 关键约束
- **消费方不断**：回填后现有 train/torii 相关测试必须仍绿（read `tests/` 里 torii/train 相关测试先摸清锁定面）
- 若上游某键在插件里没有消费方（port 裁剪了功能），该键**仍然回填**（数据完整性）+ 注明 `// upstream parity, no consumer in port`
- 纯数据/模板文件，零日志
- 新增 parity 测试：11 键存在性 + 3 个缺失键的内容包含性断言（抽样官方文案特征串）+ JSON_OUTPUT_SUFFIX 存在

## Files
- Modify: `src/resolver/torii/prompts.ts`
- Modify: `src/resolver/torii/formats.ts`（若 JSON_FORMATS 在此）
- Test: `tests/resolver/torii-parity.test.ts`（新增）

## 步骤
1. glob 定位上游 torii 源文件 → read 全文 + 审计报告 §3 + 当前 prompts.ts + 消费方
2. 写失败 parity 测试
3. 回填（11 键 + formats + suffix + system prompt + makeUserQuery 管线）
4. 新测试绿 + 既有 torii/train 测试绿 + 全量绿 + build 0
5. Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/resolver/torii plugins/prompt-master/tests/resolver
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "fix(prompt-master): torii prompts parity with PM 3.1.0 (PROMPTS_B 11 keys, JSON formats, system prompt, grounding)"
```

## 验收
- torii-parity.test.ts 覆盖 11 键 + formats + suffix + system prompt
- 既有 torii/train 测试全绿
- 全量绿
