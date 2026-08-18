# CLI Cookbook

每个 CLI 的完整使用手册。`--list-actions` 是权威动作列表（loader 也用它发现 host tool），实际可用的 flag 在每个 action 的 `--help` 里：

```bash
<preset>\.venv\Scripts\anima-prompt-v1.exe author --help
```

**约定**：所有 CLI 都接受 `--json`（loader 自动加）；`anima-prompt-v1 author` 没 `--json` 时切换纯文本。

---

## `anima-prompt-v1` — Anima 提示词编译器

### Actions

| Action | 干什么 |
|---|---|
| `author` | brief → Anima positive/negative 单行 prompt |
| `catalog.search` | 按 query 查 tag catalog（支持 alias / fuzzy） |
| `catalog.browse` | 不带 query 浏览 catalog |
| `catalog.stats` | catalog 统计 |
| `catalog.build` | 从源码重建 SQLite catalog |
| `catalog.verify` | 校验 SQLite 与 manifest 一致 |
| `relation.submit` | 把 LLM 学到的新 relation 提交到 overlay |
| `relation.list` | 列出 overlay 里的 proposals |
| `relation.accept` | 接受 proposal（更新 base relation） |
| `relation.reject` | 拒掉 proposal |

详细 schema 看 `skills/anima-prompt-v1/SKILL.md`。

### Example 1: 写一个 solo portrait

```bash
# 写 brief.json
cat > brief.json <<'JSON'
{
  "variant": "base",
  "subject": "smiling girl portrait",
  "slots": {
    "count_gender": ["1girl", "solo"],
    "appearance":   ["long hair", "blue eyes", "smile", "blush"],
    "expression":   ["smile"],
    "camera":       ["close-up", "looking at viewer"]
  }
}
JSON

# 调 author（用 --json 拿 envelope；不带就是纯文本）
<preset>\.venv\Scripts\anima-prompt-v1.exe author --request brief.json --json
```

期望 `result.positive`：`masterpiece, best quality, score_7, safe, 1girl, solo, long hair, blue eyes, smile, blush, smile, close-up, looking at viewer`

### Example 2: 用 stdin 喂 brief

```bash
cat brief.json | <preset>\.venv\Scripts\anima-prompt-v1.exe author --stdin --json
```

`--request` 和 `--stdin` 互斥，必选其一。

### Example 3: 查 catalog

```bash
# 精确 / 别名 / 模糊 三种模式
<preset>\.venv\Scripts\anima-prompt-v1.exe catalog.search "long hair" --mode auto --limit 10 --json
<preset>\.venv\Scripts\anima-prompt-v1.exe catalog.search "lon hair" --mode fuzzy --limit 5 --json

# 按 category / source 过滤
<preset>\.venv\Scripts\anima-prompt-v1.exe catalog.browse --category appearance --source danbooru --limit 20 --json

# 统计
<preset>\.venv\Scripts\anima-prompt-v1.exe catalog.stats --json
```

### Example 4: 重建 / 校验 catalog

```bash
# 从 knowledge/source/ 重建 SQLite
<preset>\.venv\Scripts\anima-prompt-v1.exe catalog.build \
    --source <preset>/skills/anima-prompt-v1/knowledge/source \
    --output <preset>/skills/anima-prompt-v1/knowledge \
    --manifest <preset>/skills/anima-prompt-v1/knowledge/manifest.json

# 校验
<preset>\.venv\Scripts\anima-prompt-v1.exe catalog.verify \
    --database <preset>/skills/anima-prompt-v1/knowledge/tag-catalog.sqlite \
    --manifest <preset>/skills/anima-prompt-v1/knowledge/manifest.json
```

### Example 5: 提交 relation proposal

