"""Preset table: a shortcut for the most common camera + image_size pairs.

When the user sets ``preset`` in the request, the corresponding ``camera``
and ``image_size`` slots are filled in only if the user didn't also set them
explicitly. The user can always override the preset.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from .config import (
    Camera,
    CameraDistance,
    CameraDirection,
    CameraElevation,
    ImageSize,
    RunConfig,
)


@dataclass(frozen=True)
class Preset:
    name: str
    width: int
    height: int
    direction: CameraDirection
    elevation: CameraElevation
    distance: CameraDistance
    description: str


PRESETS: dict[str, Preset] = {
    preset.name: preset
    for preset in (
        Preset("portrait_full_body", 832, 1216, "front", "eye-level", "full_body",
               "full-body, eye-level, center"),
        Preset("portrait_closeup", 832, 1216, "front", "eye-level", "close_up",
               "bust, eye-level, center"),
        Preset("squarish_cowboy", 1024, 1024, "front", "eye-level", "cowboy_shot",
               "cowboy shot, eye-level, center"),
        Preset("landscape_wide", 1280, 720, "front", "eye-level", "wide",
               "eye-level, wide"),
    )
}


def preset_table() -> list[dict[str, object]]:
    return [
        {"preset": preset.name, "size": f"{preset.width}x{preset.height}",
         "camera": preset.description}
        for preset in PRESETS.values()
    ]


def apply_preset(config: RunConfig) -> RunConfig:
    """Expand ``preset`` into camera/image_size unless the user set them."""
    if config.preset is None:
        return config
    if config.preset not in PRESETS:
        raise ValueError(
            f"unknown preset {config.preset!r}; valid presets: {sorted(PRESETS)}"
        )
    preset = PRESETS[config.preset]
    overrides: dict[str, object] = {}
    if config.camera is None:
        overrides["camera"] = Camera(
            direction=preset.direction,
            elevation=preset.elevation,
            distance=preset.distance,
        )
    if config.image_size is None:
        overrides["image_size"] = ImageSize(width=preset.width, height=preset.height)
    if overrides:
        config = replace(config, **overrides)
    return config
