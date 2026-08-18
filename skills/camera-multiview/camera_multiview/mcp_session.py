"""JSON-RPC stdio client for the comfyui-mcp MCP server.

Single transport module — owns the subprocess lifecycle, the JSON-RPC
plumbing, and the upload-response parsing. Knows nothing about workflows,
graph nodes, or pose assets.

Public API (all raise McpError on failure):

- McpSession context manager. `start()` spawns comfyui-mcp and completes
  the MCP `initialize` handshake; `close()` terminates the subprocess.
- `upload_image(path) -> UploadResult` — uploads to ComfyUI input/.
- `enqueue(api_graph) -> EnqueueResult` — fires-and-forgets the workflow,
  returns prompt_id.
- `get_history(prompt_id) -> dict | {}` — raw `/history/<id>` body.
- `wait_for_outputs(prompt_id, *, poll_interval, total_timeout) -> RunOutputs`
  — polls until status_str is terminal, returns the structured outputs.
- `get_image(filename, subfolder, image_type) -> bytes` — `/view` download.

Behavioral notes (gained from running against a live server):

- `tools/call` is the only working route. The "retired-name redirect" that
  maps top-level `upload_image` / `enqueue_workflow` onto `tools/call` is
  advertised by comfyui-mcp but does not actually route — we must use
  `tools/call` explicitly.
- `enqueue_workflow` requires `arguments.action` to be set; we pass
  `action="enqueue"`.
- Upload responses arrive as a tools/call `content` array with a single
  text block; the filename appears on a line starting with `Filename:`.
  Anything else (e.g. an `isError: true` content block from a failed
  upload) is treated as an upload failure.
- The MCP subprocess can exit between calls; the reader thread detects
  EOF immediately so call() surfaces it without waiting for the deadline.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional


class McpError(RuntimeError):
    """Raised when the comfyui-mcp JSON-RPC session fails."""


# --- Response shapes -------------------------------------------------------

@dataclass(frozen=True)
class UploadResult:
    """The result of a single upload_image call.

    `name` is the filename ComfyUI sees in its `input/` directory; the
    workflow's LoadImage nodes reference it. `subfolder` is non-empty
    only when comfyui-mcp's resolver decided to nest it.
    """
    name: str
    subfolder: str = ""

    @property
    def composite(self) -> str:
        """The fully-qualified name a workflow node should reference."""
        return f"{self.subfolder}/{self.name}" if self.subfolder else self.name

    @classmethod
    def from_value(cls, value: Any) -> "UploadResult":
        """Parse the modern comfyui-mcp upload response.

        Shape 1 (modern, ≥0.49.0):
            {"content": [{"type": "text", "text": "Uploaded via HTTP.\n\nFilename: X\n\nUse ..."}]}
        Shape 2 (legacy):
            {"name": "...", "subfolder": "..."}   or   "Filename: X" string
        """
        if isinstance(value, str):
            return cls._from_text(value)
        if not isinstance(value, dict):
            raise McpError(f"upload_image returned unexpected value: {value!r}")
        content = value.get("content")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    return cls._from_text(item["text"])
            raise McpError(f"upload_image content had no text block: {value!r}")
        # Legacy dict shape
        name = value.get("name")
        if isinstance(name, str) and name:
            sub = value.get("subfolder", "") or ""
            return cls(name=name, subfolder=str(sub))
        raise McpError(f"upload_image returned no usable name: {value!r}")

    @classmethod
    def _from_text(cls, text: str) -> "UploadResult":
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("Filename:"):
                name = stripped.split(":", 1)[1].strip()
                if name:
                    return cls(name=name)
        raise McpError(f"could not parse filename from upload response: {text!r}")


@dataclass(frozen=True)
class EnqueueResult:
    prompt_id: str

    @classmethod
    def from_value(cls, value: Any) -> "EnqueueResult":
        text = _first_text(value)
        prompt_id = _extract_prompt_id(text)
        if not prompt_id:
            raise McpError(f"enqueue_workflow returned no prompt_id: {value!r}")
        return cls(prompt_id=prompt_id)


@dataclass(frozen=True)
class NodeOutput:
    """A single node's outputs after a successful run."""
    node_id: str
    images: tuple[dict, ...] = ()


@dataclass(frozen=True)
class RunOutputs:
    """Structured view of /history/<prompt_id> after the run completes.

    `status` is "success" or "error" (ComfyUI also emits "failed" which we
    treat as error). `error_messages` is non-empty only when status="error".
    `outputs` is the {node_id: images-list} mapping; empty on error.
    """
    status: str
    outputs: tuple[NodeOutput, ...] = ()
    error_messages: tuple[str, ...] = ()