```bash
# payload.json: {record_id, surface_form, category, ...}
<preset>\.venv\Scripts\anima-prompt-v1.exe relation.submit \
    --database <preset>/skills/anima-prompt-v1/knowledge/tag-catalog.sqlite \
    --overlay <preset>/skills/anima-prompt-v1/knowledge/relation-overlay.sqlite \
    --payload payload.json \
    --model current-llm \
    --source llm \
    --json

# 列出 candidate（默认 all）
<preset>\.venv\Scripts\anima-prompt-v1.exe relation.list \
    --overlay <preset>/skills/anima-prompt-v1/knowledge/relation-overlay.sqlite \
    --status candidate --limit 50 --json

# 接受 / 拒
<preset>\.venv\Scripts\anima-prompt-v1.exe relation.accept \
    --overlay <preset>/skills/anima-prompt-v1/knowledge/relation-overlay.sqlite \
    <proposal-id> --json

<preset>\.venv\Scripts\anima-prompt-v1.exe relation.reject \
    --overlay <preset>/skills/anima-prompt-v1/knowledge/relation-overlay.sqlite \
    <proposal-id> --json
```

---

## `minimax-h3-prompt` — H3 视频提示词编译器

### Actions

| Action | 干什么 |
|---|---|
| `author` | story → 官方 H3 dialect（含 token 预算 + 审计） |

5 个 stage（`t2va` / `i2va` / `fl2va` / `l2va` / `ref2va`）由 `--stage` flag 选，不在 request JSON 里。

详细 schema + 多 shot 计划 (`--plan`) 看 `skills/minimax-h3-prompt/SKILL.md`。

### Example 1: 文生视频 (T2VA)

```bash
cat > story.json <<'JSON'
{
  "duration_seconds": 6,
  "shots": [
    {
      "what": "A woman walks through neon Tokyo at dusk.",
      "ambient": "city hum, distant traffic",
      "music": "low melancholic strings"
    }
  ]
}
JSON

<preset>\.venv\Scripts\minimax-h3-prompt.exe author \
    --stage t2va \
    --request story.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge
```

返回 `result.text`（可执行的英文 prompt）+ `result.text_zh`（结构词翻译的中文骨架，正文英文）。`result.budget` 报告 token / 字符用量。

### Example 2: 多 shot 计划 (FL2VA / Ref2VA / 多镜头推荐)

12s 视频、4 镜头（含首尾帧）：

```bash
cat > story.json <<'JSON'
{ "duration_seconds": 12, "shots": [{"what": "ignored when --plan is used"}] }
JSON

cat > plan.json <<'JSON'
{
  "total_duration": 12.0,
  "shot_count": 4,
  "edit_rhythm": "establishing to release",
  "continuity_strategy": "single subject, fixed rooftop",
  "shots": [
    {"shot": 1, "start": 0.0, "end": 3.0,
     "content": "Neko lands on the rooftop at dusk.",
     "camera": "static shot", "transition": "opening",
     "sound_focus": "city hum"},
    {"shot": 2, "start": 3.0, "end": 6.0,
     "content": "Neko walks toward the antenna.",
     "camera": "truck right with small amplitude at slow speed",
     "transition": "cut", "sound_focus": "footsteps, wind"},
    {"shot": 3, "start": 6.0, "end": 9.0,
     "content": "Neko reaches for the antenna.",
     "camera": "push in with large amplitude",
     "transition": "cut", "sound_focus": "wind"},
    {"shot": 4, "start": 9.0, "end": 12.0,
     "content": "Neko looks over the skyline.",
     "camera": "tilt up", "transition": "cut",
     "sound_focus": "city hum, distant traffic"}
  ],
  "continuity_ledger": {
    "identity": "Neko",
    "wardrobe_and_props": "black hoodie, silver antenna"
  }
}
JSON

<preset>\.venv\Scripts\minimax-h3-prompt.exe author \
    --stage fl2va \
    --request story.json \
    --plan plan.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge
```

`--plan` 给出时，`request.shots` 被忽略；`duration_seconds` / stage / references 仍从 request 拿。

### Example 3: Ref2VA with 参考图

```bash
cat > story.json <<'JSON'
{
  "duration_seconds": 8,
  "shots": [{"what": "Neko stands on the rooftop at dusk, wind in her hair.", "who": "Neko"}],
  "references": [
    {"kind": "picture", "who": "Neko", "image": "C:/refs/neko.png", "width": 1024, "height": 1024}
  ]
}
JSON

<preset>\.venv\Scripts\minimax-h3-prompt.exe author \
    --stage ref2va \
    --request story.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge
```

