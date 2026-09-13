/**
 * M5-T2（D7 + F1 裁定，design §2.4）：调用方显式 art_direction 卡 → 蓝图字段确定性注入。
 * 纯函数（零 LLM、不信任 LLM 产物）——卡片是调用方硬要求，语义强于 runEnrich 时代的 brief 软约束。
 * 形状契约（F1，design §2.4/评审裁定）：
 * - perspective → media_layer.image.camera_angle 追加：每卡至多 1 个 anima 安全景别词
 *   （full body/cowboy shot/upper body/close-up 白名单内；非白名单词丢弃 + advisory）——
 *   camera 是结构槽（compileAnima miss 永不删），脏词会全文穿透，白名单是产出纪律的确定性兜底；
 * - composition → core.composition 追加（全部 tags）；
 * - lighting → core.scene.lighting 追加，与既有内容/卡组间显式分隔符「；」
 *   （卡组已过 LIGHTING_BAN，A7 不变式沿用，tests/pe-framework/enrichment/art-direction-ban.test.ts 把关）；
 * - color → **不**确定性写入 core.style.palette（F1 否决：palette 是 P1 non-mapping 字段，
 *   投影不产出对应槽，写入零表面效果 = 假注入）——改走推荐先验通道：本函数把 color 卡折进
 *   colorRecommendations 返回，编排层并入 enrichBlueprint user 段【推荐先验】（LLM 终决写 narrative 色彩句）；
 * - motion → media_layer.image.pose_action 追加（全部 tags）。
 * 每张实际注入的卡出 advisory `art_direction_applied:<field>:<id>`；丢弃词出
 * `art_direction_dropped:<field>:<id>:<words>`。预检 validateArtDirectionSpec 已 fail-fast，
 * 本函数对未知 field/id 防御性跳过（不抛错）。
 */
import type { BlueprintV1 } from '../blueprint/schema.js'
import { artDirectionCardOf, type ArtDirectionField } from '../enrich/art-direction.js'

/** F1：camera_angle 追加白名单（anima 安全景别词，与 ANIMA 蓝图 persona 规则 7 同表） */
export const CAMERA_ANGLE_SAFE_TERMS: readonly string[] = ['full body', 'cowboy shot', 'upper body', 'close-up']

/** F1：追加既有字段/卡组间的显式分隔符（lighting 卡间显式分隔裁定；scene.lighting 是自然语言字段） */
export const ART_DIRECTION_FIELD_SEPARATOR = '；'

/** camera_angle 追加连接符：camera 是逗号连接 tag 语义的结构槽，不用「；」（脏词防护与 F1 白名单同旨） */
export const CAMERA_ANGLE_JOINER = ', '

/** 推荐先验条目形状（与 enrichment/engine.ts EnrichOptions.recommendations 同构） */
export interface ArtDirectionRecommendation {
  field: string
  cardId: string
  reason: string
}

export interface ArtDirectionApplyResult {
  blueprint: BlueprintV1
  /** 每张实际注入卡一条：art_direction_applied:<field>:<id>（编排层并入 envelope advisories） */
  advisories: string[]
  /** F1：color 卡折进推荐先验通道（编排层并入 enrichBlueprint recommendations） */
  colorRecommendations: ArtDirectionRecommendation[]
}

function appendSeparated(existing: string | undefined, addition: string, joiner = ART_DIRECTION_FIELD_SEPARATOR): string {
  const base = existing?.trim() ?? ''
  return base.length > 0 ? `${base}${joiner}${addition}` : addition
}

function appendTags(list: string[] | undefined, tags: readonly string[]): string[] {
  return [...(list ?? []), ...tags]
}

export function applyArtDirectionCards(bp: BlueprintV1, spec: Record<string, string>): ArtDirectionApplyResult {
  const out: BlueprintV1 = structuredClone(bp)
  const advisories: string[] = []
  const colorRecommendations: ArtDirectionRecommendation[] = []

  for (const [fieldRaw, id] of Object.entries(spec)) {
    const field = fieldRaw as ArtDirectionField
    const card = artDirectionCardOf(field, id)
    if (!card) continue // 预检 validateArtDirectionSpec 已 fail-fast；此处防御性跳过
    if (field === 'perspective') {
      // F1：每卡至多 1 个白名单景别词；非白名单词丢弃 + advisory
      const safe = card.tags.filter((t) => CAMERA_ANGLE_SAFE_TERMS.includes(t))
      const dropped = card.tags.filter((t) => !CAMERA_ANGLE_SAFE_TERMS.includes(t))
      if (safe.length > 0) {
        const image = out.media_layer.image ?? {}
        image.camera_angle = appendSeparated(image.camera_angle, safe[0] as string, CAMERA_ANGLE_JOINER)
        out.media_layer.image = image
        advisories.push(`art_direction_applied:perspective:${card.id}`)
      }
      if (dropped.length > 0) advisories.push(`art_direction_dropped:perspective:${card.id}:${dropped.join(',')}`)
      continue
    }
    if (field === 'color') {
      // F1：color 卡走推荐先验通道（LLM 终决），不做 palette 假注入
      colorRecommendations.push({ field: 'color', cardId: card.id, reason: '调用方显式指定（F1 推荐先验通道）' })
      advisories.push(`art_direction_applied:color:${card.id}`)
      continue
    }
    if (field === 'composition') {
      out.core.composition = appendTags(out.core.composition, card.tags)
      advisories.push(`art_direction_applied:composition:${card.id}`)
      continue
    }
    if (field === 'lighting') {
      const scene = out.core.scene ?? { environment: '' }
      scene.lighting = appendSeparated(scene.lighting, card.tags.join(', '))
      out.core.scene = scene
      advisories.push(`art_direction_applied:lighting:${card.id}`)
      continue
    }
    if (field === 'motion') {
      const image = out.media_layer.image ?? {}
      image.pose_action = appendTags(image.pose_action, card.tags)
      out.media_layer.image = image
      advisories.push(`art_direction_applied:motion:${card.id}`)
      continue
    }
  }

  return { blueprint: out, advisories, colorRecommendations }
}
