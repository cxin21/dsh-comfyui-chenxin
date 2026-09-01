// Torii Gate-0.5 结构化 prompt 数据 — 1:1 移植自 PM 3.1.0 torii_prompts_data.js
// （resolver×3.1.0 parity 审计高危项 #2：PROMPTS_B 官方模板回填 + TORII_JSON_FORMATS /
//   JSON_OUTPUT_SUFFIX / SYSTEM_PROMPT / makeUserQuery grounding 管线补回）

export interface ToriiGroundingItem {
  tags?: string[];
  characters?: string[];
  char_p_tags?: { chars?: Record<string, string[]>; skins?: Record<string, string[]> };
  char_descr?: { chars?: Record<string, string>; skins?: Record<string, string> };
}

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
/
"background" : "Detailed descritpion of background and it's content",
"image_effects" : "If there are some visual effects like fisheye distortion, chromatic aberration, glitches, messy drawing or anything else - write about it. If it's just a general anime art - omit this field."
"texts" : "Speech bubbles, bars, marks, signs etc. with texts if present, else None",
"atmosphere" : "...",
}
In special cases you can add extra keys.
`,

  long: `Make a caption for given image with natural text. Use 2 to 5 paragraphs. Make your description long and vivid, mentioning all the details.
`,

  min_structured_md: `Your answer must contain 3 parts:
<format>
# 1. Thoughts about characters
You need to think here and compare peoples/creatures that you see on the picture  with given popular tags, or descriptions, or your memories for each characters to determine who is who.
If no characters are listed in input - just write here "No named characters"
# 2. Key details
Here you need to write about the key details on image, prefere using regular text.
# 3. Structured description
## General
Write about general composition, content of image, background and all things that are not related to characters directly.
## Character name 1 (put here the name if any)
Write about datails and content related to specific character, including features, poses, look, used objects, interactions, and other things.
## Character name 2 (put here the name if any)
Same for each character.
## Image effects
Mention image effect, style, camera angle
</format>
In general stick to shorter descriptions.
`,

  json_comic: `Use json-style caption to describe to comin, stick to following structure:
{
"comic_format": "menation the format, for example Comic of N frames",
"1st_frame": "Main description of the content for fist frame",
"2nd_frame": "Same for the second",
...
"Nth_ftame": "...",
"character_1": "Describe the characters in comic",
...
"character_N": "Separate description for each",
"meaning": "Try to guess general mood, vibe and meaning of the comic"
}
`,

  md_comic: `Use markdown format to describe to comic, 5 parts are recommended:
<format>
# 1. Thoughts about characters
You need to think here and compare peoples/creatures that you see on the picture with given popular tags, or descriptions, or your memories for each characters to determine who is who.
# 2. Key details
Here you need to determine key details on comic and list them.
# 3. Comic format
In this section come up with the description of comic format, how many pages there are, horisontal/vertical orientation and other things. Optionally you can list main characters here.
# 4. Details for each frame
## 4.1 Frame 1 (position)
Description for each frame, includding characters, objects, interactions, texts/speech bubbles and other things. Be detailed but not overdoo.
## 4.2 Frame 2 (position)
Same for each frame.
...
# 5. Extra comment
Here you should write general desciption and some other info about the image.
</format>
`,

  min_structured_json: `
Use json-style caption for given image with following structure:
{"General" : "Here you need to come up with general/common information about picture, overall composition. Stick to shorter phrases and tags instead of long purple prose. Avoid bullets and markdown, write in plain text.",
"character_1 (put here the name if any)" : "Description of first character."
"character_2 (if present" : "Description for second ",
"character_N"
...
"image_effects" : "Mention here effects on image if there are any distinct."
"texts" : "Speech bubbles, bars, marks, signs etc. with texts if present, else None",
"watermarks" : "If present",
}
Prefere shorter description and tags.
`,

  'chroma-style': `Your task is to describe the picture in very detail using a structure of 4 parts.
