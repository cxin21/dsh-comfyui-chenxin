// ComfyUI Chenxin preset loader — single plugin that:
//   1. Registers a custom skill PROVIDER that exposes the 3 bundled SKILL.md
//      files to the host's `ctx.skills` registry. Combined with the host's
//      @deepseek-ai/dsh-tool-skill, this gives the model an on-demand skill
//      catalog: summaries in the system prompt, full bodies loaded only when
//      the model calls the `skill` tool (or auto-loaded by `/skill-name`
//      gestures in user input).
//   2. Watches the bundled skills/ directory for changes and calls
//      `control.invalidate()` so catalog updates land on the next request
//      without restarting the session.
//   3. Registers three Host Tools that wrap the bundled console scripts IF a
//      Python venv has been set up at <preset>/.venv/ (graceful skip otherwise).
//
// Virgin contract: each skill's CLI exposes ``--list-actions`` and is the
// single source of truth for its action set. The loader introspects via
// ``spawnSync(<exe> --list-actions)`` — no hard-coded action list lives
// here. To add a new action to a skill, edit only the skill's ``cli.py``;
// the loader picks it up on the next activation (or after a session reload).
//
// Skill installation (one-time, per machine):
//   When a venv is not present, the loader prints setup instructions to the
//   console. The user runs scripts/setup.ps1 (or scripts/setup.sh) to create
//   <preset>/.venv/ and pip install the 3 skill packages + the shared
//   chenxin-runtime. After that, the loader picks up the console scripts on
//   subsequent activations.
//
// Path discovery (priority order):
//   1. apply() `config` argument from agent.cordis.yml `config:` block
//   2. ctx.get('shellEnv').collect(execution).DSH_COMFYUI_PRESET_ROOT
//   3. process.env.DSH_COMFYUI_PRESET_ROOT
//   4. The directory of this loader.js file (__dirname in CJS — always the
//      preset's own directory, so this is the default and the only path that
//      is correct on a fresh machine)
//   5. process.cwd() — only if it contains skills/ AND runtime/
//
// EXPORT CONTRACT: object with apply(ctx, config). Cordis passes `config` as the
// second argument from the composition `config:` field. `inject` declares the
// host services the loader must wait for; without it Cordis might invoke apply
// before `ctx.skills` is ready.
//
// DEPENDENCY POLICY: loader.js uses ONLY built-in Node modules
// (node:fs / node:path / node:process / node:os / node:child_process).
// Presets are loaded by dynamic import() from the preset directory, which has
// no node_modules of its own, so any `require('foo')` here would fail at
// runtime. The SKILL.md frontmatter parser is intentionally inlined below
// for the same reason.

const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')

// Preset base directory: in CJS, __dirname is the directory of this file.
// The loader.js sits in the preset's own directory, so __dirname IS the preset.
const PRESET_DIR = __dirname

// 3 Skills bundled under <preset>/skills/. The order here defines the order
// the loader registers them and the order actions appear in tool descriptions.
const SKILLS = [
  { name: 'camera-image', file: 'skills/camera-image/SKILL.md' },
  { name: 'camera-video', file: 'skills/camera-video/SKILL.md' },
  { name: 'camera-multiview', file: 'skills/camera-multiview/SKILL.md' },
]

