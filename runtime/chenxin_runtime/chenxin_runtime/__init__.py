"""Shared runtime for the 5 comfyui-chenxin skills.

Layers:

* :mod:`chenxin_runtime.protocol` — the P1 JSON envelope every CLI speaks.
* :mod:`chenxin_runtime.cli` — declarative subcommand runner shared by all
  five CLIs (``--list-actions`` discovery included).
* :mod:`chenxin_runtime.camera` — the ComfyUI execution engine: comfyui-mcp
  owns execution (strip / validate / upload / enqueue), comfyui_http is the
  read-only channel (history status + artifact download).
* :mod:`chenxin_runtime.comfyui` — re-export of the read-only HTTP channel.

Skills depend on this package only; no skill carries its own protocol,
CLI boilerplate, or transport code.
"""

from .camera import (
    ExecutionReport,
    ExecutionSession,
    McpClientError,
    SavedArtifact,
    cache_workflow,
    hash_graph,
    iter_output_files,
    preset_root,
    temp_dir,
    write_summary,
)
from .cli import Arg, Subcommand, arg, main_entry, run_cli
from .comfyui import (
    Artifact,
    ComfyUIClient,
    ComfyUIConnectionError,
    ComfyUIExecutionError,
    ComfyUIHTTPError,
    ComfyUIInvalidResponseError,
    ComfyUITimeoutError,
)
from .protocol import (
    EXIT_CODES,
    RequestInputError,
    emit_failure,
    emit_success,
    exit_code_for_error,
    load_json_request,
    write_json,
)
from .workflow_hashes import canonical_json, content_hash


class TokenizerIntegrityError(ValueError):
    """A tokenizer snapshot is incomplete, modified, or not approved.

    Defined once here so every CLI classifies tokenizer failures under the
    shared ``integrity`` error category.
    """

__all__ = [
    "Arg",
    "Artifact",
    "ComfyUIClient",
    "ComfyUIConnectionError",
    "ComfyUIExecutionError",
    "ComfyUIHTTPError",
    "ComfyUIInvalidResponseError",
    "ComfyUITimeoutError",
    "EXIT_CODES",
    "ExecutionReport",
    "ExecutionSession",
    "McpClientError",
    "RequestInputError",
    "SavedArtifact",
    "Subcommand",
    "TokenizerIntegrityError",
    "arg",
    "canonical_json",
    "cache_workflow",
    "content_hash",
    "emit_failure",
    "emit_success",
    "exit_code_for_error",
    "hash_graph",
    "iter_output_files",
    "load_json_request",
    "main_entry",
    "preset_root",
    "run_cli",
    "temp_dir",
    "write_json",
    "write_summary",
]
