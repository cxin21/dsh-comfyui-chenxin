"""Lockstep gate: prove cordis.patch.yml restates agent.cordis.yml.

``agent.cordis.yml`` is the portable, human-readable form; ``cordis.patch.yml``
is the deployed bundle form advertised by ``package.json`` (``dsh.bundle.patch``)
and consumed by DSH's bundle installer. The patch restates every assembly entry
verbatim, and **no difference between the two files is allowed**.

Neither file may carry a machine-specific path. A ``./``-relative plugin
``name`` is anchored by dsh-app-boot's ``anchorInsertedPluginNames`` against the
directory holding the patch file, so it points inside the installed checkout
wherever that checkout lives; ``presetRoot: null`` lets ``loader.js`` fall back
to its own ``__dirname`` (Node resolves a symlinked module to its realpath, so
the link a profile installs still lands on the checkout).

This gate asserts four things:

  1. the entry lists are identical (ids, order, names, config, key by key);
  2. neither file contains a ``file:`` / absolute plugin name or config value
     (a per-machine override belongs in the profile's own user-layer patch);
  3. every ``./``-relative plugin entry exists on disk -- ``plugins/prompt-forge/
     dist/`` is gitignored build output, and dsh-app-boot swallows a failed
     bundle load into ``skippedBundles`` without printing anything, so a fresh
     clone otherwise boots with no prompt-forge tools and no error;
  4. ``preset.yml``'s name/description match the patch's preset entry.

``KNOWN-ISSUES.md`` #13 recorded the dual-maintenance risk and added a SYNC
OBLIGATION comment; a comment cannot fail. This gate can.

Usage:  python scripts/check_lockstep.py
Exit:   0 = both files agree and are portable, 1 = drift or a broken entry point.
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

# The two files must be byte-equivalent in meaning: cordis.patch.yml is what
# dsh actually loads, agent.cordis.yml is the human-readable twin. There is
# deliberately NO allowed-difference set.
#
# This used to allow three deployment rewrites (loader.js / prompt-forge names
# -> file:/// absolute URLs, presetRoot null -> pinned checkout). dsh-app-boot
# resolves `./`-relative plugin names against the patch's own directory, and
# Node resolves a symlinked module to its realpath, so loader.js's __dirname
# fallback already lands on the checkout. Pinning those paths was redundant and
# made the published patch machine-coupled; it is gone, and the gate now
# rejects any difference at all.
ABSOLUTE_PATH_ENTRIES: set[str] = set()
PINNED_ROOT_KEYS: set[tuple[str, str]] = set()


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


def check_portable(plugins: list[dict]) -> list[str]:
    """No machine-specific path may be committed to either assembly file.

    This is the assertion that would have caught the original defect: the
    curated patch shipped ``file:///D:/DSH/...`` names and a pinned
    ``presetRoot``, so every clone outside this machine loaded the wrong code
    (or nothing). Both files must stay relative so the bundle works wherever it
    is installed.
    """
    problems: list[str] = []
    for entry in plugins:
        eid = entry.get("id")
        name = entry.get("name")
        if isinstance(name, str) and (
            name.startswith("file:") or Path(name).is_absolute()
        ):
            problems.append(
                f"{eid}.name is machine-specific ({name!r}); use a ./relative path"
            )
        cfg = entry.get("config")
        if isinstance(cfg, dict):
            for key, value in cfg.items():
                absolute = isinstance(value, str) and (
                    Path(value).is_absolute() or value.startswith("file:")
                )
                if absolute and not value.startswith("!!"):
                    problems.append(
                        f"{eid}.{key} is machine-specific ({value!r}); leave it null"
                    )
    return problems


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
                continue  # no pinned root any more; kept for clarity
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


def check_entry_points(plugins: list[dict]) -> list[str]:
    """Every ./relative plugin entry must exist on disk.

    ``plugins/prompt-forge/dist/`` is gitignored (build output), so a fresh
    clone has the patch but not the file it points at. dsh-app-boot wraps each
    bundle load in try/catch and pushes failures into ``skippedBundles``
    without printing anything — so a missing build shows up as "the plugin
    silently did nothing", not as an error. This turns that silence into a
    failing check.
    """
    problems: list[str] = []
    for entry in plugins:
        name = entry.get("name")
        if not isinstance(name, str) or not (
            name.startswith("./") or name.startswith("../")
        ):
            continue
        target = (ROOT / name).resolve()
        if not target.is_file():
            hint = ""
            if "plugins/prompt-forge/dist/" in name.replace("\\", "/"):
                hint = " — run: cd plugins/prompt-forge && npm ci && npm run build"
            problems.append(f"{entry.get('id')}.name points at a missing file: {name}{hint}")
    return problems


def main() -> int:
    source = load_plugins(SOURCE)
    patch = load_plugins(PATCH)

    problems = compare(source, patch)
    problems += check_portable(source)
    problems += check_portable(patch)
    problems += check_entry_points(patch)
    problems += check_preset_metadata(source)

    if problems:
        print(f"DRIFT: {len(problems)} problem(s)\n")
        for p in problems:
            print(f"  - {p}")
        print(
            "\nThe two assembly files must agree exactly, and neither may carry a"
            "\nmachine-specific path. Fix both files:"
            "\n  - a plugin name is a ./relative path (dsh-app-boot anchors it to"
            "\n    the patch's own directory at load time)"
            "\n  - comfyui-loader.config.presetRoot stays null (loader.js falls back"
            "\n    to its own __dirname, which Node realpaths through the profile"
            "\n    symlink); put per-machine overrides in the profile's own"
            "\n    cordis.patch.yml instead\n"
        )
        return 1

    print(f"OK   lockstep — {len(source)} entries, files agree exactly")
    print("OK   portability — no machine-specific paths in either file")
    print("OK   entry points — every ./relative plugin entry exists on disk")
    print("OK   preset.yml name/description match the patch entry")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
