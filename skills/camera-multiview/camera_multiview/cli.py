"""camera-multiview CLI.

Three subcommands over the comfyui-mcp stdio bridge:

* ``describe`` — request contract + asset identity.
* ``run`` — validate, upload, patch, validate, enqueue, wait, download.
* ``assets verify`` — bundled asset + pose integrity check.

This CLI speaks the shared ``chenxin_runtime`` seam: one P1 JSON envelope
on stdout, fixed error-category exit codes, and ``--list-actions`` action
discovery (nested actions printed as ``parent.child``). See ADR-0001 for
the ``comfyui_mcp_error → runtime (exit 5)`` classification.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from chenxin_runtime import (
    Subcommand,
    arg,
    emit_success,
    load_json_request,
    main_entry,
)

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


def cmd_describe(args: argparse.Namespace) -> tuple[dict, int]:
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
    return emit_success("describe", spec.STAGE, payload), 0


def cmd_assets_verify(args: argparse.Namespace) -> tuple[dict, int]:
    identity = assets.verify_assets()
    return emit_success(
        "assets verify", spec.STAGE,
        {
            "verified": True,
            "stage": spec.STAGE,
            "asset_workflow_name": identity.workflow_filename,
            "asset_sha256": identity.workflow_sha256,
            "workflow_node_count": identity.workflow_node_count,
            "pose_count": identity.pose_count,
            "poses": [{"filename": f, "sha256": h} for f, h in identity.poses],
        },
    ), 0


def cmd_run(args: argparse.Namespace) -> tuple[dict, int]:
    payload = load_json_request(request_path=args.request)
    config = RunConfig.from_envelope({}, **payload)

    output_dir = Path(args.output_dir) if args.output_dir else _temp_dir()

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

    if result.status == "error":
        raise McpError("; ".join(result.error_messages) or "ComfyUI reported an error status")

    lines = [
        f"[camera-multiview] stage: {spec.STAGE}",
        f"[camera-multiview] comfyui: {args.comfyui_url}",
        f"[camera-multiview] output: {output_dir.resolve()}",
        f"[camera-multiview] prompt_id: {result.prompt_id}",
        f"[camera-multiview] status: {result.status}",
        f"[camera-multiview] elapsed: {result.elapsed_seconds:.1f}s",
        f"[camera-multiview] uploads: {len(result.uploads)}",
        f"[camera-multiview] artifacts: {len(result.artifacts)}",
        f"[camera-multiview] summary: {(output_dir / 'summary.json').resolve()}",
    ]
    for art in result.artifacts:
        if "error" in art:
            lines.append(f"  - [ERROR] {art.get('remote_filename')} ({art.get('error')})")
        else:
            lines.append(f"  - {art['filename']}  {art['bytes']} bytes  (node {art['node_id']})")

    return emit_success("run", spec.STAGE, {
        "summary": "\n".join(lines),
        "prompt_id": result.prompt_id,
        "graph_sha256": result.api_graph_sha256,
        "status": result.status,
        "elapsed_seconds": result.elapsed_seconds,
        "uploads": result.uploads,
        "artifacts": result.artifacts,
        "output_dir": str(output_dir.resolve()),
        "summary_path": str((output_dir / "summary.json").resolve()),
    }), 0


def main() -> None:
    main_entry(
        prog="camera-multiview",
        description="Fixed Flux2-Klein character multiview workflow skill.",
        subcommands=[
            Subcommand(
                "describe", "Request contract. --summary for the LLM-facing shape.",
                handler=cmd_describe,
                args=(arg("--summary", action="store_true", default=False),),
            ),
            Subcommand(
                "assets", "Bundled asset operations.",
                subcommands=(
                    Subcommand("verify", "Verify workflow + pose digests.",
                               handler=cmd_assets_verify),
                ),
            ),
            Subcommand(
                "run", "Validate, upload, patch, enqueue, wait, download.",
                handler=cmd_run,
                args=(
                    arg("--request", required=True, type=Path,
                        help="Path to a JSON request file with full_body_image + face_image."),
                    arg("--output-dir", required=False, type=Path, default=None,
                        help="Where the multi-view sheets land. "
                             "Defaults to <preset>/temp/camera-multiview/."),
                    arg("--comfyui-url", default="http://127.0.0.1:8188",
                        help="ComfyUI server base URL."),
                    arg("--timeout", type=float, default=1800.0,
                        help="Total wait-for-completion timeout (sec)."),
                    arg("--poll-interval", type=float, default=2.0,
                        help="History poll interval (sec)."),
                    arg("--mcp-timeout", type=float, default=60.0,
                        help="Per-MCP-call timeout (sec)."),
                ),
            ),
        ],
        extra_error_handlers=(
            (McpError, "comfyui_mcp_error", "runtime", None),          # ADR-0001
            (assets.AssetError, "asset_integrity_error", "integrity", None),
            (FileNotFoundError, "input_file_missing", "request", None),
        ),
    )


if __name__ == "__main__":
    main()
