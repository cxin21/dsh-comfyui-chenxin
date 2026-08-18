"""LoRA stack construction.

The graph has two relevant nodes:
- Node 26 (Lora Loader, LoraManager): 3-widget structure where
  idx 0 = version config (dict), idx 1 = text (lora syntax string),
  idx 2 = structured lora stack. Setting idx 1 uses the LoraManager
  parser at strip time.
- Node 66 (TriggerWord Toggle, LoraManager): trigger_words (linked from
  node 26 output 2) and orinalMessage.

Resolution rules (mirror the old implementation):
- Empty selections -> use the default single-LoRA stack (the asset
  already has a baked default; we leave it untouched).
- Non-empty selections -> resolve short names against the Anima-folder
  inventory via ``mcp_list_loras``. If resolution is impossible, raise
  fail-closed.
- Active=False -> skip the LoRA (it still appears in the rendered text but
  with strength 0).
- Custom trigger_words override the default trigger word list.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .config import Lora, LoraSelection


ANIMA_FOLDER_KEY = "anima"

# Skill-declared default LoRA stack (the contract, NOT inherited from the
# fixed asset's baked text, which can reference filenames that no longer
# exist on the server). Each entry is resolved against the live Anima-folder
# inventory and fail-closed if missing. Trigger words follow the asset's
# baked TriggerWord Toggle (node 66).
DEFAULT_LORA_PLAN: tuple[LoraSelection, ...] = (
    LoraSelection(
        name="anima-base-1-masterpiece-v51",
        trigger_words=["masterpiece", "very aesthetic"],
    ),
    LoraSelection(name="add_detail"),
    LoraSelection(
        name="gpt-image-2_anima-base1_v1-1",
        trigger_words=["@gpt-image-2"],
    ),
)


def _normalize_filename(name: str) -> str:
    name = name.strip()
    if "\\" in name:
        name = name.rsplit("\\", 1)[-1]
    if "/" in name:
        name = name.rsplit("/", 1)[-1]
    if name.endswith(".safetensors"):
        name = name[: -len(".safetensors")]
    return name


def _is_anima_lora(filename: str) -> bool:
    if "\\" not in filename:
        return False
    folder = filename.split("\\", 1)[0].strip().casefold()
    return ANIMA_FOLDER_KEY in folder


def parse_lora_inventory(raw: Any) -> list[str]:
    """Decode whatever ``mcp.list_local_models`` returned."""
    if isinstance(raw, dict):
        loras = raw.get("loras")
        if isinstance(loras, list):
            return [str(item) for item in loras if isinstance(item, str)]
    if isinstance(raw, list):
        return [str(item) for item in raw if isinstance(item, str)]
    if isinstance(raw, str):
        names: list[str] = []
        in_loras = False
        for line in raw.splitlines():
            stripped = line.strip()
            if stripped.lower().startswith("## loras"):
                in_loras = True
                continue
            if in_loras and stripped.startswith("- "):
                names.append(stripped[2:].strip().strip("`"))
        return names
    raise ValueError(f"cannot parse LoRA inventory from type {type(raw).__name__}")


def filter_anima_loras(inventory: list[str]) -> list[str]:
    return [name for name in inventory if _is_anima_lora(name)]


def resolve_lora_names(
    selections: tuple[LoraSelection, ...],
    inventory: list[str],
) -> list[LoraSelection]:
    """Resolve user short names against the Anima-folder inventory."""
    by_short: dict[str, str] = {}
    for full_name in inventory:
        short = _normalize_filename(full_name)
        by_short[short.casefold()] = full_name

    resolved: list[LoraSelection] = []
    for sel in selections:
        name_query = sel.name.strip()
        if not name_query:
            continue
        key = name_query.casefold()
        if key in by_short:
            matched_full = by_short[key]
        else:
            matched_full = None
            for full_name in inventory:
                if full_name == name_query or full_name.casefold() == key:
                    matched_full = full_name
                    break
            if matched_full is None:
                matches = [
                    short for short in by_short
                    if key in short or short in key
                ]
                if len(matches) == 1:
                    matched_full = by_short[matches[0]]
                elif len(matches) > 1:
                    raise ValueError(
                        f"LoRA name {name_query!r} is ambiguous, matches: {matches}"
                    )
                else:
                    raise ValueError(f"LoRA {name_query!r} not found in inventory")
        resolved.append(LoraSelection(
            name=_normalize_filename(matched_full),
            strength_model=sel.strength_model,
            strength_clip=sel.strength_clip if sel.strength_clip is not None else sel.strength_model,
            active=sel.active,
            trigger_words=list(sel.trigger_words),
        ))
    return resolved


def render_stack_text(selections: list[LoraSelection]) -> str:
    """Render the lora text string consumed by LoraManager's node 26.

    Always emits the explicit dual-strength form ``<lora:name:M:MM>`` so the
    rendered text is byte-identical to the asset's baked convention (where
    gpt-image-2_anima-base1_v1-1 uses ``:1.00:1.00``). LoraManager's parser
    accepts both forms; the dual form is what the asset ships with and what
    the live workflow expects.
    """
    parts: list[str] = []
    for sel in selections:
        if not sel.active:
            continue
        model = sel.strength_model
        clip = sel.strength_clip if sel.strength_clip is not None else model
        parts.append(f"<lora:{sel.name}:{model:.2f}:{clip:.2f}>")
    return "".join(parts)


def render_trigger_message(selections: list[LoraSelection]) -> str:
    words: list[str] = []
    for sel in selections:
        if sel.active:
            words.extend(sel.trigger_words)
    return ", ".join(f"{word}," for word in words) if words else ""


def build_lora_patch(
    lora: Lora,
    mcp_list_loras: Callable[[], Any] | None,
) -> dict[str, Any]:
    """Produce the node 26 + node 66 widget values from a Lora config.

    With no explicit selections the skill-declared ``DEFAULT_LORA_PLAN`` is
    used. Every LoRA is resolved against the live Anima-folder inventory and
    fail-closed if a referenced file is absent, so missing/baked-stale names
    surface as a clear request-time error instead of a runtime FileNotFound
    inside the LoraManager node.
    """
    raw_selections = list(lora.selections) if lora.selections else []
    if mcp_list_loras is None:
        raise ValueError(
            "LoRA resolution requires an MCP list_loras supplier"
        )
    raw_inv = mcp_list_loras()
    inventory = parse_lora_inventory(raw_inv)
    anima_loras = filter_anima_loras(inventory)

    if not raw_selections:
        # Default plan is already authored with short names; still verify
        # every one exists on the server.
        _verify_selections_present(DEFAULT_LORA_PLAN, anima_loras)
        resolved = list(DEFAULT_LORA_PLAN)
    else:
        resolved = resolve_lora_names(tuple(raw_selections), anima_loras)

    stack_text = render_stack_text(resolved)
    trigger_message = render_trigger_message(resolved)

    return {
        "node_26": {"text": stack_text},
        "node_66": {"orinalMessage": trigger_message},
        # The LoraManager plugin's _collect_widget_entries reads `strength`
        # and `clipStrength` from each entry dict (see
        # custom_nodes/ComfyUI-Lora-Manager/py/nodes/lora_loader.py). The
        # baked-in reference API format uses these exact keys, not
        # `strength_model`/`strength_clip`.
        "selections": [
            {
                "name": s.name,
                "strength": float(s.strength_model),
                "clipStrength": float(s.strength_clip if s.strength_clip is not None else s.strength_model),
                "active": s.active,
                "expanded": False,
                "selected": False,
                "locked": False,
                "trigger_words": list(s.trigger_words),
            }
            for s in resolved
        ],
    }


def _verify_selections_present(
    selections: tuple[LoraSelection, ...], inventory: list[str]
) -> None:
    by_short: dict[str, str] = {}
    for full_name in inventory:
        by_short[_normalize_filename(full_name).casefold()] = full_name
    missing: list[str] = []
    for sel in selections:
        key = sel.name.strip().casefold()
        if key not in by_short and not any(
            fn.casefold() == key or _normalize_filename(fn).casefold() == key
            for fn in inventory
        ):
            missing.append(sel.name)
    if missing:
        raise ValueError(
            f"default LoRA(s) not found on the server: {missing}. "
            f"Available Anima LoRAs: {sorted(by_short.values())}"
        )