// Console scripts that exist after `pip install -e .` on each skill. The
// `actions` list is filled in at registration time via `introspectActions` —
// no hard-coded action list here. The `blurb` is the skill-specific tool
// description. Every skill now takes ONE flat `--request <file.json>` object
// (no envelope/config split); camera-* add `--stage`, `--output-dir`.
const CONSOLE_SCRIPTS = [
  {
    name: 'camera_image',
    script: 'camera-image',
    blurb: 'Execute the bundled Anima camera workflow on ComfyUI. Load the camera-image skill first. Two stages: `t2i` and `i2i` (the latter requires `reference_image`). Asset is pinned to `camera-anima.json`; the user supplies a flat JSON request that writes the request-only widget values. `describe --stage <t2i|i2i> --summary` returns the request contract, preset table, and a canonical example. `run --stage <t2i|i2i> --request <req.json> [--output-dir <d>] [--yes]` validates, prints the group plan (interactive unless `--yes`), uploads, strips, enqueues, waits, and downloads the produced PNG plus `summary.json`. `--output-dir` defaults to <preset>/temp/camera-image/ when omitted. `assets verify --stage <t2i|i2i>` re-checks the bundled asset\'s sha256 + structural fingerprint. Failures are fail-closed.',
  },
  {
    name: 'camera_video',
    script: 'camera-video',
    blurb: 'Execute the fixed MiniMax-H3 video workflow through comfyui-mcp. Load the camera-video skill first. Stages: t2v, i2v, multi-i2v. `describe --stage <s> --summary` returns the request contract incl. reference-image count; `run --stage <s> --request <req.json> [--output-dir <d>]` validates and executes in one call (`--output-dir` defaults to <preset>/temp/camera-video/).',
  },
  {
    name: 'camera_multiview',
    script: 'camera-multiview',
    blurb: 'Execute the fixed Flux2-Klein character multiview workflow through comfyui-mcp. Load the camera-multiview skill first. No prompt input — the request is just {full_body_image, face_image}. `describe --summary` returns the request contract; `run --request <req.json> [--output-dir <d>]` validates and executes in one call (`--output-dir` defaults to <preset>/temp/camera-multiview/).',
  },
]

// Provider identity. `rank` mirrors @deepseek-ai/dsh-skill's BUNDLED_SKILL_RANK.
//
// Rank only breaks ties *within one layer*. This provider is registered from
// the agent preset's standing composition, so its skills land in the preset's
// layer; dsh-skill-filesystem's project-dsh / user-dsh roots land in the
// global layer. The skill registry merges global first and lets the nearest
// layer win a duplicate name outright (see SkillRegistry's class doc in
// @deepseek-ai/dsh-skill: "the nearest layer's entry wins a duplicate name
// outright, and the rank order decides duplicates only within one layer"), so
// inside a preset session these bundled skills take precedence over same-name
// copies in `<project>/.dsh/skills` or `<dshHome>/skills` regardless of rank.
// PROVIDER_RANK therefore only orders us against other preset-layer providers.
const PROVIDER_NAME = 'comfyui-chenxin-bundled'
const PROVIDER_RANK = 600

// ── Path resolution ──────────────────────────────────────────────────────

function resolvePresetRoot(ctx, config) {
  // 1. config override
  let presetRoot = config && config.presetRoot

  // 2. shellEnv
  if (!presetRoot) {
    try {
      const shellEnv = ctx.get('shellEnv')
      if (shellEnv && typeof shellEnv.collect === 'function') {
        const exec = ctx.get('tools') && ctx.runtime && ctx.runtime.currentExecution
        if (exec) {
          const env = shellEnv.collect(exec)
          if (env && env.DSH_COMFYUI_PRESET_ROOT) presetRoot = env.DSH_COMFYUI_PRESET_ROOT
        }
      }
    } catch (_) {}
  }

  // 3. process.env
  if (!presetRoot && process.env.DSH_COMFYUI_PRESET_ROOT) {
    presetRoot = process.env.DSH_COMFYUI_PRESET_ROOT
  }

  // 4. __dirname (preset's own directory — always correct on fresh install)
  if (!presetRoot) presetRoot = PRESET_DIR

  // 5. process.cwd() — only if it has the right structure
  if (!presetRoot || presetRoot === PRESET_DIR) {
    try {
      const cwd = process.cwd()
      if (cwd !== PRESET_DIR && fs.existsSync(path.join(cwd, 'skills')) && fs.existsSync(path.join(cwd, 'runtime'))) {
        presetRoot = cwd
      }
    } catch (_) {}
  }

  return presetRoot
}

// Inspect the preset root's expected structure without failing.
//
// This used to throw on the first missing SKILL.md. Because apply() called it
// before registering anything, one wrong preset root took the whole plugin
// down — the skill provider was never registered either, so the session lost
// three skills *and* three tools over a single bad path. Callers now get a
// report and decide what to do with it.
function inspectPresetRoot(presetRoot) {
  const present = []
  const missing = []
  for (const skill of SKILLS) {
    const skillMd = path.join(presetRoot, ...skill.file.split('/'))
    let exists = false
    try { exists = fs.existsSync(skillMd) } catch (_) { exists = false }
    if (exists) present.push({ def: skill, skillMd })
    else missing.push({ def: skill, skillMd })
  }
  return { present, missing }
}

