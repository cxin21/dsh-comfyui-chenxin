import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export interface GoldenEntry {
  name: string
  input: unknown
  inputPlan?: unknown
  pythonOutput?: unknown
  sha256: string
}

/**
 * Golden 文件路径（锚定仓库源码树：tests 编译到 dist 后 __dirname 会变，
 * 故以 process.cwd()（= 仓库根，运行时成立）为锚；golden 属源码资产，不复制进 dist）。
 */
export function goldenPath(name: string): string {
  return join(process.cwd(), 'tests', 'fidelity', 'golden', `${name}.json`)
}

export function goldenExists(name: string): boolean {
  return existsSync(goldenPath(name))
}

/**
 * 从 preset 的 Python CLI 捕获一次输出并返回（一次性 capture；之后只读 golden）。
 * 注意：DSH 沙箱会拦截 Node child_process 带管道 stdio 的 spawn（EPERM）；
 * 沙箱内生成 golden 请改用 PowerShell 直接运行 CLI 并从 stdout 落文件，或由用户在普通 shell 执行。
 */
export async function capturePresetOutput(exe: string, args: string[], inputFile: string): Promise<string> {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [...args, inputFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`capturePresetOutput exit ${code}: ${err}`))
    })
  })
}

function sha256Of(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function writeGolden(name: string, entry: GoldenEntry): void {
  writeFileSync(goldenPath(name), JSON.stringify(entry, null, 2), 'utf8')
}

export function readGolden(name: string): GoldenEntry {
  return JSON.parse(readFileSync(goldenPath(name), 'utf8')) as GoldenEntry
}

/** 按点分路径投影取子集（Ruling #8：仅比较 contracts.md ② 承诺字段） */
function projectPaths(value: unknown, paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const path of paths) {
    const parts = path.split('.')
    let cur: unknown = value
    for (const part of parts) {
      if (cur === null || cur === undefined || typeof cur !== 'object') {
        cur = undefined
        break
      }
      cur = (cur as Record<string, unknown>)[part]
    }
    out[path] = cur
  }
  return out
}

/**
 * 断言 actual 与 golden.pythonOutput 深比较 + golden 的 sha256 自洽（M5 防篡改）。
 * `project` 非空时为投影比较（点分路径白名单，如 ['result.text', 'result.budget.quality_cap']，
 * 与 contracts.md ② 对齐）；空/缺省保持全比较（向后兼容）。sha256 始终校验完整 pythonOutput。
 */
export function assertGolden(actual: unknown, name: string, project?: string[]): void {
  const entry = readGolden(name)
  if (entry.pythonOutput === undefined) throw new Error(`golden ${name}: pythonOutput missing`)
  const expectedSha = sha256Of(entry.pythonOutput)
  if (expectedSha !== entry.sha256) {
    throw new Error(`golden ${name}: sha256 mismatch (recorded ${entry.sha256}, actual ${expectedSha})`)
  }
  const actualJson = JSON.stringify(project ?? []).length > 2 ? JSON.stringify(projectPaths(actual, project!)) : JSON.stringify(actual)
  const expectedJson = JSON.stringify(project ?? []).length > 2 ? JSON.stringify(projectPaths(entry.pythonOutput, project!)) : JSON.stringify(entry.pythonOutput)
  if (actualJson !== expectedJson) {
    throw new Error(`golden ${name}: output mismatch${project ? ` (projection ${project.join(',')})` : ''}\n--- golden ---\n${expectedJson}\n--- actual ---\n${actualJson}`)
  }
}