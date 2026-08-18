# Development Guide

`scripts/` 下的 3 个脚本是这个 preset 的运维核心。这份文档是它们的**操作手册**：每个脚本什么时候跑、怎么跑、跑出来什么、跑错了怎么办。

## 速查

| 任务 | 命令 |
|---|---|
| 全新机器首次安装 | `powershell -ExecutionPolicy Bypass -File scripts/setup.ps1` |
| 拉了新代码 / 改了源码 / venv 状态乱了 | 同上（幂等，会修复一切） |
| 只重写本地包（不重装 tokenizers） | `<preset>\.venv\Scripts\python.exe scripts/install_local.py` |
| 验证 SKILL.md 契约没漂移 | `<preset>\.venv\Scripts\python.exe scripts/check_contracts.py` |
| 单独看一个 CLI 的 actions | `<preset>\.venv\Scripts\<cli>.exe --list-actions` |

---

## `scripts/setup.ps1` — 一次性安装（幂等）

唯一入口。其它所有脚本都假设 `setup.ps1` 已经跑过。

### 它做了什么

按顺序：

1. **定位 Python**：先看 `<preset>/.venv/Scripts/python.exe`，没有就在 PATH 里找 `python` / `python3` / `py`
2. **建 venv**：复用现有的，没就 `python -m venv .venv`
3. **装第三方依赖**：`pip install tokenizers==0.22.2`（h3 prompt 唯一需要的 PyPI 包）
4. **装本地包**：调 `install_local.py` —— **绕开 `pip install -e`**（原因见 `architecture.md`）
5. **自检 5 个 CLI**：每个跑 `--list-actions`，必须返回非空
6. **提示 Node.js**：`npx` 没找到就 warn（camera 执行需要，但 prompt 编写不需要）

### 跑法

```powershell
# 正常
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1

# 想看每步详细输出（默认 quiet）
# （当前脚本没 -Verbose flag；要详细就把对应 echo 那行的注释去掉或加 Write-Host）
```

### 退出码

- `0`：全部完成，5 个 CLI 都能跑
- `1`：自检失败 —— 看最后 5 行，哪个 CLI 的 `--list-actions` 失败 / 没返回 actions

### 幂等性

随便重跑，不会越弄越乱。每次跑都会：

- 重写 8 个本地包的 `.pth` + dist-info + launcher
- 清掉所有 `__editable__.*.pth` 遗留（旧 pip -e 的痕迹）
- 清掉 `~*` 前缀的 dist-info 残留（pip 中断安装的痕迹）
- 跳过已经满足版本的 `tokenizers`

**什么时候必须重跑**：

- 改了 `skills/<name>/pyproject.toml` 里的版本号
- 改了 `runtime/*` 或 `skills/*` 的代码想 reload（虽然 venv 是源树直引，reload 通常不需要）
- 看到 `chenxin_runtime` 在 venv python 里 import 失败
- 在别的机器上复制了 preset
- `loader.js` 抱怨 `resolveVenvScripts` 返回 null（5 个 `.exe` 缺失）

### 故障排除

| 症状 | 原因 | 处理 |
|---|---|---|
| `No Python interpreter found on PATH` | 没装 Python 或不在 PATH | 装 Python 3.10+，确保 `python` 在 PATH |
| `venv creation failed` | 系统没 `venv` 模块 / 权限不够 | 重装 Python 勾 "tcl/tk and idle" |
| `pip install tokenizers` 失败 | 网络 / PyPI mirror 问题 | 手动 `pip install tokenizers==0.22.2 -i https://pypi.org/simple` |
| `install_local.py failed` | 源码不完整 / 权限不够 | 看 install_local.py 的报错 |
| `SELF-CHECK FAILED: <cli>.exe missing` | install_local 没生成那个 exe | 重跑；不行就 `<preset>\.venv\Scripts\python.exe scripts\install_local.py` 单独跑 |

---

## `scripts/install_local.py` — 绕开 pip 装本地包

### 为什么存在

`pip install -e <local-dir>` 在目标机器上**稳定失败**：

