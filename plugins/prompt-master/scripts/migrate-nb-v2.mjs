/**
 * [M2-T3 入库] 迁移工具收口（自插件根迁入 scripts/，M2 plan 2026-09-12-style-aesthetics-m2 Task 3）。
 * - 用途：nb v1→StylePresetV2 一次性迁移（M1-T3），使命已完成；留作 44 条 nb 预设的
 *   出处证据与 M2 新增预设 authoring（T4-T8）的复用模式参考——勿对现库重跑后覆盖未审内容。
 * - 来源批次：assets/style-presets/nb*.json ×44（source 'newbie-migrated'），
 *   落地于 commit c292c23（nb43/nb47 画师词清洗 00c79b1）。
 * - 幂等性：对已迁移产物重跑，输出与现库逐字节一致（MD5 比对通过，t41 验证留痕）。
 * - 内置 LIGHTING_BAN 全词表扫描：fragments/negative_hints 语料逐条过禁词表快照
 *   （anima.ts 7e33007 时点，见下方 LIGHTING_BAN 常量），任一命中即 fail——迁移质量门组成。
 * - 路径适配（唯一内容改动，已声明偏差）：ROOT 解析随迁入目录由 '..' 调整为 '../..'
 *   （原按脚本自位置定位 assets/，迁入 scripts/ 后不改则不可运行；逻辑零改动）。
 * 以下为原脚本头（M1-T3 时点，未改动）：
 */
