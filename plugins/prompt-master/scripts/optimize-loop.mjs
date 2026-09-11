#!/usr/bin/env node
/**
 * optimize-loop 薄 CLI 壳（二期 spec §10.3-A9）：解析 argv → import dist 的 loop.ts → 退出码。
 * 壳内不做业务逻辑（全部委托 loop.ts）；离线铁律：只产报告，不改任何 persona，
 * 不注册任何 agent 工具。
 *
 * 用法：
 *   node scripts/optimize-loop.mjs --target anima --db <feedback.sqlite> \
 *     --persona <persona.txt> --mode mock --out <outDir> [--limit 20] [--force]
 *
 * 退出码：0 正常完成；2 参数校验失败 / 未达标且无 --force；1 运行时错误。
 */
import { resolve } from 'node:path'

const USAGE = `用法: node scripts/optimize-loop.mjs [options]
  --target <anima|h3>   目标方言（必填）
  --db <path>           feedback sqlite 路径（必填）
  --persona <path>      当前 persona 文本文件路径（必填，只读不写）
  --mode <mock|live>    mock=固定评分/变异；live=需宿主注入装配（离线 CLI 不支持，必填）
  --out <dir>           报告落盘目录（必填）
  --limit <n>           评测集条数上限（缺省 20）
  --force               跳过冷启动门槛直接跑迭代
  --help                打印本帮助`

function parseArgv(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--force') args.force = true
    else if (a === '--help') args.help = true
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[++i]
      if (val === undefined) return { error: `缺少参数值: ${a}` }
      args[key] = val
    } else return { error: `无法识别的位置参数: ${a}` }
  }
  return { args }
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2))
  if (parsed.error || parsed.args.help) {
    console.error(USAGE)
    process.exit(2)
  }
  const a = parsed.args

  const errors = []
  if (a.target !== 'anima' && a.target !== 'h3') errors.push('--target 必须是 anima 或 h3')
  if (!a.db) errors.push('--db 必填')
  if (!a.persona) errors.push('--persona 必填')
  if (a.mode !== 'mock' && a.mode !== 'live') errors.push('--mode 必须是 mock 或 live')
  if (!a.out) errors.push('--out 必填')
  if (a.limit !== undefined && (!/^\d+$/.test(a.limit) || Number(a.limit) < 1))
    errors.push('--limit 必须是正整数')
  if (errors.length) {
    for (const e of errors) console.error('参数错误: ' + e)
    console.error(USAGE)
    process.exit(2)
  }

  // ESM 方式加载 dist（file:// URL + 绝对路径；import.meta.url 已是 file://，直接取 href）
  const loopUrl = new URL('../dist/src/pe-framework/optimize/loop.js', import.meta.url)
  const loop = await import(loopUrl.href)

  const opts = {
    target: a.target,
    dbPath: resolve(a.db),
    personaFile: resolve(a.persona),
    limit: a.limit !== undefined ? Number(a.limit) : undefined,
    mode: a.mode,
    outDir: resolve(a.out),
  }

  try {
    // --force：CLI 层覆盖语义——跳过冷启动门槛直接跑迭代（委托 runIterations）
    const result = a.force
      ? await loop.runIterations(opts)
      : await loop.runOptimizeLoop(opts)
    if (!result.ready) {
      console.log(`冷启动未达标，已产冷启动报告: ${result.reportPath}`)
      console.log('如确要跳过门槛，加 --force 重跑。')
      process.exit(2)
    }
    console.log(`迭代完成: candidate=${result.candidateId} evalsetSize=${result.evalsetSize}`)
    console.log(`报告: ${result.reportPath}`)
    process.exit(0)
  } catch (err) {
    console.error('运行失败: ' + (err && err.message ? err.message : String(err)))
    process.exit(1)
  }
}

main()