# --- Session ---------------------------------------------------------------

@dataclass
class McpSession:
    """JSON-RPC stdio session against a single comfyui-mcp subprocess."""

    comfyui_url: str = "http://127.0.0.1:8188"
    comfyui_mcp_command: tuple[str, ...] = ("comfyui-mcp",)
    request_timeout: float = 60.0
    poll_interval: float = 2.0
    total_timeout: float = 1800.0

    _proc: Optional[subprocess.Popen] = field(default=None, init=False, repr=False)
    _send_lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)
    _next_id: int = field(default=1, init=False, repr=False)
    _reader_thread: Optional[threading.Thread] = field(default=None, init=False, repr=False)
    _stderr_thread: Optional[threading.Thread] = field(default=None, init=False, repr=False)
    _responses: dict[int, dict] = field(default_factory=dict, init=False, repr=False)
    _errors: dict[int, BaseException] = field(default_factory=dict, init=False, repr=False)
    _response_event: threading.Event = field(default_factory=threading.Event, init=False, repr=False)
    _eof: bool = field(default=False, init=False, repr=False)

    # -- lifecycle ------------------------------------------------------

    def __enter__(self) -> "McpSession":
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def start(self) -> None:
        if self._proc is not None:
            return
        cmd = self.comfyui_mcp_command[0]
        if os.name == "nt":
            resolved = shutil.which(cmd)
            if resolved is None:
                raise McpError(f"comfyui-mcp command not found on PATH: {cmd}")
            argv = [resolved, *self.comfyui_mcp_command[1:]]
        else:
            argv = list(self.comfyui_mcp_command)

        env = {**os.environ, "COMFYUI_URL": self.comfyui_url.rstrip("/")}

        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            proc = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                creationflags=creationflags,
                shell=False,
                bufsize=1,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except FileNotFoundError as exc:
            raise McpError(f"failed to spawn comfyui-mcp: {exc}") from exc

        self._proc = proc
        self._responses.clear()
        self._errors.clear()
        self._eof = False
        self._reader_thread = threading.Thread(target=self._drain_stdout, daemon=True, name="mcp-reader")
        self._reader_thread.start()
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True, name="mcp-stderr")
        self._stderr_thread.start()
        try:
            self._call("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "camera-multiview", "version": "1.0.0"},
            })
            self._notify("notifications/initialized", {})
        except Exception:
            self.close()
            raise

    def close(self) -> None:
        if self._proc is None:
            return
        try:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait(timeout=5)
        finally:
            self._proc = None

    # -- JSON-RPC plumbing ----------------------------------------------

    def _send(self, payload: dict) -> int:
        if self._proc is None or self._proc.stdin is None:
            raise McpError("session not started")
        with self._send_lock:
            payload["id"] = self._next_id
            self._next_id += 1
            line = json.dumps(payload, ensure_ascii=False) + "\n"
            self._proc.stdin.write(line)
            self._proc.stdin.flush()
            return payload["id"]

    def _drain_stdout(self) -> None:
        if self._proc is None or self._proc.stdout is None:
            return
        for raw in iter(self._proc.stdout.readline, ""):
            line = raw.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg_id = msg.get("id")
            if isinstance(msg_id, int):
                if "error" in msg:
                    self._errors[msg_id] = McpError(
                        f"comfyui-mcp error: {msg['error'].get('message', msg['error'])}"
                    )
                else:
                    self._responses[msg_id] = msg
                self._response_event.set()
        # EOF: stdout closed. Signal callers immediately.
        self._eof = True
        self._response_event.set()

    def _drain_stderr(self) -> None:
        if self._proc is None or self._proc.stderr is None:
            return
        import sys
        for raw in iter(self._proc.stderr.readline, ""):
            sys.stderr.write(f"[comfyui-mcp] {raw}")

    def _call(self, method: str, params: dict) -> Any:
        msg_id = self._send({"jsonrpc": "2.0", "method": method, "params": params})
        deadline = time.monotonic() + self.request_timeout
        while time.monotonic() < deadline:
            self._response_event.wait(timeout=0.5)
            if self._eof:
                raise McpError("comfyui-mcp stdout closed (subprocess exited)")
            if msg_id in self._errors:
                raise self._errors.pop(msg_id)
            if msg_id in self._responses:
                return self._responses.pop(msg_id).get("result")
        raise McpError(f"timed out after {self.request_timeout}s waiting for {method}")

    def _notify(self, method: str, params: dict) -> None:
        if self._proc is None or self._proc.stdin is None:
            return
        with self._send_lock:
            msg = {"jsonrpc": "2.0", "method": method, "params": params}
            self._proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
            self._proc.stdin.flush()

    # -- Public API ------------------------------------------------------

    def upload_image(self, source_path: str) -> UploadResult:
        """Upload a local file to ComfyUI's input directory."""
        result = self._call("tools/call", {
            "name": "upload_image",
            "arguments": {
                "action": "image",
                "source_path": source_path,
            },
        })
        return UploadResult.from_value(result)

    def enqueue(self, api_graph: dict) -> EnqueueResult:
        """Submit a validated API graph; returns the prompt_id."""
        result = self._call("tools/call", {
            "name": "enqueue_workflow",
            "arguments": {
                "action": "enqueue",
                "workflow": api_graph,
            },
        })
        return EnqueueResult.from_value(result)

    def get_history(self, prompt_id: str) -> dict:
        """Fetch /history/<prompt_id> via ComfyUI's HTTP API directly.

        We bypass the comfyui-mcp `get_history` tool because it wraps the
        response in a markdown summary string; the raw JSON is what we
        want.
        """
        url = f"{self.comfyui_url.rstrip('/')}/history/{prompt_id}"
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return {}
            raise

    def wait_for_outputs(
        self,
        prompt_id: str,
        *,
        poll_interval: Optional[float] = None,
        total_timeout: Optional[float] = None,
    ) -> RunOutputs:
        """Poll /history/<prompt_id> until the run reaches a terminal status.

        On "success" returns the structured outputs. On "error" or
        "failed" returns a RunOutputs with status="error" and the
        captured error messages (no raise) so callers can decide how to
        present the failure.

        Raises McpError on timeout.
        """
        interval = poll_interval if poll_interval is not None else self.poll_interval
        timeout = total_timeout if total_timeout is not None else self.total_timeout
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            history = self.get_history(prompt_id)
            entry = history.get(prompt_id) if isinstance(history, dict) else None
            if entry is not None:
                status = entry.get("status", {})
                status_str = status.get("status_str") if isinstance(status, dict) else None
                if status_str in {"success", "error", "failed"}:
                    outputs_dict = entry.get("outputs", {})
                    if status_str != "success":
                        msgs = status.get("messages", []) if isinstance(status, dict) else []
                        msg_strs = tuple(_message_str(m) for m in msgs)
                        return RunOutputs(status="error", error_messages=msg_strs)
                    nodes: list[NodeOutput] = []
                    if isinstance(outputs_dict, dict):
                        for nid, node_out in outputs_dict.items():
                            if not isinstance(node_out, dict):
                                continue
                            imgs = node_out.get("images", [])
                            if not isinstance(imgs, list):
                                continue
                            nodes.append(NodeOutput(node_id=str(nid), images=tuple(imgs)))
                    return RunOutputs(status="success", outputs=tuple(nodes))
            time.sleep(interval)
        raise McpError(f"timed out after {timeout}s waiting for prompt_id={prompt_id}")

    def get_image(self, filename: str, subfolder: str = "", image_type: str = "output") -> bytes:
        """Download one image artifact via ComfyUI's /view endpoint."""
        params = {"filename": filename, "subfolder": subfolder, "type": image_type}
        url = f"{self.comfyui_url.rstrip('/')}/view?{urllib.parse.urlencode(params)}"
        with urllib.request.urlopen(url, timeout=60) as resp:
            return resp.read()


