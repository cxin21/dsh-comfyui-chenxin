"""Catalog grounding: turn a slot-structured UserBrief into tag -> Citation.

Single layer of catalog evidence: one Citation per slot tag, looked up once.
Only canonical/alias exact matches become grounded citations; fuzzy is a
discovery mode (search-first), not a grounding basis, so fuzzy/miss preserve
the user text verbatim. Exclusions and narrative are NOT grounded: exclusions
are negative directives (not content to substitute) and narrative is free
prose that is never swapped for a tag.
"""

from __future__ import annotations

from .catalog import Catalog
from .catalog.facets import normalize
from .types import GROUNDED_MATCH_TYPES, Citation, UserBrief


def ground(brief: UserBrief, catalog: Catalog) -> dict[str, Citation]:
    """Ground every slot tag against the catalog. Returns normalized-tag -> Citation."""
    citations: dict[str, Citation] = {}
    for slot in brief.slots:
        for tag in slot.tags:
            _cite_one(citations, tag, catalog)
    return citations


def _cite_one(citations: dict[str, Citation], text: str, catalog: Catalog) -> None:
    if not text or not text.strip():
        return
    key = normalize(text)
    if key in citations:
        return
    hits = catalog.search(text, mode="auto", limit=1)
    if not hits or hits[0].match_type not in GROUNDED_MATCH_TYPES:
        citations[key] = Citation(text=text, match_type="miss")
        return
    hit = hits[0]
    citations[key] = Citation(
        text=text,
        record_id=hit.record_id,
        canonical=hit.canonical_name,
        prompt_form=hit.prompt_form,
        source=hit.source,
        match_type=hit.match_type,
    )
