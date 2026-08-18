"""Single CLI runner shared by every skill.

Virgin-principle source: replaces 5 copies of the same ``main()`` /
``_build_parser()`` / ``_dispatch()`` / ``_failure()`` boilerplate that
lived in each skill's ``cli.py``. Each skill now declares its subcommands
in 30-50 lines and calls :func:`run_cli`.

The runner installs the universal :func:`if __name__ == "__main__":` guard
that the camera-* CLIs were missing, so ``python -m <pkg>.cli ...`` works
identically to the ``console_scripts`` entry point.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, NoReturn, TextIO

from .protocol import (
    EXIT_CODES,
    RequestInputError,
    emit_failure,
    exit_code_for_error,
    write_json,
)


@dataclass(frozen=True)
class Arg:
    """One argparse argument, declared declaratively."""

    flags: tuple[str, ...]
    kwargs: dict[str, Any] = field(default_factory=dict)

    def add(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument(*self.flags, **self.kwargs)


def arg(*flags: str, **kwargs: Any) -> Arg:
    """Shorthand: ``arg("--stage", required=True, choices=STAGES)``."""
    return Arg(tuple(flags), kwargs)


@dataclass(frozen=True)
class Subcommand:
    """One argparse subcommand, declared declaratively.

    ``handler`` is invoked with the parsed :class:`argparse.Namespace` and
    must return ``(envelope_dict, exit_code)``. ``subcommands`` declares a
    nested sub-action group (e.g. ``assets verify``); when present,
    ``handler`` is ignored for the parent and each child is dispatched.
    """

    name: str
    help: str
    handler: Callable[[argparse.Namespace], tuple[dict[str, Any], int]] | None = None
    args: tuple[Arg, ...] = ()
    subcommands: tuple["Subcommand", ...] = ()

    def attach(self, subparsers: argparse._SubParsersAction, common: argparse.ArgumentParser) -> argparse.ArgumentParser:
        parser = subparsers.add_parser(self.name, help=self.help, parents=[common])
        if self.subcommands:
            nested = parser.add_subparsers(
                dest=f"{self.name}_command", required=True
            )
            for child in self.subcommands:
                child._attach_nested(nested, self.name, common)
        else:
            for a in self.args:
                a.add(parser)
            if self.handler is None:
                raise ValueError(f"subcommand {self.name!r} needs a handler or subcommands")
            parser.set_defaults(_handler=self.handler)
        return parser

    def _attach_nested(
        self, subparsers: argparse._SubParsersAction, parent: str, common: argparse.ArgumentParser
    ) -> argparse.ArgumentParser:
        parser = subparsers.add_parser(self.name, help=self.help, parents=[common])
        for a in self.args:
            a.add(parser)
        if self.handler is None:
            raise ValueError(f"subcommand {parent} {self.name!r} needs a handler")
        parser.set_defaults(_handler=self.handler, _command=f"{parent}.{self.name}")
        return parser


def _common_parser() -> argparse.ArgumentParser:
    """Flags every subcommand accepts.

    ``--json`` is part of the host tool contract (the loader appends it to
    every invocation). The wire format is always the P1 JSON envelope, so
    the flag is accepted and changes nothing — it only keeps one surface.
    """
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--json", action="store_true", default=False,
        help="Emit the P1 JSON envelope (always on; accepted for tool compatibility).",
    )
    return common


def run_cli(
    prog: str,
    description: str,
    *subcommands: Subcommand,
    extra_error_handlers: tuple[
        tuple[type[BaseException], str, str, Callable[[BaseException], dict[str, Any]] | None],
        ...,
    ] = (),
) -> int:
    """Run a single skill CLI as ``python -m <pkg>.cli`` or a console script.

    ``extra_error_handlers`` lets a skill register additional exception types
    that should be translated to specific envelope error codes, e.g.
    ``(ComfyUIHTTPError, "comfyui_runtime_error", "runtime", lambda e: {"type": type(e).__name__})``.
    """

    parser = argparse.ArgumentParser(prog=prog, description=description)
    sub = parser.add_subparsers(dest="command", required=True)
    common = _common_parser()
    for sc in subcommands:
        sc.attach(sub, common)
    args = parser.parse_args()

    envelope, exit_code = _dispatch(args, extra_error_handlers)
    write_json(envelope, stream=sys.stdout)
    return exit_code


def _dispatch(
    args: argparse.Namespace,
    extra_error_handlers: tuple[
        tuple[type[BaseException], str, str, Callable[[BaseException], dict[str, Any]] | None],
        ...,
    ],
) -> tuple[dict[str, Any], int]:
    handler: Callable[[argparse.Namespace], tuple[dict[str, Any], int]] = args._handler
    command: str = getattr(args, "_command", None) or args.command
    stage = getattr(args, "stage", None)

    try:
        return handler(args)
    except BaseException as error:  # noqa: BLE001
        # Specific handlers first: skill-registered types are more precise
        # than the generic categories below (e.g. TokenizerIntegrityError
        # is a ValueError but belongs to the integrity category).
        for exc_type, code, category, detail_fn in extra_error_handlers:
            if isinstance(error, exc_type):
                details = detail_fn(error) if detail_fn else {"type": type(error).__name__}
                return _fail(command, stage, code, str(error), details, category, extra_error_handlers)
        if isinstance(error, RequestInputError):
            return _fail(command, stage, "invalid_request", str(error), {}, "request", extra_error_handlers)
        if isinstance(error, (ValueError, TypeError)):
            return _fail(command, stage, "validation_failed", str(error), {}, "validation", extra_error_handlers)
        return _fail(
            command, stage, "unexpected_error", "internal CLI failure",
            {"type": type(error).__name__}, "unexpected", extra_error_handlers,
        )


def _fail(
    command: str,
    stage: str | None,
    code: str,
    message: str,
    details: dict[str, Any],
    category: str,
    _extra: tuple[Any, ...],
) -> tuple[dict[str, Any], int]:
    envelope = emit_failure(
        command or "unknown", stage,
        [{"code": code, "message": message, "details": details}],
    )
    return envelope, exit_code_for_error(category)


def main_entry(
    prog: str,
    description: str,
    subcommands: Sequence[Subcommand],
    *,
    extra_error_handlers: tuple[
        tuple[type[BaseException], str, str, Callable[[BaseException], dict[str, Any]] | None],
        ...,
    ] = (),
) -> NoReturn:
    """Standard :func:`if __name__ == "__main__":` target.

    Use::

        if __name__ == "__main__":
            main_entry("my-skill", "...",
                [subcommand("a", ...), subcommand("b", ...)],
                extra_error_handlers=(...))
    """
    # Virgin contract: the CLI itself is the single source of truth for
    # action names. ``--list-actions`` lets external tools (loader.js, MCP
    # registries, documentation generators) discover actions without
    # duplicating the list. Nested actions are printed as ``parent.child``.
    if "--list-actions" in sys.argv[1:]:
        for sc in subcommands:
            if sc.subcommands:
                for child in sc.subcommands:
                    print(f"{sc.name}.{child.name}")
            elif sc.handler is not None:
                print(sc.name)
        raise SystemExit(0)
    raise SystemExit(
        run_cli(prog, description, *subcommands, extra_error_handlers=extra_error_handlers)
    )


__all__ = [
    "Arg",
    "Subcommand",
    "arg",
    "main_entry",
    "run_cli",
]
