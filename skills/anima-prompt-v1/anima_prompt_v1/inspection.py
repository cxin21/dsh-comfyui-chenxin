"""By-construction invariants + quality advisories.

Composition guarantees policy/origin/exclusion structure. Inspection checks
what composition cannot:
  - duplicate segments, positive/negative overlap, weight syntax
  - lighting/tonal terms the lora handles internally (advisory, not removed)
  - mechanically-detectable mutual exclusions (viewpoint / shot scale)
  - tag count out of the 12-50 working range

Clothing/action exclusions need semantics and stay in SKILL.md guidance; this
module only does what is mechanically decidable.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from .catalog.facets import normalize
from .types import ComposedSegment, InspectionIssue


# Lighting/tonal terms the lora handles internally. Conservative: no bare
# 'light'/'glowing' (would false-positive 'glowing eyes', 'light particles'
# is listed explicitly). Advisory only - never auto-removed.
LIGHTING_BAN: frozenset[str] = frozenset((
    "sunlight", "moonlight", "rim light", "warm lighting", "cool lighting",
    "golden hour glow", "soft lighting", "backlighting", "god rays",
    "light rays", "volumetric light", "spotlight", "candlelight",
    "neon light", "streetlights", "warm tone", "cool tone", "sepia",
    "light particles", "backlit",
))

# Mechanically detectable mutual exclusions (viewpoint / shot scale only).
MUTUAL_EXCLUSIONS: tuple[tuple[str, str], ...] = (
    ("from front", "from behind"),
    ("from above", "from below"),
    ("pov", "full body"),
    ("close-up", "full body"),
    ("looking at viewer", "facing away"),
)

TAG_COUNT_MIN = 12
TAG_COUNT_MAX = 50


def inspect(
    positive: tuple[ComposedSegment, ...],
    negative: tuple[ComposedSegment, ...],
) -> tuple[InspectionIssue, ...]:
    issues: list[InspectionIssue] = []
    issues.extend(_check_duplicates(positive, "positive"))
    issues.extend(_check_duplicates(negative, "negative"))
    issues.extend(_check_conflict(positive, negative))
    issues.extend(_check_weights(_render(positive)))
    issues.extend(_check_weights(_render(negative)))
    issues.extend(_check_lighting(positive))
    issues.extend(_check_mutual_exclusion(positive))
    issues.extend(_check_tag_count(positive))
    return tuple(issues)


def _render(segments: Iterable[ComposedSegment]) -> str:
    return ", ".join(seg.text for seg in segments)


def _check_duplicates(
    segments: tuple[ComposedSegment, ...], channel: str,
) -> tuple[InspectionIssue, ...]:
    issues: list[InspectionIssue] = []
    seen: set[str] = set()
    for seg in segments:
        key = seg.text.strip().lower()
        if key in seen:
            issues.append(InspectionIssue(
                code="duplicate_segment", severity="warning",
                message=f"duplicate segment in {channel}: {seg.text}", location=channel,
            ))
        seen.add(key)
    return tuple(issues)


def _check_conflict(
    positive: tuple[ComposedSegment, ...],
    negative: tuple[ComposedSegment, ...],
) -> tuple[InspectionIssue, ...]:
    pos = {seg.text.strip().lower() for seg in positive}
    neg = {seg.text.strip().lower() for seg in negative}
    overlap = sorted(pos & neg)
    if not overlap:
        return ()
    return (InspectionIssue(
        code="positive_negative_conflict", severity="conflict",
        message=f"same phrase appears in positive and negative: {overlap[0]}",
        location="composition",
    ),)


def _check_weights(text: str) -> tuple[InspectionIssue, ...]:
    issues: list[InspectionIssue] = []
    if text.count("(") != text.count(")"):
        issues.append(InspectionIssue(
            code="unbalanced_parentheses", severity="warning",
            message="weight parentheses are unbalanced",
        ))
    for value in re.findall(r":\s*([-+]?\d+(?:\.\d+)?)\s*\)?", text):
        try:
            if abs(float(value)) > 4:
                issues.append(InspectionIssue(
                    code="abnormal_weight", severity="warning",
                    message=f"weight {value} is unusually large",
                ))
        except ValueError:
            continue
    return tuple(issues)


def _check_lighting(positive: tuple[ComposedSegment, ...]) -> tuple[InspectionIssue, ...]:
    text = " ".join(normalize(seg.text) for seg in positive)
    found = sorted(term for term in LIGHTING_BAN if term in text)
    if not found:
        return ()
    return (InspectionIssue(
        code="lighting_term_banned", severity="warning",
        message=f"lora-internal lighting term(s) present: {', '.join(found)}",
        location="positive",
    ),)


def _check_mutual_exclusion(positive: tuple[ComposedSegment, ...]) -> tuple[InspectionIssue, ...]:
    text = " ".join(normalize(seg.text) for seg in positive)
    issues: list[InspectionIssue] = []
    for first, second in MUTUAL_EXCLUSIONS:
        if first in text and second in text:
            issues.append(InspectionIssue(
                code="mutual_exclusion", severity="conflict",
                message=f"mutually exclusive tags: {first} + {second}",
                location="positive",
            ))
    return tuple(issues)


def _check_tag_count(positive: tuple[ComposedSegment, ...]) -> tuple[InspectionIssue, ...]:
    # Content tags only (slots + narrative); policy/safe are not content.
    count = sum(1 for seg in positive if seg.origin in ("grounded", "user-fuzzy", "narrative"))
    if TAG_COUNT_MIN <= count <= TAG_COUNT_MAX:
        return ()
    return (InspectionIssue(
        code="tag_count_out_of_range", severity="warning",
        message=f"{count} content tags (working range {TAG_COUNT_MIN}-{TAG_COUNT_MAX})",
        location="positive",
    ),)
