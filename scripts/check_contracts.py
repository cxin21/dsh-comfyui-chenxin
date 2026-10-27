"""Contract gate: prove each SKILL.md example request satisfies the CLI schema.

The SKILL.md files are the LLM-facing contract; the parsers are the machine
contract. This script extracts the first jsonc example block from each
SKILL.md, strips comments, and runs it through the exact parser the CLI
uses. If this script is red, the contract has drifted — fix the drift,
never ship it.

It also proves the CLI seam itself (#30, ADR-0001): every skill's ``run``
speaks the P1 envelope even on the failure path, and nested actions
(``assets verify``) are invocable. This is the interface test for the
shared runner — ② ③ reuse it.

Usage:  python scripts/check_contracts.py
Exit:   0 = every contract holds, 1 = drift detected.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

PRESET_ROOT = Path(__file__).resolve().parents[1]
for _p in (
    "runtime/chenxin_runtime",
    "runtime/comfyui_http",
    "runtime/comfyui_mcp",
):
    sys.path.insert(0, str(PRESET_ROOT / _p))
sys.path.insert(0, str(PRESET_ROOT / "skills" / "camera-image"))
sys.path.insert(0, str(PRESET_ROOT / "skills" / "camera-video"))
sys.path.insert(0, str(PRESET_ROOT / "skills" / "camera-multiview"))


def strip_jsonc(text: str) -> str:
    """Remove // comments while respecting string literals."""
    out: list[str] = []
    in_string = False
    i = 0
    while i < len(text):
        ch = text[i]
        if in_string:
            out.append(ch)
            if ch == "\\" and i + 1 < len(text):
                out.append(text[i + 1])
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < len(text) and text[i + 1] == "/":
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def first_example(skill_md: Path) -> dict:
    import json

    raw = skill_md.read_text(encoding="utf-8")
    match = re.search(r"```jsonc\n(.*?)```", raw, re.DOTALL)
    if not match:
        raise AssertionError(f"no jsonc example block in {skill_md}")
    payload = json.loads(strip_jsonc(match.group(1)))
    if not isinstance(payload, dict):
        raise AssertionError(f"example in {skill_md} is not a JSON object")
    return payload


# Stage marker convention: the first jsonc example block may declare which
# CLI stage it exercises via a trailing comment line:
#     // contract-stage: i2i
# The gate reads this instead of guessing from the payload shape, so the
# coupling between SKILL.md example order and the parser's stage rules is
# explicit rather than incidental.
STAGE_MARKER = re.compile(r"^\s*//\s*contract-stage:\s*([\w-]+)\s*$", re.MULTILINE)


def first_example_stage(skill_md: Path) -> str | None:
    """Return the declared contract stage, or None if the example does not
    carry the `// contract-stage:` marker."""
    raw = skill_md.read_text(encoding="utf-8")
    match = re.search(r"```jsonc\n(.*?)```", raw, re.DOTALL)
    if not match:
        return None
    stage_match = STAGE_MARKER.search(match.group(1))
    return stage_match.group(1) if stage_match else None


def check_camera_image() -> None:
    from camera_image.runtime.assets import asset_identity
    from camera_image.runtime.request import parse_request

    expected_profile_id = asset_identity()["profile_id"]
    skill_md = PRESET_ROOT / "skills/camera-image/SKILL.md"
    payload = first_example(skill_md)
    declared = first_example_stage(skill_md)
    # The first jsonc block declares its stage explicitly. If the marker is
    # absent, fall back to the historical default (t2i) so the gate never
    # silently skips.
    stage = declared if declared in ("t2i", "i2i") else "t2i"
    parse_request(stage, payload, expected_profile_id)
    # Also verify the other stage parses, using the same payload minus the
    # stage-specific reference field (synthesized for i2i).
    if stage == "t2i":
        i2i = {**payload, "reference_image": "C:/path/to/ref.png"}
        parse_request("i2i", i2i, expected_profile_id)
    else:
        t2i = {k: v for k, v in payload.items() if k != "reference_image"}
        parse_request("t2i", t2i, expected_profile_id)


def check_camera_video() -> None:
    from camera_video.runtime.request import parse_request

    skill_md = PRESET_ROOT / "skills/camera-video/SKILL.md"
    payload = first_example(skill_md)
    declared = first_example_stage(skill_md)
    stage = declared if declared in ("t2v", "i2v", "multi-i2v") else "i2v"
    # The example's declared stage must parse as-is.
    parse_request(stage, payload)
    # Every other stage must parse against the same example's prompt/duration,
    # with the reference list synthesized to that stage's required count.
    from camera_video.runtime.request import STAGE_REFERENCE_COUNT

    base = {k: v for k, v in payload.items() if k != "references"}
    for other in ("t2v", "i2v", "multi-i2v"):
        if other == stage:
            continue
        count = STAGE_REFERENCE_COUNT[other]
        other_payload = dict(base)
        if count:
            other_payload["references"] = [
                f"C:/path/to/ref-{i}.png" for i in range(1, count + 1)
            ]
        parse_request(other, other_payload)


