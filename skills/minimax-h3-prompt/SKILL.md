---
name: minimax-h3-prompt
description: "Author model-native MiniMax H3 prompts for every official mode (T2VA / I2VA / FL2VA / L2VA / Ref2VA). The model supplies a structured story and (for reference modes) ordered asset paths; the pipeline renders the official dialect, audits it against hard gates, and reports token + character accounting. Returns the executable English prompt plus a parallel Chinese skeleton."
whenToUse: "User wants an H3 video prompt authored or validated. Use after creative direction is resolved (subject, action, ending, sound, references or keyframes). Do NOT use for H3 creative brief, asset role assignment, or multishot planning — those precede this skill."
---

# MiniMax H3 Prompt Authoring

Compiler with hard validation gates. Accepts a structured story, renders the official H3 dialect, audits the result against production gates, and reports exact token + character accounting.

This skill does not plan creative direction, translate prose, or execute workflows. Pass the result to `camera-video` to actually render.

## When to call

Call this skill after:

1. The user has decided what to make (subject, action, ending, sound).
2. The user has chosen a mode (T2VA / I2VA / FL2VA / L2VA / Ref2VA).
3. For reference modes, every uploaded asset has an assigned role.

Do not call this skill when the user is still choosing duration, visual style, aspect ratio, asset responsibility, or keyframe vs reference generation. Send those questions back to the host first.

## First principle

H3 is a video model with synchronized audio. The prompt's job is to specify what happens in each shot (`integrated_multimodal_description`), what the diegetic soundscape is (`overall_soundscape`), and what the non-diegetic score is (`non_diegetic_music`). The model owns the cut grammar; the prompt supplies content + per-shot audio. The validator enforces: sequential shot numbers, MM:SS.mmm cut timestamps, soundscape free of dialogue and non-diegetic words, music free of dialogue.

## Quick start

```bash
cat > story.json <<'JSON'
{
  "duration_seconds": 6,
  "shots": [
    {
      "what": "A woman walks through neon Tokyo at dusk.",
      "ambient": "city hum, distant traffic",
      "music": "low melancholic strings"
    }
  ]
}
JSON

<preset>\.venv\Scripts\minimax-h3-prompt.exe author \
    --stage t2va \
    --request story.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge
```

`result.text` is the executable English prompt; `result.text_zh` is the structural Chinese skeleton (prose verbatim English). `result.budget` reports token + character accounting.

## Mode routing

Pick exactly one stage via `--stage`. When in doubt, pick `ref2va` — it is the default and can express keyframe semantics through prompt-level anchoring.

| Stage | When |
|---|---|
| `t2va` | No reference image / video / audio. Pure text storyboard. |
| `i2va` | One image declared as a literal first frame. No reusable reference role on any image. |
| `fl2va` | Two images declared as first and last frames. No reusable reference role on either. |
| `l2va` | One image declared as a literal last frame. No reusable reference role. |
| `ref2va` | Any other image-based request (default), including ambiguous roles, ordinary "animate this image," identity / scene / style consistency, mixed image+video+audio references, source-video editing / continuation. |

Envelopes:

- `ref2va` accepts exactly 1 or 3 picture references
- `i2va` / `fl2va` / `l2va` accept 1 or 2 picture references and forbid video / audio references
- Audio cannot be the only reference type

For the full mode-selection matrix: [`references/official-capabilities-and-routing.md`](references/official-capabilities-and-routing.md).

## Request shape

`--stage` selects the mode; the request payload itself does **not** carry a stage field. Every other field is mandatory unless marked optional.

### Common fields (all stages)

