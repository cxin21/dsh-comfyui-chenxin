"""Patch the fixed Anima UI asset for one run, before MCP strip.

Widget index map (verified against ``workflow_assets/camera-anima.json``):

* 24/25 - positive/negative ImpactWildcardProcessor
    idx 0 = wildcard_text, idx 1 = populated_text
* 3/4/5  - region ImpactWildcardProcessor (Red/Green/Blue)
    same layout as 24/25 (reuses ``_PROMPT_WIDGETS``)
* 583   - CameraAngleNode
    idx 0 = pos_x, idx 1 = pos_y, idx 2 = pos_z, idx 3 = roll
* 585   - CameraExtraConfigNode (13 widgets, 1:1 with inputs)
* 50    - Input Parameters (Image Saver): parameter provider whose
    outputs feed KSampler 27 (first pass) via links.
    idx 0 = seed, idx 1 = control_after_generate, idx 2 = steps,
    idx 3 = cfg, idx 4 = sampler, idx 5 = scheduler, idx 6 = denoise
* 51    - KSampler (refine pass)
    idx 0 = seed, idx 1 = control_after_generate, idx 2 = steps,
    idx 3 = cfg, idx 4 = sampler_name, idx 5 = scheduler, idx 6 = denoise
* 65    - rgthree seed: idx 0 = seed
* 68/71 - image width/height: idx 0 = value
* 26    - Lora Loader (LoraManager): idx 0 = version config (dict), idx 1 = text, idx 2 = structured lora stack
* 66    - TriggerWord Toggle: idx 4 = orinalMessage
* 21    - LoadImage (i2i reference): idx 0 = image
* 58    - PrimitiveInt (i2i branch): idx 0 = value
* 129   - LoadImage (ControlNet): idx 0 = image
* 0/1/2 - region LoadImage (RED/GREEN/BLUE): idx 0 = image
* 17/18/19 - region CLIPTextEncode (Red/Green/Blue): idx 0 = text
* 116   - LoadImage (signature): idx 0 = image
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .assets import load_groups
from .camera_map import camera_coords
from .config import (
    Camera,
    CameraExtra,
    Groups,
    Lora,
    RunConfig,
)
from .lora import build_lora_patch


# Default enabled groups (mirrors the legacy implementation).
DEFAULT_ENABLED_G1 = ("保存图片", "第二轮采样器（G1）", "相机视角生图（G1）")
DEFAULT_ENABLED_G2 = ("图像锐化（G2）", "对比度（G2）")
LOAD_IMAGE_GROUP = "加载图片（G1）"

# i2i conventions.
I2I_BRANCH_VALUE = 2
I2I_FIRST_PASS_DENOISE = 0.6

# Branch selector for node 75 (ImpactSwitch). The asset packages node 58
# (PrimitiveInt) with widget value 2 (i2i), wired into 75.select via link 12.
# In t2i mode we must overwrite that to 1, otherwise 75 selects the i2i
# branch (input2) where 59 (VAEEncode) is bypassed and KSampler 27 receives
# an empty latent.
BRANCH_VALUE = {"t2i": 1, "i2i": I2I_BRANCH_VALUE}

# Compact widget maps: (node_id, name) -> widget_index.
_PROMPT_WIDGETS = {
    ("24", "wildcard_text"): 0,
    ("24", "populated_text"): 1,
    ("25", "wildcard_text"): 0,
    ("25", "populated_text"): 1,
    # Region ImpactWildcardProcessor (3/4/5) shares the same layout as 24/25.
    ("3", "wildcard_text"): 0,
    ("3", "populated_text"): 1,
    ("4", "wildcard_text"): 0,
    ("4", "populated_text"): 1,
    ("5", "wildcard_text"): 0,
    ("5", "populated_text"): 1,
}
_CAMERA_ANGLE_WIDGETS = {
    ("583", "pos_x"): 0,
    ("583", "pos_y"): 1,
    ("583", "pos_z"): 2,
    ("583", "roll"): 3,
}
_CAMERA_EXTRA_WIDGETS = {
    ("585", "extreme_type"): 0,
    ("585", "extreme_weight"): 1,
    ("585", "lens_enabled"): 2,
    ("585", "lens_value"): 3,
    ("585", "dof_enabled"): 4,
    ("585", "dof_value"): 5,
    ("585", "dof_weight"): 6,
    ("585", "movement_enabled"): 7,
    ("585", "movement_value"): 8,
    ("585", "composition_enabled"): 9,
    ("585", "composition_value"): 10,
    ("585", "style_enabled"): 11,
    ("585", "style_value"): 12,
}
_SAMPLER_WIDGETS = {
    # Node 50: Input Parameters (Image Saver) - feeds KSampler 27 via links.
    ("50", "seed"): 0,
    ("50", "steps"): 2,
    ("50", "cfg"): 3,
    ("50", "sampler"): 4,
    ("50", "scheduler"): 5,
    ("50", "denoise"): 6,
    # Node 51: KSampler (refine). Only steps and denoise are user-controllable;
    # cfg/sampler/scheduler inherit the asset's baked values for the refine pass.
    ("51", "steps"): 2,
    ("51", "denoise"): 6,
}
_INT_WIDGETS = {
    ("65", "seed"): 0,
    ("58", "value"): 0,
    ("68", "value"): 0,
    ("71", "value"): 0,
}
# General widget index map for nodes that have a single patchable widget
# at a known position (image inputs, text inputs, LoRA text, trigger message).
_WIDGET_INDICES = {
    ("26", "text"): 1,
    ("66", "orinalMessage"): 4,
    ("21", "image"): 0,
    ("0", "image"): 0,
    ("1", "image"): 0,
    ("2", "image"): 0,
    ("17", "text"): 0,
    ("18", "text"): 0,
    ("19", "text"): 0,
    ("116", "image"): 0,
    ("129", "image"): 0,
}

def _get_node(ui: dict, node_id: str) -> dict:
    for node in ui.get("nodes", []):
        if isinstance(node, dict) and node.get("id") == int(node_id):
            return node
    raise ValueError(f"node {node_id} missing from workflow")


def _set_widget(ui: dict, node_id: str, name: str, value: Any, widget_idx: int) -> None:
    node = _get_node(ui, node_id)
    widgets = node.get("widgets_values")
    if not isinstance(widgets, list) or widget_idx >= len(widgets):
        raise ValueError(
            f"node {node_id} widgets_values too short for {name!r} "
            f"(expected index {widget_idx})"
        )
    widgets[widget_idx] = value


def _set_prompt_widget(ui: dict, node_id: str, text: str) -> None:
    _set_widget(ui, node_id, "wildcard_text", text, _PROMPT_WIDGETS[(node_id, "wildcard_text")])
    _set_widget(ui, node_id, "populated_text", text, _PROMPT_WIDGETS[(node_id, "populated_text")])


def _validate_group_titles(stage: str, groups: Groups) -> None:
    """Catch unknown titles early before we touch the graph."""
    meta = load_groups(stage)
    for title in groups.g1:
        if title not in meta["g1"]:
            raise ValueError(
                f"unknown g1 group title {title!r} for {stage}; "
                f"valid titles: {sorted(meta['g1'].keys())}"
            )
    for title in groups.g2:
        if title not in meta["g2"]:
            raise ValueError(
                f"unknown g2 group title {title!r} for {stage}; "
                f"valid titles: {sorted(meta['g2'].keys())}"
            )


def resolve_enabled_groups(
    stage: str, groups: Groups | None
) -> dict[str, list[dict[str, Any]]]:
    """Return every group that will be enabled for this run.

    Validates user-supplied titles against ``groups.json`` before building
    the plan, so unknown titles surface as a clear error before the
    confirmation prompt.

    Shape::

        {
          "g1": [{"title": ..., "source": ..., "node_ids": [int, ...]}, ...],
          "g2": [...]
        }

    Sources:
        * ``"default"`` - always on (DEFAULT_ENABLED_G1 / DEFAULT_ENABLED_G2).
        * ``"user"``    - the request passed this exact title.
        * ``"stage"``   - stage-mandatory (e.g. ``加载图片（G1）`` for i2i).
    """
    meta = load_groups(stage)
    user_g1: set[str] = set()
    user_g2: set[str] = set()
    if groups is not None:
        _validate_group_titles(stage, groups)
        user_g1.update(groups.g1)
        user_g2.update(groups.g2)

    enabled_g1 = set(DEFAULT_ENABLED_G1) | user_g1
    enabled_g2 = set(DEFAULT_ENABLED_G2) | user_g2
    if stage == "i2i":
        enabled_g1.add(LOAD_IMAGE_GROUP)

    out_g1: list[dict[str, Any]] = []
    out_g2: list[dict[str, Any]] = []
    bucket_meta_g1 = meta.get("g1", {}) if isinstance(meta, dict) else {}
    bucket_meta_g2 = meta.get("g2", {}) if isinstance(meta, dict) else {}

    def _build(
        bucket_meta: dict, enabled_set: set[str], user_set: set[str]
    ) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for title in enabled_set:
            members = bucket_meta.get(title)
            if not isinstance(members, list):
                continue
            if title in DEFAULT_ENABLED_G1 or title in DEFAULT_ENABLED_G2:
                source = "default"
            elif title == LOAD_IMAGE_GROUP and stage == "i2i":
                source = "stage"
            elif title in user_set:
                source = "user"
            else:
                continue
            out.append({
                "title": title,
                "source": source,
                "node_ids": list(members),
            })
        return out

    out_g1 = _build(bucket_meta_g1, enabled_g1, user_g1)
    out_g2 = _build(bucket_meta_g2, enabled_g2, user_g2)
    return {"g1": out_g1, "g2": out_g2}


def list_available_groups(stage: str) -> dict[str, list[dict[str, Any]]]:
    """Return every group defined for ``stage`` (enabled and disabled).

    Shape::

        {
          "g1": [{"title": ..., "node_ids": [int, ...]}, ...],
          "g2": [...]
        }

    Used by the confirmation prompt to show the operator the full menu of
    groups they could enable, so they can decide whether to add more before
    committing the run.
    """
    meta = load_groups(stage)
    out: dict[str, list[dict[str, Any]]] = {"g1": [], "g2": []}
    if not isinstance(meta, dict):
        return out
    for bucket in ("g1", "g2"):
        bucket_meta = meta.get(bucket, {})
        if not isinstance(bucket_meta, dict):
            continue
        for title, members in bucket_meta.items():
            if not isinstance(members, list):
                continue
            out[bucket].append({"title": title, "node_ids": list(members)})
    return out


def _apply_group_modes(
    ui: dict, stage: str, extra_g1: list[str], extra_g2: list[str]
) -> None:
    meta = load_groups(stage)
    enabled_g1 = set(DEFAULT_ENABLED_G1) | set(extra_g1)
    enabled_g2 = set(DEFAULT_ENABLED_G2) | set(extra_g2)
    if stage == "i2i":
        enabled_g1.add(LOAD_IMAGE_GROUP)
    node_ids = {
        node.get("id") for node in ui.get("nodes", []) if isinstance(node, dict)
    }
    enable_nodes: set[int] = set()
    bypass_nodes: set[int] = set()
    for bucket, enabled in (("g1", enabled_g1), ("g2", enabled_g2)):
        mapping = meta.get(bucket, {})
        if not isinstance(mapping, dict):
            raise ValueError(f"groups metadata {bucket!r} must be an object")
        for title, members in mapping.items():
            if not isinstance(members, list):
                raise ValueError(f"group {title!r} members must be a list")
            if title in enabled:
                enable_nodes.update(members)
            else:
                bypass_nodes.update(members)
    unknown = (enable_nodes | bypass_nodes) - node_ids
    if unknown:
        raise ValueError(f"groups.json references missing node(s): {sorted(unknown)}")
    for node in ui.get("nodes", []):
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        if node_id in enable_nodes:
            node["mode"] = 0
        elif node_id in bypass_nodes:
            node["mode"] = 4


def _expand_bypassed_subgraphs(ui: dict) -> None:
    """Set bypassed (mode 4) subgraph wrapper nodes to mode 0.

    MCP strip cannot expand bypassed subgraph nodes — it skips them and
    drops their output connections, breaking the image path.  ComfyUI's
    own frontend handles this transparently via ``resolveOutput`` →
    ``_getBypassSlotIndex`` → ``resolveInput`` (type-matching pass-through
    that works for subgraph nodes the same as regular nodes).

    Every subgraph in this workflow has **all** internal nodes in mode 4
    (bypass).  Setting the wrapper to mode 0 lets strip expand the subgraph
    and then correctly pass through the bypassed internal regular nodes —
    identical to what ComfyUI does at runtime, with zero visual effect.

    Only mode 4 is touched.  Mode 2 (Never/Mute) is respected — muted
    subgraphs should stay excluded entirely.
    """
    defs = ui.get("definitions")
    if not isinstance(defs, dict):
        return
    subgraphs = defs.get("subgraphs")
    if not isinstance(subgraphs, list):
        return
    sg_types = {
        sg["id"]
        for sg in subgraphs
        if isinstance(sg, dict) and "id" in sg
    }
    if not sg_types:
        return
    for node in ui.get("nodes", []):
        if not isinstance(node, dict):
            continue
        if node.get("type") in sg_types and node.get("mode") == 4:
            node["mode"] = 0


def patch_ui(
    ui: dict,
    config: RunConfig,
    *,
    stage: str,
    mcp_list_loras,
    uploaded_names: dict[str, str],
) -> dict:
    """Write every config value into the UI graph; return the patched graph.

    ``uploaded_names`` maps a logical image field name (``reference_image``,
    ``controlnet_image``, ``red_image``, ...) to the ComfyUI filename that
    comfyui-mcp returned after uploading.
    """
    ui = deepcopy(ui)

    # 1. Prompts.
    _set_prompt_widget(ui, "24", config.prompt.positive)
    _set_prompt_widget(ui, "25", config.prompt.negative)

    # 2. Region prompts: red/green/blue text -> nodes 3/4/5, plus nodes 17/18/19.
    if config.red_prompt is not None:
        _set_prompt_widget(ui, "3", config.red_prompt)
        _set_widget(ui, "17", "text", config.red_prompt, _WIDGET_INDICES[("17", "text")])
    if config.green_prompt is not None:
        _set_prompt_widget(ui, "4", config.green_prompt)
        _set_widget(ui, "18", "text", config.green_prompt, _WIDGET_INDICES[("18", "text")])
    if config.blue_prompt is not None:
        _set_prompt_widget(ui, "5", config.blue_prompt)
        _set_widget(ui, "19", "text", config.blue_prompt, _WIDGET_INDICES[("19", "text")])

    # 3. Camera coords (node 583).
    if config.camera is not None:
        _apply_camera(ui, config.camera)

    # 4. Camera extra (node 585).
    if config.camera_extra is not None:
        _apply_camera_extra(ui, config.camera_extra)

    # 5. Sampling (node 50 = first-pass params, node 51 = refine KSampler).
    if config.sampling is not None:
        _apply_sampling(ui, config.sampling)

    # 6. Seed (node 65, propagated to node 50/51 via link).
    if config.seed is not None:
        _set_widget(ui, "65", "seed", config.seed, _INT_WIDGETS[("65", "seed")])

    # 7. Image size (nodes 68/71).
    if config.image_size is not None:
        _apply_image_size(ui, config.image_size)

    # 8. LoRA stack (nodes 26 + 66).
    # Always written: with no explicit selections the skill's verified
    # DEFAULT_LORA_PLAN is used. We never inherit the asset's baked text
    # because it can reference filenames that no longer exist on the server.
    lora = config.lora if config.lora is not None else Lora()
    _apply_lora(ui, lora, mcp_list_loras)

    # 9. Group modes (default + user + i2i load_image).
    # User titles were already validated by resolve_enabled_groups before
    # the confirmation prompt; _apply_group_modes trusts the input.
    extra_g1: list[str] = []
    extra_g2: list[str] = []
    if config.groups is not None:
        extra_g1, extra_g2 = list(config.groups.g1), list(config.groups.g2)
    _apply_group_modes(ui, stage, extra_g1, extra_g2)

    # 10. Expand bypassed subgraph nodes for strip compatibility.
    # Must run after group modes are set, so that subgraph wrappers whose
    # groups were left disabled (mode 4) are flipped to mode 0 before strip.
    _expand_bypassed_subgraphs(ui)

    # 11. Image inputs (after group modes - some nodes are gated).
    if config.controlnet_image is not None:
        name = uploaded_names["controlnet_image"]
        _set_widget(ui, "129", "image", name, _WIDGET_INDICES[("129", "image")])
    if config.red_image is not None:
        _set_widget(ui, "0", "image", uploaded_names["red_image"],
                    _WIDGET_INDICES[("0", "image")])
    if config.green_image is not None:
        _set_widget(ui, "1", "image", uploaded_names["green_image"],
                    _WIDGET_INDICES[("1", "image")])
    if config.blue_image is not None:
        _set_widget(ui, "2", "image", uploaded_names["blue_image"],
                    _WIDGET_INDICES[("2", "image")])
    if config.signature_image is not None:
        _set_widget(ui, "116", "image", uploaded_names["signature_image"],
                    _WIDGET_INDICES[("116", "image")])
    # Always set 75's branch selector. The asset defaults 58 to 2 (i2i);
    # for t2i we must overwrite with 1, otherwise 75 forwards an empty
    # latent (VAEEncode bypass) to KSampler 27.
    _set_widget(ui, "58", "value", BRANCH_VALUE[stage], _INT_WIDGETS[("58", "value")])
    if stage == "i2i":
        if config.reference_image is None:
            raise ValueError("i2i requires reference_image")
        _set_widget(ui, "21", "image", uploaded_names["reference_image"],
                    _WIDGET_INDICES[("21", "image")])
        # Apply i2i default denoise only when the user didn't set it
        # explicitly via sampling.denoise_first. _apply_sampling (step 5)
        # already wrote the user's value if present.
        user_denoise = (
            config.sampling.denoise_first
            if config.sampling is not None
            else None
        )
        if user_denoise is None:
            _set_widget(ui, "50", "denoise", I2I_FIRST_PASS_DENOISE,
                        _SAMPLER_WIDGETS[("50", "denoise")])
    return ui


def _apply_camera(ui: dict, camera: Camera) -> None:
    if camera.direction is None or camera.elevation is None or camera.distance is None:
        raise ValueError("camera.direction, camera.elevation, camera.distance are required")
    pos_x, pos_y, pos_z, roll = camera_coords(
        camera.direction, camera.elevation, camera.distance, camera.roll or 0.0
    )
    _set_widget(ui, "583", "pos_x", pos_x, _CAMERA_ANGLE_WIDGETS[("583", "pos_x")])
    _set_widget(ui, "583", "pos_y", pos_y, _CAMERA_ANGLE_WIDGETS[("583", "pos_y")])
    _set_widget(ui, "583", "pos_z", pos_z, _CAMERA_ANGLE_WIDGETS[("583", "pos_z")])
    if camera.roll is not None:
        _set_widget(ui, "583", "roll", camera.roll, _CAMERA_ANGLE_WIDGETS[("583", "roll")])


def _apply_camera_extra(ui: dict, extra: CameraExtra) -> None:
    mapping = {
        "extreme_type": extra.extreme_type,
        "extreme_weight": extra.extreme_weight,
        "lens_enabled": extra.lens_enabled,
        "lens_value": extra.lens_value,
        "dof_enabled": extra.dof_enabled,
        "dof_value": extra.dof_value,
        "dof_weight": extra.dof_weight,
        "movement_enabled": extra.movement_enabled,
        "movement_value": extra.movement_value,
        "composition_enabled": extra.composition_enabled,
        "composition_value": extra.composition_value,
        "style_enabled": extra.style_enabled,
        "style_value": extra.style_value,
    }
    for name, value in mapping.items():
        _set_widget(ui, "585", name, value, _CAMERA_EXTRA_WIDGETS[("585", name)])


def _apply_sampling(ui: dict, sampling) -> None:
    if sampling.steps_first is not None:
        _set_widget(ui, "50", "steps", sampling.steps_first, _SAMPLER_WIDGETS[("50", "steps")])
    if sampling.cfg is not None:
        _set_widget(ui, "50", "cfg", sampling.cfg, _SAMPLER_WIDGETS[("50", "cfg")])
    if sampling.sampler is not None:
        _set_widget(ui, "50", "sampler", sampling.sampler, _SAMPLER_WIDGETS[("50", "sampler")])
    if sampling.scheduler is not None:
        _set_widget(ui, "50", "scheduler", sampling.scheduler, _SAMPLER_WIDGETS[("50", "scheduler")])
    if sampling.denoise_first is not None:
        _set_widget(ui, "50", "denoise", sampling.denoise_first, _SAMPLER_WIDGETS[("50", "denoise")])
    if sampling.steps_refine is not None:
        _set_widget(ui, "51", "steps", sampling.steps_refine, _SAMPLER_WIDGETS[("51", "steps")])
    if sampling.denoise_refine is not None:
        _set_widget(ui, "51", "denoise", sampling.denoise_refine, _SAMPLER_WIDGETS[("51", "denoise")])


def _apply_image_size(ui: dict, image_size) -> None:
    if image_size.width is not None:
        _set_widget(ui, "68", "value", image_size.width, _INT_WIDGETS[("68", "value")])
    if image_size.height is not None:
        _set_widget(ui, "71", "value", image_size.height, _INT_WIDGETS[("71", "value")])


def _apply_lora(ui: dict, lora: Lora, mcp_list_loras) -> None:
    patch = build_lora_patch(lora, mcp_list_loras)
    stack = patch["node_26"]["text"]
    trigger = patch["node_66"]["orinalMessage"]
    selections = patch["selections"]
    # Adversarial check: node 26 must be the Lora Loader (LoraManager) with
    # a version-config dict at idx 0. If idx 0 is a string, the fixed asset
    # has been replaced with the old LoRA Text Loader format — fail-closed
    # rather than silently corrupting the version config widget.
    node = _get_node(ui, "26")
    widgets = node.get("widgets_values", [])
    if not widgets or not isinstance(widgets[0], dict) or "version" not in widgets[0]:
        raise ValueError(
            "node 26 is not the expected Lora Loader (LoraManager) format "
            "(idx 0 must be a version-config dict); the fixed workflow asset "
            "may have been replaced with an older version"
        )
    # Set widgets_values[1] (the text widget — LoRA syntax string)
    _set_widget(ui, "26", "text", stack, _WIDGET_INDICES[("26", "text")])
    # Set widgets_values[2] (the lora_stack widget — structured selections list)
    if len(widgets) >= 3:
        widgets[2] = selections
    _set_widget(ui, "66", "orinalMessage", trigger, _WIDGET_INDICES[("66", "orinalMessage")])


def patch_api_lora(
    api_graph: dict,
    config,
    mcp_list_loras,
) -> dict:
    """Patch node 26 (LoraManager) inputs directly on the API graph.

    Why post-strip: the comfyui-mcp strip process drops the LoraManager's
    three ``__lm_widget_ids``-driven widget values (``__lm_autocomplete_meta_text``,
    ``text``, ``loras``) from the API graph — leaving only the ``model``/``clip``
    links. This kills node 26's required ``text`` input and cascades as
    "Output will be ignored" for every downstream output node (35, 490, 550).

    The UI widget values are still correct (``widgets_values`` is fine); the
    strip just doesn't lift them. We compensate by writing the three widget
    values straight into ``api_graph["26"]["inputs"]`` after strip, then
    patch node 66's trigger-words link + orinalMessage string the same way
    the source skill does for its API-format node 66.

    All writes are "setting a configurable value" — no graph-structure
    changes (no node/link/input-slot mutations).
    """
    lora = config.lora if config.lora is not None else Lora()
    patch = build_lora_patch(lora, mcp_list_loras)
    stack_text = patch["node_26"]["text"]
    trigger_message = patch["node_66"]["orinalMessage"]
    selections = patch["selections"]

    # Adversarial check: node 26 must be the new LoraManager (post-strip
    # class_type must match). Refuse to patch anything else.
    n26 = api_graph.get("26")
    if not isinstance(n26, dict):
        raise ValueError("node 26 missing from API graph (strip dropped it)")
    if n26.get("class_type") != "Lora Loader (LoraManager)":
        raise ValueError(
            f"node 26 class_type mismatch: expected 'Lora Loader (LoraManager)', "
            f"got {n26.get('class_type')!r}; the fixed workflow asset may have "
            "been swapped for an incompatible version"
        )
    inputs26 = n26.get("inputs")
    if not isinstance(inputs26, dict):
        raise ValueError("node 26 'inputs' is not a dict (post-strip API expects dict)")

    # Mirror the three widget values the strip dropped.
    inputs26["__lm_autocomplete_meta_text"] = {
        "version": 1,
        "textWidgetName": "text",
    }
    inputs26["text"] = stack_text
    inputs26["loras"] = {"__value__": selections}

    # Patch node 66 (TriggerWord Toggle) the same way the source skill does:
    # write trigger_words as a link ref to node 26's [2] output, plus the
    # rendered orinalMessage string.
    n66 = api_graph.get("66")
    if isinstance(n66, dict) and isinstance(n66.get("inputs"), dict):
        n66["inputs"]["trigger_words"] = ["26", 2]
        n66["inputs"]["orinalMessage"] = trigger_message

    return api_graph
