"""Recompute camera-image's manifest hash + fingerprint from the actual file.

Use this ONLY when you deliberately changed ``camera-anima.json`` and want
to republish the manifest to match (the "asset replacement protocol" in
docs/development.md). Run from the preset root so the relative paths
resolve:

    cd <preset>
    <preset>\\.venv\\Scripts\\python.exe docs\\recompute_manifest.py

The script:

1. Computes sha256 + structure fingerprint of ``camera-anima.json``.
2. Prints both, compares against ``manifest.json``, and reports match/mismatch.
3. Saves a legacy copy of the manifest (``manifest.json.legacy.before-run``)
   on first run for rollback.
4. Rewrites ``manifest.json`` with the current hashes.

After running it, verify with:

    <preset>\\Scripts\\camera-image.exe assets verify --stage t2i
    <preset>\\Scripts\\camera-image.exe assets verify --stage i2i

and run ``scripts/check_contracts.py`` to keep the SKILL.md contract green.
"""
import sys
import json
import hashlib
import shutil
from pathlib import Path

sys.path.insert(0, 'runtime/chenxin_runtime')
sys.path.insert(0, 'runtime/comfyui_http')
sys.path.insert(0, 'runtime/comfyui_mcp')
from chenxin_runtime import canonical_json, content_hash

ASSET = Path("skills/camera-image/camera_image/runtime/workflow_assets/camera-anima.json")
MANIFEST_PATH = Path("skills/camera-image/camera_image/runtime/workflow_assets/manifest.json")
LEGACY_PATH = Path("skills/camera-image/camera_image/runtime/workflow_assets/manifest.json.legacy.before-run")

# Compute file hash
file_sha256 = hashlib.sha256(ASSET.read_bytes()).hexdigest()
print(f"actual asset_sha256: {file_sha256}")

# Compute structure fingerprint
workflow = json.loads(ASSET.read_text(encoding="utf-8"))
nodes = [
    {
        "id": node["id"],
        "type": node.get("type", ""),
        "title": node.get("title", ""),
        "inputs": [
            {"name": item.get("name"), "type": item.get("type"), "link": item.get("link")}
            for item in node.get("inputs", [])
        ],
        "outputs": [
            {"name": item.get("name"), "type": item.get("type"), "links": item.get("links") or []}
            for item in node.get("outputs", [])
        ],
    }
    for node in workflow["nodes"]
]
groups = [
    {"id": group.get("id"), "title": group.get("title", "")}
    for group in workflow.get("groups", [])
]
payload = {
    "nodes": sorted(nodes, key=lambda item: str(item["id"])),
    "groups": sorted(groups, key=lambda item: str(item["id"])),
    "links": sorted(workflow.get("links", []), key=canonical_json),
}
fingerprint = content_hash(payload)
print(f"actual workflow_fingerprint: {fingerprint}")

# Compare with manifest
manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
print(f"manifest asset_sha256: {manifest['asset_sha256']}")
print(f"manifest workflow_fingerprint: {manifest['workflow_fingerprint']}")
print(f"file match: {file_sha256 == manifest['asset_sha256']}")
print(f"fingerprint match: {fingerprint == manifest['workflow_fingerprint']}")

# Save the legacy manifest for inspection
if not LEGACY_PATH.exists():
    shutil.copy(MANIFEST_PATH, LEGACY_PATH)
    print(f"legacy manifest saved to {LEGACY_PATH}")

# Update manifest with current hashes
manifest["asset_sha256"] = file_sha256
manifest["workflow_fingerprint"] = fingerprint
MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"manifest updated with current hashes")
