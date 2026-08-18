# MiniMax H3 Ref2VA Rules

## When to read

Read this when writing the prose for a `ref2va` story. The skill renders
the six official sections and threads the `<Subject N>` / `<Picture N>` /
`<Video N>` / `<Audio N>` labels through them.

## Mandatory structure

Ref2VA always produces exactly these six sections in this order:

```text
subject_definitions:

summary:

retention_analysis:

detailed_description:

overall_soundscape:

non_diegetic_music:
```

Ref2VA has no alignment preamble. Never use a free-form prompt,
keyword list, abbreviated prompt, or the base three-field structure
as the final deliverable.

## Label ontology

### `<Subject N>`

Reusable visible content: people, animals, objects, environments,
clothing, props, interfaces, effects, styles, actions, expressions,
poses. One subject may combine contributions from multiple assets. A
source video's visible person or action is still a subject, not a
video label.

### `<Picture N>`

A standalone label only when the image itself is a concrete first
frame, keyframe, last frame, edited keyframe, composition anchor, or
storyboard / planning reference. If an image only defines a subject's
appearance, cite the image inside the subject definition instead of
creating a separate picture entry.

### `<Video N>`

A whole-video relationship: direct editing source, continuation source,
or source of camera, cuts, pacing, or temporal structure. Do not use it
as a substitute for subjects extracted from the video.

### `<Audio N>`

A copied or referenced audio signal: complete or partial reuse, voice
timbre, music style, dialogue or lyric content, sound texture, beat,
rhythm, or continuity. A reference video does not automatically create
an audio label merely because it contains sound.

Number each category independently and keep meanings stable across all
six sections.

## Task types

| Type                   | When to use it |
| ---------------------- | -------------- |
| `keyframe completion`  | An image is a concrete first / key / edited / last frame anchor |
| `reference generation` | An asset guides identity / scene / style / action / camera / storyboard / sound without serving as a concrete frame or source video |
| `video editing`        | Directly modify an existing source video |
| `video continuation`   | Continue, extend, resume, or transition from a source video |
| `audio reuse` | Copy the same audio signal in full or part |
| `audio reference` | Reference timbre, style, words, texture, beat, or continuity without copying the signal |

Combine applicable types inside one square-bracketed prefix separated
by ` + ` and without duplicates. For direct video editing, begin the
summary after the prefix with `The target video is an edited version
of <Video 1>.`

## Retention markers

Visual:

| Marker | Meaning |
| --- | --- |
| `fully_preserved` | The defined role of the referenced content is fully preserved |
| `partially_preserved` | The content is still used, but some defined characteristics are changed or only partially retained |
| `attribute_transfer` | Referenced characteristics move to a different identifiable target subject |
| `weak_reference` | Only broad similarity in style, category, composition, or atmosphere is retained |

Audio:

| Marker | Meaning |
| --- | --- |
| `fully_copy` | The complete source audio becomes the complete final audio track |
| `partially_copy` | Only part of the timeline / layers are copied, or other sounds are added, removed, or replaced after copying |
| `reference` | Do not copy the signal; reference timbre, rhythm, style, words, or texture |
| `weak_reference` | Only broad similarity in category or atmosphere is retained |

Do not count new target actions, backgrounds, or plot events as
reference-fidelity losses unless they alter a defined reference role.

## Timeline and speakers

- Establish style in one or two English sentences before `[Shot 1]`.
- Do not timestamp `[Shot 1]`. Format later cuts as `[Shot N] At MM:SS.mmm, ...`.
- At a subject's first clear appearance, describe its referenced characteristics, frame position, and current action.
- Phrase anchors naturally: `the shot begins from <Picture 1>`, `the shot's keyframe corresponds to <Picture 2>`, or `the shot ends on <Picture 3>`.
- Use `<Subject N> (Sx)` when a referenced subject physically speaks. Keep the same `(Sx)` for off-screen speech by that source.
- Use `<Audio N>` rather than inventing `(Sx)` when verbal content is only a cue embedded in a directly reused complete soundtrack or BGM.
- Keep exact reused or explicitly reperformed words inside `<d>[Language] ...</d>`. Use `[unclear]` rather than guessing.
- Use `<scenetrans>` for dialogue crossing a cut and `<cutoff>` for speech truncated by the video ending.

