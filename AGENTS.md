# AGENTS.md — Agent 工作守则

每个 agent session 开始时，把这份文件当作运行手册：**任务进来 → 路由到 skill → 调对应工具/CLI → 解析 envelope → 把结果交给用户**。

## 1. 任务路由表

| 用户说 | 你该做的 | 调用的 CLI |
|---|---|---|
| 写 Anima 提示词 / 把一段描述变成 Anima tag | 调用 `prompt_author` (target=`anima`) 拿 `positive` + `negative`，**别直接跑 ComfyUI**；要确定性编译/审计用 `prompt_compile` / `prompt_audit`（prompt-master 插件） | `prompt_author` (target=anima) |
| 写 MiniMax H3 视频提示词 / 验证 H3 prompt 长度 | 调用 `prompt_author` (target=`h3`) / `prompt_compile` (shots)（prompt-master 插件） | `prompt_author` (target=h3) |
| 用户对出稿满意/不满意，想打分或补充反馈 | 调用 `prompt_feedback` (action=`record`)，`generation_id` 从 `prompt_author` envelope 顶层复制（UPSERT：重复评分覆盖旧评） | `prompt_feedback` (action=record) |
| 跑 Anima 图（t2i / i2i） | 先 `camera-image describe --summary` 看契约，写 req.json，再 `camera-image run` | `camera_image` |
| 跑 MiniMax H3 视频 | `camera-video describe --summary` → 写 req.json → `camera-video run` | `camera_video` |
| 跑多视图角色卡 / 三视图 / 多姿态 | `camera-multiview describe` → 写 req.json → `camera-multiview run` | `camera_multiview` |
| 创意方向还没定（风格、画幅、时长） | **停下来问用户**，不要进任何 skill | — |
| 想要的不是 Anima / 不是 H3 / 不是 ComfyUI 上的固定工作流 | **不在本 preset 范围内**，换模型或换工具 | — |

完整 skill 边界：每个 skill 的 SKILL.md 顶部 `whenToUse` + `Do not call when` 段落。

## 2. 调用 CLI 的标准动作

```text
1. 调用 <cli> describe [--summary] 看契约（prompt 是哪个 stage、需要什么字段）
2. 写 <preset>/temp/<skill>/<task>/req.json
3. 调用 <cli> run，--request 指向那个文件；不传 --output-dir 时产物默认落
   <preset>/temp/<skill>/（camera-image → temp/camera-image/，camera-video →
   temp/camera-video/，camera-multiview → temp/camera-multiview/）
4. 解析 envelope：
     - ok=true → 把 result 关键字段（summary.json 路径）给用户
     - ok=false → 看 errors[].code，按 docs/troubleshooting.md 的恢复建议走
5. advisories 永远透传给用户（advisory 是非阻塞警告，不是错误）
```

