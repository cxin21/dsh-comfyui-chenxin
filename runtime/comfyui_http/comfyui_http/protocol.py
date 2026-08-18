"""Typed record the read-only HTTP transport returns."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Artifact:
    """A binary artifact downloaded from ``GET /view``."""

    filename: str
    subfolder: str
    artifact_type: str
    bytes: bytes

    @property
    def sha256(self) -> str:
        import hashlib

        return hashlib.sha256(self.bytes).hexdigest()
