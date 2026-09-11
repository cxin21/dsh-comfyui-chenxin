/**
 * 三期 Task 4（F5 + I-2）：prompt_author trace 耗时细分（enrich/intent/catalog）
 * + canonical 替换可观测接线（observability.canonicalSubstitutions / substitutions，
 * 独立新字段，不与既有 corrections=修正闭环轮次语义混淆）+ 替换对 advisory 进 trail。
 * 全程零 LLM：mock enrich/intent provider；替换场景走 tmp fixture catalog。
 */
import { describe, expect, it, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  registerAuthorTool,
  setAuthorIntentProvider,
  setAuthorEnrichProvider,
  setAuthorFeedbackDbPath,
} from '../../src/tools/prompt-author.js'
import { setCatalogPath, closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'
import { setPresetRoot } from '../../src/pe-framework/resources/resolve.js'
import type { CriticProvider } from '../../src/pe-framework/eval/critic.js'
import { stubCtx, runTool } from './helpers.js'

const cfg = { temperature: 0.7 }

function tool() {
  return registerAuthorTool(stubCtx() as never, cfg as never)
}

type Raw = { observability?: { traceStages?: Array<{ name: string; ms: number }>; canonicalSubstitutions?: number; substitutions?: string[] }; advisories?: string[]; ok?: boolean }

function stageNames(raw: Raw): string[] {
  return (raw.observability?.traceStages ?? []).map((s) => s.name)
}

/* ---- mock providers ---- */

const GOOD_SLOTS = { slots: { count_gender: ['1girl'], appearance: ['long hair'] } }

function enrichOk(): CriticProvider {
  const brief = {
    outputLang: 'en',
    subject: [{ text: 'silver hair girl', source: 'user' }],
    scene: [{ text: 'rainy neon street', source: 'enriched' }],
    composition: [{ text: 'medium shot', source: 'enriched' }],
    lighting: [{ text: 'rim light', source: 'enriched' }],
    color: [{ text: 'teal and orange', source: 'enriched' }],
    style: [{ text: 'cinematic', source: 'enriched' }],
    mood: [{ text: 'melancholic', source: 'enriched' }],
    nameAnchors: [],
  }
  return (async () => JSON.stringify(brief)) as unknown as CriticProvider
}

/* ---- tmp fixture catalog（'1girl' 与 'moon gate' canonical；'beside a moon gate' 不在库 → miss+fuzzy 候选）---- */

let tmp: string

function buildFixtureCatalog(): string {
  const knowledge = join(tmp, 'skills', 'anima-prompt-v1', 'knowledge')
  mkdirSync(knowledge, { recursive: true })
  const dbPath = join(knowledge, 'tag-catalog.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE sources (source_id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE records (record_id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, prompt_form TEXT NOT NULL, category TEXT NOT NULL, usage_count INTEGER NOT NULL, source_ids TEXT NOT NULL);
    CREATE TABLE names (name_id TEXT PRIMARY KEY, record_id TEXT NOT NULL, value TEXT NOT NULL, normalized_value TEXT NOT NULL, name_type TEXT NOT NULL);
  `)
  db.prepare("INSERT INTO sources VALUES ('src-1', 'danbooru')").run()
  db.prepare("INSERT INTO records VALUES ('rec-1', '1girl', '1girl', 'general', 100, '[\"src-1\"]')").run()
  db.prepare("INSERT INTO records VALUES ('rec-2', 'moon gate', 'moon gate', 'general', 50, '[\"src-1\"]')").run()
  db.prepare("INSERT INTO names VALUES ('nm-1', 'rec-1', '1girl', '1girl', 'canonical')").run()
  db.prepare("INSERT INTO names VALUES ('nm-2', 'rec-2', 'moon gate', 'moon gate', 'canonical')").run()
  db.exec(`CREATE VIRTUAL TABLE catalog_fts USING fts5(name_id UNINDEXED, record_id UNINDEXED, value, normalized_value)`)
  db.prepare('INSERT INTO catalog_fts (name_id, record_id, value, normalized_value) VALUES (?, ?, ?, ?)').run('nm-1', 'rec-1', '1girl', '1girl')
  db.prepare('INSERT INTO catalog_fts (name_id, record_id, value, normalized_value) VALUES (?, ?, ?, ?)').run('nm-2', 'rec-2', 'moon gate', 'moon gate')
  db.close()
  writeFileSync(
    join(knowledge, 'manifest.json'),
    JSON.stringify({ content_filters: false, output: { path: 'tag-catalog.sqlite', checksum: createHash('sha256').update(readFileSync(dbPath)).digest('hex') } }),
  )
  return dbPath
}

describe('F5 trace 耗时细分 + corrections 接线', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pm-author-f5-'))
    setAuthorFeedbackDbPath(join(tmp, 'feedback.sqlite'))
    setPresetRoot(tmp)
    closeCatalog()
    setCatalogPath(buildFixtureCatalog()) // presetRoot 指向 tmp 后默认 catalog 不可解析 → 统一走 fixture
  })
  afterEach(() => {
    setCatalogPath('')
    closeCatalog()
    setPresetRoot(undefined)
    setAuthorFeedbackDbPath(null)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('规格1：enrich 开且成功 → traceStages 含 enrich（ms≥0）+ intent 条目', async () => {
    setAuthorEnrichProvider(enrichOk())
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'off' }))) as Raw
    expect(raw.ok).toBe(true)
    const names = stageNames(raw)
    const enrich = (raw.observability?.traceStages ?? []).find((s) => s.name === 'enrich')
    expect(enrich).toBeDefined()
    expect(enrich!.ms).toBeGreaterThanOrEqual(0)
    expect(names).toContain('intent')
  })

  it('规格1：enrich:false → 无 enrich 条目；规格2：intent 条目始终存在', async () => {
    setAuthorEnrichProvider(enrichOk())
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'off', enrich: false }))) as Raw
    expect(raw.ok).toBe(true)
    expect(stageNames(raw)).not.toContain('enrich')
    expect(stageNames(raw)).toContain('intent')
  })

  it('规格3：替换发生 → canonicalSubstitutions≥1、substitutions 含 →、advisories 含 canonical_substitution: 前缀、traceStages 含 catalog', async () => {
    setAuthorEnrichProvider(enrichOk())
    setAuthorIntentProvider(async () => ({ slots: { count_gender: ['1girl'], scene: ['beside a moon gate'] } }) as never)
    const raw = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'girl at moon gate', judge_mode: 'off', enrich: false }))) as Raw
    expect(raw.ok).toBe(true)
    expect(raw.observability?.canonicalSubstitutions).toBeGreaterThanOrEqual(1)
    expect(raw.observability?.substitutions).toEqual(['beside a moon gate→moon gate'])
    expect(raw.advisories).toContain('canonical_substitution:beside a moon gate→moon gate')
    expect(stageNames(raw)).toContain('catalog')
  })

  it('规格3/4：无替换 → 字段为 0/空数组（始终存在）；anima catalog 条目仍在；h3 无 catalog 条目', async () => {
    setAuthorEnrichProvider(enrichOk())
    setAuthorIntentProvider(async () => GOOD_SLOTS as never)
    const anima = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'anima', input: 'cat portrait', judge_mode: 'off', enrich: false }))) as Raw
    expect(anima.observability?.canonicalSubstitutions).toBe(0)
    expect(anima.observability?.substitutions).toEqual([])
    expect(stageNames(anima)).toContain('catalog')
    expect(anima.advisories?.some((a) => a.startsWith('canonical_substitution:'))).toBe(false)

    setAuthorIntentProvider(async () => ({ shots: { duration_seconds: 6, shots: [{ what: 'A cat stretches.', ambient: 'soft wind' }] } }) as never)
    const h3 = JSON.parse(String(await runTool(stubCtx(), tool(), { target: 'h3', input: 'cat stretch', judge_mode: 'off', enrich: false }))) as Raw
    expect(h3.ok).toBe(true)
    expect(h3.observability?.canonicalSubstitutions).toBe(0)
    expect(h3.observability?.substitutions).toEqual([])
    expect(stageNames(h3)).not.toContain('catalog')
    expect(stageNames(h3)).toContain('intent')
  })

  afterAll(() => {
    setAuthorIntentProvider(null)
    setAuthorEnrichProvider(null)
  })
})
