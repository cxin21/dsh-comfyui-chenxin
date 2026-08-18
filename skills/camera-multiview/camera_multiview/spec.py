"""Immutable contract for the Flux2-Klein multiview skill.

The single source of truth for: stage name, workflow filename, expected
SHA-256, node counts, user image node mapping, pose node mapping, and
asset paths. Every other module imports from here; nothing else owns these
constants. Drift in this file means the bundled asset has been republished
and the workflow JSON + manifests + pose PNGs must be updated together.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


# --- Stage + workflow identity ----------------------------------------------

STAGE = "multiview"

WORKFLOW_FILENAME = "Flux2-Klein人物一键多视图工作流.json"
EXPECTED_WORKFLOW_SHA256 = "33584a54b6587914fce078cdcddbab7915e7d834ca741ded06a44a3ba484252e"
EXPECTED_WORKFLOW_NODE_COUNT = 261

POSE_COUNT = 13
POSE_DIRNAME = "pose"


# --- Node mappings ----------------------------------------------------------

@dataclass(frozen=True)
class UserImageSpec:
    """One user-uploaded image input in the fixed workflow."""
    config_key: str       # key in the user request envelope
    node_id: str          # node ID in the fixed workflow JSON
    node_title: str       # the title the workflow's _meta must carry


USER_IMAGES: tuple[UserImageSpec, ...] = (
    UserImageSpec("full_body_image", "111", "加载图像（人物全身）"),
    UserImageSpec("face_image",       "667", "加载图像（人物面部）"),
)


@dataclass(frozen=True)
class PoseSpec:
    """One fixed pose skeleton asset in the bundled workflow."""
    index: int            # 1..POSE_COUNT
    node_id: str          # node ID in the fixed workflow JSON
    title: str            # the title the workflow's _meta must carry
    filename: str         # PNG filename in workflow_assets/pose/


# Node IDs and titles derived from the workflow JSON's _meta.
POSES: tuple[PoseSpec, ...] = tuple(
    PoseSpec(
        index=index,
        node_id=node_id,
        title=f"姿势骨架{index}",
        filename=f"姿势骨架{index}.png",
    )
    for index, node_id in enumerate((
        "152", "154", "360", "364", "148", "149",
        "147", "373", "150", "367", "368", "151", "757",
    ), start=1)
)


# --- Asset paths ------------------------------------------------------------

def asset_root() -> Path:
    """Directory containing the workflow JSON, manifest, and pose assets."""
    return Path(__file__).parent / "runtime" / "workflow_assets"


def workflow_path() -> Path:
    return asset_root() / WORKFLOW_FILENAME


def manifest_path() -> Path:
    return asset_root() / "manifest.json"


def pose_path(filename: str) -> Path:
    return asset_root() / POSE_DIRNAME / filename


def all_pose_paths() -> tuple[Path, ...]:
    """Returns pose paths in numeric order (1..POSE_COUNT)."""
    return tuple(pose_path(p.filename) for p in POSES)


# --- Lookups ---------------------------------------------------------------

def user_image_node(config_key: str) -> str:
    for s in USER_IMAGES:
        if s.config_key == config_key:
            return s.node_id
    raise KeyError(f"unknown user image config_key: {config_key}")


def user_image_spec(config_key: str) -> UserImageSpec:
    for s in USER_IMAGES:
        if s.config_key == config_key:
            return s
    raise KeyError(f"unknown user image config_key: {config_key}")


def pose_by_filename(filename: str) -> PoseSpec:
    for p in POSES:
        if p.filename == filename:
            return p
    raise KeyError(f"unknown pose filename: {filename}")


def pose_by_node_id(node_id: str) -> PoseSpec:
    for p in POSES:
        if p.node_id == node_id:
            return p
    raise KeyError(f"unknown pose node_id: {node_id}")