```jsonc
{
  "duration_seconds": 9,                        // 4..15
  "shots": [
    {
      "what": "Neko stands on the rooftop at dusk, wind in her hair",
      "who": "Neko",                            // optional; ref2va: must match a reference
      "ambient": "city hum, wind",              // optional diegetic sound
      "music": "low melancholic strings",       // optional non-diegetic score
      "dialogue": "Hello there."                // optional; preserved byte-for-byte
    }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `duration_seconds` | float | yes | 4..15 inclusive |
| `shots` | array | yes | At least 1, max `1 + floor((duration - 1) / 3)` |
| `shots[].what` | string | yes | Visible content; pipeline adds `[Shot N]` + `At MM:SS.mmm, the camera cuts to …` |
| `shots[].who` | string | conditional | ref2va only; must equal a reference's `who` |
| `shots[].ambient` | string | no | Diegetic; joined with `"; "` into `overall_soundscape` |
| `shots[].music` | string | no | Non-diegetic; joined into `non_diegetic_music` |
| `shots[].dialogue` | string or `{text, language}` | no | Wrapped as `<d>[Language] text</d>`; language auto-detected if omitted |

Shot count cap by duration:

| `duration_seconds` | Max shots |
|---|---|
| 4–6 | 2–3 |
| 7–9 | 3 |
| 10–12 | 2–4 |
| 13–15 | 3–5 |

### Reference fields (stage-specific)

ref2va:
```jsonc
"references": [                               // exactly 1 or 3 entries
  { "kind": "picture", "who": "Neko", "image": "C:/refs/neko.png", "width": 1024, "height": 1024 }
]
```

i2va / fl2va / l2va:
```jsonc
"references": [                               // exactly 1 or 2 entries; `who` MUST be absent
  { "kind": "picture", "image": "C:/refs/first.png", "width": 1024, "height": 1024 }
]
```

ref2va optional video and audio references:
```jsonc
"videos": [                                   // ref2va only; max 3; each 2..15 s
  { "kind": "video", "label": "SourceA", "path": "C:/refs/source.mp4", "duration_seconds": 6 }
],
"audios": [                                   // ref2va only; max 3; each 2..15 s; cannot be sole ref
  { "kind": "audio", "label": "Bg", "path": "C:/bg.wav", "duration_seconds": 5 }
]
```

Mixed reference envelope caps: 9 images / 3 videos / 3 audios / 12 mixed files total.

### Multishot plan (optional)

For videos ≥ 10 s, write a complete plan in one JSON object and pass it via `--plan`. When `--plan` is supplied, `request.shots` is ignored; the plan's shots become the story. `duration_seconds`, `references`, `videos`, `audios`, and `stage` still come from the request.

```jsonc
{
  "total_duration": 12.0,
  "shot_count": 4,
  "edit_rhythm": "establishing to release",
  "continuity_strategy": "single subject, fixed rooftop",
  "shots": [
    {"shot": 1, "start": 0.0, "end": 3.0,  "content": "Neko lands on the rooftop at dusk.",
     "camera": "static shot", "transition": "opening", "sound_focus": "city hum, wind"},
    {"shot": 2, "start": 3.0, "end": 6.0,  "content": "Neko walks toward the antenna.",
     "camera": "truck right with small amplitude at slow speed", "transition": "cut",
     "sound_focus": "footsteps, wind"},
    {"shot": 3, "start": 6.0, "end": 9.0,  "content": "Neko reaches for the antenna.",
     "camera": "push in with large amplitude", "transition": "cut", "sound_focus": "wind"},
    {"shot": 4, "start": 9.0, "end": 12.0, "content": "Neko looks over the skyline.",
     "camera": "tilt up", "transition": "cut", "sound_focus": "city hum, distant traffic"}
  ],
  "continuity_ledger": {
    "identity": "Neko",
    "wardrobe_and_props": "black hoodie, silver antenna",
    "space_and_lighting": "rooftop, dusk, sodium lamp upper-left",
    "object_and_text_state": "antenna visible throughout",
    "dialogue_and_audio": "city hum, wind"
  }
}
```

Required plan fields: `total_duration` ∈ [4, 15], `shot_count` ≤ cap, `shots` length == `shot_count`, non-empty `shots[i].content`, `continuity_ledger` covers at least `identity` + `wardrobe_and_props`. If `start`/`end` provided, times must connect and the final end equals `total_duration`.

## Commands

Only one action: `author`. `--list-actions` returns `author`.

### `author`

```bash
# Plain request (single or multi-shot via `shots` array)
minimax-h3-prompt author \
    --stage t2va \
    --request story.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge

# Multishot plan for ≥ 10 s videos
minimax-h3-prompt author \
    --stage fl2va \
    --request story.json \
    --plan plan.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge

# Stage with reference images
minimax-h3-prompt author \
    --stage ref2va \
    --request story.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge
```

| Flag | Required | Notes |
|---|---|---|
| `--stage` | yes | `t2va` / `i2va` / `fl2va` / `l2va` / `ref2va` |
| `--request` | yes | Story JSON file |
| `--plan` | no | Multishot plan JSON; when set, `request.shots` is ignored |
| `--tokenizer-dir` | yes | Path to `skills/minimax-h3-prompt/knowledge` |

The host tool wrapper appends `--json`; the wire format is always the P1 envelope.

## Output

Success:

```json
{
  "ok": true,
  "command": "author",
  "stage": "t2va",
  "result": {
    "text": "<copyable English H3 prompt>",
    "text_zh": "<Chinese skeleton; structural tokens translated, prose verbatim>",
    "text_zh_meta": {
      "quality": "skeleton",
      "structural_tokens_translated": true,
      "prose_translated": false,
      "advisory": "Chinese skeleton only: structural tokens are translated, prose is verbatim English. The calling model is responsible for any literary Chinese translation on top of this skeleton."
    },
    "findings": [],
    "assumptions": [],
    "budget": {
      "text_tokens": 312,
      "char_count": 845,
      "char_limit": 7000,
      "quality_cap": 1200,
      "effective_cap": 1200,
      "over": false,
      "token_over": false,
      "char_over": false
    },
    "mode": "t2va",
    "stage": "t2va"
  },
  "errors": [],
  "advisories": []
}
```

Per-stage quality caps (tokens):

| Stage | Quality cap | Context window |
|---|---|---|
| `t2va` | 1200 | 262144 |
| `i2va` | 1500 | 262144 |
| `fl2va` | 1700 | 262144 |
| `l2va` | 1700 | 262144 |
| `ref2va` | 2400 | 262144 |

All stages also cap at 7000 characters.

## Failure modes

| Envelope `code` | Cause | Recovery |
|---|---|---|
| `h3_audit_failed` | `findings` is non-empty (shot numbers / timestamps / cut grammar / dialogue markup / ref2va label resolution) | Read `result.findings`, fix the story, re-run. **Never paste `findings` back into the H3 prompt.** |
| `budget_exceeded` | `result.budget.over == true` — `text_tokens > effective_cap` or `char_count > 7000` | Shorten `what`, drop shots, remove non-essential detail |
| `tokenizer_integrity_failed` | `knowledge/tokenizer.json` SHA-256 mismatch or schema drift | Re-run `setup.ps1` to refresh the snapshot |
| `official_envelope_violated` | Asset count or per-file size exceeds official limits | Reduce the asset set: ref2va ≤ 9 images / 3 videos / 3 audios / 12 mixed; audio cannot be sole ref |

`h3_audit_failed` example:

```json
{
  "ok": false,
  "command": "author",
  "stage": "t2va",
  "result": null,
  "errors": [{
    "code": "h3_audit_failed",
    "message": "generated prompt failed the H3 audit gates",
    "details": {"findings": ["shot numbers must be sequential starting at 1"]}
  }],
  "advisories": []
}
```

`budget_exceeded` example:

```json
{
  "ok": false,
  "command": "author",
  "stage": "t2va",
  "result": null,
  "errors": [{
    "code": "budget_exceeded",
    "message": "prompt uses 1320 tokens / 4218 chars, over the effective cap 1200 tokens / 7000 chars",
    "details": {"budget": {"text_tokens": 1320, "char_count": 4218, "effective_cap": 1200, "char_limit": 7000, "over": true}}
  }]
}
```

## Examples

### Example 1 — Minimal T2VA

```bash
cat > story.json <<'JSON'
{
  "duration_seconds": 8,
  "shots": [
    {"what": "A baker opens the shutters at sunrise.",
     "dialogue": "First batch of the morning."},
    {"what": "Steam rises from sliced bread."}
  ]
}
JSON

minimax-h3-prompt author --stage t2va --request story.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge
```

`result.text` (success):

```text
integrated_multimodal_description: [Shot 1] A baker opens the shutters at sunrise. <d>[English] First batch of the morning.</d> [Shot 2] At 00:04.000, the camera cuts to steam rises from sliced bread.

overall_soundscape: N/A

non_diegetic_music: N/A
```

### Example 2 — Multi-shot T2VA with escalating score (5 shots, 15 s)

```bash
cat > story.json <<'JSON'
{
  "duration_seconds": 15,
  "shots": [
    {"what": "Above a sea of clouds at dusk, two immortal peaks face each other; a white-robed sword immortal stands on one, a black-robed demon on the other; lightning flickers in the storm.",
     "ambient": "howling gale, rolling thunder, whistling sword energies",
     "music": "low epic strings, deep taiko drums and sparse guzheng plucks"},
    {"what": "the two figures leap and clash mid-air, swords colliding; a ring-shaped shockwave erupts, the left peak cracks, debris flies.",
     "ambient": "deafening clang of colliding swords, thunderous shockwave, tumbling boulders",
     "music": "fierce taiko drumming and sharp erhu strokes"},
    {"what": "the immortal forms hand seals; his sword splits into a thousand flying swords forming a colossal golden blade above the cloud sea.",
     "ambient": "rising sword qi hum, crackling lightning",
     "music": "swelling brass and rapid guzheng arpeggios"},
    {"what": "the colossal sword descends like a falling star and pierces the demon's black vortex; the barrier shatters in a spiderweb of cracks.",
     "ambient": "ear-splitting explosion, shattering stone",
     "music": "thundering full-orchestra climax with war drums and a crashing gong"},
    {"what": "the explosion fades, the right peak splits and crumbles into the abyss; the immortal lands alone on the remaining cliff.",
     "ambient": "fading rumble, distant avalanche, calm wind",
     "music": "sparse guzheng and soft strings, solemn resolution"}
  ]
}
JSON