function errorText(err) {
  return err && err.message ? err.message : String(err)
}

// Resolve the Python venv Scripts directory. Returns null if not set up.
function resolveVenvScripts(presetRoot) {
  const candidates = ['.venv', 'venv', '.virtualenv', 'env']
  for (const venvDir of candidates) {
    const scriptsDir = path.join(presetRoot, venvDir, 'Scripts')
    try {
      if (fs.existsSync(scriptsDir) && fs.statSync(scriptsDir).isDirectory()) {
        const allPresent = CONSOLE_SCRIPTS.every(def => {
          const exe = path.join(scriptsDir, def.script + (process.platform === 'win32' ? '.exe' : ''))
          try { return fs.existsSync(exe) } catch (_) { return false }
        })
        if (allPresent) return scriptsDir
      }
    } catch (_) {}
  }
  return null
}

function printSetupHint(presetRoot) {
  const isWin = process.platform === 'win32'
  const setupScript = path.join(presetRoot, 'scripts', isWin ? 'setup.ps1' : 'setup.sh')
  console.log('[comfyui-chenxin] .venv not found — CLI wrapper tools will be skipped.')
  console.log('[comfyui-chenxin] To enable them, run setup once:')
  console.log('  ' + (isWin ? 'powershell -ExecutionPolicy Bypass -File ' : 'bash ') + setupScript)
  console.log('[comfyui-chenxin] Then restart the DSH session.')
}

// ── SKILL.md frontmatter parsing ─────────────────────────────────────────
//
// Minimal YAML frontmatter parser scoped to the dsh-skill contract. Handles:
//   - name, description, whenToUse, metadata, disable-model-invocation,
//     user-invocable, plus arbitrary single-line key: value pairs.
//   - Single-line plain scalars: `key: value`
//   - Quoted scalars: `key: "..."` or `key: '...'` (single-line only)
//   - Block literals (`|`) and folded (`>`) multi-line scalars
// Reject anything that looks like a list (`- foo`) or nested object (`{ ... }`)
// — those aren't part of the SKILL.md contract and indicate a malformed file.

