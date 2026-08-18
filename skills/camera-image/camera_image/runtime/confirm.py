"""Interactive confirmation before mutating ComfyUI server state.

Group-enabling changes which nodes run inside ComfyUI — that's server-side
state. Before the skill enables any group, it prints the full list of nodes
that will be activated and asks the operator to confirm. This keeps the
group membership (the bundle of node IDs sourced from
``workflow/<stage>/groups.json``) transparent and prevents accidental
enabling of expensive nodes such as the Ultimate SD Upscaler.
"""

from __future__ import annotations

import sys
from typing import Any


class GroupConfirmationAborted(RuntimeError):
    """The operator declined to enable the proposed group set."""


def format_group_plan(
    plan: dict[str, list[dict[str, Any]]],
    available: dict[str, list[dict[str, Any]]] | None = None,
) -> str:
    """Return a human-readable summary of the run's group state.

    Sections:

    * ``[G1/G2 ENABLED]`` — every group that will activate, with source and
      node IDs.
    * ``[G1/G2 AVAILABLE]`` (only when ``available`` is supplied) — every
      other group defined for the stage, so the operator can decide whether
      to add more before confirming.
    """
    lines: list[str] = []
    total_enabled = 0
    enabled_titles_g1 = set()
    enabled_titles_g2 = set()

    for bucket in ("g1", "g2"):
        entries = plan.get(bucket) or []
        if not entries:
            continue
        lines.append(f"[{bucket.upper()} ENABLED] {len(entries)} group(s):")
        for entry in entries:
            title = entry["title"]
            source = entry["source"]
            nodes = entry["node_ids"]
            total_enabled += len(nodes)
            if bucket == "g1":
                enabled_titles_g1.add(title)
            else:
                enabled_titles_g2.add(title)
            marker = {
                "default": "(on by default)",
                "stage": "(stage-mandatory)",
                "user": "(user-requested)",
            }.get(source, "")
            ids = ", ".join(str(n) for n in nodes)
            lines.append(f"  - {title} {marker} -> nodes [{ids}]")

    if total_enabled == 0:
        lines.append("[groups] no groups will be enabled (using asset defaults only)")
    else:
        lines.append(f"[groups] total: {total_enabled} node(s) will be activated")

    if available is not None:
        for bucket in ("g1", "g2"):
            entries = available.get(bucket) or []
            enabled_titles = enabled_titles_g1 if bucket == "g1" else enabled_titles_g2
            disabled = [e for e in entries if e["title"] not in enabled_titles]
            if not disabled:
                continue
            lines.append(
                f"[{bucket.upper()} AVAILABLE] {len(disabled)} not-enabled "
                f"group(s) (cancel & rerun if you want any):"
            )
            for entry in disabled:
                nodes = entry["node_ids"]
                ids = ", ".join(str(n) for n in nodes)
                lines.append(f"  - {entry['title']} -> nodes [{ids}]")

    return "\n".join(lines)


def confirm_group_plan(
    plan: dict[str, list[dict[str, Any]]],
    *,
    yes: bool,
    available: dict[str, list[dict[str, Any]]] | None = None,
    stream: Any = None,
    reader: Any = None,
    timeout_seconds: float = 60.0,
) -> None:
    """Print the plan and (unless ``yes``) read y/n from stdin.

    Aborts by raising :class:`GroupConfirmationAborted` on 'n' or EOF.
    Pass ``yes=True`` to skip the prompt entirely (for non-interactive /
    agent pipelines that already approved).
    """
    out = stream if stream is not None else sys.stdout
    out.write(format_group_plan(plan, available=available) + "\n")

    if yes:
        out.write("[groups] --yes passed; enabling without prompt.\n")
        return

    out.write("[groups] enable these? [y/N] ")
    out.flush()

    if reader is None:
        try:
            line = input()
        except EOFError as exc:
            raise GroupConfirmationAborted(
                "no stdin available; pass --yes to skip confirmation"
            ) from exc
    else:
        line = reader()
    answer = (line or "").strip().lower()
    if answer not in ("y", "yes"):
        raise GroupConfirmationAborted(
            f"group enablement declined by operator ({answer!r})"
        )
    out.write("[groups] confirmed.\n")
