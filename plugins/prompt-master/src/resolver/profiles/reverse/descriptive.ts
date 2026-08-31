// 「自然语言」(Descriptive) 反推 — 1:1 移植自 PM descriptivePromptEngineering.js
// 五点结构 + 极致还原检查表 + 单段自然文本

import * as ComfyuiPE from './comfyui.js';
import { resolveExpandMaxTokens } from '../expand-rules.js';

const DESCRIPTIVE_TYPE = 'Descriptive';

const FIDELITY_PREAMBLE_ZH =
  '【极致还原总则】你的职责是「视觉取证式」反推：像为后续文生图/图生图提供可复现的所见要素清单，而非写作文、讲故事或审美评论。写作前须逐项扫视画面；有则必写、无则省略；只写可见事实，禁止臆造。若画面含人物或拟人主体，头/面/视线、双臂双手（含持物与握法）、双腿双脚与重心、服装配饰材质均为硬性必写项，禁止用「美女/帅哥/精致/一个人」等套话代替。';

const FIDELITY_PREAMBLE_EN =
  '[MAX FIDELITY] Forensic visual extraction for faithful regeneration—not creative writing or story. Scan the frame before writing; include every visible fact, invent nothing. For people/anthropomorphic subjects: head/face orientation, gaze, expression, both arms/hands (grip if holding), legs/feet/weight, clothing materials are mandatory—no generic praise or category-only labels.';

function applies(caption: any): boolean {
  return (caption.type || '') === DESCRIPTIVE_TYPE;
}

export function resolveWordCountHint(caption: any): string {
  const len = caption.len || 'medium';
  const maxTokens = resolveExpandMaxTokens(len, caption.caption_len_chars);
  // 近似 1 token ≈ 1 word/1.5 字符
  return String(Math.round(maxTokens * 0.75));
}

function isZhCaption(caption: any): boolean {
  return (caption.caption_lang || 'en') === 'zh';
}

function buildFivePointFrameworkBody(caption: any, video: boolean): string {
  const zh = isZhCaption(caption);
  const media = video ? (zh ? '视频画面（含关键帧可见信息）' : 'video (key visible frames)') : zh ? '图像' : 'image';

  if (zh) {
    return (
      `【五点结构框架·极致还原】请对传入的${media}按下列五点在内心完整扫视并分析后，再写入最终正文（正文里不要出现「一、二、」等标题，须融为一段连贯叙述；检查表各项自然融入对应要点，勿复制检查表标题）：` +
      '（1）物理空间与构图逻辑：景别（大特写/特写/胸像/半身/全身/远景等）与机位（俯拍/平视/仰拍/荷兰倾斜）；主体在画框中的位置、被裁切或遮挡的部位、前景/中景/背景层次；透视与镜头三维方位（自拍须写前臂入镜、肩线倾斜、畸变方向、左手/右手持机造成的画面延展）；构图坐标、留白、引导线、框架式构图（门/窗）；景深与焦平面落在何处。' +
      '（2）主体刻画与材质反推：主体数量与主次；物种/角色类型；年龄感与气质（仅写可见）；发型（长短/卷直/颜色/刘海/发饰）与头发遮挡脸/眼的关系；头部朝向、面部朝向、视线方向（看镜头/左/右/上/下/闭眼）、嘴型与可见表情；躯干朝向、肩线、双臂姿态、肘腕弯曲、双手位置与手指状态、持物及握法；双腿站姿或坐姿、膝/脚尖朝向、重心脚；服装剪裁、叠穿、图案、配色与材质（棉/丝/皮/金属反光等）及配饰；身材比例与动作幅度；运动体须写方向、速度感与动态模糊。' +
      '（3）环境建模与光照参数：室内/室外/场所类型；地面/墙面/天空/植被/建筑与道具陈设的位置、数量、材质及是否被裁切；推测焦距倾向与虚化；主辅光方向、硬柔、色温、阴影边缘与高光/反光落点；过曝/欠曝区域；须写物体完整或半遮状态。' +
      '（4）OCR级别文本读取：逐字识别画面文字，说明字体、色彩、字号对比、载体（霓虹/屏幕/印刷）与排版位置；若确无文字或严重模糊不可辨，仅一笔带过，绝对禁止虚构文字。' +
      '（5）美学风格与统筹：可见媒介（摄影/插画/3D/动漫/水彩/像素等）、线条笔触、细节密度、颗粒/锐化倾向；艺术流派与氛围情绪；主色/辅色/强调色及明度对比层面的视觉表现。' +
      (video
        ? ' 视频另须在同一叙述中写清：动作过程与速度感、运镜方式（固定/推/拉/摇/移/跟/手持晃等）、画面内运动模糊方向；静态样貌（含头手腿朝向）与动态同等重要。'
        : '')
    );
  }

  return (
    `[FIVE-PART FRAMEWORK · MAX FIDELITY] Analyze this ${media} on all five axes mentally, then output ONE flowing paragraph (no section headings; weave checklist items naturally):` +
    ' (1) Space & composition: shot scale, camera height/angle/Dutch tilt, subject placement and cropped/occluded body parts, foreground/mid/background, perspective and lens position (selfie: forearm in frame, shoulder tilt, distortion direction); negative space, leading lines, frame-in-frame; depth of field and focus plane.' +
    ' (2) Subject & materials: count and hierarchy; species/type; hair style/color/bangs and hair-vs-face; head yaw, face orientation, gaze, mouth/expression; torso, shoulders, both arms/hands/fingers, grip on held objects; leg/foot stance and weight; clothing layers, patterns, materials, accessories; motion direction and blur if moving.' +
    ' (3) Environment & light: location type, surfaces, props and whether cut off; focal length/DOF cues; key/fill/rim, warm/cool, hard/soft shadows, highlights, reflections, exposure patches.' +
    ' (4) Visible text only—font, color, size, medium, layout; skip if none—never invent OCR.' +
    ' (5) Medium/style, line/detail/grain, mood, palette and contrast.' +
    (video
      ? ' For video also state action, speed, camera move, motion-blur direction; static pose fidelity equals motion.'
      : '')
  );
}

