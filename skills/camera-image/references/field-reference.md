# Camera Image — Field Reference

Deep per-field rules for `camera-image run`. Source of truth is the code in
`camera_image/runtime/` (this document mirrors `config.py`, `request.py`,
`presets.py`, `lora.py`, `camera_map.py`, `graph.py`, `contracts.py`).
If this document and the code disagree, **the code is right** — update this
document, never the other way around.

## `prompt`

| Key | Type | Required | Maps to | Notes |
|---|---|---|---|---|
| `prompt.positive` | string | yes | node 24 `wildcard_text` + `populated_text` | Comma-separated Anima positive. Emitted by `prompt_author (target=anima)` (prompt-master plugin). |
| `prompt.negative` | string | no | node 25 same pair | Defaults to `""`. Single string, no list. |

Non-string or empty `prompt.positive` is rejected with `validation_failed`.
Unknown keys inside `prompt` raise `prompt has unsupported field(s)` before any graph work.

## `camera` (node 583 CameraAngleNode)

When this field is present, `direction`, `elevation`, and `distance` are all required.

| Key | Type | Allowed values | Maps to widget |
|---|---|---|---|
| `direction` | string | see Coords table | node 583 `pos_x` |
| `elevation` | string | see Coords table | node 583 `pos_y` |
| `distance` | string | see Coords table | node 583 `pos_z` |
| `roll` | float `[0.0, 1.0]` | optional | node 583 `roll` |

### Camera coords (verbatim from `camera_image/runtime/camera_map.py`)

| Semantic | Float | Notes |
|---|---|---|
| `direction: front` | `pos_x = 0.0` | facing viewer |
| `direction: right_45` | `pos_x = 0.25` | 45° to camera-right |
| `direction: right` | `pos_x = 0.5` | profile, camera-right |
| `direction: right_135` | `pos_x = 0.75` | alias for `rear_45` |
| `direction: rear_45` | `pos_x = 0.75` | 45° behind subject |
| `direction: rear` | `pos_x = 1.0` | directly behind |
| `direction: left_45` | `pos_x = -0.25` | 45° to camera-left |
| `direction: left` | `pos_x = -0.5` | profile, camera-left |
| `direction: left_135` | `pos_x = -0.75` | mirror of `rear_45` |
| `elevation: high` | `pos_y = 0.5` | looking down |
| `elevation: eye-level` | `pos_y = 0.0` | horizon |
| `elevation: low` | `pos_y = -0.5` | looking up |
| `distance: extreme_close_up` | `pos_z = 0.9` | face fills frame |
| `distance: close_up` | `pos_z = 0.5` | head-and-shoulders |
| `distance: medium` | `pos_z = 0.1` | 3/4 body |
| `distance: cowboy_shot` | `pos_z = -0.2` | mid-thigh up |
| `distance: full_body` | `pos_z = -0.5` | head-to-toes |
| `distance: wide` | `pos_z = -0.9` | environmental |
| `roll: 0.0 .. 1.0` | `roll` | 0 = no tilt, 1 = full tilt |

Two semantic names share one float value (`right_135` ≡ `rear_45`); the mapping accepts both.

## `camera_extra` (node 585 CameraExtraConfigNode)

13 widgets, 1:1 with inputs. Pass only the slots you want to change; every field has a default.

| Field | Type | Default | Effect |
|---|---|---|---|
| `extreme_type` | string | `"无"` | Toggles extreme-camera modes |
| `extreme_weight` | float | `10.0` | Weight on extreme-camera bias |
| `lens_enabled` | bool | `true` | Inject lens-length prompt phrase |
| `lens_value` | string | `"85mm lens"` | Lens descriptor (e.g. `"50mm lens"`, `"135mm portrait"`) |
| `dof_enabled` | bool | `false` | Inject depth-of-field phrasing |
| `dof_value` | string | `"shallow depth of field"` | DOF descriptor |
| `dof_weight` | float | `1.3` | Weight on DOF |
| `movement_enabled` | bool | `false` | Inject camera-movement phrasing |
| `movement_value` | string | `"handheld camera"` | Movement descriptor |
| `composition_enabled` | bool | `true` | Inject composition-rule phrasing |
| `composition_value` | string | `"rule of thirds"` | Composition descriptor |
| `style_enabled` | bool | `false` | Inject style descriptor |
| `style_value` | string | `"cinematic"` | Style descriptor |

Validation (from `config.py`): `extreme_weight` must be `[0.0, 10.0]`,
`dof_weight` must be `[0.0, 5.0]`. Both are enforced in `parse_request`
via `_number` + range checks.

