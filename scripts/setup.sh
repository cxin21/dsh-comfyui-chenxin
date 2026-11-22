#!/usr/bin/env bash
# ComfyUI Chenxin preset setup — POSIX shell
# One-time setup per machine. See scripts/setup.ps1 for the Windows version.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRESET_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$PRESET_DIR/.venv"

echo "[comfyui-chenxin] preset directory: $PRESET_DIR"

# 1. Locate a Python interpreter
PYTHON=""
if [ -x "$VENV_DIR/bin/python" ]; then
  PYTHON="$VENV_DIR/bin/python"
else
  for cand in python3 python; do
    if command -v "$cand" >/dev/null 2>&1; then PYTHON="$(command -v "$cand")"; break; fi
  done
fi
if [ -z "$PYTHON" ]; then
  echo "ERROR: No Python interpreter found on PATH. Install Python 3.10+ and re-run." >&2
  exit 1
fi
echo "[comfyui-chenxin] using Python: $PYTHON"

# 2. Create venv if missing
if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "[comfyui-chenxin] creating venv at $VENV_DIR"
  "$PYTHON" -m venv "$VENV_DIR"
fi
PYTHON="$VENV_DIR/bin/python"

# 3. Install pinned third-party deps (see requirements.lock header for why)
LOCK_FILE="$PRESET_DIR/requirements.lock"
if [ -f "$LOCK_FILE" ]; then
  echo "[comfyui-chenxin] installing pinned deps from requirements.lock"
  "$PYTHON" -m pip install -r "$LOCK_FILE" --quiet
else
  echo "WARNING: requirements.lock not found at $LOCK_FILE — dependency versions will not be reproducible." >&2
  echo "WARNING: falling back to unpinned tokenizers; restore the lock file." >&2
  "$PYTHON" -m pip install 'tokenizers==0.22.2' --quiet
fi

# 4. Install packages (local-path dependencies require source order)
for rel in \
  runtime/comfyui_http \
  runtime/comfyui_mcp \
  runtime/chenxin_runtime \
  skills/camera-image \
  skills/camera-video \
  skills/camera-multiview
do
  full="$PRESET_DIR/$rel"
  if [ -f "$full/pyproject.toml" ]; then
    echo "[comfyui-chenxin] pip install -e $rel"
    "$PYTHON" -m pip install -e "$full" --quiet
  else
    echo "[comfyui-chenxin] missing $full/pyproject.toml — skipping" >&2
  fi
done

# 5. Build the prompt-forge plugin
#
# cordis.patch.yml mounts the plugin from
# plugins/prompt-forge/dist/src/plugin/index.js, and dist/ is gitignored build
# output. On a fresh clone that file does not exist, dsh-app-boot swallows the
# failure into its skippedBundles list without printing anything, and the
# preset comes up with no prompt-forge tools at all.
PLUGIN_DIR="$PRESET_DIR/plugins/prompt-forge"
PLUGIN_ENTRY="$PLUGIN_DIR/dist/src/plugin/index.js"
if [ ! -f "$PLUGIN_ENTRY" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "WARNING: npm not found on PATH — cannot build plugins/prompt-forge." >&2
    echo "WARNING: the preset will load without prompt-forge tools. Install Node.js, then run:" >&2
    echo "WARNING:   cd plugins/prompt-forge && npm ci && npm run build" >&2
  else
    echo "[comfyui-chenxin] building prompt-forge plugin (dist/ is not committed)"
    (
      cd "$PLUGIN_DIR"
      if [ -f package-lock.json ]; then
        npm ci --silent || echo "WARNING: npm ci failed" >&2
      else
        npm install --silent || echo "WARNING: npm install failed" >&2
      fi
      npm run build --silent || echo "WARNING: npm run build failed" >&2
    )
    if [ ! -f "$PLUGIN_ENTRY" ]; then
      echo "WARNING: prompt-forge build did not produce $PLUGIN_ENTRY — the preset will load without its tools." >&2
    fi
  fi
else
  echo "[comfyui-chenxin] prompt-forge dist already present, skipping build"
fi

# 5b. Render cordis.patch.yml for THIS checkout
# cordis.patch.yml is a generated deployment artifact. DSH imports a preset's
# nested plugin entries from a HOST-side base, where only absolute file:///
# URLs resolve reliably (./ is not anchored in a plain-object config; @local/
# <pkg> only exists in the profile's node_modules). The paths are therefore
# machine-specific — render_patch.py derives them from agent.cordis.yml (the
# portable source) and the current checkout. See KNOWN-ISSUES #26/#28/#29.
if [ -f "$PRESET_DIR/scripts/render_patch.py" ]; then
  echo "[comfyui-chenxin] rendering cordis.patch.yml for $PRESET_DIR"
  "$PYTHON" "$PRESET_DIR/scripts/render_patch.py" --checkout "$PRESET_DIR" || {
    echo "ERROR: render_patch.py failed" >&2
    exit 1
  }
fi

# 6. Self-check: every CLI must report its actions
for script in camera-image camera-video camera-multiview; do
  actions="$("$VENV_DIR/bin/$script" --list-actions)"
  echo "[comfyui-chenxin] $script actions: $(echo "$actions" | tr '\n' ' ')"
done

# 7. Node.js check (required for camera execution via comfyui-mcp)
if ! command -v npx >/dev/null 2>&1; then
  echo "WARNING: npx not found on PATH. camera-* execution requires Node.js." >&2
fi

echo ""
echo "[comfyui-chenxin] setup complete."
echo "[comfyui-chenxin] restart DSH (or start a new session) to load the CLI wrapper Tools."
