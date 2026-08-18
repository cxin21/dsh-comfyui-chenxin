from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from contextlib import closing
from pathlib import Path

from .facets import classify_category, normalize
from .models import CatalogStats
from .storage import CatalogStore

# Only the tables that survive the virgin schema. concepts / facets /
# record_facets / relations are gone.
_TABLES = ("sources", "records", "names")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_manifest(path: Path) -> bool:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("content_filters") is not False:
            return False
        for entry_name in ("source", "output"):
            entry = payload[entry_name]
            artifact = path.parent / entry["path"]
            checksum = entry["checksum"]
            if not isinstance(checksum, str) or len(checksum) != 64 or not artifact.is_file():
                return False
            int(checksum, 16)
            if sha256_file(artifact) != checksum:
                return False
    except (KeyError, TypeError, ValueError, OSError, json.JSONDecodeError):
        return False
    return True


def _clean_name(value: str) -> str:
    """Strip surrounding whitespace and underscores; leave interior underscores.

    'bodysuit_' -> 'bodysuit', '_1girl' -> '1girl', 'long_black_hair' stays.
    """
    if not value:
        return ""
    return value.strip().strip("_").strip()


class CatalogBuilder:
    def __init__(self, source: Path, output: Path) -> None:
        self.source = source
        self.output = output

    def build(self, *, manifest_path: Path | None = None) -> CatalogStats:
        if not self.source.is_file():
            raise FileNotFoundError(self.source)
        if self.source.resolve() == self.output.resolve():
            raise ValueError("output must not overwrite source")
        self.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.output.with_suffix(self.output.suffix + ".tmp")
        temporary.unlink(missing_ok=True)
        source = sqlite3.connect(f"file:{self.source.resolve().as_posix()}?mode=ro", uri=True)
        output = sqlite3.connect(temporary)
        try:
            output.execute("PRAGMA foreign_keys = ON")
            CatalogStore.create_schema(output)
            source_tables = {row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if {"tags", "aliases"} <= source_tables:
                self._build_from_raw_tags(source, output)
            else:
                self._copy_normalized(source, output)
            names = output.execute("SELECT name_id, record_id, value, normalized_value FROM names ORDER BY normalized_value, name_id").fetchall()
            output.executemany("INSERT INTO catalog_fts VALUES (?, ?, ?, ?)", names)
            output.commit()
            output.execute("VACUUM")
        finally:
            source.close()
            output.close()
        os.replace(temporary, self.output)
        stats = self._stats()
        if manifest_path is not None:
            self._write_manifest(manifest_path)
        return stats

    @staticmethod
    def _copy_normalized(source: sqlite3.Connection, output: sqlite3.Connection) -> None:
        # Only the surviving tables. A legacy catalog (with concepts/facets/
        # relations) will fail the column check on purpose - rebuild from the
        # raw tags.sqlite snapshot instead of carrying dead tables forward.
        for table in _TABLES:
            columns = tuple(row[1] for row in source.execute(f"PRAGMA table_info({table})"))
            if not columns:
                raise ValueError(f"source catalog missing required table: {table}")
            expected = tuple(row[1] for row in output.execute(f"PRAGMA table_info({table})"))
            if columns != expected:
                raise ValueError(f"source table {table} does not use the current schema")
            rows = source.execute(f"SELECT {', '.join(columns)} FROM {table} ORDER BY {', '.join(columns)}").fetchall()
            placeholders = ", ".join("?" for _ in columns)
            output.executemany(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})", rows)

    def _build_from_raw_tags(self, source: sqlite3.Connection, output: sqlite3.Connection) -> None:
        source_checksum = sha256_file(self.source)
        aliases_raw = source.execute("SELECT alias, tag_id, source FROM aliases ORDER BY tag_id, alias, source").fetchall()
        source_rows = set(source.execute("SELECT DISTINCT source, source_version FROM tags").fetchall())
        source_rows.update((alias_source, "unknown") for _alias, _tag_id, alias_source in aliases_raw)
        source_rows = sorted(source_rows)
        output.executemany(
            "INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (f"{name}:{version}", name, "", "unknown", version, "", source_checksum, "tags.sqlite + aliases")
                for name, version in source_rows
            ],
        )
        source_ids = {(name, version): f"{name}:{version}" for name, version in source_rows}

        tags = source.execute("SELECT tag_id, canonical, anima_form, category, usage_count, source, source_version FROM tags ORDER BY tag_id").fetchall()

        # Clean canonical names, then group by normalized form so that dirty
        # duplicates (bodysuit / bodysuit_, 1girl / _1girl) collapse into one
        # record instead of producing parallel score-1000 hits.
        groups: dict[str, list[dict]] = {}
        for tag_id, canonical, anima_form, source_category, usage_count, source_name, source_version in tags:
            clean_canonical = _clean_name(canonical)
            if not clean_canonical:
                continue
            norm = normalize(clean_canonical)
            prompt_form = _clean_name(anima_form) if anima_form else ""
            if not prompt_form:
                prompt_form = clean_canonical
            source_id = source_ids.get((source_name, source_version), f"{source_name}:{source_version}")
            groups.setdefault(norm, []).append({
                "tag_id": str(tag_id),
                "canonical": clean_canonical,
                "prompt_form": prompt_form,
                "category": classify_category(clean_canonical, source_category),
                "usage": int(usage_count or 0),
                "source_id": source_id,
            })

        # Primary per group: highest usage, then shortest canonical, then id.
        # Every dropped member's tag_id remaps to the primary so its aliases
        # survive instead of vanishing.
        remap: dict[str, str] = {}
        records: list[dict] = []
        for norm, members in groups.items():
            members.sort(key=lambda m: (-m["usage"], len(m["canonical"]), m["tag_id"]))
            primary = members[0]
            for member in members:
                remap[member["tag_id"]] = primary["tag_id"]
            records.append(primary)

        record_rows = []
        for rec in records:
            provenance = {"source_id": rec["source_id"], "raw_record_id": rec["tag_id"]}
            record_rows.append((
                rec["tag_id"], rec["canonical"], rec["prompt_form"], rec["category"], "", "[]", None,
                json.dumps([rec["source_id"]], ensure_ascii=False),
                json.dumps(provenance, ensure_ascii=False, sort_keys=True),
                rec["usage"], 0,
            ))
        output.executemany("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", record_rows)

        # Names: one canonical per record, plus aliases remapped to primaries,
        # cleaned, and de-duplicated by normalized form. An alias that collides
        # with a canonical name is dropped (the canonical wins).
        canonical_norms = set(groups.keys())
        names = []
        for rec in records:
            names.append((
                f"canonical:{rec['tag_id']}", rec["tag_id"], rec["canonical"],
                normalize(rec["canonical"]), "canonical", "", rec["source_id"],
            ))
        alias_seen: dict[str, tuple[str, str, str]] = {}
        for alias, tag_id, alias_source in aliases_raw:
            clean_alias = _clean_name(alias)
            if not clean_alias:
                continue
            norm = normalize(clean_alias)
            if norm in canonical_norms:
                continue
            mapped_id = remap.get(str(tag_id), str(tag_id))
            if norm not in alias_seen:
                alias_seen[norm] = (mapped_id, clean_alias, alias_source)
        alias_by_record: dict[str, list[tuple[str, str, str]]] = {}
        for norm, (mapped_id, value, alias_source) in alias_seen.items():
            alias_by_record.setdefault(mapped_id, []).append((norm, value, alias_source))
        index = 0
        for mapped_id, items in alias_by_record.items():
            for norm, value, alias_source in sorted(items, key=lambda x: x[0]):
                index += 1
                source_id = source_ids.get((alias_source, "unknown"), f"{alias_source}:unknown")
                names.append((f"alias:{mapped_id}:{index}", mapped_id, value, norm, "alias", "", source_id))
        output.executemany("INSERT INTO names VALUES (?, ?, ?, ?, ?, ?, ?)", names)

    def _stats(self) -> CatalogStats:
        with closing(CatalogStore.connect_readonly(self.output)) as connection:
            counts = {table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in (*_TABLES[1:], "catalog_fts")}
        return CatalogStats(counts["records"], counts["names"], counts["catalog_fts"])

    def _write_manifest(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        directory = path.parent.resolve()
        payload = {
            "content_filters": False,
            "source": {"path": _manifest_artifact_path(self.source, directory), "checksum": sha256_file(self.source)},
            "output": {"path": _manifest_artifact_path(self.output, directory), "checksum": sha256_file(self.output)},
        }
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _manifest_artifact_path(artifact: Path, directory: Path) -> str:
    try:
        return os.path.relpath(artifact.resolve(), directory)
    except ValueError:
        return str(artifact.resolve())
