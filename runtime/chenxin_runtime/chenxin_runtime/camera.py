"""Shared ComfyUI execution engine for every camera skill.

Execution boundary (fixed, no fallback channel):

* **comfyui-mcp** owns everything that mutates server state or requires
  server knowledge: UI -> API conversion (``get_workflow action=strip``),
  ``upload_image``, ``enqueue_workflow`` (which validates atomically), plus
  health/queue/observation tools.
* **comfyui_http** is the read-only observation channel: history polling
  with explicit status verification, and artifact download via ``GET /view``.

There is no separate validate/runtime-check step: ComfyUI validates an API
graph atomically at enqueue time and rejects invalid graphs without queueing
them, so a dedicated preflight is redundant.

One run = one MCP subprocess. Skills build a graph and hand it to
:meth:`ExecutionSession.execute`.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from comfyui_http import Artifact, ComfyUIClient
from comfyui_mcp import McpClient, McpClientError  # noqa: F401  (re-exported for CLI handlers)


_OUTPUT_KEYS = ("images", "videos", "gifs")

# Bundled fixed assets are always UI format; skills whose fixed asset is
# already an API graph (camera-video / camera-multiview) never call strip.
_MAX_CACHED_WORKFLOWS = 10
_CACHE_DIRNAME = ".workflow_cache"


def preset_root() -> Path:
    """Resolve the preset root directory.

    Priority: ``DSH_COMFYUI_PRESET_ROOT`` env var (set by the loader /
    shellEnv), then the preset layout this file lives in
    (``<preset>/runtime/chenxin_runtime/chenxin_runtime/camera.py`` →
    three parents up).
    """
    env = os.environ.get("DSH_COMFYUI_PRESET_ROOT")
    if env:
        return Path(env).resolve()
    return Path(__file__).resolve().parents[3]


def temp_dir(skill: str) -> Path:
    """Return (and create) ``<preset>/temp/<skill>/``.

    All runtime-generated files — camera run artifacts, anima catalog /
    relation overlay writes, engine workflow cache — land under
    ``<preset>/temp/`` grouped per skill, so a cleanup only has to remove
    that one directory and the skill packages stay pristine.
    """
    target = preset_root() / "temp" / skill
    target.mkdir(parents=True, exist_ok=True)
    return target


@dataclass(frozen=True)
class SavedArtifact:
    """One artifact written to the run's output directory."""

    filename: str
    sha256: str


@dataclass(frozen=True)
class ExecutionReport:
    """Everything a CLI needs to render the P1 result payload."""

    prompt_id: str
    api_graph_sha256: str
    artifacts: tuple[SavedArtifact, ...]
    uploads: tuple[str, ...]
    strip_notes: str = ""
    # When the wait times out but the prompt is still running/queued, this
    # holds the queue snapshot; artifacts is empty but no error is raised.
    queue_status: dict[str, Any] | None = None


