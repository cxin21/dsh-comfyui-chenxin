"""Build the video API graph from the fixed bundled asset for one stage.

The bundled asset is the only execution source. Exactly three kinds of
inputs are written into a deep copy:

* the prompt node (``PrimitiveStringMultiline``),
* the duration node (``PrimitiveFloat``),
* the stage's ordered LoadImage nodes — one per uploaded reference.

The local structural contract is verified before the graph leaves the
process.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .assets import load_fixed_workflow, scene_spec
from .contracts import validate_api_graph


def build_graph(
    *,
    stage: str,
    prompt: str,
    duration: float,
    reference_names: tuple[str, ...],
) -> dict[str, Any]:
    spec = scene_spec(stage)
    graph = deepcopy(load_fixed_workflow(stage))
    graph[str(spec["prompt_node"])]["inputs"]["value"] = prompt
    graph[str(spec["duration_node"])]["inputs"]["value"] = duration
    image_nodes = [str(node_id) for node_id in spec.get("image_nodes", [])]
    if len(image_nodes) != len(reference_names):
        raise ValueError(
            f"stage {stage} expects {len(image_nodes)} reference images, "
            f"got {len(reference_names)}"
        )
    for node_id, name in zip(image_nodes, reference_names):
        node = graph.get(node_id)
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            raise ValueError(f"reference image node {node_id} is missing: {stage}")
        node["inputs"]["image"] = name
    validate_api_graph(graph, stage)
    return graph
