"""Parse the user-facing request JSON into a typed RunConfig."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import (
    Camera,
    CameraExtra,
    Groups,
    IMAGE_FIELDS,
    ImageSize,
    Lora,
    LoraSelection,
    Prompt,
    RunConfig,
    Sampling,
    TEXT_FIELDS,
)


STAGES = ("t2i", "i2i")
ALLOWED_FIELDS = (
    "prompt",
    "evidence",
    "profile_id",
    "camera",
    "camera_extra",
    "lora",
    "groups",
    "sampling",
    "seed",
    "image_size",
    "reference_image",
    "controlnet_image",
    "red_prompt",
    "green_prompt",
    "blue_prompt",
    "red_image",
    "green_image",
    "blue_image",
    "signature_image",
    "preset",
)


def example_request(profile_id: str) -> dict[str, Any]:
    """Return the canonical example request, anchored to the manifest's profile_id."""
    return {
        "prompt": {
            "positive": "score_9, score_8_up, 1girl, anime portrait, cinematic lighting",
            "negative": "low quality, bad anatomy",
        },
        "evidence": {},
        "profile_id": profile_id,
        "preset": "portrait_full_body",
        "seed": 20260214,
    }


def _string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TypeError(f"{field} must be a non-empty string")
    return value.strip()


def _path(value: Any, field: str) -> Path:
    text = _string(value, field)
    return Path(text)


def _coerce_prompt(raw: Any) -> Prompt:
    if not isinstance(raw, dict):
        raise TypeError("request field 'prompt' must be an object")
    unknown = sorted(set(raw) - {"positive", "negative"})
    if unknown:
        raise TypeError(f"prompt has unsupported field(s): {unknown}")
    if "positive" not in raw:
        raise ValueError("request field 'prompt.positive' is required")
    positive = _string(raw["positive"], "prompt.positive")
    negative = ""
    if raw.get("negative") is not None:
        negative = _string(raw["negative"], "prompt.negative")
    return Prompt(positive=positive, negative=negative)


def _coerce_camera(raw: Any) -> Camera:
    if not isinstance(raw, dict):
        raise TypeError("camera must be an object")
    return Camera(
        direction=raw.get("direction"),
        elevation=raw.get("elevation"),
        distance=raw.get("distance"),
        roll=raw.get("roll"),
    )


def _coerce_camera_extra(raw: Any) -> CameraExtra:
    if not isinstance(raw, dict):
        raise TypeError("camera_extra must be an object")
    return CameraExtra(
        extreme_type=raw.get("extreme_type", "无"),
        extreme_weight=_number(raw.get("extreme_weight", 10.0), "camera_extra.extreme_weight"),
        lens_enabled=_bool(raw.get("lens_enabled", True), "camera_extra.lens_enabled"),
        lens_value=_string(raw.get("lens_value", "85mm lens"), "camera_extra.lens_value"),
        dof_enabled=_bool(raw.get("dof_enabled", False), "camera_extra.dof_enabled"),
        dof_value=_string(raw.get("dof_value", "shallow depth of field"),
                         "camera_extra.dof_value"),
        dof_weight=_number(raw.get("dof_weight", 1.3), "camera_extra.dof_weight"),
        movement_enabled=_bool(raw.get("movement_enabled", False), "camera_extra.movement_enabled"),
        movement_value=_string(raw.get("movement_value", "handheld camera"),
                              "camera_extra.movement_value"),
        composition_enabled=_bool(raw.get("composition_enabled", True),
                                  "camera_extra.composition_enabled"),
        composition_value=_string(raw.get("composition_value", "rule of thirds"),
                                   "camera_extra.composition_value"),
        style_enabled=_bool(raw.get("style_enabled", False), "camera_extra.style_enabled"),
        style_value=_string(raw.get("style_value", "cinematic"), "camera_extra.style_value"),
    )


def _coerce_sampling(raw: Any) -> Sampling:
    if not isinstance(raw, dict):
        raise TypeError("sampling must be an object")
    return Sampling(
        steps_first=_int(raw.get("steps_first"), "sampling.steps_first"),
        cfg=_number(raw.get("cfg"), "sampling.cfg"),
        sampler=raw.get("sampler"),
        scheduler=raw.get("scheduler"),
        denoise_first=_number(raw.get("denoise_first"), "sampling.denoise_first"),
        steps_refine=_int(raw.get("steps_refine"), "sampling.steps_refine"),
        denoise_refine=_number(raw.get("denoise_refine"), "sampling.denoise_refine"),
    )


def _coerce_image_size(raw: Any) -> ImageSize:
    if not isinstance(raw, dict):
        raise TypeError("image_size must be an object")
    return ImageSize(
        width=_int(raw.get("width"), "image_size.width"),
        height=_int(raw.get("height"), "image_size.height"),
    )


def _coerce_lora(raw: Any) -> Lora:
    if not isinstance(raw, dict):
        raise TypeError("lora must be an object")
    raw_sel = raw.get("selections")
    if raw_sel is None:
        return Lora()
    if not isinstance(raw_sel, list):
        raise TypeError("lora.selections must be an array")
    selections: list[LoraSelection] = []
    for index, item in enumerate(raw_sel):
        if not isinstance(item, dict):
            raise TypeError(f"lora.selections[{index}] must be an object")
        unknown = sorted(set(item) - {"name", "strength_model", "strength_clip", "active", "trigger_words"})
        if unknown:
            raise TypeError(f"lora.selections[{index}] has unsupported field(s): {unknown}")
        if "name" not in item:
            raise ValueError(f"lora.selections[{index}] missing required field 'name'")
        name = _string(item["name"], f"lora.selections[{index}].name")
        if not name.strip():
            raise ValueError(f"lora.selections[{index}].name must be non-empty")
        strength_model = float(item.get("strength_model", 1.0))
        strength_clip = item.get("strength_clip")
        if strength_clip is not None:
            strength_clip = float(strength_clip)
        active = bool(item.get("active", True))
        trigger_words = item.get("trigger_words", [])
        if not isinstance(trigger_words, list) or any(
            not isinstance(w, str) for w in trigger_words
        ):
            raise TypeError(
                f"lora.selections[{index}].trigger_words must be a list of strings"
            )
        selections.append(LoraSelection(
            name=name,
            strength_model=strength_model,
            strength_clip=strength_clip,
            active=active,
            trigger_words=list(trigger_words),
        ))
    return Lora(selections=tuple(selections))


