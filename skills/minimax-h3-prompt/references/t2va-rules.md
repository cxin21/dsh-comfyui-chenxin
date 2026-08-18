# MiniMax H3 T2VA Rules

## When to read

Read this when writing the prose for a `t2va` story. The skill renders the
structural envelope (`integrated_multimodal_description`,
`overall_soundscape`, `non_diegetic_music`) — your job is to author the
`shots[].what` strings, dialogue, ambient, and music that the envelope
will wrap.

## Mandatory structure

T2VA always produces exactly these three fields in this order:

```text
integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

T2VA has no picture-alignment preamble. Never use a free-form
natural-language paragraph, keyword list, abbreviated prompt, or
alternate schema as the final English prompt.

## Timeline and shots

- Begin the first field with `[Shot 1]`. No timestamp on the first shot.
- Format later cuts as `[Shot N] At MM:SS.mmm, the camera cuts to ...`.
- Cut times are evenly spaced and strictly increasing.
- Each cut must introduce a meaningful change in subject, space, state, viewpoint, or time. For a modest framing or angle change, prefer camera movement over a cut.
- Maximum shot count: `1 + floor((duration - 1) / 3)`.

## Camera vocabulary

| Motion              | Description |
| ------------------- | ----------- |
| `Zoom In / Out`     | Focal length changes; camera body stays still |
| `Push In / Out`     | Camera moves forward / backward |
| `Pan Left / Right`  | Lens pivots horizontally; camera stays in place |
| `Truck Left / Right`| Camera translates horizontally |
| `Tilt Up / Down`    | Lens pivots vertically; camera stays in place |
| `Pedestal Up / Down`| Whole camera moves up / down |
| `Arc Shot`          | Camera moves in an arc around the subject |
| `Tracking Shot`     | Camera follows a moving subject |
| `Static Shot`       | Camera and lens remain still |
| `POV`               | Subject's point of view |
| `Roll Clockwise / Counterclockwise` | Camera rolls around the lens axis |

Add `with small / large amplitude` or `at slow / fast speed` only when
meaningful. Integrate camera movement into natural prose; never append
a disconnected list of camera tags.

## Speech, lyrics, and visible text

- Assign `(Sx)` only to a real vocal source (person, character, narrator). Reuse IDs across shots. Use `(S1,S2)` for combined vocalizations.
- Put identity, delivery, and action outside `<d>`. Put only `[Language]` and exact verbal content inside.
- For voiceover, use `says in an off-screen voiceover` and immediately state that the corresponding on-screen character's lips remain completely closed.
- Use `<scenetrans>` in both connected dialogue segments when one line crosses a cut, and explicitly state continuous audio.
- Use `<cutoff>` when speech is truncated by the end of the video.
- Put visible text in English double quotation marks and preserve its original language and punctuation.

## Sound layers

- Keep shot-synchronized dialogue, singing, diegetic music, and decisive sound events in `integrated_multimodal_description`.
- `overall_soundscape`: 1-4 English sentences summarizing ambient sound, physical action sounds, and non-verbal human sounds. Use `N/A` only when the user requests complete silence.
- `non_diegetic_music`: 1-3 English sentences describing audience-only score — instrumentation, tempo / rhythm, dynamic evolution. Use `N/A` when no such music is present.

## Example

Input request (the `--stage t2va` flag is passed separately):

```json
{
  "duration_seconds": 6,
  "shots": [
    {
      "what": "A middle-aged baker with a calm, slightly raspy voice opens the shutters of a small street bakery before sunrise. The camera pushes in with small amplitude at slow speed as she places a fresh loaf on the wooden counter and says: First batch of the morning.",
      "ambient": "wooden shutters scrape open, trays clink softly",
      "music": "a soft acoustic-guitar pattern at a moderate tempo"
    },
    {
      "what": "Steam rises from the sliced bread while the baker's final words carry over from the previous shot."
    }
  ]
}
```

Rendered prompt (`text`):

```text
integrated_multimodal_description: [Shot 1] A middle-aged baker with a calm, slightly raspy voice opens the shutters of a small street bakery before sunrise. The camera pushes in with small amplitude at slow speed as she places a fresh loaf on the wooden counter and says: <d>[English] First batch of the morning.</d> [Shot 2] At 00:03.000, the camera cuts to steam rises from the sliced bread while the baker's final words carry over from the previous shot.

overall_soundscape: wooden shutters scrape open, trays clink softly

non_diegetic_music: a soft acoustic-guitar pattern at a moderate tempo
```

Note how the pipeline:

- detected the language of the dialogue from CJK / Kana heuristic and tagged it `[English]`;
- preserved the dialogue byte-for-byte inside `<d>`;
- applied the `[Shot N] At MM:SS.mmm,` format with the cut-phrase `the camera cuts to`;
- placed `ambient` in `overall_soundscape` and `music` in `non_diegetic_music`.

## See also

- [`SKILL.md`](../SKILL.md) — full request shape, command, output envelope, and per-stage examples
- [`official-capabilities-and-routing.md`](official-capabilities-and-routing.md) — when to pick `t2va` vs the other stages