## Sound sections

- Keep synchronized dialogue, singing, and decisive sound events in `detailed_description`.
- Summarize ambience and physical sounds in `overall_soundscape`; cite copied or referenced audio there when it supplies those layers.
- Describe audience-only score in `non_diegetic_music`; cite copied or referenced audio there when it supplies that layer.
- Do not repeat complete dialogue or lyrics in the two summary sound sections.

## Prompt-level keyframe anchoring

A ref2va task may designate a referenced image as a concrete first
frame, keyframe, edited keyframe, last frame, or composition anchor.
Define it as a standalone `<Picture N>` and state its exact role:

```text
<Picture 2> is the last frame of [Shot 3], defining the final pose, object placement, camera angle, lighting, and composition.
```

Combine `keyframe completion` with other task types in `summary` when
appropriate. In `detailed_description`, describe a continuous path into
or out of the anchored picture rather than repeating static image
descriptions.

When a picture both anchors a boundary frame and preserves a person,
character, object, costume, scene, style, or composition, keep the
task in ref2va. Define both responsibilities explicitly instead of
moving to the pure keyframe mode.

## API role constraint

The current official API documents keyframe and multimodal-reference
inputs as mutually exclusive. If any `reference_image`,
`reference_video`, or `reference_audio` role appears in `content[]`,
do not also use `first_frame` or `last_frame`, and vice versa. To
combine reference generation with a first / last-frame intention, keep
the asset's API role as `reference_image` and encode its concrete
frame function through `<Picture N>` and the prompt. This is a
semantic prompt anchor, not the API's hard keyframe role.

## Example

Input request (the `--stage ref2va` flag is passed separately):

```json
{
  "duration_seconds": 9,
  "shots": [
    { "what": "Neko waves at Mei on the rooftop at dusk.", "who": "Mei" }
  ],
  "references": [
    { "kind": "picture", "who": "Neko",    "image": "C:/refs/n.png", "width": 1024, "height": 1024 },
    { "kind": "picture", "who": "Mei",     "image": "C:/refs/m.png", "width": 1024, "height": 1024 },
    { "kind": "picture", "who": "Rooftop", "image": "C:/refs/r.png", "width": 1024, "height": 1024 }
  ]
}
```

Rendered prompt (`text`):

```text
subject_definitions:
<Subject 1> is Neko from <Picture 1>.
<Subject 2> is Mei from <Picture 2>.
<Subject 3> is Rooftop from <Picture 3>.

summary: [reference generation] Neko (<Picture 1>), Mei (<Picture 2>), Rooftop (<Picture 3>) appear in a 9-second, 1-shot video with synchronized audio.

retention_analysis:
<Subject 1> from <Picture 1> remains fully_preserved: identity, face, outfit, and styling unchanged across all shots.
<Subject 2> from <Picture 2> remains fully_preserved: identity, face, outfit, and styling unchanged across all shots.
<Subject 3> from <Picture 3> remains fully_preserved: identity, face, outfit, and styling unchanged across all shots.

detailed_description: [Shot 1] Neko waves at <Subject 2> on the rooftop.

overall_soundscape: N/A

non_diegetic_music: N/A
```

Note how the pipeline:

- numbered `<Subject N>` and `<Picture N>` independently starting at 1, in upload order;
- replaced the bare name `Mei` in `what` with `<Subject 2>`;
- generated a `summary` line with the `[reference generation]` task-type prefix and the cast;
- filled `retention_analysis` with `fully_preserved` markers for every subject;
- left `overall_soundscape` and `non_diegetic_music` as `N/A` because no ambient or music was supplied.

## See also

- [`SKILL.md`](../SKILL.md) — full request shape, command, output envelope, and per-stage examples
- [`official-capabilities-and-routing.md`](official-capabilities-and-routing.md) — when to pick `ref2va` vs the other stages
- [`keyframe-rules.md`](keyframe-rules.md) — pure keyframe modes (I2VA / FL2VA / L2VA)