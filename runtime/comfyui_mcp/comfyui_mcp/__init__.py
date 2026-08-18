"""Shared stdio client for the upstream comfyui-mcp server.

Wraps the JSON-RPC protocol used by ``npx -y comfyui-mcp@<version> --full`` so
all camera-* skills can share one canonical implementation. Standard library
only; no external dependencies.
"""

from .client import McpClient, McpClientError

__all__ = ["McpClient", "McpClientError"]
