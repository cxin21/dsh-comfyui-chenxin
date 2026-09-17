# T4 Brief: 低危 parity 收尾（R1 + C1 + E1 + 文案截短 — 审计 §12 优先级 4）

## 背景
resolver×3.1.0 parity 批次任务 4（最后代码任务）。合并修复审计报告的四个低危项（`plugins/prompt-master/docs/2026-08-31-resolver-3.1.0-diff.md`——先 read §4/§10/审计对应处获取逐行差异，本 brief 只给锚点）。

## 工作目录
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`

## 上游 ground truth
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\temp\pm-promptmaster-src\unpacked\electron\config\`（审计表格标了上游文件/行号）

## 修复清单

### C1：comfyui.ts `pose/orion` typo（审计 §10）
- 按审计表格修正 typo（先 read 确认拼写）

### R1：8 个 expand 内置 profile 撞名语义（审计 §12 优先级 4 + §10）
- **Ruling（Captain 预先裁决）**：保持 port-only expand profiles 现役 + 注释声明（不改 id 体系——有消费方）；在 profile 定义处加 `// legacy-name collision: PM 3.1.0 内置该 id 为其他语义；本 port 保留 expand 语义（消费方为 expand 路由）` 注释

### E1：labelUi 丢失（审计 §10）
- 按审计表格——若上游 profile 条目带 labelUi 而 port 丢失：回填到 profile 类型（若 TS 类型有该字段）或注明数据结构不承载（port-only 决定）

### 文案截短（审计 §10 resolver 入口 ensureCustomExpandSystem 守卫等）
- ensureCustomExpandSystem 守卫文案补回（"in the user message" / "or expansion rules" / "或散文"）

## 关键约束
- 既有测试全绿（若有锁定 C1 typo 的测试——typo 修复会改输出，read 先摸清）
- 每项 ≥1 parity 断言或既有测试覆盖说明
- 纯函数零日志

## Files
- Modify: comfyui.ts / profiles expand 定义 / index.ts 守卫文案（按审计定位）
- Test: 追加 parity 断言

## 步骤
1. Read 审计 §10 + §4 → 逐项定位
2. 失败测试 / 确认既有测试
3. 逐项修（C1 → R1 注释 → E1 → 文案）
4. 全绿 + build 0
5. Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src plugins/prompt-master/tests
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "fix(prompt-master): low-priority resolver parity (C1 typo, R1 collision notes, E1 labelUi, guard copy)"
```

## 验收
- 4 项落地；既有测试全绿；全量绿