# Prompt Master MCP Server — Architecture

> **本文件为设计文档中提到的 `docs/architecture.md`**

## 1. 概述

Prompt Master MCP Server 是从「提示词大师」桌面应用（PromptMaster）提取出的提示词工程（Prompt Engineering, PE）引擎，封装为 MCP（Model Context Protocol）Server。DSH Agent 通过 MCP 工具直接调用完整的扩写、反推、训练打标、MiniMax H3 场景生成能力，无需 Electron 窗口和本地模型。

## 2. 设计原则

| 原则 | 实现 |
|------|------|
| **PE Profile 注册 + Resolver 管线** | 56 个内置 Profile（8 扩写 + 13 反推 + 12 训练 + 10 MiniMax + 13 Torii/镜像） |
| **OpenAI 兼容推理** | 替换本地 llama.cpp，云 API 路由（DeepSeek/OpenAI/SiliconFlow） |
| **1:1 移植 PM 引擎** | Config 层纯函数、零 Electron 依赖 |
| **扩展性预留** | 自定义 Provider、custom_profiles 表 |

## 3. 架构

```
┌─────────────────────────────────────────────────────────┐
│               MCP Server (stdio | SSE)                    │
├─────────────────────────────────────────────────────────┤
│  Tool Handlers (5 个 MCP 工具)                            │
│  ├── prompt_expand        (扩写)                          │
│  ├── prompt_reverse       (反推)                          │
│  ├── prompt_engineering_list                             │
│  ├── minimax_scenario     (MiniMax H3 场景)              │
│  └── provider_config      (供应商管理)                    │
├─────────────────────────────────────────────────────────┤
│  Resolver Engine                                          │
│  ├── profiles/                                             │
│  │   ├── expand-rules.ts      (8 种扩写 system prompt)    │
│  │   ├── expand-mirror.ts     (反推→扩写镜像)            │
│  │   ├── reverse/             (反推 PE 模块)               │
│  │   │   ├── router.ts                                     │
│  │   │   ├── length.ts         (反推篇幅，captionLength)   │
│  │   │   ├── tagLineSanitize.ts (tag 行清洗)              │
│  │   │   ├── comfyui.ts        (SD/ComfyUI 还原检查表)   │
│  │   │   ├── descriptive.ts   (五点结构)                  │
│  │   │   ├── danbooru.ts                                    │
│  │   │   ├── anima3.ts         (Anima3 增强)                │
│  │   │   └── prose.ts          (散文类)                    │
│  │   ├── train/                (训练打标 12 种)            │
│  │   └── torii/                (Torii 结构化)              │
│  └── minimax/                 (10 个 H3 场景)             │
│      ├── catalog.ts                                        │
│      ├── assemble.ts                                       │
│      └── templates/                                        │
│          ├── h3-reference.en.ts                             │
│          ├── h3-reference.zh.ts                             │
│          └── h3-reference.ja.ts                             │
├─────────────────────────────────────────────────────────┤
│  Provider Layer                                            │
│  ├── models.ts              (供应商定义)                  │
│  ├── client.ts               (OpenAI 兼容 HTTP 客户端)    │
│  └── index.ts                (API Key 解析 + 路由)          │
├─────────────────────────────────────────────────────────┤
│  SQLite (sql.js) Persistence                              │
│  ├── settings              (API Key)                      │
│  ├── provider_cache                                          │
│  ├── history                (扩写/反推历史)                │
│  └── custom_profiles                                         │
└─────────────────────────────────────────────────────────┘
```

## 4. MCP Tools

| Tool | 描述 | 核心调用链 |
|------|------|------------|
| `prompt_expand` | 扩写简短描述为完整绘图提示词 | Resolver → Provider → History |
| `prompt_reverse` | 从图片描述生成反推提示词 | Resolver → Provider → History |
| `prompt_engineering_list` | 列出所有 Profile | Profile Registry |
| `minimax_scenario` | 按场景生成 MiniMax H3 视频提示词 | Scenario Catalog → Assemble → Provider → History |
| `provider_config` | 管理供应商配置 | DB Settings |

## 5. PE Pipeline

**扩写管线：**
```
用户输入(text, profile, ...)
    ↓
findProfileById(profile_id)  →  PEProfile
    ↓
resolveExpand(profile, params)
    ├─ builtin expand_*  → resolveExpandSystemMessage + buildExpandUserPrompt
    ├─ builtin expand_*镜像 → adaptReversePeSystemForExpand
    └─ custom profile → renderTemplate
    ↓
resolveProvider({provider, model, system, user, maxTokens})
    ├─ API Key 解析（SQLite → env）
    └─ HTTP POST → /v1/chat/completions
    ↓
recordHistory({...})  ← 持久化
    ↓
返回结果
```

