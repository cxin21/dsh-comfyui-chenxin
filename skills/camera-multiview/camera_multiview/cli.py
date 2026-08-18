"""camera-multiview CLI.

Three subcommands over the comfyui-mcp stdio bridge:

* ``describe`` — request contract + asset identity.
* ``run`` — validate, upload, patch, validate, enqueue, wait, download.
* ``assets verify`` — bundled asset + pose integrity check.

Modeled after camera-image/cli.py: thin argparse handlers that delegate to
runtime modules. No external `chenxin_runtime` / `comfyui_chenxin_mcp`
dependency — we own the JSON-RPC client (see `mcp_session.py`).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import assets, spec
from .config_schema import RunConfig
from .executor import run
from .mcp_session import McpError, McpSession


def _preset_root() -> Path:
    """Preset root: ``DSH_COMFYUI_PRESET_ROOT`` env var, else the preset
    layout (``<preset>/skills/camera-multiview/camera_multiview/cli.py`` →
    three parents up)."""
    env = os.environ.get("DSH_COMFYUI_PRESET_ROOT")
    if env:
        return Path(env).resolve()
    return Path(__file__).resolve().parents[3]


def _temp_dir() -> Path:
    target = _preset_root() / "temp" / "camera-multiview"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _descriptor() -> dict:
    identity = assets.verify_assets()
    return {
        "stage": spec.STAGE,
        "asset_workflow_name": identity.workflow_filename,
        "asset_sha256": identity.workflow_sha256,
        "workflow_node_count": identity.workflow_node_count,
        "pose_count": identity.pose_count,
    }


def cmd_describe(args: argparse.Namespace) -> int:
    desc = _descriptor()
    if args.summary:
        payload = {
            "stage": spec.STAGE,
            "request": {
                "full_body_image": "string, required (local image path)",
                "face_image":      "string, required (local image path)",
            },
            "example": {
                "full_body_image": "C:/path/to/full-body.png",
                "face_image":      "C:/path/to/face.png",
            },
            "output": f"one multi-view image per pose slot of the bundled asset ({desc['pose_count']} total)",
            **desc,
        }
    else:
        payload = {"stage": spec.STAGE, **desc}
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def cmd_assets_verify(args: argparse.Namespace) -> int:
    identity = assets.verify_assets()
    print(json.dumps({
        "verified": True,
        "stage": spec.STAGE,
        "asset_workflow_name": identity.workflow_filename,
        "asset_sha256": identity.workflow_sha256,
        "workflow_node_count": identity.workflow_node_count,
        "pose_count": identity.pose_count,
        "poses": [{"filename": f, "sha256": h} for f, h in identity.poses],
    }, ensure_ascii=False, indent=2))
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    request_path = Path(args.request)
    if not request_path.is_file():
        print(f"ERROR: request file missing: {request_path}", file=sys.stderr)
        return 2
    try:
        payload = json.loads(request_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"ERROR: invalid JSON in {request_path}: {exc}", file=sys.stderr)
        return 2

    try:
        config = RunConfig.from_envelope({}, **payload)
    except (TypeError, ValueError) as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    output_dir = Path(args.output_dir) if args.output_dir else _temp_dir()
    print(f"[camera-multiview] stage: {spec.STAGE}")
    print(f"[camera-multiview] comfyui: {args.comfyui_url}")
    print(f"[camera-multiview] output: {output_dir.resolve()}")
    print(f"[camera-multiview] full_body: {config.full_body_image}")
    print(f"[camera-multiview] face:      {config.face_image}")

    try:
        with McpSession(
            comfyui_url=args.comfyui_url,
            request_timeout=args.mcp_timeout,
            poll_interval=args.poll_interval,
            total_timeout=args.timeout,
        ) as session:
            result = run(
                session,
                config,
                output_dir=output_dir,
                poll_interval=args.poll_interval,
                total_timeout=args.timeout,
            )
    except McpError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 5
    except (assets.AssetError,) as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 4
    except (ValueError, FileNotFoundError) as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    print(f"\n[camera-multiview] prompt_id:   {result.prompt_id}")
    print(f"[camera-multiview] graph_sha256: {result.api_graph_sha256[:16]}...")
    print(f"[camera-multiview] status:      {result.status}")
    print(f"[camera-multiview] elapsed:     {result.elapsed_seconds:.1f}s")
    print(f"[camera-multiview] uploads:     {len(result.uploads)}")
    if result.status == "error":
        for msg in result.error_messages:
            print(f"  [error] {msg}")
        print(f"\n[camera-multiview] summary: {(output_dir / 'summary.json').resolve()}")
        return 5

    print(f"[camera-multiview] artifacts:   {len(result.artifacts)}")
    for art in result.artifacts:
        if "error" in art:
            print(f"  - [ERROR] {art.get('remote_filename')} ({art.get('error')})")
        else:
            print(f"  - {art['filename']}  {art['bytes']} bytes  (node {art['node_id']})")

    summary_path = output_dir / "summary.json"
    print(f"\n[camera-multiview] summary: {summary_path.resolve()}")
    return 0


def main() -> int:
    # Virgin contract: --list-actions prints the canonical action set so the
    # DSH loader's loader.js introspectActions() can register the right
    # subcommands in the Host Tool description. Keep this in sync with the
    # subparsers below.
    if "--list-actions" in sys.argv[1:]:
        for action in ("describe", "assets", "run"):
            print(action)
        return 0

    parser = argparse.ArgumentParser(
        prog="camera-multiview",
        description="Fixed Flux2-Klein character multiview workflow skill.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_describe = sub.add_parser("describe", help="Request contract.")
    p_describe.add_argument("--summary", action="store_true",
                            help="Add the request fields + example.")
    p_describe.set_defaults(func=cmd_describe)

    p_verify = sub.add_parser("assets", help="Bundled asset operations.")
    p_verify_sub = p_verify.add_subparsers(dest="assets_command", required=True)
    p_verify_verify = p_verify_sub.add_parser("verify",
                                              help="Verify workflow + pose digests.")
    p_verify_verify.set_defaults(func=cmd_assets_verify)

    p_run = sub.add_parser("run", help="Validate, upload, patch, enqueue, wait, download.")
    p_run.add_argument("--request", required=True, type=Path,
                       help="Path to a JSON request file with full_body_image + face_image.")
    p_run.add_argument("--output-dir", required=False, type=Path,
                       help="Where the multi-view sheets land. "
                            "Defaults to <preset>/temp/camera-multiview/.")
    p_run.add_argument("--comfyui-url", default="http://127.0.0.1:8188",
                       help="ComfyUI server base URL.")
    p_run.add_argument("--timeout", type=float, default=1800.0,
                       help="Total wait-for-completion timeout (sec).")
    p_run.add_argument("--poll-interval", type=float, default=2.0,
                       help="History poll interval (sec).")
    p_run.add_argument("--mcp-timeout", type=float, default=60.0,
                       help="Per-MCP-call timeout (sec).")
    p_run.set_defaults(func=cmd_run)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())