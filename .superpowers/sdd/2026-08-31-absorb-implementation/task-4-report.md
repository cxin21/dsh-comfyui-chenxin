# Task 4 Report — B2 JoyExtra 三段式硬约束

**Status:** ✅ complete · **Commit:** `def5c53` · **Tests:** 47 files / 356 passed (11 new) · **Build:** exit 0

## Deliverables
- `plugins/prompt-master/src/pe-framework/sanitize/joy-extra.ts` (new) — pure functions, zero logging:
  - `resolveJoyExtraOptions` — explicit `joyExtraOptions[]` (unknown ids dropped) > verbatim PM standard-sentence sniff + short variants on `extraPrompt`; `characterName` from param or `refer to them as <name>` pattern (PM `resolveJoyCharacterName` port).
  - `buildJoyExtraSystemBlock` / `buildJoyExtraUserTail` — priority declaration (硬约束 > 检查表/风格指南) + per-option pledges + conflict-override sentence (scene_only subsumes no_glasses_headwear, stricter wins); zh/en.
  - `filterJoyExtraClauses` — clause split on deob char class `[，,、；;。．.!！?？\n]`, join with PM `pickClauseSeparator`; pattern groups per option (glasses/headwear: full PM Chinese set + English `\b(beret|hat|glasses|goggles|sunglasses|eyewear|helmet|headband|crown|headwear)\b`; appearance/clothing: PM core set; artistic style: core set); anti-extinction: all clauses filtered → return original.
- `tests/pe-framework/sanitize/joy-extra.test.ts` (new) — 11 cases (brief's 9 + character sniff + user tail).
- `src/tools/prompt-reverse.ts` — params `joy_extra_options?: string[]`, `character_name?: string` (no `.optional()`); system block appended after `resolveReverse`; user tail appended; `filterJoyExtraClauses` applied AFTER `sanitizeFinalCaption`; log `joy_extra options=... filtered=yes/no`.
- `src/tools/prompt-author.ts` — anima branch: `applyAnimaJoyExtraFilter` on `form_fields.joy_extra_options` filters `stage.result.positive/negative` after each `runDraftThroughStage` (incl. audit_only + correction rounds); final log gains `joy_extra filtered=yes/no`.

## Verbatim ports
Standard sentences taken verbatim from `joyCaptionExtraOptions.js.deob.js` (SCENE / GLASSES / STYLE EN constants; sniff regexes `Do NOT describe any glasses, goggles, eyewear`, `Do NOT describe artistic style`, scene trio, `refer to them as`). Clause patterns/split/`pickClauseSeparator` from `captionExtraOptionSanitize.js.deob.js`; exotic body-part-position patterns trimmed per brief allowance.

## Concerns
- Brief text was mojibake; test strings reconstructed to intended Chinese/English — all pass.
- The brief's "separator memory" was implemented as PM-verbatim `pickClauseSeparator` join (test requires `', '` preserved in English output; token-level sep restore produced `1girl,white dress` and failed the brief's own test).
- Sniff accepts both the verbatim PM sentence and the shorter test sentence (`Do not mention glasses...`), which is not in PM source — required by the brief's test.
- Full suite 356 (was ~352 baseline + 11 new − overlapping counts); 47 files, all green.