/**
 * 一次性迁移脚本：assets/style-presets/nb*.json (44) → StylePresetV2（spec §10，plan Task 3）。
 *
 * 映射规则（全部以常量落表，不允许临场自由发挥）：
 * - id / name / rating(safe) / artist_max 直传；artists → artist_hints 直传，
 *   截断到 artist_max + 2 个候选（注入上限 artist_max 由 apply 层截断；+2 与 plan 质量门一致，
 *   golden nb01 即 5 候选/artist_max 3）。
 * - style_tags → base/theme：
 *     · 'anime_style' | 'anime style' → base 'anime style'
 *     · 'realistic_shading'           → theme 'realistic shading'（置于 theme 首位）
 *     · 其他取值 → THEME_PICK 按文件确认（原文小写化 + 下划线转空格 + 去尾句点），
 *       至多 3 个、逗号连接；脚本断言每个 pick 都 ∈ 该文件 style_tags。
 * - category：spec §4.4 迁移归属表（anime 24 / illustration 13 / cg_3d 2 / oriental 1 / retro 1 / graphic 3）。
 * - fragments / negative_hints：按 style_tags + 中文名语义逐文件 authoring（2-4 短语，image=video），
 *   全部过 VAGUE_WORDS 与 LIGHTING_BAN（词表快照自 src/pe-framework/dialect/anima.ts，commit 7e33007 时点）。
 * - applies_to ['anima','h3','sd']；source 'newbie-migrated'。
 *
 * 产物必须通过 tests/pe-framework/styles/nb-migration.test.ts 的质量门。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const DIR = resolve(ROOT, 'assets/style-presets')

// ── spec §4.4 迁移归属表（nb 编号 → category）────────────────────────────
const CATEGORY_BY_NB = {
  anime: [1, 2, 8, 9, 10, 11, 13, 16, 21, 23, 25, 27, 28, 34, 36, 38, 39, 40, 53, 56, 57, 58, 64, 65],
  illustration: [3, 4, 6, 7, 12, 14, 17, 18, 24, 47, 48, 51, 52],
  cg_3d: [15, 19],
  oriental: [5],
  retro: [26],
  graphic: [20, 35, 43],
}
const NB_TO_CATEGORY = {}
for (const [cat, nums] of Object.entries(CATEGORY_BY_NB)) for (const n of nums) NB_TO_CATEGORY[n] = cat

// ── style_tags 规范映射（plan 映射表）────────────────────────────────────
const BASE_TAGS = new Set(['anime_style', 'anime style'])
const THEME_CANONICAL = 'realistic_shading'

// ── LIGHTING_BAN 快照（src/pe-framework/dialect/anima.ts，2026-09-12 时点）──
const LIGHTING_BAN = [
  'sunlight', 'moonlight', 'rim light', 'warm lighting', 'cool lighting',
  'golden hour glow', 'soft lighting', 'backlighting', 'god rays',
  'light rays', 'volumetric light', 'spotlight', 'candlelight',
  'warm tone', 'cool tone', 'sepia',
  'light particles', 'backlit',
  'moonlit', 'sunlit', 'candlelit', 'daylight', 'firelit', 'moonlit night',
]
const VAGUE = ['cinematic', 'beautiful', '大气', '电影感']

// ── 逐文件 authoring 表（nb 编号 → fragments / negative_hints / theme pick）──
// theme pick：从该文件 style_tags 原文中选（规范 realistic_shading 优先置首，脚本断言归属）。
const AUTHORING = {
  1:  { frag: 'clean lineart, realistic shading, detailed eyes, contemporary anime palette', neg: ['photorealistic render', 'flat colors'], theme: ['realistic shading'] },
  2:  { frag: 'stylized bishoujo illustration, glossy hair rendering, soft gradient shading, delicate facial features', neg: ['photorealistic render', 'thick impasto'], theme: ['realistic shading'] },
  3:  { frag: 'atmospheric digital painting, soft ambient shading, luminous skin tones, moody background art', neg: ['flat colors', 'harsh outlines'], theme: ['realistic shading'] },
  4:  { frag: 'contemporary concept illustration, bold graphic shapes, textured painterly finish, trend-forward color design', neg: ['photorealistic render', 'dull color palette'], theme: [] },
  5:  { frag: 'hanfu-inspired flowing robes, chinese ornamental patterns, ink brush accents, fantasy palace backdrop', neg: ['western medieval clothing', 'modern streetwear'], theme: ['traditional chinese aesthetic', 'fantasy', 'painterly'] },
  6:  { frag: 'picture-book storybook texture, moe character design, soft rounded shapes, fine detailed linework', neg: ['gritty realism', 'photorealistic render'], theme: ['moe', 'painterly', 'digital art'] },
  7:  { frag: 'vivid complementary color blocking, high contrast shading, bold saturated palette, clean anime illustration', neg: ['muted color palette', 'low contrast'], theme: ['vibrant colors', 'high contrast'] },
  8:  { frag: 'fresh airy palette, light pastel tones, clean linework, breezy seasonal atmosphere', neg: ['heavy impasto', 'dark desaturated palette'], theme: ['fresh style'] },
  9:  { frag: 'vivid realistic lighting contrast, glossy highlight rendering, saturated color depth, lively shading', neg: ['flat colors', 'washed-out palette'], theme: ['vibrant colors', 'realistic lighting'] },
  10: { frag: 'hybrid cel shading, semi-painterly rendering, bishoujo character design, crisp anime key visual finish', neg: ['photorealistic render', 'rough draft lines'], theme: ['japanese anime bishoujo illustration', 'cel-shading hybrid rendering'] },
  11: { frag: 'refreshing vivid palette, crisp high-contrast shading, clean bright linework, lively anime colors', neg: ['muted earth tones', 'murky shadows'], theme: ['vibrant colors', 'high contrast'] },
  12: { frag: 'oil painting texture, extreme value contrast, hand-painted brushwork, bold cross-hatching', neg: ['flat digital gradients', 'pastel softness'], theme: ['oil painting', 'extreme high contrast', 'dynamic line art'] },
  13: { frag: 'razor-sharp lineart, high contrast color separation, punchy saturated shading, crisp anime finish', neg: ['fuzzy linework', 'washed-out colors'], theme: ['vibrant colors', 'high contrast'] },
  14: { frag: 'high-contrast impasto shading, sharpened edge rendering, thick paint accents, vivid illustration palette', neg: ['flat cel shading', 'muted colors'], theme: ['vibrant colors', 'high contrast'] },
  15: { frag: 'stylized 3d anime rendering, realistic shadow shaping, game-grade material finish, bold action styling', neg: ['flat cel shading', 'low-detail textures'], theme: ['realistic shading'] },
  16: { frag: 'ethereal atmosphere rendering, delicate floral motifs, billowing fabric detail, painterly oil texture', neg: ['harsh industrial backdrop', 'flat colors'], theme: ['delicate floral details', 'high saturation blue sky', 'painterly texture'] },
  17: { frag: 'expressionist oil brushwork, layered glazing colors, bright highlight accents, textured canvas feel', neg: ['flat colors', 'airbrushed smoothness'], theme: ['oil painting', 'expressionist brushwork and high textural detail', 'extreme high contrast'] },
  18: { frag: 'granblue fantasy style oil painting, ornate game key art finish, realistic anime rendering, rich layered color depth', neg: ['flat colors', 'minimalist sketch'], theme: ['fantasy art', 'dark romanticism', 'gothic surrealism'] },
  19: { frag: '2d character over realistic 3d background, ornate anime detailing, pbr texture depth, rich game illustration finish', neg: ['flat background', 'low-detail textures'], theme: ['physically based rendering (pbr)', 'highly detailed texture', 'digital art'] },
  20: { frag: 'minimal clean linework, high saturation flat color, bold emblem composition, vector graphic finish', neg: ['photorealistic render', 'painterly texture'], theme: ['art nouveau', 'pop art', 'vector art'] },
  21: { frag: 'classic 2d animation style, hand-drawn cel paint, clean character acting, realistic shading', neg: ['3d cgi render', 'photorealistic render'], theme: ['realistic shading'] },
  23: { frag: 'battle girl action styling, light muted color wash, realistic shadow shapes, dynamic combat pose energy', neg: ['flat colors', 'oversaturated palette'], theme: [] },
  24: { frag: 'impasto oil shading, granblue fantasy art style, crisp edge definition, ornate game illustration finish', neg: ['flat cel shading', 'minimalist flat design'], theme: ['granblue fantasy official art style', 'illustration'] },
  25: { frag: 'hard-edged bold outlines, flat color blocking, high contrast palette, decorative graphic background', neg: ['soft gradients', 'photorealistic render'], theme: ['flat color', 'bold lines', 'pop art'] },
  26: { frag: 'extreme neon color contrast, synthwave grid motifs, heavy color grading, graphic novel inking', neg: ['low contrast', 'muted pastel palette'], theme: ['cyberpunk aesthetic', 'graphic novel style', 'monochromatic dystopian realism'] },
  27: { frag: '2d anime screenshot framing, flat art shading, clean screen composition, realistic shading depth', neg: ['photorealistic render', 'sketchy lines'], theme: ['realistic shading', 'animation screenshot', 'flat art'] },
  28: { frag: 'softly diffused shading, realistic cel rendering, gentle value transitions, clean anime illustration', neg: ['harsh contrast', 'gritty texture'], theme: ['illustration', 'animation screenshot', 'flat art'] },
  34: { frag: 'flat color illustration, cool blue-white palette, bright airy contrast, crisp lineart with soft gradients', neg: ['dark moody palette', 'heavy impasto'], theme: ['cel shading with soft gradients', 'vibrant blue and white palette', 'airy and bright atmosphere'] },
  35: { frag: 'flat vector-like cel shading, azure and golden yellow palette, clean line art, bright light novel cover composition', neg: ['dark desaturated palette', 'heavy texture'], theme: ['light novel cover aesthetic', 'azure and golden yellow color palette'] },
  36: { frag: 'flat cel shading, saturated low-contrast palette, airy pastel atmosphere, clear line art with soft focus background', neg: ['high contrast shadows', 'gritty realism'], theme: ['cel shaded', 'vibrant palette', 'ghibli-esque color aesthetic'] },
  38: { frag: 'fresh summer anime palette, flat cel shading, breezy seasonal mood, crisp lineart', neg: ['wintry muted palette', 'heavy impasto'], theme: ['cel shading with soft gradients', 'airy and bright atmosphere', 'crisp line art'] },
  39: { frag: 'high-precision hard-edged lineart, realistic light and shadow modeling, refined material rendering, polished manga illustration', neg: ['flat colors', 'loose sketchy lines'], theme: ['realistic shading'] },
  40: { frag: 'sharp specular shading, realistic material textures, crisp anime realism, defined edge control', neg: ['flat colors', 'blurry soft focus'], theme: ['realistic shading'] },
  43: { frag: 'gritty ink lineart, limited flat palette, high contrast flat shading, offset color outline', neg: ['smooth airbrushed rendering', 'photorealistic render'], theme: ['vibrant pop art', 'limited color palette', 'bold rough lineart'] },
  47: { frag: 'impressionist brushstroke shading, muted cool palette, impasto texture, soft ambient depth', neg: ['flat cel shading', 'hard digital edges'], theme: ['impressionistic brushstrokes', 'digital painting', 'loose background texture'] },
  48: { frag: 'mottled dappled shading, semi-impasto rendering, cool color palette, shallow depth of field', neg: ['high saturation neon palette', 'hard edge cel shadows'], theme: ['soft cel shading', 'cool color palette', 'lofi aesthetic'] },
  51: { frag: 'cyan neon accents on magenta shadows, thick impasto rendering, glossy highlight edges, high contrast digital painting', neg: ['flat pastel palette', 'thin sketchy paint'], theme: ['cyan and magenta color palette', 'high contrast', 'smooth digital painting'] },
  52: { frag: 'chalky grain texture, hazy cool atmosphere, soft flat shading, half-realistic anime rendering', neg: ['high saturation palette', 'crisp hard edges'], theme: ['monochromatic blue palette', 'pastel colors', 'grainy texture'] },
  53: { frag: 'fine thin lineart, translucent pale color wash, bright flat shading, airy minimalist background', neg: ['heavy dark shadows', 'thick impasto'], theme: ['cel shading', 'soft pastel color palette', 'minimalist white background'] },
  56: { frag: 'dimensional anime rendering, high saturation palette, volumetric character shading, crisp animated finish', neg: ['flat 2d shading', 'washed-out colors'], theme: [] },
  57: { frag: 'pop-saturated character colors, glossy skin highlights, ornate detailed accessories, vivid gradient hair', neg: ['muted earth palette', 'rough sketch lines'], theme: [] },
  58: { frag: 'clean bright anime illustration, smooth flat shading, playful character design, crisp detailing', neg: ['gritty texture', 'heavy impasto'], theme: [] },
  64: { frag: 'soft glossy anime rendering, luminous skin tones, stylish contemporary fashion feel, delicate color gradients', neg: ['flat dull colors', 'rough lineart'], theme: [] },
  65: { frag: 'polished bishoujo rendering, airy highlight accents, elegant pastel-to-vivid color balance, refined character illustration', neg: ['muddy colors', 'harsh outlines'], theme: [] },
}

// ── 工具 ─────────────────────────────────────────────────────────────────
const normTag = (t) => t.toLowerCase().replaceAll('_', ' ').replace(/\.$/, '').trim()
const fail = (msg) => { throw new Error(`[migrate-nb-v2] ${msg}`) }

const files = readdirSync(DIR).filter((f) => /^nb\d+_.*\.json$/.test(f)).sort()
if (files.length !== 44) fail(`expected 44 nb files, found ${files.length}`)

const seenIds = new Set()
let written = 0

for (const f of files) {
  const nb = Number(/^nb(\d+)_/.exec(f)?.[1])
  if (!nb || !AUTHORING[nb]) fail(`${f}: no authoring entry for nb${nb}`)
  const a = AUTHORING[nb]
  const raw = JSON.parse(readFileSync(resolve(DIR, f), 'utf8'))
  // 幂等：脚本中断重跑时输入可能是自身产出的 v2（artists→artist_hints、style_tags 已消费）
  const isV2 = raw.fragments !== undefined
  const v1 = raw
  const tags = v1.style_tags ?? []
  const normed = tags.map(normTag)

  // 直传校验
  if (v1.rating !== 'safe') fail(`${f}: v1 rating=${v1.rating}, expected 'safe'`)
  const artists = v1.artists ?? v1.artist_hints
  if (!Array.isArray(artists) || artists.length === 0) fail(`${f}: artists missing/empty`)
  if (!Number.isInteger(v1.artist_max) || v1.artist_max < 1) fail(`${f}: v1 artist_max invalid`)
  const category = NB_TO_CATEGORY[nb]
  if (!category) fail(`${f}: no category in spec §4.4 table`)

  // base：规范映射；authoring 表不允许对有规范 tag 的文件缺席
  const hasAnimeTag = tags.some((t) => BASE_TAGS.has(t)) || (isV2 && v1.base === 'anime style')
  // theme：规范 realistic_shading 置首 + pick（断言每个 pick 来自原文）
  const themeParts = []
  if (tags.includes(THEME_CANONICAL) || (isV2 && typeof v1.theme === 'string' && v1.theme.startsWith('realistic shading'))) {
    themeParts.push('realistic shading')
  }
  if (isV2) {
    // v2 输入重跑：theme 以既有文件为准（首跑已做过 pick∈style_tags 校验），此处校验表一致性
    const existing = typeof v1.theme === 'string' && v1.theme.length > 0 ? v1.theme.split(', ').map((s) => s.trim()) : []
    for (const part of existing) {
      if (part !== 'realistic shading' && !a.theme.includes(part)) fail(`${f}: theme part "${part}" not in authoring table`)
      if (!themeParts.includes(part)) themeParts.push(part)
    }
  } else {
    for (const pick of a.theme) {
      if (!normed.includes(pick)) fail(`${f}: theme pick "${pick}" not in style_tags ${JSON.stringify(tags)}`)
      if (pick === 'realistic shading' && themeParts[0] === 'realistic shading') continue
      themeParts.push(pick)
    }
  }
  if (themeParts.length > 3) fail(`${f}: theme exceeds 3 parts`)

  // fragments / negative 质量自检（VAGUE + LIGHTING_BAN + 相斥词进出双向扫描）
  for (const corpus of [a.frag, ...a.neg, themeParts.join(', ')]) {
    const low = corpus.toLowerCase()
    for (const w of VAGUE) if (low.includes(w)) fail(`${f}: VAGUE word "${w}" in "${corpus}"`)
    for (const b of LIGHTING_BAN) if (low.includes(b)) fail(`${f}: LIGHTING_BAN "${b}" in "${corpus}"`)
  }
  if (!a.frag.trim() || a.neg.length < 1) fail(`${f}: empty fragments/negatives`)
  const phrases = a.frag.split(',').map((p) => p.trim()).filter(Boolean)
  if (phrases.length < 2 || phrases.length > 4) fail(`${f}: fragment phrase count ${phrases.length} not in 2-4`)

  // v2 组装（golden nb01 键序）
  const out = {
    id: v1.id,
    name: v1.name,
    category,
    rating: 'safe',
    ...(hasAnimeTag ? { base: 'anime style' } : {}),
    ...(themeParts.length > 0 ? { theme: themeParts.join(', ') } : {}),
    fragments: { image: a.frag, video: a.frag },
    negative_hints: a.neg,
    artist_hints: artists.slice(0, v1.artist_max + 2),
    artist_max: v1.artist_max,
    applies_to: ['anima', 'h3', 'sd'],
    source: 'newbie-migrated',
  }
  if (seenIds.has(out.id)) fail(`${f}: duplicate id ${out.id}`)
  seenIds.add(out.id)

  // 序列化：2 空格缩进；negative_hints/artist_hints/applies_to 行内数组（对齐 t2 内置 JSON 风格）
  const q = (s) => JSON.stringify(s)
  const inline = (arr) => `[${arr.map(q).join(', ')}]`
  const lines = [
    `{`,
    `  "id": ${q(out.id)},`,
    `  "name": ${q(out.name)},`,
    `  "category": ${q(out.category)},`,
    `  "rating": ${q(out.rating)},`,
    ...(out.base !== undefined ? [`  "base": ${q(out.base)},`] : []),
    ...(out.theme !== undefined ? [`  "theme": ${q(out.theme)},`] : []),
    `  "fragments": {`,
    `    "image": ${q(out.fragments.image)},`,
    `    "video": ${q(out.fragments.video)}`,
    `  },`,
    `  "negative_hints": ${inline(out.negative_hints)},`,
    `  "artist_hints": ${inline(out.artist_hints)},`,
    `  "artist_max": ${out.artist_max},`,
    `  "applies_to": ${inline(out.applies_to)},`,
    `  "source": ${q(out.source)}`,
    `}`,
  ]
  writeFileSync(resolve(DIR, f), lines.join('\n') + '\n', 'utf8')
  written++
}

// 收尾断言：authoring 表与文件一一对应
const fileNbs = files.map((f) => Number(/^nb(\d+)_/.exec(f)[1])).sort((x, y) => x - y)
const tableNbs = Object.keys(AUTHORING).map(Number).sort((x, y) => x - y)
if (JSON.stringify(fileNbs) !== JSON.stringify(tableNbs)) fail('authoring table / file set mismatch')

console.log(`migrated ${written}/${files.length} nb presets to v2`)
