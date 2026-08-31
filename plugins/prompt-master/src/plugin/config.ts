import z from '@deepseek-ai/schemastery'

/** R1：插件零 provider/model 配置（完全跟随 DSH 会话路由），仅保留 temperature */
export const Config = z.object({
  temperature: z.number().default(0.7),
  /** preset 根目录（资源路径解析用）；schemastery 无 default 的 string 属性即可选，缺省时按 env / preset 布局 fallback */
  presetRoot: z.string(),
})

export interface Config {
  temperature: number
  presetRoot?: string
}