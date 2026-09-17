# Task 2 Report — G3 catalog browse/stats/verify

**Status:** complete · **Commit:** `24e1874` (main, preset-root git)

## Shipped
- `plugins/prompt-master/src/pe-framework/anima-knowledge/browse.ts` — `browseCatalog({category?, source?, limit?})` (usage_count DESC scan, default limit 20; source filter via `json_each(records.source_ids)` ⋈ `sources.name`) + `catalogStats()` (records/names/ftsRows).
- `plugins/prompt-master/src/pe-framework/anima-knowledge/verify.ts` — `verifyCatalog()` with four independent try/catch'd checks: `checksum` (reuses `assertAnimaCatalog()` manifest sha256), `ftsParity` (COUNT(catalog_fts)==COUNT(names), detail `fts=N names=M`), `tables` (records/names/catalog_fts/sources via `catalogMeta()`), `schema` (required-column alignment vs storage.py SCHEMA; skipped per-table when table missing so `tables` owns that failure). Exports `VerifyCheck`/`VerifyResult`.
- `plugins/prompt-master/tests/pe-framework/anima-knowledge/browse-verify.test.ts` — 10 tests: 6 real-catalog positive (browse limit/default/category cross-checked against SQL COUNT/source filter, stats ≥1M with ftsRows===names, verify ok:true ×4 checks), 4 tmp-fixture failure branches (missing catalog_fts → tables+ftsParity fail; count mismatch → ftsParity fail w/ detail; well-formed tmp catalog + matching manifest → all pass; browse/stats on tmp).
- **Internal export (brief option a, noted):** `queryCatalogInternal(sql, params)` added to `dialect/anima-catalog.ts` — minimal read-only SQL channel reusing the shared handle cache, mtime reopen, and manifest once-check; `_db` itself stays unexported. Chosen over opening a second readOnly handle because it avoids double 783MiB-file handles and duplicate sha256 reconciliation.

## Verification
- TDD: red confirmed (module-not-found) before implementation.
- New file: 10/10 pass. Build (`tsc`) exit 0.
- Full suite: 412/412 pass, 53 files, exit 0 (one earlier run showed 8 failures under heavy parallel IO — the known flake documented in vitest.config.ts; clean rerun fully green).

## Notes / concerns
- Real-catalog `sources` data: first `LIMIT 1` source name (`danbooru`) maps to `danbooru:unknown`, which zero records reference; the test therefore selects a source name joined from an actual record's source_ids. Schema/join semantics are correct.
- Schema check is a required-column *subset* check (alignment), not full-column equality — deliberately looser than python `schema_errors` to tolerate additive columns.
- Zero logging in library code; tmp-fixture tests silence the expected `verifyManifestOnce` console.warn via spy and restore it.
