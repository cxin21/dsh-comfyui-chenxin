# Task 3Q Brief (Round 8): 美学与设计感升级——艺术指导卡片内置

工作目录：`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`（HEAD 2e1c844，880 基线）

## 背景

用户判定插件出稿「没有美学和设计感」。根因：enrich/intent persona 只教了结构，没教**艺术指导**。参考 SD-Anima-Prompt-Studio 的方法论：把专业美术指导的「设计意图包」（组合拳卡片）内置到生成层，让 LLM 先做设计决策、再按决策扩写。

## 你的任务

**A. 新建设计卡片库** `src/pe-framework/enrich/art-direction.ts`：

```ts
export interface ArtDirectionCard {
  id: string
  name: string            // 中文设计意图名
  tags: readonly string[] // 配套 tag 组合拳（3-5 个）
}
export const PERSPECTIVE_CARDS: readonly ArtDirectionCard[]   // 镜头视角
export const COMPOSITION_CARDS: readonly ArtDirectionCard[]   // 构图设计
export const LIGHTING_CARDS: readonly ArtDirectionCard[]      // 光影设计
export const COLOR_CARDS: readonly ArtDirectionCard[]         // 色彩设计
export const MOTION_CARDS: readonly ArtDirectionCard[]        // 动势设计
export const ALL_ART_DIRECTION: { perspective: ...; composition: ...; lighting: ...; color: ...; motion: ... }
```

卡片内容（从实战 studio 提炼，按此落地，可微调措辞）：

**PERSPECTIVE_CARDS**（镜头视角，选 8）：
- 低角度仰拍: ['from below', 'dramatic low angle', 'looking up']——突出气势与主体高大
- 三分之二视角: ['three-quarter view', 'dynamic angle', 'showing both face and body']——人像最自然
- 过肩回眸: ['over the shoulder shot', 'looking back at viewer', 'soft focus on background']——叙事感
- 荷兰角: ['dutch angle', 'tilted frame', 'sense of tension']——紧张/动感
- 广角全景: ['wide angle shot', 'expansive view', 'cinematic wide shot']——场景宏大
- 特写: ['close-up', 'shallow depth of field', 'detailed face']——情绪特写
- 俯视: ['from above', 'top-down view', 'looking down']——俯瞰叙事
- 侧面剪影: ['from side', 'silhouette', 'backlit subject']——戏剧轮廓

**COMPOSITION_CARDS**（构图，选 8）：
- 三分法则: ['rule of thirds', 'off-center placement', 'balanced asymmetry']
- 对角线动势: ['diagonal composition', 'dynamic diagonal lines', 'sense of movement']
- 负空间: ['negative space composition', 'minimalist', 'empty space for breathing room']
- 框架构图: ['framed composition', 'natural frame around subject', 'foreground framing']
- 对称: ['perfect symmetry', 'mirrored composition', 'formal and elegant']
- 引导线: ['leading lines', 'converging lines', 'depth through perspective']
- 黄金分割: ['golden ratio composition', 'naturally pleasing placement', 'organic balance']
- 剪影: ['strong silhouette', 'dramatic outline', 'backlit minimal detail']

**LIGHTING_CARDS**（光影，选 8）：
- 电影级: ['cinematic lighting', 'volumetric lighting', 'dramatic shadows']
- 逆光轮廓: ['backlighting', 'rim lighting', 'glowing edge']——发丝边缘光
- 体积光: ['god rays', 'light rays', 'volumetric sunlight']——穿透感
- 月夜冷调: ['moonlight', 'cool blue tones', 'soft night glow']——夜景
- 黄金时刻: ['golden hour lighting', 'warm sunlight', 'long shadows']
- 烛光/灯火: ['warm lantern light', 'candlelight glow', 'intimate warm tones']
- 高对比: ['high contrast lighting', 'chiaroscuro', 'dramatic light and shadow']
- 柔光梦幻: ['soft lighting', 'ethereal glow', 'diffused light']

