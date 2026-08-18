from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Literal

from .facets import normalize
from .models import TagHit, TagRecord

# Search modes are exactly the MatchType values the engine can produce, plus
# `auto` for the cascade. `exact`/`related` are gone (exact was never emitted
# as a value; related had zero data). The fuzzy FTS query is OR + prefix-token
# (`"word"*`): a *discovery* mode for search-first, not a grounding basis -
# grounding only accepts canonical/alias exact matches.
Mode = Literal["auto", "canonical", "alias", "fuzzy"]


def _fts_query(value: str) -> str:
    # OR + prefix tokens: any word-root match is recalled, bm25 ranks the rest.
    # Turns fuzzy from "multi-word AND almost-always-miss" into a word-root
    # discovery engine (long black hair -> black_long_hair, expression ->
    # expressionless).
    return " OR ".join(f'"{part.replace(chr(34), "")}"*' for part in normalize(value).split() if part)


class Catalog:
    """Read-only tag dictionary. Lexical resolution only - no relations."""

    def __init__(self, database: str | Path | None = None) -> None:
        self.database = Path(database) if database else Path(__file__).parents[2] / "knowledge" / "tag-catalog.sqlite"

    def _open(self) -> sqlite3.Connection:
        uri = self.database.resolve().as_uri() + "?mode=ro&immutable=1"
        connection = sqlite3.connect(uri, uri=True)
        connection.row_factory = sqlite3.Row
        return connection

    def has_record(self, record_id: str) -> bool:
        with closing(self._open()) as connection:
            return connection.execute("SELECT 1 FROM records WHERE record_id=?", (record_id,)).fetchone() is not None

    def get_record(self, record_id: str) -> TagRecord:
        with closing(self._open()) as connection:
            row = connection.execute(
                "SELECT record_id, canonical_name, prompt_form, category, description, language_names, confidence, source_ids, provenance, usage_count, deprecated FROM records WHERE record_id=?",
                (record_id,),
            ).fetchone()
        if row is None:
            raise KeyError(f"unknown Catalog record: {record_id}")
        return TagRecord(
            row["record_id"], row["canonical_name"], row["prompt_form"], row["category"], row["description"],
            tuple(_json_list(row["language_names"])), row["confidence"], tuple(_json_list(row["source_ids"])),
            _json_provenance(row["provenance"]), row["usage_count"], bool(row["deprecated"]),
        )

    def search(
        self,
        query: str,
        *,
        mode: Mode = "auto",
        categories: tuple[str, ...] = (),
        sources: tuple[str, ...] = (),
        include_aliases: bool = True,
        include_deprecated: bool = True,
        limit: int = 20,
    ) -> list[TagHit]:
        normalized = normalize(query)
        if not normalized or limit < 1:
            return []
        if mode not in {"auto", "canonical", "alias", "fuzzy"}:
            raise ValueError(f"unsupported search mode: {mode}")
        modes = ("canonical", "alias", "fuzzy") if mode == "auto" else (mode,)
        if not include_aliases:
            modes = tuple(value for value in modes if value != "alias")
        with closing(self._open()) as connection:
            for current in modes:
                rows = self._query(connection, normalized, current, categories, sources, include_aliases, include_deprecated, limit)
                if rows:
                    return self._hydrate(connection, rows)[:limit]
        return []

    @classmethod
    def _query(cls, connection, query, mode, categories, sources, include_aliases, include_deprecated, limit):
        scope, params = cls._scope(connection, categories, sources, include_deprecated)
        if mode in {"canonical", "alias"}:
            score = "1000.0" if mode == "canonical" else "850.0"
            sql = (
                f"SELECT r.*, '{mode}' AS match_type, n.value AS matched_name, n.name_type, {score} AS score "
                f"FROM names n JOIN records r ON r.record_id=n.record_id "
                f"WHERE n.normalized_value=? AND n.name_type=?{scope} "
                f"ORDER BY r.usage_count DESC, r.record_id LIMIT ?"
            )
            return connection.execute(sql, [query, mode, *params, limit]).fetchall()
        # fuzzy
        fts = _fts_query(query)
        if not fts:
            return []
        name_type_clause = "" if include_aliases else " AND n.name_type='canonical'"
        sql = (
            "SELECT r.*, 'fuzzy' AS match_type, n.value AS matched_name, n.name_type, (500.0 - bm25(catalog_fts)) AS score "
            "FROM catalog_fts f JOIN names n ON n.name_id=f.name_id JOIN records r ON r.record_id=f.record_id "
            "WHERE catalog_fts MATCH ?" + name_type_clause + scope
            + " ORDER BY bm25(catalog_fts), r.usage_count DESC LIMIT ?"
        )
        return connection.execute(sql, [fts, *params, limit]).fetchall()

    @staticmethod
    def _scope(connection, categories, sources, include_deprecated):
        clauses: list[str] = []
        params: list[object] = []
        if categories:
            placeholders = ",".join("?" for _ in categories)
            clauses.append(f"r.category IN ({placeholders})")
            params.extend(categories)
        if sources:
            clauses.append("EXISTS (SELECT 1 FROM json_each(r.source_ids) WHERE value IN (" + ",".join("?" for _ in sources) + "))")
            params.extend(sources)
        if not include_deprecated:
            clauses.append("r.deprecated=0")
        return ((" AND " + " AND ".join(clauses)) if clauses else ""), params

    def _hydrate(self, connection, rows, extra_provenance: tuple[str, ...] = ()) -> list[TagHit]:
        hits = []
        for row in rows:
            aliases = connection.execute(
                "SELECT value FROM names WHERE record_id=? AND name_type='alias' ORDER BY normalized_value, name_id",
                (row["record_id"],),
            ).fetchall()
            source_ids = tuple(_json_list(row["source_ids"]))
            source = connection.execute(
                "SELECT name, snapshot_version, checksum FROM sources WHERE source_id=?",
                (source_ids[0] if source_ids else "",),
            ).fetchone()
            provenance = list(_json_provenance(row["provenance"]))
            if source:
                provenance.extend((f"source_name:{source[0]}", f"version:{source[1]}", f"checksum:{source[2]}"))
            provenance.extend(extra_provenance)
            hits.append(TagHit(
                row["record_id"], row["canonical_name"], row["prompt_form"], row["category"], row["usage_count"],
                source_ids[0] if source_ids else "", source[1] if source else "", bool(row["deprecated"]),
                row["match_type"], row["matched_name"], row["name_type"],
                float(row["score"]), tuple(item[0] for item in aliases), tuple(provenance),
            ))
        return hits

    def browse(self, *, categories=(), sources=(), include_aliases=True, include_deprecated=True, limit=20) -> list[TagHit]:
        if limit < 1:
            return []
        with closing(self._open()) as connection:
            scope, params = self._scope(connection, categories, sources, include_deprecated)
            rows = connection.execute(
                "SELECT r.*, CASE WHEN n.name_type='alias' THEN 'alias' ELSE 'canonical' END AS match_type, n.value AS matched_name, n.name_type, 0.0 AS score "
                "FROM names n JOIN records r ON r.record_id=n.record_id WHERE 1=1"
                + (" AND n.name_type IN ('canonical','alias')" if include_aliases else " AND n.name_type='canonical'")
                + scope + " ORDER BY r.record_id, n.name_type, n.name_id LIMIT ?",
                (*params, limit),
            ).fetchall()
            return self._hydrate(connection, rows)

    def stats(self) -> dict[str, int]:
        with closing(self._open()) as connection:
            return {key: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for key, table in (("records", "records"), ("names", "names"), ("fts_rows", "catalog_fts"))}


def _json_list(value: str) -> list[str]:
    import json
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return []
    return [str(item) for item in parsed] if isinstance(parsed, list) else []


def _json_provenance(value: str) -> tuple[str, ...]:
    import json
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return ()
    if isinstance(parsed, dict):
        return tuple(f"{key}:{parsed[key]}" for key in sorted(parsed))
    return tuple(str(item) for item in parsed) if isinstance(parsed, list) else ()
