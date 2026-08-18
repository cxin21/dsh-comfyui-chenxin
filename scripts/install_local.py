"""Install the preset's local packages into a target venv WITHOUT pip's build path.

Why this exists
---------------
`pip install -e <local-dir>` on Windows has repeatedly failed on the
target machine with `OSError [Errno 13]` at the build-tracker step — even
when `TMP` is redirected into the workspace, even inside an existing venv.
Direct `os.open(..., O_CREAT|O_EXCL, 0o600)` probes of the same path
succeed, so the failure is specific to pip's build-isolation flow (most
likely AV/EDR quarantining pip's ephemeral build directories, evidenced
by `~`-prefixed dist-info leftovers in site-packages from past
interrupted upgrades).

The fix is to bypass pip for **local packages** entirely. Local packages
are source-tree code, not distributable artifacts — they don't need a
build step, a wheel, or an isolated environment. We install them by
writing the same artifacts pip would write, directly:

* a `<package>.pth` file under `<venv>/Lib/site-packages/` whose content
  is the absolute path to the package source directory (the source dir
  contains the importable package directory). site.py processes this and
  appends the path to `sys.path`, making `import <package>` work.
* a console-script launcher (and its companion `<name>-script.py`,
  `<name>.cmd`, `<name>.ps1`) under `<venv>/Scripts/`, generated via
  pip's vendored `distlib.scripts.ScriptMaker`. This is what makes
  `<name>.exe --list-actions` work, which the DSH loader requires to
  register the CLI wrapper Host Tools.
* a minimal `<name>-<version>.dist-info/` directory so `pip list` shows
  the package and future pip operations don't get confused about
  duplicate / unknown distributions.

`tokenizers` (the only third-party Python dep) is still installed by
`pip` because it is a real PyPI package and pip handles it correctly.

This script is **idempotent and exhaustive**: it always rewrites all 8
packages' install state to match the source tree. Re-running it brings
the venv back in sync with the current source — so source upgrades
(where the package version bumps in pyproject.toml) are picked up
automatically, no manual cleanup required.

Usage
-----
    <venv>/Scripts/python.exe scripts/install_local.py [--preset <path>]

Defaults: --preset = parent of the directory holding this script.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Authoritative table of the 8 local packages. Versions and entry points
# are kept in sync with each package's pyproject.toml — when you bump a
# version there, bump it here too.
PACKAGES: list[dict] = [
    {
        "name": "comfyui-http-runtime",
        "import_name": "comfyui_http",
        "src": "runtime/comfyui_http",
        "version": "1.0.0",
        "cli": None,
        "deps": [],
    },
    {
        "name": "comfyui-mcp-runtime",
        "import_name": "comfyui_mcp",
        "src": "runtime/comfyui_mcp",
        "version": "1.0.0",
        "cli": None,
        "deps": [],
    },
    {
        "name": "chenxin-runtime",
        "import_name": "chenxin_runtime",
        "src": "runtime/chenxin_runtime",
        "version": "1.0.0",
        "cli": None,
        "deps": ["comfyui-http-runtime", "comfyui-mcp-runtime"],
    },
    {
        "name": "anima-prompt-v1",
        "import_name": "anima_prompt_v1",
        "src": "skills/anima-prompt-v1",
        "version": "3.0.0",
        "cli": ("anima-prompt-v1", "anima_prompt_v1.cli:main"),
        "deps": ["chenxin-runtime"],
    },
    {
        "name": "minimax-h3-prompt",
        "import_name": "h3_prompt",
        "src": "skills/minimax-h3-prompt",
        "version": "6.0.0",
        "cli": ("minimax-h3-prompt", "h3_prompt.cli:main"),
        "deps": ["chenxin-runtime", "tokenizers==0.22.2"],
    },
    {
        "name": "camera-image",
        "import_name": "camera_image",
        "src": "skills/camera-image",
        "version": "2.0.0",
        "cli": ("camera-image", "camera_image.cli:main"),
        "deps": ["chenxin-runtime"],
    },
    {
        "name": "camera-video",
        "import_name": "camera_video",
        "src": "skills/camera-video",
        "version": "2.0.0",
        "cli": ("camera-video", "camera_video.cli:main"),
        "deps": ["chenxin-runtime"],
    },
    {
        "name": "camera-multiview",
        "import_name": "camera_multiview",
        "src": "skills/camera-multiview",
        "version": "1.0.0",
        "cli": ("camera-multiview", "camera_multiview.cli:main"),
        "deps": [],
    },
]


def normalize_name(name: str) -> str:
    """PEP 503 normalization for .pth filename and dist-info directory."""
    return re.sub(r"[-_.]+", "-", name).lower()


def find_venv_root(start: Path) -> Path:
    """Walk upward looking for a `pyvenv.cfg` (the venv root marker)."""
    current = start.resolve()
    for candidate in [current, *current.parents]:
        if (candidate / "pyvenv.cfg").exists():
            return candidate
    raise RuntimeError(
        f"could not locate a venv root (pyvenv.cfg) starting from {start}; "
        "pass --venv explicitly"
    )


def write_pth(site_packages: Path, import_name: str, src_dir: Path) -> Path:
    """Write a .pth file that appends src_dir to sys.path."""
    pth = site_packages / f"{import_name}.pth"
    pth.write_text(str(src_dir) + "\n", encoding="utf-8", newline="\n")
    return pth


def write_dist_info(site_packages: Path, pkg: dict, src_dir: Path,
                    cli_files: list[Path], pth_file: Path) -> Path:
    """Write a minimal <name>-<version>.dist-info/ directory."""
    dist_name = normalize_name(pkg["name"]).replace("-", "_")
    dist_info = site_packages / f"{dist_name}-{pkg['version']}.dist-info"
    if dist_info.exists():
        import shutil
        shutil.rmtree(dist_info)
    dist_info.mkdir(parents=True, exist_ok=True)

    deps = pkg.get("deps", [])
    requires_lines = "\n".join(f"Requires-Dist: {d}" for d in deps) if deps else ""

    metadata = (
        'Metadata-Version: 2.1\n'
        f'Name: {pkg["name"]}\n'
        f'Version: {pkg["version"]}\n'
        'Summary: Local package installed by install_local.py\n'
        + (requires_lines + "\n" if requires_lines else "")
    )
    (dist_info / "METADATA").write_text(metadata, encoding="utf-8", newline="\n")

    # RECORD lists every file this dist-info "owns".
    record_entries: list[tuple[Path, str]] = []
    for f in [pth_file, *cli_files, dist_info / "METADATA"]:
        record_entries.append((f, ""))
    direct_url = dist_info / "direct_url.json"
    direct_url.write_text(json.dumps(
        {"dir_info": {"editable": True}, "url": "file://" + str(src_dir).replace("\\", "/")}
    ), encoding="utf-8")
    record_entries.append((direct_url, ""))

    record_lines: list[str] = []
    venv_root = site_packages.parent.parent  # .../Lib/site-packages -> .../venv
    for path, _ in record_entries:
        rel = path.relative_to(venv_root).as_posix()
        record_lines.append(rel + ",")
    record_lines.append((dist_info / "RECORD").relative_to(venv_root).as_posix() + ",")
    (dist_info / "RECORD").write_text("\n".join(record_lines) + "\n", encoding="utf-8")
    return dist_info


def remove_legacy_artifacts(site_packages: Path, pkg: dict) -> list[Path]:
    """Strip stale pip-install leftovers for this package.

    Returns the list of removed paths.
    """
    removed: list[Path] = []
    norm = normalize_name(pkg["name"])
    name_underscore = pkg["import_name"]

    # Old-style editable installers: __editable__.<name>-<any-version>.pth
    # and the finder.py it imports. Match any version (not just the current
    # one) so a version bump in pyproject.toml sweeps the old .pth too.
    #
    # Note: pip uses the raw pyproject name with `-` → `_` (NOT PEP 503
    # normalization), so the glob uses the underscore form.
    pth_slug = pkg["name"].replace("-", "_").replace(".", "_")
    for p in site_packages.glob(f"__editable__.{pth_slug}-*.pth"):
        removed.append(p); p.unlink(missing_ok=True)
    for p in site_packages.glob(f"__editable___{pth_slug}_*_finder.py"):
        removed.append(p); p.unlink(missing_ok=True)

    # Old plain .pth that pointed at the same source but with a stale name
    # (e.g. minimax_h3_v5.pth is a leftover from a v5→v6 upgrade). Sweep any
    # `<import_name>_vN.pth` so future version bumps are covered too.
    for p in site_packages.glob(f"{name_underscore}_v*.pth"):
        removed.append(p); p.unlink(missing_ok=True)

    # Stale dist-info with a different version (covers version drift).
    for p in site_packages.glob(f"{name_underscore}-*.dist-info"):
        if p.name != f"{name_underscore}-{pkg['version']}.dist-info":
            import shutil
            removed.append(p); shutil.rmtree(p, ignore_errors=True)

    return removed


def cleanup_pip_tempfiles(site_packages: Path) -> int:
    """Remove pip's interrupted-rename leftovers (directories/files starting with ~)."""
    n = 0
    for p in site_packages.iterdir():
        if p.name.startswith("~"):
            import shutil
            try:
                if p.is_dir():
                    shutil.rmtree(p)
                else:
                    p.unlink()
                n += 1
            except OSError:
                pass
    return n


