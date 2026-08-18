"""End-to-end orchestration over the McpSession.

Public entry points:

- `prepare_graph(session, config) -> PreparedGraph` — load + verify the
  bundled assets, upload images, patch the graph, validate. Returns a
  `PreparedGraph` carrying the API graph plus the upload records — no
  hidden state on the function.

- `run(session, config, *, output_dir, poll_interval, total_timeout) -> RunResult`
  — full orchestration: prepare + enqueue + wait + download the
  SaveImage outputs into output_dir. Writes `summary.json` with the
  graph's SHA-256 for audit.

Design notes:

- Only `SaveImage` outputs are downloaded. `PreviewImage` outputs are
  ephemeral (ComfyUI cleans them up after the run) and were responsible
  for the 16/28 404s in the first run; filtering at the source prevents
  every download attempt from racing the temp-file GC.
- The summary.json shape is stable across runs: prompt_id, api_graph_sha256,
  uploads[], artifacts[] (with error per-artifact), elapsed_seconds.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import assets, contracts, graph, hydrate, spec
from .config_schema import RunConfig
from .mcp_session import McpError, McpSession, NodeOutput, UploadResult


# --- Prepared / result dataclasses -----------------------------------------

@dataclass(frozen=True)
class PreparedGraph:
    """Result of `prepare_graph` — API graph + upload records + graph hash."""
    api_graph: dict
    api_graph_sha256: str
    user_image_names: dict[str, UploadResult]
    pose_names: dict[str, UploadResult]
    uploads: tuple[dict, ...]  # serializable summary of the upload records

    @property
    def user_image_composites(self) -> dict[str, str]:
        """{config_key -> composite upload name} for graph binding."""
        return {k: v.composite for k, v in self.user_image_names.items()}

    @property
    def pose_composites(self) -> dict[str, str]:
        """{pose_filename -> composite upload name} for graph binding."""
        return {k: v.composite for k, v in self.pose_names.items()}


@dataclass(frozen=True)
class RunResult:
    prompt_id: str
    api_graph_sha256: str
    status: str                            # "success" or "error"
    uploads: tuple[dict, ...] = ()
    artifacts: tuple[dict, ...] = ()       # empty when status="error"
    error_messages: tuple[str, ...] = ()   # empty when status="success"
    elapsed_seconds: float = 0.0


# --- Public API -------------------------------------------------------------

def prepare_graph(session: McpSession, config: RunConfig) -> PreparedGraph:
    """Load + verify the bundled assets, upload images, patch the graph."""
    assets.verify_assets()

    user_paths = {
        "full_body_image": Path(config.full_body_image),
        "face_image":      Path(config.face_image),
    }
    for k, p in user_paths.items():
        if not p.is_file():
            raise McpError(f"{k} file missing on disk: {p}")

    user_image_names = hydrate.upload_user_images(
        session,
        full_body_path=user_paths["full_body_image"],
        face_path=user_paths["face_image"],
    )
    pose_names = hydrate.upload_poses(session, spec.all_pose_paths())

    workflow = assets.load_workflow()
    # graph.build_graph wants plain strings (the names it writes into
    # `inputs.image`). Convert UploadResult -> composite name here.
    user_image_composites = {k: v.composite for k, v in user_image_names.items()}
    pose_composites = {k: v.composite for k, v in pose_names.items()}
    api_graph = graph.build_graph(
        workflow=workflow,
        user_image_names=user_image_composites,
        pose_names=pose_composites,
    )
    contracts.validate_graph(api_graph)
    contracts.validate_bindings(
        api_graph,
        user_image_names=user_image_composites,
        pose_names=pose_composites,
    )

    return PreparedGraph(
        api_graph=api_graph,
        api_graph_sha256=_sha256_canonical(api_graph),
        user_image_names=user_image_names,
        pose_names=pose_names,
        uploads=_summarize_uploads(user_image_names, pose_names),
    )


def run(
    session: McpSession,
    config: RunConfig,
    *,
    output_dir: Path,
    poll_interval: float = 2.0,
    total_timeout: float = 1800.0,
) -> RunResult:
    """End-to-end: prepare + enqueue + wait + download persistent artifacts."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()

    prepared = prepare_graph(session, config)

    enqueue = session.enqueue(prepared.api_graph)
    prompt_id = enqueue.prompt_id

    outputs = session.wait_for_outputs(
        prompt_id,
        poll_interval=poll_interval,
        total_timeout=total_timeout,
    )
    elapsed = time.monotonic() - start

    if outputs.status != "success":
        result = RunResult(
            prompt_id=prompt_id,
            api_graph_sha256=prepared.api_graph_sha256,
            status="error",
            uploads=prepared.uploads,
            error_messages=outputs.error_messages,
            elapsed_seconds=elapsed,
        )
        _write_summary(output_dir, result)
        return result

    artifacts = _download_artifacts(
        session, prepared, outputs.outputs, output_dir,
    )
    result = RunResult(
        prompt_id=prompt_id,
        api_graph_sha256=prepared.api_graph_sha256,
        status="success",
        uploads=prepared.uploads,
        artifacts=artifacts,
        elapsed_seconds=elapsed,
    )
    _write_summary(output_dir, result)
    return result