**COLOR_CARDS**（色彩，选 6）：
- 冷暖对比: ['contrasting color palette', 'cool and warm tones', 'color tension']
- 有限色板: ['limited palette', 'two-tone color scheme', 'unified color harmony']
- 浓郁电影调色: ['cinematic color grading', 'rich saturated colors', 'vivid yet natural tones']
- 单色+点缀: ['monochrome with accent color', 'splash of red', 'selective color pop']
- 柔和淡彩: ['soft pastel colors', 'muted tones', 'gentle color transition']
- 高饱和幻想: ['vibrant fantasy colors', 'iridescent highlights', 'luminous colors']

**MOTION_CARDS**（动势，选 6——直接服务舞剑类需求）：
- 动态姿势: ['dynamic pose', 'action-ready stance', 'mid-movement']
- 衣袂飘飞: ['flowing dress', 'fabric in motion', 'clothes fluttering in wind']
- 发丝飞扬: ['hair flowing in wind', 'dynamic hair', 'hair strands floating']
- 武器轨迹: ['sword trail', 'gleaming blade', 'weapon arc']
- 花瓣飞舞: ['falling petals', 'petals in the wind', 'swirling petals']
- 定格瞬间: ['caught mid-action', 'frozen motion', 'peak of the movement']

**B. enrich persona（anima）加「艺术指导课程」**（`personas.ts`）：
在七维度任务描述后追加（大意，措辞可优化）：
「艺术指导（必须先做设计决策再扩写）：
1. 从四类设计卡中各选定一套组合：镜头视角（如低角度仰拍/三分之二视角）、构图（如对角线动势/三分法则/负空间）、光影（如逆光轮廓/体积光/月夜冷调）、色彩（如冷暖对比/有限色板）
2. 把所选组合的 tag 写入 composition 与 lighting/color 维度（source=enriched）
3. 动势设计：动作场景必须含动势卡（衣袂飘飞/发丝飞扬/武器轨迹/定格瞬间至少其一）
4. 服装描述采用五件套：材质颜色 + 剪裁细节 + 纹样点缀 + 动态特征 + 整体轮廓（如 'white silk hanfu | wide flowing sleeves | subtle cloud embroidery | sleeves trailing in motion | elegant silhouette'）
5. 设计决策服务于情绪叙事：先定画面情绪，再选服务于该情绪的光影与色彩」

**C. schema 扩展**（`enrich/brief.ts`）：`EnrichedBrief` 增加可选字段 `artDirection?: { perspective?: string; composition?: string; lighting?: string; color?: string; motion?: string }`（值为所选卡片 id）——validateBrief 对存在的 id 校验合法性（须在 ALL_ART_DIRECTION 中），未知 id → 整体 skipped（brief_too_large 同款处理：reason='invalid_art_direction'）。engine buildUser 的 user 段附上四类卡片清单（id+name+tags）供 LLM 选择。

**D. 测试**：
1. 合法 artDirection → brief 含该字段且校验通过
2. 未知卡片 id → skipped invalid_art_direction
3. persona 断言：含「艺术指导」「设计决策」「五件套」关键词
4. e2e（author-enrich.e2e）：mock provider 返回含 artDirection 的 brief → envelope enrichment 段带 artDirection；不加 artDirection 的旧形状 brief 仍通过（向后兼容）

先读：`enrich/brief.ts`、`enrich/personas.ts`、`enrich/engine.ts`、`tests/pe-framework/enrich/`、`docs/2026-09-09-round8-narrative-budget-design.md`（风格参考）。

## 完成标准

```bash
npx vitest run tests/pe-framework/enrich/ tests/plugin/author-enrich.e2e.test.ts   # 全 PASS
npx vitest run                                            # 0 failed（≥880）
npx tsc --noEmit && npm run build
git add src/pe-framework/enrich/ tests/pe-framework/enrich/ tests/plugin/author-enrich.e2e.test.ts
git commit -m "feat(enrich): 艺术指导卡片内置——美学与设计感升级 (Round8 T3Q)"
```

提交严禁混入工作区脏文件。禁止派生 subagent。

## 报告契约

完整报告写入同目录 `task-3q-report.md`；回复只报：状态/commit/一行测试摘要/concerns。