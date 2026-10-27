# ADR-0001: `comfyui_mcp_error` 归类为 `runtime`（exit 5）

- 状态：Accepted
- 日期：2026-10-24
- 关联：#30（arch-deepening ① 统一 Console Runner seam）

## 背景

三个 camera skill 的 CLI 通过 `chenxin_runtime` 的统一 runner 输出 P1 envelope：error category 映射固定退出码
（request→2 / validation→3 / integrity→4 / runtime→5 / unexpected→70，见
`runtime/chenxin_runtime/chenxin_runtime/protocol.py` 的 `EXIT_CODES`）。

历史实现与文档对 `comfyui_mcp_error`（comfyui-mcp 子进程故障 / 握手失败 / 拒收）的归属不一致：

- 代码现状：`skills/camera-image/camera_image/cli.py` 与 `skills/camera-video/camera_video/cli.py` 的
  `extra_error_handlers` 把 `McpClientError` 映射到 `comfyui_mcp_error` → `integrity` → **exit 4**。
- 文档现状：`docs/cli-cookbook.md`（错误恢复表）写 `comfyui_mcp_error` 应为 **exit 5**（runtime）。

## 决策

**`comfyui_mcp_error` → category `runtime` → exit 5。**

理由：comfyui-mcp 子进程故障属于执行环境问题（npx 拉包失败、子进程崩溃、ComfyUI 拒收），
不是资产完整性问题。`integrity`（exit 4）保留给固定资产哈希校验失败、asset 被
篡改这类「数据不可信」情形。二者混用会让上游（agent 与宿主）无法据退出码区分
「该重试/重装环境」还是「该停下修资产」。

原则：**以代码为准修正文档**——cli-cookbook 的错误表改为与 `EXIT_CODES` 一致，
而不是反向。

## 影响

- `skills/camera-image/camera_image/cli.py`、`skills/camera-video/camera_video/cli.py`、
  以及 #30 迁移后的 `skills/camera-multiview` 的 `extra_error_handlers` 统一改为
  `McpClientError → (comfyui_mcp_error, "runtime")`。
- `docs/cli-cookbook.md`、`docs/architecture.md` 的错误分类表同步修正。
- 未来执行层收深（#31）时，错误分类逻辑上收到执行 module 内部，本决策的映射关系不变。