# --- helpers --------------------------------------------------------------

def _first_text(value: Any) -> str:
    """Pull the first text block out of an MCP tools/call content list."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                return item["text"]
        return ""
    if isinstance(value, dict):
        content = value.get("content")
        if isinstance(content, list):
            return _first_text(content)
        if isinstance(content, str):
            return content
        if isinstance(value.get("text"), str):
            return value["text"]
    return ""


def _extract_prompt_id(text: str) -> str:
    """Pull the prompt_id out of an enqueue response.

    The modern response is a JSON object: ``{"status": "enqueued", "prompt_id": "..."}``
    Older responses used key=value lines: ``prompt_id: ...`` / ``Prompt ID: ...``.
    Try JSON first (preferred); fall back to a regex on the raw text.
    """
    try:
        obj = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        obj = None
    if isinstance(obj, dict):
        for key in ("prompt_id", "promptId", "id"):
            value = obj.get(key)
            if isinstance(value, str) and value:
                return value

    m = re.search(r"prompt[_ ]?id\s*[:=]\s*\"?([0-9a-fA-F-]{8,})", text, re.IGNORECASE)
    return m.group(1) if m else ""


def _message_str(m: Any) -> str:
    if isinstance(m, str):
        return m
    if isinstance(m, dict):
        return m.get("message") or m.get("text") or str(m)
    return str(m)