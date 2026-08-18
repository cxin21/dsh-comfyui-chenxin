"""The H3 authoring dialect: turn a story into model-native prompt text.

The code owns every structural rule of the dialect:

* mode-specific alignment preambles for ``i2va`` / ``fl2va`` / ``l2va``;
* shot markers sequential from 1, first shot without a timestamp;
* later shots start ``At MM:SS.mmm,`` with a model-native cut phrase;
* dialogue preserved byte-for-byte inside ``<d>[Language] ...</d>``;
* t2va renders 3 fields, ref2va renders 6 fields, in the fixed order;
* picture / subject / video / audio labels numbered independently;
* a parallel Chinese skeleton ``text_zh`` is emitted alongside ``text``.

Chinese translation policy: this module only translates *structural tokens*
(field headers, shot markers, timestamps, reference labels, dialogue blocks,
``N/A``, ``[reference generation]``). The prose between those tokens is left
untouched. The calling model — which authored the English prompt and is the
best translator of its own output — is responsible for any literary Chinese
translation on top of the skeleton.
"""

from __future__ import annotations

import re

from .contracts import (
    KEYFRAME_STAGES,
    Reference,
    Shot,
    StoryRequest,
)


_CJK = re.compile(r"[\u4e00-\u9fff]")
_KANA = re.compile(r"[\u3040-\u30ff]")
_END_PUNCT = ".!?…"


