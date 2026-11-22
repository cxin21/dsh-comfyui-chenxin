# ComfyUI Chenxin preset setup — Windows PowerShell
#
# One-time setup per machine (or after pulling a fresh copy of the preset):
#   1. Locate or create the Python venv at <preset>/.venv
#   2. Install third-party PyPI deps (tokenizers) via pip in the venv
#   3. Install the 6 local packages via scripts/install_local.py
#      (bypasses pip's build-isolation path, which has been observed to
#      fail on some Windows configurations; installs directly via .pth +
#      distlib launchers)
#   4. Build plugins/prompt-forge (dist/ is gitignored, so a fresh clone
#      has no compiled entry point until this runs)
#   5. Self-check every CLI via --list-actions
#
# Camera execution additionally requires Node.js (npx) on PATH because
# every run goes through the comfyui-mcp server.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
#
# Re-running is safe and idempotent: the venv is reused, every step is
# a deterministic re-write to match the current source tree, and broken
# half-installations (missing exe, stale finders, ~ leftovers) are cleaned
# up automatically. After setup finishes, restart the DSH session so the
# loader picks up the 3 CLI wrapper Host Tools.

$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$PresetDir  = Split-Path -Parent $ScriptDir
$VenvDir    = Join-Path $PresetDir '.venv'
$PythonExe  = Join-Path $VenvDir 'Scripts\python.exe'
$Installer  = Join-Path $ScriptDir 'install_local.py'

Write-Host "[comfyui-chenxin] preset directory: $PresetDir"

# ── 1. Locate a Python interpreter ─────────────────────────────────────────

$Python = $null
if (Test-Path $PythonExe) {
    $Python = $PythonExe
} else {
    foreach ($cand in @('python', 'python3', 'py')) {
        $cmd = Get-Command $cand -ErrorAction SilentlyContinue
        if ($cmd) { $Python = $cmd.Source; break }
    }
}
if (-not $Python) {
    Write-Error "No Python interpreter found on PATH. Install Python 3.10+ from https://www.python.org/ and re-run."
    exit 1
}
Write-Host "[comfyui-chenxin] using Python: $Python"

# ── 2. Create the venv if missing ─────────────────────────────────────────

if (-not (Test-Path $PythonExe)) {
    Write-Host "[comfyui-chenxin] creating venv at $VenvDir"
    & $Python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { Write-Error "venv creation failed"; exit 1 }
} else {
    Write-Host "[comfyui-chenxin] reusing existing venv"
}

# ── 3. Install third-party PyPI dependencies ─────────────────────────────
#
# Pinned by requirements.lock at the preset root. The six local packages do
# not upper-bound their transitive deps, so without a lock two machines set up
# a week apart drift onto different httpx / huggingface_hub / tokenizers builds
# and the workflow assets stop matching. The lock is the contract.
#
# If the lock is missing (old checkout), fall back to the single hard pin this
# script used before, and say so loudly — a silent fallback is how the drift
# comes back.

$LockFile = Join-Path $PresetDir 'requirements.lock'
if (Test-Path $LockFile) {
    Write-Host "[comfyui-chenxin] installing pinned deps from requirements.lock"
    & $PythonExe -m pip install -r $LockFile --quiet
    if ($LASTEXITCODE -ne 0) {
        Write-Error "[comfyui-chenxin] pip install -r requirements.lock failed (exit $LASTEXITCODE)"
        exit 1
    }
} else {
    Write-Warning "[comfyui-chenxin] requirements.lock not found at $LockFile - falling back to unpinned deps."
    Write-Warning "[comfyui-chenxin] Dependency versions will NOT be reproducible. Restore the lock file."
    $ThirdParty = @('tokenizers==0.22.2')
    foreach ($pkg in $ThirdParty) {
        $name, $spec = $pkg -split '==', 2
        $installed = $null
        try { $installed = & $PythonExe -m pip show $name 2>$null } catch {}
        if ($installed -and $installed -match "Version:\s*$([regex]::Escape($spec))") {
            Write-Host "[comfyui-chenxin] $pkg already satisfied"
        } else {
            Write-Host "[comfyui-chenxin] pip install $pkg"
            & $PythonExe -m pip install $pkg --quiet
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "[comfyui-chenxin] pip install $pkg failed (continuing; install_local will surface any import errors)"
            }
        }
    }
}

# ── 4. Install the 6 local packages ─────────────────────────────────────

