"""Load and verify the bundled multiview assets.

Fail-closed: any drift raises AssetError. Pure local I/O — no network, no
engine coupling. The invariants checked here:

1. The workflow JSON file exists and its SHA-256 matches EXPECTED_WORKFLOW_SHA256.
2. The manifest is valid JSON; manifest.workflow.sha256 matches the file.
3. manifest.workflow.node_count matches EXPECTED_WORKFLOW_NODE_COUNT.
4. Each of the 13 pose PNGs exists and its SHA-256 matches the manifest.
5. The workflow JSON has the expected node count and every LoadImage node
   (2 user image + 13 pose) carries the expected title and image input.

Call verify_assets() once at the top of any code path that touches the
fixed assets. load_workflow() does not re-check the topology to keep the
hot path fast.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import spec


class AssetError(ValueError):
    """A fixed asset is missing, altered, or its manifest disagrees with the file."""


@dataclass(frozen=True)
class AssetIdentity:
    """Summary of the bundled asset set, for describe() output."""
    workflow_filename: str
    workflow_sha256: str
    workflow_node_count: int
    pose_count: int
    poses: tuple[tuple[str, str], ...]    # (filename, sha256) in numeric order


# --- Internal helpers -------------------------------------------------------

def _sha256(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        raise AssetError(f"fixed asset is unreadable: {path}") from exc


def _load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AssetError(f"fixed asset is invalid JSON: {path}") from exc
    if not isinstance(value, dict) or not value:
        raise AssetError(f"fixed asset must be a non-empty JSON object: {path}")
    return value


def _load_manifest() -> dict[str, Any]:
    return _load_json(spec.manifest_path())


def _node_title(node: dict) -> str:
    meta = node.get("_meta")
    return str(meta.get("title", "")) if isinstance(meta, dict) else ""


def _check_workflow_topology(workflow: dict[str, Any]) -> None:
    """Every user image / pose node is a LoadImage with the expected title and image input."""
    for s in spec.USER_IMAGES:
        node = workflow.get(s.node_id)
        if not isinstance(node, dict) or node.get("class_type") != "LoadImage":
            raise AssetError(
                f"user image node {s.node_id} is missing or not LoadImage"
            )
        title = _node_title(node)
        if title != s.node_title:
            raise AssetError(
                f"user image node {s.node_id} title changed: "
                f"expected {s.node_title!r}, got {title!r}"
            )
        if not isinstance(node.get("inputs", {}).get("image"), str):
            raise AssetError(f"user image node {s.node_id} has no image input")

    for pose in spec.POSES:
        node = workflow.get(pose.node_id)
        if not isinstance(node, dict) or node.get("class_type") != "LoadImage":
            raise AssetError(f"pose node {pose.node_id} is missing or not LoadImage")
        title = _node_title(node)
        if title != pose.title:
            raise AssetError(
                f"pose node {pose.node_id} title changed: "
                f"expected {pose.title!r}, got {title!r}"
            )
        if node["inputs"]["image"] != pose.filename:
            raise AssetError(
                f"pose node {pose.node_id} must reference {pose.filename!r}, "
                f"got {node['inputs']['image']!r}"
            )


# --- Public API -------------------------------------------------------------

def verify_assets() -> AssetIdentity:
    """Run every fail-closed invariant. Raises AssetError on the first failure."""
    wf_path = spec.workflow_path()
    if not wf_path.is_file():
        raise AssetError(f"fixed workflow is missing: {wf_path}")

    actual_wf_hash = _sha256(wf_path)
    if actual_wf_hash != spec.EXPECTED_WORKFLOW_SHA256:
        raise AssetError(
            f"fixed workflow SHA-256 changed: "
            f"expected {spec.EXPECTED_WORKFLOW_SHA256}, got {actual_wf_hash}"
        )

    manifest = _load_manifest()
    manifest_wf = manifest.get("workflow")
    if not isinstance(manifest_wf, dict):
        raise AssetError("manifest.workflow must be an object")
    if manifest_wf.get("sha256") != actual_wf_hash:
        raise AssetError("manifest.workflow.sha256 does not match the file")
    if manifest_wf.get("node_count") != spec.EXPECTED_WORKFLOW_NODE_COUNT:
        raise AssetError(
            f"manifest.workflow.node_count changed: "
            f"expected {spec.EXPECTED_WORKFLOW_NODE_COUNT}, "
            f"got {manifest_wf.get('node_count')}"
        )

    expected_pose_hashes: dict[str, str] = {
        item.get("filename"): item.get("sha256")
        for item in manifest.get("poses", [])
        if isinstance(item, dict)
    }

    pose_records: list[tuple[str, str]] = []
    for pose in spec.POSES:
        path = spec.pose_path(pose.filename)
        if not path.is_file():
            raise AssetError(f"fixed pose asset missing: {path}")
        actual_pose_hash = _sha256(path)
        expected = expected_pose_hashes.get(pose.filename)
        if expected != actual_pose_hash:
            raise AssetError(
                f"fixed pose SHA-256 changed: {pose.filename} "
                f"expected {expected}, got {actual_pose_hash}"
            )
        pose_records.append((pose.filename, actual_pose_hash))

    workflow = _load_json(wf_path)
    if len(workflow) != spec.EXPECTED_WORKFLOW_NODE_COUNT:
        raise AssetError(
            f"workflow node count changed: "
            f"expected {spec.EXPECTED_WORKFLOW_NODE_COUNT}, got {len(workflow)}"
        )
    _check_workflow_topology(workflow)

    return AssetIdentity(
        workflow_filename=spec.WORKFLOW_FILENAME,
        workflow_sha256=actual_wf_hash,
        workflow_node_count=spec.EXPECTED_WORKFLOW_NODE_COUNT,
        pose_count=len(pose_records),
        poses=tuple(pose_records),
    )


def load_workflow() -> dict[str, Any]:
    """Parse the workflow JSON. Caller must have run verify_assets() first.

    The hot path does not re-check titles or hashes — verify_assets() is
    the gate.
    """
    return _load_json(spec.workflow_path())