def hash_graph(graph: dict[str, Any]) -> str:
    encoded = json.dumps(graph, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _find_npx() -> str:
    npx = shutil.which("npx.cmd") or shutil.which("npx")
    if npx is None:
        raise McpClientError(
            "npx not found on PATH; Node.js is required because execution "
            "runs through the comfyui-mcp server"
        )
    return npx


def _find_comfyui_mcp() -> str | None:
    """Return the global comfyui-mcp binary if installed, else None."""
    return shutil.which("comfyui-mcp.cmd") or shutil.which("comfyui-mcp")


def _uploaded_name(result: Any) -> str:
    if isinstance(result, dict):
        name = result.get("name")
        subfolder = result.get("subfolder", "")
        if isinstance(name, str) and name:
            return f"{subfolder}/{name}" if subfolder else name
    raise McpClientError(f"comfyui-mcp upload returned no filename: {result!r}")


def iter_output_files(record: dict[str, Any]) -> Iterator[tuple[str, str, str]]:
    """Yield ``(filename, subfolder, type)`` for every saved output file.

    Reads the history record's ``outputs`` exactly as ComfyUI reported them;
    nothing is hardcoded per skill.
    """
    outputs = record.get("outputs") or {}
    if not isinstance(outputs, dict):
        return
    for output in outputs.values():
        if not isinstance(output, dict):
            continue
        for key in _OUTPUT_KEYS:
            entries = output.get(key)
            if not isinstance(entries, list):
                continue
            for item in entries:
                if not isinstance(item, dict):
                    continue
                filename = item.get("filename")
                if not isinstance(filename, str) or not filename:
                    continue
                if item.get("type", "output") != "output":
                    continue
                yield filename, str(item.get("subfolder", "")), "output"


def _workflow_cache_dir() -> Path:
    """Directory for patched workflow copies shared by all camera skills.

    Lives under ``<preset>/temp/runtime/`` so the engine's runtime cache is
    cleaned up together with per-skill temp outputs.
    """
    cache_dir = temp_dir("runtime") / _CACHE_DIRNAME
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def cache_workflow(label: str, workflow: dict[str, Any]) -> Path:
    """Persist a patched workflow under the shared cache, evicting old ones.

    At most ``_MAX_CACHED_WORKFLOWS`` files are retained (oldest mtime first).
    Returns the path written.
    """
    cache_dir = _workflow_cache_dir()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    digest = hash_graph(workflow)[:8]
    safe_label = "".join(c if c.isalnum() or c in "-_" else "_" for c in label)
    path = cache_dir / f"{stamp}_{safe_label}_{digest}.json"
    path.write_text(
        json.dumps(workflow, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    cached = sorted(
        (p for p in cache_dir.glob("*.json") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in cached[_MAX_CACHED_WORKFLOWS:]:
        try:
            old.unlink()
        except OSError:
            pass
    return path


class ExecutionSession:
    """One ComfyUI run: one MCP subprocess + one read-only HTTP client."""

    def __init__(
        self,
        comfyui_url: str,
        *,
        timeout: float = 1800.0,
        poll_interval: float = 2.0,
    ) -> None:
        self.comfyui_url = comfyui_url.rstrip("/")
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.http = ComfyUIClient(self.comfyui_url)
        self._mcp: McpClient | None = None
        self._uploads: list[str] = []

    # -- lifecycle ---------------------------------------------------------

    def __enter__(self) -> "ExecutionSession":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def close(self) -> None:
        if self._mcp is not None:
            self._mcp.close()
            self._mcp = None

    def _server(self) -> McpClient:
        if self._mcp is None:
            global_bin = _find_comfyui_mcp()
            if global_bin is not None:
                executable, args = global_bin, [
                    "--full", "--comfyui-url", self.comfyui_url,
                ]
            else:
                # No global install: take whatever the registry serves.
                npx = _find_npx()
                executable, args = npx, [
                    "-y", "comfyui-mcp", "--full",
                    "--comfyui-url", self.comfyui_url,
                ]
            self._mcp = McpClient.from_subprocess(
                executable,
                args,
                timeout=600.0,
                comfyui_url=self.comfyui_url,
            )
        return self._mcp

    # -- MCP-owned operations ----------------------------------------------

    def strip_ui_workflow(self, ui_graph: dict[str, Any]) -> tuple[dict[str, Any], str]:
        """Convert a pinned UI workflow to API format.

        Returns ``(api_graph, notes)`` where ``notes`` is the advisory
        conversion summary.
        """
        return self._server().strip_workflow(ui_graph)

    def upload(self, path: Path) -> str:
        """Upload one input image via comfyui-mcp; return the LoadImage name."""
        path = Path(path)
        if not path.is_file():
            raise FileNotFoundError(f"input image is missing: {path}")
        name = _uploaded_name(self._server().upload_image(str(path.resolve())))
        self._uploads.append(name)
        return name

    def enqueue(self, api_graph: dict[str, Any]) -> str:
        return self._server().enqueue_workflow(api_graph)

    def health_check(self, **kwargs: Any) -> Any:
        """Inspect server health/stats/logs. ``action`` defaults to health."""
        action = kwargs.pop("action", "health")
        return self._server().get_system_stats(action, **kwargs)

    def resolve_missing_models(self, api_graph: dict[str, Any]) -> Any:
        """Report models the graph references that are not installed.

        Detection only — never downloads. Caller decides what to do.
        """
        return self._server().resolve_missing_models(api_graph)

    # -- end-to-end --------------------------------------------------------

    def execute(
        self,
        api_graph: dict[str, Any],
        *,
        output_dir: Path,
        strip_notes: str = "",
    ) -> ExecutionReport:
        """Enqueue, wait for verified completion, save artifacts.

        ComfyUI validates ``api_graph`` atomically at enqueue; an invalid
        graph raises :class:`McpClientError` without entering the queue.

        On wait timeout the queue is inspected: if the prompt is still
        running/queued, an :class:`ExecutionReport` is returned with
        ``queue_status`` set and no artifacts (no error raised). If it has
        vanished without producing output, the failure is diagnosed and
        raised.
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        prompt_id = self.enqueue(api_graph)

        queue_status: dict[str, Any] | None = None
        try:
            record = self.http.wait_for_completion(
                prompt_id, timeout=self.timeout, poll_interval=self.poll_interval
            )
        except Exception:
            status = self._queue_snapshot(prompt_id)
            if _prompt_is_active(status, prompt_id):
                queue_status = status
                return ExecutionReport(
                    prompt_id=prompt_id,
                    api_graph_sha256=hash_graph(api_graph),
                    artifacts=(),
                    uploads=tuple(self._uploads),
                    strip_notes=strip_notes,
                    queue_status=queue_status,
                )
            raise

        saved: list[SavedArtifact] = []
        for filename, subfolder, artifact_type in iter_output_files(record):
            artifact: Artifact = self.http.get_artifact(filename, subfolder, artifact_type)
            target = output_dir / artifact.filename
            target.write_bytes(artifact.bytes)
            saved.append(SavedArtifact(filename=artifact.filename, sha256=artifact.sha256))
        if not saved:
            raise McpClientError(
                f"prompt {prompt_id!r} succeeded but produced no saved outputs"
            )
        return ExecutionReport(
            prompt_id=prompt_id,
            api_graph_sha256=hash_graph(api_graph),
            artifacts=tuple(saved),
            uploads=tuple(self._uploads),
            strip_notes=strip_notes,
            queue_status=None,
        )

    def _queue_snapshot(self, prompt_id: str) -> dict[str, Any]:
        try:
            raw = self._server().queue_status(prompt_id)
        except Exception as exc:  # observation must not mask the original error
            return {"error": f"queue status unavailable: {exc}"}
        if isinstance(raw, dict):
            return raw
        return {"raw": raw}


def _prompt_is_active(status: dict[str, Any], prompt_id: str) -> bool:
    """Best-effort check that a prompt is still queued or running."""
    if status.get("error"):
        return False
    for key in ("queue_running", "queue_pending", "running", "pending"):
        entries = status.get(key)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if entry == prompt_id:
                return True
            if isinstance(entry, (list, tuple)) and entry and entry[0] == prompt_id:
                return True
            if isinstance(entry, dict) and entry.get("prompt_id") == prompt_id:
                return True
    return False


def write_summary(
    output_dir: Path,
    report: ExecutionReport,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Write the run's summary.json next to its artifacts and return it."""
    summary: dict[str, Any] = {
        "prompt_id": report.prompt_id,
        "api_graph_sha256": report.api_graph_sha256,
        "uploads": list(report.uploads),
        "artifacts": [
            {"filename": item.filename, "sha256": item.sha256}
            for item in report.artifacts
        ],
    }
    if report.strip_notes:
        summary["strip_notes"] = report.strip_notes
    if report.queue_status is not None:
        summary["queue_status"] = report.queue_status
        summary["still_running"] = True
    if extra:
        summary.update(extra)
    (Path(output_dir) / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return summary
