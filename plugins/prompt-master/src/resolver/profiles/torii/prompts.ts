// Torii Gate-0.5 结构化 prompt 数据 — 1:1 移植自 PM torii_prompts_data.js

export const PROMPTS_B: Record<string, string> = {
  long_thoughts_v2: `Your answer must contain 6 parts:
<format>
# 1. Thoughts about characters
You need to think here and compare peoples/creatures that you see on the picture with given popular tags, or descriptions, or your memories for each characters to determine who is who.
# 2. Key details
Here you need to determine key details on comic and list them.
# 3. Long description
Here come up with a long and detailed description of image content. Be creative, mention all detailes you listed above and other important things.
# 4. Detailed description for each character
## Name 1
Detailed and long description for the first character
## Name 2
Same for each one (if present)
</format>
`,

  long_thoughts: `Your answer must contain 6 parts:
<format>
# 1. Thoughts about characters
You need to think here and compare peoples/creatures that you see on the picture  with given popular tags, or descriptions, or your memories for each characters to determine who is who.
If no characters are listed in input - just write here "No named characters"
# 2. General description
A one-two paragraph summary of the image. Mention all individual parts/objects/characters/positions/interactions/etc.
# 3. Detailed description for each character
## Character name 1 (put here the name if any)
In very detail write about features, poses, look, used objects, interactions, and other things for character on the picture.
## Character name 2 (put here the name if any)
Same for each character.
...
# 4. Individual Parts
List the individual things you see in the image and their relative positions to other parts. Use a numbered list of between 5 and 20 items depending on image complexity.
# 5. Texts on image
Mention every texts that you notice on image, including types (a speech bubble, watermark, banner, etc.) and content.
# 6. Background and effects
Give some info about objects on background, describe the location (if seen). Then mention effects (style, camera angle, clarity/blurrines, effects like depth of field, strange angle/forshortening, etc.)
</format>
`,

  json: `Use json-style caption for given image with following structure:
{"character" : "Description for character or object. Name (if defined), main details, features, position, pose, etc.",
/or in case of multiple
"character_1" : "Description for first"
"character_2" : "Description for second ",
"character_N"...
/or if there are no characters
"main content" : "long and detailed description of main content of image that might be the main focus if characters are missing",
/or
"background" : "description of background",
"style" : "art style, camera angle, lighting"
}`,

  min_structured_md: `Your answer must contain 3 parts:
<format>
# 1. Thoughts about characters
You need to think here and compare peoples/creatures that you see on the picture with given popular tags, or descriptions, or your memories for each characters to determine who is who.
# 2. Key details
Here you need to determine key details on image and list them.
# 3. Structured description
## General
Write here composition, background, and all objects on background that are not characters.
## Character name 1 (put here the name if any)
Description of character/character name.
## Character name 2 (put here the name if any)
Same for each character.
...
## Image effects
Write here about style, camera, lighting, etc. If no effects - write "none" here.
</format>
For captioning only structured description is required. Generate only # 3 in your output. Don't output your thoughts or key details list to final answer. Just output ## headers, body, and image_effects section under # 3. `,

  min_structured_md_body: `Your answer must contain only 3 parts in body format:
<format>
## General
Write here composition, background, and all objects on background that are not characters.
## Character name 1 (put here the name if any)
Description of character/character name.
## Character name 2 (put here the name if any)
Same for each character.
...
## Image effects
Write here about style, camera, lighting, etc. If no effects - write "none" here.
</format>
Output only this. Do not output thoughts, key details or other parts to final answer. Just output structured description body. `,

  min_structured_json: `Output ONLY valid JSON with following keys (omit missing keys):
{
  "General": "composition, background, non-character objects",
  "<Character name 1>": "name + traits, clothing, pose, expression, actions, interactions",
  "<Character name 2>": "...",
  "Background": "...",
  "Style": "...",
  "Image effects": "...",
  "OCR/text": "transcribe text, fonts, positions",
  "Individual Parts": "numbered list 5-20 items"
}
Valid JSON only. No markdown, no prose. `,

  md_comic: `Output ONLY markdown comic format:
# Title
## Panel 1
[Framing, camera, panel layout, lighting, sound effects]
### Visual
[Detailed visual description]
### Caption
[Dialogue/narration with character names in CAPS, sound effects]
### Mood
[Overall mood and tone]
## Panel 2
[same structure]
...
## Summary
[Brief overall story summary]`,

  json_comic: `Output ONLY valid JSON array of panels:
[
  {
    "panel": 1,
    "framing": "close-up, wide shot, etc.",
    "camera": "pan, zoom, etc.",
    "visual": "detailed visual description",
    "caption": "dialogue/narration",
    "characters": ["name1", "name2"],
    "sound_effects": "...",
    "mood": "..."
  },
  ...
]
Valid JSON only. No markdown.`,

  long: `Write a long, natural-language description of the image in 2-5 paragraphs. Cover main subjects, scene, action, style. Do not use markdown headers.`,

  short: `Write a short, concise description covering main subjects and key details. No redundancy, no markdown.`,
};

// Torii prompt 数据 — 训练 grounding 相关
export const TORII_PROMPTS_DATA = {
  PROMPTS_B,
};