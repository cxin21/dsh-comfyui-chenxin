"""P1 JSON envelope — the single wire format every skill CLI speaks.

Virgin-principle source: replaces 4 byte-identical copies of the same protocol
that lived in each skill. Every skill's ``cli.py`` imports from here; no skill
defines its own envelope helpers.

Envelope shape (success)::

    {"ok": true, "command": str, "stage": str|null,
     "result": <skill-specific>, "errors": [], "advisories": [...]}

Envelope shape (failure)::

    {"ok": false, "command": str, "stage": str|null, "result": null,
     "errors": [{"code": str, "message": str, "details": {...}}, ...],
     "advisories": [...]}
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any, TextIO

# Exit code mapping is part of the wire contract — fixed, never branched on.
EXIT_CODES: Mapping[str, int] = {
    "request": 2,
    "validation": 3,
    "integrity": 4,
    "runtime": 5,
    "unexpected": 70,
}


class RequestInputError(ValueError):
    """Raised when a CLI request source is missing, ambiguous, or invalid."""


def emit_success(
    command: str,
    stage: str | None,
    result: Any,
    advisories: Iterable[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    return {
        "ok": True,
        "command": command,
        "stage": stage,
        "result": result,
        "errors": [],
        "advisories": list(advisories),
    }


def emit_failure(
    command: str,
    stage: str | None,
    errors: Iterable[Mapping[str, Any]],
    advisories: Iterable[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    error_list = list(errors)
    if not error_list:
        raise ValueError("failure envelope requires at least one error")
    required = {"code", "message", "details"}
    if any(not required.issubset(error) for error in error_list):
        raise ValueError("each error requires code, message, and details")
    return {
        "ok": False,
        "command": command,
        "stage": stage,
        "result": None,
        "errors": error_list,
        "advisories": list(advisories),
    }


def load_json_request(
    *,
    request_path: str | Path | None = None,
    stdin: TextIO | None = None,
) -> dict[str, Any]:
    """Read exactly one JSON request source. ``request_path`` xor ``stdin``."""
    if (request_path is None) == (stdin is None):
        raise RequestInputError("provide exactly one request source: request_path or stdin")
    try:
        # utf-8-sig: tolerate a UTF-8 BOM (common from Windows editors/tools).
        text = Path(request_path).read_text(encoding="utf-8-sig") if request_path is not None else stdin.read()
        payload = json.loads(text)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RequestInputError(f"invalid JSON request: {error}") from error
    if not isinstance(payload, dict):
        raise RequestInputError("JSON request must be an object")
    return payload


def exit_code_for_error(category: str) -> int:
    try:
        return EXIT_CODES[category]
    except KeyError as error:
        raise ValueError(f"unknown error category: {category}") from error


def write_json(envelope: Mapping[str, Any], *, stream: TextIO = sys.stdout) -> None:
    json.dump(envelope, stream, ensure_ascii=False, separators=(",", ":"))
    stream.write("\n")
    stream.flush()
