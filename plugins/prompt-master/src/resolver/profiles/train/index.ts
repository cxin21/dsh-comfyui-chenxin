// 训练打标 Profile — 移植自 PM trainCaptionTypeProfiles.js
import { PEProfile } from '../../types.js';
import { ALL_SUBJECT_DOMAIN_IDS } from '../../taxonomy.js';

const TRAIN_CAPTION_TYPE_DEFS = [
  { id: 'pe_train_descriptive', builtinKey: 'Descriptive', name: '描述式打标', desc: '单段连贯自然语言描述画面主体、环境与风格，适用于 Flux、MJ 等自然语言提示词模型训练。', fmt: 'prose', sort: 10, tags: ['描述式', '自然语言', '训练'], domains: ALL_SUBJECT_DOMAIN_IDS },
  { id: 'pe_train_descriptive_casual', builtinKey: 'Descriptive_Casual', name: '口语化描述式打标', desc: '轻松口语化的自然语言描述，语气更随意，仍覆盖画面关键信息。', fmt: 'prose', sort: 15, tags: ['口语化', '自然语言', '训练'], domains: ALL_SUBJECT_DOMAIN_IDS },
  { id: 'pe_train_straightforward', builtinKey: 'Straightforward', name: '简洁直述式描述', desc: '客观直述画面要素（主体、颜色、形状、空间关系等），避免主观臆测与「这是一张…」式开头。', fmt: 'prose', sort: 20, tags: ['直述', '自然语言', '训练'], domains: ALL_SUBJECT_DOMAIN_IDS },
  { id: 'pe_train_sd', builtinKey: 'Stable_Diffusion_Prompt', name: 'Stable Diffusion 提示词格式', desc: '一行逗号分隔 SD 正向标签，含完整还原检查表。', fmt: 'sd_tags', sort: 25, tags: ['SD', 'ComfyUI', '训练'], domains: ALL_SUBJECT_DOMAIN_IDS },
  { id: 'pe_train_midjourney', builtinKey: 'MidJourney', name: 'MidJourney 提示词格式', desc: '一行或极短一段 MidJourney 风格英文关键词与参数式短语。', fmt: 'sd_tags', sort: 30, tags: ['MidJourney', '关键词', '训练'], domains: ALL_SUBJECT_DOMAIN_IDS },
  { id: 'pe_train_danbooru', builtinKey: 'Danbooru_tag_list', name: 'Danbooru 标签列表（动漫）', desc: '一行英文 Danbooru 风格 tag（artist:/copyright:/character:/meta: 前缀 + 通用标签）。', fmt: 'danbooru_tags', sort: 35, tags: ['Danbooru', '动漫', '训练'], domains: ['general', 'portrait'] },
  { id: 'pe_train_e621', builtinKey: 'e621_tag_list', name: 'e621 标签列表（兽系）', desc: '一行 e621 风格英文标签（含 artist:/species:/lore: 等前缀）。', fmt: 'danbooru_tags', sort: 40, tags: ['e621', '兽系', '训练'], domains: ['general', 'animal', 'portrait'] },
  { id: 'pe_train_rule34', builtinKey: 'Rule34_tag_list', name: 'Rule34 标签列表', desc: '一行 Rule34 风格英文标签。', fmt: 'danbooru_tags', sort: 45, tags: ['Rule34', 'Booru', '训练'], domains: ['general', 'portrait'] },
  { id: 'pe_train_booru', builtinKey: 'Booru_tag_list', name: 'Booru 风格标签列表', desc: '一行 Booru 类站点风格的英文标签列表。', fmt: 'danbooru_tags', sort: 50, tags: ['Booru', '标签', '训练'], domains: ['general', 'portrait'] },
  { id: 'pe_train_art_critic', builtinKey: 'Art_Critic', name: '艺术评论式描述', desc: '从艺术评论角度描述构图、风格、象征、色彩、光线与艺术流派等。', fmt: 'prose', sort: 55, tags: ['艺术评论', '自然语言', '训练'], domains: ALL_SUBJECT_DOMAIN_IDS },
  { id: 'pe_train_product_listing', builtinKey: 'Product_Listing', name: '商品详情描述', desc: '以电商商品详情页的口吻描述画面中的产品、材质与卖点。', fmt: 'prose', sort: 60, tags: ['商品', '自然语言', '训练'], domains: ['general', 'product', 'still_life'] },
  { id: 'pe_train_social_media_post', builtinKey: 'Social_Media_Post', name: '社交媒体文案', desc: '以社交媒体发帖风格撰写配图文案，语气贴近日常分享。', fmt: 'prose', sort: 65, tags: ['社媒', '自然语言', '训练'], domains: ALL_SUBJECT_DOMAIN_IDS },
] as const;

export function buildBuiltinTrainCaptionProfiles(): PEProfile[] {
  return TRAIN_CAPTION_TYPE_DEFS.map((d: any) => ({
    id: d.id,
    kind: 'train',
    builtin: true,
    builtinKey: d.builtinKey,
    name: d.name,
    category: '训练打标',
    description: d.desc,
    enabled: true,
    sort: d.sort,
    outputFormat: d.fmt as any,
    tags: [...d.tags],
    subjectDomains: [...d.domains],
  }));
}

const TRAIN_CAPTION_TYPE_TO_PE_ID: Record<string, string> = Object.fromEntries(
  TRAIN_CAPTION_TYPE_DEFS.map((d: any) => [d.builtinKey, d.id])
);

export function mapTrainCaptionTypeToPeId(type: string): string {
  const key = String(type || '').trim();
  return TRAIN_CAPTION_TYPE_TO_PE_ID[key] || 'pe_train_descriptive';
}