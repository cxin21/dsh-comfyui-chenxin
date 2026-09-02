import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { resolve as pathResolve } from 'node:path'
import { buildCatalog } from '../pe-framework/anima-knowledge/catalog-build.js'
import { resolveKnowledgePath } from '../pe-framework/resources/resolve.js'
import type { Config } from '../plugin/config.js'

type LogCtx = { logger?: { info?: (msg: string) => void } }
const logInfo = (ctx: Context | null, msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)

function defaultSource(): string {
  return resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tags.sqlite' })
}
function defaultOutput(): string {
  return resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
}
function defaultManifest(): string {
  return resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'manifest.json' })
}

/**
 * catalog_build —— anima-prompt-v1 `catalog build` 动作的替代面（Stage 1 skill-merge）。
 * 默认路径全部经 resolveKnowledgePath 推导（无硬编码）：Stage 2 把 knowledge 目录
 * 迁到 assets/knowledge/ 时本工具无需改动。
 * manifest 仅跟随默认就地重建（output == 默认 tag-catalog.sqlite）时更新；
 * 自定义 output 不写 manifest，避免污染真实资产清单。
 * 纯库零日志；本层只打 action 摘要。
 */
export function registerCatalogBuildTool(ctx: Context, _config: Config) {
  return defineTool({
    name: 'catalog_build',
    description:
      '从 tags.sqlite 重建 Anima tag-catalog（临时文件 → FTS5 填充 → VACUUM → 原子替换），' +
      '替换后用 G4 mtime 刷新让 catalog_search 自动读新文件；默认同时重写 manifest.json。',
    parameters: {
      source: { type: 'string', description: '源 tags.sqlite 路径（默认 resolveKnowledgePath: skills/anima-prompt-v1/knowledge/tags.sqlite）' },
      output: { type: 'string', description: '输出 tag-catalog.sqlite 路径（默认 resolveKnowledgePath: .../tag-catalog.sqlite）' },
    },
    output: {
      schema: { type: 'string', description: 'Envelope JSON {ok, stats?, errors?}' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { source?: string; output?: string }) {
      const sourcePath = args.source?.trim() ? pathResolve(args.source) : defaultSource()
      const writtenOutput = args.output?.trim() ? pathResolve(args.output) : defaultOutput()
      const outputPath = writtenOutput
      // manifest 仅当目标是默认 knowledge catalog（就地重建）时更新
      const manifestPath = pathResolve(outputPath) === pathResolve(defaultOutput()) ? defaultManifest() : undefined
      try {
        const stats = buildCatalog({ sourcePath, outputPath, manifestPath })
        logInfo(
          ctx,
          `[prompt-master] catalog_build action=build records=${stats.records} names=${stats.names} ftsRows=${stats.ftsRows} output=${outputPath}`,
        )
        return JSON.stringify({
          ok: true,
          stats,
          source: sourcePath,
          output: outputPath,
          manifest: manifestPath ?? null,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        const code = /not found/i.test(message)
          ? 'input_file_missing'
          : /must not overwrite source/i.test(message)
            ? 'argument_error'
            : 'catalog_build_failed'
        logInfo(ctx, `[prompt-master] catalog_build failed code=${code} ${message}`)
        return JSON.stringify({ ok: false, errors: [{ code, message }] })
      }
    },
  })
}