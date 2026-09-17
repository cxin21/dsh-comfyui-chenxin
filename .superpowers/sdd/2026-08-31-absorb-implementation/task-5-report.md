# Task 5 Report — Model-Family Output Sanitize Pipeline (generic level)

## Status
**COMPLETE** — commit `a4706ec`

## What was done
1. **TDD red:** wrote `tests/pe-framework/sanitize/model-specific.test.ts` (5 cases from brief Step 1) — failed on missing module.
2. **TDD green:** created `src/pe-framework/sanitize/model-specific.ts` exporting `sanitizeModelSpecific(text, { family, outputLang })`:
   - Routes via `getCapabilities(family)`; `sanitizeLevel: 'none'` families (deepseek, glm, openai, generic) pass through untouched.
   - `'generic'` families (qwen-vl, qwen-text, gemma) get, in order: strip `<think>` tags (closed + unclosed + `思考：` lines), extract polished tail (last marker wins, fallback to full text if tail < 2 chars), strip instruction-echo lines.
   - Pure module, no logging.
3. **Wiring:**
   - `src/tools/prompt-reverse.ts`: after `completeWithBlocks` returns raw text, BEFORE `sanitizeFinalCaption`: `sanitizeModelSpecific(raw, { family, outputLang })` with `family = inferModelFamily(provider, model)`. Log line `prompt_reverse sanitize family=... changed=...` added. Task 4's joy_extra wiring untouched; `filterJoyExtraClauses` remains LAST.
   - `src/tools/prompt-expand.ts`: after `complete()` returns, before return (only sanitize pass). Log line `prompt_expand sanitize family=... changed=...` added.
4. **Verification:** `tsc` clean; full suite **48 files / 361 tests passed** (was ~356 before +5 new).

## Notes / deviations
- **Mojibake reconstruction (same as Task 4 precedent):** the brief's code blocks were UTF-8-read-as-GBK mojibake. Reconstructed intended strings from byte patterns:
  - Tail markers: `润色与精简:`, `精简后:`, `最终输出:`, `Final polished caption:`, `Polished:`, `最终答案:`, `优化后:`, `Refined:`
  - Echo-line regex: `/^(这张图片|这是|我需要|关键词构思|整理|组合成|精简并优化|答案[:：])/`
  - Think-ZH regex: `/思考[：:][\s\S]*?(?=\n|$)/g`
  - Test fixtures: `输出文本`, `正文内容`, `初稿内容/润色与精简:/最终精修文本`, `这张图片展示了一个女孩\n实际的描述内容`, `一位穿红裙的少女站在樱花树下，阳光柔和`
- Brief lists 5 `it` blocks (6 expectations across the echo case); all implemented as specified.

## Files
- New: `src/pe-framework/sanitize/model-specific.ts`, `tests/pe-framework/sanitize/model-specific.test.ts`
- Modified (minimal inserts): `src/tools/prompt-reverse.ts`, `src/tools/prompt-expand.ts`

## Concerns
- `sanitizeModelSpecific` runs on ALL generic-family output including `prompt_expand`, where a legit caption starting with e.g. "这是" would be dropped as an echo line. Accepted per brief (echo-stripping is inherently heuristic); deepseek/glm/openai are unaffected.
- `changed=` log compares against the raw model output only (model-level diff), not the dialect/joy diff — matches brief's log spec.
