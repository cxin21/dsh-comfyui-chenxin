"""Load and verify the fixed Anima UI asset against its manifest."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from chenxin_runtime import canonical_json, content_hash


class WorkflowAssetError(ValueError):
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


def asset_identity() -> dict[str, Any]:
    manifest = _manifest()
    return {
        "asset": manifest["asset"],
        "asset_sha256": manifest["asset_sha256"],
        "workflow_fingerprint": manifest["workflow_fingerprint"],
        "profile_id": manifest["profile_id"],
    }


def _require_workflow_nodes(workflow: object) -> list[dict]:
    if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), list):
        raise WorkflowAssetError("workflow requires a nodes list")
    nodes = workflow["nodes"]
    seen_ids: set[int] = set()
    for node in nodes:
        if not isinstance(node, dict):
            raise WorkflowAssetError("workflow nodes must be objects")
        node_id = node.get("id")
        if not isinstance(node_id, int) or isinstance(node_id, bool):
            raise WorkflowAssetError("workflow nodes require integer ids")
        if node_id in seen_ids:
            raise WorkflowAssetError(f"workflow node id {node_id} is ambiguous")
        seen_ids.add(node_id)
    return nodes


def structure_fingerprint(workflow: dict) -> str:
    """Stable identity hash: nodes + links + groups, excluding widget state."""
    nodes = [
        {
            "id": node["id"],
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
        for node in _require_workflow_nodes(workflow)
    ]
    groups = [
        {"id": group.get("id"), "title": group.get("title", "")}
        for group in workflow.get("groups", [])
    ]
    payload = {
        "nodes": sorted(nodes, key=lambda item: str(item["id"])),
        "groups": sorted(groups, key=lambda item: str(item["id"])),
        "links": sorted(workflow.get("links", []), key=canonical_json),
    }
    return content_hash(payload)


def load_fixed_ui() -> dict[str, Any]:
    manifest = _manifest()
    asset_name = manifest["asset"]
    path = (ASSET_ROOT / asset_name).resolve()
    if not path.is_file() or not path.is_relative_to(ASSET_ROOT.resolve()):
        raise WorkflowAssetError(f"fixed workflow asset is missing: {asset_name}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != manifest["asset_sha256"]:
        raise WorkflowAssetError(f"fixed workflow asset hash mismatch: {asset_name}")
    try:
        workflow = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise WorkflowAssetError(f"fixed workflow asset is invalid JSON: {asset_name}") from exc
    if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), list):
        raise WorkflowAssetError("fixed workflow asset is not a ComfyUI UI workflow")
    if structure_fingerprint(workflow) != manifest["workflow_fingerprint"]:
        raise WorkflowAssetError("fixed workflow structure fingerprint mismatch")
    return workflow


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
