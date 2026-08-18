"""Standalone Anima Prompt v1 command line interface (virgin rewrite).

Action contract: dotted flat subcommands. `--list-actions`, the MCP wrapper,
and the argparse subparsers all speak the same names (author, catalog.search,
relation.submit, ...) - there is no two-level `catalog search` vs dotted
`catalog.search` split to disagree on.

The relation overlay is an independent writable store (submit/list/accept/
reject) and never touches search; the base relations table is gone.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import traceback
from dataclasses import asdict
from pathlib import Path
from typing import Any, TextIO

from chenxin_runtime import (
    RequestInputError,
    emit_failure,
    emit_success,
    exit_code_for_error,
    load_json_request,
    temp_dir,
    write_json,
)

from .catalog import Catalog, RelationOverlay
from .catalog.builder import CatalogBuilder, sha256_file
from .catalog.verification import verify_catalog
from .composition import compose
from .output import PromptOutput, render_output, to_text_output
from .relation_submission import submit_relation_payload
from .types import SLOT_ORDER, Slot, UserBrief


_ACTIONS = (
    "author",
    "catalog.search", "catalog.browse", "catalog.stats",
    "catalog.build", "catalog.verify",
    "relation.submit", "relation.list", "relation.accept", "relation.reject",
)

_SEARCH_MODES = ("auto", "canonical", "alias", "fuzzy")


class CliError(Exception):
    def __init__(
        self,
        category: str,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.category = category
        self.code = code
        self.message = message
        self.details = details or {}

    def record(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "details": self.details}


class ArgumentParsingError(ValueError):
    pass


class CliArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ArgumentParsingError(message)


def main(
    argv: list[str] | None = None,
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    # Virgin contract: --list-actions is the single source for action discovery.
    raw_argv_probe = list(argv) if argv is not None else sys.argv[1:]
    if "--list-actions" in raw_argv_probe:
        out = stdout if stdout is not None else sys.stdout
        for action in _ACTIONS:
            out.write(action + "\n")
        return 0

    stdin = stdin if stdin is not None else sys.stdin
    stdout = stdout if stdout is not None else sys.stdout
    stderr = stderr if stderr is not None else sys.stderr
    raw_argv = list(argv) if argv is not None else sys.argv[1:]
    parser = _build_parser()
    try:
        args = parser.parse_args(raw_argv)
    except ArgumentParsingError as error:
        command, stage = _command_from_tokens(raw_argv)
        cli_error = CliError("request", "argument_error", str(error))
        if "--json" in raw_argv:
            write_json(emit_failure(command, stage, [cli_error.record()]), stream=stdout)
        else:
            stderr.write(f"argument_error: {error}\n")
        return exit_code_for_error("request")

    action = args.action
    command = action
    stage = "author" if action == "author" else None

    try:
        if action == "author":
            result, advisories = _author(args, stdin)
            envelope = emit_success("author", "author", result, advisories)
        elif action.startswith("catalog."):
            result, advisories = _catalog(args, action)
            envelope = emit_success(action, None, result, advisories)
        elif action.startswith("relation."):
            result, advisories = _relation(args, action)
            envelope = emit_success(action, None, result, advisories)
        else:
            cli_error = CliError("request", "unknown_command", f"unknown command: {action}")
            envelope = emit_failure(action, stage, [cli_error.record()])
            if getattr(args, "json", False):
                write_json(envelope, stream=stdout)
            else:
                stderr.write(f"{cli_error.code}: {cli_error.message}\n")
            return exit_code_for_error(cli_error.category)
        if args.json:
            write_json(envelope, stream=stdout)
        elif action == "author":
            stdout.write(to_text_output(_prompt_output(result["prompt"])) + "\n")
        else:
            stdout.write(json.dumps(result, ensure_ascii=False, default=list) + "\n")
        return 0
    except RequestInputError as error:
        cli_error = CliError("request", "request_invalid", str(error))
    except CliError as error:
        cli_error = error
    except (TypeError, ValueError) as error:
        cli_error = CliError("validation", "request_validation_failed", str(error))
    except (KeyError, OSError, sqlite3.Error) as error:
        cli_error = CliError("integrity", "resource_unavailable", str(error))
    except Exception as error:  # pragma: no cover - defensive process boundary
        traceback.print_exc(file=stderr)
        cli_error = CliError("unexpected", "unexpected_error", str(error))

    envelope = emit_failure(command, stage, [cli_error.record()])
    if getattr(args, "json", False):
        write_json(envelope, stream=stdout)
    else:
        stderr.write(f"{cli_error.code}: {cli_error.message}\n")
    return exit_code_for_error(cli_error.category)


def _build_parser() -> argparse.ArgumentParser:
    parser = CliArgumentParser(prog="anima-prompt-v1")
    parser.add_argument("--version", action="version", version="%(prog)s 3.0.0")
    sub = parser.add_subparsers(dest="action", required=True)

    author = sub.add_parser("author")
    _add_request_source(author)
    author.add_argument("--database", type=Path)
    author.add_argument("--json", action="store_true")

    search = sub.add_parser("catalog.search")
    search.add_argument("query")
    search.add_argument("--database", type=Path)
    search.add_argument("--mode", choices=_SEARCH_MODES, default="auto")
    _add_catalog_filters(search)
    search.add_argument("--limit", type=_positive_limit, default=20)
    search.add_argument("--json", action="store_true")

    browse = sub.add_parser("catalog.browse")
    browse.add_argument("--database", type=Path)
    _add_catalog_filters(browse)
    browse.add_argument("--limit", type=_positive_limit, default=20)
    browse.add_argument("--json", action="store_true")

    stats = sub.add_parser("catalog.stats")
    stats.add_argument("--database", type=Path)
    stats.add_argument("--json", action="store_true")

    build = sub.add_parser("catalog.build")
    build.add_argument("--source", type=Path, required=True)
    build.add_argument("--output", type=Path, default=None,
                       help="Output catalog sqlite. Defaults to "
                            "<preset>/temp/anima-prompt-v1/catalog.sqlite.")
    build.add_argument("--manifest", type=Path)
    build.add_argument("--json", action="store_true")

    verify = sub.add_parser("catalog.verify")
    verify.add_argument("--database", type=Path, required=True)
    verify.add_argument("--manifest", type=Path)
    verify.add_argument("--json", action="store_true")

    submit = sub.add_parser("relation.submit")
    submit.add_argument("--database", type=Path, required=True)
    submit.add_argument("--overlay", type=Path, default=None,
                        help="Overlay sqlite. Defaults to "
                             "<preset>/temp/anima-prompt-v1/relation-overlay.sqlite.")
    submit.add_argument("--payload", type=Path, required=True)
    submit.add_argument("--model", default="current-llm")
    submit.add_argument("--source", default="llm")
    submit.add_argument("--json", action="store_true")

    list_command = sub.add_parser("relation.list")
    list_command.add_argument("--overlay", type=Path, default=None,
                              help="Overlay sqlite. Defaults to "
                                   "<preset>/temp/anima-prompt-v1/relation-overlay.sqlite.")
    list_command.add_argument("--status", choices=("candidate", "accepted", "rejected", "all"), default="all")
    list_command.add_argument("--record-id")
    list_command.add_argument("--limit", type=_positive_limit, default=100)
    list_command.add_argument("--json", action="store_true")

    for action_name in ("relation.accept", "relation.reject"):
        action_parser = sub.add_parser(action_name)
        action_parser.add_argument("--overlay", type=Path, default=None,
                                   help="Overlay sqlite. Defaults to "
                                        "<preset>/temp/anima-prompt-v1/relation-overlay.sqlite.")
        action_parser.add_argument("proposal_id")
        action_parser.add_argument("--json", action="store_true")
    return parser


def _add_catalog_filters(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--category", action="append", default=[])
    parser.add_argument("--source", action="append", default=[])


def _positive_limit(value: str) -> int:
    limit = int(value)
    if limit < 1:
        raise argparse.ArgumentTypeError("limit must be at least 1")
    return limit


def _add_request_source(parser: argparse.ArgumentParser) -> None:
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--request", type=Path)
    source.add_argument("--stdin", action="store_true")


def _author(args: argparse.Namespace, stdin: TextIO):
    request = load_json_request(
        request_path=args.request,
        stdin=stdin if args.stdin else None,
    )
    brief = _coerce_brief(request)
    catalog = Catalog(args.database)
    composed = compose(brief, catalog)
    output = render_output(composed)
    advisories = list(output.advisories)
    segments_payload = _segments_payload(composed)
    citations_payload = _citations_payload(composed)
    has_citation = any(c.get("record_id") for c in citations_payload)
    return {
        "prompt": asdict(output),
        "metadata": {
            "variant": composed.policy.variant,
            "subject": brief.subject,
        },
        "phase_status": {
            "policy": "PASS",
            "grounding": "PASS" if has_citation else "ADVISORY",
            "composition": "PASS",
            "inspection": "ADVISORY" if advisories else "PASS",
        },
        "citations": citations_payload,
        "segments": segments_payload,
    }, advisories


def _coerce_brief(request: dict[str, Any]) -> UserBrief:
    if "subject" not in request:
        raise ValueError("request requires 'subject' (a string describing the main subject)")
    subject = _string(request["subject"], "subject")
    if "slots" not in request:
        raise ValueError("request requires 'slots' (an object {slot_name: [tags]})")
    raw_slots = request["slots"]
    if not isinstance(raw_slots, dict):
        raise TypeError("slots must be an object {slot_name: [tags]}")
    unknown = sorted(set(raw_slots) - set(SLOT_ORDER))
    if unknown:
        raise ValueError(f"unknown slot(s): {unknown}; valid slots: {list(SLOT_ORDER)}")
    slots: list[Slot] = []
    for name in SLOT_ORDER:
        if name not in raw_slots:
            continue
        tags = tuple(
            _string(item, f"slots.{name}[{index}]")
            for index, item in enumerate(_items(raw_slots[name], f"slots.{name}"))
        )
        if tags:
            slots.append(Slot(name=name, tags=tags))
    narrative = request.get("narrative", "")
    if narrative is None:
        narrative = ""
    if not isinstance(narrative, str):
        raise TypeError("narrative must be a string when provided")
    exclusions = tuple(
        _string(value, f"exclusions[{index}]")
        for index, value in enumerate(_items(request.get("exclusions", ()), "exclusions"))
    )
    variant = request.get("variant", "base")
    quality_prefix = request.get("quality_prefix", True)
    if not isinstance(quality_prefix, bool):
        raise TypeError("quality_prefix must be a boolean")
    explicit = request.get("explicit", False)
    if not isinstance(explicit, bool):
        raise TypeError("explicit must be a boolean")
    return UserBrief(
        subject=subject,
        slots=tuple(slots),
        narrative=narrative,
        exclusions=exclusions,
        variant=variant,
        quality_prefix=quality_prefix,
        explicit=explicit,
    )


def _items(value: Any, field: str) -> list[Any]:
    if not isinstance(value, (list, tuple)):
        raise TypeError(f"{field} must be an array")
    return list(value)


def _string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TypeError(f"{field} must be a non-empty string")
    return value


def _segments_payload(composed) -> list[dict[str, Any]]:
    """Project ComposedPrompt into the machine-readable segment list."""
    segments: list[dict[str, Any]] = []
    counter = 0
    for channel in ("positive", "negative"):
        for seg in (composed.positive if channel == "positive" else composed.negative):
            counter += 1
            segments.append({
                "segment_id": f"seg{counter}",
                "channel": channel,
                "text": seg.text,
                "origin": seg.origin,
                "priority": seg.priority,
                "slot": seg.slot,
                "citation": asdict(seg.citation) if seg.citation else None,
            })
    return segments


def _citations_payload(composed) -> list[dict[str, Any]]:
    """Deduplicated citation list."""
    seen: set[str] = set()
    citations: list[dict[str, Any]] = []
    for channel in ("positive", "negative"):
        for seg in (composed.positive if channel == "positive" else composed.negative):
            if seg.citation is None:
                continue
            if seg.citation.record_id is None or seg.citation.record_id in seen:
                continue
            seen.add(seg.citation.record_id)
            citations.append(asdict(seg.citation))
    return citations


def _catalog(args: argparse.Namespace, action: str):
    if action == "catalog.build":
        output = args.output.resolve() if args.output is not None else (
            temp_dir("anima-prompt-v1") / "catalog.sqlite"
        )
        manifest = args.manifest.resolve() if args.manifest is not None else None
        stats = CatalogBuilder(args.source.resolve(), output).build(manifest_path=manifest)
        return {
            "output": str(output),
            "manifest": str(manifest) if manifest is not None else None,
            "stats": asdict(stats),
        }, []

    if action == "catalog.verify":
        database = args.database.resolve()
        manifest = args.manifest.resolve() if args.manifest is not None else None
        issues = verify_catalog(database, manifest)
        if issues:
            raise CliError(
                "integrity",
                "catalog_integrity_failed",
                "Catalog verification failed",
                {"issues": issues},
            )
        return {
            "database": str(database),
            "manifest": str(manifest) if manifest is not None else None,
            "issues": [],
        }, []

    catalog = Catalog(args.database)
    if action == "catalog.search":
        hits = catalog.search(
            args.query,
            mode=args.mode,
            categories=tuple(args.category),
            sources=tuple(args.source),
            limit=args.limit,
        )
        return {"hits": [_tag_hit(item) for item in hits]}, []
    if action == "catalog.browse":
        hits = catalog.browse(
            categories=tuple(args.category),
            sources=tuple(args.source),
            limit=args.limit,
        )
        return {"hits": [_tag_hit(item) for item in hits]}, []
    if action == "catalog.stats":
        return {"stats": catalog.stats()}, []
    raise CliError("request", "unknown_catalog_command", f"unknown catalog command: {action}")


def _relation(args: argparse.Namespace, action: str):
    overlay = RelationOverlay(
        args.overlay if args.overlay is not None
        else temp_dir("anima-prompt-v1") / "relation-overlay.sqlite"
    )
    if action == "relation.submit":
        payload = load_json_request(request_path=args.payload)
        submission = submit_relation_payload(
            payload,
            catalog=Catalog(args.database),
            overlay=overlay.path,
            model=args.model,
            source=args.source,
        )
        if submission.issues:
            raise CliError(
                "validation",
                "relation_validation_failed",
                "relation submission failed validation",
                {"issues": list(submission.issues)},
            )
        return {
            "record_ids": list(submission.record_ids),
            "proposals": [asdict(item) for item in submission.proposals],
            "issues": [],
        }, []
    if action == "relation.list":
        proposals = overlay.list(
            status=args.status,
            record_id=args.record_id,
            limit=args.limit,
        )
        return {"proposals": [asdict(item) for item in proposals]}, []
    if action == "relation.accept":
        overlay.accept(args.proposal_id)
        return {"proposal_id": args.proposal_id, "status": "accepted"}, []
    if action == "relation.reject":
        overlay.reject(args.proposal_id)
        return {"proposal_id": args.proposal_id, "status": "rejected"}, []
    raise CliError("request", "unknown_relation_command", f"unknown relation command: {action}")


def _tag_hit(hit) -> dict[str, Any]:
    payload = asdict(hit)
    payload["candidate"] = hit.match_type == "fuzzy"
    return payload


def _command_from_tokens(argv: list[str]) -> tuple[str, str | None]:
    words = [value for value in argv if not value.startswith("-")]
    if not words:
        return "unknown", None
    if words[0] == "author":
        return "author", "author"
    return words[0], None


def _prompt_output(payload: dict[str, Any]) -> PromptOutput:
    return PromptOutput(
        payload["positive"],
        payload["negative"],
        tuple(payload.get("notes", ())),
        tuple(payload.get("assumptions", ())),
        tuple(payload.get("advisories", ())),
    )


if __name__ == "__main__":
    raise SystemExit(main())
