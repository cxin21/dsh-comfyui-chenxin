# Inspection Rules

Inspection reports findings; it never blocks or mutates. Every rule below
returns an `InspectionIssue` with a code, severity, and message. The LLM
decides whether to act on a finding: fix the brief and re-run, or surface
the advisory to the user verbatim.

## Severity levels

| Severity   | Meaning                                            |
|------------|----------------------------------------------------|
| `info`     | Informational; almost always safe to ignore        |
| `warning`  | Likely quality problem; usually worth fixing       |
| `conflict` | Mutually exclusive or impossible; must resolve     |

## `lighting_term_banned`

**Severity**: warning

Any of these terms appearing in a positive segment triggers the advisory:

```text
sunlight, moonlight, rim light, warm lighting, cool lighting,
golden hour glow, soft lighting, backlighting, god rays, light rays,
volumetric light, spotlight, candlelight, neon light, streetlights,
warm tone, cool tone, sepia, light particles, backlit
```

**Why**: the bundled LoRA owns lighting/tone. Adding these tags averages
with the LoRA's conditioning and produces muted output.

**Trigger**:

```json
{"slots": {"scene": ["moonlight", "backlighting"]}}
```

**Advisory**:

```text
[warning] lighting_term_banned: lora-internal lighting term(s) present: backlighting, moonlight
```

**Fix**: drop the lighting tag, or replace with a scene-level cue (e.g.
`night`, `fog`, `cinematic`).

## `mutual_exclusion`

**Severity**: conflict

Both halves of any of these pairs in positive:

```text
(from front, from behind)
(from above, from below)
(pov, full body)
(close-up, full body)
(looking at viewer, facing away)
```

**Trigger**:

```json
{"slots": {"camera": ["from front", "from behind"]}}
```

**Advisory**:

```text
[conflict] mutual_exclusion: mutually exclusive tags: from front + from behind
```

**Fix**: pick one per pair.

## `duplicate_segment`

**Severity**: warning

The same segment text appears twice in one channel.

**Trigger**:

```json
{"slots": {"appearance": ["long hair", "long hair"]}}
```

**Advisory**:

```text
[warning] duplicate_segment: duplicate segment in positive: long hair
```

**Fix**: drop the duplicate.

## `positive_negative_conflict`

**Severity**: conflict

The same text appears in both positive and negative. This usually means
an exclusion was mistyped or an LLM confused itself.

**Trigger**:

```json
{"slots": {"appearance": ["smile"]}, "exclusions": ["smile"]}
```

**Advisory**:

```text
[conflict] positive_negative_conflict: same phrase appears in positive and negative: smile
```

**Fix**: pick one side. The pipeline does not auto-resolve.

## `unbalanced_parentheses`

**Severity**: warning

Mismatched `(` / `)` count in any segment.

**Trigger**:

```json
{"slots": {"appearance": ["(long hair"]}
```

**Advisory**:

```text
[warning] unbalanced_parentheses: weight parentheses are unbalanced
```

**Fix**: balance the parens, or use position-weight instead of `(tag:N)`
syntax. The pipeline does not emit weight syntax itself; this advisory
catches LLM-authored weight-syntax slips.

## `abnormal_weight`

**Severity**: warning

A weight value `> 4` in `(tag:N)` syntax.

**Trigger**:

```json
{"slots": {"appearance": ["(long hair:10)"]}
```

**Advisory**:

```text
[warning] abnormal_weight: weight 10.0 is unusually large
```

**Fix**: stay within the `-2..2` working range, or drop the explicit
weight and use position-weight instead.

## `tag_count_out_of_range`

**Severity**: warning

Content tags (slots + narrative) outside the 12..50 working range.

**Trigger (3 tags)**:

```json
{"slots": {"count_gender": ["1girl"]}}
```

**Advisory**:

```text
[warning] tag_count_out_of_range: 3 content tags (working range 12-50)
```

**Fix**: add detail; aim for 16–48.

**Trigger (60 tags)**: same advisory fires with `60 content tags (working range 12-50)`.

**Fix**: trim redundant tags; aim for 16–48.

## `catalog_miss` (assumption, not advisory)

**Severity**: info (lives in `result.assumptions`, not `result.advisories`)

A slot tag did not ground as canonical or alias. The original text is
preserved; an assumption is recorded.

**Trigger**:

```json
{"slots": {"appearance": ["nonexistent_tag_xyz"]}}
```

**Assumption**:

```text
catalog_miss: nonexistent_tag_xyz
```

**Fix**: re-search with `catalog.search "nonexistent_tag_xyz" --mode fuzzy`
to find a word-root neighbor, or rewrite the tag, or move the concept to
`narrative`.

## LLM-side semantic checks (not in `inspection.py`)

These need judgment; they live in `../SKILL.md` as guidance, not as
mechanical rules.

- **Garment vs. undress** — `completely nude` + any specific clothing. Pick one.
- **Position conflict** — e.g. `missionary` + `doggystyle`. Pick one.
- **Body part focus** — same body part over-tagged (≤ 2 focus tags per part). Trim.
- **World mismatch** — ancient-CJK outfit + cyberpunk scene. Pick one world.