def _coerce_groups(raw: Any) -> Groups:
    if not isinstance(raw, dict):
        raise TypeError("groups must be an object")
    unknown = sorted(set(raw) - {"g1", "g2"})
    if unknown:
        raise TypeError(f"groups has unsupported key(s): {unknown}")
    g1 = raw.get("g1", [])
    g2 = raw.get("g2", [])
    if not isinstance(g1, list):
        raise TypeError("groups.g1 must be an array")
    if not isinstance(g2, list):
        raise TypeError("groups.g2 must be an array")
    for index, title in enumerate(g1):
        if not isinstance(title, str) or not title.strip():
            raise TypeError(f"groups.g1[{index}] must be a non-empty string")
    for index, title in enumerate(g2):
        if not isinstance(title, str) or not title.strip():
            raise TypeError(f"groups.g2[{index}] must be a non-empty string")
    return Groups(g1=tuple(str(t).strip() for t in g1), g2=tuple(str(t).strip() for t in g2))


def _number(value: Any, field: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{field} must be a number")
    return float(value)


def _int(value: Any, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field} must be an integer")
    return value


def _bool(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise TypeError(f"{field} must be a boolean")
    return value


def parse_request(stage: str, payload: Any, expected_profile_id: str) -> RunConfig:
    """Validate shape and return a typed RunConfig.

    The expected profile_id comes from the bundled workflow manifest (single
    source of truth). The manifest pins the asset identity; the request must
    match it or the asset the user is asking to run is not the one we ship.
    """
    if stage not in STAGES:
        raise ValueError(f"unknown camera-image stage: {stage!r}")
    if not isinstance(payload, dict):
        raise TypeError("request must be a JSON object")
    unknown = sorted(set(payload) - set(ALLOWED_FIELDS))
    if unknown:
        raise TypeError(
            f"unsupported request field(s): {unknown}; valid fields: {sorted(ALLOWED_FIELDS)}"
        )

    prompt = _coerce_prompt(payload["prompt"])
    evidence = payload.get("evidence") or {}
    if not isinstance(evidence, dict):
        raise TypeError("evidence must be an object")
    profile_id = payload.get("profile_id", expected_profile_id)
    if profile_id != expected_profile_id:
        raise ValueError(
            f"profile_id must be {expected_profile_id!r}, got {profile_id!r}"
        )

    camera = _coerce_camera(payload["camera"]) if "camera" in payload else None
    camera_extra = _coerce_camera_extra(payload["camera_extra"]) if "camera_extra" in payload else None
    lora = _coerce_lora(payload["lora"]) if "lora" in payload else None
    groups = _coerce_groups(payload["groups"]) if "groups" in payload else None
    sampling = _coerce_sampling(payload["sampling"]) if "sampling" in payload else None
    seed = _int(payload.get("seed"), "seed")
    image_size = _coerce_image_size(payload["image_size"]) if "image_size" in payload else None

    image_fields: dict[str, Path] = {}
    for field in IMAGE_FIELDS:
        if field in payload:
            image_fields[field] = _path(payload[field], field)

    text_fields: dict[str, str] = {}
    for field in TEXT_FIELDS:
        if field in payload:
            text_fields[field] = _string(payload[field], field)

    preset = payload.get("preset")
    if preset is not None:
        if not isinstance(preset, str) or not preset.strip():
            raise TypeError("preset must be a non-empty string")

    if stage == "i2i":
        if "reference_image" not in image_fields:
            raise ValueError("stage i2i requires 'reference_image'")
    else:
        if "reference_image" in image_fields:
            raise ValueError("'reference_image' is only supported in stage i2i")

    return RunConfig(
        prompt=prompt,
        evidence=evidence,
        profile_id=profile_id,
        camera=camera,
        camera_extra=camera_extra,
        lora=lora,
        groups=groups,
        sampling=sampling,
        seed=seed,
        image_size=image_size,
        reference_image=image_fields.get("reference_image"),
        controlnet_image=image_fields.get("controlnet_image"),
        red_prompt=text_fields.get("red_prompt"),
        green_prompt=text_fields.get("green_prompt"),
        blue_prompt=text_fields.get("blue_prompt"),
        red_image=image_fields.get("red_image"),
        green_image=image_fields.get("green_image"),
        blue_image=image_fields.get("blue_image"),
        signature_image=image_fields.get("signature_image"),
        preset=preset,
    )


def require_files(config: RunConfig) -> None:
    """Check that every image path the user supplied exists on disk."""
    for field in IMAGE_FIELDS:
        path = getattr(config, field)
        if path is not None and not path.is_file():
            raise FileNotFoundError(f"{field} is missing: {path}")


def upload_targets(config: RunConfig) -> tuple[str, ...]:
    """Logical image field names whose files must be uploaded to ComfyUI."""
    return tuple(
        field for field in IMAGE_FIELDS
        if getattr(config, field) is not None
    )
