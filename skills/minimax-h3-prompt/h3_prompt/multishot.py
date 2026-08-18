"""Multishot plan compilation.

The model writes a complete multishot plan in one pass; this module validates
the plan and compiles it into a list of :class:`contracts.Shot` objects that
``author`` consumes.

A plan is a JSON object with::

    total_duration: float       # 4..15 seconds
    shot_count: int             # 1..max_shots(duration)
    edit_rhythm: str            # narrative pacing summary
    continuity_strategy: str    # one-line continuity summary
    shots: list[ShotDraft]      # fully populated, length == shot_count
    continuity_ledger: dict    # at least {identity, wardrobe_and_props}
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .contracts import (
    MAX_DURATION_SECONDS,
    MIN_DURATION_SECONDS,
    Shot,
    max_shots,
)


REQUIRED_LEDGER_FIELDS = ("identity", "wardrobe_and_props")


class MultishotPlanError(ValueError):
    """A multishot plan failed validation."""


@dataclass
class ShotDraft:
    shot: int
    content: str = ""
    camera: str = ""
    transition: str = ""
    sound_focus: str = ""
    composition: str = ""
    action: str = ""
    entry_state: str = ""
    exit_state: str = ""
    narrative_function: str = ""
    shot_size: str = ""
    active_references: list[str] = field(default_factory=list)
    start: float | None = None
    end: float | None = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any], index: int) -> "ShotDraft":
        start = raw.get("start")
        end = raw.get("end")
        return cls(
            shot=index,
            content=str(raw.get("content", "")),
            camera=str(raw.get("camera", "")),
            transition=str(raw.get("transition", "")),
            sound_focus=str(raw.get("sound_focus", "")),
            composition=str(raw.get("composition", "")),
            action=str(raw.get("action", "")),
            entry_state=str(raw.get("entry_state", "")),
            exit_state=str(raw.get("exit_state", "")),
            narrative_function=str(raw.get("narrative_function", "")),
            shot_size=str(raw.get("shot_size", "")),
            active_references=list(raw.get("active_references", []) or []),
            start=float(start) if isinstance(start, (int, float)) and not isinstance(start, bool) else None,
            end=float(end) if isinstance(end, (int, float)) and not isinstance(end, bool) else None,
        )


@dataclass
class MultishotPlan:
    total_duration: float
    shot_count: int
    edit_rhythm: str = ""
    continuity_strategy: str = ""
    shots: tuple[ShotDraft, ...] = field(default_factory=tuple)
    continuity_ledger: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_duration": self.total_duration,
            "shot_count": self.shot_count,
            "edit_rhythm": self.edit_rhythm,
            "continuity_strategy": self.continuity_strategy,
            "shots": [
                {
                    "shot": s.shot, "content": s.content, "camera": s.camera,
                    "transition": s.transition, "sound_focus": s.sound_focus,
                    "composition": s.composition, "action": s.action,
                    "entry_state": s.entry_state, "exit_state": s.exit_state,
                    "narrative_function": s.narrative_function,
                    "shot_size": s.shot_size,
                    "active_references": list(s.active_references),
                    "start": s.start, "end": s.end,
                }
                for s in self.shots
            ],
            "continuity_ledger": dict(self.continuity_ledger),
        }

    def compile_to_shots(self) -> tuple[Shot, ...]:
        """Convert each ShotDraft into a Shot consumable by ``build_text``."""
        return tuple(
            Shot(
                what=draft.content,
                who=None,
                ambient=draft.sound_focus or None,
                music=None,
                dialogue=None,
                language=None,
            )
            for draft in self.shots
        )


def _validate_timing(plan: MultishotPlan) -> list[str]:
    findings: list[str] = []
    if not all(s.start is not None and s.end is not None for s in plan.shots):
        return findings  # timing is advisory unless explicitly provided
    prev_end = 0.0
    for shot in plan.shots:
        if abs(shot.start - prev_end) > 1e-6:
            findings.append(
                f"shot {shot.shot} start ({shot.start}) does not connect to "
                f"previous shot end ({prev_end})"
            )
        if shot.end <= shot.start:
            findings.append(
                f"shot {shot.shot} end ({shot.end}) must be after start ({shot.start})"
            )
        if shot.end > plan.total_duration:
            findings.append(
                f"shot {shot.shot} end ({shot.end}) exceeds "
                f"total_duration ({plan.total_duration})"
            )
        prev_end = shot.end
    if abs(prev_end - plan.total_duration) > 1e-6:
        findings.append(
            f"final shot end ({prev_end}) does not match "
            f"total_duration ({plan.total_duration})"
        )
    return findings


def compile_plan(plan: MultishotPlan) -> tuple[str, ...]:
    """Validate a plan and return a tuple of findings (empty on success).

    On success the caller invokes ``plan.compile_to_shots()`` to obtain the
    ``Shot`` tuple for ``author``. The compile step does NOT mutate the plan;
    it only checks invariants.
    """
    findings: list[str] = []

    if not MIN_DURATION_SECONDS <= plan.total_duration <= MAX_DURATION_SECONDS:
        findings.append(
            f"total_duration {plan.total_duration} outside "
            f"[{MIN_DURATION_SECONDS}, {MAX_DURATION_SECONDS}]"
        )

    cap = max_shots(plan.total_duration)
    if plan.shot_count <= 0:
        findings.append("shot_count must be a positive integer")
    elif plan.shot_count > cap:
        findings.append(
            f"shot_count {plan.shot_count} exceeds max_shots {cap} for "
            f"{plan.total_duration}s"
        )

    if len(plan.shots) != plan.shot_count:
        findings.append(
            f"shots length {len(plan.shots)} does not match "
            f"shot_count {plan.shot_count}"
        )

    for shot in plan.shots:
        if not shot.content.strip():
            findings.append(f"shot {shot.shot}.content must be non-empty")
        if shot.shot < 1 or shot.shot > plan.shot_count:
            findings.append(
                f"shot index {shot.shot} out of [1, {plan.shot_count}]"
            )

    for field_name in REQUIRED_LEDGER_FIELDS:
        if not plan.continuity_ledger.get(field_name, "").strip():
            findings.append(f"continuity_ledger.{field_name} must be non-empty")

    findings.extend(_validate_timing(plan))

    return tuple(findings)


def load_plan(path: Path) -> MultishotPlan:
    path = Path(path)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise MultishotPlanError(f"plan file unreadable: {path} ({exc})") from exc
    if not isinstance(raw, dict):
        raise MultishotPlanError("plan file must be a JSON object")

    total = raw.get("total_duration")
    if not isinstance(total, (int, float)) or isinstance(total, bool):
        raise MultishotPlanError("plan.total_duration must be a number")

    shot_count = raw.get("shot_count")
    if not isinstance(shot_count, int) or isinstance(shot_count, bool):
        raise MultishotPlanError("plan.shot_count must be an integer")

    raw_shots = raw.get("shots")
    if not isinstance(raw_shots, list):
        raise MultishotPlanError("plan.shots must be a list")

    shots = tuple(
        ShotDraft.from_dict(s, idx)
        for idx, s in enumerate(raw_shots, start=1)
        if isinstance(s, dict)
    )

    raw_ledger = raw.get("continuity_ledger") or {}
    if not isinstance(raw_ledger, dict):
        raise MultishotPlanError("plan.continuity_ledger must be an object")
    ledger = {str(k): str(v) for k, v in raw_ledger.items()}

    return MultishotPlan(
        total_duration=float(total),
        shot_count=shot_count,
        edit_rhythm=str(raw.get("edit_rhythm", "")),
        continuity_strategy=str(raw.get("continuity_strategy", "")),
        shots=shots,
        continuity_ledger=ledger,
    )