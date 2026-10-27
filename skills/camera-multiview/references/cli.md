# CLI Subcommands

Three top-level actions: `describe`, `run`, `assets verify`. All
output is the shared P1 JSON envelope on stdout (`{"ok", "command",
"stage", "result", "errors", "advisories"}`); the human-readable run
report lives in `result.summary`. `--json` is accepted on every
subcommand (the host tool appends it; the wire format is always the
envelope).

```bash
python -m camera_multiview.cli <subcommand> [args]
```

The script lives in `camera_multiview/cli.py` and is registered as
the `camera-multiview` console script in `pyproject.toml`.

## `describe` — request contract

```bash
python -m camera_multiview.cli describe [--summary]
```

| Flag | Effect |
|---|---|
| (no flags) | Minimal payload: stage + asset identity |
| `--summary` | Adds `request`, `example`, `output` fields for LLM consumption |

### Examples

```bash
$ python -m camera_multiview.cli describe
```

```jsonc
{
  "stage": "multiview",
  "asset_workflow_name": "Flux2-Klein人物一键多视图工作流.json",
  "asset_sha256": "33584a54b6587914fce078cdcddbab7915e7d834ca741ded06a44a3ba484252e",
  "workflow_node_count": 261,
  "pose_count": 13
}
```

```bash
$ python -m camera_multiview.cli describe --summary
```

```jsonc
{
  "stage": "multiview",
  "request": {
    "full_body_image": "string, required (local image path)",
    "face_image":      "string, required (local image path)"
  },
  "example": {
    "full_body_image": "C:/path/to/full-body.png",
    "face_image":      "C:/path/to/face.png"
  },
  "output": "one multi-view image per pose slot of the bundled asset (13 total)",
  "asset_workflow_name": "Flux2-Klein人物一键多视图工作流.json",
  "asset_sha256": "33584a54b6587914fce078cdcddbab7915e7d834ca741ded06a44a3ba484252e",
  "workflow_node_count": 261,
  "pose_count": 13
}
```

Exit code: `0` always (verification isn't part of `describe`).

## `assets verify` — bundled asset integrity

```bash
python -m camera_multiview.cli assets verify
```

Hashes the workflow JSON + all 13 pose PNGs + the manifest.
Re-prints every pose's hash. Aborts with exit code 4 if any drift is
detected. This is the same check `prepare_graph` runs at the start
of every run; calling it standalone lets you verify without paying
for an 8-minute workflow execution.

### Example

```bash
$ python -m camera_multiview.cli assets verify
```

```jsonc
{
  "verified": true,
  "stage": "multiview",
  "asset_workflow_name": "Flux2-Klein人物一键多视图工作流.json",
  "asset_sha256": "33584a54b6587914fce078cdcddbab7915e7d834ca741ded06a44a3ba484252e",
  "workflow_node_count": 261,
  "pose_count": 13,
  "poses": [
    {"filename": "姿势骨架1.png",  "sha256": "a6e988caa54806beee608fb63350ff64039e7f12b37488323fcdc1a68d29b8ed"},
    {"filename": "姿势骨架2.png",  "sha256": "9729498dfd83319303a42b0781027ad5c75995e421d1e856cc8a7d3153bd1d28"},
    ...   // 11 more
  ]
}
```

Drift:

```bash
$ python -m camera_multiview.cli assets verify
# (after editing the workflow JSON)
{"ok":false,"command":"assets verify","stage":"multiview","result":null,
 "errors":[{"code":"asset_integrity_error","message":"ValueError: fixed workflow SHA-256 changed: expected 33584a..., got <new hash>","details":{}}],"advisories":[]}
# exit code: 4
```

See [assets.md](assets.md) for the manifest schema and the asset
replacement protocol.

## `run` — end-to-end execution

```bash
python -m camera_multiview.cli run \
    --request  <path/to/request.json> \
    --output-dir  <path/to/output/dir> \
    [--comfyui-url  http://127.0.0.1:8188] \
    [--timeout  1800] \
    [--poll-interval  2.0] \
    [--mcp-timeout  60.0]
```

| Flag | Required | Type | Default | Effect |
|---|---|---|---|---|
| `--request` | yes | path | — | JSON file with `full_body_image` + `face_image` |
| `--output-dir` | yes | path | — | Where the 12 character sheets + `summary.json` land |
| `--comfyui-url` | no | URL | `http://127.0.0.1:8188` | ComfyUI server base URL |
| `--timeout` | no | float (sec) | `1800` | Wall-clock budget for `wait_for_outputs` |
| `--poll-interval` | no | float (sec) | `2.0` | `/history/<id>` poll interval |
| `--mcp-timeout` | no | float (sec) | `60` | Per-MCP-call timeout |

### Example request file

```json
{
  "full_body_image": "C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/temp/camera-multiview/full_body_input.png",
  "face_image":      "C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/temp/camera-multiview/face_input.png"
}
```

Only the two fields above are accepted. Any other key raises
`unsupported request field(s)`.

### Example successful run

```bash
$ python -m camera_multiview.cli run \
    --request  temp/camera-multiview/request.json \
    --output-dir  temp/camera-multiview/run1 \
    --timeout  1200 \
    --poll-interval  3
```

```jsonc
{
  "ok": true,
  "command": "run",
  "stage": "multiview",
  "result": {
    "summary": "[camera-multiview] stage: multiview\n... (human-readable report)",
    "prompt_id": "82527df3-28f1-4783-820e-e9f494465e76",
    "graph_sha256": "33584a54b6587914...",
    "status": "success",
    "elapsed_seconds": 473.9,
    "uploads": ["...15 uploaded names..."],
    "artifacts": [
      {"filename": "zove_00020_.png", "bytes": 4965064, "node_id": 201},
      "... (12 artifacts) ..."
    ],
    "output_dir": ".../temp/camera-multiview/run1",
    "summary_path": ".../temp/camera-multiview/run1/summary.json"
  },
  "errors": [],
  "advisories": []
}
```

The output dir contains:

```
temp/camera-multiview/run1/
├── summary.json
├── zove_00020_.png        (the full composition: input + 12 views)
├── face_00005_.png
├── z_00005_.png
├── ... (12 .png files)
```

### Exit codes

| Code | Cause | Recovery |
|---|---|---|
| 0 | success | Check `result.summary_path` / `<output-dir>/summary.json` |
| 2 | `invalid_request` (missing/invalid request file) · `input_file_missing` · `validation_failed` (schema) | Fix the request; ensure paths exist on disk |
| 4 | `asset_integrity_error` — fixed asset drifted | Run `assets verify`; the file or `spec.py` is out of sync |
| 5 | `comfyui_mcp_error` — comfyui-mcp JSON-RPC failed, **or** workflow ran but returned `status="error"` (ADR-0001: MCP 故障归 runtime) | Read `result`/`summary.json` |

## Where output goes

The `run` command writes one JSON file (`summary.json`) plus N PNG
files (where N = number of `SaveImage` outputs from the workflow;
typically 12) to `<output-dir>/`. See the
[Output section in SKILL.md](../SKILL.md#output-summaryjson) for the
`summary.json` schema.