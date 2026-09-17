// probe-v2.mjs — bge-base-en-v1.5 768-dim acceptance probes (ops artifact, not repo code)
const m = await import('../../plugins/prompt-master/dist/src/pe-framework/dialect/anima-catalog.js')

const probes = ['selafuku', 'twintail', 'bunny ears', 'sailor uniform']
for (const q of probes) {
  const hits = await m.searchCatalog(q, { mode: 'auto', limit: 10 })
  console.log(`\n=== ${q} (${hits.length} hits) ===`)
  hits.forEach((h, i) =>
    console.log(`  #${i + 1} [${h.match_type}${h.text_source ? '/' + h.text_source : ''}] ${h.prompt_form ?? h.raw} score=${h.score?.toFixed(4) ?? '-'} usage=${h.usage_count ?? '-'}`),
  )
}

console.log('\n=== 水手服 (CJK rejection — expect []) ===')
console.log(JSON.stringify(await m.searchCatalog('水手服', { mode: 'auto', limit: 10 })))

console.log('\n=== threshold sweep on selafuku ===')
for (const th of [0.5, 0.55, 0.6]) {
  process.env.PM_SEMANTIC_THRESHOLD = String(th)
  // createVectorSearch reads threshold at creation — re-import won't reset the singleton,
  // so use searchCatalog with a fresh import is not possible; instead report hit counts via distinct runs below
}
// threshold sweep requires separate processes; handled outside this script
console.log('(sweep runs as separate processes — see driver)')
