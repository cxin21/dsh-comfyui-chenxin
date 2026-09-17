# T3 Brief: 中危 parity 项合并（M1/M2 + A1 + V1 + D1 — 审计 §12 优先级 3）

## 背景
resolver×3.1.0 parity 批次任务 3。合并修复审计报告的四个中危项（`plugins/prompt-master/docs/2026-08-31-resolver-3.1.0-diff.md`——先 read §5/§6/§7 对应表格获取逐行差异，本 brief 只给锚点）。

## 工作目录
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`

## 上游 ground truth
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\temp\pm-promptmaster-src\unpacked\electron\config\`（各差异表标了上游行号——执行者按审计表格定位）

## 修复清单（4 项独立，逐项移植 + 逐项测试）

### M1/M2：expandMirror 非结构化分支（审计 §5）
- M1: CaptionPE 全家桶（buildSystemPrompt + buildSystemAddons）在 pe_expand_descriptive/danbooru 镜像生成缺失
- M2: tokenLimits 透传缺失
- 消费方：`src/resolver/profiles/expand-mirror.ts`（或同区域——执行者先 read 定位）

### A1：captionLength resolveAnima3TagCountBand custom 分支（审计 §6）
- anima3 内联版丢失 custom 字数档；补回 custom 分支
- 消费方：`src/resolver/profiles/` 的 anima3 相关 length 逻辑

### V1：resolveReverse 自定义分支长度块被顶替（审计 §10）
- 上游 system 追加 `CaptionLen.buildCaptionLengthBlock`（resolver.js:227-228）；port 改成了 `routerBuildSystemPrompt(cap, mt)`——**长度块被 workflow 块顶替不在既定裁剪方针**
- 修法：自定义反推分支 system 恢复长度块追加（JoyExtra 部分保持既定裁剪不动）
- 消费方：`src/resolver/index.ts` resolveReverse 非内置分支（:158-190 附近）

### D1：descriptive/prose 字数表述（审计 §7 对应行）
- 按审计表格回填正确表述

## 关键约束
- 既有测试全绿（这些区域可能有锁定断言——先 read 相关测试再动手）
- 每项至少 1 个 parity 断言（新增 `tests/resolver/parity-medium.test.ts` 或分散到既有测试文件——执行者按测试组织惯例决定）
- 上游行号是审计时的引用——以实际源码内容为准
- 纯函数零日志

## Files
- Modify: expand-mirror / captionLength / index.ts / descriptive|prose 相关（按审计表格定位）
- Test: 新增或追加 parity 测试

## 步骤
1. Read 审计报告 §5/§6/§7/§10 差异表 → 按表逐项定位上游与 port 源码
2. 写失败测试（每项 ≥1）
3. 逐项移植（M1/M2 → A1 → V1 → D1）
4. 全绿 + build 0
5. Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src plugins/prompt-master/tests
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "fix(prompt-master): medium parity items (expandMirror CaptionPE, anima3 custom band, resolveReverse length block, word-count wording)"
```

## 验收
- 4 项各有 parity 断言；既有测试全绿；全量绿
