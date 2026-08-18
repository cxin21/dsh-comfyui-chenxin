# Relation Overlay (post-authoring)

The relation overlay is a separate writable SQLite database for LLM
proposed semantic relations between catalog records. It is independent
from `knowledge/tag-catalog.sqlite` — submitting a proposal never mutates
the runtime catalog.

## When to use

Submit a proposal after authoring a brief if the LLM observed reusable
semantic structure that the catalog does not encode. Examples:

- A parent / child hierarchy that wasn't obvious from the source snapshot
  (e.g. `miko_costume` → `hatsune_miku`).
- A "related" link between two character tags that share an IP universe.

Do not use for:

- Cooccurrence statistics — these require a real corpus source, not an
  LLM proposal. The submission validator rejects
  `relation_type: "cooccurrence"`.
- New tags missing from the catalog — submit those via the catalog build
  pipeline, not the overlay.
- Single-use tag combinations inside one brief — these are not reusable
  relations.

## Relation types

| Type      | Meaning                                                    |
|-----------|------------------------------------------------------------|
| `parent`  | From → To expresses is-a (e.g. `magical_girl` → `girl`)    |
| `child`   | From → To expresses has-a (e.g. `hatsune_miku` → `twintails`) |
| `related` | From → To are semantically linked without hierarchy         |

`cooccurrence` is intentionally not allowed — cooccurrence requires a
real statistics source.

## Commands

### `relation.submit`

Validate and persist a structured proposal payload.

#### Signature

```bash
anima-prompt-v1 relation.submit \
    --database knowledge/tag-catalog.sqlite \
    --overlay knowledge/relation-overlay.sqlite \
    --payload proposal.json \
    [--model current-llm] \
    [--source llm]
```

| Flag         | Required | Purpose                                                            |
| ------------ | -------- | ----------------------------------------------------------------- |
| `--database` | yes      | Runtime catalog (used to validate endpoint record IDs)            |
| `--overlay`  | yes      | Writable overlay database (created if missing)                    |
| `--payload`  | yes      | JSON file matching the proposal schema below                      |
| `--model`    | no       | LLM model identifier; defaults to `current-llm`                  |
| `--source`   | no       | Proposal origin; defaults to `llm`                                |

#### Payload schema

```jsonc
{
  "catalog_record_ids": ["<record_id_1>", "<record_id_2>", ...],
  "relations": [
    {
      "from_record_id": "<record_id>",
      "to_record_id":   "<record_id>",
      "relation_type":  "parent" | "child" | "related",
      "confidence":     0.0..1.0,
      "rationale":      "non-empty string",
      "evidence":       ["non-empty string", ...]
    }
  ]
}
```

`catalog_record_ids` declares which record IDs the payload references;
every endpoint in `relations` must be a member. The validator rejects
unknown IDs.

#### Worked example

First, look up the record IDs you want to reference:

```bash
anima-prompt-v1 catalog.search "hatsune miku" --limit 1
# → record_id "33564"

anima-prompt-v1 catalog.search "twintails" --limit 1
# → record_id "9871"
```

Then write `proposal.json`:

```json
{
  "catalog_record_ids": ["33564", "9871"],
  "relations": [
    {
      "from_record_id": "33564",
      "to_record_id": "9871",
      "relation_type": "child",
      "confidence": 0.95,
      "rationale": "Hatsune Miku canonically wears twintails in every official design",
      "evidence": ["character design sheet 2007", "Crypton Future Media official art"]
    }
  ]
}
```

Submit:

```bash
anima-prompt-v1 relation.submit \
    --database knowledge/tag-catalog.sqlite \
    --overlay knowledge/relation-overlay.sqlite \
    --payload proposal.json
```

Output:

