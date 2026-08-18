"""Structural validation of the API graph produced by comfyui-mcp strip."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


OUTPUT_CLASS_TYPES = frozenset({"Image Saver Simple", "PreviewImage"})


def validate_api_graph(graph: Mapping[str, Any]) -> None:
    if not isinstance(graph, Mapping) or not graph:
        raise ValueError("compiled API graph must be a non-empty mapping")

    node_ids = {str(node_id) for node_id in graph}
    output_nodes: list[str] = []

    for node_id, node in graph.items():
        label = str(node_id)
        if not isinstance(node, Mapping):
            raise ValueError(f"node {label} is not an object")
        class_type = node.get("class_type")
        if not isinstance(class_type, str) or not class_type:
            raise ValueError(f"node {label} has no class_type")
        inputs = node.get("inputs")
        if not isinstance(inputs, Mapping):
            raise ValueError(f"node {label} has no API inputs object")

        if class_type in OUTPUT_CLASS_TYPES:
            output_nodes.append(label)
            if "images" not in inputs:
                raise ValueError(f"output node {label} has no images input")
            if not _is_link(inputs["images"]):
                raise ValueError(
                    f"output node {label} images input is not a link"
                )

        for input_name, value in inputs.items():
            if not _is_link(value):
                continue
            target_id = str(value[0])
            if target_id not in node_ids:
                raise ValueError(
                    f"node {label} input {input_name!r} has dangling input reference "
                    f"to node {target_id}"
                )

    if not output_nodes:
        raise ValueError("compiled API graph has no image output node")


def _is_link(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) == 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], int)
    )
