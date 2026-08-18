"""Virgin types: every concept the architecture speaks about lives here.

The brief is slot-structured, not a flat fact list. Anima's core best
practice is *position as implicit weight*: the slot order
(count/gender -> character -> appearance -> clothing -> pose/action ->
expression -> camera -> scene -> detail/mood -> narrative) is the single
most important quality lever, so the data model makes it first-class.

Four species, no overlap:
  - UserBrief       : declarative, what the human asked (slot-structured)
  - ModelPolicy     : variant-mandated, what the model contract demands
  - Citation        : grounding, where each tag came from in the catalog
  - ComposedSegment : final piece, with provenance baked in
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


Variant = Literal["base", "aesthetic", "turbo"]
Channel = Literal["positive", "negative"]
Origin = Literal["policy", "grounded", "user-fuzzy", "narrative", "exclusion"]
Severity = Literal["info", "warning", "conflict"]
MatchType = Literal["canonical", "alias", "fuzzy", "miss"]

# Slot order IS the implicit-weight policy. Front slots weigh more.
# `narrative` is not a slot - it is always appended last as free prose.
SLOT_ORDER: tuple[str, ...] = (
    "count_gender",
    "character",
    "appearance",
    "clothing",
    "pose_action",
    "expression",
    "camera",
    "scene",
    "detail_mood",
)

SlotName = Literal[
    "count_gender", "character", "appearance", "clothing",
    "pose_action", "expression", "camera", "scene", "detail_mood",
]

# Match types that justify substituting the user text with the catalog's
# canonical prompt form. Single source of truth shared by grounding and
# composition.
GROUNDED_MATCH_TYPES: frozenset[str] = frozenset({"canonical", "alias"})


@dataclass(frozen=True)
class Slot:
    """One slot of the slot-ordered brief. tags are plain strings."""
    name: str
    tags: tuple[str, ...]


@dataclass(frozen=True)
class UserBrief:
    """Declarative, slot-structured input. The LLM produces this; code reads it."""

    subject: str
    slots: tuple[Slot, ...]
    narrative: str = ""
    exclusions: tuple[str, ...] = ()
    variant: str = "base"
    # quality_prefix=false yields a pure-content prompt (the lora/script
    # workflow adds quality terms itself). Default true keeps the Anima
    # protocol terms in-prompt.
    quality_prefix: bool = True
    # explicit=true forces the safety seed off without relying on marker
    # substring detection.
    explicit: bool = False

    def slot(self, name: str) -> tuple[str, ...]:
        """Return the tags of one slot, or () if absent."""
        for slot in self.slots:
            if slot.name == name:
                return slot.tags
        return ()


@dataclass(frozen=True)
class ModelPolicy:
    """Variant-mandated terms. Independent from user data."""

    variant: Variant
    mandatory_positive: tuple[str, ...]
    mandatory_negative: tuple[str, ...]
    safety_seed: tuple[str, ...] = ("safe",)

    @classmethod
    def for_variant(cls, variant: str) -> "ModelPolicy":
        if not isinstance(variant, str):
            raise ValueError(
                f"variant must be a string, got {type(variant).__name__}"
            )
        v = variant.strip().lower()
        if v in ("base", "anima-base"):
            return cls(
                variant="base",
                mandatory_positive=("masterpiece", "best quality", "score_7"),
                mandatory_negative=(
                    "worst quality", "low quality",
                    "score_1", "score_2", "score_3",
                ),
            )
        if v in ("aesthetic", "anima-aesthetic"):
            return cls(
                variant="aesthetic",
                mandatory_positive=("masterpiece", "best quality"),
                mandatory_negative=("worst quality", "low quality"),
            )
        if v in ("turbo", "anima-turbo"):
            return cls(
                variant="turbo",
                mandatory_positive=("masterpiece", "best quality"),
                mandatory_negative=("worst quality", "low quality"),
            )
        raise ValueError(f"unknown variant: {variant!r}")


@dataclass(frozen=True)
class Citation:
    """Catalog grounding for one tag (single evidence layer)."""

    text: str
    record_id: str | None = None
    canonical: str | None = None
    prompt_form: str | None = None
    source: str | None = None
    match_type: MatchType = "miss"


@dataclass(frozen=True)
class ComposedSegment:
    """A piece of the final prompt. Provenance is in origin, not in notes."""

    text: str
    channel: Channel
    origin: Origin
    priority: int = 0
    slot: str | None = None
    citation: Citation | None = None


@dataclass(frozen=True)
class InspectionIssue:
    code: str
    severity: Severity
    message: str
    location: str | None = None


@dataclass(frozen=True)
class ComposedPrompt:
    positive: tuple[ComposedSegment, ...]
    negative: tuple[ComposedSegment, ...]
    policy: ModelPolicy
    notes: tuple[str, ...] = ()
    assumptions: tuple[str, ...] = ()
    advisories: tuple[InspectionIssue, ...] = ()

    @property
    def positive_text(self) -> str:
        return ", ".join(seg.text for seg in self.positive)

    @property
    def negative_text(self) -> str:
        return ", ".join(seg.text for seg in self.negative)


# Explicit-request safety markers. If NONE of these appear in the brief and
# `explicit` is not set, policy mandates a 'safe' safety seed.
EXPLICIT_SAFETY_MARKERS: frozenset[str] = frozenset((
    "explicit", "nude", "nudity", "genitals", "genital", "vulva", "penis",
    "乳头", "乳房", "生殖器", "阴部", "阴茎", "阴道", "隐私部位", "裸露", "露骨", "色情", "pornographic", "nsfw",
))


def is_explicit_request(brief: UserBrief) -> bool:
    """True iff the brief is marked explicit or mentions an explicit marker."""
    if brief.explicit:
        return True
    pieces: list[str] = [brief.subject.lower(), brief.narrative.lower()]
    for slot in brief.slots:
        pieces.extend(tag.lower() for tag in slot.tags)
    pieces.extend(value.lower() for value in brief.exclusions)
    corpus = " ".join(pieces)
    return any(marker in corpus for marker in EXPLICIT_SAFETY_MARKERS)