```json
{
  "ok": true,
  "command": "relation.submit",
  "result": {
    "record_ids": ["33564", "9871"],
    "proposals": [{
      "proposal_id": "rel:...",
      "from_record_id": "33564",
      "to_record_id": "9871",
      "relation_type": "child",
      "status": "candidate",
      "confidence": 0.95,
      "source": "llm",
      "rationale": "Hatsune Miku canonically wears twintails in every official design",
      "model": "current-llm",
      "evidence": ["character design sheet 2007", "Crypton Future Media official art"],
      "created_at": "...",
      "updated_at": "..."
    }],
    "issues": []
  },
  "errors": [],
  "advisories": []
}
```

#### Failure modes

| Error                              | Cause                                                                              | Recovery                                                            |
|------------------------------------|------------------------------------------------------------------------------------|---------------------------------------------------------------------|
| `relation_payload_invalid`         | JSON parse error or wrong shape                                                    | Validate the JSON shape against the payload schema above             |
| `relation_catalog_record_unknown`  | A record ID is not in the runtime catalog                                          | Re-run `catalog.search` to look up the correct ID                   |
| `relation_<index>_invalid`         | One of the relation items failed validation (e.g. `relation_type: "cooccurrence"`) | Fix the item and re-submit                                          |
| `relation_save_failed`             | Overlay DB conflict (proposal already exists with the same `(from, to, type)`)     | Drop the duplicate or update the existing proposal                  |

### `relation.list`

Read proposals from the overlay.

#### Signature

```bash
anima-prompt-v1 relation.list \
    --overlay knowledge/relation-overlay.sqlite \
    [--status candidate|accepted|rejected|all] \
    [--record-id <record_id>] \
    [--limit 100]
```

| Flag          | Required | Default     | Purpose                                                |
|---------------|----------|-------------|--------------------------------------------------------|
| `--overlay`   | yes      | —           | Overlay database to read                               |
| `--status`    | no       | `accepted`  | Filter by status                                       |
| `--record-id` | no       | (none)      | Filter to proposals involving this record (from or to) |
| `--limit`     | no       | `100`       | Max proposals to return                                |

#### Worked example

```bash
anima-prompt-v1 relation.list \
    --overlay knowledge/relation-overlay.sqlite \
    --status candidate --limit 50
```

Output:

```json
{
  "ok": true,
  "command": "relation.list",
  "result": {
    "proposals": [
      {"proposal_id": "rel:abc...", "from_record_id": "33564", "to_record_id": "9871", ...},
      ...
    ]
  }
}
```

### `relation.accept` / `relation.reject`

Flip a candidate proposal's status.

#### Signature

```bash
anima-prompt-v1 relation.accept --overlay knowledge/relation-overlay.sqlite <proposal_id>
anima-prompt-v1 relation.reject --overlay knowledge/relation-overlay.sqlite <proposal_id>
```

#### Worked example

```bash
# List candidates
anima-prompt-v1 relation.list \
    --overlay knowledge/relation-overlay.sqlite \
    --status candidate
# → pick a proposal_id, e.g. "rel:abc123..."

# Accept it
anima-prompt-v1 relation.accept \
    --overlay knowledge/relation-overlay.sqlite \
    rel:abc123...
```

Output:

```json
{
  "ok": true,
  "command": "relation.accept",
  "result": {"proposal_id": "rel:abc123...", "status": "accepted"}
}
```

Note: `relation.accept` does **not** promote the proposal into the
runtime catalog. It only flips the overlay status flag. Promotion into
the runtime catalog requires a separate `catalog.build` after editing
`knowledge/tags.sqlite`.

## End-to-end workflow

```text
   author brief (catalog.search → ground → compose)
            │
            ▼
   LLM observes reusable relation?
            │
       ┌────┴────┐
       no        yes
       │          │
       ▼          ▼
    done    relation.submit (payload)
                   │
                   ▼
              relation.list (review)
                   │
              ┌────┴────┐
              │         │
              accept    reject
              │
              ▼
         edit knowledge/tags.sqlite (if the relation reveals a missing tag or hierarchy)
                   │
                   ▼
              catalog.build + catalog.verify
```