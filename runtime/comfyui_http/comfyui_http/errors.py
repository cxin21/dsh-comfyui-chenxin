"""Typed exception hierarchy for the read-only ComfyUI HTTP channel."""

from __future__ import annotations


class ComfyUIHTTPError(RuntimeError):
    """Base class for all read-channel errors."""


class ComfyUIConnectionError(ComfyUIHTTPError):
    """The transport could not reach ComfyUI at all (DNS, TCP, refused)."""


class ComfyUIInvalidResponseError(ComfyUIHTTPError):
    """ComfyUI replied with a status, payload shape, or Content-Type we cannot use."""


class ComfyUIExecutionError(ComfyUIHTTPError):
    """ComfyUI executed the prompt and reported a failed status."""

    def __init__(self, prompt_id: str, status: dict) -> None:
        self.prompt_id = prompt_id
        self.status = status
        messages = status.get("messages") if isinstance(status, dict) else None
        super().__init__(
            f"prompt {prompt_id!r} execution failed: {messages!r}"
        )


class ComfyUITimeoutError(ComfyUIHTTPError):
    """``wait_for_completion`` exceeded the supplied timeout without completion."""
