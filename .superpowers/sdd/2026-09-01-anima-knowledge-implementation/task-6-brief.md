### Task 6: G1 relation 鏍￠獙閾?+ overlay 搴擄紙`anima-knowledge/relations.ts`锛?
**Files:**
- Create: `src/pe-framework/anima-knowledge/relations.ts`
- Test: `tests/pe-framework/anima-knowledge/relations.test.ts`

**Interfaces:**
- Consumes: `resolveKnowledgePath`锛坥verlay 璺緞锛夛紱`classifyTag`/`searchCatalog`锛堢鐐瑰瓨鍦ㄦ€э級
- Produces:
  - `export function openOverlayDb(): DatabaseSync`锛堣鍐欐ā寮忥紱鐩綍涓嶅瓨鍦ㄥ垯 mkdir -p锛?  - `export function validateProposal(input: { source_tag: string; target_tag: string; relation: string }, catalog: { classify(tag: string): 'canonical'|'alias'|'fuzzy'|'miss' }): { ok: true } | { ok: false; issues: string[] }`锛堚憼 绔偣 canonical/alias 鈶?cooccurrence 鎷掓敹 鈶?signature 鍘婚噸璇存槑锛?  - `export function proposalSignature(source: string, target: string, relation: string): string`锛堝綊涓€鍖栧悗 `sha256(normalized_src|normalized_tgt|relation)`锛?  - `export function submitProposal(input, opts?: { model?: string }): { proposal_id: string; status: 'candidate' } | { ok: false; issues: string[] }`
  - `export function listProposals(opts?: { status?: 'candidate'|'accepted'|'rejected'|'all' }): ProposalRow[]`
  - `export function decideProposal(proposalId: string, decision: 'accept'|'reject'): { proposal_id: string; status: string }`

- [ ] **Step 1: 澶辫触娴嬭瘯锛坱mp overlay 搴?fixture锛?*

```ts
// tests/pe-framework/anima-knowledge/relations.test.ts
// fixture: mkdtemp + setPresetRoot(tmp)锛坥verlay 钀?<tmp>/temp/...锛熲€斺€?relations.ts 鐨勫簱璺緞 =
//   join(dirname(resolveKnowledgePath({skillDir:'anima-prompt-v1', asset:'tag-catalog.sqlite'})), '..', '..', 'temp', 'anima-prompt-v1')
//   鎵ц鑰呭彲绠€鍖栦负鐙珛 env ANIMA_OVERLAY_PATH 浼樺厛 + tmp 璺緞娉ㄥ叆锛堜笌 setCatalogPath 鍚屾ā寮忥紝瀵煎嚭 setOverlayPath锛?describe('relation validation chain', () => {
  it('proposal_id deterministic (same input 鈫?same sha256 signature)', ...)
  it('signature normalization: a鈫抌 == b鈫抋 reversed pair distinct relation kept separate', ...)  // 鎸?skill 璇箟锛氬悓 relation 鍙嶅悜 = 涓嶅悓鎻愭鎴栧悓涓€锛焤ead relation_submission.py 瀹氱鈥斺€攅xecutor 鍏?read 鍐嶆柇瑷€
  it('endpoint missing 鈫?issues contains 绔偣', ...)
})
describe('overlay lifecycle (tmp db)', () => {
  it('submit 鈫?candidate; list shows it; accept 鈫?accepted; list filter by status', ...)
  it('duplicate signature 鈫?same proposal_id (idempotent upsert)', ...)
})
```
> **鎵ц鑰呭厛 read** `skills/anima-prompt-v1/anima_prompt_v1/catalog/relation_submission.py` + `relation_overlay.py`锛氱鍚嶆瀯鎴愶紙鏄惁鍚?relation锛夈€乸roposal_id 绠楁硶銆乤ccepted UPSERT 璇箟銆佹牎楠岄摼椤哄簭鈥斺€斾互 deob/婧愮爜涓哄噯閫愭潯绉绘锛屾祴璇曟柇瑷€璺熸簮鐮佽涓哄榻愩€?
- [ ] **Step 2: 纭澶辫触 鈫?Step 3: 瀹炵幇 鈫?Step 4: 閫氳繃锛坒ixture tmp 搴擄紝鍙祴閾句笌鐢熷懡鍛ㄦ湡锛屼笉纰扮湡瀹?overlay锛?*

- [ ] **Step 5: 鏋勫缓 + 鍏ㄩ噺 + 鎻愪氦**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/anima-knowledge/relations.ts plugins/prompt-master/tests/pe-framework/anima-knowledge/relations.test.ts
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): G1 relation validation chain + overlay lifecycle"
```

---