def format_timestamp(seconds: float) -> str:
    total_ms = int(round(seconds * 1000))
    minutes, rem = divmod(total_ms, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{minutes:02d}:{secs:02d}.{ms:03d}"


def format_duration_two_decimals(seconds: float) -> str:
    return f"{seconds:.2f}"


def shot_cut_times(duration_seconds: float, shot_count: int) -> list[str | None]:
    """Cut instant per shot; the first shot has none."""
    return [None] + [
        duration_seconds * index / shot_count for index in range(1, shot_count)
    ]


def detect_language(text: str) -> str:
    if _CJK.search(text):
        return "中文"
    if _KANA.search(text):
        return "日本語"
    return "English"


def _trim_punct(text: str) -> str:
    text = text.strip()
    while text and text[-1] in _END_PUNCT:
        text = text[:-1].rstrip()
    return text


def _subject_labels(references: tuple[Reference, ...]) -> dict[str, int]:
    return {ref.who: index for index, ref in enumerate(references, start=1)}


def _apply_subject_labels(text: str, shot: Shot, labels: dict[str, int]) -> str:
    if shot.who and shot.who in labels:
        text = text.replace(shot.who, f"<Subject {labels[shot.who]}>")
    return text


def _build_dialogue(shot: Shot) -> str:
    if not shot.dialogue:
        return ""
    language = shot.language or detect_language(shot.dialogue)
    return f" <d>[{language}] {shot.dialogue}</d>"


def build_shot_lines(
    request: StoryRequest,
    *,
    subject_labels: dict[str, int] | None = None,
) -> list[str]:
    labels = subject_labels or {}
    times = shot_cut_times(request.duration_seconds, len(request.shots))
    lines: list[str] = []
    for index, (shot, cut) in enumerate(zip(request.shots, times), start=1):
        what = _trim_punct(shot.what)
        what = _apply_subject_labels(what, shot, labels)
        if cut is None:
            body = f"[Shot {index}] {what}."
        else:
            body = (
                f"[Shot {index}] At {format_timestamp(cut)}, "
                f"the camera cuts to {what}."
            )
        body += _build_dialogue(shot)
        lines.append(body)
    return lines


def _soundscape(shots: tuple[Shot, ...]) -> str:
    parts = [shot.ambient.strip() for shot in shots if shot.ambient and shot.ambient.strip()]
    return "; ".join(parts) if parts else "N/A"


def _music(shots: tuple[Shot, ...]) -> str:
    parts = [shot.music.strip() for shot in shots if shot.music and shot.music.strip()]
    return "; ".join(parts) if parts else "N/A"


# ── Mode-specific alignment preambles (keyframe stages only) ──────────────


def alignment_preamble(stage: str, request: StoryRequest) -> str:
    if stage == "i2va":
        return (
            "For the target video, at 0.00 seconds into the target video, "
            "<Picture 1> (from [Shot 1]) is fully referenced."
        )
    if stage == "fl2va":
        last_shot = len(request.shots)
        duration = format_duration_two_decimals(request.duration_seconds)
        return (
            "How the reference pictures align with the target video — "
            f"Picture 1 (from Shot 1) aligns with the 0.00-second mark of the "
            f"target video; Picture 2 (from Shot {last_shot}) aligns with the "
            f"{duration}-second mark of the target video."
        )
    if stage == "l2va":
        last_shot = len(request.shots)
        duration = format_duration_two_decimals(request.duration_seconds)
        return (
            "How the reference pictures align with the target video — "
            f"<Picture 1> (from [Shot {last_shot}]) aligns with the "
            f"{duration}-second mark of the target video."
        )
    return ""


# ── Text builders ─────────────────────────────────────────────────────────


def build_t2va_text(request: StoryRequest) -> str:
    description = " ".join(build_shot_lines(request))
    return (
        f"integrated_multimodal_description: {description}\n\n"
        f"overall_soundscape: {_soundscape(request.shots)}\n\n"
        f"non_diegetic_music: {_music(request.shots)}"
    )


def build_keyframe_text(stage: str, request: StoryRequest) -> str:
    preamble = alignment_preamble(stage, request)
    description = " ".join(build_shot_lines(request))
    body = (
        f"integrated_multimodal_description: {description}\n\n"
        f"overall_soundscape: {_soundscape(request.shots)}\n\n"
        f"non_diegetic_music: {_music(request.shots)}"
    )
    return f"{preamble}\n\n{body}" if preamble else body


def build_ref2va_text(request: StoryRequest) -> str:
    labels = _subject_labels(request.references)
    subject_definitions = "\n".join(
        f"<Subject {index}> is {ref.who} from <Picture {index}>."
        for index, ref in enumerate(request.references, start=1)
    )
    cast = ", ".join(
        f"{ref.who} (<Picture {index}>)"
        for index, ref in enumerate(request.references, start=1)
    )
    duration = request.duration_seconds
    duration_text = f"{duration:g}"
    verb = "appears" if len(request.references) == 1 else "appear"
    summary = (
        f"[reference generation] {cast} {verb} in a {duration_text}-second, "
        f"{len(request.shots)}-shot video with synchronized audio."
    )
    retention_analysis = "\n".join(
        f"<Subject {index}> from <Picture {index}> remains fully_preserved: "
        f"identity, face, outfit, and styling unchanged across all shots."
        for index in range(1, len(request.references) + 1)
    )
    detailed = " ".join(build_shot_lines(request, subject_labels=labels))
    return (
        f"subject_definitions: {subject_definitions}\n\n"
        f"summary: {summary}\n\n"
        f"retention_analysis: {retention_analysis}\n\n"
        f"detailed_description: {detailed}\n\n"
        f"overall_soundscape: {_soundscape(request.shots)}\n\n"
        f"non_diegetic_music: {_music(request.shots)}"
    )


def build_text(stage: str, request: StoryRequest) -> str:
    if stage == "t2va":
        return build_t2va_text(request)
    if stage in KEYFRAME_STAGES:
        return build_keyframe_text(stage, request)
    if stage == "ref2va":
        return build_ref2va_text(request)
    raise ValueError(f"unknown stage: {stage!r}")


# ── Chinese skeleton translation ──────────────────────────────────────────

_FIELD_HEADERS_ZH = {
    "integrated_multimodal_description": "整合多模态描述",
    "overall_soundscape": "整体声音景观",
    "non_diegetic_music": "非叙事音乐",
    "subject_definitions": "主体定义",
    "summary": "摘要",
    "retention_analysis": "保持性分析",
    "detailed_description": "详细描述",
}


def _kind_zh(kind: str) -> str:
    return {
        "Subject": "主体",
        "Picture": "图片",
        "Video": "视频",
        "Audio": "音频",
    }.get(kind, kind)


def _skeleton_tokenize(text: str) -> str:
    """Translate only structural tokens. English prose passes through verbatim."""
    out = text
    out = re.sub(
        r"\[Shot (?P<n>\d+)\]",
        lambda m: f"[镜头 {m.group('n')}]",
        out,
    )
    out = re.sub(
        r"At (?P<ts>\d{2}:\d{2}\.\d{3}),",
        lambda m: f"在 {m.group('ts')}，",
        out,
    )
    out = re.sub(
        r"<(Subject|Picture|Video|Audio) (?P<n>\d+)>",
        lambda m: f"<{_kind_zh(m.group(1))} {m.group('n')}>",
        out,
    )
    out = re.sub(
        r"\bPicture (?P<n>\d+)\b",
        lambda m: f"图片 {m.group('n')}",
        out,
    )
    out = re.sub(
        r"\bShot (?P<n>\d+)\b",
        lambda m: f"第 {m.group('n')} 镜",
        out,
    )
    out = re.sub(
        r"\bN/A\b",
        "无",
        out,
    )
    out = re.sub(
        r"\[reference generation\]",
        "[参考生成]",
        out,
    )
    return out


def build_text_zh(text_en: str) -> str:
    """Build a Chinese skeleton: structural tokens translated, prose verbatim.

    The caller (the LLM that authored the English prompt) is responsible for
    any literary Chinese translation on top. The skeleton is for orientation
    only — every line still maps 1:1 to the English prompt.
    """
    out_lines: list[str] = []
    for line in text_en.split("\n"):
        stripped = line.strip()
        if not stripped:
            out_lines.append("")
            continue
        header_match = re.match(r"^([a-z_]+):\s?(.*)$", stripped)
        if header_match and header_match.group(1) in _FIELD_HEADERS_ZH:
            field = header_match.group(1)
            body = header_match.group(2)
            translated_body = _skeleton_tokenize(body) if body else ""
            out_lines.append(f"{_FIELD_HEADERS_ZH[field]}: {translated_body}".rstrip())
            continue
        out_lines.append(_skeleton_tokenize(stripped))
    return "\n".join(out_lines).strip()


def build_text_pair(stage: str, request: StoryRequest) -> tuple[str, str]:
    """Build the (English, Chinese skeleton) pair."""
    text_en = build_text(stage, request)
    text_zh = build_text_zh(text_en)
    return text_en, text_zh