`who` 必须匹配 `references[].who`。

---

## `camera-image` — Anima camera workflow（t2i / i2i）

### Actions

| Action | 干什么 |
|---|---|
| `describe` | 打印请求契约 + 资产身份 |
| `run` | 验证 → patch → enqueue → wait → download |
| `assets verify` | 验证固定 workflow 资产的 sha256 + 拓扑 |

详细 schema（所有字段、camera coords、preset table、group 列表）看 `skills/camera-image/SKILL.md`。

### Example 1: 最小 t2i（用 baked preset）

```bash
cat > req.json <<'JSON'
{
  "prompt": {
    "positive": "score_9, score_8_up, 1girl, anime portrait, cinematic lighting",
    "negative": "low quality, bad anatomy"
  },
  "profile_id": "camera-anima-v1",
  "preset": "portrait_full_body",
  "seed": 42
}
JSON

# 看契约（不执行）
<preset>\.venv\Scripts\camera-image.exe describe --stage t2i --summary

# 跑（会问 y/N，加 --yes 跳过）
<preset>\.venv\Scripts\camera-image.exe run \
    --stage t2i \
    --request req.json \
    --output-dir temp/camera-image/ \
    --yes
```

输出：`temp/camera-image/<timestamp>_<filename>.png` + `temp/camera-image/summary.json`。

### Example 2: 最小 i2i（带参考图）

```bash
cat > req.json <<'JSON'
{
  "prompt": {"positive": "...", "negative": "..."},
  "profile_id": "camera-anima-v1",
  "reference_image": "C:/path/to/reference.png"
}
JSON

<preset>\.venv\Scripts\camera-image.exe run \
    --stage i2i \
    --request req.json \
    --output-dir temp/camera-image/ \
    --yes
```

i2i 自动开启 `加载图片（G1）`、强制 node 58 = 2。`denoise_first` 默认 `0.6`（可被 `sampling.denoise_first` 覆盖）。

### Example 3: 显式相机 + 镜头，DOF

```bash
cat > req.json <<'JSON'
{
  "prompt": {"positive": "...", "negative": "..."},
  "profile_id": "camera-anima-v1",
  "preset": "portrait_full_body",
  "camera": {
    "direction": "rear_45",
    "elevation": "low",
    "distance":  "medium",
    "roll":      0.05
  },
  "camera_extra": {
    "lens_enabled": true,
    "lens_value":   "50mm lens",
    "dof_enabled":  true,
    "dof_weight":   1.5,
    "dof_value":    "shallow depth of field"
  }
}
JSON

<preset>\.venv\Scripts\camera-image.exe run --stage t2i --request req.json --output-dir temp/camera-image/ --yes
```

### Example 4: 自定义采样

```bash
cat > req.json <<'JSON'
{
  "prompt": {"positive": "...", "negative": "..."},
  "profile_id": "camera-anima-v1",
  "sampling": {
    "steps_first":   28,
    "cfg":           7.5,
    "sampler":       "euler_ancestral",
    "scheduler":     "karras",
    "denoise_first": 0.92
  }
}
JSON

<preset>\.venv\Scripts\camera-image.exe run --stage t2i --request req.json --output-dir temp/camera-image/ --yes
```

### Example 5: 替换 LoRA stack

```bash
cat > req.json <<'JSON'
{
  "prompt": {"positive": "...", "negative": "..."},
  "profile_id": "camera-anima-v1",
  "lora": {
    "selections": [
      {
        "name":           "Anima风格-哥特霓虹",
        "strength_model": 1.0,
        "strength_clip":  1.0,
        "active":         true,
        "trigger_words":  []
      }
    ]
  }
}
JSON

<preset>\.venv\Scripts\camera-image.exe run --stage t2i --request req.json --output-dir temp/camera-image/ --yes
```

`name` 解析为 server 上 ComfyUI LoRA 库存里的实际文件名（Anima folder only）。找不到就 `validation_failed`，不会半跑半挂。

