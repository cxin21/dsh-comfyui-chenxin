"""Load and verify the bundled multiview assets.

Thin adapter over :mod:`chenxin_runtime.fixed_asset` (issue #32). Trust
roots (grilled decision, fail-closed — both must agree):

* **primary**: ``manifest.json`` ships next to the assets;
* **redundant**: the hard-coded ``spec.EXPECTED_WORKFLOW_SHA256`` /
  ``EXPECTED_WORKFLOW_NODE_COUNT`` constants stay as an extra check.

Verified reads hash the exact bytes returned, so ``load_workflow()`` no
longer has a TOCTOU window; topology assertions stay here — they are this
skill's knowledge.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from chenxin_runtime import ArtifactPin, FixedAsset, FixedAssetError

from . import spec


class AssetError(FixedAssetError):
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

def _load_manifest() -> dict[str, Any]:
    try:
        value = json.loads(spec.manifest_path().read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AssetError(f"fixed asset is invalid JSON: {spec.manifest_path()}") from exc
    if not isinstance(value, dict) or not value:
        raise AssetError(f"fixed asset must be a non-empty JSON object: {spec.manifest_path()}")
    return value


def _node_title(node: dict) -> str:
    meta = node.get("_meta")
    return str(meta.get("title", "")) if isinstance(meta, dict) else ""


def _pins(manifest: dict[str, Any]) -> tuple[ArtifactPin, ...]:
    manifest_wf = manifest.get("workflow")
    if not isinstance(manifest_wf, dict):
        raise AssetError("manifest.workflow must be an object")
    # Dual trust root: the spec constant and the manifest must agree.
    if manifest_wf.get("sha256") != spec.EXPECTED_WORKFLOW_SHA256:
        raise AssetError(
            "manifest.workflow.sha256 does not match the spec constant: "
            f"expected {spec.EXPECTED_WORKFLOW_SHA256}, got {manifest_wf.get('sha256')}"
        )
    if manifest_wf.get("node_count") != spec.EXPECTED_WORKFLOW_NODE_COUNT:
        raise AssetError(
            "manifest.workflow.node_count changed: "
            f"expected {spec.EXPECTED_WORKFLOW_NODE_COUNT}, "
            f"got {manifest_wf.get('node_count')}"
        )
    pins = [ArtifactPin("workflow", spec.workflow_path(), spec.EXPECTED_WORKFLOW_SHA256)]
    for item in manifest.get("poses", []):
        if isinstance(item, dict) and isinstance(item.get("filename"), str):
            pins.append(
                ArtifactPin(
                    f"pose:{item['filename']}",
                    spec.pose_path(item["filename"]),
                    str(item.get("sha256", "")),
                )
            )
    return tuple(pins)


def _asset() -> FixedAsset:
    return FixedAsset(_pins(_load_manifest()), label="fixed multiview asset")


def _check_workflow_topology(workflow: dict[str, Any]) -> None:
    """Every user image / pose node is a LoadImage with the expected title and image input."""
    for s in spec.USER_IMAGES:
        node = workflow.get(s.node_id)
        if not isinstance(node, dict) or node.get("class_type") != "LoadImage":
            raise AssetError(f"user image node {s.node_id} is missing or not LoadImage")
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
    manifest = _load_manifest()
    digests = _asset().verify()

    pose_records: list[tuple[str, str]] = []
    for pose in spec.POSES:
        actual_pose_hash = digests.get(f"pose:{pose.filename}")
        if not actual_pose_hash:
            raise AssetError(f"fixed pose asset missing from manifest: {pose.filename}")
        pose_records.append((pose.filename, actual_pose_hash))

    workflow = _asset().load_json("workflow")
    if len(workflow) != spec.EXPECTED_WORKFLOW_NODE_COUNT:
        raise AssetError(
            "workflow node count changed: "
            f"expected {spec.EXPECTED_WORKFLOW_NODE_COUNT}, got {len(workflow)}"
        )
    _check_workflow_topology(workflow)

    return AssetIdentity(
        workflow_filename=spec.WORKFLOW_FILENAME,
        workflow_sha256=digests["workflow"],
        workflow_node_count=spec.EXPECTED_WORKFLOW_NODE_COUNT,
        pose_count=len(pose_records),
        poses=tuple(pose_records),
    )


def load_workflow() -> dict[str, Any]:
    """Verified read + parse of the fixed workflow.

    Hashes the exact bytes it parses (no TOCTOU window) and asserts the
    expected node count; call ``verify_assets()`` additionally when the
    full topology check is required.
    """
    workflow = _asset().load_json("workflow")
    if len(workflow) != spec.EXPECTED_WORKFLOW_NODE_COUNT:
        raise AssetError(
            "workflow node count changed: "
            f"expected {spec.EXPECTED_WORKFLOW_NODE_COUNT}, got {len(workflow)}"
        )
    return workflow
