"""Structural API graph checks owned by camera-video."""

from __future__ import annotations

from typing import Any

from .assets import AssetError, scene_spec


FRONTEND_ONLY_TYPES = {"easy getNode", "easy setNode", "Reroute"}


def validate_api_graph(graph: dict[str, Any], stage: str) -> None:
    """Reject malformed API graphs and dangling references before enqueue."""
    if not isinstance(graph, dict) or not graph:
        raise AssetError("video API graph must be a non-empty object")
    for node_id, node in graph.items():
        if not isinstance(node, dict):
            raise AssetError(f"node {node_id} is not an object")
        class_type = node.get("class_type")
        inputs = node.get("inputs")
        if not isinstance(class_type, str) or not isinstance(inputs, dict):
            raise AssetError(f"node {node_id} is not an API node")
        if class_type in FRONTEND_ONLY_TYPES:
            raise AssetError(f"frontend-only node remains in API graph: {node_id}")
        for key, value in inputs.items():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                if value[0] not in graph:
                    raise AssetError(f"node {node_id}.{key} references missing node {value[0]}")
    spec = scene_spec(stage)
    output_nodes = [
        node for node in graph.values()
        if node.get("class_type") == "VHS_VideoCombine"
    ]
    if not output_nodes:
        raise AssetError(f"video stage has no VHS_VideoCombine output: {stage}")
    for node in output_nodes:
        if node.get("inputs", {}).get("save_output") is not True:
            raise AssetError(f"video output must save files: {stage}")
    if len(graph) != spec["node_count"]:
        raise AssetError(f"video graph node count changed after patching: {stage}")
