import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  proposalSignature,
  canonicalRelationSignature,
  validateProposal,
  submitProposal,
  listProposals,
  decideProposal,
  setOverlayPath,
} from '../../../src/pe-framework/anima-knowledge/relations.js'
import type { MatchKind } from '../../../src/pe-framework/dialect/anima-catalog.js'

let tmp: string

/** classify stub：只有显式给出的 tag 视为 canonical，其余 miss */
function classifyOf(known: string[]) {
  return (tag: string): MatchKind => (known.includes(tag) ? 'canonical' : 'miss')
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pm-overlay-'))
  setOverlayPath(join(tmp, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite'))
})
afterEach(() => {
  setOverlayPath('')
  rmSync(tmp, { recursive: true, force: true })
})

describe('relation validation chain', () => {
  it('proposal_id deterministic (same input → same sha256 signature)', () => {
    const s1 = proposalSignature('a', 'b', 'parent')
    const s2 = proposalSignature('a', 'b', 'parent')
    expect(s1).toBe(s2)
    // 源码语义：'rel:' + sha256(f"{from_id}|{to_id}|{relation_type}").hexdigest()[:20]（原始端点，strip 后）
    expect(s1).toBe('rel:' + createHash('sha256').update('a|b|parent').digest('hex').slice(0, 20))
  })

  it('signature normalization: child a→b == parent b→a；child a→b ≠ child b→a；parent 反向是不同提案', () => {
    // _canonical_signature：child → (to, from, 'parent')；related → sorted pair；parent 原样
    expect(canonicalRelationSignature('a', 'b', 'child')).toEqual(canonicalRelationSignature('b', 'a', 'parent'))
    expect(canonicalRelationSignature('a', 'b', 'child')).not.toEqual(canonicalRelationSignature('b', 'a', 'child'))
    expect(canonicalRelationSignature('a', 'b', 'related')).toEqual(canonicalRelationSignature('b', 'a', 'related'))
    expect(canonicalRelationSignature('a', 'b', 'parent')).not.toEqual(canonicalRelationSignature('b', 'a', 'parent'))
    // proposal_id 用原始端点（relation_submission.py L93）：反向 pair 是不同 proposal_id
    expect(proposalSignature('a', 'b', 'parent')).not.toBe(proposalSignature('b', 'a', 'parent'))
  })

  it('endpoint missing → issues contains endpoint marker', () => {
    const r = validateProposal({ source_tag: 'hair', target_tag: 'unknown_tag', relation: 'parent' }, { classify: classifyOf(['hair']) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.some((i) => i.includes('unknown_tag'))).toBe(true)
  })

  it('cooccurrence rejected (requires real statistics source, not LLM)', () => {
    const r = validateProposal({ source_tag: 'a', target_tag: 'b', relation: 'cooccurrence' }, { classify: classifyOf(['a', 'b']) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.some((i) => i.includes('cooccurrence'))).toBe(true)
  })

  it('unsupported relation type → issue', () => {
    const r = validateProposal({ source_tag: 'a', target_tag: 'b', relation: 'sibling' }, { classify: classifyOf(['a', 'b']) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.some((i) => i.includes('relation_type'))).toBe(true)
  })

  it('same submission: duplicate canonical signature and conflicting relation types flagged', () => {
    // child a→b 与 parent b→a 归一化后同签名 → duplicate
    const dup = validateProposal(
      { source_tag: 'a', target_tag: 'b', relation: 'child' },
      { classify: classifyOf(['a', 'b']), pending: [{ source_tag: 'b', target_tag: 'a', relation: 'parent' }] },
    )
    expect(dup.ok).toBe(false)
    // 同端点不同 relation（归一化后）→ conflicting
    const conflict = validateProposal(
      { source_tag: 'a', target_tag: 'b', relation: 'related' },
      { classify: classifyOf(['a', 'b']), pending: [{ source_tag: 'a', target_tag: 'b', relation: 'parent' }] },
    )
    expect(conflict.ok).toBe(false)
  })

  it('valid proposal → ok:true', () => {
    const r = validateProposal(
      { source_tag: 'blue_hair', target_tag: 'hair', relation: 'child' },
      { classify: classifyOf(['blue_hair', 'hair']) },
    )
    expect(r).toEqual({ ok: true })
  })
})

describe('overlay lifecycle (tmp db)', () => {
  const known = ['blue_hair', 'hair', 'long_hair']
  const classify = classifyOf(known)

  it('submit → candidate; list shows it; accept → accepted; list filter by status', () => {
    const r = submitProposal(
      { source_tag: 'blue_hair', target_tag: 'hair', relation: 'child', rationale: 'blue hair is a kind of hair', evidence: ['taxonomy'] },
      { classify },
    )
    if (!('proposal_id' in r)) throw new Error(`submit failed: ${JSON.stringify(r)}`)
    expect(r.status).toBe('candidate')
    // 目录不存在 → mkdir -p（db 已落盘）
    expect(existsSync(join(tmp, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite'))).toBe(true)

    const candidates = listProposals({ status: 'candidate' })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].from_record_id).toBe('blue hair')
    expect(candidates[0].to_record_id).toBe('hair')
    expect(candidates[0].relation_type).toBe('child')

    const acc = decideProposal(r.proposal_id, 'accept')
    expect(acc).toEqual({ proposal_id: r.proposal_id, status: 'accepted' })
    expect(listProposals({ status: 'candidate' })).toHaveLength(0)
    expect(listProposals({ status: 'accepted' })).toHaveLength(1)
    expect(listProposals({ status: 'all' })).toHaveLength(1)
  })

  it('reject → rejected', () => {
    const r = submitProposal(
      { source_tag: 'long_hair', target_tag: 'hair', relation: 'child', rationale: 'taxonomy', evidence: ['e1'] },
      { classify },
    )
    if (!('proposal_id' in r)) throw new Error('submit failed')
    expect(decideProposal(r.proposal_id, 'reject')).toEqual({ proposal_id: r.proposal_id, status: 'rejected' })
    expect(listProposals({ status: 'rejected' })).toHaveLength(1)
  })

  it('unknown proposal_id on decide → throws', () => {
    expect(() => decideProposal('rel:nonexistent00000000', 'accept')).toThrow(/unknown relation proposal/)
  })

  it('duplicate signature → same proposal_id (idempotent upsert)', () => {
    const input = { source_tag: 'blue_hair', target_tag: 'hair', relation: 'child', rationale: 'taxonomy', evidence: ['e1'] }
    const r1 = submitProposal(input, { classify })
    const r2 = submitProposal(input, { classify })
    if (!('proposal_id' in r1) || !('proposal_id' in r2)) throw new Error('submit failed')
    expect(r2.proposal_id).toBe(r1.proposal_id)
    expect(listProposals({ status: 'all' })).toHaveLength(1)
  })

  it('accepted-no-downgrade: resubmit after accept keeps accepted status', () => {
    const input = { source_tag: 'blue_hair', target_tag: 'hair', relation: 'child', rationale: 'taxonomy', evidence: ['e1'] }
    const r1 = submitProposal(input, { classify })
    if (!('proposal_id' in r1)) throw new Error('submit failed')
    decideProposal(r1.proposal_id, 'accept')
    const r2 = submitProposal(input, { classify })
    if (!('proposal_id' in r2)) throw new Error('submit failed')
    // UPSERT：status=CASE WHEN accepted THEN accepted ELSE excluded.status END；proposal_id 相同
    expect(r2.proposal_id).toBe(r1.proposal_id)
    const rows = listProposals({ status: 'all' })
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('accepted')
  })

  it('submit with endpoint missing → ok:false, nothing persisted', () => {
    const r = submitProposal(
      { source_tag: 'blue_hair', target_tag: 'ghost_tag', relation: 'child' },
      { classify },
    )
    expect(r).toEqual({ ok: false, issues: [expect.stringContaining('ghost_tag')] })
    expect(listProposals({ status: 'all' })).toHaveLength(0)
  })

  it('MF-1: underscore endpoints stored normalized (matches overlayAliasHits from_record_id=? query)', () => {
    const r = submitProposal(
      { source_tag: 'blue_hair', target_tag: 'long_hair', relation: 'related', rationale: 'color variant', evidence: ['taxonomy'] },
      { classify },
    )
    if (!('proposal_id' in r)) throw new Error('submit failed')
    decideProposal(r.proposal_id, 'accept')
    const rows = listProposals({ status: 'accepted' })
    expect(rows).toHaveLength(1)
    // 存储面归一化：查询侧 overlayAliasHits 用 normalizeTag(tag) 做 from_record_id=? —— 存储必须同形
    expect(rows[0].from_record_id).toBe('blue hair')
    expect(rows[0].to_record_id).toBe('long hair')
  })
})
