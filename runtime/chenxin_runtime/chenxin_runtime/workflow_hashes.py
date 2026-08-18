"""Canonical serialization and content hashing for workflow assets.

Shared by every camera-* skill via ``chenxin_runtime``. Pure functions; no
network, no filesystem side effects.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json(value: Any) -> str:
    """Serialize ``value`` deterministically (sorted keys, no spaces) for hashing."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def content_hash(value: Any) -> str:
    """SHA-256 digest of :func:`canonical_json`-serialized ``value``."""
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


__all__ = ["canonical_json", "content_hash"]
