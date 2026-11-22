"""Lockstep gate: prove cordis.patch.yml is the correct deployment of agent.cordis.yml.

``agent.cordis.yml`` is the portable, human-editable source. ``cordis.patch.yml``
is what DSH actually loads (``dsh.bundle.patch`` in package.json), generated
from it by ``scripts/render_patch.py``. Three deployment rewrites are allowed,
and only these:

  1. ``comfyui-loader.name``       ``./loader.js`` -> ``file:///<checkout>/loader.js``
  2. ``comfyui-loader.config.presetRoot``  ``null`` -> ``<checkout>``
  3. ``prompt-forge.name``         ``./plugins/...`` -> ``file:///<checkout>/plugins/...``

They are forced by DSH's resolution chain: a preset's nested entries are
imported from a host-side base, where ``./`` (not anchored for a plain-object
config) and ``@local/...`` (only in the profile's node_modules) both fail, while
``file:///<abs>`` resolves. See KNOWN-ISSUES #26/#28/#29. The rewrites must be
generated per machine, never hard-coded — this gate asserts the patch's absolute
paths point at THIS checkout.

Anything else that differs is drift: the file DSH runs would not be the file a
human reviews. #13 recorded the dual-maintenance risk with a comment; a comment
cannot fail, this gate can.

Asserted here:
  1. entry ids/order/config match key by key, modulo the 3 deployment rewrites;
  2. the patch's rewritten paths are absolute URLs under THIS checkout;
  3. the source file itself carries no machine-specific path;
  4. every local plugin entry exists on disk (dist/ is gitignored build output);
  5. ``preset.yml``'s name/description match the patch's preset entry.

Usage:  python scripts/check_lockstep.py
Exit:   0 = patch is a correct deployment of the source, 1 = drift or broken entry.
"""

from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

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

# The only entries whose `name` may be rewritten to a file:/// URL, and the
# only config key that may be pinned to the checkout, in the deployed patch.
ABSOLUTE_PATH_ENTRIES = {"comfyui-loader", "prompt-forge"}
PINNED_ROOT_KEYS = {("comfyui-loader", "presetRoot")}


def file_url_path(actual: str) -> Path:
    """Map a ``file:///...`` URL to a local Path (handles Windows ``/D:/``)."""
    parsed = urlparse(actual)
    path = unquote(parsed.path)
    # On Windows file:///D:/x parses to '/D:/x' — drop the leading slash so
    # pathlib reads the drive letter. On POSIX '/x' stays absolute.
    if path.startswith("/") and len(path) > 2 and path[2] == ":":
        path = path[1:]
    return Path(path).resolve()


def is_absolute_form(rel: str, actual) -> bool:
    """True when `actual` is exactly `rel` rewritten to file:///<checkout>."""
    if not isinstance(actual, str) or not actual.startswith("file:///"):
        return False
    parsed = urlparse(actual)
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost"):
        return False
    target = file_url_path(actual)
    expected = (ROOT / rel[2:]).resolve()  # strip leading "./"
    return target == expected


def is_pinned_checkout(value) -> bool:
    """True when `value` is exactly this checkout as an absolute path."""
    if not isinstance(value, str):
        return False
    try:
        return Path(value).resolve() == ROOT.resolve()
    except OSError:
        return False


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

    if doc and all(isinstance(e, dict) and "insert" not in e for e in doc):
        return doc

    for group in doc:
        if not isinstance(group, dict):
            continue
        for entry in group.get("insert", []):
            if entry.get("id") == PRESET_ENTRY_ID:
                return entry["config"]["plugins"]

    raise SystemExit(f"FAIL: {path.name} has no insert entry id={PRESET_ENTRY_ID}")


def check_source_portable(plugins: list[dict]) -> list[str]:
    """The human-editable source must carry no machine-specific path."""
    problems: list[str] = []
    for entry in plugins:
        eid = entry.get("id")
        name = entry.get("name")
        if isinstance(name, str):
            if name.startswith("file:") or Path(name).is_absolute():
                problems.append(
                    f"{eid}.name is machine-specific ({name!r}) in the source; "
                    "use a ./-relative name (render_patch.py generates the URL)"
                )
            elif name.startswith("../"):
                problems.append(
                    f"{eid}.name escapes the checkout ({name!r}) in the source"
                )
        cfg = entry.get("config")
        if isinstance(cfg, dict):
            for key, value in cfg.items():
                if isinstance(value, str) and not value.startswith("!!") and (
                    Path(value).is_absolute() or value.startswith("file:")
                ):
                    problems.append(
                        f"{eid}.{key} is machine-specific ({value!r}) in the source; "
                        "leave it null"
                    )
    return problems


