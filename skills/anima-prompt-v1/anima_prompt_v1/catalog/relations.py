from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

RelationType = Literal["parent", "child", "related"]
RelationStatus = Literal["candidate", "accepted", "rejected"]


@dataclass(frozen=True)
class RelationProposal:
    proposal_id: str
    from_record_id: str
    to_record_id: str
    relation_type: RelationType
    status: RelationStatus
    confidence: float
    source: str
    rationale: str
    model: str | None = None
    evidence: tuple[str, ...] = ()
    created_at: str = ""
    updated_at: str = ""

    def __post_init__(self) -> None:
        for value, label in (
            (self.proposal_id, "proposal_id"),
            (self.from_record_id, "from_record_id"),
            (self.to_record_id, "to_record_id"),
            (self.source, "source"),
            (self.rationale, "rationale"),
        ):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{label} must be non-empty")
        if self.from_record_id == self.to_record_id:
            raise ValueError("relation proposal cannot target itself")
        if self.relation_type not in {"parent", "child", "related"}:
            raise ValueError("LLM relation proposals cannot create cooccurrence")
        if self.status not in {"candidate", "accepted", "rejected"}:
            raise ValueError(f"invalid relation status: {self.status!r}")
        if isinstance(self.confidence, bool) or not isinstance(self.confidence, (int, float)) or not 0 <= self.confidence <= 1:
            raise ValueError("confidence must be between 0 and 1")
        if not isinstance(self.evidence, tuple) or any(not isinstance(value, str) or not value.strip() for value in self.evidence):
            raise ValueError("evidence must be a tuple of non-empty strings")