if (-not (Test-Path $Installer)) {
    Write-Error "missing installer: $Installer"
    exit 1
}
Write-Host "[comfyui-chenxin] running install_local.py"
& $PythonExe $Installer --preset $PresetDir
if ($LASTEXITCODE -ne 0) { Write-Error "install_local.py failed"; exit $LASTEXITCODE }

# ── 4b. Render cordis.patch.yml for THIS checkout ────────────────────────
#
# cordis.patch.yml is a generated deployment artifact. DSH imports a
# preset's nested plugin entries from a HOST-side base, where only absolute
# file:/// URLs resolve reliably (./ is not anchored in a plain-object
# config; @local/<pkg> only exists in the profile's node_modules). The
# paths are therefore specific to each machine — render_patch.py derives
# them from agent.cordis.yml (the portable source) and the current checkout.
# See KNOWN-ISSUES #26/#28/#29.
$Renderer = Join-Path $PresetDir 'scripts/render_patch.py'
Write-Host "[comfyui-chenxin] rendering cordis.patch.yml for $PresetDir"
& $PythonExe $Renderer --checkout $PresetDir
if ($LASTEXITCODE -ne 0) { Write-Error "render_patch.py failed"; exit $LASTEXITCODE }

# ── 5. Build the prompt-forge plugin ─────────────────────────────────────
#
# cordis.patch.yml mounts the plugin from
# plugins/prompt-forge/dist/src/plugin/index.js, and dist/ is gitignored
# build output. On a fresh clone that file does not exist, dsh-app-boot
# swallows the failure into its skippedBundles list without printing
# anything, and the preset comes up with no prompt-forge tools at all —
# which reads as "the plugin is broken" rather than "it was never built".
# Build it here so setup produces a working install in one pass.

$PluginDir = Join-Path $PresetDir 'plugins/prompt-forge'
$PluginEntry = Join-Path $PluginDir 'dist/src/plugin/index.js'
if (-not (Test-Path $PluginEntry)) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Warning "npm not found on PATH — cannot build plugins/prompt-forge."
        Write-Warning "The preset will load without prompt-forge tools. Install Node.js, then run:"
        Write-Warning "  cd plugins/prompt-forge; npm ci; npm run build"
    } else {
        Write-Host "[comfyui-chenxin] building prompt-forge plugin (dist/ is not committed)"
        Push-Location $PluginDir
        try {
            if (Test-Path (Join-Path $PluginDir 'package-lock.json')) {
                & npm ci --silent
            } else {
                & npm install --silent
            }
            if ($LASTEXITCODE -ne 0) { Write-Warning "npm install failed (exit $LASTEXITCODE)" }
            & npm run build --silent
            if ($LASTEXITCODE -ne 0) { Write-Warning "npm run build failed (exit $LASTEXITCODE)" }
        } finally {
            Pop-Location
        }
        if (-not (Test-Path $PluginEntry)) {
            Write-Warning "prompt-forge build did not produce $PluginEntry — the preset will load without its tools."
        }
    }
} else {
    Write-Host "[comfyui-chenxin] prompt-forge dist already present, skipping build"
}

# ── 6. Self-check every CLI ──────────────────────────────────────────────

$Scripts = Join-Path $VenvDir 'Scripts'
$Required = @('camera-image', 'camera-video', 'camera-multiview')
$Failed = @()
foreach ($script in $Required) {
    $exe = Join-Path $Scripts "$script.exe"
    if (-not (Test-Path $exe)) { $Failed += "$script.exe missing"; continue }
    $actions = & $exe --list-actions 2>$null
    if ($LASTEXITCODE -ne 0) {
        $Failed += "$script --list-actions failed (exit $LASTEXITCODE)"
        continue
    }
    Write-Host "[comfyui-chenxin] $script actions: $($actions -join ', ')"
}

if ($Failed.Count -gt 0) {
    Write-Host ""
    Write-Error "[comfyui-chenxin] SELF-CHECK FAILED:"
    foreach ($f in $Failed) { Write-Host "  - $f" }
    exit 1
}

# ── 7. Node.js (camera execution needs npx) ──────────────────────────────

$npx = Get-Command npx -ErrorAction SilentlyContinue
if (-not $npx) {
    Write-Warning "[comfyui-chenxin] npx not found on PATH. camera-image / camera-video / camera-multiview execution requires Node.js."
}

Write-Host ""
Write-Host "[comfyui-chenxin] setup complete."
Write-Host "[comfyui-chenxin] restart DSH (or start a new session) to load the CLI wrapper Host Tools."
