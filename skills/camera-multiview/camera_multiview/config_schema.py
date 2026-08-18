"""The two user-uploaded reference images. Nothing else is configurable.

The Prompt Forge / engine handles dialect, draft, evidence, groups,
LoRAs, etc. upstream. None of those concerns belong in this skill — the
fixed workflow defines them.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RunConfig:
    """Only the two user-uploaded reference image paths are configurable."""

    full_body_image: str
    face_image: str

    @classmethod
    def from_envelope(cls, envelope: dict[str, Any] | None, **tunables: Any) -> "RunConfig":
        """Build a RunConfig from the engine's envelope + tunables.

        Unknown tunable keys are rejected — the skill does not accept
        arbitrary config, and silently ignoring extra keys would hide
        contract drift.
        """
        allowed = {"full_body_image", "face_image"}
        unknown = sorted(set(tunables) - allowed)
        if unknown:
            raise TypeError(f"unsupported multiview config field(s): {unknown}")

        full_body = tunables.get("full_body_image")
        face = tunables.get("face_image")
        if not isinstance(full_body, str) or not full_body.strip():
            raise TypeError("full_body_image is required (non-empty path string)")
        if not isinstance(face, str) or not face.strip():
            raise TypeError("face_image is required (non-empty path string)")

        # We don't validate file existence here — the engine handles upload
        # failure at the moment it tries to push the bytes to ComfyUI.
        return cls(full_body_image=full_body, face_image=face)