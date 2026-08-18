"""Camera mapping: semantic direction/elevation/distance -> node 583 floats.

The CameraAngleNode (node 583) accepts pos_x/pos_y/pos_z as floats in [-1, 1].
Verified against the bundled asset.
"""

from __future__ import annotations

from .config import (
    CameraDirection,
    CameraDistance,
    CameraElevation,
)


DIRECTION_X: dict[str, float] = {
    "front": 0.0,
    "right_45": 0.25,
    "right": 0.5,
    "right_135": 0.75,
    "rear_45": 0.75,
    "rear": 1.0,
    "left_45": -0.25,
    "left": -0.5,
    "left_135": -0.75,
}

ELEVATION_Y: dict[str, float] = {
    "high": 0.5,
    "eye-level": 0.0,
    "low": -0.5,
}

DISTANCE_Z: dict[str, float] = {
    "extreme_close_up": 0.9,
    "close_up": 0.5,
    "medium": 0.1,
    "cowboy_shot": -0.2,
    "full_body": -0.5,
    "wide": -0.9,
}


def camera_coords(
    direction: CameraDirection,
    elevation: CameraElevation,
    distance: CameraDistance,
    roll: float = 0.0,
) -> tuple[float, float, float, float]:
    if direction not in DIRECTION_X:
        raise ValueError(f"unknown camera direction: {direction!r}")
    if elevation not in ELEVATION_Y:
        raise ValueError(f"unknown camera elevation: {elevation!r}")
    if distance not in DISTANCE_Z:
        raise ValueError(f"unknown camera distance: {distance!r}")
    if not 0.0 <= roll <= 1.0:
        raise ValueError(f"camera roll must be in [0, 1], got {roll}")
    return DIRECTION_X[direction], ELEVATION_Y[elevation], DISTANCE_Z[distance], roll
