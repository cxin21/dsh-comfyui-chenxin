# Authoring Pipeline (4 stages)

`anima-prompt-v1 author` runs four stages in order. Each stage has one
job; outputs are explicit. No stage reads another stage's mutable state —
they communicate through the dataclasses in `anima_prompt_v1/types.py`.

```text
Policy → Grounding → Composition → Inspection
```

## Stage 1 — Policy

**What it does**: decide which variant terms to inject. **What it reads**:
`brief.variant` only. Never reads user slot/narrative data.

`ModelPolicy.for_variant(variant)` returns the variant's
`mandatory_positive`, `mandatory_negative`, and `safety_seed` terms.

Variant → term mapping:

| Variant     | `mandatory_positive`                          | `mandatory_negative`                          |
|-------------|-----------------------------------------------|-----------------------------------------------|
| `base`      | `masterpiece`, `best quality`, `score_7`      | `worst quality`, `low quality`, `score_1..3`  |
| `aesthetic` | `masterpiece`, `best quality`                 | `worst quality`, `low quality`                |
| `turbo`     | `masterpiece`, `best quality`                 | `worst quality`, `low quality`                |

The safety seed (`safe`) is held back when `is_explicit_request(brief)` is
true; otherwise it is injected into positive. See
[`quality-policy.md`](quality-policy.md) for the full matrix.

## Stage 2 — Grounding

**What it does**: turn each slot tag into a `Citation`. **What it reads**:
the slot tags and the catalog.

`grounding.ground(brief, catalog)` walks every slot, looks up every tag
via `catalog.search(tag, mode="auto", limit=1)`, and produces a
`dict[normalized_tag, Citation]`.

- Canonical or alias hits → `Citation(record_id, canonical, prompt_form, source, match_type=...)`.
- Fuzzy or miss → `Citation(text=tag, match_type="miss")`. The original
  text is preserved; an assumption `catalog_miss:<tag>` is recorded for
  misses (de-duplicated by normalized key).

Exclusions and narrative are **not** grounded. Exclusions are negative
directives; narrative is free prose. See [`catalog.md`](catalog.md) for
search mode semantics.

## Stage 3 — Composition

**What it does**: emit positive and negative segment lists in the fixed
order. **What it reads**: the brief, the policy, the citations.

`composition.compose(brief, catalog)` returns a `ComposedPrompt`. The
positive channel is built in this order:

1. Policy mandatory positive (if `quality_prefix=true`).
2. Safety seed (if not explicit).
3. Slot tags in `SLOT_ORDER` (count_gender → character → appearance → clothing → pose_action → expression → camera → scene → detail_mood).
4. Narrative (always last).

Each slot tag uses `prompt_form` from its Citation if grounded (canonical
or alias), otherwise the original text. The negative channel is built
from policy mandatory negative + exclusions (verbatim).

`notes` contains one `citation:...` line per grounded tag. `assumptions`
contains one `catalog_miss:<tag>` line per missed tag (de-duplicated).

## Stage 4 — Inspection

**What it does**: report everything composition cannot guarantee.
**What it reads**: the composed positive and negative segment lists.

`inspection.inspect(positive, negative)` returns a tuple of
`InspectionIssue`. Findings are advisory only — they never block or
mutate. See [`inspection-rules.md`](inspection-rules.md) for the full
list of rules and example triggers.

| Code                         | Severity  | Triggered by                                       |
|------------------------------|-----------|----------------------------------------------------|
| `duplicate_segment`          | warning   | Same text appears twice in one channel             |
| `positive_negative_conflict` | conflict  | Same text appears in both positive and negative    |
| `unbalanced_parentheses`     | warning   | Mismatched `(` / `)` count in any segment          |
| `abnormal_weight`            | warning   | Weight value `> 4` in `(tag:N)` syntax             |
| `lighting_term_banned`       | warning   | Any of the lighting-ban terms in positive          |
| `mutual_exclusion`           | conflict  | Both halves of a banned pair in positive           |
| `tag_count_out_of_range`     | warning   | Content tags outside 12..50                        |

