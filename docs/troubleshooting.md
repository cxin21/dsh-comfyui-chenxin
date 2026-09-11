# Troubleshooting

按症状 → 诊断 → 恢复 排列。所有 CLI 都返回 P1 envelope + 退出码组合，先看这两个。

## 1. CLI 找不到 / 报 ModuleNotFoundError

### 症状

```
The term 'anima-prompt-v1' is not recognized as the name of a cmdlet, function, script file, or operable program.
```

或裸 `python`：

```
ModuleNotFoundError: No module named 'chenxin_runtime'
```

### 诊断

`scripts/setup.ps1` 没跑，或者跑的时候 venv 没创建完整。检查：

```powershell
Test-Path "<preset>\.venv\Scripts\anima-prompt-v1.exe"   # 应该是 True
Test-Path "<preset>\.venv\Scripts\python.exe"           # 应该是 True
```

### 恢复

```powershell
powershell -ExecutionPolicy Bypass -File <preset>\scripts\setup.ps1
```

完了之后**重启 DSH 会话**——`loader.js` 在 session 启动时跑 `resolveVenvScripts`，缺一次扫描。

> 不要试图改 `PATH` 或装到 system Python：preset 不污染系统环境，所有东西都在 venv 里。激活 venv：`.\.venv\Scripts\Activate.ps1`；或直接调 `.venv\Scripts\<cli>.exe`。

---

## 2. `loader.js` 没注册 CLI 工具（DSH 会话里看不到 host tool）

### 症状

- DSH agent 报 "no tool named `minimax_h3_prompt`"
- loader 控制台日志：`[comfyui-chenxin] .venv not found — CLI wrapper tools will be skipped.`

### 诊断

`loader.js` 的 `resolveVenvScripts()` 要求 `<preset>/.venv/Scripts/` 里**全部 5 个** console-script `.exe` 都存在，缺一个就跳过整个 CLI tool 注册。

```powershell
<preset>\.venv\Scripts\anima-prompt-v1.exe --list-actions
<preset>\.venv\Scripts\minimax-h3-prompt.exe --list-actions
<preset>\.venv\Scripts\camera-image.exe --list-actions
<preset>\.venv\Scripts\camera-video.exe --list-actions
<preset>\.venv\Scripts\camera-multiview.exe --list-actions
```

任何一个 `Test-Path` 是 False 就是病因。

### 恢复

```powershell
# 修 venv
powershell -ExecutionPolicy Bypass -File <preset>\scripts\setup.ps1
# 重启 DSH session
```

---

## 3. `setup.ps1` 自检失败：`SELF-CHECK FAILED: <cli>.exe missing`

### 诊断

`install_local.py` 没生成那个 `.exe`。可能是：

- `PACKAGES` 表里 `cli` 字段配错了
- 源目录里 `cli.py` 缺 `main()` 或 `main()` 没标 `--list-actions` 处理
- distlib launchers 因为 OS / Python 版本问题没生成

### 恢复

1. 看 `<preset>/scripts/install_local.py` 顶部 `PACKAGES` 表，`cli` 字段要等于 `(cli_name, cli_target)`：
   ```python
   "cli": ("anima-prompt-v1", "anima_prompt_v1.cli:main")
   ```
2. 看对应 skill 的 `cli.py`，确认 `main()` 里有 `--list-actions` 路由（裸 `if "--list-actions" in sys.argv[1:]: print(...)` 或 `main_entry`/`Subcommand` 内部自动处理）
3. 手动跑 install_local 看输出：
   ```bash
   <preset>\.venv\Scripts\python.exe <preset>\scripts\install_local.py
   ```
4. 还不行就重启 venv：删 `<preset>\.venv`，重跑 setup.ps1

---

## 4. `pip install tokenizers` 失败

### 症状

```
ERROR: Could not install packages due to an OSError: [Errno 13] Permission denied
```

### 诊断

不是 tokenizers 本身的问题——是 pip 的 build 流程在那台机器上整体不稳定（同样的失败也会让 `pip install -e <local-dir>` 失败）。`tokenizers` 是 wheel 包，理论上只下载不构建；如果还失败，说明**系统级**问题（网络、临时目录权限、AV）。

