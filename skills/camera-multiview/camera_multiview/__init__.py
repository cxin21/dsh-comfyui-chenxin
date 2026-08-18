"""Flux2-Klein character multiview skill.

Re-exports the public API. Code lives in sibling modules; runtime/
holds the immutable workflow assets.
"""
from __future__ import annotations

from . import spec
from .assets import AssetError, AssetIdentity, load_workflow, verify_assets
from .config_schema import RunConfig
from .contracts import validate_bindings, validate_graph
from .executor import PreparedGraph, RunResult, prepare_graph, run
from .graph import build_graph
from .hydrate import McpLike, upload_poses, upload_user_images
from .mcp_session import (
    EnqueueResult, McpError, McpSession, NodeOutput, RunOutputs, UploadResult,
)


__all__ = [
    # identity
    "STAGE", "spec",
    # config
    "RunConfig",
    # assets
    "AssetError", "AssetIdentity", "verify_assets", "load_workflow",
    # graph build
    "build_graph",
    # hydration (McpLike kept for typing)
    "McpLike", "upload_poses", "upload_user_images",
    # validation
    "validate_graph", "validate_bindings",
    # mcp session
    "McpSession", "McpError", "UploadResult", "EnqueueResult",
    "NodeOutput", "RunOutputs",
    # orchestrator
    "prepare_graph", "run", "PreparedGraph", "RunResult",
]