def check_camera_multiview() -> None:
    from camera_multiview.config_schema import RunConfig

    payload = first_example(PRESET_ROOT / "skills/camera-multiview/SKILL.md")
    RunConfig.from_envelope({}, **payload)


CHECKS = {
    "camera-image": check_camera_image,
    "camera-video": check_camera_video,
    "camera-multiview": check_camera_multiview,
}


# ── CLI seam contract (#30) ───────────────────────────────────────────────

# Per skill: (package, argv up to the missing request file). ``run`` is the
# one action every skill must speak the envelope on — probe it with a
# missing request file and require invalid_request + exit 2.
SEAM_PROBES: dict[str, tuple[str, list[str]]] = {
    "camera-image": ("camera_image", ["run", "--stage", "t2i"]),
    "camera-video": ("camera_video", ["run", "--stage", "i2v"]),
    "camera-multiview": ("camera_multiview", ["run"]),
}


def _child_env() -> dict[str, str]:
    env = os.environ.copy()
    extra = os.pathsep.join(
        str(PRESET_ROOT / p)
        for p in (
            "runtime/chenxin_runtime",
            "runtime/comfyui_http",
            "runtime/comfyui_mcp",
            "skills/camera-image",
            "skills/camera-video",
            "skills/camera-multiview",
        )
    )
    env["PYTHONPATH"] = extra + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def _run_cli(argv: list[str]) -> tuple[int, str]:
    python = PRESET_ROOT / ".venv" / "Scripts" / "python.exe"
    exe = str(python) if python.is_file() else sys.executable
    proc = subprocess.run(
        [exe] + argv,
        capture_output=True, text=True, encoding="utf-8", env=_child_env(),
        cwd=str(PRESET_ROOT), timeout=60,
    )
    return proc.returncode, proc.stdout


def check_cli_seam() -> None:
    for name, (package, prefix) in SEAM_PROBES.items():
        # 1. --list-actions must be non-empty (the loader registers tools
        #    from it; an empty list means an unusable tool).
        rc, out = _run_cli(["-m", package + ".cli", "--list-actions"])
        actions = [line.strip() for line in out.splitlines() if line.strip()]
        if rc != 0 or not actions:
            raise AssertionError(f"{name}: --list-actions returned rc={rc}, actions={actions!r}")
        # 2. run with a missing request file: P1 envelope, ok=false,
        #    invalid_request, exit 2 (the seam's failure contract).
        rc, out = _run_cli(
            ["-m", package + ".cli", *prefix, "--request", "__missing__.json", "--json"]
        )
        if rc != 2:
            raise AssertionError(f"{name}: run(missing request) exit {rc}, want 2 (stdout={out[:200]!r})")
        envelope = json.loads(out)
        if envelope.get("ok") is not False or envelope["errors"][0]["code"] != "invalid_request":
            raise AssertionError(f"{name}: failure envelope drifted: {out[:200]!r}")

    # 4. Nested action: camera-multiview ``assets verify`` must be
    #    reachable in dotted form (loader splits parent.child into argv).
    rc, out = _run_cli(["-m", "camera_multiview.cli", "--list-actions"])
    if "assets.verify" not in [line.strip() for line in out.splitlines()]:
        raise AssertionError("camera-multiview: --list-actions must expose 'assets.verify'")
    rc, out = _run_cli(["-m", "camera_multiview.cli", "assets", "verify", "--json"])
    if rc != 0:
        raise AssertionError(f"camera-multiview: assets verify exit {rc}: {out[:200]!r}")
    envelope = json.loads(out)
    if envelope.get("ok") is not True or envelope.get("command") != "assets verify":
        raise AssertionError(f"camera-multiview: assets verify envelope drifted: {out[:200]!r}")


CHECKS["cli-seam"] = check_cli_seam


# ── Asset-pin contract (#32) ──────────────────────────────────────────────
# The three skills share one trust model (FixedAsset); the gate proves the
# real bundled assets still verify and that tampering fails closed.