function parseScalarValue(value) {
  // Strip surrounding single or double quotes (single-line only).
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function parseSimpleYaml(text) {
  const lines = text.split(/\r?\n/)
  const result = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    // Disallow list items and flow objects at the top level — they signal
    // a non-skill frontmatter and should fail loudly upstream.
    if (/^\s*-\s/.test(line) || /^\s*[\[{]/.test(line)) {
      throw new Error('top-level list or flow mapping not supported in SKILL.md frontmatter')
    }
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/)
    if (!m) { i++; continue }
    const key = m[1]
    let value = m[2]
    i++

    if (value === '|' || value === '>') {
      // Block scalar — collect indented (or blank) continuation lines until
      // we hit a non-indented, non-blank line or end of input.
      const joiner = value === '|' ? '\n' : ' '
      const collected = []
      while (i < lines.length) {
        const next = lines[i]
        if (next === '' || next.trim() === '') {
          // A blank line inside a block scalar is preserved (|'s) or treated
          // as a paragraph break (>'s). For our simple parser, treat both
          // the same: a single blank line, no dedent.
          collected.push('')
          i++
          continue
        }
        if (/^\s/.test(next)) {
          // Indented continuation: strip one level of indent (2 spaces is the
          // convention for our SKILL.md files; we accept any leading whitespace
          // and trim the first run of spaces).
          collected.push(next.replace(/^ {1,4}/, ''))
          i++
          continue
        }
        // Dedent: stop the block.
        break
      }
      // Drop trailing blank lines we may have over-collected, then join.
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
      result[key] = collected.join(joiner).trim()
    } else {
      result[key] = parseScalarValue(value)
    }
  }
  return result
}

function parseSkillFrontmatter(raw) {
  // Open: a line that is exactly `---` (allow optional trailing CR).
  const openMatch = raw.match(/^---[ \t]*\r?\n/)
  if (!openMatch) return undefined
  const bodyStart = openMatch[0].length

  // Close: a line that is exactly `---` somewhere after bodyStart. The
  // closing fence must be at column 0 (no leading whitespace).
  const rest = raw.slice(bodyStart)
  let closeIdx = -1
  const re = /\r?\n---[ \t]*(?:\r?\n|$)/
  const m = rest.match(re)
  if (!m) return undefined
  closeIdx = m.index
  const yamlText = rest.slice(0, closeIdx)
  const body = rest.slice(closeIdx + m[0].length).replace(/^\r?\n/, '').trim()

  let parsed
  try {
    parsed = parseSimpleYaml(yamlText)
  } catch (_) {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  if (typeof parsed.name !== 'string' || parsed.name.length === 0) return undefined
  if (typeof parsed.description !== 'string' || parsed.description.length === 0) return undefined

  return {
    name: parsed.name,
    description: parsed.description.replace(/\s+/g, ' ').trim(),
    whenToUse: typeof parsed.whenToUse === 'string' ? parsed.whenToUse : undefined,
    body,
  }
}

function readParsedSkill(skillMdPath) {
  let raw
  try {
    raw = fs.readFileSync(skillMdPath, 'utf8')
  } catch (_) {
    return undefined
  }
  return parseSkillFrontmatter(raw)
}

// ── Custom skill provider registration ──────────────────────────────────

function registerBundledSkillProvider(ctx, presetRoot, skillDefs) {
  const skills = ctx.get('skills')
  if (!skills) throw new Error('skills service unavailable')

  // Resolve absolute paths once. The provider reads files on every list() /
  // get() call so edits to SKILL.md land without restarting the session.
  const files = skillDefs.map((def) => ({
    def,
    skillMdPath: path.join(presetRoot, ...def.file.split('/')),
    directory: null,
  }))
  for (const f of files) f.directory = path.dirname(f.skillMdPath)

  function toCandidate(f, parsed) {
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled',
      provider: PROVIDER_NAME,
      rank: PROVIDER_RANK,
      locator: { path: f.skillMdPath, directory: f.directory },
      resourceBase: { kind: 'directory', path: f.directory },
    }
  }

  const provider = {
    name: PROVIDER_NAME,
    async list(_options) {
      const out = []
      for (const f of files) {
        const parsed = readParsedSkill(f.skillMdPath)
        if (!parsed) continue
        out.push(toCandidate(f, parsed))
      }
      return out
    },
    async get(candidate, options) {
      options?.signal?.throwIfAborted?.()
      const match = files.find((f) => f.skillMdPath === candidate.locator?.path
        || f.def.name === candidate.name)
      if (!match) return undefined
      const parsed = readParsedSkill(match.skillMdPath)
      if (!parsed) return undefined
      return {
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
        invocation: candidate.invocation,
        source: candidate.source,
        provider: candidate.provider,
        resourceBase: candidate.resourceBase,
        path: match.skillMdPath,
        content: parsed.body,
      }
    },
  }

  // Set up file watching inside the provider factory so `control.invalidate()`
  // scopes to this exact registration. We watch the parent directory rather
  // than each individual file: on most platforms fs.watch stops firing after
  // a delete+recreate of the watched inode, but a directory watcher survives
  // file replacement, which is the typical SKILL.md edit pattern (write to
  // temp, rename over).
  const skillsDir = path.join(presetRoot, 'skills')
  // Pre-compute the basenames we care about so we can filter directory events.
  const watched = new Set(skillDefs.map((def) => path.basename(def.file)))

  let watcher = null
  let invalidateTimer = null

  const unregister = skills.registerProvider((control) => {
    const onSignalAbort = () => {
      if (watcher) {
        try { watcher.close() } catch (_) {}
        watcher = null
      }
      if (invalidateTimer) {
        clearTimeout(invalidateTimer)
        invalidateTimer = null
      }
    }
    if (control.signal.aborted) {
      onSignalAbort()
    } else {
      control.signal.addEventListener('abort', onSignalAbort, { once: true })
    }

    try {
      watcher = fs.watch(skillsDir, { persistent: false }, (_eventType, filename) => {
        if (!filename) return
        const base = path.basename(filename)
        if (!watched.has(base)) return
        // Coalesce bursts (editors often emit several events per save) into
        // one invalidate. 50ms is well below human-noticeable latency and
        // well above the typical fs event cluster duration.
        if (invalidateTimer) clearTimeout(invalidateTimer)
        invalidateTimer = setTimeout(() => {
          invalidateTimer = null
          try { control.invalidate() } catch (_) {}
        }, 50)
      })
      watcher.on('error', (err) => {
        console.warn('[comfyui-chenxin] skills watcher error: ' + (err && err.message ? err.message : String(err)))
      })
    } catch (err) {
      console.warn('[comfyui-chenxin] failed to watch ' + skillsDir + ': ' + (err && err.message ? err.message : String(err)))
    }

    return provider
  })

  ctx.effect(function* () {
    yield unregister
  }, 'comfyui-chenxin skill provider')
  return files.length
}

// ── P1 envelope decoding ─────────────────────────────────────────────────

function decodeChunks(c) {
  if (!c || !c.chunks || !c.chunks.length) return ''
  const total = c.bytes || 0
  const buf = new Uint8Array(total)
  let off = 0
  for (const chunk of c.chunks) {
    buf.set(chunk, off)
    off += chunk.length
  }
  return new TextDecoder('utf-8').decode(buf)
}

// ── Action introspection ──────────────────────────────────────────────────

// Synchronous spawn of `<exe> --list-actions` to read the canonical action
// list straight from the CLI itself. Returns [] on any failure (vintage
// binary that doesn't support the flag, missing venv, etc.) — the loader
// falls back to registering an empty actions list and the model will see
// the actual actions when it invokes the tool.
function introspectActions(scriptExe, graceMs = 5000) {
  try {
    const r = cp.spawnSync(scriptExe, ['--list-actions'], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: graceMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (r.error) return []
    if (r.status !== 0) return []
    const text = (r.stdout || '').toString('utf-8')
    return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  } catch (_) {
    return []
  }
}

// ── CLI tool registration ────────────────────────────────────────────────

function registerCliTools(ctx, presetRoot, venvScripts) {
  const sub = ctx.get('subprocess')
  const tools = ctx.get('tools')
  if (!sub || !tools) {
    console.warn('[comfyui-chenxin] CLI tools skipped: ' +
      (!sub ? 'subprocess service unavailable' : 'tools registry unavailable'))
    return 0
  }

  let registered = 0
  for (const def of CONSOLE_SCRIPTS) {
    const toolName = def.name
    const exeName = def.script + (process.platform === 'win32' ? '.exe' : '')
    const scriptExe = path.join(venvScripts, exeName)
    // Introspect the canonical action list straight from the CLI itself.
    // No hard-coded list lives here — adding a subcommand to a skill is a
    // one-line edit in that skill's cli.py, and the loader picks it up.
    const actions = introspectActions(scriptExe)
    if (actions.length === 0) {
      console.warn('[comfyui-chenxin] ' + def.script + ' reported no actions; tool may be unusable. ' +
                   'Re-run scripts/setup.ps1 to refresh the venv.')
    }
    tools.register({
      name: toolName,
      description: def.blurb + ' Valid actions: ' + actions.join(', ') + '. Every call appends --json and returns { exit_code, envelope, stderr } parsed from the P1 JSON Envelope on stdout.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: actions, description: 'The console-script subcommand to invoke.' },
          args: { type: 'array', description: 'Additional CLI arguments appended after the action (each a string), e.g. ["--summary"], ["--config", "c.json"], ["--output-dir", "out/"].', items: { type: 'string' } },
          stage: { type: 'string', description: 'Optional stage token forwarded as --stage (camera-* describe/run).' },
          request_file: { type: 'string', description: 'Optional JSON request file forwarded as --request (camera-* run).' },
          env: { type: 'object', description: 'Extra environment variables merged into the spawn env.' }
        },
        required: ['action']
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            exit_code: { type: 'number' },
            envelope: { type: 'object' },
            stderr: { type: 'string' }
          }
        },
        render(_a, v) { return [{ type: 'text', text: JSON.stringify(v, null, 1) }] }
      },
      async execute(args) {
        const extra = Array.isArray(args.args) ? args.args.slice() : []
        // Nested actions arrive as "parent.child" (from --list-actions);
        // split them back into real argv segments, e.g. assets.verify →
        // ["assets", "verify"], so argparse sees the nested subcommand.
        const actionArgv = String(args.action).split('.').filter(Boolean)
        const argv = [scriptExe, ...actionArgv]
        if (args.stage) argv.push('--stage', args.stage)
        if (args.request_file) argv.push('--request', args.request_file)
        for (const a of extra) argv.push(String(a))
        argv.push('--json')
        const spawnEnv = { PYTHONIOENCODING: 'utf-8' }
        if (args.env && typeof args.env === 'object') {
          for (const k of Object.keys(args.env)) spawnEnv[k] = args.env[k]
        }
        let handle
        try {
          handle = sub.spawn({
            argv: argv,
            cwd: presetRoot,
            stdio: { stdin: 'ignore', stdout: 'collect', stderr: 'collect' },
            graceMs: 120000,
            env: spawnEnv
          })
        } catch (e) {
          return { exit_code: -1, envelope: null, stderr: 'spawn failed: ' + e.message }
        }
        let outcome
        try {
          outcome = await handle.done
        } catch (e) {
          return { exit_code: -1, envelope: null, stderr: 'await done failed: ' + e.message }
        }
        const stdoutText = decodeChunks(handle.collected.stdout)
        const stderrText = decodeChunks(handle.collected.stderr)
        let envelope = null
        try { envelope = JSON.parse(stdoutText) } catch (_) {}
        return { exit_code: outcome.exitCode, envelope: envelope, stderr: stderrText }
      }
    })
    registered += 1
  }
  return registered
}

