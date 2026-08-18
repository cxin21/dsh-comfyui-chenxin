"""Contract gate: prove each SKILL.md example request satisfies the CLI schema.

The SKILL.md files are the LLM-facing contract; the parsers are the machine
contract. This script extracts the first jsonc example block from each
SKILL.md, strips comments, and runs it through the exact parser the CLI
uses. If this script is red, the contract has drifted — fix the drift,
never ship it.

Usage:  python scripts/check_contracts.py
Exit:   0 = every contract holds, 1 = drift detected.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

PRESET_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PRESET_ROOT / "skills" / "anima-prompt-v1"))
sys.path.insert(0, str(PRESET_ROOT / "skills" / "minimax-h3-prompt"))
sys.path.insert(0, str(PRESET_ROOT / "skills" / "camera-image"))
sys.path.insert(0, str(PRESET_ROOT / "skills" / "camera-video"))
sys.path.insert(0, str(PRESET_ROOT / "skills" / "camera-multiview"))


def strip_jsonc(text: str) -> str:
    """Remove // comments while respecting string literals."""
    out: list[str] = []
    in_string = False
    i = 0
    while i < len(text):
        ch = text[i]
        if in_string:
            out.append(ch)
            if ch == "\\" and i + 1 < len(text):
                out.append(text[i + 1])
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < len(text) and text[i + 1] == "/":
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def first_example(skill_md: Path) -> dict:
    import json

    raw = skill_md.read_text(encoding="utf-8")
    match = re.search(r"```jsonc\n(.*?)```", raw, re.DOTALL)
    if not match:
        raise AssertionError(f"no jsonc example block in {skill_md}")
    payload = json.loads(strip_jsonc(match.group(1)))
    if not isinstance(payload, dict):
        raise AssertionError(f"example in {skill_md} is not a JSON object")
    return payload


# Stage marker convention: the first jsonc example block may declare which
# CLI stage it exercises via a trailing comment line:
#     // contract-stage: i2i
# The gate reads this instead of guessing from the payload shape, so the
# coupling between SKILL.md example order and the parser's stage rules is
# explicit rather than incidental.
STAGE_MARKER = re.compile(r"^\s*//\s*contract-stage:\s*([\w-]+)\s*$", re.MULTILINE)


def first_example_stage(skill_md: Path) -> str | None:
    """Return the declared contract stage, or None if the example does not
    carry the `// contract-stage:` marker."""
    raw = skill_md.read_text(encoding="utf-8")
    match = re.search(r"```jsonc\n(.*?)```", raw, re.DOTALL)
    if not match:
        return None
    stage_match = STAGE_MARKER.search(match.group(1))
    return stage_match.group(1) if stage_match else None


def check_anima() -> None:
    from anima_prompt_v1.cli import _coerce_brief
    from anima_prompt_v1.types import ModelPolicy

    payload = first_example(PRESET_ROOT / "skills/anima-prompt-v1/SKILL.md")
    ModelPolicy.for_variant(payload.get("variant", "base"))
    _coerce_brief(payload)


def check_h3() -> None:
    from h3_prompt.contracts import parse_request

    payload = first_example(PRESET_ROOT / "skills/minimax-h3-prompt/SKILL.md")
    stage = "ref2va" if payload.get("references") else "t2va"
    parse_request(stage, payload)


def check_camera_image() -> None:
    from camera_image.runtime.assets import asset_identity
    from camera_image.runtime.request import parse_request

    expected_profile_id = asset_identity()["profile_id"]
    skill_md = PRESET_ROOT / "skills/camera-image/SKILL.md"
    payload = first_example(skill_md)
    declared = first_example_stage(skill_md)
    # The first jsonc block declares its stage explicitly. If the marker is
    # absent, fall back to the historical default (t2i) so the gate never
    # silently skips.
    stage = declared if declared in ("t2i", "i2i") else "t2i"
    parse_request(stage, payload, expected_profile_id)
    # Also verify the other stage parses, using the same payload minus the
    # stage-specific reference field (synthesized for i2i).
    if stage == "t2i":
        i2i = {**payload, "reference_image": "C:/path/to/ref.png"}
        parse_request("i2i", i2i, expected_profile_id)
    else:
        t2i = {k: v for k, v in payload.items() if k != "reference_image"}
        parse_request("t2i", t2i, expected_profile_id)


def check_camera_video() -> None:
    from camera_video.runtime.request import parse_request

    skill_md = PRESET_ROOT / "skills/camera-video/SKILL.md"
    payload = first_example(skill_md)
    declared = first_example_stage(skill_md)
    stage = declared if declared in ("t2v", "i2v", "multi-i2v") else "i2v"
    # The example's declared stage must parse as-is.
    parse_request(stage, payload)
    # Every other stage must parse against the same example's prompt/duration,
    # with the reference list synthesized to that stage's required count.
    from camera_video.runtime.request import STAGE_REFERENCE_COUNT

    base = {k: v for k, v in payload.items() if k != "references"}
    for other in ("t2v", "i2v", "multi-i2v"):
        if other == stage:
            continue
        count = STAGE_REFERENCE_COUNT[other]
        other_payload = dict(base)
        if count:
            other_payload["references"] = [
                f"C:/path/to/ref-{i}.png" for i in range(1, count + 1)
            ]
        parse_request(other, other_payload)


def check_camera_multiview() -> None:
    from camera_multiview.config_schema import RunConfig

    payload = first_example(PRESET_ROOT / "skills/camera-multiview/SKILL.md")
    RunConfig.from_envelope({}, **payload)


CHECKS = {
    "anima-prompt-v1": check_anima,
    "minimax-h3-prompt": check_h3,
    "camera-image": check_camera_image,
    "camera-video": check_camera_video,
    "camera-multiview": check_camera_multiview,
}


def main() -> int:
    failures = 0
    for name, check in CHECKS.items():
        try:
            check()
        except Exception as error:  # noqa: BLE001 - report every drift
            failures += 1
            print(f"FAIL {name}: {error}")
        else:
            print(f"OK   {name}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