### Example 6: 加 G1 / G2 group

```bash
cat > req.json <<'JSON'
{
  "prompt": {"positive": "...", "negative": "..."},
  "profile_id": "camera-anima-v1",
  "groups": {
    "g1": ["高清 PreDetailer（G1）", "高清 PostDetailer（G1）"],
    "g2": []
  }
}
JSON

<preset>\.venv\Scripts\camera-image.exe run --stage t2i --request req.json --output-dir temp/camera-image/ --yes
```

title 必须精确匹配 `workflow/<stage>/groups.json` 里的标题（不能省略"（G1）"后缀）。

### Example 7: i2i 全功能（controlnet + 区域 + 签名）

```bash
cat > req.json <<'JSON'
{
  "prompt": {"positive": "...", "negative": "..."},
  "profile_id":       "camera-anima-v1",
  "reference_image":  "C:/path/ref.png",
  "controlnet_image": "C:/path/pose.png",
  "red_prompt":       "red armor with battle damage",
  "green_prompt":     "emerald energy field",
  "blue_prompt":      "arctic wind aura",
  "red_image":        "C:/path/red_ref.png",
  "green_image":      "C:/path/green_ref.png",
  "blue_image":       "C:/path/blue_ref.png",
  "signature_image":  "C:/path/signature.png"
}
JSON

<preset>\.venv\Scripts\camera-image.exe run --stage i2i --request req.json --output-dir temp/camera-image/ --yes
```

每个 `*_image` 自动打开对应的 G1 group。

### Example 8: 验证资产（不需要 ComfyUI 在跑）

```bash
<preset>\.venv\Scripts\camera-image.exe assets verify --stage t2i
<preset>\.venv\Scripts\camera-image.exe assets verify --stage i2i
```

### 远程 ComfyUI

```bash
<preset>\.venv\Scripts\camera-image.exe run \
    --stage t2i --request req.json --output-dir temp/camera-image/ \
    --comfyui-url http://192.168.1.42:8188 \
    --yes
```

---

## `camera-video` — MiniMax H3 视频（t2v / i2v / multi-i2v）

### Actions

| Action | 干什么 |
|---|---|
| `describe` | 打印请求契约 + 资产身份 |
| `run` | 验证 → enqueue → wait → download |
| `assets verify` | 校验固定 workflow |

`references[]` 长度按 stage 严格匹配：`t2v`=0 / `i2v`=1 / `multi-i2v`=3。

### Example 1: 最小 t2v

```bash
cat > req.json <<'JSON'
{
  "prompt": "A woman walks through neon Tokyo at dusk, cinematic, low angle.",
  "duration": 6.0,
  "references": []
}
JSON

<preset>\.venv\Scripts\camera-video.exe describe --stage t2v --summary

<preset>\.venv\Scripts\camera-video.exe run --stage t2v --request req.json --output-dir temp/camera-image/
```

### Example 2: i2v with 1 reference

```bash
cat > req.json <<'JSON'
{
  "prompt": "A rain-soaked cyclist opens an umbrella beside a bicycle, low light, cinematic.",
  "duration": 6.0,
  "references": ["C:/refs/cyclist.png"]
}
JSON

<preset>\.venv\Scripts\camera-video.exe run --stage i2v --request req.json --output-dir temp/camera-image/
```

### Example 3: multi-i2v with 3 references

```bash
cat > req.json <<'JSON'
{
  "prompt": "Character poses in three moods.",
  "duration": 8.0,
  "references": [
    "C:/refs/char_front.png",
    "C:/refs/char_side.png",
    "C:/refs/char_back.png"
  ]
}
JSON

<preset>\.venv\Scripts\camera-video.exe run --stage multi-i2v --request req.json --output-dir temp/camera-image/
```

### Example 4: 验证资产

```bash
<preset>\.venv\Scripts\camera-video.exe assets verify --stage t2v
<preset>\.venv\Scripts\camera-video.exe assets verify --stage i2v
<preset>\.venv\Scripts\camera-video.exe assets verify --stage multi-i2v
```

