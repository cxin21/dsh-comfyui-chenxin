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

# 3. Install packages (local-path dependencies require source order)
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

# 4. Self-check: every CLI must report its actions
for script in camera-image camera-video camera-multiview; do
  actions="$("$VENV_DIR/bin/$script" --list-actions)"
  echo "[comfyui-chenxin] $script actions: $(echo "$actions" | tr '\n' ' ')"
done

# 5. Node.js check (required for camera execution via comfyui-mcp)
if ! command -v npx >/dev/null 2>&1; then
  echo "WARNING: npx not found on PATH. camera-* execution requires Node.js." >&2
fi

echo ""
echo "[comfyui-chenxin] setup complete."
echo "[comfyui-chenxin] restart DSH (or start a new session) to load the CLI wrapper Tools."
