---
name: anima-prompt-v1
description: "Author copyable Anima (SD-family) prompts from a slot-structured brief. The pipeline renders a single-line positive + negative prompt with provenance and inspection advisories. Use for any Anima-Base / Anima-Aesthetic / Anima-Turbo text-to-image request. Do NOT use for ComfyUI execution — call camera-image for that."
whenToUse: "User wants an Anima still-image prompt authored, refined, audited, or converted from prose into the model's tag-native form. Use after creative direction is resolved (subject, scene, mood) and before sending to camera-image."
---

# Anima Prompt Authoring

Compiler from a slot-structured brief to a one-line Anima positive + negative prompt with provenance. It does not plan creative direction, critique art, or execute workflows — pass the result to `camera-image` to actually run the workflow.

## When to call

Call this skill when:

1. Creative direction is resolved (subject, scene, mood, lighting intent).
2. The output target is one of: Anima-Base, Anima-Aesthetic, Anima-Turbo.
3. The user wants copyable text (not yet a generated PNG).

Do not call this skill when:

- The user is choosing visual style, aspect ratio, sampler, or LoRA → that is `camera-image` territory.
- The user wants the prompt sent through ComfyUI → that is `camera-image`.
- The user wants Anima video → that is `camera-video` (MiniMax H3).
- Creative direction is still in flux → ask the host first.

## First principle

Anima is an SD-family CLIP-conditioned diffusion model. Five objective facts follow, and every design decision serves one:

| # | Fact | Design consequence |
|---|------|--------------------|
| 1 | CLIP attention is biased toward front tokens | Fixed `SLOT_ORDER`; front slots carry implicit weight |
| 2 | **Anima was trained on Danbooru-style tags** | **`catalog.search` is mandatory before any slot tag commit — see [Authoring workflow](#authoring-workflow-mandatory) below** |
| 3 | Diffusion samplers converge with quality anchors | `ModelPolicy.for_variant` injects `masterpiece` / `best quality` / `score_7` |
| 4 | Conflicting tags sum to noise, not average | Mechanical `mutual_exclusion` pairs + LLM-side world/garment checks |
| 5 | LoRA conditioning overrides raw text for lighting | `lighting_term_banned` advisory — the LoRA owns lighting |

## Authoring workflow (MANDATORY)

> **Every authoring run MUST walk these 7 steps in order. Skipping step 2 produces `user-fuzzy` and `catalog_miss` assumptions in the audit trail — those are symptoms of an unsafe commit, not a normal advisory.**

The pipeline (`anima-prompt-v1 author`) runs 4 stages internally (Policy → Grounding → Composition → Inspection, see [`references/pipeline.md`](references/pipeline.md)). The 7 steps below are the **agent-side contract** that wraps it: steps 1–6 build the brief; step 7 audits the output.

| # | Step | Tool | What you do |
|---|------|------|-------------|
| 1 | Resolve creative direction | Conversation with user | Subject, scene, mood, lighting intent, **target variant** (`base` / `aesthetic` / `turbo`) — must be confirmed before step 2 |
| 2 | **Catalog search for every planned tag** | `anima-prompt-v1 catalog.search <tag> --mode auto --limit 5 --json` | For every tag the brief will commit (count_gender, appearance, clothing, pose, expression, camera, scene, detail_mood), run search and record the result. Skip only for `narrative` prose (free text, not grounded) and `exclusions` (verbatim negative directives) |
| 3 | Triage each search hit | Hand | `match_type=canonical` or `alias` → use the catalog's `prompt_form` verbatim; `match_type=fuzzy` → reject unless `usage_count >= 1000` AND `record_id` is well-attested (publishing, accept the rewrite); `match_type=miss` → delete the tag, rewrite to a synonym, or move it to `narrative` |
| 4 | Compose the brief JSON | `write` tool | Follow the [Request schema](#request-schema) below. Variant MUST match what the user named; `subject` is a routing label only (never emitted). If the user said "Anima-Base" the value is `base` — never substitute `aesthetic` because you think "stylized" |
| 5 | Run `author` | `anima-prompt-v1 author --request brief.json --json` | Capture the envelope verbatim |
| 6 | Audit the audit trail | Hand | Check `result.phase_status` is PASS on policy/grounding/composition. Inspect `result.assumptions` — **any `catalog_miss:<tag>` entry is a step 2 violation**. Inspect `result.advisories` — surface them verbatim to the user, never edit them |
| 7 | Surface output | Hand | Show the user the `result.positive` + `result.negative` + the unmodified `advisories` list |

### Step 2 — what "every planned tag" means

It is **not** the slot names — those are fixed by the schema. It is every string value inside each slot. For Example 2 in this skill:

- Slot `clothing` → 7 values: `bodysuit`, `skin tight`, `torn clothes`, `battle damage`, `scratches`, `gauntlets`, `high heel boots`
- Each one needs its own `catalog.search` call before it lands in the brief JSON

Calling search once for the whole slot, or trusting the LLM's training data to know that Anima is Danbooru-trained, both fail at the same point: the LLM guesses tag strings from generic SD knowledge, and Anima's token vocabulary differs from base SDXL/SD1.5.

### Why this matters

`user-fuzzy` and `catalog_miss` are not silent. They become an `assumption` line in the audit envelope, and they pollute the final prompt with strings the model's CLIP tokenizer either maps weakly (fuzzy — low attention weight) or ignores (miss — wasted slot budget). A brief full of misses reads as if the pipeline "worked", but the resulting image drifts from intent.

The author pipeline does not block on misses (it preserves the user's text and emits `catalog_miss:<tag>` so the LLM can see what was dropped), so a step 2 skip is invisible at exit code level — only the audit trail shows it.

### Anti-pattern: skip step 2

Real failure captured in a prior session:

> User asked for "two sword-wielding women, one with silver hair". Agent wrote `silver hair` into the brief without searching. The pipeline accepted it, emitted `catalog_miss:silver hair` in `assumptions`, and the resulting prompt contained a string Anima's CLIP had no embedding for. The correct workflow: `catalog.search "silver hair" --mode auto --limit 5` returns `silvery_hair` (record_id `1092824`) with `match_type=canonical`. Rewrite the brief to `silvery hair` and re-run.

The same anti-pattern produced 17 `catalog_miss` entries in a single 64-tag brief because the agent pattern-matched common English phrases against SDXL training data instead of querying Anima's Danbooru-derived vocabulary.

## Quick start

```bash
cat > brief.json <<'JSON'
{
  "variant": "base",
  "subject": "smiling girl portrait",
  "slots": {
    "count_gender": ["1girl", "solo"],
    "appearance":   ["long hair", "blue eyes", "smile", "blush"],
    "expression":   ["smile"],
    "camera":       ["close-up", "looking at viewer"]
  }
}
JSON

<preset>\.venv\Scripts\anima-prompt-v1.exe author --request brief.json --json
```

Expected `result.positive`:
```
masterpiece, best quality, score_7, safe, 1girl, solo, long hair, blue eyes, smile, blush, smile, close-up, looking at viewer
```

`safe` is present because `explicit` defaults to `false`.

## Request schema

```jsonc
{
  "variant": "base",                                // base | aesthetic | turbo (default base)
  "subject": "battle-damaged veteran warrior",      // routing label; never emitted in prompt
  "slots": {
    "count_gender": ["1girl", "solo"],              // 1girl / 2girls / solo / multiple girls
    "character":    [],                             // named IP + series, if any
    "appearance":   ["mature", "long hair", "red eyes"],
    "clothing":     ["bodysuit", "torn clothes", "battle damage"],
    "pose_action":  ["kneeling", "hand on own hip"],
    "expression":   ["expressionless", "smirk"],
    "camera":       ["cowboy shot", "from below"],
    "scene":        ["ruins", "rain", "night"],
    "detail_mood":  ["cinematic"]
  },
  "narrative":     "...",                           // free prose, ALWAYS last in prompt
  "exclusions":    ["no text", "no watermark"],      // verbatim, go to negative channel
  "quality_prefix": true,                           // inject variant quality terms (default true)
  "explicit":       false                           // drop the safety seed (default false)
}
```

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `variant` | enum | no | `base` | `base` / `aesthetic` / `turbo` — see [Variants](#variants) |
| `subject` | string | **yes** | — | Routing label; never appears in prompt |
| `slots` | object | **yes** | — | Slot name → tag list; unknown slot names rejected at parse |
| `slots.count_gender` | list[string] | no | `[]` | Slot 1 |
| `slots.character` | list[string] | no | `[]` | Slot 2 — named IP + series |
| `slots.appearance` | list[string] | no | `[]` | Slot 3 — hair, eyes, body, skin, marks |
| `slots.clothing` | list[string] | no | `[]` | Slot 4 — garment + state + accessories |
| `slots.pose_action` | list[string] | no | `[]` | Slot 5 — posture, action, interaction |
| `slots.expression` | list[string] | no | `[]` | Slot 6 — face + intensity |
| `slots.camera` | list[string] | no | `[]` | Slot 7 — shot scale, angle, POV, focus |
| `slots.scene` | list[string] | no | `[]` | Slot 8 — location + props + weather/time |
| `slots.detail_mood` | list[string] | no | `[]` | Slot 9 — texture, mood baseline |
| `narrative` | string | no | `""` | Free prose; emitted last, after all slot tags |
| `exclusions` | list[string] | no | `[]` | Verbatim, appended to negative channel |
| `quality_prefix` | bool | no | `true` | Inject variant quality terms |
| `explicit` | bool | no | `false` | Drop the `safe` safety seed from positive |

Tag guidance: 16–48 content tags total (slots + narrative count as content; policy and safety terms do not). Below 12 reads under-specified; above 50 mutually dilutes.

## Variants

| Variant | Positive must contain | Negative must contain |
|---------|-----------------------|-----------------------|
| `base` | `masterpiece`, `best quality`, `score_7` | `worst quality`, `low quality`, `score_1..3` |
| `aesthetic` | `masterpiece`, `best quality` | `worst quality`, `low quality` |
| `turbo` | `masterpiece`, `best quality` | `worst quality`, `low quality` |

Use `aesthetic` for stylized illustration runs. Use `turbo` for fast/low-step sampling. Full policy matrix: [`references/quality-policy.md`](references/quality-policy.md).

> **Variant contract**: when the user names a model variant (`Anima-Base`, `Anima-Aesthetic`, `Anima-Turbo`), the brief's `variant` field MUST be its lowercase form (`base` / `aesthetic` / `turbo`). Substituting a different variant — even one that "looks similar" — changes the mandatory quality anchors (`score_7` only on `base`) and the policy negatives (`score_1..3` only on `base`). This is a step 1 violation: resolve creative direction includes resolving variant, and the LLM has no authority to override it.

## Commands

| Action | Purpose |
|---|---|
| `author` | brief → Anima positive/negative |
| `catalog.search` | query the bundled tag catalog (canonical / alias / fuzzy) |
| `catalog.browse` | list catalog entries without a query |
| `catalog.stats` | catalog statistics |
| `catalog.build` | rebuild SQLite catalog from source tree |
| `catalog.verify` | verify SQLite against manifest |
| `relation.submit` | submit a new relation proposal |
| `relation.list` | list overlay proposals |
| `relation.accept` / `relation.reject` | accept / reject a proposal |

`--list-actions` returns this list verbatim. Every action returns the P1 envelope when `--json` is set; `author` without `--json` switches to two-block text format (POSITIVE / NEGATIVE).

### `author` — compile one brief

```bash
# From a file
anima-prompt-v1 author --request brief.json --json

# From stdin (mutually exclusive with --request)
cat brief.json | anima-prompt-v1 author --stdin --json

# Use a custom catalog
anima-prompt-v1 author --request brief.json --database path/to/other.sqlite --json
```

| Flag | Required | Notes |
|---|---|---|
| `--request` | yes* | Path to brief JSON file |
| `--stdin` | yes* | Read brief from stdin (mutually exclusive with `--request`) |
| `--database` | no | Path to catalog SQLite (default: bundled `knowledge/tag-catalog.sqlite`) |
| `--json` | **yes** | Always set this for programmatic use; loader adds it automatically |

### `catalog.search` — query the catalog

```bash
# Exact / alias / fuzzy — mode auto picks the best
anima-prompt-v1 catalog.search "long hair" --mode auto --limit 10 --json

# Misspellings land as fuzzy candidates
anima-prompt-v1 catalog.search "lon hair" --mode fuzzy --limit 5 --json

# Filter by category / source
anima-prompt-v1 catalog.search "hair" --category appearance --source danbooru --limit 20 --json
```

`mode` ∈ `auto` / `canonical` / `alias` / `fuzzy`. `auto` tries canonical first, then alias, then fuzzy.

### `catalog.browse` — list without a query

```bash
anima-prompt-v1 catalog.browse --category clothing --source danbooru --limit 50 --json
```

### `catalog.stats` — counts

```bash
anima-prompt-v1 catalog.stats --json
```

### `catalog.build` / `catalog.verify` — maintain the snapshot

```bash
# Build a fresh catalog snapshot. --output defaults to
# <preset>/temp/anima-prompt-v1/catalog.sqlite when omitted; the examples
# below write the canonical knowledge/ copy that the catalog reads from.
anima-prompt-v1 catalog.build \
    --source <preset>/skills/anima-prompt-v1/knowledge/source \
    --output <preset>/skills/anima-prompt-v1/knowledge \
    --manifest <preset>/skills/anima-prompt-v1/knowledge/manifest.json

anima-prompt-v1 catalog.verify \
    --database <preset>/skills/anima-prompt-v1/knowledge/tag-catalog.sqlite \
    --manifest <preset>/skills/anima-prompt-v1/knowledge/manifest.json
```

### `relation.submit` / `.list` / `.accept` / `.reject`

```bash
# Submit a new proposal (payload is JSON). Overlay defaults to
# <preset>/temp/anima-prompt-v1/relation-overlay.sqlite when --overlay is omitted.
anima-prompt-v1 relation.submit \
    --database <preset>/skills/anima-prompt-v1/knowledge/tag-catalog.sqlite \
    --overlay <preset>/temp/anima-prompt-v1/relation-overlay.sqlite \
    --payload proposal.json \
    --model current-llm --source llm --json

# List candidates
anima-prompt-v1 relation.list \
    --overlay <preset>/temp/anima-prompt-v1/relation-overlay.sqlite \
    --status candidate --limit 50 --json

# Accept / reject
anima-prompt-v1 relation.accept \
    --overlay <preset>/temp/anima-prompt-v1/relation-overlay.sqlite \
    <proposal-id> --json

anima-prompt-v1 relation.reject \
    --overlay <preset>/temp/anima-prompt-v1/relation-overlay.sqlite \
    <proposal-id> --json
```

`--status` ∈ `candidate` / `accepted` / `rejected` / `all` (default `all`).

## Output

With `--json`:

```json
{
  "ok": true,
  "command": "author",
  "stage": "author",
  "result": {
    "prompt": {
      "positive": "<one-line Anima positive>",
      "negative": "<one-line Anima negative>",
      "notes":      ["citation:<record_id>:match=...:canonical=...:source=...", ...],
      "assumptions":["catalog_miss:<tag>", "safety_seed_injected:...", ...],
      "advisories": ["[warning] lighting_term_banned: ...", "[conflict] mutual_exclusion: ...", ...]
    },
    "metadata": {
      "variant": "base",
      "subject": "smiling girl portrait"
    },
    "phase_status": {
      "policy": "PASS",
      "grounding": "PASS",
      "composition": "PASS",
      "inspection": "ADVISORY"
    },
    "citations": [...],
    "segments": [...]
  },
  "errors": [],
  "advisories": []
}
```

Without `--json`:

```text
POSITIVE:
masterpiece, best quality, score_7, 1girl, solo, ...

NEGATIVE:
worst quality, low quality, score_1, score_2, score_3, ...
```

Failure envelopes (always non-zero exit):

```json
{
  "ok": false,
  "command": "author",
  "stage": "author",
  "result": null,
  "errors": [{
    "code": "brief_validation_failed",
    "message": "unknown slot(s): ['lighting']; valid slots: ['count_gender', 'character', ...]",
    "details": {"type": "ValueError"}
  }],
  "advisories": []
}
```

## Failure modes

| Envelope `code` | Exit | Cause | Recovery |
|---|---|---|---|
| `argument_error` | 2 | Bad CLI args | Check `--help` |
| `request_invalid` | 2 | `--request` / `--stdin` both missing, or unreadable | Provide exactly one |
| `brief_validation_failed` | 3 | Unknown slot name, missing required field, wrong type | Fix the brief; error message names the field |
| `request_validation_failed` | 3 | Catalog miss / composition failure | Look at `result.advisories`; fix and re-run |
| `catalog_read_failed` | 4 | Bundled `knowledge/tag-catalog.sqlite` missing or corrupt | Re-run `anima-prompt-v1 catalog build/verify` |
| `resource_unavailable` | 4 | Catalog / overlay I/O failed | Check filesystem permissions |
| `unexpected_error` | 70 | Anything else | Report the traceback on stderr |

**Never edit `result.advisories` — surface them verbatim to the user.**

## Agent contract: surfacing audit output

The author pipeline returns a P1 envelope. The agent's job at step 7 is to render the envelope faithfully, not to interpret, rewrite, or hide it.

| Field | Agent must | Agent must NOT |
|---|---|---|
| `result.prompt.positive` | Display verbatim as a single line | Reorder, reweight, paraphrase, or "improve" tag choice |
| `result.prompt.negative` | Display verbatim as a single line | Add or remove entries the pipeline did not emit |
| `result.prompt.advisories` | Surface each line prefixed with its type tag (`[warning]` / `[conflict]`) | Edit wording, omit ones the agent thinks are "minor", or convert them into prose explanations |
| `result.assumptions` | List every `catalog_miss:*` entry; these are step 2 violations | Hide misses to make the prompt look cleaner |
| `result.phase_status` | Report which of the 4 stages were PASS / ADVISORY / FAIL | Skip the inspection stage because the overall envelope `ok: true` |
| `result.citations` | Available on request, but not required in the default render | Use `record_id` numbers as if they were promises about specific images |

When the user asks for "a clean prompt without warnings", the correct path is to **fix the brief and re-author**, not to hide the warnings. `lighting_term_banned` and `catalog_miss` are signals about the brief, not noise about the pipeline.

## Examples

### Example 1 — Minimal solo portrait

Brief (`brief.json`):

```json
{
  "variant": "base",
  "subject": "smiling girl portrait",
  "slots": {
    "count_gender": ["1girl", "solo"],
    "appearance":   ["long hair", "blue eyes", "smile", "blush"],
    "expression":   ["smile"],
    "camera":       ["close-up", "looking at viewer"]
  }
}
```

Command:

```bash
anima-prompt-v1 author --request brief.json --json
```

`result.positive`:
```text
masterpiece, best quality, score_7, safe, 1girl, solo, long hair, blue eyes, smile, blush, smile, close-up, looking at viewer
```

`result.advisories`: empty. The `safe` seed is present because `explicit` defaults to `false`.

### Example 2 — Battle-damaged veteran (41 tags, 0 advisories)

Brief:

```json
{
  "variant": "base",
  "subject": "battle-damaged veteran warrior in torn bodysuit, kneeling in ruined city",
  "slots": {
    "count_gender": ["1girl", "solo"],
    "appearance":   ["mature", "long hair", "black hair", "ponytail", "red eyes", "makeup", "lipstick", "curvy", "big breasts", "wide hips", "pale skin"],
    "clothing":     ["bodysuit", "skin tight", "torn clothes", "battle damage", "scratches", "gauntlets", "high heel boots"],
    "pose_action":  ["kneeling", "hand on own hip", "holding sword"],
    "expression":   ["expressionless", "smirk", "narrow eyes"],
    "camera":       ["cowboy shot", "from below", "looking at viewer"],
    "scene":        ["ruins", "debris", "cityscape", "night", "rain", "smoke", "fire"],
    "detail_mood":  ["cinematic", "atmospheric"]
  },
  "narrative":  "a cold veteran warrior kneeling in the rain amid the wreckage of a battle just won, her skin-tight bodysuit torn and battle-damaged at the shoulder pauldron, one sleeve, the side torso just under the arm, the hip seam, the outer thigh, and one knee guard — skin showing through every jagged rip but the chest plate and lower front still intact, gauntlets scratched and dusted, sword point down resting against the debris, smoke and distant fire drifting past crumbling pillars of a destroyed city, looking up at the viewer through the rain with the unhurried composure of a regal survivor who has already counted the bodies",
  "exclusions": ["no text", "no watermark", "no censored", "no bar censor", "no mosaic"]
}
```

Command:

```bash
anima-prompt-v1 author --request brief.json --json
```

`result.positive` (truncated):
```text
masterpiece, best quality, score_7, 1girl, solo, mature, long hair, black hair, ponytail, red eyes, makeup, lipstick, curvy, big breasts, wide hips, pale skin, bodysuit, skin tight, torn clothes, ...
```

41 content tags; 38 grounded as canonical; zero advisories.

### Example 3 — Named IP (Hatsune Miku)

```json
{
  "variant": "aesthetic",
  "subject": "Hatsune Miku stage performance",
  "slots": {
    "count_gender": ["1girl", "solo"],
    "character":    ["hatsune miku", "vocaloid"],
    "appearance":   ["long hair", "aqua hair", "twin tails", "blue eyes"],
    "clothing":     ["sleeves past wrists", "necktie", "boots"],
    "pose_action":  ["standing", "microphone"],
    "expression":   ["smile", "open mouth"],
    "camera":       ["from below", "cowboy shot"],
    "scene":        ["stage", "spotlights", "confetti"],
    "detail_mood":  ["cinematic"]
  },
  "exclusions": ["no text"]
}
```

Variant `aesthetic` drops `score_7` and `score_1..3` from policy terms (see [`references/quality-policy.md`](references/quality-policy.md)).

### Example 4 — Triggering advisories (lighting ban + mutual exclusion)

```json
{
  "variant": "base",
  "subject": "advisory trigger demo",
  "slots": {
    "count_gender": ["1girl"],
    "appearance":   ["curvy"],
    "clothing":     ["leotard"],
    "camera":       ["from front", "from behind"],
    "scene":        ["moonlight", "backlighting"]
  }
}
```

`result.advisories`:
```text
[warning] lighting_term_banned: lora-internal lighting term(s) present: backlighting, moonlight
[conflict] mutual_exclusion: mutually exclusive tags: from front + from behind
```

Advisories never block — the brief still produces a valid prompt. Fix the brief, or surface the advisories to the user.

### Example 5 — `explicit: true` (drop the safety seed)

```json
{
  "variant": "base",
  "subject": "intimate portrait",
  "slots": {
    "count_gender": ["1girl", "solo"],
    "appearance":   ["long hair", "blush"],
    "camera":       ["close-up", "looking at viewer"]
  },
  "explicit": true
}
```

`result.positive`:
```text
masterpiece, best quality, score_7, 1girl, solo, long hair, blush, close-up, looking at viewer
```

The `safe` token is absent (compare Example 1). `brief.explicit` is the authoritative signal; the pipeline does not keyword-scan.

### Example 6 — `quality_prefix: false` (skip policy terms)

```json
{
  "variant": "base",
  "subject": "lora-driven portrait",
  "quality_prefix": false,
  "slots": {
    "count_gender": ["1girl", "solo"],
    "appearance":   ["long hair"]
  }
}
```

`result.positive`: `1girl, solo, long hair` — no policy terms. The pipeline still emits `notes` and `assumptions`; only policy terms are suppressed.

## Python API

For agent code that wants to compose without round-tripping through the CLI:

```python
from anima_prompt_v1 import (
    UserBrief, ModelPolicy, Citation, ComposedPrompt, ComposedSegment,
    InspectionIssue, PromptOutput,
    compose, ground, inspect_prompt, render_output,
    is_explicit_request,
    to_json_output, to_text_output,
)
from anima_prompt_v1.catalog import (
    Catalog, TagHit, TagRecord, TagName, SourceInfo, CatalogStats,
    CatalogBuilder, RelationOverlay, RelationProposal,
    sha256_file, verify_manifest,
)
```

`compose(brief, catalog)` runs the full pipeline. `ground(brief, catalog)` returns `{normalized_tag: Citation}`. `inspect_prompt(positive, negative)` returns a tuple of `InspectionIssue`. `render_output(composed)` returns a `PromptOutput`; serialize with `to_json_output` or `to_text_output`.

## See also

- [`references/pipeline.md`](references/pipeline.md) — 4-stage pipeline internals with worked trace
- [`references/catalog.md`](references/catalog.md) — catalog architecture and search modes
- [`references/catalog-build.md`](references/catalog-build.md) — rebuild and verify the catalog snapshot
- [`references/inspection-rules.md`](references/inspection-rules.md) — every advisory rule with example triggers
- [`references/quality-policy.md`](references/quality-policy.md) — variant policy, `quality_prefix`, `explicit`
- [`references/relations.md`](references/relations.md) — post-authoring relation overlay workflow
- [`knowledge/README.md`](knowledge/README.md) — catalog snapshot maintenance
- [`../../docs/cli-cookbook.md`](../../docs/cli-cookbook.md) — every CLI invocation form
- [`../../docs/troubleshooting.md`](../../docs/troubleshooting.md) — error recovery