### 长任务

```bash
<preset>\.venv\Scripts\camera-video.exe run \
    --stage t2v --request req.json --output-dir temp/camera-image/ \
    --timeout 3600 --poll-interval 5
```

---

## `camera-multiview` — Flux2-Klein 多视图角色卡

### Actions

| Action | 干什么 |
|---|---|
| `describe` | 打印请求契约 + 资产身份 |
| `run` | 验证 → upload 2 用户图 + 13 pose → patch → enqueue → wait → download 12 张 |
| `assets verify` | 校验 workflow + 13 pose 资产 |

### Example 1: 跑一次（标准流程）

```bash
cat > req.json <<'JSON'
{
  "full_body_image": "C:/path/to/full-body.png",
  "face_image":      "C:/path/to/face.png"
}
JSON

<preset>\.venv\Scripts\camera-multiview.exe describe --summary
<preset>\.venv\Scripts\camera-multiview.exe run \
    --request req.json \
    --output-dir temp/camera-multiview/multiview-1/
```

约 8 分钟（5s 上传 + 470s ComfyUI 执行 + 1s 轮询）。

### Example 2: 远程 ComfyUI + 长 timeout

```bash
<preset>\.venv\Scripts\camera-multiview.exe run \
    --request req.json \
    --output-dir temp/camera-multiview/multiview-1/ \
    --comfyui-url http://192.168.1.42:8188 \
    --timeout 3600 --poll-interval 3
```

### Example 3: 验证资产（不需要 ComfyUI）

```bash
<preset>\.venv\Scripts\camera-multiview.exe assets verify
```

输出 `verified: true` + 13 个 pose 的 sha256。

### 输出

```
temp/camera-multiview/multiview-1/
├── zove_00020_.png        ← 12 张产物
├── face_00005_.png
├── z_00005_.png
├── ...
└── summary.json           ← prompt_id + graph sha256 + uploads + artifacts + elapsed_seconds
```

---

## 通用：跑 stdin / dry-run / 自检

### 直接通过 venv python 调（不进 venv 也行）

```bash
<preset>\.venv\Scripts\python.exe -m anima_prompt_v1.cli author --request brief.json --json
<preset>\.venv\Scripts\python.exe -m h3_prompt.cli author --stage t2va --request story.json --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge
<preset>\.venv\Scripts\python.exe -m camera_image.cli run --stage t2i --request req.json --output-dir temp/camera-image/ --yes
<preset>\.venv\Scripts\python.exe -m camera_video.cli run --stage t2v --request req.json --output-dir temp/camera-image/
<preset>\.venv\Scripts\python.exe -m camera_multiview.cli run --request req.json --output-dir temp/camera-image/
```

### `--list-actions`（loader 也用这个）

```bash
<preset>\.venv\Scripts\anima-prompt-v1.exe --list-actions
<preset>\.venv\Scripts\minimax-h3-prompt.exe --list-actions
<preset>\.venv\Scripts\camera-image.exe --list-actions
<preset>\.venv\Scripts\camera-video.exe --list-actions
<preset>\.venv\Scripts\camera-multiview.exe --list-actions
```

### `--help`

```bash
<preset>\.venv\Scripts\anima-prompt-v1.exe author --help
<preset>\.venv\Scripts\camera-image.exe run --help
```

### 退出码

| Category | Exit | 例 |
|---|---|---|
| success | 0 | `ok=true` |
| `request` | 2 | `invalid_request`, `input_file_missing`, `group_confirmation_aborted` |
| `validation` | 3 | `validation_failed`, `brief_validation_failed`, `h3_audit_failed` |
| `integrity` | 4 | `fixed_workflow_invalid`, `AssetError`, `catalog_read_failed`, `tokenizer_integrity_failed` |
| `runtime` | 5 | `comfyui_runtime_error`, `comfyui_mcp_error` |
| `unexpected` | 70 | `unexpected_error` |

`h3` 例外：`budget_exceeded` 走 exit 3，`official_envelope_violated` 也走 exit 3（但 code 是 `validation` 类）。
