"""Fixed-asset pinning — one deep module for every bundled, hash-pinned asset.

Virgin-principle source (issue #32): replaces three divergent trust roots
that lived in the skills:

* camera-image pinned via ``manifest.json`` (asset_policy + asset_sha256 +
  workflow_fingerprint), re-hashing on every load.
* camera-video pinned via per-stage ``manifest.scenes[stage].sha256``.
* camera-multiview pinned via a hard-coded SHA-256 in ``spec.py`` — with a
  ``load_workflow`` that explicitly did NOT re-verify (TOCTOU gap).

Trust-root decision (grilled, 2026-10-25): the **manifest is the primary
trust root** (it ships next to the assets, so republishing never touches
code). Where a skill also hard-codes an expected hash (multiview
``spec.py``), that constant becomes an *additional redundant check* — both
must agree, fail-closed.

Interface::

    pin = FixedAsset([ArtifactPin(name, path, sha256), ...], label=...)
    pin.verify()            -> {name: sha256}   (hash everything, fail-closed)
    pin.load_json(name)     -> dict             (read once → hash → parse the
                                                 SAME bytes; no TOCTOU window)
    structure_fingerprint(wf) -> str            (generic UI-graph identity hash)

Skill adapters keep their own names (``WorkflowAssetError`` /
``AssetError``) by subclassing :class:`FixedAssetError`, so existing CLI
error-handler tables and envelope codes stay untouched.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .workflow_hashes import canonical_json, content_hash

__all__ = [
    "ArtifactPin",
    "FixedAsset",
    "FixedAssetError",
    "structure_fingerprint",
]


class FixedAssetError(ValueError):
    """A fixed asset is missing, altered, or its manifest disagrees."""


@dataclass(frozen=True)
class ArtifactPin:
    """One hash-pinned file: logical name, on-disk path, expected SHA-256."""

    name: str
    path: Path
    sha256: str


def structure_fingerprint(workflow: dict) -> str:
    """Stable identity hash of a ComfyUI *UI* workflow.

    Nodes + links + groups, excluding widget state (widget values are the
    caller's business; structure is the asset's identity).
    """
    nodes_raw = workflow.get("nodes")
    if not isinstance(nodes_raw, list):
        raise FixedAssetError("workflow requires a nodes list")
    seen_ids: set[int] = set()
    nodes = []
    for node in nodes_raw:
        if not isinstance(node, dict):
            raise FixedAssetError("workflow nodes must be objects")
        node_id = node.get("id")
        if not isinstance(node_id, int) or isinstance(node_id, bool):
            raise FixedAssetError("workflow nodes require integer ids")
        if node_id in seen_ids:
            raise FixedAssetError(f"workflow node id {node_id} is ambiguous")
        seen_ids.add(node_id)
        nodes.append(
            {
                "id": node_id,
                "type": node.get("type", ""),
                "title": node.get("title", ""),
                "inputs": [
                    {"name": item.get("name"), "type": item.get("type"), "link": item.get("link")}
                    for item in node.get("inputs", [])
                ],
                "outputs": [
                    {"name": item.get("name"), "type": item.get("type"), "links": item.get("links") or []}
                    for item in node.get("outputs", [])
                ],
            }
        )
    groups = [
        {"id": group.get("id"), "title": group.get("title", "")}
        for group in workflow.get("groups", [])
        if isinstance(group, dict)
    ]
    links = workflow.get("links", [])
    payload = {
        "nodes": sorted(nodes, key=lambda item: str(item["id"])),
        "groups": sorted(groups, key=lambda item: str(item["id"])),
        "links": sorted(links, key=canonical_json) if isinstance(links, list) else links,
    }
    return content_hash(payload)


class FixedAsset:
    """A set of hash-pinned files with fail-closed verified reads."""

    def __init__(
        self,
        pins: Iterable[ArtifactPin],
        *,
        label: str = "fixed asset",
    ) -> None:
        pins = tuple(pins)
        if not pins:
            raise ValueError("FixedAsset requires at least one ArtifactPin")
        seen: set[str] = set()
        for pin in pins:
            if pin.name in seen:
                raise ValueError(f"duplicate ArtifactPin name: {pin.name!r}")
            seen.add(pin.name)
        self._pins = pins
        self._label = label

    # -- verified reads ----------------------------------------------------

    def _read_verified(self, pin: ArtifactPin) -> bytes:
        """Read a pinned file once and hash those exact bytes.

        The hash covers the bytes returned, so a file swapped between the
        read and the parse cannot slip through — there is no TOCTOU window
        by construction.
        """
        try:
            data = pin.path.read_bytes()
        except OSError as exc:
            raise FixedAssetError(f"{self._label} is unreadable: {pin.path}") from exc
        digest = hashlib.sha256(data).hexdigest()
        if digest != pin.sha256:
            raise FixedAssetError(
                f"{self._label} hash changed: {pin.name} "
                f"expected {pin.sha256}, got {digest}"
            )
        return data

    def pin(self, name: str) -> ArtifactPin:
        for pin in self._pins:
            if pin.name == name:
                return pin
        raise KeyError(f"unknown artifact pin: {name!r}")

    def verify(self) -> dict[str, str]:
        """Hash every pin; return ``{name: actual_sha256}`` or raise."""
        return {pin.name: hashlib.sha256(self._read_verified(pin)).hexdigest() for pin in self._pins}

    def load_json(
        self,
        name: str,
        *,
        structure: Callable[[dict], str] | None = None,
        expected_fingerprint: str | None = None,
    ) -> dict[str, Any]:
        """Verified read + JSON parse of one pinned file.

        ``structure`` + ``expected_fingerprint`` optionally assert the
        parsed graph's structural identity (widget changes pass, node /
        link changes fail).
        """
        pin = self.pin(name)
        data = self._read_verified(pin)
        try:
            value = json.loads(data.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise FixedAssetError(
                f"{self._label} is invalid JSON: {pin.name} ({exc})"
            ) from exc
        if not isinstance(value, dict) or not value:
            raise FixedAssetError(
                f"{self._label} must be a non-empty JSON object: {pin.name}"
            )
        if structure is not None:
            if expected_fingerprint is None:
                raise ValueError("structure requires expected_fingerprint")
            actual = structure(value)
            if actual != expected_fingerprint:
                raise FixedAssetError(
                    f"{self._label} structure fingerprint mismatch: {pin.name} "
                    f"expected {expected_fingerprint}, got {actual}"
                )
        return value
