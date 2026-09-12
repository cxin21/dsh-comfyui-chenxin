# H3 多段工程设计稿（h3-director-depth Phase 8b）

日期：2026-09-12
状态：设计稿（未实现；实现前需单独排期，依赖 Phase 1-7 已落地的导演深度基建）
参照：`ailaimi/minimax-h3-director-suite` 的剧本→Beat→分段流水线与 hybrid-example 的 2×10s 拆段实践。

## 0. 问题

单段 H3 契约是 4–15s / max_shots=1+floor((d-1)/3)。短剧、PV、长镜头叙事天然超出，当前 prompt_author/compile 只能一次一段，段间衔接（锚点、声音延续、世界观一致性）全靠用户手写。

## 1. 目标形状

新工具 `prompt_segments(target=h3)`（或 prompt_author 的 `multi_segment` 模式），输入一段剧本/分场大纲，输出：

```jsonc
{
  "segments": [
    {
      "index": 1,
      "duration_seconds": 10,
      "stage": "t2va",              // 段级路由：refs→ref2va，首尾帧→i2va，否则 t2va
      "text": "…官方六段式或三字段正文…",
      "entry_anchor": "white chip falls onto black felt",
      "exit_anchor": "card flips to face camera",
      "shots": 3
    }
  ],
  "meta": {
    "world_anchors": { "palette": "red/white/black high-contrast", "medium": "pure 2D cel" },
    "audiovisual_signature": { "music": "132BPM electro rock", "transition_library": ["flat mask", "card flip"] },
    "sound_events": { "1": "chip clacks + low pulse", "2": "drums enter at 8s" }
  }
}
```

## 2. 拆段规则（确定性，LLM 只产 Beat）

1. LLM（intent persona 扩展）只产出 **Beat 列表**：每 Beat = {duration ∈ [4,15], action_summary, entry/exit anchor, sound_design}；
2. 编码器校验：Beat 时长总和 ≈ 目标总时长（±1s）；单 Beat 落在 [4,15]；max_shots 公式逐 Beat 适用；
3. 超 15s 的连续动作 → 硬切拆段，**文字锚点交接**（上一段 exit_anchor 与下一段入口呼应），**禁止引用上一段尾帧**（H3 无跨段帧传递）；
4. 每段独立走现有 `compileH3` + `auditH3Full`（段内审计零新增）；`depth`/`constraints` 沿用 Phase 4/7。

## 3. 跨段审计（新增 gate family：segment_continuity，important）

- `segment_anchor_handoff`：seg[N].entry_anchor 与 seg[N-1].exit_anchor 共享至少一个名词/动作元素（编辑距离/词面匹配）；
- `segment_tailframe_ban`：段文本不得出现 "the last frame / previous shot / continue from" 类跨段帧引用；
- `segment_meta_completeness`：world_anchors 与 audiovisual_signature 非空（director 档）。

## 4. 落点与复用

- 新模块 `pe-framework/segments/`（schema + encoder + audit），独立于 dialect 层；`prompt_segments` 工具薄封装；
- 产物可直接喂 `camera-video` 的 multi-i2v 分段渲染流水线（AGENTS.md §6 的长跑监控模式），段 MP4 → 剪映/ffmpeg 拼接；
- judge：逐段评审（rubric 复用 Phase 6 九维），跨段维度由 segment_continuity 闸门承担，不进 LLM rubric。

## 5. 非目标

- 不做自动 BGM/字幕生成（对齐 suite 的无字幕无 BGM 缺省）；
- 不做 UI 工作流转换（suite 的 convert_ui_workflow 属 ComfyUI 执行层，与本插件无关）；
- 不改现有单段 API（prompt_compile/audit 向后兼容）。

## 6. 实现切片（预估 3 提交）

1. `segments/schema.ts` + encoder（Beat 校验、锚点交接投影）+ 单测；
2. `segments/audit.ts`（segment_continuity gates）+ prompt_segments 工具 + e2e；
3. persona 扩展（Beat 拆分指导）+ docs。
