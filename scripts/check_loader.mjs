#!/usr/bin/env node
// loader.js wiring check — failure-domain isolation.
//
// The loader used to `throw` on the first missing SKILL.md, which aborted the
// whole Cordis plugin: a single wrong preset root cost the session three skills
// AND three CLI tools. This script pins the fix in place by driving
// `module.exports.apply()` against a mocked context.
//
// Usage:
//   node scripts/check_loader.mjs [preset-root]
//
// preset-root defaults to this repo. Exits 0 when every assertion passes.
//
// What it asserts:
//   1. good root            -> 3 skills registered + 3 CLI tools registered
//   2. 1-of-3 SKILL.md      -> no throw, 1 skill, CLI tools still register
//   3. skills service gone  -> CLI tools still register
//
// `check_contracts.py` covers request schemas and asset pins, not loader
// wiring; this is the other half.

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const REPO = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'))

// Minimal Cordis context: only the surface loader.apply() actually touches.
function makeCtx({ withSkills = true, withTools = true, withSubprocess = true } = {}) {
  const registeredSkills = []
  const registeredTools = []
  const services = {
    skills: withSkills ? {
      registerProvider(create) {
        registeredSkills.push(create({ signal: new AbortController().signal, invalidate() {} }))
        return () => {}
      },
    } : undefined,
    tools: withTools ? { register(def) { registeredTools.push(def) } } : undefined,
    subprocess: withSubprocess ? {
      spawn() {
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: { stdout: { bytes: 0, chunks: [] }, stderr: { bytes: 0, chunks: [] } },
        }
      },
    } : undefined,
  }
  return {
    registeredSkills,
    registeredTools,
    get(name) { return services[name] },
    effect() {},
    runtime: {},
  }
}

const loader = require(path.join(REPO, 'loader.js'))

async function scenario(label, { presetRoot, ctxOpts }) {
  const ctx = makeCtx(ctxOpts)
  const origLog = console.log
  const origWarn = console.warn
  const lines = []
  console.log = (...a) => { lines.push('LOG  ' + a.join(' ')) }
  console.warn = (...a) => { lines.push('WARN ' + a.join(' ')) }
  let threw = null
  try {
    loader.apply(ctx, { presetRoot })
  } catch (e) {
    threw = e
  } finally {
    console.log = origLog
    console.warn = origWarn
  }

  const listed = []
  for (const p of ctx.registeredSkills) listed.push(...(await p.list({})))

  origLog('\n===== ' + label + ' =====')
  for (const l of lines) origLog(l)
  origLog('THREW         : ' + (threw ? threw.message : 'no'))
  origLog('skills        : ' + (listed.map(s => s.name).join(', ') || '(none)'))
  origLog('tools         : ' + (ctx.registeredTools.map(t => t.name).join(', ') || '(none)'))

  return { threw, listed, tools: ctx.registeredTools }
}

// A partial root: only 1 of 3 SKILL.md files, but with a venv whose three
// console scripts exist, so the tool-registration path is exercised too. The
// stubs fail `--list-actions`, which yields an empty action enum — fine, the
// question is whether the tools get registered at all.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-root-'))
const broken = path.join(tmp, 'broken')
fs.mkdirSync(path.join(broken, 'skills', 'camera-image'), { recursive: true })
fs.copyFileSync(
  path.join(REPO, 'skills', 'camera-image', 'SKILL.md'),
  path.join(broken, 'skills', 'camera-image', 'SKILL.md'),
)
const fakeScripts = path.join(broken, '.venv', 'Scripts')
fs.mkdirSync(fakeScripts, { recursive: true })
for (const name of ['camera-image', 'camera-video', 'camera-multiview']) {
  fs.writeFileSync(path.join(fakeScripts, name + '.exe'), '')
}

const good = await scenario('GOOD root', { presetRoot: REPO, ctxOpts: {} })
const partial = await scenario('PARTIAL root (1 of 3 SKILL.md)', { presetRoot: broken, ctxOpts: {} })
const noSkills = await scenario('GOOD root, skills service absent', { presetRoot: REPO, ctxOpts: { withSkills: false } })

const checks = [
  ['good root registers 3 skills', good.listed.length === 3],
  ['good root registers 3 CLI tools', good.tools.length === 3],
  ['partial root does not throw', partial.threw === null],
  ['partial root keeps the 1 readable skill', partial.listed.length === 1],
  ['partial root still registers 3 CLI tools', partial.tools.length === 3],
  ['missing skills service does not kill CLI tools', noSkills.tools.length === 3],
]

console.log('\n===== ASSERTIONS =====')
let failed = 0
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name)
  if (!ok) failed += 1
}
fs.rmSync(tmp, { recursive: true, force: true })

if (failed > 0) {
  console.log('\n' + failed + ' assertion(s) failed.')
  process.exit(1)
}
console.log('\nall ' + checks.length + ' assertions passed.')