- 症状：`OSError [Errno 13] Permission denied` 在 `pip-build-tracker-*/<hash>` 路径
- 手动 `os.open(path, O_CREAT|O_EXCL, 0o600)` 写同一路径 → **成功**
- 结论：失败在 pip 的 build-isolation 流程里，跟具体路径 / 父目录无关；最可能是 AV / EDR 把 pip 的临时 build 目录隔离了
- 证据：`<venv>/Lib/site-packages/~omfyui_chenxin_mcp-0.2.0.dist-info` 这种 `~` 前缀的残骸——是 pip 中断升级留下的

修法：本地包**不走 pip**。它们是源码树的一部分，不需要 build / wheel / 隔离环境。我们写 pip 本来会写的产物：

```
<venv>/Lib/site-packages/<import_name>.pth          ← source dir 路径（importability）
<venv>/Scripts/<cli>.exe + <cli>-script.py + .cmd    ← distlib launchers（executable）
<venv>/Lib/site-packages/<name>-<ver>.dist-info/     ← METADATA + RECORD + direct_url.json（pip list 兼容）
```

`tokenizers` 仍走 `pip install`，因为它是真正的 PyPI 包，pip 处理它没问题。

### 用法

```bash
# 默认：找当前 python 的 venv，把 8 个本地包按 PACKAGES 表装好
<preset>\.venv\Scripts\python.exe scripts/install_local.py

# 显式指定 preset 路径（默认是脚本所在目录的父目录）
<preset>\.venv\Scripts\python.exe scripts/install_local.py --preset D:/projects/comfyui-chenxin
```

### 它做了哪些事（每个包都做）

1. 读 `PACKAGES` 表（脚本顶部硬编码 8 个包）
2. 检查源目录存在 + 包含正确的 `<import_name>/__init__.py`
3. **清理遗留**：所有 `__editable__.<name>-*.pth` + 配套 finder + 旧版本 dist-info
4. **清 pip `~` 残留**（一次性，session 开头）
5. **写 `.pth`**：`<import_name>.pth` 单行写源目录绝对路径
6. **写 launcher**（如果有 cli）：用 `pip._vendor.distlib.scripts.ScriptMaker` 生成 `<cli>.exe` + 配套 `-script.py` + `.cmd`
7. **写最小 dist-info**：`METADATA`（name + version + Requires-Dist）+ `RECORD` + `direct_url.json`（标 editable）

### 维护 PACKAGES 表

源码版本变了要同步改这里：

```python
# scripts/install_local.py 第 59 行附近
PACKAGES = [
    {"name": "comfyui-http-runtime", "version": "1.0.0", ...},
    {"name": "anima-prompt-v1",      "version": "3.0.0", ...},   # ← pyproject 改了这里也要改
    ...
]
```

`name` 跟 `pyproject.toml` 的 `[project] name` 一致（不是 import name）；`version` 跟 `version =` 一致；`cli` 跟 `[project.scripts]` 一致。

### 输出解读

```
[install-local] preset   = C:\Users\...\comfyui-chenxin
[install-local] venv     = C:\Users\...\comfyui-chenxin\.venv
[install-local] site     = C:\Users\...\comfyui-chenxin\.venv\Lib\site-packages
[install-local] comfyui-http-runtime: cleared 1 legacy artifact(s)   ← 清掉了旧 __editable__ 文件
[install-local] comfyui-http-runtime: wrote comfyui_http.pth         ← 写了 .pth
[install-local] comfyui-http-runtime: dist-info comfyui_http_runtime-1.0.0.dist-info
... (8 个包)
[install-local] done — venv in sync with source tree
```

如果有 `cleared N legacy artifact(s)`，说明 venv 上次 install 不干净（正常 —— 旧 preset 版本 + 你手动改过 `.venv` 都会留痕迹）。没残留的话这一行会消失。

### 退出码

- `0`：全部 8 个包成功
- `1`：某个包源目录缺 `__init__.py` 或目录不存在 —— 看 `[install-local] FAILURES:` 列表

---

## `scripts/check_contracts.py` — SKILL.md 契约 gate

每个 SKILL.md 顶部的 **第一个 jsonc 代码块**就是这个 skill 的**官方请求样板**。`check_contracts.py` 把它解出来，跑过对应 CLI 的真实 parser。如果 parser 拒收，SKILL.md 和代码就漂移了——修 SKILL.md（不要改 parser 让它更宽松）。

