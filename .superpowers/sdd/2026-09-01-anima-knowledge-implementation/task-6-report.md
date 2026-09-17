# Task 6 Report — G1 relation validation chain + overlay lifecycle

**Status:** ✅ Complete · **Commit:** `96bb73a` (main) · **Build:** exit 0 · **Tests:** 54 files / 434 passed (13 new)

## Deliverables

- `plugins/prompt-master/src/pe-framework/anima-knowledge/relations.ts` (new, ~330 lines, pure library, zero logging)
- `plugins/prompt-master/tests/pe-framework/anima-knowledge/relations.test.ts` (new, 13 tests)

## Ported skill-source semantics (file → behavior)

### `relation_submission.py` (203 lines) → validation chain
| Source | Port |
|---|---|
| L198-203 `_canonical_signature` | `canonicalRelationSignature()`: `child` → `(to, from, 'parent')`; `related` → sorted endpoint pair; `parent` verbatim. Used for dedup (⑥) and same-pair conflict detection (⑦), **not** for proposal_id |
| L93-95 proposal_id | `proposalSignature()` = `'rel:' + sha256("{from_id}|{to_id}|{relation_type}").hexdigest()[:20]` — **raw (trimmed) endpoints**, exactly as source |
| L77-78 | `cooccurrence` rejected with source message "cooccurrence requires a real statistics source, not an LLM" |
| L79 | relation_type whitelist `{parent, child, related}` |
| L185-195 | `_required_string` trim semantics; `evidence` must be non-empty list of non-empty strings |
| L66, 85-92 | per-item chain order: endpoints → relation semantics → confidence → rationale/evidence → duplicate signature → conflicting relation types for same endpoint pair |

### `relation_overlay.py` (138 lines) → lifecycle
- SCHEMA ported verbatim (PK, CHECK constraints on relation_type/status/confidence, `UNIQUE(from_record_id, to_record_id, relation_type)`, both indexes).
- `_open()`: `mkdir -p` parent + apply SCHEMA — ported in `openOverlayDb()` (read-write `DatabaseSync`).
- `save()` UPSERT: `ON CONFLICT(from,to,relation_type) DO UPDATE SET proposal_id=excluded.proposal_id, status=CASE WHEN relation_proposals.status='accepted' THEN 'accepted' ELSE excluded.status END, …` — **accepted-no-downgrade protection** ported exactly; tested ("resubmit after accept keeps accepted").
- `list()` semantics: status filter (`all` default, matching CLI `--status` default), optional record_id `(from=? OR to=?)`, `ORDER BY confidence DESC, proposal_id LIMIT ?`.
- `set_status()`: `UPDATE … WHERE proposal_id=?`, rowcount≠1 → error `unknown relation proposal: <id>`; `accept`/`reject` map to `decideProposal()`.
- Per-operation open/close (source uses `closing(connection)`).

### `cli.py` (L200-225, L424-463) → defaults & path
- Default overlay path `<preset>/temp/anima-prompt-v1/relation-overlay.sqlite` (L427: `temp_dir('anima-prompt-v1') / 'relation-overlay.sqlite'`), derived from `resolveKnowledgePath` knowledge dir → preset root → `temp/` (env `ANIMA_OVERLAY_PATH` override + `setOverlayPath()` tmp injection, same pattern as `setCatalogPath`).
- `relation.submit` → validate, issues ⇒ nothing persisted; ok ⇒ candidate rows persisted. `relation.list` → status/record_id/limit. `relation.accept`/`relation.reject` → `{proposal_id, status}` envelope.

## Ambiguities resolved (source wins)

1. **proposal_id vs canonical signature** (brief test sketch implied reversed-pair equality on the signature): source computes proposal_id from raw endpoints while dedup uses the canonical signature. Ported both separately; `canonicalRelationSignature` exported so the normalization contract is directly testable. Reversed parent pairs are distinct proposals but hit the same overlay slot only when raw triples coincide (source UNIQUE is on raw `from,to,relation_type`, matching).
2. **Brief sketch path** `join(dirname(knowledge), '..','..','temp', …)` would resolve to `<root>/skills/temp/…` — wrong; followed cli.py L427 (`<preset>/temp/anima-prompt-v1/`) instead.
3. **`relation_submission.py` located at** `anima_prompt_v1/relation_submission.py` (not `catalog/` as stated in the task prompt).
4. **`submitProposal` surface**: brief input omits confidence/rationale/evidence which source requires. Added optional fields with defaults (`confidence 0.5`, `rationale 'post-authoring relation proposal'`, `evidence ['llm-submission']`) — documented deviation; Task 7 wrapper can surface them.
5. **Endpoint validation**: source uses `catalog.has_record`; TS equivalent per brief = `classify ∈ {canonical, alias}`. `submitProposal` requires an injected `classify` (pure library; Task 7 wires `classifyTag`), keeping this module free of the 783 MiB catalog dependency in unit tests.
6. **Batch dedup**: source validates within one submission payload; the brief surface is single-proposal. Per-call validation + `pending` array param preserves the check; cross-call dedup falls to overlay UNIQUE+UPSERT (same terminal state).

## Test evidence

- TDD: red first (`Failed to load url … relations.js`), then 13/13 green.
- New tests: proposal_id determinism + exact sha256 vector; canonical-signature normalization matrix (child↔parent swap, related sorted pair); endpoint missing; cooccurrence rejection; unsupported type; duplicate/conflict flags; valid ok. Lifecycle: submit→candidate→accept→accepted with status filters; reject; unknown proposal_id throws; idempotent duplicate (same proposal_id, 1 row); accepted-no-downgrade on resubmit; failed submit persists nothing; mkdir -p verified via tmp fixture.
- Full suite: `Test Files 54 passed (54) / Tests 434 passed (434)`; `tsc` exit 0.

## Deviations / concerns

- No other files touched (constraint held; `resolveKnowledgePath`/`anima-catalog` only imported, not modified — `MatchKind` type-only import from `anima-catalog.ts`).
- `submitProposal` does not hard-import `classifyTag` (deliberate: keeps the pure library testable; Task 7 must pass `classify: classifyTag`).
- `_overlayPathOverride` init reads `process.env.ANIMA_OVERLAY_PATH` at module load (same as `setCatalogPath` pattern).
- Minor process note: a mid-task `pwsh -replace | Set-Content` round-trip corrupted the file's UTF-8 encoding; detected by the tooling, deleted, and rewritten cleanly via the write tool — final committed content verified by build+full suite.
- Self-review: UPSERT conflict target is the UNIQUE triple (not `proposal_id` PK), matching source; per-op db open/close avoids leaked handles; no console output anywhere.
