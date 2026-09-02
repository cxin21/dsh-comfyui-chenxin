// ComfyUI 反推提示词工程 — 1:1 移植自 PromptMaster config/comfyuiPromptEngineering.js
// 唯一核心目标：最大限度忠实还原原图/原视频，使 ComfyUI 正向提示词可复现所见画面。

import { cleanTagLineBody } from './tagLineSanitize.js';

export const TAG_LINE_TYPES: Set<string> = new Set([
  'Stable_Diffusion_Prompt',
  'MidJourney',
  'Danbooru_tag_list',
  'e621_tag_list',
  'Rule34_tag_list',
  'Booru_tag_list',
]);

export const PROSE_TYPES: Set<string> = new Set([
  'Descriptive',
  'Descriptive_Casual',
  'Straightforward',
  'Art_Critic',
  'Product_Listing',
  'Social_Media_Post',
]);

function isZh(caption: any): boolean {
  return (caption.caption_lang || 'en') === 'zh';
}

function mediaTarget(caption: any): string {
  return caption.media_target || 'image';
}

function captionType(caption: any): string {
  return caption.type || 'Stable_Diffusion_Prompt';
}

function isVideoBatch(caption: any, media_target?: string): boolean {
  return (media_target || mediaTarget(caption)) === 'video';
}

function isMixedBatch(caption: any, media_target?: string): boolean {
  return (media_target || mediaTarget(caption)) === 'mixed';
}

const COMFYUI_NEGATIVE_HINT_ZH =
  '【ComfyUI】仅正向提示词；禁止 negative、禁止「不要/避免/no/without」。';

const COMFYUI_NEGATIVE_HINT_EN =
  '[ComfyUI] Positive prompt ONLY—no negative, no "no/without/avoid".';

/** 还原度检查表：按类目罗列可见要素（模型须逐项观察，有则写入） */
const FIDELITY_CHECKLIST_ZH: Record<string, string[]> = {
  composition: [
    '景别（大特写/特写/胸像/半身/七分/全身/远景/大远景）',
    '机位高度（俯拍/平视/仰拍）与镜头俯仰角',
    '画面倾斜/荷兰角、对称或不对称构图',
    '主体在画框中的位置（居中/偏左偏右/三分法/贴边/被裁切部位）',
    '前景/中景/背景层次与遮挡关系',
    '留白、画幅内次要元素占比',
    '景深（浅景深/全景清晰）、焦平面落在何处',
    '视线引导线、框架式构图（门框/窗框等）',
  ],
  scene: [
    '室内/室外/虚拟场景、具体场所类型（街道/房间/舞台/自然地貌等）',
    '地面/墙面/天空/水面/植被/建筑结构',
    '道具与陈设及其位置、数量、材质',
    '空间纵深（走廊/开阔/拥挤）、天气与时间感（若可辨）',
    '画面边缘可见的杂物、文字标牌、屏幕/UI（照录可见文字）',
  ],
  color_light: [
    '整体色温（偏冷/偏暖/中性）、主色与点缀色',
    '饱和度高低、对比度、褪色/高饱和/胶片感等可见倾向',
    '主光源方向（顶光/侧光/逆光/底光/多点光）',
    '阴影软硬、长度、落点；高光与反光位置',
    '环境光、轮廓光/发丝光、局部曝光（过曝/欠曝区域）',
    '材质上的高光（金属/玻璃/皮肤/织物）',
  ],
  subject_identity: [
    '主体数量、主次关系、相对大小',
    '物种/角色类型（人/动物/机甲/物体拟人等）',
    '大致年龄段、性别呈现（仅当视觉可辨）',
    '肤色、发型（长短/卷直/颜色/刘海/发饰）',
    '面部结构、胡须/妆容、痣/疤痕/眼镜/面具等可见特征',
    '服装层次、款式、图案、配色、材质（棉/皮/丝/金属等）',
    '配饰（帽/首饰/包/武器/工具/耳机等）',
    '体表覆盖物（毛皮/鳞片/装甲/透明件等）',
  ],
  head_face: [
    '头部朝向（正面/侧面/四分之三侧/背面/低头/仰头）',
    '面部朝向与视线方向（看镜头/看左/看右/看上/看下/闭眼）',
    '眉毛形态、眼睛睁闭、嘴型（闭/微张/笑/嘟嘴/露齿）',
    '表情情绪（仅写可见，勿心理推断）',
    '头发与脸的遮挡关系（遮眼/遮脸/风吹发）',
  ],
  body_limbs: [
    '躯干朝向、含胸/挺胸/扭转/弯腰/驼背',
    '肩膀高低、双臂自然下垂/抬起/交叉/抱胸/叉腰',
    '肘部弯曲方向、前臂旋转',
    '双手位置（胸前/身侧/背后/插兜/合十/握拳/张开/比心/指向）',
    '手指分开/并拢、是否握持物体（写清物体与握法）',
    '腿部姿态（站立/坐/跪/蹲/单腿抬起/交叉腿/劈叉/行走中）',
    '膝盖弯曲、脚尖朝向、脚是否着地/悬空',
    '重心脚、步态瞬间（起步/落地/踮脚）',
    '与物体/他人/地面的接触点（手扶栏杆/背靠墙/坐在椅上等）',
  ],
  objects_interaction: [
    '手持/背负/佩戴的物品及其颜色形状',
    '多主体之间的位置、朝向、视线、肢体接触',
    '动物/人物与道具的互动状态',
  ],
  style_medium: [
    '可见媒介（摄影/插画/3D渲染/动漫赛璐璐/水彩/像素等）',
    '线条与笔触、细节密度、边缘锐利/柔和',
    '画面颗粒/噪点/锐化程度、可见分辨率倾向',
  ],
  video_extra: [
    '动作过程（走/跑/跳/转身/挥手/拥抱/坠落等）与速度感',
    '循环/单次动作、前后帧变化趋势',
    '运镜（固定/推/拉/摇/移/跟拍/升降/环绕/手持晃动）',
    '画面内运动模糊、动态模糊方向',
    '口型/说话/眨眼等瞬时动作（若可见）',
  ],
};

