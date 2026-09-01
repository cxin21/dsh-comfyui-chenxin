import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerCatalogRelationsTool } from '../../src/tools/catalog-relations.js'
import { stubCtx, runTool } from './helpers.js'
import { setOverlayPath } from '../../src/pe-framework/anima-knowledge/relations.js'
import { closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'

const cfg = { temperature: 0.7 }
const def = () => registerCatalogRelationsTool(null as never, cfg as never)

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pm-reltool-'))
  setOverlayPath(join(tmp, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite'))
})

afterEach(() => {
  setOverlayPath('')
  rmSync(tmp, { recursive: true, force: true })
})

describe('catalog_relations tool', () => {
  it('submit → list → accept → status round-trip via injected tmp overlay', async () => {
    const ctx = stubCtx()
    const tool = registerCatalogRelationsTool(ctx as never, cfg as never)
    // submit：'wave' 是 catalog alias、'waving' 是 canonical → 端点存在
    const sub = JSON.parse(String(await runTool(ctx, tool, {
      action: 'submit',
      source_tag: 'wave',
      target_tag: 'waving',
      relation: 'related',
      rationale: 'wave is a short form of waving',
      evidence: ['taxonomy'],
    })))
    expect(sub.ok).toBe(true)
    expect(sub.proposal_id).toMatch(/^rel:/)
    expect(sub.status).toBe('candidate')

    // list 默认 all
    const listed = JSON.parse(String(await runTool(ctx, tool, { action: 'list' })))
    expect(listed.proposals).toHaveLength(1)
    expect(listed.proposals[0].from_record_id).toBe('wave')
    expect(listed.proposals[0].to_record_id).toBe('waving')
    expect(listed.proposals[0].status).toBe('candidate')

    // accept
    const acc = JSON.parse(String(await runTool(ctx, tool, { action: 'accept', proposal_id: sub.proposal_id })))
    expect(acc.status).toBe('accepted')

    // status：accepted 计数 1
    const status = JSON.parse(String(await runTool(ctx, tool, { action: 'status' })))
    expect(status.counts.accepted).toBe(1)
    expect(status.counts.candidate).toBe(0)
    expect(status.overlay).toBe('available')
  })

  it('reject flips candidate → rejected and list status filter works', async () => {
    const ctx = stubCtx()
    const tool = registerCatalogRelationsTool(ctx as never, cfg as never)
    const sub = JSON.parse(String(await runTool(ctx, tool, {
      action: 'submit', source_tag: 'long hair', target_tag: 'waving', relation: 'related',
    })))
    const rej = JSON.parse(String(await runTool(ctx, tool, { action: 'reject', proposal_id: sub.proposal_id })))
    expect(rej.status).toBe('rejected')
    const listed = JSON.parse(String(await runTool(ctx, tool, { action: 'list', status: 'rejected' })))
    expect(listed.proposals).toHaveLength(1)
    expect(JSON.parse(String(await runTool(ctx, tool, { action: 'list', status: 'candidate' }))).proposals).toHaveLength(0)
  })

  it('unknown endpoint → readable error naming the tag', async () => {
    const ctx = stubCtx()
    const tool = registerCatalogRelationsTool(ctx as never, cfg as never)
    await expect(runTool(ctx, tool, {
      action: 'submit', source_tag: 'zzzznotatag', target_tag: 'waving', relation: 'related',
    })).rejects.toThrow(/zzzznotatag/)
  })

  it('cooccurrence → readable rejection (real statistics source, not LLM)', async () => {
    const ctx = stubCtx()
    const tool = registerCatalogRelationsTool(ctx as never, cfg as never)
    await expect(runTool(ctx, tool, {
      action: 'submit', source_tag: 'wave', target_tag: 'waving', relation: 'cooccurrence',
    })).rejects.toThrow(/cooccurrence/)
  })

  it('unknown proposal_id on accept → readable error', async () => {
    const ctx = stubCtx()
    const tool = registerCatalogRelationsTool(ctx as never, cfg as never)
    await expect(runTool(ctx, tool, { action: 'accept', proposal_id: 'rel:doesnotexist' })).rejects.toThrow(/rel:doesnotexist/)
  })

  it('missing action / unknown action → readable errors', async () => {
    const ctx = stubCtx()
    const tool = registerCatalogRelationsTool(ctx as never, cfg as never)
    await expect(runTool(ctx, tool, {})).rejects.toThrow(/action/)
    await expect(runTool(ctx, tool, { action: 'explode' })).rejects.toThrow(/explode/)
  })

  it('status on empty overlay → zero counts, path reported', async () => {
    const ctx = stubCtx()
    const tool = registerCatalogRelationsTool(ctx as never, cfg as never)
    const status = JSON.parse(String(await runTool(ctx, tool, { action: 'status' })))
    expect(status.counts).toEqual({ candidate: 0, accepted: 0, rejected: 0 })
    expect(String(status.path)).toContain('relation-overlay.sqlite')
  })

  afterEach(() => closeCatalog())
})
