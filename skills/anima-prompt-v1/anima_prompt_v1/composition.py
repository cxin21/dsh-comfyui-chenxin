"""Compose a final prompt from policy, slot-structured brief, and citations.

Virgin 4-stage pipeline: Policy -> Grounding -> Composition -> Inspection.

Position is implicit weight (Anima/SD): positive segments are emitted in fixed
SLOT_ORDER regardless of how the brief was filled. `quality_prefix` gates the
policy quality terms (pure-content mode for lora/script workflows); the safety
seed is independent of it (safety policy always applies unless explicit).
narrative is always last. No silent-drop path: every slot tag is either
substituted (canonical/alias), preserved-and-reported (miss -> catalog_miss),
or preserved (fuzzy).
"""

from __future__ import annotations

from .catalog import Catalog
from .catalog.facets import normalize
from .grounding import ground
from .inspection import inspect
from .types import (
    GROUNDED_MATCH_TYPES, Citation, ComposedPrompt, ComposedSegment,
    ModelPolicy, SLOT_ORDER, UserBrief, is_explicit_request,
)


def compose(brief: UserBrief, catalog: Catalog) -> ComposedPrompt:
    """4-stage pipeline. Each stage has one job; outputs are explicit."""
    # Stage 1: Policy. No search; no user data.
    policy = ModelPolicy.for_variant(brief.variant)

    # Stage 2: Grounding. Single source of catalog evidence.
    citations = ground(brief, catalog)

    # Stage 3: Composition. Build segments with provenance baked in.
    positive, negative, notes, assumptions = _build(policy, brief, citations)

    # Stage 4: Inspection. By-construction checks + quality advisories.
    advisories = inspect(positive, negative)

    return ComposedPrompt(
        positive=positive,
        negative=negative,
        policy=policy,
        notes=tuple(notes),
        assumptions=tuple(assumptions),
        advisories=advisories,
    )


def _build(
    policy: ModelPolicy,
    brief: UserBrief,
    citations: dict[str, Citation],
) -> tuple[
    tuple[ComposedSegment, ...],  # positive
    tuple[ComposedSegment, ...],  # negative
    list[str],                    # notes
    list[str],                    # assumptions
]:
    positive: list[ComposedSegment] = []
    negative: list[ComposedSegment] = []
    notes: list[str] = []
    assumptions: list[str] = []
    missed_keys: set[str] = set()

    # 3a: Policy quality terms. Gated by quality_prefix - pure-content mode
    # omits both positive and negative quality terms (the lora/script adds them).
    if brief.quality_prefix:
        for term in policy.mandatory_positive:
            positive.append(ComposedSegment(
                text=term, channel="positive", origin="policy", priority=100,
            ))
        for term in policy.mandatory_negative:
            negative.append(ComposedSegment(
                text=term, channel="negative", origin="policy", priority=100,
            ))

    # 3b: Safety seed. Independent of quality_prefix - safety policy always
    # applies unless the brief is explicitly marked.
    if not is_explicit_request(brief):
        for term in policy.safety_seed:
            positive.append(ComposedSegment(
                text=term, channel="positive", origin="policy", priority=99,
            ))
        assumptions.append("safety_seed_injected:default_for_non_explicit_request")

    # 3c: Slots in fixed SLOT_ORDER. This IS the implicit-weight policy.
    for slot_index, slot_name in enumerate(SLOT_ORDER):
        tags = brief.slot(slot_name)
        if not tags:
            continue
        base = 200 + slot_index * 50
        for tag_index, tag in enumerate(tags):
            citation = citations.get(normalize(tag))
            if citation is not None and citation.match_type in GROUNDED_MATCH_TYPES:
                text = citation.prompt_form or tag
                origin = "grounded"
            else:
                text = tag
                origin = "user-fuzzy"
                if citation is not None and citation.match_type == "miss":
                    nkey = normalize(tag)
                    if nkey not in missed_keys:
                        missed_keys.add(nkey)
                        assumptions.append(f"catalog_miss:{tag}")
            positive.append(ComposedSegment(
                text=text, channel="positive", origin=origin,
                priority=base + tag_index, slot=slot_name, citation=citation,
            ))

    # 3d: Narrative always last (multi-person attribution, complex composition,
    # viewer relation - free prose after all tags).
    if brief.narrative and brief.narrative.strip():
        positive.append(ComposedSegment(
            text=brief.narrative.strip(), channel="positive",
            origin="narrative", priority=2000,
        ))

    # 3e: Exclusions to negative channel (verbatim, never grounded).
    for exclusion in brief.exclusions:
        negative.append(ComposedSegment(
            text=exclusion, channel="negative", origin="exclusion", priority=900,
        ))

    # 3f: Notes from grounded citations only.
    for citation in citations.values():
        if citation.match_type in GROUNDED_MATCH_TYPES and citation.record_id:
            notes.append(
                f"citation:{citation.record_id}:match={citation.match_type}:"
                f"canonical={citation.canonical}:source={citation.source}"
            )

    return tuple(positive), tuple(negative), notes, assumptions
