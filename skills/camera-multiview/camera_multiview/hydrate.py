"""Upload images to ComfyUI via the MCP session.

The only module that drives the mcp client's upload. Returns UploadResult
objects (not raw strings) so the response shape stays an implementation
detail of `mcp_session`.

Two responsibilities:

1. upload_user_images — push the 2 user-provided reference images.
2. upload_poses — push the 13 fixed pose skeleton PNGs.

No HTTP probe for pose reuse: every run uploads all 13 fixed poses. The
savings from caching (~650 KB of network) are not worth the added probe
complexity.
"""
from __future__ import annotations

from pathlib import Path
from typing import Protocol

from .mcp_session import McpSession, UploadResult


class McpLike(Protocol):
    """The minimal interface this module needs from the comfyui-mcp client."""
    def upload_image(self, path: str) -> UploadResult: ...


def upload_user_images(
    mcp: McpLike,
    *,
    full_body_path: Path,
    face_path: Path,
) -> dict[str, UploadResult]:
    """Upload the two user-provided images. Returns {config_key: UploadResult}."""
    return {
        "full_body_image": mcp.upload_image(str(full_body_path)),
        "face_image":       mcp.upload_image(str(face_path)),
    }


def upload_poses(
    mcp: McpLike,
    pose_paths: tuple[Path, ...],
) -> dict[str, UploadResult]:
    """Upload the fixed pose assets. Returns {pose_filename: UploadResult}."""
    return {
        path.name: mcp.upload_image(str(path))
        for path in pose_paths
    }