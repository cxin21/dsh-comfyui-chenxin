"""Build the patched API graph from the fixed workflow.

Pure transformation: takes the loaded workflow dict and two name dicts
({config_key: uploaded_filename} for user images, {pose_filename: uploaded_filename}
for poses) and returns a deep-copied workflow with the 15 image inputs
written. Touches nothing else.

Failure modes (raise ValueError):
- Missing user image upload (a config_key from spec.USER_IMAGES has no entry).
- Missing pose upload (a pose filename from spec.POSES has no entry).
"""
from __future__ import annotations

import copy
from typing import Any

from . import spec


def build_graph(
    *,
    workflow: dict[str, Any],
    user_image_names: dict[str, str],     # {config_key: uploaded_filename}
    pose_names: dict[str, str],            # {pose_filename: uploaded_filename}
) -> dict[str, Any]:
    """Deep-copy the workflow and write the 15 image inputs."""
    missing_user = [s.config_key for s in spec.USER_IMAGES if s.config_key not in user_image_names]
    if missing_user:
        raise ValueError(f"missing user image uploads: {missing_user}")
    missing_pose = [p.filename for p in spec.POSES if p.filename not in pose_names]
    if missing_pose:
        raise ValueError(f"missing pose uploads: {missing_pose}")

    graph = copy.deepcopy(workflow)
    for s in spec.USER_IMAGES:
        graph[s.node_id]["inputs"]["image"] = user_image_names[s.config_key]
    for p in spec.POSES:
        graph[p.node_id]["inputs"]["image"] = pose_names[p.filename]
    return graph