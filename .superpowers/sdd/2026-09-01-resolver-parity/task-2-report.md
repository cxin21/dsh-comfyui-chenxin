# Task 2 Report: torii prompts parity backfill (audit high-priority item #2)

**Status:** ✅ Complete
**Commit:** `b804932` — `fix(prompt-master): torii prompts parity with PM 3.1.0 (PROMPTS_B 11 keys, JSON formats, system prompt, grounding)`
**Files changed:**
- `plugins/prompt-master/src/resolver/profiles/torii/prompts.ts` (rewritten, 1:1 upstream port)
- `plugins/prompt-master/tests/resolver/torii-parity.test.ts` (new, 15 tests)

## What was done

### Ground truth location
Upstream file located at `temp/pm-promptmaster-src/unpacked/electron/config/torii_prompts_data.js` (292 lines). Brief/audit referenced `src/resolver/torii/prompts.ts`; actual port tree is `src/resolver/profiles/torii/prompts.ts` (same for formats.ts — not modified, audit says formats 10/10 aligned).

### 1. PROMPTS_B — all upstream keys restored verbatim
Upstream PROMPTS_B has **12 keys** (brief said 11; recount: 7 rewritten + 3 missing + **2** aligned `long_thoughts_v2`/`long_thoughts` = 12; audit's "13" is also off by one). Final state:
- **Restored official copy for 7 rewritten keys:** `json`, `long`, `min_structured_md`, `json_comic`, `md_comic`, `min_structured_json`, `short` (e.g. official `json` schema with `"main content"`/`"image_effects"`/`"atmosphere"` keys; official `min_structured_json` `"watermarks"` contract replaces port's self-invented `"OCR/text"`/`"Individual Parts"` keyset).
- **Added 3 missing keys:** `chroma-style`, `danbooru_line`, `sd_tag_line` (the two latter are the JSON line formats referenced by TORII_JSON_FORMATS).
- **2 already-aligned keys kept verbatim:** `long_thoughts_v2`, `long_thoughts`.
- **`min_structured_md_body` kept** with a port-only comment (audit T3): it has no upstream counterpart but its id is referenced by `formats.ts` (`cTypeRuntime`), `taxonomy.ts`, and `expand-rules.ts`. Note: its *prompt key* itself has no direct PROMPTS_B consumer (builtinKey resolves via cTypeRuntime to `min_structured_md`).

### 2. TORII_JSON_FORMATS + JSON_OUTPUT_SUFFIX + SYSTEM_PROMPT
All three backfilled verbatim from upstream (`:145-160`), each annotated `// upstream parity, no consumer in port`.

### 3. makeUserQuery grounding pipeline
Ported 1:1 (tags shuffle, underscoresReplace, booru-tags block, character names, `char_p_tags` traits injection, `char_descr` description mode) + `shuffleInPlace`. TS-typed via new `ToriiGroundingItem` interface; the only deviation from upstream source is hoisting `chars || {}` locals to satisfy `strict` TS (`Object.entries` on possibly-undefined fields) — semantically identical.

### Consumer-surface verification (nothing breaks)
- Only real consumer of `PROMPTS_B` in the port: `expand-mirror.ts:55` `buildStructuredExpandSystem` → `PROMPTS_B[builtinKey]`. All builtinKeys come from `formats.ts` cTypes (`cTypeRuntime || cType`), all present after backfill.
- `TORII_JSON_FORMATS` / `JSON_OUTPUT_SUFFIX` / `SYSTEM_PROMPT` / `makeUserQuery`: upstream consumer is `torii_llama_helper.js` (llama inference path, cut from the port per established trimming) → backfilled as data completeness with explicit no-consumer comments.
- **No existing test asserts torii prompt content** (grep across `tests/` for PROMPTS_B/min_structured/torii: zero matches), so the official-copy restoration breaks no locked surface.
- `TORII_PROMPTS_DATA` namespace export retained and extended with the new constants for backward compatibility.

### New parity test (`tests/resolver/torii-parity.test.ts`, 15 tests)
- T1: 12-key existence.
- Content containment on official strings: 3 previously-missing keys (`chroma-style` "Midjourney-Style Summary"/"DeviantArt Commission Request"; `danbooru_line` "Return ONLY one JSON object"/"include counts (1girl, solo)"; `sd_tag_line` official contract) + 2 previously-rewritten keys (`json`, `min_structured_json`).
- TORII_JSON_FORMATS exact 5-member set; JSON_OUTPUT_SUFFIX "# Output requirement"; SYSTEM_PROMPT exact string.
- makeUserQuery: format header, tags shuffle (order-independent), underscoresReplace semantics (length>3 only), names/traits injection, description mode, JSON_OUTPUT_SUFFIX wiring mirroring upstream `torii_llama_helper.js:109-110`.

## Verification
- `npx vitest run tests/resolver/torii-parity.test.ts` → **15/15 passed**
- `npm run build` (tsc) → **0 errors**
- `npx vitest run` (full suite) → **58 files, 498/498 tests passed**
- Zero logging added; pure data/template changes.

## Concerns / notes for the batch
1. **Key-count discrepancy in brief/audit:** actual upstream PROMPTS_B = 12 keys (brief said 11, audit said 13). All 12 are backfilled — superset of either count, so no gap.
2. **Git path in brief was stale** (`plugins/prompt-master/src/resolver/torii` doesn't exist; real path `src/resolver/profiles/torii`). First `git add` with the brief's path failed silently; committed with corrected paths — commit `b804932` contains exactly the 2 intended files.
3. Upstream `md_comic`/`min_structured_md` official copy contains typos ("comin", "horisontal", "menation", "overdoo") — preserved verbatim per parity mandate; flagged in case a later task wants a deliberate deviation decision.
4. T6 (torii description truncation in formats.ts) and T7 (buildTrainToriiProfiles / usesStructuredPromptCaption) are out of Task-2 scope per the brief's file list and remain open audit items.
