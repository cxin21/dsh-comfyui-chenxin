# Catalog

The catalog is a read-only SQLite tag dictionary. It maps user strings to
their canonical prompt form. The catalog is not a model registry and not
a concept engine.

## Agent-side usage (mandatory contract)

The `anima-prompt-v1` skill treats the catalog as the single source of
truth for tag strings. Every authoring run MUST consult it before
committing a tag to a brief. See the parent skill's
[Authoring workflow](../SKILL.md#authoring-workflow-mandatory) for the
full 7-step contract; this chapter is the catalog-specific half of step 2
and step 3.

### What "lookup a tag" means for an agent

```bash
anima-prompt-v1 catalog.search "<tag the agent planned to write>" \
    --mode auto --limit 5 --json
```

Three outcomes and how to handle each:

| `match_type` | `record_id` | Action |
|---|---|---|
| `canonical` | non-null | Use the catalog's `prompt_form` verbatim in the brief. The `record_id` and `source` become a `citation` in the audit envelope. **This is the happy path.** |
| `alias` | non-null | The user's text was a synonym or historical variant. Use `prompt_form` verbatim. Same citation handling. |
| `fuzzy` | non-null, but `usage_count` low | **Reject.** `fuzzy` is a discovery tool, not a substitution. Do not write the original text into the brief. If `usage_count >= 1000` (well-attested in training data) the LLM may accept the rewrite, but it must record the choice and cite the new `record_id`. |
| `miss` | null | **Reject.** Do not write this string into the brief. Choose one of: (a) find a synonym via `catalog.search --mode auto` on a related term, (b) rewrite the slot so the tag is not needed, or (c) move the concept into `narrative` (free prose, not grounded). |

### Why "fuzzy" and "miss" are unsafe to commit

The author pipeline is fail-soft on catalog misses: it preserves the
user's text in the prompt and emits `catalog_miss:<tag>` in
`result.assumptions`. This is intentional — the pipeline should never
block authoring over a vocabulary gap. But for the LLM agent, a miss
is a **signal that the planned tag was based on assumption, not on
knowledge of Anima's vocabulary.** Committing it anyway turns the
audit trail into noise.

A `user-fuzzy` entry in `result.advisories` (e.g. `[warning]
tag_count_out_of_range: ...`) is a downstream symptom of the same root
cause: the prompt contains tags Anima's CLIP tokenizer handles weakly,
and the cumulative effect is dilution across the attention budget.

### Why `silver hair` is not in the catalog

A real-world example that surfaced this contract: an agent planned
`silver hair` for a "two women, one with silver hair" brief. The
catalog returned only `silvery_hair` (record_id `1092824`,
`match_type=canonical`). Anima was trained on Danbooru-style tag
conventions where hair colors use the `-y` suffix; the SDXL-trained
LLM in the agent defaulted to the SD1.5 vocabulary it learned
during its own training. The right move was to `catalog.search` first,
take the catalog's `prompt_form` (`silvery hair`), and re-run.

The catalog is not a synonym thesaurus — it is Anima's tag vocabulary
as actually used in its training data. The agent's training data is
not authoritative.

## Storage layers

```text
knowledge/tags.sqlite                 (source snapshot — read-only input to catalog.build)
   ↓ CatalogBuilder.build()
knowledge/tag-catalog.sqlite          (runtime database — read-only after build)
   ↓ Catalog.search() / browse() / stats()
   CLI + Python API
```

The runtime database has four tables (the legacy `concepts` / `facets` /
`record_facets` / `relations` tables were dropped in the v2 rewrite; the
design rationale is preserved in the git history).

| Table         | Purpose                                              |
|---------------|------------------------------------------------------|
| `sources`     | Origin provenance (snapshot version, checksum)       |
| `records`     | Canonical name, prompt form, category, usage count   |
| `names`       | Aliases, translations, historical variants           |
| `catalog_fts` | FTS5 index over `names.value` and `normalized_value` |

## Normalization

`catalog.facets.normalize(value)` is the single normalization function
shared by builder and search. It lowercases, replaces underscores with
spaces, and collapses whitespace. It is idempotent:

```python
normalize("Long_Black_Hair  ") == normalize("long black hair")  # True
```

The builder additionally strips surrounding whitespace and underscores
(`bodysuit_` → `bodysuit`, `_1girl` → `1girl`) before inserting.

## Search interface (Python)

```python
Catalog.search(
    query: str,
    *,
    mode: Literal["auto", "canonical", "alias", "fuzzy"] = "auto",
    categories: tuple[str, ...] = (),
    sources: tuple[str, ...] = (),
    include_aliases: bool = True,
    include_deprecated: bool = True,
    limit: int = 20,
) -> list[TagHit]
```

Auto cascade order: `canonical → alias → fuzzy`. The first mode that
returns any hits wins.

### MatchType values

| Value       | Meaning                                                                  |
|-------------|--------------------------------------------------------------------------|
| `canonical` | Exact normalized hit on the canonical name                               |
| `alias`     | Exact normalized hit on an alias, translation, or historical variant     |
| `fuzzy`     | FTS5 word-root hit (`long black hair` → `black long hair` via prefix)    |
| `miss`      | No hit in any mode                                                       |

Only `canonical` and `alias` justify substituting the user's text with
`prompt_form`. These are the `GROUNDED_MATCH_TYPES` that
`grounding.ground` and `composition.compose` both read. `fuzzy` is a
discovery tool: the LLM uses it to find word-root neighbors; the pipeline
never substitutes a fuzzy hit for the user's text.

### TagHit fields

```text
record_id, canonical_name, prompt_form, category, usage_count,
source, source_version, deprecated, match_type, matched_name,
name_type, score, aliases, provenance
```

Deprecated hits are returned by default; pass `include_deprecated=False`
to filter them out.

## Catalog CLI commands

```bash
anima-prompt-v1 catalog.search "<query>"             # mode=auto
anima-prompt-v1 catalog.search "<query>" --mode fuzzy
anima-prompt-v1 catalog.browse --category clothing
anima-prompt-v1 catalog.stats
```

Each command's signature, flag reference, and worked examples are below.

## Examples

### Example 1 — `catalog.search` exact canonical hit

```bash
anima-prompt-v1 catalog.search "1girl" --limit 1
```

Output (`hits[0]`):

```json
{
  "record_id": "10768",
  "canonical_name": "1girl",
  "prompt_form": "1girl",
  "category": "general",
  "usage_count": 100000000,
  "match_type": "canonical",
  "matched_name": "1girl",
  "name_type": "canonical",
  "score": 1000.0,
  "candidate": false
}
```

The LLM should put `prompt_form` (`1girl`) in the slot, not the original
query string. The `--limit 1` flag caps the hit count; omit it for the
default of 20.

### Example 2 — `catalog.search` alias substitution

```bash
anima-prompt-v1 catalog.search "voluptuous" --limit 1
```

Output (`hits[0]`):

```json
{
  "record_id": "...",
  "canonical_name": "curvy",
  "prompt_form": "curvy",
  "match_type": "alias",
  "candidate": false
}
```

The user wrote `voluptuous`; the catalog maps it to `curvy`. Fill the slot
with `curvy`, not `voluptuous`.

### Example 3 — `catalog.search` fuzzy discovery

```bash
anima-prompt-v1 catalog.search "expressionless mood" --mode fuzzy --limit 1
```

Output (`hits[0]`):

```json
{
  "canonical_name": "expressionless",
  "prompt_form": "expressionless",
  "match_type": "fuzzy",
  "candidate": true
}
```

`candidate: true` flags fuzzy hits. The LLM may pick this as inspiration
but should re-search in `auto` or `canonical` mode to confirm. If only
fuzzy matches exist, the tag is reported as a miss and preserved.

### Example 4 — `catalog.search` miss

```bash
anima-prompt-v1 catalog.search "asdfqwer"
```

Output:

```json
{"hits": []}
```

The pipeline records `catalog_miss: asdfqwer` and preserves the original
text in the prompt. Reword the tag, drop it, or move the concept to
`narrative`.

### Example 5 — `catalog.search` with category filter

```bash
anima-prompt-v1 catalog.search "armor" --category clothing --limit 5
```

Output: a list of `TagHit` records, all with `category: "clothing"`,
suitable for narrowing search to a clothing slot.

### Example 6 — `catalog.browse` by category

```bash
anima-prompt-v1 catalog.browse --category clothing --limit 10
```

Output: a list of 10 `TagHit` records, all with `category: "clothing"`,
suitable for exploring what's available before authoring. `browse` does
no matching; it scans the table directly.

### Example 7 — `catalog.stats`

```bash
anima-prompt-v1 catalog.stats
```

Output:

```json
{
  "stats": {
    "records": 12480,
    "names": 38420,
    "fts_rows": 38420
  }
}
```

`fts_rows` should equal `names`. A mismatch is a sign of catalog drift;
rebuild from `knowledge/tags.sqlite` (see
[`catalog-build.md`](catalog-build.md)).

## Catalog is read-only

The runtime catalog never changes during authoring. To add a tag, edit
`knowledge/tags.sqlite` and rebuild (see
[`catalog-build.md`](catalog-build.md)), or submit a relation proposal
(see [`relations.md`](relations.md)). The CLI never writes to the
runtime catalog.