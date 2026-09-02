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
#   assets/knowledge/anima-prompt-v1/tag-catalog.sqlite   （来自 tag-catalog.sqlite.gz）
#   assets/knowledge/anima-prompt-v1/tags.sqlite          （来自 tags.sqlite.gz）
#   assets/knowledge/minimax-h3-prompt/tokenizer.json     （来自 tokenizer.json.gz）
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1

# 重启 DSH，会话起来后 loader 会自动注册 3 个 CLI 工具
# （camera_image / camera_video / camera_multiview）；提示词创作由 prompt-master 插件承担
```

> **大文件不走 git**：三个知识库快照（共 ~993 MB）体积过大，托管在
> [GitHub Releases](https://github.com/cxin21/dsh-comfyui-chenxin/releases)（tag `v0.1.0`，
> gzip 压缩后共 ~241 MB）。clone 后按上表放回路径即可，仓库内 `.gitignore` 已排除它们。

`scripts/setup.ps1` 会创建 `<preset>/.venv`、装 `tokenizers`、把 6 个本地包装进 venv、自检 3 个 CLI，全部幂等。详见 `docs/development.md`。

## 这是什么

```
┌──────────────────────────────────────────────────────────────────────┐
│  agent ──► loader.js ──► ctx.skills (catalog) + ctx.tools (3 个 CLI)   │
│                                                                      │
│  plugins/prompt-master  ← 提示词创作内核（Anima/H3 编译+审计+管理）    │
│  assets/knowledge/      ← 知识资产（tag-catalog/tags/tokenizer 等）   │
│  skills/camera-image    ← Anima camera workflow（t2i/i2i）            │
│  skills/camera-video    ← MiniMax H3 视频（t2v/i2v/multi-i2v）        │
│  skills/camera-multiview← Flux2-Klein 多视图角色卡                  │
│                                                                      │
│  runtime/chenxin_runtime   ← P1 envelope + 共享 CLI runner + 相机引擎 │
│  runtime/comfyui_http      ← stdlib HTTP 通道（history/view）          │
│  runtime/comfyui_mcp       ← comfyui-mcp stdio JSON-RPC 客户端         │
└──────────────────────────────────────────────────────────────────────┘
```

3 个 runtime 包是 Python 源码（不是 wheel），通过 `.pth` + distlib launchers 直接装进 venv——绕开 `pip install -e` 的构建路径（在那台 Windows 机器上会稳定报错）。详见 `docs/architecture.md`。

## 给谁用、什么时候调哪个 skill

| 我想做 | 用这个 | 然后用 |
|---|---|---|
| 写 Anima 提示词（slot → 单行 positive/negative） | `prompt_author` (target=anima) / `prompt_compile`（prompt-master 插件） | `camera-image` |
| 写 MiniMax H3 视频提示词（T2VA / I2VA / FL2VA / L2VA / Ref2VA） | `prompt_author` (target=h3) / `prompt_compile`（prompt-master 插件） | `camera-video` |
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
│   ├── anima-prompt-v1/                 ← relation-overlay.sqlite（catalog_relations）
│   ├── camera-image/                    ← t2i/i2i 产物 PNG + summary.json
│   ├── camera-video/                    ← t2v/i2v/multi-i2v 产物 mp4 + summary.json
│   ├── camera-multiview/                ← 多视图 PNG + summary.json
│   └── runtime/.workflow_cache/         ← 引擎缓存（10-deep LRU）
├── assets/knowledge/                    ← 知识资产（prompt-master 只读消费）
│   ├── anima-prompt-v1/                 ← tag-catalog.sqlite / tags.sqlite / manifest.json
│   └── minimax-h3-prompt/               ← tokenizer.json / tokenizer_config.json / chat_template.json
├── plugins/prompt-master/               ← 提示词创作内核（编译+审计+管理工具）
├── skills/
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

Anima/H3 提示词创作由 prompt-master 插件的 `prompt_author` / `prompt_compile` / `prompt_audit` 工具承担（不走 CLI）；camera-* CLI 只负责执行渲染，始终吐 envelope。

## 下一步

- **新用户**：先读 [`AGENTS.md`](AGENTS.md)，看任务→工具路由
- **agent**：提示词创作走 prompt-master 工具（`prompt_author` / `prompt_compile` / `prompt_audit` / `catalog_search` / `catalog_relations` / `catalog_build`）；渲染执行走 host tool `camera_image` / `camera_video` / `camera_multiview`（loader 已注册）
- **开发者 / 调试**：读 [`docs/development.md`](docs/development.md) + [`docs/cli-cookbook.md`](docs/cli-cookbook.md)
- **已知问题 / 审计**：读 [`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md)