### 用法

```bash
# 在 preset 根目录跑
<preset>\.venv\Scripts\python.exe scripts/check_contracts.py

# 或直接（如果已在 venv 内）
python scripts/check_contracts.py
```

### 它检查什么

5 个 SKILL.md × 各 1 个 jsonc 例子：

| SKILL.md | 示例被解析成什么 |
|---|---|
| `skills/anima-prompt-v1/SKILL.md` | `UserBrief`（看 `anima_prompt_v1.cli._coerce_brief`） |
| `skills/minimax-h3-prompt/SKILL.md` | `StoryRequest`（看 `h3_prompt.contracts.parse_request`，按第一个 jsonc 块的 stage 字段；缺则用 t2va） |
| `skills/camera-image/SKILL.md` | `RunConfig`（看 `camera_image.runtime.request.parse_request`，按 stage 字段） |
| `skills/camera-video/SKILL.md` | `RunConfig`（按 stage 字段） |
| `skills/camera-multiview/SKILL.md` | `RunConfig`（看 `camera_multiview.config.RunConfig.from_envelope`） |

### 退出码

- `0`：5 个契约全过
- `1`：至少一个 SKILL.md 的例子被 parser 拒收

### 什么时候跑

- 改 `SKILL.md` 的请求 schema 段后
- 改 cli.py / runtime 的请求解析逻辑后
- CI / 提交前（如果设了 pre-commit hook）

### 失败怎么办

```
contract drift in skills/camera-image/SKILL.md:  example block rejected by camera_image.runtime.request.parse_request
  reason: 'profile_id' must equal 'camera-anima-v1', got 'foo'
```

修 SKILL.md 的 jsonc 例子，让它跟 parser 当前接受的输入一致。**永远不要为了让 SKILL.md 通过去改 parser**——SKILL.md 是契约，parser 是实现。

---

## 脚本的依赖关系

```
setup.ps1
  ├── 创建/复用 .venv
  ├── pip install tokenizers
  ├── python .venv/Scripts/python.exe scripts/install_local.py
  └── 自检 5 个 .exe

install_local.py
  ├── pip._vendor.distlib.scripts.ScriptMaker   ← Python 自带
  ├── 写 .pth / dist-info                       ← 纯文件操作
  └── 不依赖 pip install

check_contracts.py
  ├── import 5 个 skill 的运行时
  ├── strip_jsonc()                            ← 自实现的 JSONC 注释剥离
  └── 每个 skill 的 parse_request()             ← 用 skill 自己的 parser
```

`check_contracts.py` 用 `sys.path.insert(...)` 把 5 个 skill 目录加进去（因为它们是 source-tree package，importable 不需要 pip install）。前提是 venv 已经 setup 好了。

---

## 资产替换协议（camera-image manifest 轮换）

改 `camera-anima.json`（或它的 `workflow/<stage>/groups.json`）之后，`manifest.json` 里的 sha256 + fingerprint 必须同步，否则每次 `run` 都 fail-closed。

1. 改 `camera_image/runtime/workflow_assets/camera-anima.json`（或 group 文件）。
2. 从 preset 根目录跑 recompute 脚本（它读相对路径）：
   ```powershell
   cd <preset>
   <preset>\.venv\Scripts\python.exe docs\recompute_manifest.py
   ```
   脚本打印新旧 sha256 / fingerprint 对比，保存 `manifest.json.legacy.before-run`（首次），然后重写 manifest。
3. 验证资产：
   ```powershell
   <preset>\.venv\Scripts\camera-image.exe assets verify --stage t2i
   <preset>\.venv\Scripts\camera-image.exe assets verify --stage i2i
   ```
4. 验证契约 gate：
   ```powershell
   <preset>\.venv\Scripts\python.exe scripts\check_contracts.py
   ```
5. 如果 `profile_id` 变了，同步更新 `SKILL.md` 的 `profile_id` 字段默认值。

> camera-video / camera-multiview 的 asset 替换走各自 `runtime/workflow_assets/README.md` 里的协议（同样的三步：改图 → 重算 hash → 更新 manifest → `assets verify`）。
