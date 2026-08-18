# Quality Policy

The policy stage decides what the model protocol requires and what safety
seed (if any) to inject. It never reads user data — only `brief.variant`,
`brief.quality_prefix`, and `brief.explicit`.

## Variants

`brief.variant` chooses the policy. Default is `base`. Unknown variants
raise `ValueError` in `compose`.

| Variant     | Mandatory positive                          | Mandatory negative                          |
|-------------|---------------------------------------------|---------------------------------------------|
| `base`      | `masterpiece`, `best quality`, `score_7`    | `worst quality`, `low quality`, `score_1..3`|
| `aesthetic` | `masterpiece`, `best quality`               | `worst quality`, `low quality`              |
| `turbo`     | `masterpiece`, `best quality`               | `worst quality`, `low quality`              |

Pick `base` unless the user names a different Anima checkpoint. `turbo`
is for fast/low-step sampling; `aesthetic` for stylized illustration.

### Example — variant difference

The same brief rendered under `base` vs `aesthetic`:

```jsonc
// brief
{
  "variant": "base",
  "subject": "portrait",
  "slots": {"count_gender": ["1girl", "solo"], "appearance": ["long hair"]}
}
```

`base` POSITIVE: `masterpiece, best quality, score_7, safe, 1girl, solo, long hair`
`base` NEGATIVE: `worst quality, low quality, score_1, score_2, score_3`

```jsonc
// brief
{
  "variant": "aesthetic",
  "subject": "portrait",
  "slots": {"count_gender": ["1girl", "solo"], "appearance": ["long hair"]}
}
```

`aesthetic` POSITIVE: `masterpiece, best quality, safe, 1girl, solo, long hair`
`aesthetic` NEGATIVE: `worst quality, low quality`

`score_7` and `score_1..3` are dropped because `aesthetic` policy does not
mandate them. All other terms are preserved.

## `quality_prefix`

`brief.quality_prefix` (default `true`) controls whether the policy
mandatory terms are injected at all.

- `true` (default) — full variant terms injected.
- `false` — no policy terms; the prompt is pure content. Use this when an
  external workflow (LoRA script, sampler preset) injects quality anchors
  itself and you don't want them doubled.

### Example — `quality_prefix: false`

Brief:

```jsonc
{
  "variant": "base",
  "quality_prefix": false,
  "subject": "portrait",
  "slots": {"count_gender": ["1girl"], "appearance": ["long hair"]}
}
```

Output POSITIVE: `safe, 1girl, long hair`
Output NEGATIVE: (empty)

The pipeline still emits `notes` and `assumptions` (catalog grounding
runs); only the policy terms are suppressed. The `safe` safety seed is
still injected because `explicit` is `false`.

## `explicit` and the safety seed

`brief.explicit` (default `false`) drops the safety seed (`safe`) from
positive when `true`. The safety seed is the conservative anchor that
keeps the model from drifting into mature content during normal runs.

The pipeline reads `brief.explicit` as the authoritative signal. There is
no keyword list the user has to memorize.

### Example — explicit off (default)

Brief:

```jsonc
{
  "variant": "base",
  "subject": "intimate portrait",
  "slots": {"count_gender": ["1girl", "solo"], "appearance": ["long hair", "blush"], "camera": ["close-up"]}
}
```

Output POSITIVE: `masterpiece, best quality, score_7, safe, 1girl, solo, long hair, blush, close-up`

Note the `safe` term between policy and slot tags.

### Example — explicit on

Brief:

```jsonc
{
  "variant": "base",
  "explicit": true,
  "subject": "intimate portrait",
  "slots": {"count_gender": ["1girl", "solo"], "appearance": ["long hair", "blush"], "camera": ["close-up"]}
}
```

Output POSITIVE: `masterpiece, best quality, score_7, 1girl, solo, long hair, blush, close-up`

`safe` is dropped. Use this when the user explicitly wants mature content
rendered without the conservative anchor.

## Decision matrix

| Variant     | `quality_prefix` | `explicit` | POSITIVE injection                              | NEGATIVE injection                       |
|-------------|------------------|------------|-------------------------------------------------|------------------------------------------|
| `base`      | `true`           | `false`    | `masterpiece, best quality, score_7, safe, ...` | `worst quality, low quality, score_1..3` |
| `base`      | `true`           | `true`     | `masterpiece, best quality, score_7, ...`       | `worst quality, low quality, score_1..3` |
| `base`      | `false`          | `false`    | `safe, ...`                                     | (empty)                                  |
| `base`      | `false`          | `true`     | `...`                                           | (empty)                                  |
| `aesthetic` | `true`           | `false`    | `masterpiece, best quality, safe, ...`          | `worst quality, low quality`              |
| `aesthetic` | `true`           | `true`     | `masterpiece, best quality, ...`                | `worst quality, low quality`              |
| `turbo`     | `true`           | `false`    | `masterpiece, best quality, safe, ...`          | `worst quality, low quality`              |
| `turbo`     | `true`           | `true`     | `masterpiece, best quality, ...`                | `worst quality, low quality`              |

`...` represents the slot/narrative content. Empty NEGATIVE channel
happens only when `quality_prefix=false` and `exclusions` is empty.