# MiniMax H3 Keyframe Rules (I2VA / FL2VA / L2VA)

## When to read

Read this when writing the prose for a pure keyframe story
(`i2va` / `fl2va` / `l2va`). The skill renders the mode-specific
alignment preamble before the three core fields; your job is to write
the `shots[].what` strings that describe the motion path through the
boundary frame(s).

## Eligibility gate

Use a keyframe mode only when **both** conditions are true:

1. the user explicitly declares each relevant image as a literal first
   frame, last frame, or first-and-last-frame pair;
2. none of those images also supplies reusable identity, character,
   person, object, costume, scene, style, action, camera, composition,
   voice, or other reference trait.

If either condition is absent or uncertain, use `ref2va` and encode
any frame role through a `<Picture N>` prompt-level anchor.

A boundary image **must not** carry `who`, `style`, or any other
reusable role — keyframe labels are positional
(`<Picture 1>`, `<Picture 2>`), not identity-bearing. The pipeline
rejects `references[*].who` for keyframe modes.

## Exact alignment preambles

### I2VA

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> ( from [Shot 1]) is fully referenced.
```

`<Picture 1>` is the actual first frame at 0.00 seconds and belongs to
`[Shot 1]`.

### FL2VA

```text
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.
```

Replace `N` with the actual final-shot number and `S.SS` with the
effective duration formatted to exactly two decimal places.

### L2VA

```text
How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.
```

Replace `N` with the actual final-shot number and `S.SS` with the
duration formatted to exactly two decimal places. `<Picture 1>` belongs
to the final shot, not to Shot 1.

## Mandatory structure

Each keyframe prompt consists of:

1. the alignment preamble (above);
2. one blank line;
3. the three official core fields: `integrated_multimodal_description`,
   `overall_soundscape`, `non_diegetic_music`.

## Shared base rules

- Start `[Shot 1]` with style and initial composition. Do not timestamp it.
- Format later cuts as `[Shot N] At MM:SS.mmm, ...` with strictly increasing times inside the duration.
- Prefer camera movement over a cut for modest angle or distance changes.
- Use mechanically correct camera terms: Zoom vs Push, Pan vs Truck, Tilt vs Pedestal.
- Assign stable `(Sx)` IDs only to actual vocal sources.
- Put exact dialogue or lyrics inside `<d>[Language] ...</d>`.
- Preserve visible text in English double quotation marks without translation.
- Put synchronized dialogue, singing, diegetic music, and decisive sound events in the main timeline.
- Summarize ambience, physical action sounds, and non-verbal human sounds in `overall_soundscape`.
- Describe audience-only music by instrumentation, tempo / rhythm, and dynamics in `non_diegetic_music`.

## Motion paths

### I2VA

`first-frame anchor → action onset → continuous development → result or reaction`

### FL2VA

`first-frame state → observable intermediate changes → progressively narrowing differences → exact last-frame state`

Do not merely describe two static images. Explain how poses, objects,
lighting, camera, and composition transform between them.

### L2VA

`plausible preceding state → explicit causal action → gradual convergence → exact final-frame landing`

Do not begin in the final state. Infer a compatible earlier state and
show how it becomes the reference frame.

## API boundary

The current MiniMax H3 API treats keyframe generation and multimodal
reference generation as mutually exclusive input combinations. A request
containing any `reference_image`, `reference_video`, or
`reference_audio` role cannot also contain `first_frame` or
`last_frame` roles. Use ref2va when references and semantic picture
anchoring must be combined.

## Examples

### Example — I2VA

Input request (the `--stage i2va` flag is passed separately):

```json
{
  "duration_seconds": 6,
  "shots": [
    { "what": "Live-action, cinematic, the young woman shown in <Picture 1> remains beside the rain-covered train window, preserving her appearance, clothing, seat position, and the carriage layout. The camera trucks right with small amplitude at slow speed as she lifts her gaze from the folded letter toward the passing city lights. Her reflection moves across the glass." }
  ],
  "references": [
    { "kind": "picture", "image": "C:/refs/first.png", "width": 1024, "height": 1024 }
  ]
}
```

Rendered prompt (`text`):

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, the young woman shown in <Picture 1> remains beside the rain-covered train window, preserving her appearance, clothing, seat position, and the carriage layout. The camera trucks right with small amplitude at slow speed as she lifts her gaze from the folded letter toward the passing city lights. Her reflection moves across the glass.

overall_soundscape: N/A

non_diegetic_music: N/A
```

### Example — FL2VA

Input request (the `--stage fl2va` flag is passed separately):

```json
{
  "duration_seconds": 8,
  "shots": [
    { "what": "Live-action, cinematic, a rain-soaked cyclist begins in the position and framing established by Picture 1, holding a closed black umbrella beside a silver bicycle. The camera pulls out with small amplitude at slow speed as she releases the bicycle handle, raises the umbrella above her shoulder, and presses the runner upward until the canopy opens. Water rolls from the expanding fabric while she steps beneath it, rotates the handle into the final angle, and settles into the pose, spacing, and composition established by Picture 2 at the end of the shot." }
  ],
  "references": [
    { "kind": "picture", "image": "C:/refs/first.png", "width": 1024, "height": 1024 },
    { "kind": "picture", "image": "C:/refs/last.png",  "width": 1024, "height": 1024 }
  ]
}
```

Rendered prompt (`text`):

```text
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 8.00-second mark of the target video.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, a rain-soaked cyclist begins in the position and framing established by Picture 1, holding a closed black umbrella beside a silver bicycle. The camera pulls out with small amplitude at slow speed as she releases the bicycle handle, raises the umbrella above her shoulder, and presses the runner upward until the canopy opens. Water rolls from the expanding fabric while she steps beneath it, rotates the handle into the final angle, and settles into the pose, spacing, and composition established by Picture 2 at the end of the shot.

overall_soundscape: N/A

non_diegetic_music: N/A
```

### Example — L2VA

Input request (the `--stage l2va` flag is passed separately):

```json
{
  "duration_seconds": 6,
  "shots": [
    { "what": "Live-action, cinematic, a close shot begins with an intact drinking glass near the edge of a dark wooden table, while the same hand and sleeve visible in <Picture 1> approach from the right. The camera pushes in with small amplitude at slow speed as the fingertips strike the rim. The glass tips, falls, and hits the floor with a sharp impact; cracks spread through it as fragments slide outward. Toward the end, the moving pieces lose momentum and settle into the exact broken arrangement, hand position, camera angle, lighting, and final composition established by <Picture 1>." }
  ],
  "references": [
    { "kind": "picture", "image": "C:/refs/last.png", "width": 1024, "height": 1024 }
  ]
}
```

Rendered prompt (`text`):

```text
How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 6.00-second mark of the target video.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, a close shot begins with an intact drinking glass near the edge of a dark wooden table, while the same hand and sleeve visible in <Picture 1> approach from the right. The camera pushes in with small amplitude at slow speed as the fingertips strike the rim. The glass tips, falls, and hits the floor with a sharp impact; cracks spread through it as fragments slide outward. Toward the end, the moving pieces lose momentum and settle into the exact broken arrangement, hand position, camera angle, lighting, and final composition established by <Picture 1>.

overall_soundscape: N/A

non_diegetic_music: N/A
```

## See also

- [`SKILL.md`](../SKILL.md) — full request shape, command, output envelope, and per-stage examples
- [`official-capabilities-and-routing.md`](official-capabilities-and-routing.md) — when to pick a keyframe mode vs `ref2va`
- [`ref2va-rules.md`](ref2va-rules.md) — the default mode for any image-based request with reusable reference traits