def make_console_script(scripts_dir: Path, python_exe: Path,
                        cli_name: str, cli_target: str) -> list[Path]:
    """Generate the distlib launcher pair for one console script."""
    from pip._vendor.distlib.scripts import ScriptMaker

    scripts_dir.mkdir(parents=True, exist_ok=True)
    maker = ScriptMaker(None, str(scripts_dir))
    maker.executable = str(python_exe)
    maker.variants = {""}
    spec = f"{cli_name} = {cli_target}"
    created = maker.make(spec)
    return [Path(p) for p in created]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preset", type=Path, default=None,
                        help="preset root directory (default: parent of this script's directory)")
    args = parser.parse_args()

    preset = (args.preset or Path(__file__).resolve().parent.parent).resolve()
    venv = find_venv_root(Path(sys.executable))
    site_packages = venv / "Lib" / "site-packages"
    scripts_dir = venv / "Scripts"
    python_exe = scripts_dir / "python.exe"

    print(f"[install-local] preset   = {preset}")
    print(f"[install-local] venv     = {venv}")
    print(f"[install-local] site     = {site_packages}")

    # 1. Clean pip interrupted-rename leftovers.
    n = cleanup_pip_tempfiles(site_packages)
    if n:
        print(f"[install-local] removed {n} pip ~ temp leftovers")

    # 2. Per-package install (deterministic, idempotent).
    failures: list[str] = []
    for pkg in PACKAGES:
        src = preset / pkg["src"]
        if not src.is_dir():
            failures.append(f"{pkg['name']}: source dir missing ({src})")
            continue
        if not (src / pkg["import_name"] / "__init__.py").exists():
            failures.append(f"{pkg['name']}: package dir '{pkg['import_name']}' missing in {src}")
            continue

        removed = remove_legacy_artifacts(site_packages, pkg)
        if removed:
            print(f"[install-local] {pkg['name']}: cleared {len(removed)} legacy artifact(s)")

        pth_file = write_pth(site_packages, pkg["import_name"], src)
        print(f"[install-local] {pkg['name']}: wrote {pth_file.name}")

        cli_files: list[Path] = []
        if pkg["cli"]:
            cli_name, cli_target = pkg["cli"]
            cli_files = make_console_script(scripts_dir, python_exe, cli_name, cli_target)
            print(f"[install-local] {pkg['name']}: generated {cli_name} ({len(cli_files)} file(s))")

        write_dist_info(site_packages, pkg, src, cli_files, pth_file)
        print(f"[install-local] {pkg['name']}: dist-info {normalize_name(pkg['name']).replace('-', '_')}-{pkg['version']}.dist-info")

    if failures:
        print()
        print("[install-local] FAILURES:")
        for f in failures:
            print("  - " + f)
        return 1

    print()
    print("[install-local] done — venv in sync with source tree")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
