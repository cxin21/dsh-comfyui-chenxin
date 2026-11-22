# ComfyUI Chenxin Preset

DSH 预设：3 个 camera 技能 + 1 个提示词创作插件（prompt-forge）+ 共享运行时，让 agent 在本机 ComfyUI 上完成 Anima / MiniMax H3 提示词编写与生图生视频。

![GitHub stars](https://img.shields.io/github/stars/cxin21/dsh-comfyui-chenxin)
![GitHub license](https://img.shields.io/github/license/cxin21/dsh-comfyui-chenxin)
![GitHub release](https://img.shields.io/github/v/release/cxin21/dsh-comfyui-chenxin)
![GitHub last commit](https://img.shields.io/github/last-commit/cxin21/dsh-comfyui-chenxin)
![Platform](https://img.shields.io/badge/Platform-Windows-blue)
![DSH](https://img.shields.io/badge/DSH-Agent%20Preset-8A2BE2)

## ✨ 功能亮点

- **3 个开箱即用的 camera CLI 技能 + 提示词创作插件**：生图 + 生视频 + 多视图角色卡；Anima / MiniMax H3 提示词编写由 prompt-forge 插件承担
- **Anima 文生图 / 图生图**：`camera-image`（t2i / i2i），pinned 工作流零配置
- **MiniMax H3 视频**：`camera-video`（t2v / i2v / multi-i2v），支持跨段参考图与参考音频
- **多视图角色卡**：`camera-multiview`（Flux2-Klein），一张卡出多视角
- **统一 P1 Envelope**：所有 CLI 输出结构一致，agent / 脚本都好解析
- **幂等一键安装**：`scripts/setup.ps1` 自动建 venv、装依赖、自检 3 个 CLI

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
# （camera_image / camera_video / camera_multiview）；提示词创作由 prompt-forge 插件承担
```

> **大文件不走 git**：三个知识库快照（共 ~993 MB）体积过大，托管在
> [GitHub Releases](https://github.com/cxin21/dsh-comfyui-chenxin/releases)（tag `v0.1.0`，
> gzip 压缩后共 ~241 MB）。clone 后按上表放回路径即可，仓库内 `.gitignore` 已排除它们。

`scripts/setup.ps1` 会创建 `<preset>/.venv`、装 `tokenizers`、把 6 个本地包装进 venv、自检 3 个 CLI，全部幂等。详见 `docs/development.md`。

### 让 DSH 认到这个 preset

DSH 只通过 **bundle** 装载预设（`plugin_manager` 装一个声明了 `dsh.bundle.patch` 的包）。仓库里两份装配文件的分工是：

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 声明，`dsh.bundle.patch` 指向 `cordis.patch.yml` |
| `cordis.patch.yml` | **DSH 真正加载的**那份（`insert` 一条 `preset-comfyui-chenxin`） |
| `agent.cordis.yml` | 同一份 entry 列表的可移植形态，供人阅读与评审 |

`agent.cordis.yml` 和 `cordis.patch.yml` 的 entry 列表**逐条完全相同，没有任何允许差异**——两份文件都不含机器相关路径。`./` 开头的 plugin `name` 由 dsh-app-boot 在加载时锚定到 patch 文件所在目录，`comfyui-loader.presetRoot` 保持 `null` 让 loader.js 回落到自己的 `__dirname`（Node 会把 symlink 模块解析到 realpath，所以 profile 里的链接照样指向 checkout）。需要按机器覆盖的配置写进 profile 自己的 `cordis.patch.yml`（user 层），不要写进仓库。

两份必须锁步——改一份就要改另一份，然后跑

```powershell
python scripts/check_lockstep.py
```

它断言四件事：entry 列表逐条相同、两份文件都不含机器相关路径、每个 `./` 入口在磁盘上真实存在、`preset.yml` 的 name/description 与 patch 一致。为什么这条要紧：**DSH 读的是 `cordis.patch.yml`**，`agent.cordis.yml` 只是给人读的那份；两者漂移时，你改的东西不会生效，而不改的东西会生效。

> **`plugins/prompt-forge/dist/` 不入 git**（构建产物）。所以全新 clone 里 patch 指向的入口文件还不存在，而 dsh-app-boot 会把 bundle 加载失败静默塞进 `skippedBundles`（不打印任何东西）——表现是「预设起来了但没有 prompt-forge 工具」。`scripts/setup.ps1` / `setup.sh` 现在会在第 5 步自动 `npm ci && npm run build`；如果你跳过了 setup，手动跑一次 `cd plugins/prompt-forge && npm ci && npm run build`。

> 旧版 DSH 用 `$DSH_HOME/.agent-presets/<id>/` 目录装载（`preset.yml` + `agent.cordis.yml`）。**那个目录现在没有任何代码读取**，所以本仓库不再提供该形态的安装步骤；`agent.cordis.yml` 保留只是为了可读性 + 锁步 gate。

装成 bundle 一次即可，装完 profile 的 `package.json` 里 `dsh.profile.bundles` 会多一项，重启 DSH 后新会话可在预设菜单里选 `ComfyUI Chenxin`：

- **Desktop**：侧栏 **Plugins** 页面 → **Add plugin**，填入本 checkout 的绝对路径 → 安装后 **Enable now**。或对 agent 说「用 plugin_manager 安装 `link:<checkout 绝对路径>`」。桌面端的 profile 由 Electron 拥有，`dsh plugin` 命令会拒绝管理它（设置里的 **Built-in plugins** 只是只读清单）。
- **命令行 profile**：`dsh plugin --profile <name> add link:<checkout 绝对路径>`（需 pnpm 在 `PATH` 上）。

`link:` 意味着改源码后要重新构建（`cd plugins/prompt-forge && npm run build`）并重启才生效；它用这个 checkout 的依赖，不会另装一份。安装 bundle 会在 Host 进程里执行插件代码，需要 Full access 或一次批准。

## 这是什么

```
┌──────────────────────────────────────────────────────────────────────┐
│  agent ──► loader.js ──► ctx.skills (catalog) + ctx.tools (3 个 CLI)   │
│                                                                      │
│  plugins/prompt-forge  ← 提示词创作内核（Anima/H3 编译+审计+管理）    │
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
| 写 Anima 提示词（slot → 单行 positive/negative） | `prompt_author` (target=anima) / `prompt_compile`（prompt-forge 插件） | `camera-image` |
| 写 MiniMax H3 视频提示词（T2VA / I2VA / FL2VA / L2VA / Ref2VA） | `prompt_author` (target=h3) / `prompt_compile`（prompt-forge 插件） | `camera-video` |
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
├── package.json                         ← DSH bundle 声明（指向 cordis.patch.yml）
├── loader.js                            ← DSH 插件入口
├── agent.cordis.yml                     ← Cordis 组合配置（可移植形态）
├── cordis.patch.yml                     ← 同一组合的部署形态（bundle 消费）
├── requirements.lock                    ← 第三方依赖钉版（17 个包）
├── scripts/
│   ├── setup.ps1                        ← 一键安装（幂等）
│   ├── setup.sh                         ← 同上，POSIX
│   ├── install_local.py                 ← 绕开 pip 的本地包安装器
│   ├── check_contracts.py               ← SKILL.md 契约 gate
│   ├── check_loader.mjs                 ← loader 接线 / 失败域隔离 gate
│   └── check_lockstep.py                ← agent.cordis.yml ↔ cordis.patch.yml 一致性 gate
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
├── data/
│   └── runtime/                         ← prompt_feedback 反馈记录（feedback.sqlite）
├── assets/knowledge/                    ← 知识资产（prompt-forge 只读消费）
│   ├── anima-prompt-v1/                 ← tag-catalog.sqlite / tags.sqlite / manifest.json
│   └── minimax-h3-prompt/               ← tokenizer.json / tokenizer_config.json / chat_template.json
├── plugins/prompt-forge/               ← 提示词创作内核（编译+审计+管理工具）
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

Anima/H3 提示词创作由 prompt-forge 插件的 `prompt_author` / `prompt_compile` / `prompt_audit` 工具承担（不走 CLI）；camera-* CLI 只负责执行渲染，始终吐 envelope。

## 下一步

- **新用户**：先读 [`AGENTS.md`](AGENTS.md)，看任务→工具路由
- **agent**：提示词创作走 prompt-forge 的 14 个工具（`prompt_author` / `prompt_compile` / `prompt_audit` / `prompt_feedback` / `prompt_expand` / `prompt_reverse` / `minimax_scenario` / `style_list` / `style_save` / `profile_list` / `catalog_search` / `catalog_artist_add` / `catalog_relations` / `catalog_build`，逐个的用途与入参见 [`AGENTS.md`](AGENTS.md) §1）；渲染执行走 host tool `camera_image` / `camera_video` / `camera_multiview`（loader 已注册）
- **开发者 / 调试**：读 [`docs/development.md`](docs/development.md) + [`docs/cli-cookbook.md`](docs/cli-cookbook.md)
- **已知问题 / 审计**：读 [`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md)

## 参与贡献

欢迎 issue 与 PR：bug 报告请附完整 CLI envelope（`errors[].code`）与 exit code；环境搭建与提交前质量门见 [CONTRIBUTING.md](CONTRIBUTING.md)（`scripts/check_contracts.py` 契约 gate + `scripts/check_loader.mjs` loader 接线 gate + `plugins/prompt-forge` 测试）。新增动作只改对应 skill 的 `cli.py`——loader 经 `--list-actions` 自动发现；固定工作流 asset 结构不要动（[AGENTS.md](AGENTS.md) §4）。
