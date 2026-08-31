// MiniMax H3 场景目录 — 1:1 移植自 PM minimaxScenarios/catalog.js
// 10 个场景：表单字段 + 硬约束 + 输出模式 + 组装提示

export interface AspectOption {
  value: string;
  label: string;
}

export interface FormFieldOption {
  value: string;
  label: string;
}

export interface FormField {
  key: string;
  label: string;
  type: 'select' | 'text' | 'textarea';
  options?: FormFieldOption[];
  default?: string;
  required?: boolean;
  showIf?: { key: string; equals?: string; notEquals?: string; gte?: string };
  placeholder?: string;
  rows?: number;
}

export interface MiniMaxScenario {
  id: string;
  peId: string;
  builtinKey: string;
  name: string;
  description: string;
  sort: number;
  outputMode: 'full_reference' | 'plain_video_prompt' | 'timeline_template' | 'director_segments';
  mediaExpandLayout?: boolean;
  skillSource?: string;
  formFields: FormField[];
  hardConstraints: string[];
  assembleHints?: string;
}

export const ASPECT_COMMON: AspectOption[] = [
  { value: '16:9', label: '16:9 横屏' },
  { value: '9:16', label: '9:16 竖屏' },
  { value: '1:1', label: '1:1 方形' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
];

export const CONTINUOUS_STORY_MAX_SEGMENTS = 8;

function customPlanShowIf(extra?: { key: string; gte: string }): any {
  const conds: any[] = [{ key: 'plan_mode', equals: 'custom' }];
  if (extra) conds.push(extra);
  return conds.length === 1 ? conds[0] : { all: conds };
}

function buildContinuousStoryBeatFields(max: number): FormField[] {
  const fields: FormField[] = [];
  for (let i = 1; i <= max; i += 1) {
    const field: FormField = {
      key: `segment_${i}_beat`,
      label: `第 ${i} 段在干什么`,
      type: 'textarea',
      rows: 2,
      placeholder:
        i === 1
          ? '例如：傍晚室内，短发女人坐在桌边看手机，望向窗外说「再等我五分钟」'
          : '例如：无硬切接上段，特写她转头微笑说「好」',
      required: true,
      showIf:
        i >= 2
          ? customPlanShowIf({ key: 'segment_count', gte: String(i) })
          : customPlanShowIf(),
    };
    fields.push(field);
  }
  return fields;
}

export const MINIMAX_SCENARIOS: MiniMaxScenario[] = [
  {
    id: 'full_reference',
    peId: 'pe_expand_h3_full_reference',
    builtinKey: 'h3_full_reference',
    name: 'Minimax六段式通用提示词',
    description:
      '通用：将素材/简述改写为 MiniMax-H3 Full-Reference 六段视频提示词（subject_definitions → non_diegetic_music）。',
    sort: 5,
    outputMode: 'full_reference',
    mediaExpandLayout: true,
    skillSource: 'h3-prompt-writing / Full-Reference template',
    formFields: [
      {
        key: 'duration_seconds',
        label: '目标时长（秒）',
        type: 'select',
        options: [
          { value: '5', label: '5 秒' },
          { value: '10', label: '10 秒' },
          { value: '15', label: '15 秒' },
          { value: 'custom', label: '自定义（写在需求里）' },
        ],
        default: '10',
      },
      {
        key: 'aspect_ratio',
        label: '画幅比例',
        type: 'select',
        options: ASPECT_COMMON,
        default: '16:9',
      },
      {
        key: 'expand_mode',
        label: '改写模式',
        type: 'select',
        options: [
          { value: 'strict', label: '严格改写（不编造情节）' },
          { value: 'expand', label: '允许扩写补全（帮我写提示词）' },
        ],
        default: 'strict',
      },
    ],
    hardConstraints: [
      'Output ONLY six sections in order. ZH titles: 主体定义/摘要/保留分析/详细描述/整体声景/非叙事配乐. EN titles: subject_definitions/summary/retention_analysis/detailed_description/overall_soundscape/non_diegetic_music.',
      'Section titles AND body language follow Output language (zh/en dual templates). Keep English reference tags/markers; preserve original language only inside <d> for dialogue/lyrics/on-screen text.',
      'Keep reference label identities stable: <Subject N>, <Picture N>, <Video N>, <Audio N>.',
      'Do not invent plot unless expand_mode is expand.',
    ],
    assembleHints: 'Use the language-matched Full-Reference guide (zh/en) as the primary format.',
  },

  {
    id: 'continuous_story',
    peId: 'pe_expand_minimax_continuous_story',
    builtinKey: 'minimax_continuous_story',
    name: '连续剧情（导演台）',
    description:
      '多段连续镜头：AI智能分段只需段数+创作需求；自定义则手写每段内容。输出公共「主体定义」+ 每段六段式（去掉重复角色设定）。',
    sort: 8,
    outputMode: 'director_segments',
    mediaExpandLayout: true,
    skillSource: 'MiniMax H3 Director / 段间引导',
    formFields: [
      { key: 'prompt_kind', label: '生成方式', type: 'select', options: [
        { value: 't2v', label: '文生视频（无参考图，公共设定用文字锁角色）' },
        { value: 'r2v', label: '参考图生视频（公共设定锁 <Picture N>/<Subject N>）' },
      ], default: 't2v', required: true },
      { key: 'plan_mode', label: '分段方式', type: 'select', options: [
        { value: 'ai', label: 'AI智能分段（只填创作需求，由 AI 拆段）' },
        { value: 'custom', label: '自定义（自己写每段内容和时长）' },
      ], default: 'ai', required: true },
      { key: 'segment_count', label: '生成几段', type: 'select', options: Array.from({ length: CONTINUOUS_STORY_MAX_SEGMENTS - 1 }, (_, i) => {
        const n = String(i + 2);
        return { value: n, label: `${n} 段` };
      }), default: '4', required: true },
      { key: 'segment_seconds', label: '每段时长', type: 'select', options: [
        { value: '5', label: '约 5 秒（导演台默认）' },
        { value: '10', label: '约 10 秒' },
        { value: '15', label: '约 15 秒' },
      ], default: '5', required: true, showIf: { key: 'plan_mode', equals: 'custom' } },
      { key: 'aspect_ratio', label: '画幅比例', type: 'select', options: ASPECT_COMMON, default: '16:9' },
      { key: 'visual_style', label: '视觉风格锁定', type: 'text', placeholder: '例如：真人实拍，电影感；或赛博朋克夜景', default: '' },
      { key: 'expand_mode', label: '改写模式', type: 'select', options: [
        { value: 'expand', label: '允许补全运镜/声画细节（推荐）' },
        { value: 'strict', label: '严格按各段说明，少编造' },
      ], default: 'expand', showIf: { key: 'plan_mode', equals: 'custom' } },
      ...buildContinuousStoryBeatFields(CONTINUOUS_STORY_MAX_SEGMENTS),
    ],
    hardConstraints: [
      'Output TWO parts only, nothing else. No markdown fences, no chat, no extra commentary.',
      'Part 1 separator: ===== 公共设定 =====  This block is pasted into Director 公共参数. It contains ONLY 主体定义 / subject_definitions. Do NOT put summary or shots here.',
      'Part 2: EXACTLY N groups (segment_count). Separators: ===== 提示词组 k ===== (k from 1 to N).',
      'ZH titles (forced when Output language is zh): 公共设定 uses 主体定义:. Each 提示词组 uses MiniMax 六段式 but WITHOUT 主体定义: — only 摘要: / 保留分析: / 详细描述: / 整体声景: / 非叙事配乐: in that order. Never output subject_definitions:/summary: English headers when zh.',
      'EN titles (when Output language is en): public block uses subject_definitions:. Each group uses summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music. Never repeat subject_definitions inside a group.',
      'Public 主体定义 locks identity/wardrobe once. If no media, describe subjects in prose without inventing <Picture N>.',
      'Each 提示词组 must NOT redefine appearance/wardrobe. Reference <Subject N> only. retention_analysis cites who appears in this group and fully_preserved / partially_preserved — no new character bible.',
      'Group 2+ 详细描述 MUST start with「无硬切。紧接上一段。」or "No hard cut. Immediately following the previous section."',
      'Each 详细描述 ends on a stable handoff pose (段末停在…). Last group may complete the action. Last line of 详细描述: 不要乱说话',
      'Reuse the same cast, wardrobe, space, and music theme across groups unless the user explicitly changes them.',
      'Music/soundscape: same motif; groups 1..N-1 must not fade out. Final group may resolve lightly.',
      'Timestamps [Shot N] At MM:SS.mmm reset to 0 at the start of EACH group.',
      'Director 段间引导 / 引用上段 is a UI toggle, not a prompt field.',
      'plan_mode=ai: invent each segment beat and duration from 创作需求 only; never ask the user to fill per-segment fields. plan_mode=custom: follow 第 N 段在干什么 and 每段时长.',
    ],
    assembleHints: 'Part 1 = Director 公共参数 (主体定义 only). Part 2 = N MiniMax Full-Reference groups minus 主体定义. AI mode splits 创作需求 into N beats; custom mode uses user beats.',
  },

  {
    id: 'product_ad',
    peId: 'pe_expand_minimax_product_ad',
    builtinKey: 'minimax_product_ad',
    name: '极简产品广告',
    description: '电商/新品发布：Apple 风极简产品广告片提示词。',
    sort: 10,
    outputMode: 'full_reference',
    mediaExpandLayout: true,
    skillSource: 'minimalist-product-ad-generator',
    formFields: [
      { key: 'duration_seconds', label: '目标时长', type: 'select', options: [
        { value: '5', label: '5 秒' },
        { value: '10', label: '10 秒（推荐）' },
        { value: '15', label: '15 秒' },
      ], default: '10', required: true },
      { key: 'aspect_ratio', label: '画幅比例', type: 'select', options: [...ASPECT_COMMON, { value: 'match_reference', label: '匹配参考图' }], default: '16:9', required: true },
      { key: 'apple_style', label: '苹果风模板', type: 'select', options: [
        { value: 'white-tech', label: '白色科技风' },
        { value: 'dark-rim-light', label: '黑底轮廓光' },
        { value: 'brand-color-field', label: '品牌色块' },
        { value: 'light-lifestyle', label: '生活方式轻场景' },
      ], default: 'white-tech', required: true },
      { key: 'variant_strategy', label: '款式策略', type: 'select', options: [
        { value: 'single', label: '单款' },
        { value: 'multi', label: '多款/多色' },
      ], default: 'single' },
      { key: 'main_variant', label: '主推款 / 主色名', type: 'text', default: '' },
      { key: 'narrative_spine', label: '叙事脊柱', type: 'select', options: [
        { value: 'Product Launch', label: '产品发布型（推荐）' },
        { value: 'Feature Touch', label: '功能触感型' },
        { value: 'Color Family', label: '色彩家族型' },
      ], default: 'Product Launch' },
      { key: 'copy_mode', label: '画面文案', type: 'select', options: [
        { value: 'agent_generate', label: '由模型生成 Apple 风文案' },
        { value: 'user_provided', label: '使用我提供的文案' },
      ], default: 'agent_generate' },
      { key: 'user_copy', label: '用户文案', type: 'text', default: '', showIf: { key: 'copy_mode', equals: 'user_provided' } },
      { key: 'product_selling_points', label: '卖点 / 可展示动作', type: 'textarea', default: '' },
    ],
    hardConstraints: [
      'Apple-style means clean composition, premium light, restrained motion, negative space — NOT recoloring the product body.',
      'Preserve product body color/material from reference media; never recolor to generic silver/white.',
      'In-frame copy: follow Output language lock — English 3–5 words OR Chinese ~4–12 chars; single line only; never two rows or bottom subtitles.',
      'White-tech: first-half text black/dark gray; second-half = specific product color. Dark-rim-light may use white for first half.',
      'No grids, split screens, collage, storyboard boards, or product walls — especially not in the ending.',
      'Prefer one mid-film copy moment + one final copy moment for ~10s films.',
      'Use reference media as <Picture N> anchors; map hero / material detail / closing composition roles when multiple images exist.',
      'Default video model language: MiniMax-H3 premium product film camera language + native Apple-tech BGM direction (~100 BPM pluck/noise bed).',
    ],
    assembleHints: 'Deliver a Full-Reference 6-section prompt for a minimalist product ad film.',
  },

  {
    id: 'handdrawn_live',
    peId: 'pe_expand_minimax_handdrawn',
    builtinKey: 'minimax_handdrawn',
    name: '手绘实拍融合',
    description: '固定 15s/16:9：手绘发光动画×实拍。',
    sort: 20,
    outputMode: 'plain_video_prompt',
    mediaExpandLayout: true,
    skillSource: 'handdrawn-live-video-generator',
    formFields: [
      { key: 'contact_object', label: '接触对象 / 手部动作', type: 'text', default: '', required: true },
      { key: 'mood', label: '情绪氛围', type: 'select', options: [
        { value: '生活感', label: '生活感' },
        { value: '可爱', label: '可爱' },
        { value: '怀旧', label: '怀旧' },
        { value: '温柔', label: '温柔' },
        { value: '略带切感', label: '略带切感' },
      ], default: '生活感' },
      { key: 'prompt_language', label: 'Prompt 语言', type: 'select', options: [
        { value: 'follow_user', label: '跟随用户输入' },
        { value: 'zh', label: '中文' },
        { value: 'en', label: '英文' },
        { value: 'ja', label: '日文' },
      ], default: 'follow_user' },
      { key: 'initial_drawn_form', label: '手绘初始形态（可选）', type: 'text', default: '' },
      { key: 'style_limits', label: '风格限制（可选）', type: 'textarea', default: '' },
    ],
    hardConstraints: [
      'FIXED: 15 seconds, 16:9. Do not change duration/aspect.',
      'Text-to-video first: media is optional. Without attached media, NEVER invent <Picture N>/<Subject N>.',
      'Required section order: opening line → live-action space & phone texture → 0-3 → 3-6 → 6-10 → 10-13 → 13-15 → hand-drawn texture → camera chase → prohibitions → ambience.',
      'FORBIDDEN formats: Full-Reference six sections (主体定义/摘要/保留分析…), subject_definitions, retention_analysis.',
      '0–3s must include clear live-action contact; same entity continuously morphs — no sudden new characters.',
      'Same space or adjacent continuous space; no hard location jumps.',
      'Hand-drawn feel: crayon/chalk/colored pencil/pastel/rough brush. Forbid 3DCG, plush, clean vector, smooth neon.',
      'Forbid horror tropes: giant eyes, ripping mouths, teeth threats, jump scares.',
      'Camera lags half a beat; do not keep subject perfectly centered.',
      '13–15s must include space-level transform + tender aftertaste + cute gag.',
      'Invent fresh content every time; do not recycle stock gags.',
    ],
    assembleHints: 'Output ONE ready-to-run plain H3 T2V prompt. Chinese opening:「15秒，16:9横版视频。将实拍的〇〇与手绘发光动画融合的影像。」',
  },

  {
    id: 'coop_game',
    peId: 'pe_expand_minimax_coop_game',
    builtinKey: 'minimax_coop_game',
    name: '双人游戏开场',
    description: '固定约 15s/16:9 主机菜单框架。',
    sort: 30,
    outputMode: 'timeline_template',
    mediaExpandLayout: true,
    skillSource: 'co-op-game-intro-generator',
    formFields: [
      { key: 'visual_style', label: '视觉风格', type: 'select', options: [
        { value: '赛博朋克', label: '赛博朋克' },
        { value: '像素风', label: '像素风' },
        { value: '水彩手绘', label: '水彩手绘' },
        { value: '粘土风', label: '粘土风' },
        { value: '日系动漫', label: '日系动漫' },
        { value: '暗黑奇幻', label: '暗黑奇幻' },
        { value: '蒸汽朋克', label: '蒸汽朋克' },
        { value: 'custom', label: '自定义' },
      ], default: '赛博朋克', required: true },
      { key: 'visual_style_custom', label: '自定义风格描述', type: 'text', default: '', showIf: { key: 'visual_style', equals: 'custom' } },
      { key: 'game_title', label: '游戏名称', type: 'text', default: '', required: true },
      { key: 'player1_name', label: 'PLAYER 1 名字', type: 'text', default: '', required: true },
      { key: 'player2_name', label: 'PLAYER 2 名字', type: 'text', default: '', required: true },
      { key: 'height_contrast', label: '体型对比备注', type: 'text', default: '' },
    ],
    hardConstraints: [
      'FIXED UI framework 16:9 console menu: centered duo, top-left player cards, right vertical menu, bottom caution/decor strip, CONTINUE as visual center.',
      'Style changes appearance only — never layout/information hierarchy.',
      'Character refs are identity anchors only; redraw faces into selected style; do not inherit photo realism.',
      'P1 left/taller lightweight claw; P2 right/shorter heavy fist. Never swap names/sides or merge bodies.',
      'Menu titles single-line ALL CAPS. Palette ≤5 colors; red only for danger/exit.',
      'Forbid third player, split-screen, hard cuts, gore, weapons, official game logos, brand UI clones, watermarks.',
      'Fixed timeline beats: 0–2s menu, 2–4s P1 arm equip, 4–7s P2 heavy arm, 7–8.5s CONFIRM CONFIG, 8.5–10s LOADING world transform, 10–15s third-person enter world.',
      'UI copy tokens: START NEW GAME / CONTINUE / SETTINGS / EXIT GAME / READY / CONFIRM CONFIG / LOADING.',
    ],
    assembleHints: 'Output one complete H3 timeline video prompt (~15s).',
  },

  {
    id: 'paper_collage',
    peId: 'pe_expand_minimax_paper_collage',
    builtinKey: 'minimax_paper_collage',
    name: '纸拼贴讲解',
    description: '口播句/知识点 → 半调纸拼贴停格动画提示词。',
    sort: 40,
    outputMode: 'plain_video_prompt',
    mediaExpandLayout: true,
    skillSource: 'paper-collage-explainer-generator',
    formFields: [
      { key: 'aspect_ratio', label: '画幅', type: 'select', options: ASPECT_COMMON, default: '16:9' },
      { key: 'clip_duration', label: '单段时长', type: 'select', options: [
        { value: '4', label: '4 秒（默认）' },
        { value: '5', label: '5 秒' },
        { value: '6', label: '6 秒' },
      ], default: '4' },
      { key: 'palette_tone', label: '色调偏好', type: 'select', options: [
        { value: 'burnt_orange', label: '焦橙/红（紧迫）' },
        { value: 'mustard', label: '芥末黄（警示）' },
        { value: 'dark_green', label: '墨绿（认知/平静）' },
        { value: 'deep_purple', label: '深紫（记忆/神秘）' },
        { value: 'teal', label: '青绿（协作）' },
        { value: 'magenta', label: '玫红（荒诞/戏剧）' },
      ], default: 'dark_green' },
      { key: 'audio_plan', label: '音频方案', type: 'select', options: [
        { value: 'sfx_only', label: '仅拼贴音效' },
        { value: 'sfx_plus_bgm', label: '音效+BGM' },
        { value: 'sfx_plus_vo', label: '音效+旁白' },
        { value: 'sfx_bgm_vo_subs', label: '音效+BGM+旁白+字幕' },
        { value: 'silent', label: '静音' },
      ], default: 'sfx_only' },
      { key: 'emotion', label: '情绪', type: 'select', options: ['平静', '紧迫', '讽刺', '惊奇', '荒诞', '澄清', '反思', '神秘', '轻快'].map((x) => ({ value: x, label: x })), default: '澄清' },
      { key: 'visual_metaphor', label: '视觉隐喻（一句话）', type: 'textarea', default: '' },
    ],
    hardConstraints: [
      'Style signature: flat bold color field + B&W halftone cut-outs + selective cardstock + cream keylines + soft paper shadows + stop-motion assembly.',
      'Motion must be stop-motion assembly: slide-in / pop-in / settle / press-flat / pause / lock. Forbid smooth digital pan-zoom, global fades, chaotic scatter.',
      'Default keep collage SFX; do not add BGM/VO/subs unless audio_plan requires.',
      'Forbid readable letters/numbers/UI/subtitles/watermarks/logos unless user explicitly asks.',
      'Opening color field must match approved tone; avoid unapproved kraft/brown paper default.',
      'Paper controllable: not too flat, not overly dirty/wrinkled/brown.',
      'Motion order: clean color field → base structure → main metaphor → secondary objects → lock final composition → brief hold.',
    ],
    assembleHints: 'Output a ready H3 stop-motion collage explainer prompt.',
  },

  {
    id: 'brand_promo',
    peId: 'pe_expand_minimax_brand_promo',
    builtinKey: 'minimax_brand_promo',
    name: '品牌宣传短片',
    description: '基于可核验品牌素材与推广目标，输出品牌事实约束下的宣传短片提示词。',
    sort: 50,
    outputMode: 'full_reference',
    mediaExpandLayout: true,
    skillSource: 'brand-promo-video-generator',
    formFields: [
      { key: 'duration_seconds', label: '目标时长', type: 'select', options: [
        { value: '15', label: '15 秒（推荐）' },
        { value: '20', label: '20 秒' },
        { value: '30', label: '30 秒' },
      ], default: '15' },
      { key: 'aspect_ratio', label: '画幅比例', type: 'select', options: ASPECT_COMMON, default: '16:9' },
      { key: 'audience', label: '目标受众', type: 'text', default: '', required: true },
      { key: 'campaign_focus', label: '推广重点', type: 'textarea', default: '', required: true },
      { key: 'product_type', label: '叙事脊柱类型', type: 'select', options: [
        { value: 'physical', label: '实体产品' },
        { value: 'ai_saas', label: 'AI/SaaS' },
        { value: 'service', label: '服务/公司' },
        { value: 'image_led', label: '影像主导' },
      ], default: 'physical' },
      { key: 'channel', label: '投放渠道', type: 'select', options: ['官网', '社交媒体横版', '短视频竖版', '投流', '线下活动', '其他'].map((x) => ({ value: x, label: x })), default: '短视频竖版' },
      { key: 'cta', label: '行动号召 CTA', type: 'text', default: '' },
      { key: 'key_claims', label: '已核验主张（勿编造）', type: 'textarea', default: '' },
      { key: 'vo_language', label: '旁白/文案语言', type: 'select', options: [
        { value: 'auto', label: '跟随品牌/素材' },
        { value: 'zh', label: '中文' },
        { value: 'en', label: '英文' },
        { value: 'none', label: '无旁白' },
      ], default: 'auto' },
    ],
    hardConstraints: [
      'Never invent product claims, metrics, or official statements not provided by the user.',
      'Never forge/redraw/approximate unauthorized logos, wordmarks, UI, packaging, mascots, or real people.',
      'If identity assets cannot be verified from provided media, mark as concept and avoid fake official marks.',
      'Prefer product-specific narrative spine from product_type; end with clear CTA when provided.',
      'Subtitles only if user explicitly asks.',
      'Prefer native H3 audio direction; avoid duplicate VO+native tracks unless requested.',
    ],
    assembleHints: 'Deliver Full-Reference 6-section brand promo prompt grounded only in provided assets and verified claims.',
  },

  {
    id: 'mv_subtitle',
    peId: 'pe_expand_minimax_mv',
    builtinKey: 'minimax_mv',
    name: '音乐MV动态字幕',
    description: '音乐/歌词驱动的 MV 分镜与空间贴字方案。',
    sort: 60,
    outputMode: 'plain_video_prompt',
    mediaExpandLayout: true,
    skillSource: 'mv-subtitle-skill-confirmed',
    formFields: [
      { key: 'aspect_format', label: '视频格式', type: 'select', options: [
        { value: '9:16_1080x1920', label: '竖屏' },
        { value: '16:9_1920x1080', label: '横屏' },
        { value: '1:1_1080x1080', label: '方图' },
        { value: '21:9_2560x1080', label: '宽银幕' },
      ], default: '9:16_1080x1920' },
      { key: 'target_duration', label: '目标时长', type: 'select', options: [
        { value: '10s', label: '10 秒' },
        { value: '15s', label: '15 秒' },
        { value: '30s_plus', label: '30 秒+' },
      ], default: '15s' },
      { key: 'lyrics_mode', label: '歌词来源', type: 'select', options: [
        { value: 'user_provided', label: '用户提供' },
        { value: 'generate_original', label: '模型生成' },
      ], default: 'user_provided' },
      { key: 'lyrics_text', label: '歌词正文', type: 'textarea', default: '', showIf: { key: 'lyrics_mode', equals: 'user_provided' } },
      { key: 'visual_preset', label: '视觉预设', type: 'select', options: [
        { value: 'Trap', label: 'Trap' },
        { value: 'Dark-pop', label: 'Dark-pop' },
        { value: 'Cyber-grunge', label: 'Cyber-grunge' },
        { value: 'Gospel hip-hop', label: 'Gospel hip-hop' },
        { value: 'custom', label: '自定义' },
      ], default: 'Dark-pop' },
      { key: 'mood_temperature', label: '情绪温度', type: 'text', default: '' },
      { key: 'exclusions', label: '明确排除项', type: 'textarea', default: '' },
    ],
    hardConstraints: [
      'On-screen text is a spatial design layer, NOT a bottom subtitle bar.',
      'When vocals exist, match locked lyrics word-by-word; never rewrite/translate user-provided lyrics.',
      'Text must not cover eyes/main expressions; avoid covering mouths during lip-sync; one main text event per shot.',
      'If character/scene/type refs exist, isolate roles — do not cross-contaminate.',
      'For >15s: multi-shot + drum-hit hard cuts; forbid fade/dissolve; avoid cutting mid-lyric unless extreme lip-sync CU.',
      'Uploaded real song defaults as master music bed.',
      'Do not copy copyrighted IP visuals.',
      'Shot script should include Global Aesthetic & Character Lock + per-shot Vocal/Typography/Visual/Camera/Transition.',
    ],
    assembleHints: 'Output Complete MV Prompt package: global global lock + shot list + typography plan.',
  },

  {
    id: 'papercraft',
    peId: 'pe_expand_minimax_papercraft',
    builtinKey: 'minimax_papercraft',
    name: '纸艺定格科普',
    description: '知识主题 → 纸偶/分层布景/分镜向纸艺定格科普提示词包。',
    sort: 70,
    outputMode: 'plain_video_prompt',
    mediaExpandLayout: true,
    skillSource: 'papercraft-stop-motion-explainer',
    formFields: [
      { key: 'audience', label: '目标观众', type: 'select', options: ['儿童', '泛知识用户', '课堂学生', '社媒用户', '品牌教育', '专业观众'].map((x) => ({ value: x, label: x })), default: '泛知识用户' },
      { key: 'duration', label: '目标时长', type: 'select', options: [
        { value: '5', label: '5 秒' },
        { value: '10', label: '10 秒' },
        { value: '15', label: '15 秒（推荐）' },
      ], default: '15' },
      { key: 'aspect_ratio', label: '画幅', type: 'select', options: ASPECT_COMMON, default: '16:9' },
      { key: 'deliverable_type', label: '交付类型', type: 'select', options: [
        { value: 'full_package', label: '完整制作包摘要+主提示词' },
        { value: '5s_i2v_prompt', label: '5 秒图生视频提示词' },
        { value: 'storyboard', label: '分镜提示词' },
        { value: 'single_image_prompt', label: '单图提示词' },
      ], default: '5s_i2v_prompt' },
      { key: 'creative_direction', label: '创意方向', type: 'select', options: [
        { value: '立体书旅程', label: '立体书旅程' },
        { value: '纸艺科学家实验室', label: '纸艺科学家实验室' },
        { value: '分层剖面模型', label: '分层剖面模型' },
        { value: '微缩自然剧场', label: '微缩自然剧场' },
        { value: '纸片机关板', label: '纸片机关板' },
      ], default: '分层剖面模型' },
      { key: 'learning_goal', label: '核心学习目标', type: 'text', default: '' },
      { key: 'need_host', label: '纸偶主持人', type: 'select', options: [
        { value: 'yes', label: '需要' },
        { value: 'no', label: '不需要' },
      ], default: 'no' },
    ],
    hardConstraints: [
      'Emphasize real paper layers: foreground/midground/background/distant with inter-layer shadows.',
      'Everything looks like real paper materials: thickness, fibers, creases, cut edges, brads/pull-tabs/slides.',
      'Motion = stop-motion steps/pauses/rebounds/hinges/page-turns. Forbid silky CG, plastic 3D, flat vector, large character locomotion.',
      'Transitions obey paper physics: page-turn / pop-up / pull-tab / paper door. Avoid neon glitch/digital shatter unless requested.',
      'Educational labels also made of paper pieces; one knowledge beat per shot.',
      'Preserve user domain terms; do not change the topic.',
      'Include reverse-prompt style protections against photoreal humans / plastic CG / paperless cartoon.',
      'Knowledge path: hook → explain → example/cultural link → memorable line.',
    ],
    assembleHints: 'Output the selected deliverable_type as a production-ready papercraft prompt package.',
  },

  {
    id: 'anim_3d',
    peId: 'pe_expand_minimax_anim3d',
    builtinKey: 'minimax_anim3d',
    name: '3D动画短片',
    description: '一句话故事 → 皮克斯感 3D 短片的项目简报级提示词。',
    sort: 80,
    outputMode: 'plain_video_prompt',
    mediaExpandLayout: true,
    skillSource: '3d-animation-short-generator',
    formFields: [
      { key: 'aspect_ratio', label: '画幅', type: 'select', options: [
        { value: '16:9', label: '16:9 横屏' },
        { value: '9:16', label: '9:16 竖屏' },
        { value: '1:1', label: '1:1' },
        { value: '4:5', label: '4:5' },
      ], default: '16:9' },
      { key: 'total_duration', label: '总时长', type: 'select', options: [
        { value: '5', label: '5 秒' },
        { value: '10', label: '10 秒' },
        { value: '15', label: '15 秒（推荐）' },
      ], default: '15' },
      { key: 'dialogue_mode', label: '台词需求', type: 'select', options: [
        { value: 'none', label: '无台词' },
        { value: 'dialogue', label: '有对白' },
        { value: 'narration', label: '旁白' },
      ], default: 'none' },
      { key: 'dialogue_language', label: '台词语言', type: 'text', default: '', showIf: { key: 'dialogue_mode', notEquals: 'none' } },
      { key: 'q_version', label: 'Q 版比例', type: 'select', options: [
        { value: 'auto', label: '自动' },
        { value: 'yes', label: 'Q 版 2.5–3 头身' },
        { value: 'no', label: '偏写实卡通比例' },
      ], default: 'auto' },
      { key: 'emotional_premise', label: '情绪前提', type: 'textarea', default: '' },
    ],
    hardConstraints: [
      'Global style lock: Pixar-like stylized 3D / C4D+Octane feel; warm cinematic lighting.',
      'Forbid photoreal live-action, flat anime 2D, plastic toy skin, stiff anatomy.',
      'Prefer SSS-like skin/materials, expressive Disney-style acting, clear silhouette.',
      'Single shot ≤15s conceptually; important characters per shot ≤3.',
      'When reference images are attached: 主体定义 MUST define each <Picture N> and map <Subject N> to it; reuse tags in 保留分析/详细描述. Never omit angle-bracket tags.',
      'If producing shot list: include per-second action/camera/audio/continuity cues.',
      'Scene cards must not include characters/silhouettes/hands/faces when separating env boards.',
      'Strip storyboard tags from final renderable prompts.',
      'Default model language: MiniMax-H3.',
    ],
    assembleHints: 'Output a LIGHT H3-feedable package: brief + beat spine + shot prompts.',
  },
];

export function getScenarioById(id: string): MiniMaxScenario | null {
  return MINIMAX_SCENARIOS.find((s) => s.id === String(id || '').trim()) || null;
}

export function getScenarioByPeId(peId: string): MiniMaxScenario | null {
  const id = String(peId || '').trim();
  return MINIMAX_SCENARIOS.find((s) => s.peId === id || s.builtinKey === id) || null;
}

export function listScenarios(): MiniMaxScenario[] {
  return MINIMAX_SCENARIOS.slice().sort((a, b) => a.sort - b.sort);
}