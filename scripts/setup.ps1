# ComfyUI Chenxin preset setup — Windows PowerShell
#
# One-time setup per machine (or after pulling a fresh copy of the preset):
#   1. Locate or create the Python venv at <preset>/.venv
#   2. Install third-party PyPI deps (tokenizers) via pip in the venv
#   3. Install the 6 local packages via scripts/install_local.py
#      (bypasses pip's build-isolation path, which has been observed to
#      fail on some Windows configurations; installs directly via .pth +
#      distlib launchers)
#   4. Self-check every CLI via --list-actions
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

# ── 4. Install the 6 local packages ─────────────────────────────────────

if (-not (Test-Path $Installer)) {
    Write-Error "missing installer: $Installer"
    exit 1
}
Write-Host "[comfyui-chenxin] running install_local.py"
& $PythonExe $Installer --preset $PresetDir
if ($LASTEXITCODE -ne 0) { Write-Error "install_local.py failed"; exit $LASTEXITCODE }

# ── 5. Self-check every CLI ──────────────────────────────────────────────

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

# ── 6. Node.js (camera execution needs npx) ──────────────────────────────

$npx = Get-Command npx -ErrorAction SilentlyContinue
if (-not $npx) {
    Write-Warning "[comfyui-chenxin] npx not found on PATH. camera-image / camera-video / camera-multiview execution requires Node.js."
}

Write-Host ""
Write-Host "[comfyui-chenxin] setup complete."
Write-Host "[comfyui-chenxin] restart DSH (or start a new session) to load the CLI wrapper Host Tools."