const FIDELITY_CHECKLIST_EN: Record<string, string[]> = {
  composition: [
    'shot scale (ECU/CU/bust/half/full/wide), camera height, pitch/roll',
    'subject placement, cropping of body parts, rule-of-thirds',
    'foreground/mid/background layers, occlusion, negative space',
    'depth of field, focus plane, leading lines, frame-in-frame',
  ],
  scene: [
    'indoor/outdoor, location type, ground/wall/sky/water/vegetation/architecture',
    'props, furniture, clutter, spatial depth, weather/time cues if visible',
    'visible text/signs/screens—transcribe verbatim',
  ],
  color_light: [
    'palette, warm/cool, saturation, contrast, color grading look',
    'key/fill/rim light direction, hard/soft shadows, highlights, reflections',
    'material-specific speculars (metal/glass/skin/fabric)',
  ],
  subject_identity: [
    'subject count, hierarchy, size, species/character type',
    'apparent age/gender only if visible, skin tone, hair style/color/length/bangs',
    'face marks, makeup, facial hair, glasses/mask, clothing layers/materials/patterns',
    'accessories, armor/fur/scales/transparency',
  ],
  head_face: [
    'head yaw/pitch (front/profile/3-4/back/down/up)',
    'gaze target, eye open/closed, brow, mouth shape, visible emotion',
    'hair covering face/eyes, wind-blown hair',
  ],
  body_limbs: [
    'torso orientation, shoulder line, arm pose (raised/crossed/akimbo/behind back)',
    'elbow bend, wrist rotation, hand pose (open/fist/prayer/point/holding object—describe grip)',
    'leg pose (stand/sit/kneel/crossed/lifted/walking), knee/foot direction, weight on which foot',
    'contact points with furniture/people/ground',
  ],
  objects_interaction: [
    'held/worn/carried items, multi-subject layout, gaze/contact between subjects',
  ],
  style_medium: [
    'visible medium (photo/illustration/3D/anime/pixel), line/edge quality, detail level, grain/sharpness',
  ],
  video_extra: [
    'action verb, speed, motion blur, camera move (static/dolly/pan/tilt/zoom/handheld)',
    'lip/movement cues if visible',
  ],
};

function formatChecklist(checklist: Record<string, string[]>, video: boolean): string {
  const keys: [string, string][] = [
    ['composition', '构图镜头'],
    ['scene', '场景环境'],
    ['color_light', '色调光影'],
    ['subject_identity', '主体身份外观'],
    ['head_face', '头部面部'],
    ['body_limbs', '躯干四肢'],
    ['objects_interaction', '物体与互动'],
    ['style_medium', '风格媒介'],
  ];
  if (video) keys.push(['video_extra', '视频动态']);
  return keys
    .map(([k, title]) => `${title}：${checklist[k].join('、')}`)
    .join('；');
}

