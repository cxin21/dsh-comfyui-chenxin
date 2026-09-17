# Task 6 Report — Multi-image identity mapping (B4, S subset)

## Status: DONE

- **Commit:** `fdaacff` — `feat(prompt-master): multi-image identity mapping declarations (S subset)` (3 files, +52/−2)
- **Tests:** 365/365 passing (49 files), includes 4 new identity tests (red→green TDD; initial red confirmed with module absent).
- **Build:** `tsc` exit 0.

## Changes

1. **New** `plugins/prompt-master/src/pe-framework/media/identity.ts`
   - `TaggedMedia { n, tag }`, `enumerateTaggedMedia(count)` (1-based `<Picture N>`), `buildIdentityDeclarations(media, outputLang)` — returns `''` for <2 media; zh header `身份映射——不要混淆对应关系：` with lines `<Picture N> = 第 N 张图`; en header `Identity mapping — do not swap identities:` with `= image #N`. Pure module, no logging.
2. **Modified** `plugins/prompt-master/src/tools/prompt-reverse.ts` (minimal insert)
   - Import of the two identity functions.
   - Immediately after route resolution (blocks construction), when `images.length >= 2`: declaration text block is `unshift`ed ahead of the copied image blocks; log line `[prompt-master] multi-image identity declarations injected (n=${images.length})`.
   - Task 4 joy_extra wiring and Task 5 `sanitizeModelSpecific` untouched.

## Notes / deviations

- Brief was mojibake for zh strings; reconstructed per Task 4 precedent: `不要混淆` (matches test's `toContain`), `身份映射——不要混淆对应关系：`, `第 N 张图`.
- First full-suite run showed 3 collection-failed test files due to a transient syntax slip in my wiring (leftover `]` after converting the array literal to `blocks.push(...)`); fixed immediately — subsequent run fully green. Task 4/5 behavior unaffected (365 = 361 prior + 4 new).

## Concerns

- Declarations use `<Picture N>` tags in text only; the model must associate tags with images by position — this is the S-subset limitation per brief (full B4 would tag image blocks natively).
- dry_run path reports `imageBlocks: images.length` but does not echo the declarations text; left as-is (out of scope).