### 恢复

```bash
# 显式指定临时目录到 workspace 内
$env:TMP = "<preset>\.venv\.piptmp"
$env:TEMP = "<preset>\.venv\.piptmp"
New-Item -ItemType Directory -Force -Path $env:TMP

<preset>\.venv\Scripts\python.exe -m pip install tokenizers==0.22.2 ^
    --cache-dir <preset>\.venv\.piptmp\cache ^
    --no-build-isolation
```

如果 `--no-build-isolation` 报 setuptools 缺失：

```bash
<preset>\.venv\Scripts\python.exe -m pip install --upgrade pip setuptools wheel
```

如果还不行，手动下载 wheel 从 [PyPI](https://pypi.org/project/tokenizers/0.22.2/#files) 然后 `pip install tokenizers-0.22.2-cp312-cp312-win_amd64.whl`。

---

## 5. camera-image / camera-video / camera-multiview `run` 卡在 stdin

### 症状

CLI 跑了但什么都没出，停在 group plan / asset verification 确认。

### 诊断

这些 CLI 默认要求交互式 y/N：

| CLI | 何时问 |
|---|---|
| `camera-image run` | 永远问（除非 `--yes`） |
| `camera-video run` | 不问 |
| `camera-multiview run` | 不问 |

自动化场景（agent 调用、CI）必须 `--yes`，否则 stdin 是 EOF → `group_confirmation_aborted`。

### 恢复

```bash
# 加 --yes
camera-image run --stage t2i --request req.json --output-dir temp/camera-image/ --yes
```

---

## 6. envelope `ok: false` + `errors[].code`

`code` 是真错误，`advisories` 是非阻塞警告。先看 `errors`，再看 `advisories`。

### `brief_validation_failed`（anima）

brief 字段拼错。常见：

| 错 | 修 |
|---|---|
| `unknown slot(s): ['lighting']` | slot 名只能是 `SLOT_ORDER` 里的 9 个（看 anima SKILL.md） |
| `subject must be non-empty string` | `subject` 字段是 routing label，必须有 |
| `slots must be an object` | `slots` 必须是 `{slot_name: [tag, ...]}` 形式 |

### `catalog_read_failed`（anima）

`knowledge/tag-catalog.sqlite` 不存在或损坏。重新构建：

```bash
anima-prompt-v1 catalog build --source knowledge/source --output knowledge --manifest knowledge/manifest.json
anima-prompt-v1 catalog verify --database knowledge/tag-catalog.sqlite --manifest knowledge/manifest.json
```

### `h3_audit_failed`（h3）

`result.findings` 数组列出门禁失败原因，常见：

| Finding | 修 |
|---|---|
| `shot numbers must be sequential starting at 1` | 1..N 连续 |
| `first shot must not contain a timestamp` | Shot 1 不要带 `At MM:SS.mmm` |
| `every shot after the first requires At MM:SS.mmm` | Shot 2+ 都要带时间戳 |
| `declared shot count does not match shot markers` | `shots[]` 长度 = `[Shot N]` 数量 |
| `dialogue must use <d>[Language] text</d>` | `<d>` 标签套对 |

**不要把 findings 字符串贴回 H3 prompt**——那是诊断信息，不是 prompt 内容。

### `budget_exceeded`（h3）

`budget.text_tokens` 超过 `effective_cap` / `char_count` 超过 7000：

| Stage | Token cap |
|---|---|
| `t2va` | 1200 |
| `i2va` | 1500 |
| `fl2va` / `l2va` | 1700 |
| `ref2va` | 2400 |

缩短故事、砍镜头、砍 description 细节。

### `tokenizer_integrity_failed`（h3）

`<preset>/skills/minimax-h3-prompt/knowledge/tokenizer.json` 或 `manifest.json` 被改过 / 损坏。恢复：

```powershell
powershell -ExecutionPolicy Bypass -File <preset>\scripts\setup.ps1
```

setup 会重装 tokenizers，install_local 不动 tokenizer snapshot（那是 PyPI wheel 的内容），所以要从 setup 重跑。

### `official_envelope_violated`（h3）

引用资产超官方上限：

| 类型 | 上限 |
|---|---|
| 图片（ref2va） | 9 |
| 视频（ref2va） | 3 |
| 音频（ref2va） | 3 |
| 混合 | 12 |

`audio cannot be the only reference type` —— 不能只有音频。

### `generation_not_found`（prompt_feedback / prompt-master 插件）

`prompt_feedback(action=record)` 的 `generation_id` 在生成记录库中不存在：

| 原因 | 修 |
|---|---|
| `generation_id` 拼错 / 编造 | 从 `prompt_author` 成功 envelope 顶层的 `generation_id`（形如 `gen_<ts>_<rand>`）原样复制 |
| 生成记录已过 90 天保留期被懒清理 | 生成记录只保留 90 天；过期后补反馈会得到此错误，属预期行为，不可恢复 |

注意：`record` 是 UPSERT——同 `generation_id` 再次评分会覆盖旧评（补评历史不保留）。

### `prompt_author` 缺省评审/扩写（prompt-master 插件）

缺省 `judge_mode='fast'` + `enrich=true`（每次 author ≈ 3 次 LLM 调用：intent + enrich + fast 评审，pass 情形；修正轮更多）：

| 想要 | 传参 |
|---|---|
| 省成本（回旧路径） | `judge_mode:'off'`、`enrich:false`（可只关一个） |
| 更强质量把关 | `judge_mode:'strict'`（对抗二轮） |
| 输出语言 | `outputLang:'en'|'zh'|'ja'`（anima 恒锁 en；仅 h3 显式生效） |

评审/enrich 任何故障自动降级（`judge_skipped`/`enrich_skipped` advisory），出稿不中断。

### `invalid_request` / `input_file_missing`（camera-*）

- `invalid_request`：req.json 不存在、不是 JSON、字段未知
- `input_file_missing`：req.json 里的图片/参考图路径在硬盘上不存在

### `group_confirmation_aborted`（camera-image）

`run` 没加 `--yes`，stdin EOF。要么加 `--yes`，要么改成 **手动跑**（shell 里 `echo y | camera-image run ...`）。

### `fixed_workflow_invalid` / `AssetError`（camera-image / camera-multiview）

资产哈希对不上。可能是被人改了，也可能是 Windows NTFS 大小写 / 换行差异。验证：

```bash
camera-image assets verify --stage t2i
camera-multiview assets verify
```

输出里 `verified: true` 表示正常；`false` 就看具体哪个文件哈希不对。

### `comfyui_mcp_error`（camera-*）

`comfyui-mcp` 的 npx 调用失败。诊断：

```bash
# 1. npx 在 PATH 里吗
where.exe npx
# 2. comfyui-mcp 装了吗
npx -y comfyui-mcp --help
# 3. ComfyUI 在跑吗
curl http://127.0.0.1:8188/system_stats
```

### `comfyui_runtime_error`（camera-*）

ComfyUI 拒收 API graph（通常因为节点缺模型、显存不够）。看 envelope `result.error_messages`，把原始错误透给用户。

### `unexpected_error`（全部）

未捕获异常。`stderr` 上有 traceback，发给开发者分析。

---

## 7. 检查当前状态（一行命令）

```powershell
# 5 个 CLI 都能跑吗？
@('anima-prompt-v1','minimax-h3-prompt','camera-image','camera-video','camera-multiview') | ForEach-Object {
    $r = & "<preset>\.venv\Scripts\$_.exe" --list-actions 2>&1 | Out-String
    Write-Host "$_ : $($r.Split("`n").Count) actions"
}

# venv 里 8 个本地包都装了吗？
<preset>\.venv\Scripts\python.exe -m pip list | Select-String -Pattern "anima|camera|chenxin|comfyui-|minimax|tokenizers"

# SKILL.md 契约没漂移？
<preset>\.venv\Scripts\python.exe <preset>\scripts\check_contracts.py
```

三个都过 = 系统健康。
