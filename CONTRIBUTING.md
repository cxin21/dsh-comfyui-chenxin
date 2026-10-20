# Contributing Guide（参与贡献）

感谢关注 ComfyUI Chenxin Preset！开工前请先读 [`AGENTS.md`](AGENTS.md)（任务路由、调用纪律与硬边界）与 [`docs/architecture.md`](docs/architecture.md)（设计原理与契约）。

## 环境搭建（当前仅支持 Windows）

1. 准备 Python 3.10+ 与 Node.js（comfyui-mcp 子进程需要 `npx`）
2. `git clone` 本仓库
3. 从 [Releases (v0.1.0)](https://github.com/cxin21/dsh-comfyui-chenxin/releases) 下载 3 个数据包（gzip 后共 ~241 MB），解压后放回 `assets/knowledge/` 对应路径（见 README「5 分钟跑起来」的路径表）
4. `powershell -ExecutionPolicy Bypass -File scripts/setup.ps1` —— 幂等安装：建 `.venv`、装依赖、自检 3 个 camera CLI

## 欢迎的贡献

- **Bug 报告**：附完整 P1 envelope（`errors[].code` 与 `advisories`）、CLI exit code、`--list-actions` 输出、ComfyUI 后端版本；先对照 [`docs/troubleshooting.md`](docs/troubleshooting.md) 的错误恢复表
- **文档改进**：以一手实测为准；`SKILL.md` 的 failure-modes 表是 exit code 的权威，改动须同步通过 `scripts/check_contracts.py`
- **新增 skill 动作**：只改对应 skill 的 `cli.py` —— loader 通过 `--list-actions` 动态发现，无需改 `loader.js`
- **prompt-master 插件**：提示词创作内核，见 [`plugins/prompt-master/AGENTS.md`](plugins/prompt-master/AGENTS.md) 与其自带测试

## 硬边界（不要做，来自 AGENTS.md §4）

- 不要修改固定工作流 asset 的 node 结构（`camera-anima.json` / `Flux2-Klein人物一键多视图工作流.json`）——调用方只写请求表面
- 不要破坏 P1 envelope 契约（`ok` / `command` / `stage` / `result` / `errors` / `advisories`）与按 category 的退出码约定
- 运行时产物一律落 `temp/`，不要写进 `skills/`
- 大文件（知识库快照 ~993 MB）走 Releases，不进 git（`.gitignore` 已排除）

## 提交前质量门

- `python scripts/check_contracts.py` —— SKILL.md 契约 gate（前提：`.venv` 已 setup）
- `cd plugins/prompt-master` 后跑测试（`vitest run`，依赖按仓库内 `bun.lock` 安装）—— 全绿才算完成

## 提交约定

- 一个 PR 只做一件事；commit message 走 conventional commits 风格（参照现有历史，如 `fix(directing): #29 …`）
- PR 描述写清：动机、改动面、质量门证据（契约 gate + 测试输出）
- 本仓库以 MIT License 授权，提交即视为同意按该协议授权你的贡献

## 先讨论再动手

涉及新 skill、跨平台支持、工作流 asset 或知识资产结构的改动，请先开 issue 对齐方案再实现。
