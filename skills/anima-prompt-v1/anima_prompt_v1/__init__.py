"""Clean-room Anima prompt authoring package (4-stage pipeline)."""

from .types import (
    Citation,
    ComposedPrompt,
    ComposedSegment,
    InspectionIssue,
    ModelPolicy,
    UserBrief,
    is_explicit_request,
)
from .grounding import ground
from .composition import compose
from .inspection import inspect as inspect_prompt
from .output import PromptOutput, render_output, to_json_output, to_text_output

__all__ = [
    "Citation",
    "ComposedPrompt",
    "ComposedSegment",
    "InspectionIssue",
    "ModelPolicy",
    "PromptOutput",
    "UserBrief",
    "compose",
    "ground",
    "inspect_prompt",
    "is_explicit_request",
    "render_output",
    "to_json_output",
    "to_text_output",
]
