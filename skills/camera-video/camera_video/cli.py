"""camera-video CLI.

Three stages over fixed MiniMax H3 API assets:

* ``describe`` — the request contract for one stage + asset identity.
* ``run`` — validate the request locally, then execute the fixed asset
  through the shared engine (comfyui-mcp owns execution).
* ``assets verify`` — bundled asset integrity check for one stage.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from chenxin_runtime import (
    ComfyUIHTTPError,
    ExecutionSession,
    McpClientError,
    Subcommand,
    arg,
    cache_workflow,
    emit_success,
    load_json_request,
    main_entry,
    temp_dir,
    write_summary,
)

from .runtime.assets import STAGES, load_fixed_workflow, scene_spec
from .runtime.graph import build_graph
from .runtime.request import (
    example_for_stage,
    STAGE_REFERENCE_COUNT,
    parse_request,
    require_files,
)


def _descriptor(stage: str) -> dict:
    spec = scene_spec(stage)
    return {
        "asset_workflow_name": spec.get("workflow_name", spec["workflow"]),
        "asset_sha256": spec.get("sha256", ""),
        "node_count": spec.get("node_count"),
        "reference_count": STAGE_REFERENCE_COUNT[stage],
    }


def cmd_describe(args: argparse.Namespace) -> tuple[dict, int]:
    descriptor = _descriptor(args.stage)
    expected = STAGE_REFERENCE_COUNT[args.stage]
    if args.summary:
        payload = {
            "stage": args.stage,
            "request": {
                "prompt": "string, required (H3 native prompt)",
                "duration": "number in [2, 15], default 4.0",
                "references": f"{expected} ordered local image path(s)",
            },
            "example": example_for_stage(args.stage),
            "output": "one video per run",
            **descriptor,
        }
    else:
        payload = {"stage": args.stage, **descriptor}
    return emit_success("describe", args.stage, payload), 0


def cmd_assets_verify(args: argparse.Namespace) -> tuple[dict, int]:
    workflow = load_fixed_workflow(args.stage)
    descriptor = _descriptor(args.stage)
    return emit_success(
        "assets verify", args.stage,
        {"verified": True, "node_count": len(workflow), **descriptor},
    ), 0


def cmd_run(args: argparse.Namespace) -> tuple[dict, int]:
    payload = load_json_request(request_path=args.request)
    request = parse_request(args.stage, payload)
    require_files(request)
    output_dir = args.output_dir or temp_dir("camera-video")
    with ExecutionSession(
        args.comfyui_url,
        timeout=args.timeout,
        poll_interval=args.poll_interval,
    ) as session:
        reference_names = tuple(
            session.upload(path) for path in request.references
        )
        graph = build_graph(
            stage=args.stage,
            prompt=request.prompt,
            duration=request.duration,
            reference_names=reference_names,
        )
        cache_workflow(f"camera-video-{args.stage}", graph)
        report = session.execute(graph, output_dir=output_dir)
    summary = write_summary(output_dir, report, {"stage": args.stage})
    return emit_success("run", args.stage, summary), 0


def main() -> None:
    main_entry(
        prog="camera-video",
        description="MiniMax H3 video workflow skill (T2V / I2V / multi-I2V).",
        subcommands=[
            Subcommand(
                "describe", "Request contract. --summary for the LLM-facing shape.",
                handler=cmd_describe,
                args=(
                    arg("--stage", required=True, choices=STAGES),
                    arg("--summary", action="store_true", default=False),
                ),
            ),
            Subcommand(
                "run", "Validate the request, then execute the fixed asset.",
                handler=cmd_run,
                args=(
                    arg("--stage", required=True, choices=STAGES),
                    arg("--request", required=True, type=Path),
                    arg("--output-dir", required=False, type=Path, default=None,
                        help="Where summary.json + produced video land. "
                             "Defaults to <preset>/temp/camera-video/."),
                    arg("--comfyui-url", default="http://127.0.0.1:8188"),
                    arg("--timeout", type=float, default=1800.0),
                    arg("--poll-interval", type=float, default=2.0),
                ),
            ),
            Subcommand(
                "assets", "Bundled asset operations.",
                subcommands=(
                    Subcommand("verify", "Verify digest + topology.",
                               handler=cmd_assets_verify,
                               args=(arg("--stage", required=True, choices=STAGES),)),
                ),
            ),
        ],
        extra_error_handlers=(
            (McpClientError, "comfyui_mcp_error", "integrity", None),
            (ComfyUIHTTPError, "comfyui_runtime_error", "runtime", None),
            (FileNotFoundError, "input_file_missing", "request", None),
        ),
    )


if __name__ == "__main__":
    main()