**反推管线：**
```
用户输入(image_description, profile, ...)
    ↓
findProfileById → PEProfile
    ↓
resolveReverse(profile, {caption_lang, len, media_target, ...})
    ↓
reverse/router.ts → 按 caption.type 路由
    ├─ Descriptive → reverse/descriptive.ts (五点结构)
    ├─ Stable_Diffusion_Prompt → reverse/comfyui.ts (还原检查表)
    ├─ Danbooru_tag_list → reverse/danbooru.ts
    ├─ AltProse → reverse/prose.ts
    └─ Torii 结构化 → 走反向映射 + PROMPTS_B 模板
    ↓
resolveProvider()  → History
    ↓
返回 {system, userLead, userBody, outputConstraints, userTail, captionType}
```

## 6. 配置层

四层优先级：
1. **CLI 参数**: `--provider`, `--model`, `--db-path`, `--port`, `--transport`, `--log-level`
2. **.env 文件**: `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `SILICONFLOW_API_KEY`
3. **YAML 配置文件**: `~/.prompt-master-mcp/config.yaml`
4. **代码默认值**: DeepSeek + deepseek-chat, stdio transport

## 7. 数据持久化

- **settings 表**: key-value，存 API Key
- **history 表**: 每次扩写/反推调用都记录（tool、profile、input、result、tokens、duration）
- **provider_cache 表**: 供应商列表缓存
- **custom_profiles 表** (预留): 用户自定义 Profile

## 8. 错误码

| Code | 触发 | HTTP-like |
|------|------|-----------|
| `provider_not_configured` | API Key 未配置 | 412 |
| `provider_unreachable` | 供应商 API 不可达 | 502 |
| `provider_error` | API 返回错误 | 502 |
| `profile_not_found` | Profile ID 不存在 | 404 |
| `scenario_not_found` | MiniMax 场景 ID 不存在 | 404 |
| `invalid_params` | 参数校验失败 | 400 |
| `internal_error` | 未预期异常 | 500 |

## 9. 部署与运行

```bash
# 安装依赖（用 bun 因为 npm 有 EPERM 问题）
bun install --ignore-scripts

# 编译
node node_modules/typescript/bin/tsc

# 配置 API Key
echo "DEEPSEEK_API_KEY=sk-xxx" > ~/.prompt-master-mcp/.env

# 启动（stdio 模式，默认）
node dist/src/index.js

# 启动（SSE 模式）
node dist/src/index.js --transport sse --port 3100

# 运行测试
npm test
```

## 10. 后续扩展

- `resolver/ext/`: 接入自有技能（如 anima-prompt-v1 CLI、minimax-h3 CLI）
- `custom_profiles` 表: 运行时动态注册新 Profile
- 中间件模式: 在 Resolver → Provider 之间插入自定义处理（缓存/审计）

## 11. 与原 PM 的差异

| 维度 | 原 PM | MCP Server |
|------|-------|-----------|
| 推理 | llama.cpp 本地 | 云 API（DeepSeek 等） |
| 界面 | Electron + Vue | 无（MCP Tool 接口） |
| 视频导出 | ffmpeg 子进程 | 不支持（已确认在范围外） |
| Anima 训练 | GPU + Python | 仅 PE 引擎 |
| 配置存储 | SQLite + JSON | SQLite |

**核心引擎 1:1 移植**：`promptExpandRules.js`、`captionPromptEngineering.js`（含 `sanitizeFinalCaption`）、`captionLength.js`、`tagLineSanitize.js`、`comfyuiPromptEngineering.js`、`minimaxScenarios/` 等全部按原版保留函数签名和提示词文本。

## 12. 明确范围外（Out of Scope）

以下原 PM 能力**有意不移植**，避免把 Electron 前端行为或专用本地模型逻辑带进纯 MCP Server：

| 能力 | 原 PM 模块 | MCP Server 处理 |
|------|-----------|-----------------|
| JoyCaption 额外选项（no-glasses / no-character-appearance 等） | `joyCaptionExtraOptions.js`、`joyCaptionExtraPromptEngineering.js`、`captionExtraOptionSanitize.js` | `router.ts` 保留 `applyJoyExtraOptionCaptionSanitize` / `buildJoyExtraUserEnforcementTail` 签名，但实现为 **no-op**（干净裁剪，见 `sanitizeFinalCaption` 注释） |
| 本地 llama.cpp / Ollama 推理 | `llamaRuntime.js`、`llamaContext.js`、`ggufModelManifest.js` | 全部替换为 OpenAI 兼容云 API |
| Electron 渲染进程行为（`window.electron`、`workspacePath.js` 路径对话框等） | 各 config 文件中的 `.js` Electron 引用 | 删除或改为纯字符串/纯 Node 逻辑 |
| 视频导出 / ffmpeg | 主进程子进程 | 不支持 |
| Anima 模型 GPU 训练 | Python + GPU | 仅保留 PE 引擎（反推/扩写/MiniMax） |
| Settings 服务（`ee-core/services`） | `readLocalTokenLimitsFromSettingsService` | 默认 token 上限内联（`reverseMax=1024`、`expandMax=8192`），不读取 Electron Settings |

**缺失说明**：设计文档 §4.1 中的 `captionLength.js → reverse/length.ts` 与新增的 `tagLineSanitize.js → reverse/tagLineSanitize.ts` 为纯函数移植，已补齐；`resolveExpandLengthSpec` 现返回 `custom/chars` 字段与 PM 一致。