def check_patch_deployment(plugins: list[dict]) -> list[str]:
    """The deployed patch may only differ in the 3 rewrites, pinned to THIS checkout."""
    problems: list[str] = []
    for entry in plugins:
        eid = entry.get("id")
        name = entry.get("name")
        if eid in ABSOLUTE_PATH_ENTRIES:
            if not (isinstance(name, str) and name.startswith("file:///")):
                problems.append(
                    f"{eid}.name must be a file:/// URL in the patch "
                    "(run python scripts/render_patch.py), got {name!r}"
                )
        elif isinstance(name, str) and (
            name.startswith("file:") or Path(name).is_absolute()
        ):
            problems.append(f"{eid}.name is machine-specific in the patch ({name!r})")

        cfg = entry.get("config")
        if isinstance(cfg, dict):
            for key, value in cfg.items():
                if (eid, key) in PINNED_ROOT_KEYS:
                    if not is_pinned_checkout(value):
                        problems.append(
                            f"{eid}.{key} must be THIS checkout "
                            f"({ROOT.as_posix()!r}) in the patch, got {value!r}"
                        )
                elif isinstance(value, str) and not value.startswith("!!") and (
                    Path(value).is_absolute() or value.startswith("file:")
                ):
                    problems.append(
                        f"{eid}.{key} is machine-specific in the patch ({value!r})"
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
            if eid in ABSOLUTE_PATH_ENTRIES and is_absolute_form(
                entry["name"], other["name"]
            ):
                pass  # allowed deployment rewrite (validated separately)
            else:
                problems.append(f"{eid}: name {entry['name']!r} vs {other['name']!r}")

        s_cfg = entry.get("config")
        p_cfg = other.get("config")

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
                if s_cfg[key] is None and is_pinned_checkout(p_cfg[key]):
                    continue  # null -> this checkout is the allowed diff
            if s_cfg[key] != p_cfg[key]:
                problems.append(f"{eid}.{key}: {s_cfg[key]!r} vs {p_cfg[key]!r}")

    return problems


def check_preset_metadata() -> list[str]:
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
    """Every local plugin entry in the source must exist in this checkout.

    ``plugins/prompt-forge/dist/`` is gitignored build output, so a fresh clone
    has the source but not the file the patch points at. The Loader swallows a
    failed import into an unstarted fiber, so this turns silence into a red gate.
    """
    problems: list[str] = []
    for entry in plugins:
        name = entry.get("name")
        if not isinstance(name, str):
            continue
        if name.startswith("./") or name.startswith("../"):
            target = ROOT / name
        elif name.startswith("file:"):
            target = file_url_path(name)
        elif Path(name).is_absolute():
            target = Path(name)
        else:
            continue  # bare package specifier — resolved from node_modules

        if not target.resolve().exists():
            hint = ""
            if "plugins/prompt-forge/dist" in str(target).replace("\\", "/"):
                hint = " — run: cd plugins/prompt-forge && npm ci && npm run build"
            problems.append(
                f"{entry.get('id')}.name points at a missing file: {name}{hint}"
            )
    return problems


def main() -> int:
    source = load_plugins(SOURCE)
    patch = load_plugins(PATCH)

    problems = compare(source, patch)
    problems += check_source_portable(source)
    problems += check_patch_deployment(patch)
    problems += check_entry_points(source)
    problems += check_preset_metadata()

    if problems:
        print(f"DRIFT: {len(problems)} problem(s)\n")
        for p in problems:
            print(f"  - {p}")
        print(
            "\nFix source (agent.cordis.yml) by hand, then regenerate the patch:"
            "\n  python scripts/render_patch.py"
            "\nAllowed differences (patch vs source), and only these:"
            "\n  comfyui-loader.name       ./loader.js -> file:///<this-checkout>/loader.js"
            "\n  comfyui-loader.presetRoot null -> <this-checkout>"
            "\n  prompt-forge.name         ./plugins/... -> file:///<this-checkout>/plugins/...\n"
        )
        return 1

    print(f"OK   lockstep — {len(source)} entries, 3 deployment rewrites only")
    print("OK   portability — source has no machine paths; patch pinned to this checkout")
    print("OK   entry points — every local plugin entry exists in this checkout")
    print("OK   preset.yml name/description match the patch entry")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