## Worked pipeline trace

Given the brief from Example 2 in `../SKILL.md`:

```text
Stage 1 (Policy, variant=base):
  mandatory_positive: (masterpiece, best quality, score_7)
  mandatory_negative: (worst quality, low quality, score_1, score_2, score_3)
  safety_seed:        (safe,)                 — held back because brief.explicit=true

Stage 2 (Grounding):
  citations (38 total, all canonical):
    "1girl"           → match_type=canonical, prompt_form="1girl"
    "solo"            → match_type=canonical, prompt_form="solo"
    "mature"          → match_type=canonical, prompt_form="mature"
    "long hair"       → match_type=canonical, prompt_form="long hair"
    "black hair"      → match_type=canonical, prompt_form="black hair"
    "ponytail"        → match_type=canonical, prompt_form="ponytail"
    "red eyes"        → match_type=canonical, prompt_form="red eyes"
    "makeup"          → match_type=canonical, prompt_form="makeup"
    "lipstick"        → match_type=canonical, prompt_form="lipstick"
    "curvy"           → match_type=canonical, prompt_form="curvy"
    "big breasts"     → match_type=alias,     prompt_form="big breasts"
    "wide hips"       → match_type=canonical, prompt_form="wide hips"
    "pale skin"       → match_type=canonical, prompt_form="pale skin"
    ... (25 more, all canonical)

Stage 3 (Composition):
  positive segments (priority order):
    policy[masterpiece, best quality, score_7]      priority=100
    slot[count_gender][1girl, solo]                  priority=200
    slot[appearance][mature, long hair, ...]        priority=300
    slot[clothing][bodysuit, ...]                    priority=400
    slot[pose_action][kneeling, ...]                priority=500
    slot[expression][expressionless, ...]           priority=600
    slot[camera][cowboy shot, ...]                  priority=700
    slot[scene][ruins, ...]                          priority=800
    slot[detail_mood][cinematic, atmospheric]       priority=900
    narrative                                        priority=1000

  negative segments:
    policy[worst quality, low quality, score_1..3]                     priority=100
    exclusions[no text, no watermark, no censored, no bar censor, no mosaic] priority=900

Stage 4 (Inspection):
  duplicate_segment:           none
  positive_negative_conflict:  none
  unbalanced_parentheses:      none
  abnormal_weight:             none
  lighting_term_banned:        none (no banned terms)
  mutual_exclusion:            none
  tag_count_out_of_range:      none (41 content tags within 12..50)
  → result.advisories = []

Stage 5 (Render):
  to_text_output(...)
  POSITIVE: masterpiece, best quality, score_7, 1girl, solo, mature, long hair, black hair, ponytail, red eyes, makeup, lipstick, curvy, big breasts, wide hips, pale skin, bodysuit, skin tight, torn clothes, battle damage, scratches, gauntlets, high heel boots, kneeling, hand on own hip, holding sword, expressionless, smirk, narrow eyes, cowboy shot, from below, looking at viewer, ruins, debris, cityscape, night, rain, smoke, fire, cinematic, atmospheric, <narrative>
  NEGATIVE: worst quality, low quality, score_1, score_2, score_3, no text, no watermark, no censored, no bar censor, no mosaic
```

The `priority` numbers come from `_build()` in `composition.py` and are
internal — they only encode the slot-order weight. The human output never
shows priorities.

## Pipeline stages ↔ Python API

| Stage       | Function                 | Returns                                  |
|-------------|--------------------------|------------------------------------------|
| Policy      | `ModelPolicy.for_variant`| `ModelPolicy`                            |
| Grounding   | `ground(brief, catalog)` | `dict[normalized_tag, Citation]`         |
| Composition | `compose(brief, catalog)`| `ComposedPrompt(positive, negative, ...)`|
| Inspection  | `inspect_prompt(pos, neg)`| `tuple[InspectionIssue, ...]`           |
| Render      | `render_output(composed)`| `PromptOutput(positive, negative, ...)`  |

The full CLI runs all five stages in one call. For Python-side use, the
stages compose naturally.