### 1. Regular Summary:
[A one-paragraph summary of the image. The paragraph should mention all individual parts/things/characters/etc.]
### 2. Individual Parts:
[List the individual things you see in the image and their relative positions to other parts. Use a numbered list of between 5 and 30 items depending on image complexity.]
### 3. Midjourney-Style Summary:
[A summary that has higher concept density by using comma-separated partial sentences instead of proper sentence structure.]
### 4. DeviantArt Commission Request
[Write a description as if you're commissioning this *exact* image via someone who is currently taking requests.]
`,

  short: `The caption for image should be quite short without long purple prose and slop. Cover main objects and details.
`,

  danbooru_line: `Return ONLY one JSON object (no markdown, no prose before or after JSON) with exactly these keys:
{"artist":"artist name or unknown",
"copyright":"series/copyright or original",
"character":"character name(s) or none",
"meta":"meta tag or none",
"tags":"general Danbooru tags ONLY: comma-separated lowercase English; spaces inside phrases (long hair, blue eyes); include counts (1girl, solo), clothing, pose, expression, background. NO full sentences in any value."}
`,

  sd_tag_line: `Return ONLY one JSON object with key "tags": comma-separated English Stable Diffusion prompt tags/phrases (one line; spaces inside phrases OK). NO sentences, NO markdown, NO extra keys unless needed.`,

  // port-only extension：上游无此模板（上游靠 cTypeRuntime=min_structured_md 复用），
  // 保留以兼容既有 pe_torii_min_structured_md_body 语义；无直接 PROMPTS_B 消费方。
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
};

// upstream parity：官方 JSON 类格式集合（json / json_comic / min_structured_json / danbooru_line / sd_tag_line）。
// 上游消费方 torii_llama_helper.js 属 llama 推理路径，port 已裁剪 —— upstream parity, no consumer in port。
export const TORII_JSON_FORMATS: ReadonlySet<string> = new Set([
  'json',
  'json_comic',
  'min_structured_json',
  'danbooru_line',
  'sd_tag_line',
]);

// upstream parity, no consumer in port（上游由 torii_llama_helper.js 追加到 JSON 类 userQuery 尾部）
export const JSON_OUTPUT_SUFFIX =
  '\n\n# Output requirement\n' +
  'Return exactly one valid JSON object matching the schema above. ' +
  'Do not use markdown section headings (for example # 1. Thoughts, # 2. Key details, ' +
  '# 3. Long description). No prose before or after the JSON.\n';

// upstream parity, no consumer in port（上游为 torii 打标的统一 system prompt）
export const SYSTEM_PROMPT =
  "You are image captioning expert. Describe user's picture according to requested format and instructions.";

function shuffleInPlace(arr: string[]): string[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Torii grounding user-query 构造管线 — 1:1 移植自上游 makeUserQuery。
 * upstream parity, no consumer in port：上游由 torii_llama_helper.js（llama 路径）消费；
 * port 的反推走 CaptionPE / expand-mirror 路线，保留此管线以保证数据/行为完整性。
 */
export function makeUserQuery(
  item: ToriiGroundingItem,
  cType: string,
  useNames: boolean,
  addTags: boolean,
  addCharacters: boolean,
  addCharTags: boolean,
  addDescription: boolean,
  underscoresReplace = false,
): string {
  const tags = [...(item.tags || [])];
  shuffleInPlace(tags);
  let tagsString: string;
  if (underscoresReplace) {
    tagsString = tags
      .map((a) => (a.length > 3 ? a.replace(/_/g, ' ') : a))
      .join(', ');
  } else {
    tagsString = tags.join(' ');
  }

  let userRequest = '# Captioning format:\n';
  userRequest += PROMPTS_B[cType];
  userRequest += '\n';

  if (addTags) {
    userRequest += `# Booru tags for the image\n[${tagsString}]\n\n`;
  }

  if (useNames) {
    if (addCharacters) {
      let charsTags = [...(item.characters || [])];
      let charsString: string;
      if (underscoresReplace) {
        charsTags = charsTags.map((a) => a.replace(/_/g, ' '));
        charsString = charsTags.join(', ');
      } else {
        charsString = charsTags.join(' ');
      }

      userRequest +=
        '# Characters on picture:\n' +
        `Here are names/tags for characters from the picture, make sure to use them: [${charsString}].\n\n`;

      const charsPopularTags = item.char_p_tags || { chars: {}, skins: {} };
      const charsDescription = item.char_descr || { chars: {}, skins: {} };
      const popularTagsChars = charsPopularTags.chars || {};
      const popularTagsSkins = charsPopularTags.skins || {};
      const descrChars = charsDescription.chars || {};
      const descrSkins = charsDescription.skins || {};

      if (
        Object.keys(popularTagsChars).length > 0 &&
        (addCharTags || addDescription)
      ) {
        userRequest += '# Known traits for characters\n';
        const charUnderscores = underscoresReplace;

        if (addCharTags) {
          userRequest += 'Here are popular tags for each characters on picture:\n';
          for (const [cName, cTags] of Object.entries(popularTagsChars)) {
            const name = charUnderscores ? cName.replace(/_/g, ' ') : cName;
            const tagsS = charUnderscores
              ? cTags
                  .map((a) => (a.length > 3 ? a.replace(/_/g, ' ') : a))
                  .join(', ')
              : cTags.join(' ');
            userRequest += `${name}: [${tagsS}]\n`;
          }
          if (Object.keys(popularTagsSkins).length > 0) {
            userRequest += 'Extra tags for characters skins:\n';
            for (const [cName, cTags] of Object.entries(popularTagsSkins)) {
              const name = charUnderscores ? cName.replace(/_/g, ' ') : cName;
              const tagsS = charUnderscores
                ? cTags
                    .map((a) => (a.length > 3 ? a.replace(/_/g, ' ') : a))
                    .join(', ')
                : cTags.join(' ');
              userRequest += `${name}: [${tagsS}]\n`;
            }
          }
        } else if (addDescription) {
          userRequest +=
            'Here are general descriptions for each characters on the picture:\n';
          for (const [cName, cDescr] of Object.entries(descrChars)) {
            const name = charUnderscores ? cName.replace(/_/g, ' ') : cName;
            userRequest += `## ${name}\n${cDescr}\n\n`;
          }
          if (Object.keys(descrSkins).length > 0) {
            userRequest +=
              'Here are also descriptions for specific skin of characters:\n';
            for (const [cName, cDescr] of Object.entries(descrSkins)) {
              const name = charUnderscores ? cName.replace(/_/g, ' ') : cName;
              userRequest += `## ${name}\n${cDescr}\n\n`;
            }
          }
        }
      }
    } else {
      userRequest +=
        '# Characters on picture:\nTry to recognize the characters in the picture and use their names.\n';
    }
    userRequest += '\n';
  } else {
    userRequest += '# Characters on picture:\nAvoid to guess names for characters.\n';
  }

  return userRequest;
}

// Torii prompt 数据 — 训练 grounding 相关（历史命名空间导出，保留兼容）
export const TORII_PROMPTS_DATA = {
  PROMPTS_B,
  TORII_JSON_FORMATS,
  JSON_OUTPUT_SUFFIX,
  SYSTEM_PROMPT,
  makeUserQuery,
};
