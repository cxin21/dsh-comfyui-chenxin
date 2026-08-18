"""Request schema for camera-video.

One flat object:

    {"prompt": "<H3 native prompt>", "duration": 6.0, "references": ["..."]}

``references`` length is fixed per stage: t2v 0, i2v 1, multi-i2v 3.
Unknown fields are rejected.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


ALLOWED_FIELDS = ("prompt", "duration", "references")

STAGE_REFERENCE_COUNT = {
    "t2v": 0,
    "i2v": 1,
    "multi-i2v": 3,
}

EXAMPLE_REQUEST: dict[str, Any] = {
    "prompt": "[Shot 1] A cat stands on a rooftop at dusk, looking at the city.",
    "duration": 6.0,
    "references": ["C:/path/to/ref-1.png"],
}


def example_for_stage(stage: str) -> dict[str, Any]:
    """Return a runnable example whose reference count matches the stage.

    The single canonical example is i2v-shaped (1 reference). For t2v the
    ``references`` field is omitted; for multi-i2v the list is padded to
    the stage's required count so copying the example into a request never
    fails the reference-count gate.
    """
    if stage not in STAGE_REFERENCE_COUNT:
        raise ValueError(f"unknown camera-video stage: {stage!r}")
    expected = STAGE_REFERENCE_COUNT[stage]
    if expected == 0:
        return {k: v for k, v in EXAMPLE_REQUEST.items() if k != "references"}
    if expected == 1:
        return dict(EXAMPLE_REQUEST)
    return {
        "prompt": EXAMPLE_REQUEST["prompt"],
        "duration": EXAMPLE_REQUEST["duration"],
        "references": [
            f"C:/path/to/ref-{i}.png" for i in range(1, expected + 1)
        ],
    }


@dataclass(frozen=True)
class VideoRequest:
    prompt: str
    duration: float
    references: tuple[Path, ...]


def parse_request(stage: str, payload: Any) -> VideoRequest:
    """Validate the request shape for one stage; file checks happen later."""
    if stage not in STAGE_REFERENCE_COUNT:
        raise ValueError(f"unknown camera-video stage: {stage!r}")
    if not isinstance(payload, dict):
        raise TypeError("request must be a JSON object")
    unknown = sorted(set(payload) - set(ALLOWED_FIELDS))
    if unknown:
        raise TypeError(
            f"unsupported request field(s): {unknown}; valid fields: {sorted(ALLOWED_FIELDS)}"
        )
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise TypeError("request field 'prompt' must be a non-empty string")
    duration = payload.get("duration", 4.0)
    if isinstance(duration, bool) or not isinstance(duration, (int, float)):
        raise TypeError(
            f"request field 'duration' must be a JSON number (got {duration!r}); use 8.0 not \"8.0\""
        )
    duration = float(duration)
    if not 2.0 <= duration <= 15.0:
        raise ValueError(f"duration must be between 2 and 15 seconds, got {duration}")
    raw_refs = payload.get("references", [])
    if not isinstance(raw_refs, list):
        raise TypeError("request field 'references' must be an array of path strings")
    references: list[Path] = []
    for index, item in enumerate(raw_refs):
        if not isinstance(item, str) or not item.strip():
            raise TypeError(f"references[{index}] must be a non-empty path string")
        references.append(Path(item.strip()))
    expected = STAGE_REFERENCE_COUNT[stage]
    if len(references) != expected:
        raise ValueError(
            f"stage {stage} requires exactly {expected} references, got {len(references)}"
        )
    return VideoRequest(prompt=prompt.strip(), duration=duration, references=tuple(references))


def require_files(request: VideoRequest) -> None:
    for index, path in enumerate(request.references):
        if not path.is_file():
            raise FileNotFoundError(f"references[{index}] is missing: {path}")
