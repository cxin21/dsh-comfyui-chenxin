"""Post-authoring relation validation and persistence boundary.

The skill LLM decides whether a reusable semantic relation exists after it has
finished authoring the prompt.  This module never calls an LLM.  It validates
the LLM's structured submission and writes only validated candidate proposals
to the writable relation overlay.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .catalog import Catalog, RelationOverlay
from .catalog.models import TagHit
from .catalog.relations import RelationProposal


@dataclass(frozen=True)
class RelationSubmission:
    """Result of validating and optionally persisting one post-authoring submission."""

    record_ids: tuple[str, ...]
    proposals: tuple[RelationProposal, ...]
    issues: tuple[str, ...] = ()


class RelationValidator:
    """Validate a structured relation submission without semantic inference."""

    def validate(
        self,
        payload: str | Mapping[str, Any],
        *,
        known_record_ids: Sequence[str],
        model: str = "current-llm",
        source: str = "llm",
    ) -> RelationSubmission:
        try:
            document = _decode_document(payload)
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            return RelationSubmission((), (), (f"relation_payload_invalid:{error}",))

        raw_ids = document.get("catalog_record_ids")
        if not isinstance(raw_ids, list) or any(not isinstance(value, str) or not value.strip() for value in raw_ids):
            return RelationSubmission((), (), ("relation_catalog_record_ids_invalid",))
        record_ids = tuple(dict.fromkeys(value.strip() for value in raw_ids))

        items = document.get("relations")
        if not isinstance(items, list):
            return RelationSubmission(record_ids, (), ("relation_list_invalid",))

        known = frozenset(value for value in known_record_ids if isinstance(value, str))
        submitted = frozenset(record_ids)
        issues: list[str] = []
        if not submitted.issubset(known):
            unknown = sorted(submitted - known)
            issues.append(f"relation_catalog_hit_unknown:{','.join(unknown)}")
            return RelationSubmission(record_ids, (), tuple(issues))

        proposals: list[RelationProposal] = []
        seen: set[tuple[str, str, str]] = set()
        seen_pairs: dict[tuple[str, str], str] = {}
        for index, item in enumerate(items):
            try:
                if not isinstance(item, Mapping):
                    raise ValueError("relation item must be an object")
                from_id = _required_string(item, "from_record_id")
                to_id = _required_string(item, "to_record_id")
                if from_id not in submitted or to_id not in submitted:
                    raise ValueError("relation endpoint is not in catalog_record_ids")
                relation_type = _required_string(item, "relation_type")
                if relation_type == "cooccurrence":
                    raise ValueError("cooccurrence requires a real statistics source, not an LLM")
                if relation_type not in {"parent", "child", "related"}:
                    raise ValueError("unsupported semantic relation type")
                confidence = float(item["confidence"])
                rationale = _required_string(item, "rationale")
                evidence = _evidence(item.get("evidence"))
                signature = _canonical_signature(from_id, to_id, relation_type)
                if signature in seen:
                    raise ValueError("duplicate relation proposal")
                pair = tuple(sorted((from_id, to_id)))
                prior = seen_pairs.get(pair)
                if prior is not None and prior != signature[2]:
                    raise ValueError("conflicting relation types for the same endpoints")
                seen.add(signature)
                seen_pairs[pair] = signature[2]
                proposal_id = "rel:" + hashlib.sha256(
                    f"{from_id}|{to_id}|{relation_type}".encode()
                ).hexdigest()[:20]
                proposals.append(RelationProposal(
                    proposal_id,
                    from_id,
                    to_id,
                    relation_type,
                    "candidate",
                    confidence,
                    source,
                    rationale,
                    model,
                    evidence,
                ))
            except (KeyError, TypeError, ValueError) as error:
                issues.append(f"relation_{index}_invalid:{error}")
        return RelationSubmission(record_ids, tuple(proposals), tuple(issues))


def submit_relation_payload(
    payload: str | Mapping[str, Any],
    *,
    catalog: Catalog,
    overlay: RelationOverlay | str | Path | None = None,
    model: str = "current-llm",
    source: str = "llm",
) -> RelationSubmission:
    """Validate and persist the LLM's post-authoring relation submission."""

    known_record_ids = tuple(_catalog_record_ids(payload))
    if not all(catalog.has_record(record_id) for record_id in known_record_ids):
        unknown = sorted(record_id for record_id in known_record_ids if not catalog.has_record(record_id))
        return RelationSubmission(
            known_record_ids,
            (),
            (f"relation_catalog_record_unknown:{','.join(unknown)}",),
        )
    if isinstance(overlay, RelationOverlay):
        relation_overlay = overlay
    else:
        relation_overlay = RelationOverlay(overlay, record_exists=catalog.has_record)
    relation_overlay.bind(catalog.has_record)
    submission = RelationValidator().validate(
        payload,
        known_record_ids=known_record_ids,
        model=model,
        source=source,
    )
    if submission.issues:
        return submission
    save_issues = list(submission.issues)
    for proposal in submission.proposals:
        try:
            relation_overlay.save(proposal)
        except ValueError as error:
            save_issues.append(f"relation_save_failed:{proposal.proposal_id}:{error}")
    return RelationSubmission(submission.record_ids, submission.proposals, tuple(save_issues))


def relation_record_ids_from_hits(hits: Sequence[TagHit]) -> tuple[str, ...]:
    """Return the exact Catalog IDs that the LLM is allowed to reference."""

    return tuple(dict.fromkeys(hit.record_id for hit in hits))


def _decode_document(payload: str | Mapping[str, Any]) -> Mapping[str, Any]:
    if isinstance(payload, Mapping):
        document = payload
    elif isinstance(payload, str):
        text = payload.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        document = json.loads(text)
    else:
        raise TypeError("relation payload must be a JSON object or JSON string")
    if not isinstance(document, Mapping):
        raise ValueError("relation payload must be a JSON object")
    return document


def _catalog_record_ids(payload: str | Mapping[str, Any]) -> tuple[str, ...]:
    try:
        document = _decode_document(payload)
    except (TypeError, ValueError, json.JSONDecodeError):
        return ()
    values = document.get("catalog_record_ids")
    if not isinstance(values, list):
        return ()
    return tuple(dict.fromkeys(value.strip() for value in values if isinstance(value, str) and value.strip()))


def _required_string(item: Mapping[str, Any], key: str) -> str:
    value = item[key]
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be non-empty")
    return value.strip()


def _evidence(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or not value or any(not isinstance(item, str) or not item.strip() for item in value):
        raise ValueError("evidence must contain at least one non-empty item")
    return tuple(item.strip() for item in value)


def _canonical_signature(from_id: str, to_id: str, relation_type: str) -> tuple[str, str, str]:
    if relation_type == "child":
        return to_id, from_id, "parent"
    if relation_type == "related":
        return tuple(sorted((from_id, to_id))) + ("related",)
    return from_id, to_id, "parent"