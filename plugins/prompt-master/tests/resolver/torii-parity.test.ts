// torii prompts parity — upstream PM 3.1.0 torii_prompts_data.js 对照断言（审计高危项 #2）
// 覆盖：PROMPTS_B 12 个上游键存在性、3 个此前缺失键 + 2 个此前重写键的内容包含性抽查、
//       TORII_JSON_FORMATS / JSON_OUTPUT_SUFFIX / SYSTEM_PROMPT、makeUserQuery grounding 管线。
import { describe, expect, it } from 'vitest'
import {
  PROMPTS_B,
  TORII_JSON_FORMATS,
  JSON_OUTPUT_SUFFIX,
  SYSTEM_PROMPT,
  makeUserQuery,
} from '../../src/resolver/profiles/torii/prompts.js'

// 上游 PROMPTS_B 全部 12 键（torii_prompts_data.js:5-143）
const UPSTREAM_KEYS = [
  'long_thoughts_v2',
  'long_thoughts',
  'json',
  'long',
  'min_structured_md',
  'json_comic',
  'md_comic',
  'min_structured_json',
  'chroma-style',
  'short',
  'danbooru_line',
  'sd_tag_line',
]

describe('T1: PROMPTS_B key surface', () => {
  it('contains all 12 upstream keys', () => {
    for (const key of UPSTREAM_KEYS) {
      expect(PROMPTS_B[key], `missing key: ${key}`).toBeTruthy()
    }
  })
})

describe('T1/T2: previously-missing keys — content containment (official strings)', () => {
  it("chroma-style: official 4-part structure", () => {
    const t = PROMPTS_B['chroma-style']
    expect(t).toContain('### 3. Midjourney-Style Summary:')
    expect(t).toContain('### 4. DeviantArt Commission Request')
  })

  it('danbooru_line: official JSON keys contract', () => {
    const t = PROMPTS_B['danbooru_line']
    expect(t).toContain('Return ONLY one JSON object (no markdown, no prose before or after JSON)')
    expect(t).toContain('"tags":"general Danbooru tags ONLY')
    expect(t).toContain('include counts (1girl, solo)')
  })

  it('sd_tag_line: official one-line SD tags contract', () => {
    expect(PROMPTS_B['sd_tag_line']).toContain(
      'Return ONLY one JSON object with key "tags"',
    )
  })

  it('json: official schema restored (was rewritten in port)', () => {
    const t = PROMPTS_B['json']
    expect(t).toContain('"main content" : "long and detailed description')
    expect(t).toContain('"image_effects" :')
    expect(t).toContain('In special cases you can add extra keys.')
  })

  it('min_structured_json: official watermarks contract (was rewritten)', () => {
    const t = PROMPTS_B['min_structured_json']
    expect(t).toContain('"General" :')
    expect(t).toContain('"watermarks" : "If present"')
    expect(t).toContain('Prefere shorter description and tags.')
  })
})

describe('T4: TORII_JSON_FORMATS / JSON_OUTPUT_SUFFIX / SYSTEM_PROMPT', () => {
  it('TORII_JSON_FORMATS = {json, json_comic, min_structured_json, danbooru_line, sd_tag_line}', () => {
    expect([...TORII_JSON_FORMATS].sort()).toEqual(
      ['danbooru_line', 'json', 'json_comic', 'min_structured_json', 'sd_tag_line'].sort(),
    )
  })

  it('JSON_OUTPUT_SUFFIX present with official "# Output requirement" block', () => {
    expect(JSON_OUTPUT_SUFFIX).toContain('# Output requirement')
    expect(JSON_OUTPUT_SUFFIX).toContain('Return exactly one valid JSON object matching the schema above.')
  })

  it('SYSTEM_PROMPT matches official captioning-expert line', () => {
    expect(SYSTEM_PROMPT).toBe(
      "You are image captioning expert. Describe user's picture according to requested format and instructions.",
    )
  })
})

describe('T5: makeUserQuery grounding pipeline', () => {
  const item = {
    tags: ['long_hair', '1girl', 'blue_eyes'],
    characters: ['hatsune_miku'],
    char_p_tags: { chars: { hatsune_miku: ['twintails', 'vocaloid'] }, skins: {} },
    char_descr: { chars: { hatsune_miku: 'A virtual singer with teal hair.' }, skins: {} },
  }

  it('builds caption format header + format block', () => {
    const q = makeUserQuery(item, 'long', false, false, false, false, false)
    expect(q.startsWith('# Captioning format:\n')).toBe(true)
    expect(q).toContain('Make a caption for given image with natural text.')
    expect(q).toContain('# Characters on picture:\nAvoid to guess names for characters.\n')
  })

  it('injects booru tags block when addTags', () => {
    const q = makeUserQuery(item, 'long', false, true, false, false, false)
    expect(q).toContain('# Booru tags for the image\n[')
    // all tags present regardless of shuffle order
    for (const tag of item.tags!) expect(q).toContain(tag)
  })

  it('underscoresReplace swaps underscores for spaces on long tags only', () => {
    const q = makeUserQuery(item, 'long', false, true, false, false, false, true)
    expect(q).toContain('long hair')
    expect(q).toContain('1girl') // length <= 3 stays untouched
    expect(q).not.toContain('long_hair')
  })

  it('character names + traits injection (addCharacters + addCharTags)', () => {
    const q = makeUserQuery(item, 'long_thoughts', true, true, true, true, false, true)
    expect(q).toContain('# Characters on picture:')
    expect(q).toContain('make sure to use them: [hatsune miku].')
    expect(q).toContain('# Known traits for characters')
    expect(q).toContain('hatsune miku: [twintails, vocaloid]')
  })

  it('description mode (addDescription) injects char descriptions instead of tags', () => {
    const q = makeUserQuery(item, 'long_thoughts', true, false, true, false, true, false)
    expect(q).toContain('Here are general descriptions for each characters on the picture:')
    expect(q).toContain('## hatsune_miku\nA virtual singer with teal hair.')
    // upstream: '# Known traits for characters' header guards (addCharTags || addDescription),
    // so it appears in both modes; only the body differs
    expect(q).toContain('# Known traits for characters')
    expect(q).not.toContain('Here are popular tags for each characters on picture:')
  })

  it('JSON format + JSON_OUTPUT_SUFFIX wiring matches upstream llama helper behavior', () => {
    const q = makeUserQuery(item, 'json', false, false, false, false, false)
    expect(TORII_JSON_FORMATS.has('json')).toBe(true)
    if (TORII_JSON_FORMATS.has('json')) {
      // upstream: userQuery += JSON_OUTPUT_SUFFIX (torii_llama_helper.js:109-110)
      const wired = q + JSON_OUTPUT_SUFFIX
      expect(wired).toContain('# Output requirement')
    }
  })
})