function buildExpertRole(caption: any, video: boolean): string {
  const zh = isZhCaption(caption);
  const media = video ? (zh ? '视频画面' : 'video') : zh ? '图像' : 'image';
  if (zh) {
    return `你是顶级的视觉取证与画面还原专家，须对当前${media}进行精确、详尽、可复现的描述。`;
  }
  return `You are an expert forensic visual analyst for maximum faithful reproduction of this ${media}.`;
}

export function buildSystemPrompt(caption: any, media_target: string): string {
  const mt = media_target || caption.media_target || 'image';
  const video = mt === 'video';
  const wc = resolveWordCountHint(caption);
  const zh = isZhCaption(caption);

  if (zh) {
    return (
      ` ${buildExpertRole(caption, video)}` +
      ` ${FIDELITY_PREAMBLE_ZH}` +
      ` 总字数控制在约 ${wc} 字，信息高度密集、语义连贯，宁可写细勿概括省略可见要素。` +
      buildFivePointFrameworkBody(caption, video) +
      ComfyuiPE.buildFaithfulReproductionBlock(caption, media_target) +
      ' 【最终输出格式】将五点分析与检查表要素融合为一整段顺滑流淌的自然文本；绝对严禁输出任何 Markdown 标记（禁止 ** 加粗、- 列表、# 标题、序号标题如「1.」「###」）；禁止分点、禁止提纲、禁止「这张图片」「用户需要」「本任务」等元话语。'
    );
  }

  return (
    ` ${buildExpertRole(caption, video)}` +
    ` ${FIDELITY_PREAMBLE_EN}` +
    ` One cohesive English paragraph (~${wc} words), dense and reproducible—prefer exhaustive visible detail over vague summary.` +
    buildFivePointFrameworkBody(caption, video) +
    ComfyuiPE.buildFaithfulReproductionBlock(caption, media_target) +
    ' [OUTPUT] Single flowing paragraph only—no Markdown, bullets, headings, or meta commentary.'
  );
}

export function buildOutputConstraints(caption: any): string {
  const wc = resolveWordCountHint(caption);
  const zh = isZhCaption(caption);
  if (zh) {
    return (
      ` 【输出契约·极致还原】仅输出最终正文一段（约 ${wc} 字），须覆盖五点框架与检查表中所有可见项；人物场景必须含头/视线/双手/双腿姿态；可多句但须连成一体。` +
      ' 禁止 Markdown、分节标题、思维链、格式说明与虚构文字；若使用包裹行格式，包裹行之外不得有任何字符。'
    );
  }
  return (
    ` [OUTPUT CONTRACT] One paragraph (~${wc} words) covering all five parts and visible checklist items; people require head/gaze/hands/legs.` +
    ' No Markdown, headings, chain-of-thought, or invented text.'
  );
}

export function buildUserTaskLead(caption: any, media_target: string): string {
  const mt = media_target || caption.media_target || 'image';
  const video = mt === 'video';
  const wc = resolveWordCountHint(caption);
  const zh = isZhCaption(caption);

  if (zh) {
    const lead = video
      ? `请按系统提示中的【五点结构框架·极致还原】与【还原检查表】逐项扫视当前视频画面，输出约 ${wc} 字的一整段中文描述。`
      : `请按系统提示中的【五点结构框架·极致还原】与【还原检查表】逐项扫视当前图像，输出约 ${wc} 字的一整段中文描述。`;
    return lead + ComfyuiPE.buildSubjectScanReminder(caption);
  }

  const lead = video
    ? `Scan this video with the five-part max-fidelity framework and checklist in the system prompt; output one English paragraph (~${wc} words).`
    : `Scan this image with the five-part max-fidelity framework and checklist in the system prompt; output one English paragraph (~${wc} words).`;
  return lead + ComfyuiPE.buildSubjectScanReminder(caption);
}

export function buildUserTaskBody(caption: any): string {
  const wc = resolveWordCountHint(caption);
  const zh = isZhCaption(caption);
  if (zh) {
    return (
      `依照五点框架撰写：构图透视与裁切遮挡、主体（含头/面/视线/双手/双腿/服装材质）、环境光照、可见文字（无则略过）、风格媒介；` +
      `极致还原优先，有则必写，最终只输出一段连贯正文约 ${wc} 字，不要 Markdown。`
    );
  }
  return (
    `Cover all five parts with max fidelity: composition/crop/occlusion, subject incl. head/gaze/both hands/legs/clothing, environment/light, visible text only, style/medium; ` +
    `one paragraph ~${wc} words, no Markdown.`
  );
}

export function buildUserTailAddon(): string {
  return (
    ' 输出前确认：已按五点+检查表覆盖所有可见要素；人物已写头/视线/双手/双腿；单段自然文；无 **/-/#/序号标题；无虚构文字与套话概括。'
  );
}

/**
 * 描述式正文后处理：去 Markdown 残留、合并为一段
 */
export function sanitizeProseOutput(text: string): string {
  let s = String(text || '').trim();
  if (!s) return s;
  s = s.replace(/\r\n/g, '\n');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/^\s*[-*•]\s+/gm, '');
  s = s.replace(/^\s*\d+[.)）、]\s*/gm, '');
  s = s.replace(/\n{2,}/g, '\n');
  s = s.replace(/\n/g, '');
  s = s.replace(/\s{2,}/g, '');
  return s.trim();
}