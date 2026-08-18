# Rebuild and Verify the Catalog

The catalog is built once from `knowledge/tags.sqlite` (the source
snapshot) into `knowledge/tag-catalog.sqlite` (the runtime database).
Both files are checked in; you only rebuild when the source snapshot
changes.

## When to rebuild

- The source snapshot `knowledge/tags.sqlite` has been updated upstream.
- `catalog.verify` reports integrity failure.
- A maintainer adds or edits records in `knowledge/tags.sqlite`.

Do not rebuild just to refresh the runtime database. The runtime database
is deterministic from the source snapshot; rebuilding without a source
change produces an identical (modulo timestamps) artifact.

## `catalog.build`

Builds the runtime database from the source snapshot. Optionally writes a
SHA-256 manifest alongside.

### Signature

```bash
anima-prompt-v1 catalog.build \
    --source knowledge/tags.sqlite \
    --output knowledge/tag-catalog.sqlite \
    [--manifest knowledge/manifest.json]
```

| Flag         | Required | Purpose                                                       |
|--------------|----------|---------------------------------------------------------------|
| `--source`   | yes      | The snapshot SQLite (usually `knowledge/tags.sqlite`)         |
| `--output`   | yes      | Where to write the runtime database. Must not equal `--source` |
| `--manifest` | no       | Write a SHA-256 manifest file alongside the output            |

### What the build does

1. Open `--source` read-only via SQLite URI.
2. Open `--output` (a sibling `.tmp` file first; `os.replace` after commit).
3. Create the schema from `catalog.storage.SCHEMA` (sources / records / names / catalog_fts).
4. Either copy rows from a same-schema source, or rebuild from a raw
   `tags.sqlite` + `aliases` table (cleaning underscores, de-duplicating
   by normalized form, dropping alias-canonical collisions, remapping
   dropped members' aliases to the surviving primary).
5. Populate `catalog_fts` from `names`.
6. `VACUUM`.
7. If `--manifest` is given, write a JSON manifest with SHA-256
   checksums for both `--source` and `--output`.

### Worked example

Source snapshot already at `knowledge/tags.sqlite`. Build to a new
runtime database and write the manifest:

```bash
anima-prompt-v1 catalog.build \
    --source knowledge/tags.sqlite \
    --output knowledge/tag-catalog.sqlite \
    --manifest knowledge/manifest.json
```

Output:

```json
{
  "output": "C:\\path\\to\\knowledge\\tag-catalog.sqlite",
  "manifest": "C:\\path\\to\\knowledge\\manifest.json",
  "stats": {"records": 12480, "names": 38420, "fts_rows": 38420}
}
```

### Failure modes

| Failure                    | Cause                                                                | Recovery                                                                   |
|----------------------------|----------------------------------------------------------------------|----------------------------------------------------------------------------|
| `source missing`           | `--source` path does not exist                                       | Check the snapshot is checked in                                            |
| `source/output collision`  | The builder refuses to overwrite its own source                       | Pass a distinct `--output` path                                            |
| `schema mismatch`          | The source uses legacy tables (`concepts`/`facets`/`record_facets`/`relations`) | Fetch the latest raw `tags.sqlite` snapshot and rebuild              |

## `catalog.verify`

Validates the runtime database (and optionally the manifest).

### Signature

```bash
anima-prompt-v1 catalog.verify \
    --database knowledge/tag-catalog.sqlite \
    [--manifest knowledge/manifest.json]
```

| Flag         | Required | Purpose                                                          |
|--------------|----------|------------------------------------------------------------------|
| `--database` | yes      | The runtime catalog to verify                                    |
| `--manifest` | no       | Validate the manifest checksum and `content_filters: false`      |

### What verify checks

1. `sqlite3` integrity check.
2. Required schema objects present (sources / records / names / catalog_fts).
3. `catalog_fts` row count equals `names` row count.
4. Foreign key check passes.
5. If `--manifest` is given, validate SHA-256 checksums and the
   `content_filters: false` marker.

### Worked examples

Passing verify:

```bash
anima-prompt-v1 catalog.verify \
    --database knowledge/tag-catalog.sqlite \
    --manifest knowledge/manifest.json
```

Output:

```json
{
  "ok": true,
  "command": "catalog.verify",
  "result": {
    "database": "C:\\path\\to\\knowledge\\tag-catalog.sqlite",
    "manifest": "C:\\path\\to\\knowledge\\manifest.json",
    "issues": []
  },
  "errors": [],
  "advisories": []
}
```

Failing verify (drifted manifest checksum):

```bash
anima-prompt-v1 catalog.verify \
    --database knowledge/tag-catalog.sqlite \
    --manifest knowledge/manifest.json
```

Output:

```json
{
  "ok": false,
  "command": "catalog.verify",
  "errors": [{
    "code": "catalog_integrity_failed",
    "message": "Catalog verification failed",
    "details": {"issues": ["manifest checksum or artifact validation failed"]}
  }],
  "advisories": []
}
```

Recovery: re-run `catalog.build` to regenerate the runtime database and
manifest from the source snapshot.

Failing verify (FTS out of sync):

```json
{
  "errors": [{
    "code": "catalog_integrity_failed",
    "details": {"issues": ["FTS row count differs from names"]}
  }]
}
```

Recovery: rebuild from source. The FTS index is regenerated from
`names` on every build.

## Workflow

```text
   edit knowledge/tags.sqlite
            │
            ▼
   catalog.build --source knowledge/tags.sqlite \
                 --output knowledge/tag-catalog.sqlite \
                 --manifest knowledge/manifest.json
            │
            ▼
   catalog.verify --database knowledge/tag-catalog.sqlite \
                  --manifest knowledge/manifest.json
            │
            ▼
   author --request brief.json --database knowledge/tag-catalog.sqlite
```

See [`../knowledge/README.md`](../knowledge/README.md) for the
maintenance playbook (pre-flight check, end-to-end example, manifest
format reference).