注意：
- `camera-image run` 默认会**问你 y/N**（group plan / asset verification），自动化场景必须加 `--yes`。
- `camera-video run` 和 `camera-multiview run` **不接受 `--yes`**（argparse 会直接 exit code 2），它们没有交互式 prompt，会直接 enqueue。不要照搬 `camera-image` 的 flag。
- 所有 CLI 都接受 `--json`（loader 已经自动加），**调 CLI 时不用自己加 `--json`**。
- 写 Anima / H3 提示词**不走 CLI**：由 prompt-master 插件的 `prompt_author` / `prompt_compile` / `prompt_audit` / `prompt_feedback` / `style_list` 处理，CLI 只负责 camera-* 的执行。
- `prompt_author` 的 `rating`（`safe` 默认 / `sensitive` / `explicit`）：内容分级声明——预检在任何 LLM 前定档（关键词命中自动升档记 `rating_escalated` advisory），硬边界违规（未成年/非自愿/兽）0 token 抛错；声明档位确定性注入蓝图 `core.rating` 并透传 enrich/评审；成功 envelope 顶层另有 `rating`/`aesthetics`/`style` 三字段（spec §9）。`judge_mode`（`fast`（默认）/ `strict` / `off`）：LLM 证据化评审，`off`=显式关闭回退旧路径。`enrich`（默认 `true`）：先 LLM 扩写为七维度 brief 再拆解（`false` 显式关闭；**M5 起 anima 默认路径走蓝图形态，`enrich` 参数在蓝图形态下被忽略并出 `enrich_ignored_blueprint` advisory——brief 层存活面 = h3 / blueprint_id / 未迁移方言**）；`outputLang`（`en`/`zh`/`ja`）：输出语言偏好（anima 恒锁 en；仅 h3 显式生效）。成功 envelope 顶层字段：`generation_id`（反馈回写用）、`judge`（评审结果，含 `verdict`/`score`/`findings`；跳过时 `judge.skipped=true`）、`debate`（评审-修订全程留痕）、`judgeFeedback`（needs_revision 终态的 findings 投影）、`enrichment`（七维度 brief，`source=user/enriched` 可追溯；M5 起 anima 默认路径无此字段——蓝图形态由扩展层承担，h3/blueprint_id 路径仍有）、`blueprint_id`（M5：anima 蓝图落库成功时的条件顶层键，=generation_id，可直接作下次 `prompt_author` 的 `blueprint_id` 输入增量续链）。评审/enrich 任何故障不阻塞出稿。旧的 `audit_only` 参数已删除——只审计用 `prompt_audit`。`style_list` 查风格预设 id（category/rating 上限/applies_to/query 过滤，82 条；sensitive/explicit 预设仅 anima），id 传给 `prompt_author.style_id`。
- **成本提示**：缺省一次 `prompt_author` ≈ 3 次 LLM 调用（intent + 蓝图扩展/brief enrich + fast 评审，pass 情形；修正轮更多）；要省成本可显式传 `judge_mode:'off'`、`enrich:false`（或两者都关）。
- **M5 迁移（anima 默认蓝图形态，2026-09-13）**：标准 `prompt_author (target=anima)` 默认走蓝图链——intent 子代理产出 BlueprintV1（image 形 + expectedMedia 守卫）→ 确定性 `core.rating` 注入 → art_direction 显式卡注入 → `enrichBlueprint` 美学扩展 → `projectToAnima` 投影 → 编译/审计；runEnrich 七维 brief 层退出默认路径（首轮调用数持平）。运行时回滚不用发版：环境变量 `PM_AUTHOR_INTENT_FORM=slots` 切回旧 slots 直译路径（advisory `intent_form_override` 可观测，非法值 fail-fast）。成功出口蓝图落库（fail-open：settings 缺失/写失败仅 advisory `blueprint_save_failed`，不阻塞出稿），落库成功即 `blueprint_id` 有料（见上）；envelope 另增 `observability.blueprint`（form/media/missing_count/expansions_count/repairs_count/anchor_rounds）。设计稿：`plugins/prompt-master/docs/specs/2026-09-13-blueprint-form-migration-design.md`。
- `--request` 文件路径用绝对路径或 preset 内相对路径，不要依赖 cwd。
- **跨 skill 的字段不可移植**：每个 skill 的 request schema 独立，先 `describe --summary` 看 `result.request` 的 schema 描述，不要凭印象从其他 skill 抄。

## 3. 输出与文件位置

```
temp/<skill>/<task>/
├── req.json                    ← 请求（你写的）
├── summary.json                ← camera-* run 的执行摘要（CLI 写的）
├── *.png / *.mp4               ← 产物（CLI 写的）
└── ...
```

约定：
- agent 写的请求文件放到 `temp/<skill>/<task>/` 下面（skill 名与 CLI 名一致：camera-image / camera-video / camera-multiview）
- camera-* 的产物默认落 `<preset>/temp/<skill>/`（不传 `--output-dir` 时），也可显式 `--output-dir` 覆盖到别处
- prompt-master 的 `catalog_build` 工具从 `assets/knowledge/anima-prompt-v1/tags.sqlite` 重建 `tag-catalog.sqlite` + manifest；`catalog_relations` 读写 `temp/anima-prompt-v1/relation-overlay.sqlite`
- 引擎 workflow 缓存（每次 run 写 1 个 json）落在 `temp/runtime/.workflow_cache/`，随 temp 一起清理
- `prompt_feedback` 的生成/反馈记录落在 `data/runtime/feedback.sqlite`（node:sqlite；generations 保留 90 天懒清理，feedback 永久保留，孤儿行在 `list` 里标 `orphaned: true`）；首次使用时自动从旧位置 `temp/runtime/feedback.sqlite` 迁移（含 -wal/-shm）
- 不要写到 `skills/<name>/` 下面（那是技能包源码 + 只读 knowledge/，与项目无关；历史遗留的 `out/` 已迁到 `temp/`）

## 4. 不要做的事

- **不要绕开 skill 自己拼请求**：所有 ComfyUI 工作流都固定在 skill 里的 asset（`camera-anima.json` / `Flux2-Klein人物一键多视图工作流.json`），调用方只写请求表面（prompt / camera / reference path），不写 node ID、widget index、graph 结构。
- **不要碰 system Python**：所有 6 个本地包只装在 `<preset>/.venv`；如果发现 `import chenxin_runtime` 在裸 `python` 下失败，**那是预期行为**，让用户走 venv（`.\.venv\Scripts\python.exe`）或激活 venv。
- **不要在没有 `describe --summary` 的情况下猜字段**：每个 skill 的请求 schema 在 `describe --summary` 的 `result.example` 里都有活样板，直接复制。
- **不要把 envelope 的 `errors[]` 当 `warnings`**：errors 永远意味着调用失败，需要修复后重试；advisories 是非阻塞警告。

## 5. 错误恢复快速表

