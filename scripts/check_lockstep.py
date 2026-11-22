"""Lockstep gate: prove cordis.patch.yml restates agent.cordis.yml.

`agent.cordis.yml` is the portable form (used when the preset lives at
``~/.dsh/.agent-presets/comfyui-chenxin/``); ``cordis.patch.yml`` is the
deployed bundle form consumed by DSH's bundle installer. The patch restates
every assembly entry verbatim. Two differences are allowed, and only these:

  1. ``comfyui-loader.name``      ``./loader.js``  ->  ``file:///<abs>/loader.js``
  2. ``comfyui-loader.config.presetRoot``  ``null``  ->  ``<abs checkout>``

and the same absolute-path treatment for ``prompt-forge.name``
(``./plugins/prompt-forge/dist/src/plugin/index.js`` -> ``file:///<abs>/...``).

Those are deployment mechanics, not content. Anything else that differs is
drift: the two files describe different agents, and the one that actually
runs (the patch) is not the one a human reviews when editing the source.

``KNOWN-ISSUES.md`` #13 recorded the dual-maintenance risk and added a
SYNC OBLIGATION comment; a comment cannot fail. This gate can.

Usage:  python scripts/check_lockstep.py
Exit:   0 = entries match within the allowed difference set, 1 = drift.
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - environment guard
    print("FAIL: PyYAML is required (it is already a camera-* dependency)", file=sys.stderr)
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "agent.cordis.yml"
PATCH = ROOT / "cordis.patch.yml"
PRESET_YML = ROOT / "preset.yml"

PRESET_ENTRY_ID = "preset-comfyui-chenxin"

# Entries whose `name` legitimately becomes an absolute file:/// URL in the
# deployed form (bundle form has no cwd to resolve relative paths against).
ABSOLUTE_PATH_ENTRIES = {"comfyui-loader", "prompt-forge"}
# Config keys whose value legitimately becomes the pinned checkout path.
PINNED_ROOT_KEYS = {("comfyui-loader", "presetRoot")}


def load_plugins(path: Path) -> list[dict]:
    """Return the assembly entry list, wherever the file nests it.

    Three shapes exist in this repo:
      * ``agent.cordis.yml``  — a flat list of entries (here: 12 dicts)
      * ``cordis.patch.yml``  — ``[{insert: [{id: preset-..., config: {plugins: [...]}}]}]``
      * a wrapper object      — ``{plugins: [...]}`` (tolerated, not used today)
    """
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))

    if isinstance(doc, dict):
        if "plugins" in doc:
            return doc["plugins"]
        raise SystemExit(f"FAIL: {path.name} is an object without a 'plugins' key")

    if not isinstance(doc, list):
        raise SystemExit(f"FAIL: {path.name} is neither a list nor an object")

    # Flat entry list: every element is an entry with an id.
    if doc and all(isinstance(e, dict) and "insert" not in e for e in doc):
        return doc

    # Patch groups: find the preset insert.
    for group in doc:
        if not isinstance(group, dict):
            continue
        for entry in group.get("insert", []):
            if entry.get("id") == PRESET_ENTRY_ID:
                return entry["config"]["plugins"]

    raise SystemExit(f"FAIL: {path.name} has no insert entry id={PRESET_ENTRY_ID}")


def is_absolute_form(rel: str, actual) -> bool:
    """True when `actual` is exactly `rel` rewritten to file:///<abs>."""
    if not isinstance(actual, str) or not actual.startswith("file:///"):
        return False
    return actual[len("file:///") :].replace("\\", "/").endswith(rel.lstrip("./"))


def compare(source: list[dict], patch: list[dict]) -> list[str]:
    problems: list[str] = []

    s_ids = [e["id"] for e in source]
    p_ids = [e["id"] for e in patch]
    if s_ids != p_ids:
        only_source = [i for i in s_ids if i not in p_ids]
        only_patch = [i for i in p_ids if i not in s_ids]
        if only_source:
            problems.append(f"entries only in agent.cordis.yml: {only_source}")
        if only_patch:
            problems.append(f"entries only in cordis.patch.yml: {only_patch}")
        if not only_source and not only_patch:
            problems.append(f"entry ORDER differs: {s_ids} vs {p_ids}")

    by_id = {e["id"]: e for e in patch}
    for entry in source:
        eid = entry["id"]
        other = by_id.get(eid)
        if other is None:
            continue  # already reported as missing

        if entry["name"] != other["name"]:
            if eid in ABSOLUTE_PATH_ENTRIES and is_absolute_form(entry["name"], other["name"]):
                pass  # allowed deployment rewrite
            else:
                problems.append(f"{eid}: name {entry['name']!r} vs {other['name']!r}")

        s_cfg = entry.get("config")
        p_cfg = other.get("config")

        # `compaction` carries a list config (group + isolate), not a mapping.
        # It has no allowed-difference keys, so it must match exactly.
        if not isinstance(s_cfg, dict) or not isinstance(p_cfg, dict):
            if s_cfg != p_cfg:
                problems.append(f"{eid}.config: {s_cfg!r} vs {p_cfg!r}")
            continue

        s_cfg = s_cfg or {}
        p_cfg = p_cfg or {}
        for key in sorted(set(s_cfg) | set(p_cfg)):
            if key not in s_cfg:
                problems.append(f"{eid}.{key}: only in patch (value={p_cfg[key]!r})")
                continue
            if key not in p_cfg:
                problems.append(f"{eid}.{key}: only in source (value={s_cfg[key]!r})")
                continue
            if (eid, key) in PINNED_ROOT_KEYS:
                if s_cfg[key] is None and isinstance(p_cfg[key], str):
                    continue  # null -> pinned checkout is the allowed diff
            if s_cfg[key] != p_cfg[key]:
                problems.append(f"{eid}.{key}: {s_cfg[key]!r} vs {p_cfg[key]!r}")

    return problems


def check_preset_metadata(source_plugins: list[dict]) -> list[str]:
    """preset.yml and the patch's preset entry must describe the same preset."""
    problems: list[str] = []
    preset = yaml.safe_load(PRESET_YML.read_text(encoding="utf-8"))
    patch_entry = None
    for group in yaml.safe_load(PATCH.read_text(encoding="utf-8")):
        for entry in group.get("insert", []):
            if entry.get("id") == PRESET_ENTRY_ID:
                patch_entry = entry["config"]
    if patch_entry is None:
        return ["preset entry missing from cordis.patch.yml"]

    for key in ("name", "description"):
        if preset.get(key) != patch_entry.get(key):
            problems.append(f"preset.{key}: preset.yml={preset.get(key)!r} vs patch={patch_entry.get(key)!r}")
    return problems


def main() -> int:
    source = load_plugins(SOURCE)
    patch = load_plugins(PATCH)

    problems = compare(source, patch)
    problems += check_preset_metadata(source)

    if problems:
        print(f"DRIFT: {len(problems)} problem(s)\n")
        for p in problems:
            print(f"  - {p}")
        print(
            "\nFix both files. Allowed differences only:"
            "\n  comfyui-loader.name  ./loader.js -> file:///<abs>/loader.js"
            "\n  comfyui-loader.config.presetRoot  null -> <checkout>"
            "\n  prompt-forge.name  ./plugins/... -> file:///<abs>/plugins/...\n"
        )
        return 1

    print(f"OK   lockstep — {len(source)} entries, allowed difference set only")
    print("OK   preset.yml name/description match the patch entry")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
