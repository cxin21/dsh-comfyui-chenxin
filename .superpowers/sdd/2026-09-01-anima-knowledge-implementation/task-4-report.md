# Task 4 Report — G2 author payload projection (compileAnima 扩展)

**Status:** DONE
**Commit:** `3d55a19` — feat(prompt-master): G2 author payload projection (segments/phase_status/citations.source/metadata)
**Files:** `plugins/prompt-master/src/pe-framework/dialect/anima.ts`, `plugins/prompt-master/tests/plugin/compile-anima.test.ts` (only, per constraint)

## Verification
- New tests (brief Step 1, 3 cases): RED first (3 failed / 10 passed) → GREEN after implementation.
- Full suite: **418 passed (418), 53 files, 0 failed** (includes fidelity anima-brief-golden 13/13 byte-exact — the derived-string equivalence proof).
- `npm run build` (tsc): exit 0.
- Temp PRAGMA probe script deleted before commit; no logging added.

## Implementation notes
1. **Segments**: `pushSeg()` collects `{segment_id: segN, text, channel, origin, priority, slot, citation}` through all 5 stages — 3a policy=100 (pos+neg), 3b safety=99 origin policy, 3c base=200+slotIndex*50 + tagIndex (origin grounded when citation match_type ∈ {canonical,alias} else user-fuzzy, slot=slotName, citation attached), 3d narrative=2000, 3e exclusions=900 channel negative. segment_id included to mirror the Python `_segments_payload` golden shape.
2. **Byte-equality proof**: `positive`/`negative` are now derived from `segments.filter(channel).map(text).join(', ')` — the `positive: string[]` push accumulation was removed entirely (no dual source of truth). All 13 brief-golden byte-exact assertions pass, proving equivalence including edge cases (explicit safety-seed off, qualityPrefix off, exclusions).
3. **citations.source — real schema (not guessed)**: `PRAGMA table_info(sources)` shows columns `source_id, name, uri, license, snapshot_version, fetched_at, checksum, raw_schema` — **no `value` column**. The golden source string (`gelbooru_canonical:4dd87…`) is exactly `sources.source_id`, and `records.source_ids` is a JSON-array string, so the implemented query is:
   `SELECT s.source_id AS value FROM sources s JOIN records r ON r.record_id=? JOIN json_each(r.source_ids) je ON je.value=s.source_id LIMIT 1` (verified against the real catalog for record 10768). Lookup wrapped in try/catch → null (never blocks compile); only runs when record_id present; mock-search tests with fake record_ids simply get null.
4. **phaseStatus derivation** (key `phase_status` in the result — the brief's own Step-1 test asserts `raw.result.phase_status`, overriding the camelCase interface spelling in the plan text):
   - policy/composition: constant PASS (matches cli.py:266-271).
   - grounding: any citation with record_id → PASS else ADVISORY.
   - inspection: gates from `auditAnima` with severity critical, or important with rule ≠ `tag_count_out_of_range` → ADVISORY else PASS. **Documented deviation** (see Concerns).
5. **metadata**: `{variant}` + `subject` only when `slots.subject !== undefined` (brief test asserts exact `toEqual({variant:'aesthetic'})`).
6. **G6 rider**: `validateAnimaSlots` now accepts `subject` as optional-but-must-be-string.

## Concerns
1. **inspection tag_count exception (intentional deviation from the task text, required by the brief's own test)**: the task said inspection = gates.some(severity ∈ {important, conflict, critical}). But the plugin's `Severity` union is `critical|important|minor` (no `conflict` — TS2367 confirmed), and `tag_count_out_of_range` (important) fires for **any** brief under 12 content tags — including the brief's Step-1 fixture `{count_gender:['1girl']}`, which asserts `inspection:'PASS'`. Strictly counting `important` makes that test unpassable. Resolution: `tag_count_out_of_range` is excluded from the important+ class (it is a soft self-correction advisory in the SKILL.md closed loop). Side effect: for ex1-minimal/ex4-like briefs whose *only* important-class advisory is tag_count, our inspection reads PASS where the Python CLI golden says ADVISORY. All other important gates (lighting ban, mutual exclusion, duplicates, conflicts, weights) still demote to ADVISORY. If Python-verbatim inspection parity is later required, the golden phase_status for short briefs must change too — flagging for the captain/spec owner.
2. `segments[].citation` is attached for any existing citation (grounded or miss); the golden only exhibits grounded attachments, so miss-attachment is unverified against Python (harmless; not asserted by tests).
3. `compileAnima` now internally calls `auditAnima` (one extra search pass per tag with default limit 5) to derive inspection. Measured cost negligible (full suite runtime unchanged); no golden impact.