function formatChecklistEn(checklist: Record<string, string[]>, video: boolean): string {
  const keys = [
    'composition',
    'scene',
    'color_light',
    'subject_identity',
    'head_face',
    'body_limbs',
    'objects_interaction',
    'style_medium',
  ];
  if (video) keys.push('video_extra');
  return keys.map((k) => `${k}: ${checklist[k].join('; ')}`).join(' | ');
}

const FIDELITY_FORBIDDEN_ZH =
  '【严禁】臆造画面没有的元素；用「美女/帅哥/精致」等套话代替可见特征；只写类别不写个体（如只说「一个人」不写朝向与手脚姿态）；推断身份/情绪/故事；把负向要求写进正向。';

const FIDELITY_FORBIDDEN_EN =
  '[FORBIDDEN] Inventing elements; generic praise; category-only labels without pose/gaze/limbs; inferred backstory; negatives in positive.';

/**
 * 反推核心：完整还原检查表（system）
 */
export function buildFaithfulReproductionBlock(caption: any, media_target: string): string {
  const zh = isZh(caption);
  const video = isVideoBatch(caption, media_target);

  if (zh) {
    return (
      ' 【反推最高目标】最大限度忠实还原当前画面，使用户在 ComfyUI 生成时接近原图/原视频。写作前请逐项扫视画面，有则必写、无则省略；只写可见事实。' +
      ' 【还原检查表·有则必写】' +
      formatChecklist(FIDELITY_CHECKLIST_ZH, video) +
      '。' +
      FIDELITY_FORBIDDEN_ZH +
      ' 检查表仅供内心观察，禁止把检查表、自检或分析标题写入最终输出。'
    );
  }

  return (
    ' [TOP GOAL] Maximize faithful reproduction of THIS frame for ComfyUI—scan visually before writing; include every visible fact, omit nothing important, invent nothing.' +
    ' [FIDELITY CHECKLIST—if visible, include]' +
    formatChecklistEn(FIDELITY_CHECKLIST_EN, video) +
    '.' +
    FIDELITY_FORBIDDEN_EN +
    ' Checklist is for internal observation only—never output checklist/self-check/analysis headings.'
  );
}

/**
 * 人物/主体：写任务前强制扫视清单（user 首句）
 */
export function buildSubjectScanReminder(caption: any): string {
  const zh = isZh(caption);
  if (zh) {
    return (
      ' 若画面含人物或拟人主体：必须写清头部朝向、面部朝向、视线方向、表情、头发与脸的关系；' +
      '双臂与双手的具体姿态（是否持物及握法）、双腿与双脚的站姿或坐姿、躯干朝向与重心；' +
      '服装与配饰的可见款式颜色材质。'
    );
  }
  return (
    ' If humans/anthropomorphic subjects: state head/face orientation, gaze, expression, hair-vs-face;' +
    ' exact arm/hand pose and held objects/grip; leg/foot stance and weight;' +
    ' visible clothing/accessories/materials.'
  );
}

export function buildExpertSystemPrefix(caption: any, media_target: string): string {
  const zh = isZh(caption);
  const mt = media_target || mediaTarget(caption);
  const faithful = zh
    ? '你的职责是「视觉取证式」反推：像给生成模型一份所见要素清单，而非写作文或讲故事。'
    : 'Your job is forensic visual extraction—a checklist of what is seen for regeneration, not creative writing.';

  if (mt === 'video') {
    return zh
      ? `你是 ComfyUI 正向提示词还原专家，${faithful} 针对视频：静态画面特征与动态/运镜同等重要。只输出 positive。禁止思维链与分镜表。可见中文照录。`
      : `You are a ComfyUI faithful-reproduction prompt expert, ${faithful} For video: static look plus motion/camera equally matter. Positive only. No chain-of-thought. Quote visible Chinese.`;
  }

  if (isMixedBatch(caption, media_target)) {
    return zh
      ? `你是 ComfyUI 正向提示词还原专家，${faithful} 批次含图/视频：逐条按检查表还原，图片写静态细节，视频另写动作与运镜。只写 positive。`
      : `You are a ComfyUI faithful-reproduction expert, ${faithful} Mixed batch: per-asset checklist; stills=static detail, video=motion/camera. Positive only.`;
  }

  return zh
    ? `你是 ComfyUI 正向提示词还原专家，${faithful} 针对文生图/图生图，目标是最接近地复现当前图片。只写 positive。请用简体中文（画面文字照录）。`
    : `You are a ComfyUI faithful-reproduction expert for T2I/I2I, ${faithful} Goal: closest match to this image. Positive only. English; quote visible Chinese.`;
}

