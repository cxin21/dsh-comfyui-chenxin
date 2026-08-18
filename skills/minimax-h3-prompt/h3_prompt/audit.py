"""Deterministic audit gates over the generated H3 prompt text.

The builder generates structure by construction; the audit is the second
line of defense that verifies the final text itself. All gates are
fact-free: preservation is guaranteed because the code wrote the text.

Stages:
* ``t2va``     — three fields, no alignment preamble.
* ``i2va``     — alignment preamble + three fields; <Picture 1> at 0.00s.
* ``fl2va``    — alignment preamble + three fields; <Picture 2> at duration.
* ``l2va``     — alignment preamble + three fields; <Picture 1> at duration.
* ``ref2va``   — six fields, no alignment preamble.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from math import floor

from .contracts import MAX_PROMPT_CHARS, Reference


class H3AuditError(ValueError):
    """A MiniMax-H3 production hard gate failed."""


@dataclass(frozen=True)
class Shot:
    number: int
    start_seconds: float
    end_seconds: float
    text: str


_SHOT_MARKER = re.compile(r"\[Shot ([1-9][0-9]*)\]")
_CUT_PREFIX = re.compile(r"^\s*At ([0-9]{2}):([0-9]{2})\.([0-9]{3}),\s*")
_DIALOGUE = re.compile(r"<d>\[([^\]]+)\] ([\s\S]*?)</d>")
_REFERENCE = re.compile(r"<(Subject|Picture|Video|Audio) ([1-9][0-9]*)>")

T2VA_FIELDS = (
    "integrated_multimodal_description",
    "overall_soundscape",
    "non_diegetic_music",
)
KEYFRAME_FIELDS = T2VA_FIELDS  # keyframe modes share the base three-field layout
REF2VA_FIELDS = (
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
)


def _check_char_budget(text: str, findings: list[str]) -> None:
    if len(text) > MAX_PROMPT_CHARS:
        findings.append(
            f"prompt length {len(text)} chars exceeds the official "
            f"{MAX_PROMPT_CHARS}-character maximum"
        )


def split_fields(text: str, names: tuple[str, ...]) -> dict[str, str]:
    """Slice the generated text into its labeled fields, verifying order."""
    positions: list[tuple[int, str]] = []
    for name in names:
        index = text.find(f"{name}: ")
        if index == -1:
            raise H3AuditError(f"field {name!r} is missing from the prompt")
        positions.append((index, name))
    ordered = sorted(positions)
    if [name for _, name in ordered] != list(names):
        raise H3AuditError("fields are not in the required dialect order")
    fields: dict[str, str] = {}
    for index, (start, name) in enumerate(ordered):
        body_start = start + len(name) + 2
        body_end = ordered[index + 1][0] if index + 1 < len(ordered) else len(text)
        fields[name] = text[body_start:body_end].strip()
    return fields


def parse_shots(
    description: str,
    *,
    duration_seconds: float,
    declared_shot_count: int,
) -> tuple[Shot, ...]:
    if not 4 <= duration_seconds <= 15:
        raise H3AuditError("duration_seconds must be between 4 and 15")
    if declared_shot_count <= 0:
        raise H3AuditError("declared_shot_count must be a positive integer")
    if not isinstance(description, str) or not description.strip():
        raise H3AuditError("description must be non-empty")
    markers = list(_SHOT_MARKER.finditer(description))
    numbers = [int(marker.group(1)) for marker in markers]
    if numbers != list(range(1, len(numbers) + 1)):
        raise H3AuditError("shot numbers must be sequential starting at 1")
    if len(markers) != declared_shot_count:
        raise H3AuditError("declared shot count does not match shot markers")
    max_shots = 1 + floor((duration_seconds - 1) / 3)
    if len(markers) > max_shots:
        raise H3AuditError(f"shot count exceeds max_shots {max_shots}")

    starts: list[float] = [0.0]
    bodies: list[str] = []
    for index, marker in enumerate(markers):
        end = markers[index + 1].start() if index + 1 < len(markers) else len(description)
        body = description[marker.end():end].strip()
        if index == 0:
            if _CUT_PREFIX.match(body):
                raise H3AuditError("first shot must not contain a timestamp")
        else:
            timestamp = _CUT_PREFIX.match(body)
            if timestamp is None:
                raise H3AuditError("every shot after the first requires At MM:SS.mmm")
            minutes, seconds, milliseconds = (int(value) for value in timestamp.groups())
            if seconds >= 60:
                raise H3AuditError("timestamp seconds must be below 60")
            start = minutes * 60 + seconds + milliseconds / 1000
            if start >= duration_seconds:
                raise H3AuditError("shot timestamp must fall within video duration")
            starts.append(start)
            body = body[timestamp.end():].strip()
        if not body:
            raise H3AuditError(f"Shot {index + 1} must have executable content")
        bodies.append(body)
    if any(later <= earlier for earlier, later in zip(starts, starts[1:])):
        raise H3AuditError("shot timestamps must be strictly increasing")

    return tuple(
        Shot(
            number=index + 1,
            start_seconds=starts[index],
            end_seconds=(starts[index + 1] if index + 1 < len(starts) else float(duration_seconds)),
            text=body,
        )
        for index, body in enumerate(bodies)
    )


def audit_shot_execution(shots: tuple[Shot, ...]) -> None:
    for shot in shots[1:]:
        if re.match(
            r"(?i)^(?:the camera|the shot|camera|shot)\s+"
            r"(?:cuts|transitions|changes|switches)\s+to\b",
            shot.text,
        ) is None:
            raise H3AuditError(
                f"Shot {shot.number} cut must declare a model-native transition and new view"
            )
    for previous, current in zip(shots, shots[1:]):
        if _semantic_shot(previous.text) == _semantic_shot(current.text):
            raise H3AuditError(
                f"Shot {current.number} cut adds no new information or state"
            )


def audit_dialogue(text: str) -> None:
    malformed = re.sub(_DIALOGUE, "", text)
    if "<d>" in malformed or "</d>" in malformed:
        raise H3AuditError("dialogue blocks must use <d>[Language] exact text</d>")


def audit_sound_music_separation(soundscape: str, music: str) -> None:
    if "<d>" in soundscape or "</d>" in soundscape:
        raise H3AuditError("dialogue must not be repeated in overall_soundscape")
    if re.search(r"\bnon[- ]diegetic\b|\bbackground music\b", soundscape, re.IGNORECASE):
        raise H3AuditError("non-diegetic music must not appear in overall_soundscape")
    if "<d>" in music or "</d>" in music:
        raise H3AuditError("dialogue must not appear in non_diegetic_music")


def audit_reference_labels(
    subject_definitions: str,
    usage_text: str,
    references: tuple[Reference, ...],
) -> None:
    if any(not (ref.who and ref.who.strip()) for ref in references):
        raise H3AuditError("every ordered input reference requires an owner")
    combined = f"{subject_definitions}\n{usage_text}"
    labels = {(kind, int(index)) for kind, index in _REFERENCE.findall(combined)}
    picture_numbers = {index for kind, index in labels if kind == "Picture"}
    expected_numbers = set(range(1, len(references) + 1))
    if not picture_numbers.issubset(expected_numbers):
        raise H3AuditError("reference label does not resolve to an ordered input image")
    definition_labels = re.findall(
        r"(?m)^\s*<(Subject|Picture|Video|Audio) ([1-9][0-9]*)>\s+is\b",
        subject_definitions,
    )
    if len(definition_labels) != len(set(definition_labels)):
        raise H3AuditError("reference definition collision")
    if not expected_numbers.issubset(picture_numbers):
        raise H3AuditError("every ordered input image must be referenced")
    defined_subjects = {
        int(index) for kind, index in definition_labels if kind == "Subject"
    }
    used_subjects = {
        int(index) for kind, index in _REFERENCE.findall(usage_text) if kind == "Subject"
    }
    if not used_subjects.issubset(defined_subjects):
        raise H3AuditError("used Subject label is not defined in subject_definitions")


def _semantic_shot(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", text.lower()))


def _audit_timeline(description: str, duration_seconds: float, shot_count: int) -> None:
    shots = parse_shots(
        description,
        duration_seconds=duration_seconds,
        declared_shot_count=shot_count,
    )
    audit_shot_execution(shots)
    audit_dialogue(description)


# ── Keyframe preamble audits ──────────────────────────────────────────────

def _audit_i2va_preamble(preamble: str) -> None:
    if "<Picture 1>" not in preamble:
        raise H3AuditError("i2va preamble must reference <Picture 1>")
    if "0.00 seconds" not in preamble:
        raise H3AuditError("i2va preamble must anchor at 0.00 seconds")


def _audit_fl2va_preamble(preamble: str, duration_seconds: float, shot_count: int) -> None:
    expected = f"{duration_seconds:.2f}-second"
    if "Picture 1" not in preamble or "Picture 2" not in preamble:
        raise H3AuditError("fl2va preamble must reference both Picture 1 and Picture 2")
    if "0.00-second" not in preamble:
        raise H3AuditError("fl2va preamble must anchor Picture 1 at 0.00 seconds")
    if expected not in preamble:
        raise H3AuditError(
            f"fl2va preamble must end at {expected} (two decimal places)"
        )
    if f"Shot {shot_count}" not in preamble:
        raise H3AuditError(
            f"fl2va preamble must place Picture 2 at Shot {shot_count}"
        )


def _audit_l2va_preamble(preamble: str, duration_seconds: float, shot_count: int) -> None:
    expected = f"{duration_seconds:.2f}-second"
    if "<Picture 1>" not in preamble:
        raise H3AuditError("l2va preamble must reference <Picture 1>")
    if expected not in preamble:
        raise H3AuditError(
            f"l2va preamble must end at {expected} (two decimal places)"
        )
    if f"[Shot {shot_count}]" not in preamble:
        raise H3AuditError(
            f"l2va preamble must place Picture 1 at Shot {shot_count}"
        )


def _strip_preamble(text: str) -> str:
    """Keyframe modes prepend a non-field paragraph before the three core fields.

    The first blank line separates the preamble from the fields. After that
    split, the remainder follows the base three-field layout.
    """
    parts = text.split("\n\n", 1)
    if len(parts) == 1:
        return text
    first, rest = parts
    if any(first.startswith(name) for name in T2VA_FIELDS):
        return text
    return rest


def audit_t2va(text: str, *, duration_seconds: float, shot_count: int) -> tuple[str, ...]:
    findings: list[str] = []
    _check_char_budget(text, findings)
    try:
        fields = split_fields(text, T2VA_FIELDS)
        _audit_timeline(
            fields["integrated_multimodal_description"], duration_seconds, shot_count
        )
        audit_sound_music_separation(
            fields["overall_soundscape"], fields["non_diegetic_music"]
        )
    except H3AuditError as error:
        findings.append(str(error))
    return tuple(findings)


def audit_keyframe(
    text: str,
    *,
    stage: str,
    duration_seconds: float,
    shot_count: int,
) -> tuple[str, ...]:
    findings: list[str] = []
    _check_char_budget(text, findings)
    try:
        parts = text.split("\n\n", 1)
        if len(parts) != 2:
            raise H3AuditError(
                f"{stage} prompt must start with the alignment preamble, "
                "followed by a blank line and the three core fields"
            )
        preamble, body = parts
        if stage == "i2va":
            _audit_i2va_preamble(preamble)
        elif stage == "fl2va":
            _audit_fl2va_preamble(preamble, duration_seconds, shot_count)
        elif stage == "l2va":
            _audit_l2va_preamble(preamble, duration_seconds, shot_count)
        else:
            raise H3AuditError(f"unknown keyframe stage: {stage!r}")
        fields = split_fields(body, KEYFRAME_FIELDS)
        _audit_timeline(
            fields["integrated_multimodal_description"], duration_seconds, shot_count
        )
        audit_sound_music_separation(
            fields["overall_soundscape"], fields["non_diegetic_music"]
        )
    except H3AuditError as error:
        findings.append(str(error))
    return tuple(findings)


def audit_ref2va(
    text: str,
    *,
    duration_seconds: float,
    shot_count: int,
    references: tuple[Reference, ...],
) -> tuple[str, ...]:
    findings: list[str] = []
    _check_char_budget(text, findings)
    try:
        fields = split_fields(text, REF2VA_FIELDS)
        audit_reference_labels(
            fields["subject_definitions"],
            fields["retention_analysis"] + "\n" + fields["detailed_description"],
            references,
        )
        _audit_timeline(fields["detailed_description"], duration_seconds, shot_count)
        audit_sound_music_separation(
            fields["overall_soundscape"], fields["non_diegetic_music"]
        )
    except H3AuditError as error:
        findings.append(str(error))
    return tuple(findings)


def audit_prompt(
    stage: str,
    text: str,
    *,
    duration_seconds: float,
    shot_count: int,
    references: tuple[Reference, ...] = (),
) -> tuple[str, ...]:
    """Stage-aware audit dispatcher."""
    if stage == "t2va":
        return audit_t2va(text, duration_seconds=duration_seconds, shot_count=shot_count)
    if stage in ("i2va", "fl2va", "l2va"):
        return audit_keyframe(
            text,
            stage=stage,
            duration_seconds=duration_seconds,
            shot_count=shot_count,
        )
    if stage == "ref2va":
        return audit_ref2va(
            text,
            duration_seconds=duration_seconds,
            shot_count=shot_count,
            references=references,
        )
    raise ValueError(f"unknown stage: {stage!r}")