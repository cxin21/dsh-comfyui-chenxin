---
name: camera-video
description: "Execute MiniMax-H3 video generation on ComfyUI and save one video per run. Three stages — text-to-video (`t2v`), single-reference (`i2v`), and multi-reference (`multi-i2v`). The prompt comes from `minimax-h3-prompt`; this skill just runs the fixed MiniMax H3 workflow on your ComfyUI server. Do NOT use for prompt authoring — call `minimax-h3-prompt` first."
whenToUse: "User wants one MiniMax H3 video rendered. Use after the prompt is authored by `minimax-h3-prompt` and before any post-processing."
---

# Camera Video

Three stages over fixed MiniMax-H3 workflows. Execution runs through comfyui-mcp on your ComfyUI server.

| Stage | `references[]` length |
|---|---|
| `t2v` | 0 |
| `i2v` | 1 |
| `multi-i2v` | 3 |

`references` must have exactly the stage's count; `t2v` rejects the field when non-empty.

## When to call

Call this skill when:

1. The user has an H3 prompt (typically from `minimax-h3-prompt author`).
2. The user wants the prompt rendered through MiniMax H3 on their ComfyUI server.
3. The fixed MiniMax H3 workflow asset ships with this skill (no creative direction needed).

Do not call this skill when:

- The user wants a still image → `camera-image` (Anima) or `camera-multiview` (Flux2-Klein).
- The user wants an H3 prompt authored or validated → `minimax-h3-prompt`.
- The user wants to switch models or change the workflow structure → out of scope.

## First principle

**The workflow asset is invariant.** The fixed MiniMax H3 API graph is the only execution source; the skill verifies its identity on every run and rejects drift. To change the contract, republish the asset, manifest, and SKILL.md together. The user supplies a single-string H3 prompt + an ordered list of local image paths; the skill builds and enqueues the API graph.

## Quick start

```jsonc
// contract-stage: t2v
{
  "prompt": "A woman walks through neon Tokyo at dusk, cinematic, low angle.",
  "duration": 6.0,
  "references": []
}
```

```bash
# Save the JSON above into req.json, then run:
<preset>\.venv\Scripts\camera-video.exe describe --stage t2v --summary

<preset>\.venv\Scripts\camera-video.exe run \
    --stage t2v --request req.json --output-dir temp/camera-video/
```

Output: one video file in `temp/camera-video/` + `temp/camera-video/summary.json`.

## Request schema

