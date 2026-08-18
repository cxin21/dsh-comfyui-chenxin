"""Exact H3 token budgeting driven by references/budget-policy.json.

The policy file is the single source of truth for quality caps per stage.
``over`` is a hard failure: an over-budget prompt never ships.

Per-stage quality caps (MiniMax H3 official envelope):

    t2va      1200 tokens
    i2va      1500 tokens
    fl2va     1700 tokens
    l2va      1700 tokens
    ref2va    2400 tokens

All stages also cap at 7000 characters per the official MiniMax H3 manual;
the character gate lives in :mod:`h3_prompt.audit` and is reported
together with the token count under ``budget.char_over``.
"""

from __future__ import annotations

import json
from math import ceil
from pathlib import Path
from typing import Any

from .contracts import (
    MAX_PROMPT_CHARS,
    AudioReference,
    Reference,
    VideoReference,
)
from .token_counting import TokenCounter, count_h3_text_context


POLICY_PATH = Path(__file__).resolve().parents[1] / "references" / "budget-policy.json"

H3_CONTEXT_LIMIT = 262_144
H3_MIN_PIXELS = 65_536
H3_MAX_PIXELS = 16_777_216
H3_SPATIAL_STRIDE = 32

DEFAULT_REFERENCE_WIDTH = 1024
DEFAULT_REFERENCE_HEIGHT = 1024
DEFAULT_SPECIAL_TOKENS = 0
DEFAULT_RUNTIME_SAFETY_MARGIN = 256


def load_budget_policy() -> dict[str, Any]:
    try:
        policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"budget policy is unreadable: {POLICY_PATH}") from exc
    if not isinstance(policy, dict):
        raise ValueError("budget policy must be a JSON object")
    for stage in ("t2va", "i2va", "fl2va", "l2va", "ref2va"):
        if stage not in policy:
            raise ValueError(f"budget policy must define stage {stage!r}")
    return policy


def visual_tokens(reference: Reference, assumptions: list[str]) -> int:
    width = reference.width
    height = reference.height
    if width is None or height is None:
        width = width or DEFAULT_REFERENCE_WIDTH
        height = height or DEFAULT_REFERENCE_HEIGHT
        assumptions.append(
            f"reference_dimensions_assumed:{reference.who or 'Picture'}={width}x{height}"
        )
    pixels = width * height
    if not H3_MIN_PIXELS <= pixels <= H3_MAX_PIXELS:
        raise ValueError(
            f"reference {reference.who!r} pixel area must be within "
            f"{H3_MIN_PIXELS}..{H3_MAX_PIXELS}"
        )
    return ceil(width / H3_SPATIAL_STRIDE) * ceil(height / H3_SPATIAL_STRIDE)


def build_budget(
    *,
    stage: str,
    text: str,
    counter: TokenCounter,
    references: tuple[Reference, ...],
    videos: tuple[VideoReference, ...] = (),
    audios: tuple[AudioReference, ...] = (),
    assumptions: list[str],
) -> dict[str, Any]:
    policy = load_budget_policy()[stage]
    quality_cap = int(policy["limits"]["quality_cap"])
    text_tokens = count_h3_text_context(
        counter, text, reference_count=len(references)
    )
    visual = sum(visual_tokens(ref, assumptions) for ref in references)
    chat = count_h3_text_context(counter, "", reference_count=len(references))
    available = (
        H3_CONTEXT_LIMIT - visual - chat
        - DEFAULT_SPECIAL_TOKENS - DEFAULT_RUNTIME_SAFETY_MARGIN
    )
    if available < 0:
        raise ValueError("multimodal inputs exceed the physical H3 context limit")
    effective_cap = min(quality_cap, available)
    char_count = len(text)
    char_over = char_count > MAX_PROMPT_CHARS
    token_over = text_tokens > effective_cap
    return {
        "verified": True,
        "snapshot_id": counter.snapshot_id,
        "model_id": counter.manifest.model_id,
        "model_hard_limit": counter.manifest.model_hard_limit,
        "reference_count": len(references),
        "video_count": len(videos),
        "audio_count": len(audios),
        "visual_tokens": visual,
        "chat_template_tokens": chat,
        "available_tokens": available,
        "text_tokens": text_tokens,
        "char_count": char_count,
        "char_limit": MAX_PROMPT_CHARS,
        "quality_cap": quality_cap,
        "effective_cap": effective_cap,
        "over": token_over or char_over,
        "token_over": token_over,
        "char_over": char_over,
    }