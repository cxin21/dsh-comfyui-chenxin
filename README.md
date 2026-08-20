# ComfyUI Chenxin Preset

DSH 预设：5 个 prompt + camera 技能 + 共享运行时，让 agent 在本机 ComfyUI 上完成 Anima / MiniMax H3 提示词编写与生图生视频。

![GitHub stars](https://img.shields.io/github/stars/cxin21/dsh-comfyui-chenxin)
![GitHub license](https://img.shields.io/github/license/cxin21/dsh-comfyui-chenxin)
![GitHub release](https://img.shields.io/github/v/release/cxin21/dsh-comfyui-chenxin)
![GitHub last commit](https://img.shields.io/github/last-commit/cxin21/dsh-comfyui-chenxin)
![Platform](https://img.shields.io/badge/Platform-Windows-blue)
![DSH](https://img.shields.io/badge/DSH-Agent%20Preset-8A2BE2)

## ✨ 功能亮点

- **5 个开箱即用的 CLI 技能**：提示词编写（Anima / MiniMax H3）+ 生图 + 生视频 + 多视图角色卡
- **Anima 文生图 / 图生图**：`camera-image`（t2i / i2i），pinned 工作流零配置
- **MiniMax H3 视频**：`camera-video`（t2v / i2v / multi-i2v），支持跨段参考图与参考音频
- **多视图角色卡**：`camera-multiview`（Flux2-Klein），一张卡出多视角
- **统一 P1 Envelope**：所有 CLI 输出结构一致，agent / 脚本都好解析
- **幂等一键安装**：`scripts/setup.ps1` 自动建 venv、装依赖、自检 5 个 CLI

## 5 分钟跑起来

```powershell
# 一次性：装 Python 3.10+，把 preset 拿到本地，然后：
git clone https://github.com/cxin21/dsh-comfyui-chenxin.git
# 从 GitHub Releases (v0.1.0) 下载 3 个数据包（.gz），解压后放回：
#   skills/anima-prompt-v1/knowledge/tag-catalog.sqlite   （来自 tag-catalog.sqlite.gz）
#   skills/anima-prompt-v1/knowledge/tags.sqlite          （来自 tags.sqlite.gz）
#   skills/minimax-h3-prompt/knowledge/tokenizer.json     （来自 tokenizer.json.gz）
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1

# 重启 DSH，会话起来后 loader 会自动注册 5 个 CLI 工具
# （anima_prompt_v1 / minimax_h3_prompt / camera_image / camera_video / camera_multiview）
```

> **大文件不走 git**：三个知识库快照（共 ~993 MB）体积过大，托管在
> [GitHub Releases](https://github.com/cxin21/dsh-comfyui-chenxin/releases)（tag `v0.1.0`，
> gzip 压缩后共 ~241 MB）。clone 后按上表放回路径即可，仓库内 `.gitignore` 已排除它们。

`scripts/setup.ps1` 会创建 `<preset>/.venv`、装 `tokenizers`、把 8 个本地包装进 venv、自检 5 个 CLI，全部幂等。详见 `docs/development.md`。

## 这是什么

```
┌──────────────────────────────────────────────────────────────────────┐
│  agent ──► loader.js ──► ctx.skills (catalog) + ctx.tools (5 个 CLI)   │
│                                                                      │
│  skills/anima-prompt-v1    ← Anima 提示词编译器（slot → tag）         │
│  skills/minimax-h3-prompt  ← MiniMax H3 提示词编译器（T2VA/I2VA/...） │
│  skills/camera-image       ← Anima camera workflow（t2i/i2i）        │
│  skills/camera-video       ← MiniMax H3 视频（t2v/i2v/multi-i2v）    │
│  skills/camera-multiview   ← Flux2-Klein 多视图角色卡                  │
│                                                                      │
│  runtime/chenxin_runtime   ← P1 envelope + 共享 CLI runner + 相机引擎 │
│  runtime/comfyui_http      ← stdlib HTTP 通道（history/view）          │
│  runtime/comfyui_mcp       ← comfyui-mcp stdio JSON-RPC 客户端         │
└──────────────────────────────────────────────────────────────────────┘
```

3 个 runtime 包是 Python 源码（不是 wheel），通过 `.pth` + distlib launchers 直接装进 venv——绕开 `pip install -e` 的构建路径（在那台 Windows 机器上会稳定报错）。详见 `docs/architecture.md`。

## 给谁用、什么时候调哪个 skill

| 我想做 | 用这个 skill | 然后用 |
|---|---|---|
| 写 Anima 提示词（slot → 单行 positive/negative） | `anima-prompt-v1` | `camera-image` |
| 写 MiniMax H3 视频提示词（T2VA / I2VA / FL2VA / L2VA / Ref2VA） | `minimax-h3-prompt` | `camera-video` |
| 跑 Anima 图（text→image / image→image） | `camera-image` | — |
| 跑 MiniMax H3 视频 | `camera-video` | — |
| 跑多视图角色卡（Flux2-Klein） | `camera-multiview` | — |

完整决策树见 `AGENTS.md`。

## 仓库结构

```
.
├── README.md                            ← 本文件
├── AGENTS.md                            ← agent 工作守则
├── preset.yml                           ← loader 注册元数据
├── loader.js                            ← DSH 插件入口
├── scripts/
│   ├── setup.ps1                        ← 一键安装（幂等）
│   ├── install_local.py                 ← 绕开 pip 的本地包安装器
│   └── check_contracts.py               ← SKILL.md 契约 gate
├── docs/
│   ├── architecture.md                  ← 设计原理与契约
│   ├── cli-cookbook.md                  ← 每个 CLI 的完整使用手册
│   ├── development.md                   ← setup / install_local / 调试
│   └── troubleshooting.md               ← 常见错误与恢复
├── temp/                                ← 运行时生成物（可按技能子目录清理）
│   ├── anima-prompt-v1/                 ← catalog.sqlite / relation-overlay.sqlite
│   ├── camera-image/                    ← t2i/i2i 产物 PNG + summary.json
│   ├── camera-video/                    ← t2v/i2v/multi-i2v 产物 mp4 + summary.json
│   ├── camera-multiview/                ← 多视图 PNG + summary.json
│   ├── minimax-h3-prompt/               ← 预留（当前无落盘产物）
│   └── runtime/.workflow_cache/         ← 引擎缓存（10-deep LRU）
├── skills/
│   ├── anima-prompt-v1/
│   │   ├── SKILL.md                     ← LLM 契约
│   │   └── references/                  ← 实现细节、规则
│   ├── minimax-h3-prompt/
│   │   ├── SKILL.md
│   │   ├── knowledge/                   ← tokenizer snapshot
│   │   └── references/
│   ├── camera-image/
│   │   ├── SKILL.md
│   │   └── camera_image/runtime/        ← 请求解析 / graph / assets
│   ├── camera-video/
│   │   ├── SKILL.md
│   │   └── camera_video/runtime/
│   └── camera-multiview/
│       ├── SKILL.md
│       ├── camera_multiview/
│       └── references/
└── runtime/
    ├── chenxin_runtime/                 ← P1 envelope + camera 引擎
    ├── comfyui_http/                    ← stdlib HTTP
    └── comfyui_mcp/                     ← stdio JSON-RPC
```

## 输出位置约定

所有运行时写出的文件都落在 `<preset>/temp/` 下，按技能分子目录（见上）。三个 camera CLI 的 `--output-dir` 现在**可选**：不传时默认 `temp/<skill>/`，传了则覆盖；anima 的 `catalog build` / `relation.*` 也有同样的默认路径。清理时删整个 `temp/` 即可，`skills/` 与 `runtime/` 源码保持干净。

## 输出格式：P1 JSON Envelope

每个 CLI 都吐 P1 envelope 到 stdout：

```json
{
  "ok": true,
  "command": "author",
  "stage": "t2i",
  "result": { ... },
  "errors": [],
  "advisories": []
}
```

退出码（按 category）：

| Category | Exit |
|---|---|
| `request` | 2 |
| `validation` | 3 |
| `integrity` | 4 |
| `runtime` | 5 |
| `unexpected` | 70 |

> 此表是汇总；**每个 skill 的 SKILL.md 里的 failure-modes 表是权威**（个别 error code 映射到不同 exit，例如 camera-multiview 的 `McpError` 映射到 5、`AssetError` 映射到 4）。

`anima-prompt-v1 author` 在没 `--json` 时会切换到纯文本（`POSITIVE: ... / NEGATIVE: ...`），其他 CLI 始终吐 envelope。

## 下一步

- **新用户**：先读 [`AGENTS.md`](AGENTS.md)，看任务→skill 路由
- **agent**：直接通过 host tool 调用 `anima_prompt_v1` / `minimax_h3_prompt` / `camera_image` / `camera_video` / `camera_multiview`（loader 已注册）
- **开发者 / 调试**：读 [`docs/development.md`](docs/development.md) + [`docs/cli-cookbook.md`](docs/cli-cookbook.md)
- **已知问题 / 审计**：读 [`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md)
