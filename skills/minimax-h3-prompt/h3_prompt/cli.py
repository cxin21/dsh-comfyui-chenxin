"""MiniMax-H3 prompt skill CLI.

One action: ``author``. The model supplies a structured story (shots +
optional references / videos / audios), optionally via a precompiled multishot
plan (``--plan``). The code generates the model-native prompt text in five
official modes (T2VA / I2VA / FL2VA / L2VA / Ref2VA), emits a parallel
Chinese skeleton, audits it, and accounts the exact token + character
budget. Audit findings, token overage, and character overage are hard
failures with dedicated error codes.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from chenxin_runtime import (
    Subcommand,
    TokenizerIntegrityError,
    arg,
    emit_failure,
    emit_success,
    load_json_request,
    main_entry,
)

from .audit import audit_prompt
from .budget import build_budget
from .contracts import (
    OfficialEnvelopeError,
    STAGES,
    parse_request,
)
from .dialect import build_text_pair
from .multishot import MultishotPlanError, compile_plan, load_plan
from .token_counting import TokenCounter


EXPECTED_SNAPSHOT = "h3-qwen3-vl"


def cmd_author(args: argparse.Namespace) -> tuple[dict, int]:
    payload = load_json_request(request_path=args.request)
    stage = args.stage
    story = parse_request(stage, payload)
    counter = TokenCounter.load(args.tokenizer_dir, EXPECTED_SNAPSHOT)
    assumptions: list[str] = []

    if args.plan is not None:
        try:
            plan = load_plan(args.plan)
        except MultishotPlanError as error:
            return emit_failure(
                "author", stage,
                [{
                    "code": "h3_audit_failed",
                    "message": f"multishot plan failed to load: {error}",
                    "details": {"type": "MultishotPlanError"},
                }],
            ), 3
        findings_plan = compile_plan(plan)
        if findings_plan:
            return emit_failure(
                "author", stage,
                [{
                    "code": "h3_audit_failed",
                    "message": "multishot plan failed validation",
                    "details": {"findings": list(findings_plan)},
                }],
            ), 3
        # Rebuild story with the plan's shots; preserve the original stage,
        # duration, references, videos, audios from the parsed story.
        from .contracts import StoryRequest

        story = StoryRequest(
            stage=story.stage,
            duration_seconds=story.duration_seconds,
            shots=plan.compile_to_shots(),
            references=story.references,
            videos=story.videos,
            audios=story.audios,
        )

    text_en, text_zh = build_text_pair(stage, story)

    findings = audit_prompt(
        stage,
        text_en,
        duration_seconds=story.duration_seconds,
        shot_count=len(story.shots),
        references=story.references,
    )
    if findings:
        return emit_failure(
            "author", stage,
            [{
                "code": "h3_audit_failed",
                "message": "generated prompt failed the H3 audit gates",
                "details": {"findings": list(findings)},
            }],
        ), 3

    budget = build_budget(
        stage=stage,
        text=text_en,
        counter=counter,
        references=story.references,
        videos=story.videos,
        audios=story.audios,
        assumptions=assumptions,
    )
    if budget["over"]:
        return emit_failure(
            "author", stage,
            [{
                "code": "budget_exceeded",
                "message": (
                    f"prompt uses {budget['text_tokens']} tokens / "
                    f"{budget['char_count']} chars, over the effective cap "
                    f"{budget['effective_cap']} tokens / "
                    f"{budget['char_limit']} chars"
                ),
                "details": {"budget": budget},
            }],
        ), 3

    return emit_success(
        "author", stage,
        {
            "text": text_en,
            "text_zh": text_zh,
            "text_zh_meta": {
                "quality": "skeleton",
                "structural_tokens_translated": True,
                "prose_translated": False,
                "advisory": (
                    "Chinese skeleton only: structural tokens are translated, "
                    "prose is verbatim English. The calling model is responsible "
                    "for any literary Chinese translation on top of this skeleton."
                ),
            },
            "findings": [],
            "assumptions": assumptions,
            "budget": budget,
            "mode": stage,
            "stage": stage,
        },
    ), 0


def main() -> None:
    main_entry(
        prog="minimax-h3-prompt",
        description=(
            "MiniMax-H3 story-to-prompt authoring with audit, "
            "exact token budget, 7000-character cap, and bilingual "
            "English + Chinese skeleton output."
        ),
        subcommands=[
            Subcommand(
                "author",
                "Generate, audit, and budget an H3 prompt from a story.",
                handler=cmd_author,
                args=(
                    arg("--stage", required=True, choices=list(STAGES)),
                    arg("--request", required=True, type=Path),
                    arg("--tokenizer-dir", required=True, type=Path),
                    arg("--plan", required=False, type=Path, default=None),
                ),
            ),
        ],
        extra_error_handlers=(
            (TokenizerIntegrityError, "tokenizer_integrity_failed", "integrity", None),
            (OfficialEnvelopeError, "official_envelope_violated", "validation", None),
        ),
    )


if __name__ == "__main__":
    main()