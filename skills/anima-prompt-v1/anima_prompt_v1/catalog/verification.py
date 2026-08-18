"""Deterministic Catalog integrity verification used by CLI and scripts."""

from __future__ import annotations

import json
from contextlib import closing
from pathlib import Path

from .builder import verify_manifest
from .storage import CatalogStore


def verify_catalog(database: Path, manifest: Path | None = None) -> list[str]:
    issues: list[str] = []
    issues.extend(CatalogStore.schema_errors(database))
    if CatalogStore.integrity_check(database) != ("ok",):
        issues.append("sqlite integrity check failed")
    try:
        with closing(CatalogStore.connect_readonly(database)) as connection:
            required = ("sources", "records", "names", "catalog_fts")
            present = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            issues.extend(
                f"missing schema object: {name}" for name in required if name not in present
            )
            if "catalog_fts" in present and "names" in present:
                fts_rows = connection.execute("SELECT COUNT(*) FROM catalog_fts").fetchone()[0]
                name_rows = connection.execute("SELECT COUNT(*) FROM names").fetchone()[0]
                if fts_rows != name_rows:
                    issues.append("FTS row count differs from names")
            if connection.execute("PRAGMA foreign_key_check").fetchall():
                issues.append("foreign key check failed")
    except OSError as error:
        issues.append(f"catalog read failed: {error}")

    if manifest is not None:
        if not verify_manifest(manifest):
            issues.append("manifest checksum or artifact validation failed")
        else:
            try:
                if json.loads(manifest.read_text(encoding="utf-8")).get("content_filters") is not False:
                    issues.append("content_filters must be false")
            except (OSError, ValueError, json.JSONDecodeError) as error:
                issues.append(f"manifest read failed: {error}")
    return issues
