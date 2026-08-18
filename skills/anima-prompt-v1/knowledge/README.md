# Catalog Snapshot Maintenance

`knowledge/tag-catalog.sqlite` is the runtime database the skill reads.
`knowledge/tags.sqlite` is the source snapshot it was built from. Both
are checked in. Rebuild only when the source snapshot changes.

## Files in this directory

| File                  | Role                                                              |
|-----------------------|-------------------------------------------------------------------|
| `tags.sqlite`         | Source snapshot (read-only input to `catalog.build`)              |
| `tag-catalog.sqlite`  | Runtime database (output of `catalog.build`)                      |
| `manifest.json`       | SHA-256 checksums; built alongside the database                   |
| `README.md`           | This file                                                         |

See [`../references/catalog-build.md`](../references/catalog-build.md) for
the build/verify command reference.

## When to rebuild

- The source snapshot `tags.sqlite` has been updated upstream.
- `catalog.verify` reports integrity failure.
- A maintainer adds or edits records in `tags.sqlite`.

Do not rebuild just to refresh the runtime database. The runtime database
is deterministic from the source snapshot; rebuilding without a source
change produces an identical (modulo timestamps) artifact.

## Workflow

### Step 1 — Pre-flight verify

```bash
anima-prompt-v1 catalog.verify \
    --database knowledge/tag-catalog.sqlite \
    --manifest knowledge/manifest.json
```

If `result.issues` is empty, the catalog is intact. Stop here.

### Step 2 — Rebuild

```bash
anima-prompt-v1 catalog.build \
    --source knowledge/tags.sqlite \
    --output knowledge/tag-catalog.sqlite \
    --manifest knowledge/manifest.json
```

The build writes a sibling `.tmp` file first, then `os.replace`s into
place. The runtime database is never in a partially-written state.

### Step 3 — Verify the rebuild

Re-run the verify command from Step 1. Confirm `result.issues` is empty.

### Step 4 — Smoke-test authoring

```bash
anima-prompt-v1 author \
    --request temp/anima-prompt-v1/curvy_warrior_v2_brief.json \
    --database knowledge/tag-catalog.sqlite
```

Confirm the output POSITIVE contains the expected grounded tags and that
`result.advisories` is empty.

## Worked end-to-end example

```bash
# Step 1: pre-flight
anima-prompt-v1 catalog.verify \
    --database knowledge/tag-catalog.sqlite \
    --manifest knowledge/manifest.json
# {"result": {"issues": []}}  → no rebuild needed

# (maintainer edits knowledge/tags.sqlite)

# Step 2: rebuild
anima-prompt-v1 catalog.build \
    --source knowledge/tags.sqlite \
    --output knowledge/tag-catalog.sqlite \
    --manifest knowledge/manifest.json
# {"result": {"stats": {"records": 12480, "names": 38420, "fts_rows": 38420}}}

# Step 3: verify
anima-prompt-v1 catalog.verify \
    --database knowledge/tag-catalog.sqlite \
    --manifest knowledge/manifest.json
# {"result": {"issues": []}}

# Step 4: smoke-test
anima-prompt-v1 author \
    --request temp/anima-prompt-v1/curvy_warrior_v2_brief.json \
    --database knowledge/tag-catalog.sqlite
# POSITIVE: masterpiece, best quality, score_7, 1girl, solo, mature, ...
# result.advisories: []
```

## Manifest format

`manifest.json` is regenerated on every build. Format:

```json
{
  "content_filters": false,
  "source":  {"path": "tags.sqlite",        "checksum": "<sha256>"},
  "output":  {"path": "tag-catalog.sqlite", "checksum": "<sha256>"}
}
```

`content_filters` is always `false` — the catalog is a tag dictionary,
not a content moderation layer. `verify_catalog` checks this marker and
fails if it is `true` or absent.

## Failure recovery

| Symptom                                                              | Cause                                                              | Fix                                                                              |
|----------------------------------------------------------------------|--------------------------------------------------------------------|----------------------------------------------------------------------------------|
| Build fails with `schema mismatch`                                   | Source uses legacy tables (`concepts`/`facets`/`record_facets`/`relations`) | Fetch the latest raw `tags.sqlite` snapshot                                      |
| Verify fails with `FTS row count differs from names`                 | `catalog_fts` index out of sync                                    | Rebuild from source                                                              |
| Verify fails with `manifest checksum or artifact validation failed`  | Runtime database or source was edited after the manifest was written | Rebuild                                                                         |
| Verify fails with `content_filters must be false`                    | Manifest's `content_filters` is `true` or missing                  | Edit `manifest.json` to set `content_filters: false`, then rebuild                |
| Author fails with `catalog_read_failed`                              | Runtime database missing or corrupt                                | Run `catalog.build` to regenerate it from `tags.sqlite`                          |