## `sampling` (node 50 first-pass / node 51 refine)

| Key | Type | Default | Maps to widget | Notes |
|---|---|---|---|---|
| `steps_first` | int | asset-baked | node 50 `steps` | First-pass KSampler step count |
| `cfg` | float | asset-baked | node 50 `cfg` | Classifier-free guidance, first pass only |
| `sampler` | enum | asset-baked | node 50 `sampler` | See sampler list |
| `scheduler` | enum | asset-baked | node 50 `scheduler` | See scheduler list |
| `denoise_first` | float | asset-baked / `0.6` for i2i | node 50 `denoise` | First-pass denoise; `i2i` overrides baked value with `0.6` unless you set your own |
| `steps_refine` | int | asset-baked | node 51 `steps` | Second-pass KSampler step count |
| `denoise_refine` | float | asset-baked | node 51 `denoise` | Second-pass denoise |

`cfg`, `sampler`, `scheduler` apply **only** to the first pass; refine-pass values are baked into the asset.

### Allowed `sampler` values (verbatim from `config.py`)

```
euler, euler_ancestral, heun, heunpp2,
dpmpp_2m, dpmpp_2m_sde, dpmpp_2m_sde_heun, dpmpp_2m_sde_heun_pp,
dpmpp_3m_sde, dpmpp_3m_sde_heun, dpmpp_3m_sde_heun_pp,
er_sde, er_sde_heun, er_sde_heun_pp,
ddim, ddim_uniform, uni_pc, uni_pc_bh2, lms,
euler_cfg_pp, euler_dynamic, heunpp2_dynamic
```

### Allowed `scheduler` values

```
normal, karras, exponential, sgm_uniform, simple, ddim_uniform, beta
```

## `lora` (node 26 LoraManager + node 66 TriggerWord Toggle)

`selections[]` schema:

| Key | Type | Required | Default | Notes |
|---|---|---|---|---|
| `name` | string | yes | — | Short filename stem or full path. Resolved against the live Anima-folder LoRA inventory via `comfyui-mcp list_local_models`. |
| `strength_model` | float | no | `1.0` | Model-side weight |
| `strength_clip` | float | no | `= strength_model` | CLIP-side weight |
| `active` | bool | no | `true` | `false` → emitted with strength 0 (still rendered but inert) |
| `trigger_words` | list[string] | no | `[]` | Words appended to node 66's `orinalMessage` (rendered as `"word,"`) |

### Resolution rules (from `lora.py`)

1. `mcp.list_local_models` is called once at the top of the run.
2. The response is decoded from JSON, list, or ComfyUI `- ` markdown (`parse_lora_inventory`).
3. Only LoRAs whose full path contains `anima` are considered (`filter_anima_loras`).
4. The short name (filename stem, `.safetensors` stripped) is matched case-insensitively against the inventory.
5. If the exact stem is absent, full-path exact and case-folded matches are tried. If still missing and there is exactly one substring hit, that match is selected. Otherwise ambiguity → fail closed; no match → fail closed.
6. The resolved full name is normalized (path stripped, `.safetensors` stripped) before being rendered into the LoraManager text widget.
7. If `selections` is empty/absent, the default 3-LoRA plan (`DEFAULT_LORA_PLAN` in `lora.py`) is used — and **every entry must be present in the inventory** (fail-closed if any is missing). This prevents stale-baked LoRA references from silently producing "LoRA failed to load" mid-run.

### Default LoRA plan (from `lora.py`)

```
anima-base-1-masterpiece-v51   (trigger words: masterpiece, very aesthetic)
add_detail
gpt-image-2_anima-base1_v1-1   (trigger words: @gpt-image-2)
```

## `groups` (G1 / G2)

| Key | Type | Default | Notes |
|---|---|---|---|
| `groups.g1` | list[string] | empty | Group titles to enable in addition to the default G1 set and stage-mandatory groups. |
| `groups.g2` | list[string] | empty | Same for G2. |

Every title must match **exactly** the title listed in `workflow/<stage>/groups.json`. The skill does not expand Chinese shorthand (`二次采样`, `高清修复`, etc.); use the full sub-title from `groups.json`. Group membership lives outside the UI JSON, so any change to a group's node composition requires an asset update + a manifest update + a SKILL.md update.

### Default enabled groups (from `graph.py`)

```
G1: 保存图片, 第二轮采样器（G1）, 相机视角生图（G1）
    + i2i-mandatory 加载图片（G1）
G2: 图像锐化（G2）, 对比度（G2）
```

