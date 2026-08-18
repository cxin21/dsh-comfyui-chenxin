"""Load and verify the three bundled MiniMax H3 API workflows."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


class AssetError(ValueError):
    """Raised when a fixed video workflow is missing or altered."""


ASSET_ROOT = Path(__file__).with_name("workflow_assets")
MANIFEST_PATH = ASSET_ROOT / "manifest.json"
STAGES = ("t2v", "i2v", "multi-i2v")


def _sha256(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        raise AssetError(f"fixed video asset is unreadable: {path}") from exc


def _load_manifest() -> dict[str, Any]:
    try:
        value = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AssetError(f"fixed video manifest is invalid: {MANIFEST_PATH}") from exc
    if not isinstance(value, dict) or not isinstance(value.get("scenes"), dict):
        raise AssetError("fixed video manifest must contain a scenes object")
    return value


def scene_spec(stage: str) -> dict[str, Any]:
    """Return the manifest-owned immutable specification for one stage."""
    if stage not in STAGES:
        raise AssetError(f"unknown camera-video stage: {stage!r}")
    spec = _load_manifest()["scenes"].get(stage)
    if not isinstance(spec, dict):
        raise AssetError(f"manifest has no specification for {stage!r}")
    return spec


def _node(workflow: dict[str, Any], node_id: str, class_type: str, title: str) -> dict[str, Any]:
    value = workflow.get(node_id)
    if not isinstance(value, dict) or value.get("class_type") != class_type:
        raise AssetError(f"node {node_id} must be {class_type}")
    meta = value.get("_meta")
    actual_title = meta.get("title") if isinstance(meta, dict) else None
    if actual_title != title:
        raise AssetError(f"node {node_id} title changed: {actual_title!r}")
    if not isinstance(value.get("inputs"), dict):
        raise AssetError(f"node {node_id} has no API inputs object")
    return value


def load_fixed_workflow(stage: str) -> dict[str, Any]:
    """Load one immutable API graph and verify its configurable node topology."""
    spec = scene_spec(stage)
    path = ASSET_ROOT / str(spec["workflow"])
    if not path.is_file():
        raise AssetError(f"fixed video workflow is missing: {path}")
    actual_hash = _sha256(path)
    if actual_hash != spec.get("sha256"):
        raise AssetError(f"fixed video workflow hash changed for {stage}")
    try:
        workflow = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AssetError(f"fixed API workflow is invalid: {path}") from exc
    if not isinstance(workflow, dict) or len(workflow) != spec.get("node_count"):
        raise AssetError(f"fixed API workflow node count changed for {stage}")
    if any(
        not isinstance(node, dict)
        or not isinstance(node.get("class_type"), str)
        or not isinstance(node.get("inputs"), dict)
        for node in workflow.values()
    ):
        raise AssetError(f"fixed API workflow contains an invalid node: {stage}")

    prompt = _node(workflow, str(spec["prompt_node"]), "PrimitiveStringMultiline", "Input Text (Prompt)")
    if not isinstance(prompt["inputs"].get("value"), str):
        raise AssetError(f"prompt node is missing its value input: {stage}")
    duration = _node(workflow, str(spec["duration_node"]), "PrimitiveFloat", "Float (Duration)")
    if not isinstance(duration["inputs"].get("value"), (int, float)):
        raise AssetError(f"duration node is missing its value input: {stage}")
    for node_id in spec.get("image_nodes", []):
        image = _node(workflow, str(node_id), "LoadImage", "加载图像")
        if not isinstance(image["inputs"].get("image"), str):
            raise AssetError(f"image node has no image input: {stage}/{node_id}")
    return workflow
