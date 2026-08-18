"""Structural + binding contracts for the patched API graph.

Pure local checks. No network, no I/O.

Two independent checks:

- validate_graph(graph): the graph is well-formed.
  - Non-empty mapping.
  - Every node has class_type (string) and inputs (mapping).
  - No frontend-only class (easy getNode, easy setNode, Reroute).
  - Every input that is a link [node_id, slot] resolves to an existing node.
  - Every SaveImage / PreviewImage has an images link.
  - The graph has at least one image output.

- validate_bindings(graph, *, user_image_names, pose_names): every patched
  image input references a name that was actually uploaded. This is the
  contract that catches "we forgot to thread an upload result into the
  graph" — without it the graph would be structurally valid but point at
  filenames that don't exist on ComfyUI.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from . import spec


_FRONTEND_ONLY_CLASSES = frozenset({"easy getNode", "easy setNode", "Reroute"})
_IMAGE_OUTPUT_CLASSES = frozenset({"SaveImage", "PreviewImage"})


def _is_link(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) == 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], int)
    )


def validate_graph(graph: Mapping[str, Any]) -> None:
    """Reject an incomplete or tampered graph before it reaches ComfyUI."""
    if not isinstance(graph, Mapping) or not graph:
        raise ValueError("multiview API graph must be a non-empty mapping")

    node_ids = {str(node_id) for node_id in graph}
    output_count = 0

    for node_id, node in graph.items():
        label = str(node_id)
        if not isinstance(node, Mapping):
            raise ValueError(f"node {label} is not an object")

        class_type = node.get("class_type")
        inputs = node.get("inputs")
        if not isinstance(class_type, str) or not class_type:
            raise ValueError(f"node {label} has no class_type")
        if not isinstance(inputs, Mapping):
            raise ValueError(f"node {label} has no inputs object")

        if class_type in _FRONTEND_ONLY_CLASSES:
            raise ValueError(
                f"frontend-only node {label} ({class_type}) reached API graph"
            )

        if class_type in _IMAGE_OUTPUT_CLASSES:
            output_count += 1
            if not _is_link(inputs.get("images")):
                raise ValueError(f"output node {label} has no images link")

        for input_name, value in inputs.items():
            if _is_link(value) and str(value[0]) not in node_ids:
                raise ValueError(
                    f"node {label} input {input_name!r} references missing node {value[0]}"
                )

    if output_count == 0:
        raise ValueError("multiview API graph has no image output")


def validate_bindings(
    graph: Mapping[str, Any],
    *,
    user_image_names: dict[str, str],
    pose_names: dict[str, str],
) -> None:
    """Each patched image input must reference a name we actually uploaded."""
    for s in spec.USER_IMAGES:
        node = graph.get(s.node_id)
        if not isinstance(node, Mapping):
            raise ValueError(f"user image node {s.node_id} is missing")
        image = node.get("inputs", {}).get("image")
        expected = user_image_names.get(s.config_key)
        if image != expected:
            raise ValueError(
                f"user image node {s.node_id} image {image!r} does not match "
                f"uploaded name {expected!r}"
            )
    for p in spec.POSES:
        node = graph.get(p.node_id)
        if not isinstance(node, Mapping):
            raise ValueError(f"pose node {p.node_id} is missing")
        image = node.get("inputs", {}).get("image")
        expected = pose_names.get(p.filename)
        if image != expected:
            raise ValueError(
                f"pose node {p.node_id} image {image!r} does not match "
                f"uploaded name {expected!r}"
            )