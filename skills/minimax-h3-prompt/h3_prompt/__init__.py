"""Independent MiniMax-H3 prompt skill surface."""

from .contracts import (
    KEYFRAME_STAGES,
    MAX_PROMPT_CHARS,
    REFERENCE_STAGE,
    STAGES,
    AudioReference,
    Reference,
    Shot,
    StoryRequest,
    VideoReference,
    parse_request,
)
from .dialect import (
    build_text,
    build_text_pair,
    build_text_zh,
)
from .audit import H3AuditError, audit_prompt
from .multishot import (
    MultishotPlan,
    MultishotPlanError,
    ShotDraft,
    compile_plan,
    load_plan,
)


__all__ = [
    "H3AuditError",
    "KEYFRAME_STAGES",
    "MAX_PROMPT_CHARS",
    "MultishotPlan",
    "MultishotPlanError",
    "REFERENCE_STAGE",
    "ShotDraft",
    "STAGES",
    "AudioReference",
    "Reference",
    "Shot",
    "StoryRequest",
    "VideoReference",
    "audit_prompt",
    "build_text",
    "build_text_pair",
    "build_text_zh",
    "compile_plan",
    "load_plan",
    "parse_request",
]