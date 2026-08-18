from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

NameType = Literal["canonical", "alias", "translation", "historical"]


@dataclass(frozen=True)
class SourceInfo:
    source_id: str
    name: str
    uri: str
    license: str
    snapshot_version: str
    fetched_at: str
    checksum: str
    raw_schema: str


@dataclass(frozen=True)
class TagRecord:
    record_id: str
    canonical_name: str
    prompt_form: str
    category: str
    description: str
    language_names: tuple[str, ...]
    confidence: float | None
    source_ids: tuple[str, ...]
    provenance: tuple[str, ...]
    usage_count: int
    deprecated: bool


@dataclass(frozen=True)
class TagName:
    name_id: str
    record_id: str
    value: str
    name_type: NameType
    language: str
    source_id: str


@dataclass(frozen=True)
class CatalogStats:
    # Only counts that mean something. relations/concepts/facets counts were
    # always zero-or-redundant and are gone with their tables.
    records: int
    names: int
    fts_rows: int


@dataclass(frozen=True)
class TagHit:
    record_id: str
    canonical_name: str
    prompt_form: str
    category: str
    usage_count: int
    source: str
    source_version: str
    deprecated: bool
    match_type: str
    matched_name: str
    name_type: NameType
    score: float
    aliases: tuple[str, ...] = ()
    provenance: tuple[str, ...] = ()