/** SD 标签：ANIMA3 槽位工作流（替代旧 ComfyUI 逗号标签顺序说明） */
export function buildAnima3WorkflowBlock(caption: any, media_target: string): string {
  const zh = isZh(caption);
  const parts = [zh ? COMFYUI_NEGATIVE_HINT_ZH : COMFYUI_NEGATIVE_HINT_EN];

  if (isVideoBatch(caption, media_target)) {
    parts.push(
      zh
        ? '【视频·ANIMA3】在忠实观察基础上按槽位写 tag，并含动作/运镜；一行英文 lowercase。'
        : '[Video·ANIMA3] Fidelity observation then slot-filled tags incl. motion/camera; one lowercase English line.'
    );
  } else if (isMixedBatch(caption, media_target)) {
    parts.push(zh ? '【混合】每条独立按检查表观察后 ANIMA3 组装。' : '[Mixed] Per file: checklist observe, ANIMA3 assemble.');
  } else {
    parts.push(
      zh
        ? '【SD·ANIMA3】一行英文 tag，严格槽位顺序与输出协议；观察用还原检查表，输出用 ANIMA3 组装。'
        : '[SD·ANIMA3] One lowercase English line; checklist for seeing, ANIMA3 slots for writing.'
    );
  }

  return ' ' + parts.join(' ');
}

export function buildSystemWorkflowBlock(caption: any, media_target: string): string {
  const zh = isZh(caption);
  const ct = captionType(caption);
  const parts = [zh ? COMFYUI_NEGATIVE_HINT_ZH : COMFYUI_NEGATIVE_HINT_EN];

  const tagOrderZh =
    '建议标签顺序：景别机位→主体数量与类型→头部面部（朝向/视线/表情）→躯干朝向→手臂双手→腿足姿态→服装配饰材质→场景道具→色调→光影→风格媒介→画质；';
  const tagOrderEn =
    'Tag order: framing→subject count/type→head/face/gaze/expression→torso→arms/hands→legs/feet→clothing/accessories/materials→scene/props→palette→lighting→style/quality;';

  if (isVideoBatch(caption, media_target)) {
    parts.push(
      zh
        ? '【视频】在检查表基础上必须写清动作过程、速度感、运镜方式；勿把动态信息省略成静态快照。'
        : '[Video] On top of the checklist: motion process, speed, camera move—do not collapse to a still.'
    );
  } else if (isMixedBatch(caption, media_target)) {
    parts.push(zh ? '【混合】每条独立按检查表还原。' : '[Mixed] Each file gets full checklist.');
  } else if (TAG_LINE_TYPES.has(ct)) {
    parts.push(zh ? `【标签式·还原】一行逗号分隔，${tagOrderZh}每个标签对应可见事实。` : `[Tags] One comma line, ${tagOrderEn} visible facts only.`);
  } else if (PROSE_TYPES.has(ct)) {
    parts.push(
      zh
        ? '【描述式·还原】按检查表类目用连贯句写出，优先覆盖：构图→场景→光影→主体→头面→四肢→服装→风格；勿漏手脚朝向。'
        : '[Prose] Cover checklist categories in sentences: framing→scene→light→subject→head/face→limbs→clothing→style; include hand/leg pose.'
    );
  } else if (ct === 'MidJourney') {
    parts.push(zh ? '【MJ式】关键词覆盖检查表各项，含朝向与肢体。' : '[MJ] Keywords across checklist incl. orientation/limbs.');
  } else {
    parts.push(zh ? '【还原】按检查表写全可见要素。' : '[Faithful] Full checklist coverage.');
  }

  return ' ' + parts.join(' ');
}

