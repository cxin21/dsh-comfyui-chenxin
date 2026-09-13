# AGENTS.md — prompt-master 插件开发工作约定

本插件被 DSH 通过 `agent.cordis.yml` 以 `./plugins/prompt-master/dist/src/plugin/index.js` 挂载，
**运行时加载的是 dist（tsc 编译产物），不是 src**。

## 铁律：改 src 必须同步 dist

任何修改 `src/**` 的提交，必须在提交前执行：

```bash
npm run build   # tsc → 把 src 改动编译进 dist/
```

**为什么**：DSH 无 TS 运行时，`require` 只认 `dist`。只改 src 不 build，运行的是旧逻辑
（历史事故：8/27 后 src 的 CJK 审计修复长期未进 dist，导致全中文分镜被误判
「Shot N cut adds no new information」，用户在真实会话中被卡 7 分钟）。

**注意**：`dist/` 在 preset 层 `.gitignore` 中（`git check-ignore` 证实），
**dist 不入 git**——它是本机构建产物。所以纪律是「build 后本机 dist 更新即可」，
提交只含 src；不要期待 git status 里出现 dist。

**修改 src 后的标准流程**（防止再犯）：
1. `git status --short` 是否显示 `src/**` 改动
2. 若是 → 跑 `npm run build`（本机 dist 立即更新，DSH 下次加载即用新逻辑）
3. 可选复测：`node` 加载 `dist/src/pe-framework/audit/rules-h3.js` 跑 `auditH3Full`，
   确认关键审计逻辑与 src 一致（dist 是 ESM，用 `import` 而非 `require`）
4. 提交只含 `src/**`（+ 本次新增的文档/测试），dist 不进提交

## 验证命令

- 全量测试：`npx vitest run`（当前基线 831 passed / 1 skipped / 0 failed）
- 类型检查：`npx tsc --noEmit`
- 构建：`npm run build`（tsc 产出 dist）

## 提交规范

- 单文件/单一意图提交；message 标注 spec 章节（如 `spec §7.2`）
- src 改动必须在提交前执行过 `npm run build`（本机 dist 已同步；dist 不入 git）

## 插件结构速览

- `src/pe-framework/blueprint/` — 蓝图 IR：schema / analyzer / project（投影器）/ repo
- `src/pe-framework/enrichment/` — 美学扩展引擎 + 风格库（style.ts）
- `src/pe-framework/aesthetics/` — 具体性/保真检查 + 词库（lexicon.ts）
- `src/pe-framework/dialect/` — 方言包（h3.ts / anima.ts / registry / package）
- `src/pe-framework/audit/` — H3 审计规则（rules-h3.ts，含 CJK 感知 semanticShot）
- `src/pe-framework/intent/` — 意图分析（analyzer / subagent-provider）
- `src/pe-framework/eval/` — LLM 评委（judge.ts，可选路径）
- `src/tools/` — prompt_author / prompt_compile / prompt_audit 工具定义（注册清单权威源 =
  `tests/plugin/registry.test.ts` 精确名单，14 工具；M3 T2 起 +style_save 预设入库写工具，
  spec §13——validateStylePreset fail-fast + id 白名单 + 原子写，重复 id 拒收改走 git；
  M4 T1 起 +catalog_artist_add 画师存在性登记（overlay 同库新表，evidence 必填防灌水，
  catalog_search 以 alias+source=overlay_artist_registry 填隙消费，源 tags.sqlite 零改动）

## 安全词表与预设维护注记

- 新增 ASCII 词表词（boundaries.ts / rating.ts）必须跑全表 **y-结尾扫描**：y 结尾词的复数形
  不含词干尾 'y'，后缀模式 (?:s|es|ren) 不覆盖——命中者同步 `PLURAL_VARIANTS`（rating 侧
  直录复数形态），扫描结论注释留痕（boundaries.ts 头注释 + PLURAL_VARIANTS 块）。
- 新预设 artist_hints 必须逐名过 `catalog_search`（canonical/alias 才采纳，fuzzy 候选不采信，
  验证失败留空）；五批采纳/弃用全量台账与 rec 号留痕见 `docs/artist-provenance.md`。
- `style_save` 写入的预设即仓库工作树内容，git 提交由用户完成（工具不碰 git）；同进程重复
  保存未提交 id 会静默覆盖且不可恢复（缓存镜像盲区，详见 artist-provenance.md 维护注记）。
