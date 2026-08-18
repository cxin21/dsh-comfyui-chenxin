"""camera-image CLI.

Three subcommands over the shared chenxin_runtime engine:

* ``describe`` — request schema and asset identity.
* ``run`` — validate the request, upload images, patch the UI graph,
  strip via comfyui-mcp, and execute against ComfyUI.
* ``assets verify`` — fixed-asset integrity check.
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

from .runtime.assets import asset_identity, load_fixed_ui
from .runtime.confirm import GroupConfirmationAborted, confirm_group_plan
from .runtime.contracts import validate_api_graph
from .runtime.graph import (
    list_available_groups,
    patch_api_lora,
    patch_ui,
    resolve_enabled_groups,
)
from .runtime.presets import apply_preset, preset_table
from .runtime.request import (
    STAGES,
    example_request,
    parse_request,
    require_files,
    upload_targets,
)


def _descriptor() -> dict:
    identity = asset_identity()
    return {
        "asset_workflow_name": identity["asset"],
        "asset_sha256": identity["asset_sha256"],
        "workflow_fingerprint": identity["workflow_fingerprint"],
        "profile_id": identity["profile_id"],
    }


def cmd_describe(args: argparse.Namespace) -> tuple[dict, int]:
    descriptor = _descriptor()
    if args.summary:
        payload = {
            "stage": args.stage,
            "request_fields": {
                "prompt": "object {positive: string, negative: string}",
                "evidence": "object (creative evidence; passed through)",
                "profile_id": f"string, must be {descriptor['profile_id']!r} (the manifest's pinned profile)",
                "camera": "object {direction, elevation, distance, roll} (optional)",
                "camera_extra": "object — 13 fields of node 585 (optional)",
                "lora": "object {selections: [{name, strength_model, strength_clip, active, trigger_words}]} (optional)",
                "groups": "object {g1: [titles...], g2: [titles...]} (optional; titles must match groups.json exactly — no aliases)",
                "sampling": "object {steps_first, cfg, sampler, scheduler, denoise_first, steps_refine, denoise_refine} (optional)",
                "seed": "integer (optional)",
                "image_size": "object {width, height} (optional)",
                "reference_image": "local image path (i2i only)",
                "controlnet_image": "local image path (optional)",
                "red_prompt/green_prompt/blue_prompt": "red/green/blue region prompts (optional)",
                "red_image/green_image/blue_image": "RG/B region reference images (optional)",
                "signature_image": "local image path (optional)",
                "preset": "one of the preset table (optional shortcut for camera+image_size)",
            },
            "presets": preset_table(),
            "example": example_request(descriptor["profile_id"]),
            "output": "one PNG per run",
            **descriptor,
        }
    else:
        payload = {
            "stage": args.stage,
            "presets": preset_table(),
            **descriptor,
        }
    return emit_success("describe", args.stage, payload), 0


def cmd_assets_verify(args: argparse.Namespace) -> tuple[dict, int]:
    ui = load_fixed_ui()
    descriptor = _descriptor()
    return emit_success(
        "assets verify", args.stage,
        {"verified": True, "node_count": len(ui.get("nodes", [])), **descriptor},
    ), 0


def cmd_run(args: argparse.Namespace) -> tuple[dict, int]:
    payload = load_json_request(request_path=args.request)
    identity = asset_identity()
    config = parse_request(args.stage, payload, identity["profile_id"])
    require_files(config)
    config = apply_preset(config)

    group_plan = resolve_enabled_groups(args.stage, config.groups)
    available_groups = list_available_groups(args.stage)
    confirm_group_plan(group_plan, yes=args.yes, available=available_groups)

    output_dir = args.output_dir or temp_dir("camera-image")

    targets = upload_targets(config)
    with ExecutionSession(
        args.comfyui_url,
        timeout=args.timeout,
        poll_interval=args.poll_interval,
    ) as session:
        uploaded_names: dict[str, str] = {}
        for field in targets:
            path = getattr(config, field)
            uploaded_names[field] = session.upload(path)

        ui = patch_ui(
            load_fixed_ui(),
            config,
            stage=args.stage,
            mcp_list_loras=session._server().list_local_models,
            uploaded_names=uploaded_names,
        )
        cache_workflow(f"camera-image-{args.stage}", ui)
        api_graph, strip_notes = session.strip_ui_workflow(ui)
        # Post-strip API patch: the strip drops the LoraManager's three
        # __lm_widget_ids-driven widget values from node 26, leaving
        # `text` missing (required) → cascades as "Output will be ignored"
        # for 35/490/550. Re-write the dropped inputs directly.
        api_graph = patch_api_lora(
            api_graph, config, session._server().list_local_models
        )
        validate_api_graph(api_graph)
        report = session.execute(
            api_graph, output_dir=output_dir, strip_notes=strip_notes
        )

    summary = write_summary(
        output_dir,
        report,
        {
            "stage": args.stage,
            "preset": config.preset,
            "seed": config.seed,
            "uploads": [
                {"field": field, "comfyui_name": name}
                for field, name in uploaded_names.items()
            ],
        },
    )
    return emit_success("run", args.stage, summary), 0


def main() -> None:
    main_entry(
        prog="camera-image",
        description="Anima camera workflow skill (text-to-image / image-to-image).",
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
                        help="Where summary.json + produced PNG land. "
                             "Defaults to <preset>/temp/camera-image/."),
                    arg("--comfyui-url", default="http://127.0.0.1:8188"),
                    arg("--timeout", type=float, default=1800.0),
                    arg("--poll-interval", type=float, default=2.0),
                    arg("--yes", action="store_true", default=False,
                        help="Skip the interactive confirmation before "
                             "enabling workflow groups."),
                ),
            ),
            Subcommand(
                "assets", "Bundled asset operations.",
                subcommands=(
                    Subcommand("verify", "Verify digest + fingerprint.",
                               handler=cmd_assets_verify,
                               args=(arg("--stage", required=True, choices=STAGES),)),
                ),
            ),
        ],
        extra_error_handlers=(
            (McpClientError, "comfyui_mcp_error", "integrity", None),
            (ComfyUIHTTPError, "comfyui_runtime_error", "runtime", None),
            (FileNotFoundError, "input_file_missing", "request", None),
            (GroupConfirmationAborted, "group_confirmation_aborted", "request", None),
        ),
    )


if __name__ == "__main__":
    main()