def check_asset_pin() -> None:
    import copy
    import hashlib
    import tempfile

    from chenxin_runtime import (
        ArtifactPin,
        FixedAsset,
        FixedAssetError,
        structure_fingerprint,
    )

    # 1. Every real bundled asset verifies through its adapter.
    import camera_image.runtime.assets as image_assets
    import camera_multiview.assets as multiview_assets
    import camera_video.runtime.assets as video_assets

    identity = multiview_assets.verify_assets()
    if identity.pose_count != 13 or identity.workflow_node_count != 261:
        raise AssertionError(f"multiview identity drifted: {identity}")
    multiview_assets.load_workflow()
    image_assets.load_fixed_ui()
    for stage in ("t2v", "i2v", "multi-i2v"):
        video_assets.load_fixed_workflow(stage)

    # 2. Tamper negative: one flipped byte must fail the verified read.
    src = multiview_assets.spec.workflow_path()
    real = src.read_bytes()
    with tempfile.TemporaryDirectory() as td:
        pin = ArtifactPin(
            "wf",
            Path(td) / "wf.json",
            hashlib.sha256(real).hexdigest(),
        )
        tampered = Path(td) / "wf.json"
        tampered.write_bytes(real + b" ")
        asset = FixedAsset([pin], label="contract fixture")
        try:
            asset.load_json("wf")
        except FixedAssetError:
            pass
        else:
            raise AssertionError("tampered asset passed the verified read")

    # 3. structure_fingerprint: widget edits are invisible, node edits are not.
    ui = {
        "nodes": [
            {"id": 1, "type": "KSampler", "title": "s", "inputs": [], "outputs": []},
            {"id": 2, "type": "LoadImage", "title": "t", "inputs": [], "outputs": []},
        ],
        "links": [[1, 1, 0, 2, 0, "IMAGE"]],
        "groups": [],
    }
    fingerprint = structure_fingerprint(ui)
    widget_edit = copy.deepcopy(ui)
    widget_edit["nodes"][0]["widgets_values"] = [99]
    if fingerprint != structure_fingerprint(widget_edit):
        raise AssertionError("structure_fingerprint reacts to widget edits")
    node_edit = copy.deepcopy(ui)
    node_edit["nodes"][1]["type"] = "CheckpointLoader"
    if fingerprint == structure_fingerprint(node_edit):
        raise AssertionError("structure_fingerprint missed a node edit")
    try:
        structure_fingerprint({"nodes": [{"id": 1}, {"id": 1}]})
    except FixedAssetError:
        pass
    else:
        raise AssertionError("duplicate node ids accepted")


CHECKS["asset-pin"] = check_asset_pin


# ── run_graph outcome contract (#31) ─────────────────────────────────────
# Three RunOutcome states against a fake HTTP/MCP layer — no server needed.

def check_run_outcome() -> None:
    from unittest.mock import patch

    from chenxin_runtime.camera import ExecutionSession, RunOutcome, safe_artifact_name

    if safe_artifact_name("..\\evil name.png") != "evil_name.png":
        raise AssertionError("safe_artifact_name leaked path characters")
    if safe_artifact_name("   ") != "artifact.bin":
        raise AssertionError("safe_artifact_name empty-name fallback drifted")

    session = ExecutionSession("http://127.0.0.1:8188")

    def fake_wait(prompt_id, timeout, poll_interval=2.0):
        from comfyui_http.errors import ComfyUITimeoutError

        raise ComfyUITimeoutError(f"timed out after {timeout}s")

    class FakeArtifact:
        filename = "ComfyUI_00001_.png"
        bytes = b"png"
        sha256 = "deadbeef" * 8

    with patch.object(session, "_queue_snapshot", return_value={"queue_running": ["pid-1"]}), \
         patch.object(session, "enqueue", return_value="pid-1"), \
         patch.object(session.http, "wait_for_completion", side_effect=fake_wait):
        outcome = session.run_graph({}, output_dir=Path(PRESET_ROOT) / "temp" / "contract-outcome")
    if not isinstance(outcome, RunOutcome) or outcome.status != "still_running":
        raise AssertionError(f"timeout path should be still_running, got {outcome!r}")
    if outcome.prompt_id != "pid-1" or outcome.summary.get("still_running") is not True:
        raise AssertionError(f"still_running outcome incomplete: {outcome!r}")

    fake_record = {
        "status": {"status_str": "success", "completed": True},
        "outputs": {"9": {"images": [{"filename": "ComfyUI_00001_.png", "subfolder": "", "type": "output"}]}},
    }

    class FakeHttp:
        def wait_for_completion(self, prompt_id, timeout, poll_interval=2.0):
            return fake_record

        def get_artifact(self, filename, subfolder, rtype):
            return FakeArtifact()

    with patch.object(session, "enqueue", return_value="pid-2"), \
         patch.object(session, "http", new=FakeHttp()):
        outcome = session.run_graph({}, output_dir=Path(PRESET_ROOT) / "temp" / "contract-outcome")
    if outcome.status != "completed" or len(outcome.artifacts) != 1:
        raise AssertionError(f"success path drifted: {outcome!r}")
    if outcome.artifacts[0].filename != "ComfyUI_00001_.png":
        raise AssertionError(f"artifact name not sanitized/kept: {outcome.artifacts[0]!r}")

    import shutil

    shutil.rmtree(Path(PRESET_ROOT) / "temp" / "contract-outcome", ignore_errors=True)


CHECKS["run-outcome"] = check_run_outcome


def main() -> int:
    failures = 0
    for name, check in CHECKS.items():
        try:
            check()
        except Exception as error:  # noqa: BLE001 - report every drift
            failures += 1
            print(f"FAIL {name}: {error}")
        else:
            print(f"OK   {name}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
