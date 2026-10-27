"""Load and verify the fixed Anima UI asset against its manifest.

Thin adapter over :mod:`chenxin_runtime.fixed_asset` (issue #32): the
manifest is the trust root; hashing, verified reads, and the structural
fingerprint live in the shared module.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from chenxin_runtime import (
    ArtifactPin,
    FixedAsset,
    FixedAssetError,
    structure_fingerprint,
)


class WorkflowAssetError(FixedAssetError):
    """Raised when the fixed workflow asset is missing or altered."""


ASSET_ROOT = Path(__file__).with_name("workflow_assets")
MANIFEST_PATH = ASSET_ROOT / "manifest.json"


def _manifest() -> dict:
    try:
        value = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise WorkflowAssetError("fixed workflow manifest is unreadable") from exc
    if not isinstance(value, dict) or value.get("asset_policy") != "bundled-fixed-ui-json":
        raise WorkflowAssetError("fixed workflow manifest policy is invalid")
    return value


def _asset() -> FixedAsset:
    manifest = _manifest()
    return FixedAsset(
        [ArtifactPin("workflow", ASSET_ROOT / manifest["asset"], manifest["asset_sha256"])],
        label="fixed workflow asset",
    )


def asset_identity() -> dict[str, Any]:
    manifest = _manifest()
    return {
        "asset": manifest["asset"],
        "asset_sha256": manifest["asset_sha256"],
        "workflow_fingerprint": manifest["workflow_fingerprint"],
        "profile_id": manifest["profile_id"],
    }


def load_fixed_ui() -> dict[str, Any]:
    manifest = _manifest()
    return _asset().load_json(
        "workflow",
        structure=structure_fingerprint,
        expected_fingerprint=manifest["workflow_fingerprint"],
    )


def load_groups(stage: str) -> dict[str, Any]:
    """Load the per-stage groups.json (title -> node id list)."""
    base = Path(__file__).resolve().parent.parent.parent / "workflow"
    path = base / stage / "groups.json"
    if not path.is_file():
        raise FileNotFoundError(f"groups asset missing: {path}")
    groups = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(groups, dict) or "g1" not in groups or "g2" not in groups:
        raise ValueError(f"groups asset is invalid: {path}")
    return groups