// ── Plugin entry ─────────────────────────────────────────────────────────

module.exports = {
  name: 'comfyui-chenxin-loader',
  // Hard dependencies: skills (for registering the bundled provider), tools
  // and subprocess (for the 3 CLI wrapper tools when a venv is present).
  inject: ['skills', 'tools', 'subprocess'],
  apply(ctx, config) {
    const presetRoot = resolvePresetRoot(ctx, config || {})
    console.log('[comfyui-chenxin] presetRoot=' + presetRoot)

    // Failure domains are kept separate on purpose: a bad SKILL.md must not
    // cost the session its CLI tools, and a missing venv must not cost it the
    // skills. Each stage reports and degrades on its own.
    const { present, missing } = inspectPresetRoot(presetRoot)
    if (missing.length > 0) {
      for (const m of missing) {
        console.warn('[comfyui-chenxin] SKILL.md not found at ' + m.skillMd + ' — skill "' + m.def.name + '" will not load.')
      }
      if (present.length === 0) {
        console.warn('[comfyui-chenxin] no bundled skills found under ' + presetRoot +
          '. The preset directory must contain skills/ and runtime/ subdirectories; ' +
          'reinstall the preset from the source distribution.')
      } else {
        console.warn('[comfyui-chenxin] loading ' + present.length + ' of ' + SKILLS.length +
          ' bundled skills; fix the paths above to restore the rest.')
      }
    }

    if (present.length > 0) {
      try {
        const skillCount = registerBundledSkillProvider(ctx, presetRoot, present.map(p => p.def))
        console.log('[comfyui-chenxin] registered ' + skillCount + ' bundled skills via ctx.skills provider (with file watcher)')
      } catch (e) {
        // A provider registration failure (duplicate name, disposed scope) is
        // reported rather than thrown so the CLI tools below still get a chance.
        console.warn('[comfyui-chenxin] skill provider registration failed: ' + errorText(e))
      }
    }

    const venvScripts = resolveVenvScripts(presetRoot)
    if (venvScripts) {
      try {
        const toolCount = registerCliTools(ctx, presetRoot, venvScripts)
        console.log('[comfyui-chenxin] venvScripts=' + venvScripts)
        console.log('[comfyui-chenxin] registered ' + toolCount + ' CLI tools')
      } catch (e) {
        console.warn('[comfyui-chenxin] CLI tool registration failed: ' + errorText(e))
      }
    } else {
      printSetupHint(presetRoot)
    }
  },
}
