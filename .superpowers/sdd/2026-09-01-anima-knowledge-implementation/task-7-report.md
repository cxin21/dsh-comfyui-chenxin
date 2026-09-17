# Task 7 Report — G1 catalog_relations tool + G7 query extensions

**Status:** ✅ Complete · **Commit:** `70c3124` · **Suite:** 56 files / 453 tests passed · **Build:** tsc exit 0

## Scope delivered

### (a) `catalog_relations` tool — new `src/tools/catalog-relations.ts`
- Actions: `submit` / `list` / `accept` / `reject` / `status`, dispatched switch-style (mirrors catalog-search/profile-list patterns).
- Wraps Task 6 library verbatim: `submitProposal` / `listProposals` / `decideProposal` / `openOverlayDb` / `overlayPath`. Library layer stays zero-log; the tool logs one `[prompt-master] catalog_relations …` action summary per call via the optional `ctx.logger` pattern used by the other tools.
- **classify wired (T6 review carry-over):** `submitProposal(input, { classify: classifyTag, model })` — endpoint existence now resolves against the real 783MiB tag-catalog.
- Errors readable: validation issues → `relation submission rejected: issue1; issue2`; unknown proposal id / unknown action / missing action all throw with the offending value in the message.
- `status` returns `{path, counts{candidate,accepted,rejected}, overlay: available|unavailable}`.

### (b) G7 — `src/pe-framework/dialect/anima-catalog.ts`
- `CatalogQueryOptions.mode` extended to `'auto' | 'exact' | 'canonical' | 'alias' | 'fuzzy'` — single modes query one level directly (no cascade).
- New `categories?: string[]` (records.category, underscore/space-equivalent variants, parameterized `IN`) and `sources?: string[]` (`names.source_id` exact ∪ quoted-contains match on `records.source_ids` JSON text) filters, threaded through `exactQuery` and `fuzzyQuery`.
- `applyRelationOverlay` shell replaced by real overlay alias reads (`overlayAliasHits`): after the auto/exact cascade, reads **accepted** proposals from the overlay (`from_record_id = query tag`), resolves each `to_record_id` canonical→alias in the catalog, and appends hits marked `match_type: 'alias'` up to the remaining limit.
- **Canonical protection:** overlay resolution runs only after the catalog cascade; real canonical/alias hits always win (tested directly). Uses `relations.ts` `overlayPath()` so `setOverlayPath` / `ANIMA_OVERLAY_PATH` injection works; guarded by `existsSync` (no dir creation on the read path). No cycle: relations.ts imports only the `MatchKind` type.
- Golden untouched: with no overlay file the behavior is byte-identical; all fidelity/golden tests pass unmodified.

### (c) Registration — `src/plugin/index.ts`
- `registerCatalogRelationsTool(ctx, config)` registered alongside the other eight tools (tool count 8 → 9; `registry.test.ts` count assertion updated accordingly — the only pre-existing test touched, and it asserts registration, not fidelity).

## Tests (TDD, red→green verified)
- New `tests/plugin/catalog-relations.test.ts` (7): submit→list→accept→status round-trip on injected tmp overlay, reject + status filter, unknown endpoint / cooccurrence / unknown proposal / unknown+missing action readable errors, empty-overlay status.
- New `tests/pe-framework/dialect/anima-catalog.test.ts` (12): single-mode direct queries, categories/sources filter pass+drop, overlay alias appended after fuzzy (with room under limit), overlay in exact mode, canonical protection, no-overlay golden unchanged.

## Deviations / notes
- Brief pointed at `tests/pe-framework/dialect/anima-catalog.test.ts` as "单模式追加" — created there as instructed; the pre-existing catalog tests live in `tests/plugin/anima-catalog.test.ts` and were left untouched.
- Overlay append semantics: appended *after* cascade results, capped by `limit` (a fuzzy level that fills the limit leaves no append room — pinned by test).
- `plugin/registry.test.ts` tool-count literal updated 8→9 (registration contract, not golden).

## Review fix: overlay alias hits respect categories/sources filters (commit 89641cd)

- Finding: overlayAliasHits in searchCatalog cascade appended overlay rows without applying the new categories/sources filters.
- Option taken: **(a) real filtering** �� overlay resolution resolves targets via exactQuery, so the filter args are threaded straight through to the canonical/alias target queries (records JOIN gives per-record filtering). No exemption comment needed.
- Docs: CatalogQueryOptions.sources JSDoc + overlayAliasHits docstring updated to state overlay hits are filtered, not exempt.
- Test: new case in 	ests/pe-framework/dialect/anima-catalog.test.ts �� with an accepted overlay alias present and a categories (or sources) filter that excludes the target record, searchCatalog returns [] (control without filter returns the overlay hit).
- Verification: targeted files 20/20 green; 
pm run build exit 0; full suite 454/454 green.
