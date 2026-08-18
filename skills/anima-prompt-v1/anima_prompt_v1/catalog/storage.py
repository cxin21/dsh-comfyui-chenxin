from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path


# Virgin schema: only what search actually reads.
# Dropped vs. legacy:
#   - concepts       : was a 1:1 copy of records with empty descriptions.
#   - facets          : was 31 rows re-encoding records.category a second time.
#   - record_facets   : join table for the dropped facets.
#   - relations       : base table held zero rows; the LLM overlay is a
#                       separate database and never needed this table.
# records.category stays - it is real single-value classification used by
# the category filter, not a redundant second copy.
SCHEMA = """
CREATE TABLE sources (
    source_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    uri TEXT NOT NULL,
    license TEXT NOT NULL,
    snapshot_version TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    checksum TEXT NOT NULL,
    raw_schema TEXT NOT NULL
);
CREATE TABLE records (
    record_id TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    prompt_form TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    language_names TEXT NOT NULL,
    confidence REAL,
    source_ids TEXT NOT NULL,
    provenance TEXT NOT NULL,
    usage_count INTEGER NOT NULL,
    deprecated INTEGER NOT NULL CHECK (deprecated IN (0, 1))
);
CREATE TABLE names (
    name_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES records(record_id),
    value TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    name_type TEXT NOT NULL CHECK (name_type IN ('canonical', 'alias', 'translation', 'historical')),
    language TEXT NOT NULL,
    source_id TEXT NOT NULL REFERENCES sources(source_id)
);
CREATE VIRTUAL TABLE catalog_fts USING fts5(
    name_id UNINDEXED,
    record_id UNINDEXED,
    value,
    normalized_value,
    tokenize='unicode61'
);
CREATE INDEX idx_records_canonical ON records(canonical_name);
CREATE INDEX idx_records_category ON records(category);
CREATE INDEX idx_names_normalized ON names(normalized_value);
CREATE INDEX idx_names_record ON names(record_id);
"""


class CatalogStore:
    @staticmethod
    def create_schema(connection: sqlite3.Connection) -> None:
        connection.executescript(SCHEMA)

    @staticmethod
    def connect_readonly(path: Path) -> sqlite3.Connection:
        uri = path.resolve().as_uri() + "?mode=ro&immutable=1"
        return sqlite3.connect(uri, uri=True)

    @staticmethod
    def integrity_check(path: Path) -> tuple[str, ...]:
        with closing(CatalogStore.connect_readonly(path)) as connection:
            return tuple(row[0] for row in connection.execute("PRAGMA integrity_check"))

    @staticmethod
    def schema_errors(path: Path) -> tuple[str, ...]:
        required = {
            "sources": ("source_id", "name", "uri", "license", "snapshot_version", "fetched_at", "checksum", "raw_schema"),
            "records": ("record_id", "canonical_name", "prompt_form", "category", "description", "language_names", "confidence", "source_ids", "provenance", "usage_count", "deprecated"),
            "names": ("name_id", "record_id", "value", "normalized_value", "name_type", "language", "source_id"),
        }
        errors: list[str] = []
        with closing(CatalogStore.connect_readonly(path)) as connection:
            for table, columns in required.items():
                actual = tuple(row[1] for row in connection.execute(f"PRAGMA table_info({table})"))
                if actual != columns:
                    errors.append(f"{table}: expected {columns}, got {actual}")
        return tuple(errors)