| Envelope code | 出处 | 怎么修 |
|---|---|---|
| `catalog_build_failed` / `input_file_missing` | prompt-master (catalog) | 知识资产缺失 / 重建失败 → 跑 `catalog_build` 工具重建 |
| audit critical gates（`field_order` / `cut_timestamps` / `ref_count` / `budget` / 其余 rule） | prompt_author / prompt_compile / prompt_audit | 看 Envelope 的 `next_action`：`retry_input`→按 `repair_hints` 改入参；`auto_repair`→引擎已修，检查 `observability.repairs`；`manual`→人工接手（`loop_exhausted`） |
| `invalid_request` | camera-* | req.json 路径/格式不对 |
| `input_file_missing` | camera-* | 路径在硬盘上不存在，修复路径 |
| `group_confirmation_aborted` | camera-image | 自动化场景加 `--yes`，或改 req 减 group |
| `fixed_workflow_invalid` / `AssetError` | camera-image / multiview | asset 哈希不对 → 跑 `assets verify`；被人改过则回滚 |
| `comfyui_mcp_error` | camera-* | npx / comfyui-mcp 子进程挂了，参考 `docs/troubleshooting.md` |
| `comfyui_runtime_error` | camera-* | ComfyUI 拒收 / 超时，把原始错误透传给用户 |
| `argument_error` / `request_invalid` | 全部 | CLI 参数写错，对照 `docs/cli-cookbook.md` |

完整错误处理（含 exit code 对照）见 `docs/troubleshooting.md`。

## 6. 进程启动验证 + 异步监控纪律

**任何用 `Start-Process` 或 detached 方式启动 CLI 后，必须在 5 秒内验证它真的跑起来了**：

```text
1. 启动后立即 sleep 5
2. 检查进程是否还活着（Get-Process -Id $pid）
3. cat 重定向文件（-RedirectStandardOutput / -RedirectStandardError）：
   - stdout 不为空 → 拿到 prompt_id / 进度行
   - stderr 不为空 → 立即读出 errors[].code，不要跳过
4. 同时检查 ComfyUI 端：
   - GET http://127.0.0.1:8188/queue → queue_running 应该 ≥ 1
   - GET http://127.0.0.1:8188/history → 看最新条目有没有新 prompt_id
5. 三者一致（进程在、ComfyUI 在跑、prompt_id 在 history）→ 才进入"等结果"模式
6. 任一不对 → 立刻停，重读 stderr / 重写 req.json，**不要盲等 25 分钟**
```

**为什么必须有这条**：CLI 启动到真正 enqueue 之间可能 0–3 秒。这段时间 arg 解析失败 / IO 错 / schema 错都会写到 stderr。如果只看 stdout（enqueue 成功才输出）或等 GPU 涨就以为在跑，**你会在 25 分钟的轮询里等一个从来不存在的任务**。

**长跑任务（>5 分钟）的监控模式**（`camera-video` multi-i2v 渲染流水线、批量调用都用得到）：

```text
1. enqueue 后立即拿 prompt_id（从 stdout JSON envelope 的 result.prompt_id，或从 ComfyUI /queue 抓）
2. 用 pwsh 长轮询（不要 spawn 后端 CLI 轮询 —— 它是单次调用，sampling 还没完它就死了）：
   - GET http://127.0.0.1:8188/history/<prompt_id>
   - 等到 response 中 status.status_str == "success" 且 status.completed == true
3. 从 ComfyUI server 文件系统（默认 E:\Comfy\comfyui-licyk-20260608\core\output\MiniMaxH3\）直接 Copy-Item 产物到 <preset>\temp\camera-video\<task>\，不要依赖 CLI 帮你下载
4. 用 ffmpeg 抽尾帧 PNG（ffmpeg -y -ss <duration-1> -i src.mp4 -frames:v 1 last_frame.png）作为下一段的 Picture 3 reference
5. 用 ffmpeg 抽 audio WAV（ffmpeg -y -i src.mp4 -vn -acodec pcm_s16le ref.wav）作为下一段的跨段 ref_audio
```

**pwsh timeout 陷阱**：pwsh 默认单次调用 timeout 600 秒（10 分钟），但 H3 multi-i2v 一次渲染需要 25–35 分钟。如果用 `& <exe>` 在前台跑，超时后 ps 会 kill 掉 binary 子进程。**正确做法**是前台启动后立即验证 enqueue 成功 → 放弃这个 ps session → 改用 HTTP 轮询 `/history/<prompt_id>` + 直接从 server 拷产物。CLI 进程本身会随 pwsh 超时被杀，但 ComfyUI server 上的任务会独立跑完。

## 7. 调试时怎么手动跑 CLI

每个 skill 的 `--list-actions` 是动作列表的权威来源（loader 也用它发现 action）：

```bash
<preset>\.venv\Scripts\camera-image.exe --list-actions
<preset>\.venv\Scripts\camera-video.exe --list-actions
<preset>\.venv\Scripts\camera-multiview.exe --list-actions
```

每次想看完整示例就看 `docs/cli-cookbook.md`。
