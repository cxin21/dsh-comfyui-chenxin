"""Configuration dataclasses for camera-image.

Every dataclass corresponds to a single Anima UI asset slot. The mapping
from dataclass field to UI widget index lives in ``graph.py``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


CameraDirection = Literal["front", "right_45", "right", "right_135", "rear_45", "rear",
                     "left_45", "left", "left_135"]
CameraElevation = Literal["high", "eye-level", "low"]
CameraDistance = Literal["extreme_close_up", "close_up", "medium", "cowboy_shot",
                     "full_body", "wide"]
Sampler = Literal[
    "euler", "euler_ancestral", "heun", "heunpp2", "dpmpp_2m", "dpmpp_2m_sde",
    "dpmpp_2m_sde_heun", "dpmpp_2m_sde_heun_pp", "dpmpp_3m_sde", "dpmpp_3m_sde_heun",
    "dpmpp_3m_sde_heun_pp", "er_sde", "er_sde_heun", "er_sde_heun_pp",
    "ddim", "ddim_uniform", "uni_pc", "uni_pc_bh2", "lms",
    "euler_cfg_pp", "euler_dynamic", "heunpp2_dynamic",
]
Scheduler = Literal["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta"]


@dataclass(frozen=True)
class Camera:
    """Maps to node 583 (CameraAngleNode)."""

    direction: CameraDirection | None = None
    elevation: CameraElevation | None = None
    distance: CameraDistance | None = None
    roll: float | None = None


@dataclass(frozen=True)
class CameraExtra:
    """Maps to node 585 (CameraExtraConfigNode). 13 widgets, 1:1 with inputs."""

    extreme_type: str = "无"
    extreme_weight: float = 10.0
    lens_enabled: bool = True
    lens_value: str = "85mm lens"
    dof_enabled: bool = False
    dof_value: str = "shallow depth of field"
    dof_weight: float = 1.3
    movement_enabled: bool = False
    movement_value: str = "handheld camera"
    composition_enabled: bool = True
    composition_value: str = "rule of thirds"
    style_enabled: bool = False
    style_value: str = "cinematic"


@dataclass(frozen=True)
class Sampling:
    """Maps to node 50 (Input Parameters / first pass) and node 51 (refine KSampler).

    Node 50 is ``Input Parameters (Image Saver)``, a parameter provider
    whose outputs feed KSampler 27 (first pass) via links. Node 51 is the
    refine KSampler. ``cfg``, ``sampler``, and ``scheduler`` apply to node
    50 only; the refine pass inherits its own baked values for those slots.
    """

    steps_first: int | None = None
    cfg: float | None = None
    sampler: Sampler | None = None
    scheduler: Scheduler | None = None
    denoise_first: float | None = None
    steps_refine: int | None = None
    denoise_refine: float | None = None


@dataclass(frozen=True)
class ImageSize:
    """Maps to nodes 68/71 (width/height)."""

    width: int | None = None
    height: int | None = None


@dataclass(frozen=True)
class LoraSelection:
    name: str
    strength_model: float = 1.0
    strength_clip: float | None = None
    active: bool = True
    trigger_words: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Lora:
    selections: tuple[LoraSelection, ...] = ()


@dataclass(frozen=True)
class Groups:
    g1: tuple[str, ...] = ()
    g2: tuple[str, ...] = ()


@dataclass(frozen=True)
class Prompt:
    """Maps to node 24 (positive ImpactWildcardProcessor)."""

    positive: str
    negative: str = ""


@dataclass(frozen=True)
class RunConfig:
    """Single flat configuration object consumed by ``graph.patch_ui``.

    Fields mirror the camera-image's full configuration surface, in the
    same shape the old implementation accepted (envelope + config collapsed
    into one object). All fields except those marked required are optional.
    """

    prompt: Prompt
    evidence: dict = field(default_factory=dict)
    profile_id: str = ""
    camera: Camera | None = None
    camera_extra: CameraExtra | None = None
    lora: Lora | None = None
    groups: Groups | None = None
    sampling: Sampling | None = None
    seed: int | None = None
    image_size: ImageSize | None = None
    reference_image: Path | None = None
    controlnet_image: Path | None = None
    red_prompt: str | None = None
    green_prompt: str | None = None
    blue_prompt: str | None = None
    red_image: Path | None = None
    green_image: Path | None = None
    blue_image: Path | None = None
    signature_image: Path | None = None
    preset: str | None = None


# Convenience: list every optional field's source name (used by ``request.py``).
IMAGE_FIELDS = (
    "reference_image",
    "controlnet_image",
    "red_image",
    "green_image",
    "blue_image",
    "signature_image",
)
TEXT_FIELDS = (
    "red_prompt",
    "green_prompt",
    "blue_prompt",
)
DATACLASS_FIELDS = (
    "camera",
    "camera_extra",
    "lora",
    "groups",
    "sampling",
    "image_size",
)
SCALAR_FIELDS = ("seed", "preset", "profile_id", "evidence")