# --- helpers ---------------------------------------------------------------

def _summarize_uploads(
    user_image_names: dict[str, UploadResult],
    pose_names: dict[str, UploadResult],
) -> tuple[dict, ...]:
    records: list[dict] = []
    for config_key, ur in user_image_names.items():
        records.append({
            "config_key": config_key,
            "filename":   ur.name,
            "subfolder":  ur.subfolder,
        })
    for pose_filename, ur in pose_names.items():
        records.append({
            "pose":       pose_filename,
            "filename":   ur.name,
            "subfolder":  ur.subfolder,
        })
    return tuple(records)


def _save_image_node_ids(workflow: dict) -> set[str]:
    """Top-level node IDs whose class_type is SaveImage (the persistent
    outputs). For nested IDs like "570.0.0.3.0.0.565", we walk to the
    prefix (570) and use its class_type; that prefix is a subgraph wrapper
    in the Flux2-Klein workflow, and its internal outputs are preview-only.
    """
    save_ids: set[str] = set()
    for nid, node in workflow.items():
        if isinstance(node, dict) and node.get("class_type") == "SaveImage":
            save_ids.add(str(nid))
    return save_ids


def _node_is_save_image(workflow: dict, node_id: str) -> bool:
    """True if the top-level node behind `node_id` is SaveImage.

    `node_id` may be a dotted path into a subgraph; the prefix is the
    top-level subgraph wrapper (e.g. easy imageConcat), whose internal
    outputs are not the workflow's "SaveImage" set, so we exclude them.
    """
    if node_id in workflow:
        node = workflow[node_id]
        return isinstance(node, dict) and node.get("class_type") == "SaveImage"
    top = node_id.split(".", 1)[0]
    if top in workflow:
        node = workflow[top]
        return isinstance(node, dict) and node.get("class_type") == "SaveImage"
    return False


def _download_artifacts(
    session: McpSession,
    prepared: PreparedGraph,
    outputs: tuple[NodeOutput, ...],
    output_dir: Path,
) -> tuple[dict, ...]:
    """Download only SaveImage outputs. PreviewImage outputs are
    ephemeral temp files and would 404 on /view; filtering at the source
    avoids the round-trip.
    """
    workflow = assets.load_workflow()
    artifacts: list[dict] = []
    image_index = 0
    for node in outputs:
        if not _node_is_save_image(workflow, node.node_id):
            continue
        for img in node.images:
            if not isinstance(img, dict):
                continue
            filename = img.get("filename")
            subfolder = img.get("subfolder", "")
            if not isinstance(filename, str) or not filename:
                continue
            try:
                data = session.get_image(filename, subfolder=subfolder)
            except Exception as exc:
                artifacts.append({
                    "node_id": node.node_id,
                    "filename": filename,
                    "subfolder": subfolder,
                    "error": f"download failed: {exc}",
                })
                continue
            local_name = _artifact_name(filename, image_index)
            (output_dir / local_name).write_bytes(data)
            artifacts.append({
                "node_id": node.node_id,
                "filename": local_name,
                "remote_filename": filename,
                "subfolder": subfolder,
                "bytes": len(data),
            })
            image_index += 1
    return tuple(artifacts)


_ARTIFACT_BAD_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _artifact_name(remote_filename: str, index: int) -> str:
    """Make a filesystem-safe local name from ComfyUI's output filename."""
    if not _ARTIFACT_BAD_RE.search(remote_filename):
        return remote_filename
    safe = _ARTIFACT_BAD_RE.sub("_", remote_filename).strip("_")
    return safe or f"pose_{index:02d}.png"


def _write_summary(output_dir: Path, result: RunResult) -> None:
    payload = {
        "prompt_id":         result.prompt_id,
        "api_graph_sha256":  result.api_graph_sha256,
        "status":            result.status,
        "uploads":           list(result.uploads),
        "artifacts":         list(result.artifacts),
        "error_messages":    list(result.error_messages),
        "elapsed_seconds":   result.elapsed_seconds,
    }
    (output_dir / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _sha256_canonical(graph: dict) -> str:
    """Stable hash of the API graph for audit.

    Uses json.dumps(sort_keys=True) so dict ordering doesn't perturb the
    hash. The graph has no floats or non-JSON-native values, so this is
    sufficient.
    """
    blob = json.dumps(graph, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()