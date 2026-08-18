"""Shared stdio client for the upstream comfyui-mcp server (>=0.50).

All camera-* skills route server-state-mutating operations through this one
thin client. It spawns the global ``comfyui-mcp`` (or an npx fallback when no
global bin exists) as a JSON-RPC subprocess and wraps the tools the server
exposes.

The 0.50 server reshaped the tool surface. The conversions this client relies
on are:

* ``get_workflow`` ``action:"strip"``  — UI workflow -> API graph. Returns two
  text content items: a human-readable conversion summary first, then the
  actual API graph JSON. We must scan every content item for the graph rather
  than assuming ``content[0]``.
* ``enqueue_workflow`` ``action:"enqueue"`` — submit an API graph; ComfyUI
  validates atomically at enqueue time and rejects invalid graphs (400) with a
  structured ``{error, message, details}`` payload.
* ``get_system_stats``, ``queue``, ``download_model``, ``save_workflow`` —
  health/observation, queue inspection, missing-model resolution, and workflow
  persistence.

Standard library only; no external dependencies.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional


class McpClientError(RuntimeError):
    """Raised when an MCP tool call or handshake fails."""


# Tools whose textual content must never be auto-parsed as JSON even when it
# happens to start with "{" (e.g. markdown that embeds a JSON snippet).
_RAW_TEXT_TOOLS = frozenset({"get_system_stats", "queue", "download_model"})


class McpClient:
    """Wraps MCP tool calls for camera and video operations."""

    def __init__(
        self,
        call_tool: Callable[..., Any],
        comfyui_url: str = "http://127.0.0.1:8188",
    ) -> None:
        self._call = call_tool
        self._proc: Optional[subprocess.Popen] = None
        self._comfyui_url = comfyui_url.rstrip("/")

    @classmethod
    def from_subprocess(
        cls,
        command: str,
        args: list[str],
        timeout: float = 600.0,
        comfyui_url: str = "http://127.0.0.1:8188",
    ) -> "McpClient":
        """Spawn ``comfyui-mcp --full`` as a JSON-RPC subprocess.

        On Windows ``shell=True`` would strip quoting, so we resolve the
        executable with ``shutil.which`` and pass argv as a list with
        ``shell=False`` (the kernel quotes each arg correctly).
        """
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        resolved = shutil.which(command) if os.name == "nt" else command
        argv: list[str] = [resolved or command, *args]
        try:
            proc = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=creationflags,
                shell=False,
                bufsize=1,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except FileNotFoundError as exc:
            raise McpClientError(f"MCP command not found: {command}") from exc

        client = cls.__new__(cls)
        client._proc = proc
        client._send_counter = 0
        client._timeout = timeout
        client._comfyui_url = comfyui_url.rstrip("/")
        client._call = _make_stdio_caller(proc, timeout)
        return client

    def close(self) -> None:
        if self._proc is not None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait(timeout=5)
            self._proc = None

    def __enter__(self) -> "McpClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    # -- workflow conversion -------------------------------------------------

    def strip_workflow(self, ui_graph: dict) -> tuple[dict, str]:
        """Convert a UI workflow to API format.

        Returns ``(api_graph, notes)``. ``notes`` is the human-readable
        conversion summary (substitutions, bypassed components, etc.). It is
        advisory only — success is determined solely by the presence of a
        non-empty graph dict.
        """
        content = self._call_content("get_workflow", {
            "action": "strip",
            "graph": ui_graph,
        })
        graph = _extract_json_dict(content)
        if not isinstance(graph, dict) or not graph:
            joined = _join_text(content)
            raise McpClientError(
                "get_workflow(action=strip) did not return an API graph. "
                f"Server said: {joined[:1000]}"
            )
        notes = _summary_notes(content, graph_json_index=0)
        return graph, notes

    # -- execution -----------------------------------------------------------

    def enqueue_workflow(self, api_graph: dict) -> str:
        """Submit an API graph for execution and return the prompt_id.

        ComfyUI validates atomically here; an invalid graph is rejected (no
        queueing) with a structured error payload we surface verbatim.
        """
        raw = self._call("enqueue_workflow", {
            "action": "enqueue",
            "workflow": api_graph,
        })
        prompt_id = _extract_prompt_id(raw)
        if not prompt_id:
            if isinstance(raw, dict) and raw.get("error"):
                raise McpClientError(_format_enqueue_error(raw))
            raise McpClientError(f"enqueue_workflow returned no prompt_id: {raw!r}")
        return prompt_id

    # -- assets / IO ---------------------------------------------------------

    def upload_image(self, source_path: str) -> Any:
        raw = self._call("upload_image", {"action": "image", "source_path": source_path})
        if isinstance(raw, dict):
            return raw
        if isinstance(raw, str):
            filename: Optional[str] = None
            for line in raw.splitlines():
                stripped = line.strip()
                if stripped.startswith("Filename:"):
                    filename = stripped.split(":", 1)[1].strip()
                    break
            return {"name": filename, "subfolder": ""}
        return {"name": None}

    def list_local_models(self, *, model_type: str | None = None) -> Any:
        arguments: dict[str, Any] = {"action": "list"}
        if model_type is not None:
            arguments["model_type"] = model_type
        return self._call("list_local_models", arguments)

    # -- new in 0.50: health, queue, model resolution, persistence -----------

    def get_system_stats(self, action: str, **kwargs: Any) -> Any:
        """``action`` is one of ``stats``/``logs``/``health``."""
        return self._call("get_system_stats", {"action": action, **kwargs})

    def queue_status(self, prompt_id: str) -> Any:
        return self._call("queue", {"action": "status", "prompt_id": prompt_id})

    def resolve_missing_models(self, api_graph: dict) -> Any:
        """Detect models referenced by the graph that are not installed.

        Returns the server's resolution report (missing entries plus download
        candidates). This NEVER downloads — the caller decides.
        """
        return self._call("download_model", {
            "action": "resolve_missing",
            "workflow": api_graph,
        })

    def save_workflow(self, filename: str, workflow: dict) -> Any:
        """Persist a workflow into the ComfyUI user library."""
        return self._call("save_workflow", {
            "action": "save",
            "filename": filename,
            "workflow": workflow,
        })

    def get_image(self, **kwargs: Any) -> Any:
        return self._call("get_image", kwargs)

    def get_history(self, **kwargs: Any) -> Any:
        return self._call("get_history", kwargs)

    # -- raw content access --------------------------------------------------

    def _call_content(self, name: str, arguments: dict) -> list[dict]:
        """Call a tool and return its raw ``content`` list.

        Bypasses the default text/JSON coercion so callers can inspect every
        content item.
        """
        raw = self._call(name, arguments, _return_content=True)
        if isinstance(raw, list):
            return raw
        return []


# --------------------------------------------------------------------------- #
# stdio transport
# --------------------------------------------------------------------------- #

def _make_stdio_caller(proc: subprocess.Popen, timeout: float) -> Callable[..., Any]:
    next_id = [1]
    lock = threading.Lock()

    def _send(method: str, params: dict | None = None, *, is_notification: bool = False) -> int | None:
        msg: dict = {"jsonrpc": "2.0", "method": method}
        if is_notification:
            if params is not None:
                msg["params"] = params
        else:
            with lock:
                msg["id"] = next_id[0]
                next_id[0] += 1
            if params is not None:
                msg["params"] = params
        line = json.dumps(msg, ensure_ascii=False)
        proc.stdin.write(line + "\n")
        proc.stdin.flush()
        return msg.get("id")

    def _recv(expected_id: int, deadline: float) -> dict:
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if not line:
                if proc.poll() is not None:
                    stderr = ""
                    try:
                        stderr = proc.stderr.read(4096) or ""
                    except Exception:
                        stderr = ""
                    raise McpClientError(
                        f"MCP process exited (code={proc.returncode}) stderr={stderr[:500]}"
                    )
                continue
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == expected_id:
                return msg
        raise McpClientError(f"timed out waiting for MCP response id={expected_id}")

    def call_tool(name: str, arguments: dict, *, _return_content: bool = False) -> Any:
        deadline = time.monotonic() + timeout
        if not getattr(call_tool, "_initialized", False):
            init_id = _send("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "comfyui-chenxin-preset", "version": "2.0"},
            })
            _recv(init_id, deadline)
            _send("notifications/initialized", is_notification=True)
            call_tool._initialized = True  # type: ignore[attr-defined]

        call_id = _send("tools/call", {"name": name, "arguments": arguments or {}})
        resp = _recv(call_id, deadline)
        if "error" in resp:
            err = resp["error"]
            raise McpClientError(f"tools/call {name} error: {err}")

        result = resp.get("result", {})
        if not isinstance(result, dict) or "content" not in result:
            return result
        content = result.get("content")
        is_error = bool(result.get("isError"))

        if _return_content:
            return content if isinstance(content, list) else []

        return _coerce_content(name, content, is_error)

    return call_tool


def _coerce_content(name: str, content: Any, is_error: bool) -> Any:
    """Turn MCP ``content`` into a Python value.

    * Structured error payloads (``{"error": ...}``) are raised.
    * For tools whose output is prose/markdown, return joined text.
    * Otherwise scan every text item and return the first that parses as a
      JSON object/array, falling back to the joined text.
    """
    if not isinstance(content, list) or not content:
        return content

    texts = [
        item.get("text", "")
        for item in content
        if isinstance(item, dict) and isinstance(item.get("text"), str)
    ]

    if is_error:
        joined = "\n".join(texts).strip()
        # The server often returns a JSON error object as the text body.
        for text in texts:
            stripped = text.strip()
            if stripped.startswith("{"):
                try:
                    parsed = json.loads(stripped)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict) and parsed.get("error"):
                    raise McpClientError(_format_enqueue_error(parsed))
        raise McpClientError(joined or f"MCP tool {name} reported an error")

    if name in _RAW_TEXT_TOOLS:
        return "\n".join(texts)

    for text in texts:
        stripped = text.strip()
        if stripped.startswith("{") or stripped.startswith("["):
            try:
                return json.loads(stripped)
            except json.JSONDecodeError:
                continue

    return "\n".join(texts)


# --------------------------------------------------------------------------- #
# content extraction helpers
# --------------------------------------------------------------------------- #

def _extract_json_dict(content: list[dict]) -> Optional[dict]:
    """Return the first content item that is a JSON object."""
    for item in content:
        if not (isinstance(item, dict) and isinstance(item.get("text"), str)):
            continue
        text = item["text"].strip()
        if not (text.startswith("{") or text.startswith("[")):
            continue
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _summary_notes(content: list[dict], *, graph_json_index: int) -> str:
    """Join the prose content items (everything that is not the graph JSON)."""
    notes: list[str] = []
    for item in content:
        if not (isinstance(item, dict) and isinstance(item.get("text"), str)):
            continue
        text = item["text"].strip()
        if text.startswith("{") or text.startswith("["):
            try:
                json.loads(text)
                continue  # this is the graph JSON, not prose
            except json.JSONDecodeError:
                pass
        if text:
            notes.append(text)
    return "\n\n".join(notes)


def _join_text(content: list[dict]) -> str:
    parts = [
        item["text"] for item in content
        if isinstance(item, dict) and isinstance(item.get("text"), str)
    ]
    return "\n".join(parts)


def _extract_prompt_id(raw: Any) -> Optional[str]:
    if isinstance(raw, dict):
        for key in ("prompt_id", "promptId", "id"):
            value = raw.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        nested = raw.get("content")
        if nested is not None:
            return _extract_prompt_id(nested)
    if isinstance(raw, list):
        for item in reversed(raw):
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                try:
                    parsed = json.loads(item["text"])
                except json.JSONDecodeError:
                    continue
                found = _extract_prompt_id(parsed)
                if found:
                    return found
    if isinstance(raw, str):
        stripped = raw.strip()
        if stripped.startswith("{"):
            try:
                return _extract_prompt_id(json.loads(stripped))
            except json.JSONDecodeError:
                return None
    return None


def _format_enqueue_error(raw: dict) -> str:
    message = raw.get("message") or raw.get("error") or "enqueue rejected the workflow"
    details = raw.get("details")
    if isinstance(details, dict):
        server_error = details.get("error")
        if isinstance(server_error, dict):
            node_errors = server_error.get("node_errors") or details.get("node_errors")
            if node_errors:
                return f"{message} | node_errors={json.dumps(node_errors, ensure_ascii=False)}"
    if isinstance(message, str):
        return message
    return json.dumps(raw, ensure_ascii=False)


__all__ = ["McpClient", "McpClientError"]
