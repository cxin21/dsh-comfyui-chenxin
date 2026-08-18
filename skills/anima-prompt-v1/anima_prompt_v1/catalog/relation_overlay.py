"""Writable proposal overlay with endpoint and conflict validation."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable

from .relations import RelationProposal

SCHEMA = """
CREATE TABLE IF NOT EXISTS relation_proposals (
    proposal_id TEXT PRIMARY KEY,
    from_record_id TEXT NOT NULL,
    to_record_id TEXT NOT NULL,
    relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'child', 'related')),
    status TEXT NOT NULL CHECK (status IN ('candidate', 'accepted', 'rejected')),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    source TEXT NOT NULL,
    rationale TEXT NOT NULL,
    model TEXT,
    evidence TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (from_record_id, to_record_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_relation_overlay_from ON relation_proposals(from_record_id, status, relation_type);
CREATE INDEX IF NOT EXISTS idx_relation_overlay_to ON relation_proposals(to_record_id, status, relation_type);
"""


class RelationOverlay:
    def __init__(
        self,
        path: str | Path | None = None,
        *,
        record_exists: Callable[[str], bool] | None = None,
        record_ids: Iterable[str] | None = None,
    ) -> None:
        self.path = Path(path) if path else Path(__file__).parents[2] / "knowledge" / "relation-overlay.sqlite"
        if record_exists is not None and record_ids is not None:
            raise ValueError("provide record_exists or record_ids, not both")
        known = frozenset(record_ids) if record_ids is not None else None
        self._record_exists = record_exists or (lambda record_id: record_id in known if known is not None else False)
        self._has_validator = record_exists is not None or record_ids is not None

    def bind(self, record_exists: Callable[[str], bool]) -> "RelationOverlay":
        self._record_exists = record_exists
        self._has_validator = True
        return self

    def _open(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path)
        connection.executescript(SCHEMA)
        return connection

    def save(self, proposal: RelationProposal) -> None:
        if not self._has_validator:
            raise ValueError("relation overlay requires a Catalog endpoint validator")
        if not self._record_exists(proposal.from_record_id) or not self._record_exists(proposal.to_record_id):
            raise ValueError("relation proposal endpoints must exist in the Catalog")
        now = proposal.updated_at or proposal.created_at or datetime.now(timezone.utc).isoformat()
        created_at = proposal.created_at or now
        with closing(self._open()) as connection:
            try:
                connection.execute(
                    """INSERT INTO relation_proposals
                    (proposal_id, from_record_id, to_record_id, relation_type, status,
                     confidence, source, rationale, model, evidence, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(from_record_id, to_record_id, relation_type) DO UPDATE SET
                      proposal_id=excluded.proposal_id,
                      status=CASE WHEN relation_proposals.status='accepted' THEN 'accepted' ELSE excluded.status END,
                      confidence=excluded.confidence, source=excluded.source,
                      rationale=excluded.rationale, model=excluded.model,
                      evidence=excluded.evidence, updated_at=excluded.updated_at""",
                    (
                        proposal.proposal_id, proposal.from_record_id, proposal.to_record_id,
                        proposal.relation_type, proposal.status, proposal.confidence,
                        proposal.source, proposal.rationale, proposal.model,
                        json.dumps(proposal.evidence, ensure_ascii=False), created_at, now,
                    ),
                )
            except sqlite3.IntegrityError as error:
                raise ValueError(f"relation proposal conflicts with an existing relation: {error}") from error
            connection.commit()

    def list(self, *, status: str = "accepted", record_id: str | None = None, limit: int = 100) -> tuple[RelationProposal, ...]:
        if status not in {"candidate", "accepted", "rejected", "all"}:
            raise ValueError(f"invalid relation status: {status!r}")
        if limit < 1:
            return ()
        clauses: list[str] = []
        params: list[object] = []
        if status != "all":
            clauses.append("status=?")
            params.append(status)
        if record_id is not None:
            clauses.append("(from_record_id=? OR to_record_id=?)")
            params.extend((record_id, record_id))
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with closing(self._open()) as connection:
            rows = connection.execute(
                "SELECT proposal_id, from_record_id, to_record_id, relation_type, status, confidence, source, rationale, model, evidence, created_at, updated_at FROM relation_proposals" + where + " ORDER BY confidence DESC, proposal_id LIMIT ?",
                (*params, limit),
            ).fetchall()
        return tuple(_proposal(row) for row in rows)

    def set_status(self, proposal_id: str, status: str) -> None:
        if status not in {"candidate", "accepted", "rejected"}:
            raise ValueError(f"invalid relation status: {status!r}")
        with closing(self._open()) as connection:
            cursor = connection.execute(
                "UPDATE relation_proposals SET status=?, updated_at=? WHERE proposal_id=?",
                (status, datetime.now(timezone.utc).isoformat(), proposal_id),
            )
            if cursor.rowcount != 1:
                raise KeyError(f"unknown relation proposal: {proposal_id}")
            connection.commit()

    def accept(self, proposal_id: str) -> None:
        self.set_status(proposal_id, "accepted")

    def reject(self, proposal_id: str) -> None:
        self.set_status(proposal_id, "rejected")


def _proposal(row: tuple[object, ...]) -> RelationProposal:
    return RelationProposal(
        proposal_id=str(row[0]), from_record_id=str(row[1]), to_record_id=str(row[2]),
        relation_type=str(row[3]), status=str(row[4]), confidence=float(row[5]),
        source=str(row[6]), rationale=str(row[7]), model=str(row[8]) if row[8] is not None else None,
        evidence=tuple(json.loads(row[9])), created_at=str(row[10]), updated_at=str(row[11]),
    )