minimax-h3-prompt author --stage t2va --request story.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge
```

Expected budget at this density: ~800 tokens / 3600 chars (under the 1200 / 7000 cap).

### Example 3 — I2VA with one first-frame image

```bash
cat > story.json <<'JSON'
{
  "duration_seconds": 6,
  "shots": [{"what": "The character turns toward the window as daylight fills the room."}],
  "references": [
    {"kind": "picture", "image": "C:/refs/first.png", "width": 1024, "height": 1024}
  ]
}
JSON

minimax-h3-prompt author --stage i2va --request story.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge
```

Note: `who` MUST be absent on the picture reference; the pipeline emits the I2VA alignment preamble before the three core fields.

### Example 4 — FL2VA with first + last frame

```bash
cat > story.json <<'JSON'
{
  "duration_seconds": 8,
  "shots": [{"what": "A rain-soaked cyclist opens an umbrella beside a bicycle."}],
  "references": [
    {"kind": "picture", "image": "C:/refs/first.png", "width": 1024, "height": 1024},
    {"kind": "picture", "image": "C:/refs/last.png",  "width": 1024, "height": 1024}
  ]
}
JSON

minimax-h3-prompt author --stage fl2va --request story.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge
```

The pipeline emits the FL2VA alignment preamble with `0.00-second` and `8.00-second` marks.

### Example 5 — Ref2VA with one identity reference

```bash
cat > story.json <<'JSON'
{
  "duration_seconds": 8,
  "shots": [{"what": "Neko stands on the rooftop at dusk, wind in her hair.", "who": "Neko"}],
  "references": [
    {"kind": "picture", "who": "Neko", "image": "C:/refs/neko.png", "width": 1024, "height": 1024}
  ]
}
JSON

minimax-h3-prompt author --stage ref2va --request story.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge
```

`who` must match `references[].who`. Ref2VA quality cap is 2400 tokens.

### Example 6 — Ref2VA with 3 references + a video source

```bash
cat > story.json <<'JSON'
{
  "duration_seconds": 8,
  "shots": [{"what": "Neko waves at Mei on the rooftop.", "who": "Mei"}],
  "references": [
    {"kind": "picture", "who": "Neko",    "image": "C:/refs/n.png", "width": 1024, "height": 1024},
    {"kind": "picture", "who": "Mei",     "image": "C:/refs/m.png", "width": 1024, "height": 1024},
    {"kind": "picture", "who": "Rooftop", "image": "C:/refs/r.png", "width": 1024, "height": 1024}
  ],
  "videos": [{"kind": "video", "label": "SourceA", "path": "C:/refs/source.mp4", "duration_seconds": 5}]
}
JSON

minimax-h3-prompt author --stage ref2va --request story.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge
```

### Example 7 — 12-second multishot plan

```bash
cat > story.json <<'JSON'
{ "duration_seconds": 12, "shots": [{"what": "ignored when --plan is used"}] }
JSON

cat > plan.json <<'JSON'
{
  "total_duration": 12.0,
  "shot_count": 4,
  "edit_rhythm": "establishing to release",
  "continuity_strategy": "single subject, fixed rooftop",
  "shots": [
    {"shot": 1, "start": 0.0, "end": 3.0,  "content": "Neko lands on the rooftop at dusk.",
     "camera": "static shot", "transition": "opening", "sound_focus": "city hum"},
    {"shot": 2, "start": 3.0, "end": 6.0,  "content": "Neko walks.",
     "camera": "truck right", "transition": "cut", "sound_focus": "footsteps"},
    {"shot": 3, "start": 6.0, "end": 9.0,  "content": "Neko reaches.",
     "camera": "push in", "transition": "cut", "sound_focus": "wind"},
    {"shot": 4, "start": 9.0, "end": 12.0, "content": "Neko looks.",
     "camera": "tilt up", "transition": "cut", "sound_focus": "city hum"}
  ],
  "continuity_ledger": {"identity": "Neko", "wardrobe_and_props": "black hoodie"}
}
JSON

minimax-h3-prompt author --stage fl2va --request story.json --plan plan.json \
    --tokenizer-dir <preset>/skills/minimax-h3-prompt/knowledge
```

## See also

- [`references/official-capabilities-and-routing.md`](references/official-capabilities-and-routing.md) — full mode envelope + product limits
- [`references/t2va-rules.md`](references/t2va-rules.md) — T2VA prompt content rules
- [`references/ref2va-rules.md`](references/ref2va-rules.md) — Ref2VA prompt content rules
- [`references/keyframe-rules.md`](references/keyframe-rules.md) — I2VA / FL2VA / L2VA prompt content rules
- [`references/budget-policy.json`](references/budget-policy.json) — machine-readable token caps
- [`../../docs/cli-cookbook.md`](../../docs/cli-cookbook.md) — every CLI invocation form
- [`../../docs/troubleshooting.md`](../../docs/troubleshooting.md) — error recovery