export function buildUserTaskFaithfulLead(caption: any): string {
  const zh = isZh(caption);
  const video = isVideoBatch(caption) || mediaTarget(caption) === 'video';
  if (zh) {
    return (
      (video
        ? '请逐帧观察当前视频画面，按「还原检查表」生成 ComfyUI 正向提示词，尽可能完整复现所见——'
        : '请逐像素观察当前图片，按「还原检查表」生成 ComfyUI 正向提示词，尽可能完整复现所见——') +
      '构图镜头、场景环境、色调光影、主体外观、头部朝向与视线、面部表情、头发、服装配饰、手臂与双手动作、腿与脚姿态、物体互动与可见风格。' +
      buildSubjectScanReminder(caption)
    );
  }
  return (
    (video
      ? 'Observe this video frame-by-frame; use the fidelity checklist for a ComfyUI POSITIVE prompt—'
      : 'Observe this image pixel-by-pixel; use the fidelity checklist for a ComfyUI POSITIVE prompt—') +
    'framing, scene, color/light, subject, head orientation, gaze, expression, hair, clothing, arms/hands, legs/feet, interactions, style.' +
    buildSubjectScanReminder(caption)
  );
}

export function buildTypeOutputAddon(caption: any): string {
  const zh = isZh(caption);
  const ct = captionType(caption);
  const qa = zh
    ? ' 【还原质检】关键可见信息（头/视线/手脚）须写入标签，勿另写质检说明段。'
    : ' [QA] Include visible head/gaze/limbs in tags—no separate QA prose.';
  if (!TAG_LINE_TYPES.has(ct)) {
    return qa;
  }
  const sdFmt = zh
    ? ' 【SD标签格式】逗号分隔的短词组（词内可用空格，如 brown hair, looking at viewer, from side）；禁止把描述压成 woman_xxx、man_yyy 或 2_subjects 式自创长 tag；禁止 cu 等未展开缩写；多人优先 1girl, 1boy 等标准 tag，再写姿态与服装短语。'
    : ' [SD TAG FORMAT] Comma-separated short phrases (spaces OK: brown hair, looking at viewer, profile)—NOT underscore role dumps (woman_profile_left_facing_right), NOT invented tokens like 2_subjects or abbreviations like cu (use close-up); for couples use 1girl, 1boy plus standard pose tags.';
  return sdFmt + qa;
}

export function buildUserTailAddon(caption: any): string {
  const zh = isZh(caption);
  const tail = zh
    ? ' 内心核对可见要素后，直接输出一行标签正文；禁止输出自检、分析、Markdown 标题或「fidelity analysis」类说明。'
    : ' Verify mentally, then output tag line only—no self-check headings, analysis, or markdown.';

  return tail;
}

export const COMFYUI_EXTRA_TEMPLATES: Record<string, { zh: string; en: string }> = {
  comfyui_image_quality: {
    zh: '在末尾追加画质词：精细，清晰，细节丰富。不得删改或稀释已有构图、朝向、手脚姿态与主体描述。',
    en: 'Append sharp, detailed, high quality at end—do not dilute composition, orientation, or limb poses.',
  },
  comfyui_video_motion: {
    zh: '必须写清动作过程与运镜；在完整还原静态样貌（含头手腿朝向）的前提下描述动态。',
    en: 'State motion and camera; keep full static fidelity including head/hand/leg orientation.',
  },
  comfyui_lora_character: {
    zh: '仅描述场景、背景、构图、光影、姿态（含头/手/腿朝向与动作）、表情；不描述人物外貌、服装、发型、年龄、性别（人物 LoRA 训练用）。',
    en: 'Scene, background, composition, lighting, pose incl. head/hand/leg—NO face/clothing/hair/age/gender (character LoRA).',
  },
  comfyui_lora_style: {
    zh: '描述主体、环境、姿态（含四肢与朝向）、互动；删除画风、媒介、渲染方式与质量词（风格 LoRA 训练用）。',
    en: 'Subject, environment, pose/orientation, interaction—strip style/medium/quality (style LoRA).',
  },
  comfyui_fidelity_max: {
    zh: '最高优先级：还原度。逐项扫视检查表，人物必须写头朝向、视线、表情、双手动作、双腿与脚姿态、持物方式；禁止概括性省略。',
    en: 'Priority: maximum fidelity. Full checklist; for people include head/gaze, both hands, legs/feet, grip—no summarization that drops pose.',
  },
};

// sanitizeOutput — SD/ComfyUI 正向标签行后处理。
// PM 的 SD 输出清洗实际在 captionPromptEngineering.sanitizeFinalCaption 内完成：
// 非 ANIMA 直接保留原文 raw，随后由 tagLineSanitize.cleanTagLineBody 去方括号/hex 垃圾/去重。
// 此处提供单一入口：清洗一行逗号分隔的 SD 正向标签（保留短语内空格，不压下划线长串）。
export function sanitizeOutput(text: string, caption?: any): string {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  const cleaned = cleanTagLineBody(raw, caption);
  return cleaned || raw;
}