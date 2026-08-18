"""Render ComposedPrompt to the wire output shape.

The five fields (positive / negative / notes / assumptions / advisories) are
the authoring contract defined in SKILL.md - not a legacy compatibility
surface. ComposedPrompt is backed by ComposedSegment with origin provenance;
this module only projects it onto the flat wire shape.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from .types import ComposedPrompt


@dataclass(frozen=True)
class PromptOutput:
    positive: str
    negative: str
    notes: tuple[str, ...] = ()
    assumptions: tuple[str, ...] = ()
    advisories: tuple[str, ...] = ()


def render_output(prompt: ComposedPrompt) -> PromptOutput:
    """Project ComposedPrompt onto the five-field wire shape."""
    return PromptOutput(
        positive=prompt.positive_text,
        negative=prompt.negative_text,
        notes=prompt.notes,
        assumptions=prompt.assumptions,
        advisories=tuple(
            f"[{issue.severity}] {issue.code}: {issue.message}"
            for issue in prompt.advisories
        ),
    )


def to_text_output(output: PromptOutput) -> str:
    return f"POSITIVE:\n{output.positive}\n\nNEGATIVE:\n{output.negative}"


def to_json_output(output: PromptOutput) -> str:
    return json.dumps(
        {
            "positive": output.positive,
            "negative": output.negative,
            "notes": list(output.notes),
            "assumptions": list(output.assumptions),
            "advisories": list(output.advisories),
        },
        ensure_ascii=False,
    )
