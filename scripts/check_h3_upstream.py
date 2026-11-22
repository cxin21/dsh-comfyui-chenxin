"""Drift detector: current official H3 skill vs local baseline snapshot.

The alignment contract (issue #19): whenever MiniMax-AI/MiniMax-H3 updates
its h3-prompt-writing skill, this repo must produce a versioned DIFF table
under docs/rules-h3-upstream/<version>/. This script is the event trigger's
machinery: it hashes every skill file in the newest local baseline under
docs/rules-h3-upstream/_snapshot/, fetches the same files from the official
repo at HEAD, and compares sha256 per file.

Usage:  python scripts/check_h3_upstream.py [--baseline <dir-name>]
Exit:   0 = no drift (local baseline matches official HEAD),
        1 = drift detected (list printed; open a new DIFF round),
        2 = cannot detect (network/gh failure, missing baseline). Never
            report "no drift" when detection itself failed.

Official file paths come from the baseline's SOURCE.md `source_url` lines
(or the `official_dir:` key); this keeps the script working when the skill
moves without hardcoding paths here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

PRESET_ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_ROOT = PRESET_ROOT / "docs" / "rules-h3-upstream" / "_snapshot"
OFFICIAL_REPO = "MiniMax-AI/MiniMax-H3"
SOURCE_MD = "SOURCE.md"


def fail(code: int, msg: str) -> int:
    print(f"[check_h3_upstream] {msg}")
    return code


def newest_baseline(explicit: str | None) -> Path:
    if explicit:
        p = SNAPSHOT_ROOT / explicit
        if not p.is_dir():
            raise FileNotFoundError(f"baseline not found: {p}")
        return p
    baselines = sorted(d for d in SNAPSHOT_ROOT.iterdir() if d.is_dir()) if SNAPSHOT_ROOT.is_dir() else []
    if not baselines:
        raise FileNotFoundError(f"no baselines under {SNAPSHOT_ROOT}")
    return baselines[-1]  # date-prefixed names sort chronologically


def parse_source_md(baseline: Path) -> dict:
    """Extract official_dir / source_url / commit / tag keys from SOURCE.md."""
    src = baseline / SOURCE_MD
    if not src.is_file():
        raise FileNotFoundError(f"{src} missing — baseline has no provenance")
    info: dict[str, str] = {}
    for line in src.read_text(encoding="utf-8").splitlines():
        for key in ("official_dir", "source_url", "commit", "tag"):
            if line.strip().startswith(f"{key}:"):
                info[key] = line.split(":", 1)[1].strip()
    return info


def official_files(baseline: Path, info: dict) -> dict[str, str]:
    """Fetch official skill files -> {relative_path: content}. Prefers gh api; falls back to raw URLs."""
    off_dir = info.get("official_dir", "").strip("/")
    if not off_dir:
        raise ValueError("SOURCE.md has no `official_dir:` key — cannot locate official files")
    files: dict[str, str] = {}
    # Try gh api tree first (handles any layout, includes subdirs).
    try:
        out = subprocess.run(
            ["gh", "api", f"repos/{OFFICIAL_REPO}/git/trees/HEAD?recursive=1", "--jq",
             '.tree[] | select(.type=="blob") | .path'],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout
        paths = [l.strip() for l in out.splitlines() if l.strip().startswith(off_dir + "/")]
    except (subprocess.SubprocessError, FileNotFoundError):
        paths = []
    if paths:
        for p in paths:
            out = subprocess.run(
                ["gh", "api", f"repos/{OFFICIAL_REPO}/contents/{p}", "-H",
                 "Accept: application/vnd.github.raw"],
                capture_output=True, text=True, timeout=60, check=True,
            ).stdout
            files[Path(p).relative_to(off_dir).as_posix()] = out
        return files
    # Fallback: local baseline mirrors the official file list 1:1 (minus SOURCE.md).
    for f in sorted(baseline.rglob("*")):
        if f.is_file() and f.name != SOURCE_MD:
            rel = f.relative_to(baseline).as_posix()
            url = info.get("source_url", "").rsplit("/", 1)[0] + "/" + rel
            with urllib.request.urlopen(url, timeout=60) as r:  # noqa: S310 - fixed https host
                files[rel] = r.read().decode("utf-8")
    if not files:
        raise RuntimeError("no official files resolved (gh api failed and no source_url fallback)")
    return files


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", help="specific _snapshot/<dir> to compare against (default: newest)")
    args = ap.parse_args()

    try:
        baseline = newest_baseline(args.baseline)
    except FileNotFoundError as e:
        return fail(2, f"cannot detect: {e}")

    try:
        info = parse_source_md(baseline)
    except (FileNotFoundError, ValueError) as e:
        return fail(2, f"cannot detect: {e}")

    local: dict[str, str] = {}
    for f in sorted(baseline.rglob("*")):
        if f.is_file() and f.name != SOURCE_MD:
            local[f.relative_to(baseline).as_posix()] = f.read_text(encoding="utf-8")
    if not local:
        return fail(2, f"baseline {baseline.name} has no skill files")

    try:
        official = official_files(baseline, info)
    except Exception as e:  # network/gh/auth — never pretend "no drift"
        return fail(2, f"cannot detect (official fetch failed): {type(e).__name__}: {e}")

    h = lambda s: hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]
    same, diff, missing, extra = [], [], [], []
    for rel, content in official.items():
        if rel not in local:
            extra.append(rel)
        elif h(content) == h(local[rel]):
            same.append(rel)
        else:
            diff.append(rel)
    missing = [r for r in local if r not in official]

    print(f"[check_h3_upstream] baseline={baseline.name} tag={info.get('tag', '?')} "
          f"commit={info.get('commit', '?')[:12]}")
    print(f"[check_h3_upstream] identical={len(same)} changed={len(diff)} "
          f"removed_upstream={len(missing)} added_upstream={len(extra)}")
    for label, rows in (("CHANGED", diff), ("REMOVED upstream", missing), ("ADDED upstream", extra)):
        for r in rows:
            print(f"  {label}: {r}")

    if diff or missing or extra:
        print("[check_h3_upstream] DRIFT: open a new docs/rules-h3-upstream/<tag>/DIFF.md round "
              "(snapshot the new state first, then diff against this baseline)")
        return 1
    print("[check_h3_upstream] OK: local baseline matches official HEAD")
    return 0


if __name__ == "__main__":
    sys.exit(main())