i2i additionally enables `加载图片（G1）` (node IDs `[21, 57, 58, 59]`).
The t2i asset defaults node 58 to value `2` (i2i branch); the skill always overwrites node 58 to `1` for `t2i` and `2` for `i2i` so the branch and the assets stay aligned.

### G1 titles (`t2i` and `i2i` — same list)

| Title | Node IDs |
|---|---|
| 加载图片（G1） | 21, 57, 58, 59 |
| 保存图片 | 35 |
| 手部 ADetailer（G1） | 31, 36, 53, 106 |
| 敏感内容 ADetailer（G1） | 32, 37, 54, 107 |
| 面部 ADetailer（G1） | 33, 38, 55, 108 |
| 眼部 ADetailer（G1） | 34, 39, 56, 109 |
| 启用 SAM 加载器（G1） | 29 |
| Detailer（瑕疵修复）（G1） | 44, 45, 47, 82 |
| 高清 PreDetailer（G1） | 94 |
| 高清 PostDetailer（G1） | 95 |
| 第二轮采样器（G1） | 51 |
| 添加签名（G1） | 116, 117, 118, 122, 125, 126, 127, 128, 132, 133, 135, 491 |
| 移除背景（G1） | 124 |
| Ultimate SD 放大器（G1） | 91, 92, 93, 101, 119, 134 |
| 色彩匹配（G1） | 123 |
| CFGZeroStar（零 CFG）（G1） | 74 |
| 蒙版 Detailer（G1） | 43, 46, 81 |
| Any Detailer（SAM 3.1）（G1） | 30, 42, 49, 60, 61, 63, 105 |
| 区域提示词（G1） | 0–20 |
| ControlNet LLLite（G1） | 129, 130, 131, 137 |
| CLIP NegPip（多层负向）（G1） | 85 |
| 相机视角生图（G1） | 583, 585 |

### G2 titles (`t2i` and `i2i` — same list)

| Title | Node IDs |
|---|---|
| 图像色阶（G2） | 97 |
| 图像形态学（G2） | 100 |
| 边缘保留模糊（G2） | 98 |
| 图像量化（G2） | 110 |
| 色差（G2） | 102 |
| 图像锐化（G2） | 111 |
| 胶片颗粒（G2） | 99 |
| VHS 电视效果（G2） | 103 |
| 像素化（G2） | 104 |
| 数字故障（G2） | 113 |
| 夜视（G2） | 114 |
| 蓝图（G2） | 115 |
| 磨砂玻璃（G2） | 120 |
| Gameboy（游戏机风）（G2） | 121 |
| 对比度（G2） | 96 |

`Ultimate SD 放大器（G1）` triggers an expensive upscaler pass — enable only when the source resolution makes the upscale worth its cost. `高清 PreDetailer（G1）` + `高清 PostDetailer（G1）` together roughly double the step count; enable both only when the request really needs the high-definition detailer chain.

## Image / text field mapping

| Field | Type | Stage | Maps to |
|---|---|---|---|
| `reference_image` | local path | i2i only, required | node 21 `image` (LoadImage) |
| `controlnet_image` | local path | all | node 129 `image` (LoadImage); `ControlNet LLLite（G1）` is the matching group |
| `red_prompt` / `green_prompt` / `blue_prompt` | string | all | node 3/4/5 wildcard + populated, and node 17/18/19 CLIPTextEncode |
| `red_image` / `green_image` / `blue_image` | local path | all | node 0/1/2 LoadImage |
| `signature_image` | local path | all | node 116 LoadImage (signature source); auto-enables `添加签名（G1）` |

Setting any region prompt/image auto-enables `区域提示词（G1）`.

`reference_image` is rejected with `'reference_image' is only supported in stage i2i` if the stage is `t2i`; missing for `i2i` → `i2i requires 'reference_image'`.

## Stage rules

### `t2i` (text → image)

- `reference_image` is rejected; the request must omit it.
- Node 58 (branch selector) is forced to `1` so node 75 (ImpactSwitch) routes through the t2i branch.
- Default LoRA plan runs unless `lora.selections` is set.
- Default group set only: G1 `保存图片`, `第二轮采样器（G1）`, `相机视角生图（G1）`; G2 `图像锐化（G2）`, `对比度（G2）`.

### `i2i` (image → image)

- `reference_image` is **required**. Paths are validated against the file system at parse time.
- Node 58 is forced to `2`.
- `加载图片（G1）` is **always** enabled (mandatory, added before confirmation).
- `denoise_first` defaults to `0.6` if the request does not set `sampling.denoise_first`.
