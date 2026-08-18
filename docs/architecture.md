# Architecture

Single authoritative description of the preset. If code and this document disagree, one of them is wrong; `scripts/check_contracts.py` is the gate for the LLM-facing half.

## What this preset does

Five DSH skills + three shared Python packages let the agent author prompts for two generative models (Anima, MiniMax H3) and execute three fixed ComfyUI workflows (Anima camera, MiniMax H3 video, Flux2-Klein multiview).

```
skills/                                  runtime/
├── anima-prompt-v1/    (Anima prompt compiler)       ├── comfyui_http/    (stdlib HTTP)
├── minimax-h3-prompt/  (MiniMax H3 prompt compiler)  ├── comfyui_mcp/     (stdio JSON-RPC client)
├── camera-image/       (Anima camera workflow)       └── chenxin_runtime/ (P1 envelope + camera engine)
├── camera-video/       (MiniMax H3 video workflow)
└── camera-multiview/   (Flux2-Klein character sheet)
```

## Interaction model

```
catalog description  →  skill tool loads SKILL.md  →  CLI tool call
      (when)                  (contract)                 (one flat request)
```

- **Catalog description** is the 1-line `description` field in each SKILL.md's frontmatter — visible to the host when the user might trigger the skill
- **SKILL.md body** is the contract the LLM follows: when to call, request shape, commands, output, failure modes, examples
- **CLI tool call** is one flat JSON request via `--request <file.json>` (or `--stdin`); output is the P1 JSON envelope

Every skill CLI returns the P1 envelope on stdout:
```json
{
  "ok": true,
  "command": "...",
  "stage": "...",
  "result": { ... },
  "errors": [],
  "advisories": []
}
```

Exit codes by category:

| Category | Exit |
|---|---|
| `request` | 2 |
| `validation` | 3 |
| `integrity` | 4 |
| `runtime` | 5 |
| `unexpected` | 70 |

Note: `anima-prompt-v1 author` without `--json` switches to a two-block text format (POSITIVE / NEGATIVE). All other CLIs always emit JSON.

**Design rule: the LLM writes content; the code writes structure.** No skill requires the LLM to produce storage shapes, widget indices, node IDs, or provenance metadata. The LLM supplies subject / prompt / camera semantic / paths — the code turns those into node wiring and graph validation.

## Request shapes (single flat object via `--request`)

Each skill accepts exactly one flat JSON object via `--request`. Authoritative schemas live in each SKILL.md; this table is the index.

| Skill | Request fields (full schema in SKILL.md) |
|---|---|
| `anima-prompt-v1 author` | `{variant, subject, slots, narrative?, exclusions?, quality_prefix?, explicit?}` |
| `minimax-h3-prompt author` | `--stage` flag + `{duration_seconds, shots[{what, who?, ambient?, music?, dialogue?}], references?[], videos?[], audios?[]}` (stage ∈ t2va/i2va/fl2va/l2va/ref2va; or `--plan plan.json` for ≥10s multishot) |
| `camera-image run` | `{prompt.{positive,negative}, evidence?, profile_id?, preset?, seed?, image_size?, camera?, camera_extra?, lora?, sampling?, groups?, reference_image?, controlnet_image?, red/green/blue_prompt?, red/green/blue_image?, signature_image?}` (stage: t2i/i2i) |
| `camera-video run` | `{prompt, duration, references[]}` (stage: t2v/i2v/multi-i2v) |
| `camera-multiview run` | `{full_body_image, face_image}` |

`scripts/check_contracts.py` extracts the first jsonc block from each SKILL.md and runs it through the exact parser. Drift → red gate. Run after any SKILL.md or schema change.

## Execution boundary (camera skills)

- **comfyui-mcp** (via `runtime/comfyui_mcp`) owns everything that mutates ComfyUI state or requires server knowledge: `strip_workflow` (UI→API for camera-image), `upload_image`, `enqueue_workflow`. ComfyUI validates the API graph **atomically at enqueue** — there is no separate pre-flight step.
- **comfyui_http** (via `runtime/comfyui_http`) is the read-only channel: history polling **with status verification** and artifact download via `GET /view`.
- **chenxin_runtime** (`runtime/chenxin_runtime`) owns the P1 envelope protocol, the shared CLI runner (`--list-actions`, `--json` handling, error categories → exit codes), and the camera execution engine (`ExecutionSession`) that bundles one MCP subprocess + one HTTP session per run.
- One run = one `ExecutionSession` = one MCP subprocess.

Fixed assets are the only workflow source. sha256 + structural checks at load; mismatch = fail-closed (no discovery, no repair, no fallback).

## Why local packages don't go through `pip install -e`

`pip install -e <local-dir>` fails on the target Windows machine with `OSError [Errno 13] Permission denied` at the build-tracker step (likely AV/EDR quarantine; see `~`-prefixed dist-info leftovers from past interrupted upgrades). Direct `os.open(path, O_CREAT|O_EXCL, 0o600)` of the same path succeeds.

The fix: **bypass pip for local packages**. `scripts/install_local.py` writes the same artifacts pip would write — `.pth` file (source dir → sys.path), `distlib.scripts.ScriptMaker` launcher (`<cli>.exe` + companion files), minimal `<name>-<ver>.dist-info/` — by hand. `tokenizers` (the only third-party PyPI dep) still goes through `pip install` because it's a real PyPI wheel.

This is **deterministic and idempotent**: re-running `setup.ps1` always rewrites the venv to match the source tree, so source upgrades (pyproject version bumps) are picked up automatically with no manual cleanup.

## Skill anatomy

```
skills/<name>/
├── SKILL.md                  # the LLM contract (schema + commands + output + failures)
├── pyproject.toml            # console-script entry point; deps: chenxin-runtime (+ tokenizers for h3)
├── <package>/                # importable Python package
│   ├── __init__.py
│   ├── cli.py                # thin: argparse + handlers (or main_entry + Subcommand)
│   └── ...
│       ├── runtime/          # skill-specific logic: request parsing, graph building, asset loading
│       └── workflow_assets/  # fixed workflows + manifests + tokenizers (where applicable)
├── references/               # deep docs: node IDs, camera coords, pipeline phases, etc.
└── knowledge/                # skill-specific data (anima catalog sqlite, h3 tokenizer snapshot)
```

5 skills × this layout, plus `runtime/` with 3 packages following the same `<pkg>/__init__.py` + `<pkg>/cli.py` pattern.

## Maintenance operations

| Task | Command |
|---|---|
| Fresh install / repair | `powershell -ExecutionPolicy Bypass -File scripts/setup.ps1` |
| Re-write local packages only | `<preset>\.venv\Scripts\python.exe scripts/install_local.py` |
| Verify SKILL.md contracts | `<preset>\.venv\Scripts\python.exe scripts/check_contracts.py` |
| Rebuild Anima catalog | `anima-prompt-v1 catalog build --source knowledge/source --output knowledge` |
| Verify Anima catalog | `anima-prompt-v1 catalog verify --database knowledge/tag-catalog.sqlite --manifest knowledge/manifest.json` |
| Verify camera assets | `<camera-cli> assets verify --stage <stage>` |
| Reset tokenizer snapshot (h3 only) | Re-run `setup.ps1` (install_local doesn't touch PyPI wheels) |