The block below documents every field the parser accepts; it is not a
runnable example (`scripts/check_contracts.py` does not parse this block).
For runnable examples see [Examples](#examples).

```text
{
  "prompt": "<H3 native prompt, single string>",   // required
  "duration": 6.0,                                // optional, default 4.0; range [2, 15]
  "references": ["C:/path/ref-1.png"]              // ordered local image paths
}
```

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `prompt` | string | **yes** | — | H3 native prompt (typically `result.text` from `minimax-h3-prompt author`) |
| `duration` | float | no | `4.0` | Length in seconds; range `[2, 15]` |
| `references` | list[string] | conditional | `[]` | Ordered local image paths; `t2v` rejects non-empty, `i2v` requires exactly 1, `multi-i2v` requires exactly 3 |

`describe --stage <s> --summary` returns the live contract (including the exact reference count) — prefer it over memorizing stage rules.

## Commands

| Action | Purpose |
|---|---|
| `describe` | Print the request contract + asset identity |
| `run` | Validate → build graph → enqueue → wait → download |
| `assets verify` | Verify the bundled workflow asset against the manifest |

`--list-actions` returns this list verbatim.

### `describe`

```bash
camera-video describe --stage t2v --summary
camera-video describe --stage i2v --summary
camera-video describe --stage multi-i2v --summary

# Minimal: identifiers only
camera-video describe --stage t2v
```

| Flag | Required | Choices | Effect |
|---|---|---|---|
| `--stage` | yes | `t2v`, `i2v`, `multi-i2v` | Which stage's contract to describe |
| `--summary` | no | — | Add the full `request` block + `example` |

### `run`

```bash
# Standard run (no --yes needed; camera-video doesn't prompt)
camera-video run --stage t2v --request req.json --output-dir temp/camera-video/

# i2v with a single reference image
camera-video run --stage i2v --request req.json --output-dir temp/camera-video/

# multi-i2v with three references
camera-video run --stage multi-i2v --request req.json --output-dir temp/camera-video/

# Non-default ComfyUI server
camera-video run --stage t2v --request req.json --output-dir temp/camera-video/ \
    --comfyui-url http://192.168.1.42:8188

# Long-running session with custom timeout
camera-video run --stage t2v --request req.json --output-dir temp/camera-video/ \
    --timeout 3600 --poll-interval 5
```

| Flag | Required | Type | Default | Effect |
|---|---|---|---|---|
| `--stage` | yes | enum | — | `t2v` / `i2v` / `multi-i2v` |
| `--request` | yes | path | — | Path to the request JSON file |
| `--output-dir` | no | path | `temp/camera-video/` | Where `summary.json` and the produced video land. Created if missing. |
| `--comfyui-url` | no | URL | `http://127.0.0.1:8188` | ComfyUI server base URL |
| `--timeout` | no | float (sec) | `1800` | Total wait-for-completion timeout |
| `--poll-interval` | no | float (sec) | `2.0` | History poll interval |
| `--json` | no | flag | `false` | Universal flag; wire format is always P1 |

`run` validates the request locally before it touches the network.

### `assets verify`

```bash
camera-video assets verify --stage t2v
camera-video assets verify --stage i2v
camera-video assets verify --stage multi-i2v
```

Hashes the bundled workflow and re-runs the structural fingerprint against the manifest.

## Failure modes

| Envelope `code` | Exit | Cause | Recovery |
|---|---|---|---|
| `invalid_request` | 2 | `--request` path missing, JSON malformed, not UTF-8, unknown field, wrong reference count for stage | Fix the JSON; `describe --summary` shows the expected shape |
| `input_file_missing` | 2 | A `references[i]` path does not exist on disk | Verify the path, then rerun |
| `validation_failed` | 3 | Stage-specific semantic check failed (e.g. `t2v` with non-empty `references`) | Adjust stage or request |
| `fixed_workflow_invalid` | 4 | Workflow JSON sha256 mismatch or structural drift | Revert the asset, or republish with a new manifest deliberately |
| `comfyui_mcp_error` | 4 | npx / comfyui-mcp install path broken, MCP subprocess failed | Check `npx` + `comfyui-mcp` |
| `comfyui_runtime_error` | 5 | ComfyUI rejected enqueue, HTTP error during polling, artifact download failed | Surface verbatim |
| `unexpected_error` | 70 | Anything else | Surface the traceback |

Failures are fail-closed: no automatic retry, no fallback to an older asset.

## Examples

### Example 1 — `t2v` (text-to-video)

```bash
cat > req.json <<'JSON'
{
  "prompt": "A woman walks through neon Tokyo at dusk, cinematic, low angle.",
  "duration": 6.0,
  "references": []
}
JSON

<preset>\.venv\Scripts\camera-video.exe run \
    --stage t2v --request req.json --output-dir temp/camera-video/
```

### Example 2 — `i2v` (single reference)

```bash
cat > req.json <<'JSON'
{
  "prompt": "A rain-soaked cyclist opens an umbrella beside a bicycle, low light, cinematic.",
  "duration": 6.0,
  "references": ["C:/refs/cyclist.png"]
}
JSON

<preset>\.venv\Scripts\camera-video.exe run \
    --stage i2v --request req.json --output-dir temp/camera-video/
```

### Example 3 — `multi-i2v` (three references)

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

<preset>\.venv\Scripts\camera-video.exe run \
    --stage multi-i2v --request req.json --output-dir temp/camera-video/
```

### Example 4 — From an `minimax-h3-prompt` output

```bash
# 1. Author the H3 prompt
<preset>\.venv\Scripts\minimax-h3-prompt.exe author \
    --stage t2va \
    --request story.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge \
    > h3-out.json

# 2. Extract `result.text` from the envelope (jq)
PROMPT=$(jq -r '.result.text' h3-out.json)

# 3. Wrap it for camera-video
jq -n --arg p "$PROMPT" '{
  "prompt":   $p,
  "duration": 6.0,
  "references": []
}' > req.json

# 4. Run
<preset>\.venv\Scripts\camera-video.exe run \
    --stage t2v --request req.json --output-dir temp/camera-video/
```

## Output

`run` writes:

- One video in `<output-dir>` (ComfyUI picks the filename)
- `summary.json` in `<output-dir>` with `prompt_id`, `api_graph_sha256`, `uploads`, per-artifact `filename` + `sha256`

```json
{
  "prompt_id":        "7561b961-c49a-42f4-aefe-1ab13e5c5c3d",
  "api_graph_sha256": "af9abb86...",
  "uploads":          [],
  "artifacts": [
    {"filename": "neon-tokyo-walk_00001_.mp4", "sha256": "28af3021..."}
  ],
  "stage": "t2v"
}
```

If the wait times out but the prompt is still queued/running, the run returns a non-error envelope with `queue_status` set and `artifacts: []` — retry later.

## See also

- [`camera_video/runtime/`](camera_video/runtime/) — request schema validation, graph build, asset loading
- [`../../docs/cli-cookbook.md`](../../docs/cli-cookbook.md) — every CLI invocation form
- [`../../docs/troubleshooting.md`](../../docs/troubleshooting.md) — error recovery
- [`../minimax-h3-prompt/SKILL.md`](../minimax-h3-prompt/SKILL.md) — author the prompt first
