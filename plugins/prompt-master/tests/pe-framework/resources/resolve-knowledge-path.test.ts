// tests/pe-framework/resources/resolve-knowledge-path.test.ts
// Stage 2 skill-merge：resolveKnowledgePath 双路径优先级（assets/knowledge 优先，skills 回退，都缺 → 新路径）。
// 用真实临时目录做假 preset root，确定性验证 existsSync 驱动的分支，而非依赖磁盘上不存在的假根。
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setPresetRoot, resolveKnowledgePath } from '../../../src/pe-framework/resources/resolve.js'

function makeFakeRoot(): { root: string; newDir: string; oldDir: string; newPath: string; oldPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'prompt-master-resolve-'))
  const skillDir = 'anima-prompt-v1'
  const asset = 'tag-catalog.sqlite'
  const newDir = join(root, 'assets', 'knowledge', skillDir)
  const oldDir = join(root, 'skills', skillDir, 'knowledge')
  const newPath = join(newDir, asset)
  const oldPath = join(oldDir, asset)
  return { root, newDir, oldDir, newPath, oldPath }
}

describe('resolveKnowledgePath dual-path priority (fake root with real files)', () => {
  let fake: ReturnType<typeof makeFakeRoot>

  beforeEach(() => {
    fake = makeFakeRoot()
    setPresetRoot(fake.root)
  })

  afterEach(() => {
    setPresetRoot(undefined)
    rmSync(fake.root, { recursive: true, force: true })
  })

  it('resolves NEW path when assets/knowledge/<skill>/<asset> exists (preferred)', () => {
    mkdirSync(fake.newDir, { recursive: true })
    writeFileSync(fake.newPath, 'new')
    // 旧路径也存在时仍须选新路径（Stage 2 过渡期两者并存）
    mkdirSync(fake.oldDir, { recursive: true })
    writeFileSync(fake.oldPath, 'old')
    expect(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })).toBe(fake.newPath)
  })

  it('falls back to OLD path when only skills/<skill>/knowledge/<asset> exists', () => {
    mkdirSync(fake.oldDir, { recursive: true })
    writeFileSync(fake.oldPath, 'old')
    expect(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })).toBe(fake.oldPath)
  })

  it('resolves NEW path when neither location exists (graceful; callers handle missing assets)', () => {
    expect(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })).toBe(fake.newPath)
    // 顺带验证：该路径当前确实不存在（证明优先级是「都不存在 → 仍给新路径」而非误判存在）
    expect(existsSync(fake.newPath)).toBe(false)
  })

  it('per-asset resolution: h3 tokenizer asset follows the same priority', () => {
    const h3New = join(fake.root, 'assets', 'knowledge', 'minimax-h3-prompt', 'tokenizer.json')
    mkdirSync(join(fake.root, 'assets', 'knowledge', 'minimax-h3-prompt'), { recursive: true })
    writeFileSync(h3New, 'tok')
    expect(resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'tokenizer.json' })).toBe(h3New)
  })
})

describe('resolveKnowledgePath on real preset checkout (before/after migration both resolve)', () => {
  // 不注入 setPresetRoot / env → fallbackPresetRoot 解析出真实 preset 根（本 checkout 布局）。
  // Stage 2 前后此测试都必须绿：迁移前旧路径存在 → 解析到 skills/…；迁移后新路径存在 → 解析到 assets/knowledge/…，
  // 始终落在一个实际存在的资产文件上（golden 不变量：catalog/tokenizer 照常可读）。
  beforeEach(() => setPresetRoot(undefined))

  it('tag-catalog.sqlite resolves to an existing file', () => {
    const resolved = resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
    expect(resolved).toContain('tag-catalog.sqlite')
    expect(existsSync(resolved)).toBe(true)
  })

  it('tokenizer.json resolves to an existing file', () => {
    const resolved = resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'tokenizer.json' })
    expect(resolved).toContain('tokenizer.json')
    expect(existsSync(resolved)).toBe(true)
  })
})