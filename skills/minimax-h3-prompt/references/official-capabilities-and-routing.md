# MiniMax H3 Official Capabilities and Routing

Source: MiniMax H3 official usage manual, revision 1241 — `https://vrfi1sk8a0.feishu.cn/wiki/FIWjwgL33ipnkekzk30crmKUnIh`.

This document is the local source of truth for product limits, asset
roles, and routing policy. When this document and the live manual
disagree, follow the live manual.

Read this file when choosing the mode for a new request, or when
verifying an asset set against the official envelope.

## Product envelope

| Limit                     | Value           |
| ------------------------- | --------------- |
| Output duration           | **4-15 seconds** |
| Frame rate                | 24 FPS          |
| Output audio              | native stereo   |
| Prompt character length   | **≤ 7000**      |
| Default output resolution | 768p (1440p upgrade path documented) |
| T2VA aspect ratios        | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 |
| First / last-frame input  | 0, 1, or 2 images |
| First / last-frame dimensions | 256 - 5760 px |
| First / last-frame aspect ratio | 5:2 to 2:5 |

Local ComfyUI workflows may apply narrower runtime limits; obey the
runtime-specific limits when they are stricter.

## Full-reference input limits

| Limit                          | Value  |
| ------------------------------ | ------ |
| Images                         | ≤ 9   |
| Videos                         | ≤ 3, each 2-15 s, combined ≤ 15 s |
| Audio                          | ≤ 3, each 2-15 s, combined ≤ 15 s |
| Audio as the only reference    | forbidden |
| Mixed references                | ≤ 12 files total |
| Per-file image size            | ≤ 30 MB |
| Per-file video size            | ≤ 50 MB |
| Per-file audio size             | ≤ 15 MB |
| API request body size          | ≤ 64 MB |
| Accepted image formats         | JPG / JPEG / PNG / WEBP / HEIC / HEIF |
| Accepted video formats         | H264 / H265 with AAC / MP3 audio |
| Accepted audio formats         | WAV / MP3 |

The Python pipeline raises `official_envelope_violated` (exit 3) when
the supplied `references` / `videos` / `audios` arrays breach these
counts.

## Mode selection

| User intent | Stage |
| --- | --- |
| Text, idea, script, or storyboard with no assets | `t2va` |
| One image declared as a literal first frame; no reusable reference role | `i2va` |
| Two images declared as a literal first-and-last pair; neither carries reusable reference role | `fl2va` |
| One image declared as a literal last frame; no reusable reference role | `l2va` |
| Any image with an unstated or ambiguous role | `ref2va` |
| Any image that preserves identity / character / person / object / costume / scene / style / action / camera or another reusable trait | `ref2va` |
| A first / key / last-frame image that also preserves reusable traits | `ref2va` with prompt-level frame anchoring |
| Mixed image + video + audio references | `ref2va` |
| Source-video replacement, addition, removal, background / light / effect / audio modification | `ref2va` (editing) |
| Continuing from a source video | `ref2va` (continuation) |
| Existing prompt diagnosis or repair | `prompt-reviewer` (outside this skill) |

Ref2VA can express first / key / last-frame semantics in the prompt
through prompt-level anchoring (`<Picture N>`) while maintaining
reference consistency. Do not infer pure keyframe mode from the number
of images alone. Both conditions (explicit boundary wording AND zero
reusable reference responsibility) must be true; otherwise use ref2va.

## Prompt planning formula

Plan each request as:

```
reference material description + core creative concept + visual process description
```

For every asset, state upload index / order and one or more explicit
responsibilities. Valid responsibilities: identity, character, object,
scene, costume, style, composition, action, camera movement, storyboard,
first / last / key frame, voice / timbre, full or partial audio reuse,
source-video editing.

The core creative concept should name the subject, location, event /
action, genre / style, and special camera / edit strategy. H3 may cut
by default, so explicitly request a one-take when continuity is
required. Name the desired cut type when cuts matter: cut, fade,
beat-synced cut, fast cut.

Break the process into time or shot blocks. Each shot should control
shot size, visible content, camera, action, dialogue, and sound
effects. Explicitly name exact visible text and negative requirements.

## Mandatory question gate

This skill assumes the creative direction stage has already asked the
structured questions required by `minimax-h3-creative-director`. If the
model finds the request still sparse (missing duration, missing visual
style, missing asset responsibility), it must return to the creative
director instead of guessing inside the prompt.

## Dialogue, audio, and text

- Match dialogue length to shot duration for reliable lip sync.
- Identify the on-screen speaker. State when a voice is off-screen.
- When dialogue crosses a cut, state that it continues and describe the intended J-cut or L-cut relationship.
- Preserve exact speech, singing, lyrics, and reused source audio. For partial reuse, identify the track or time segment.
- To prohibit audience-only music, set `non_diegetic_music: N/A` and do not request extra score elsewhere.
- Write exact wording for titles, signs, captions, subtitles, slogans, logos, buttons, and interface text.

## Common failure checks

- One undivided paragraph instead of time / shot structure.
- Uploaded asset without a defined role.
- Music requested while `non_diegetic_music` is `N/A`.
- One continuous take requested while multiple cuts are specified.
- Face / identity consistency requested without an identity reference.
- Text-only prompt missing subject appearance, scene, action, camera, sound, or style.
- Vague metaphor where an observable event is needed.
- Too much dialogue or too many events for the chosen duration.
- Two boundary images treated as an automatic montage rather than a controlled transition.

## Strengths to exploit

H3 can combine text, image, video, and audio context; transfer character,
action, camera, composition, voice, atmosphere, and editing rhythm; and
perform source-video edits such as replacing, adding, or removing
subjects / objects, changing background / lighting / effects, and
modifying dialogue, voice, or audio while preserving untouched content.
Use a preservation ledger for multi-edit requests.