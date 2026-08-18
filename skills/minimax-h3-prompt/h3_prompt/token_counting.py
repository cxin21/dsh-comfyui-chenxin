"""Integrity-checked offline token counting for MiniMax-H3."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from chenxin_runtime import TokenizerIntegrityError
from tokenizers import Tokenizer


_REVISION_RE = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class TokenizerManifest:
    snapshot_id: str
    model_id: str
    upstream_repository: str
    upstream_revision: str
    tokenizer_class: str
    model_hard_limit: int
    file_hashes: tuple[tuple[str, str], ...]


class TokenCounter:
    """A verified tokenizer loaded only from a repository-pinned snapshot."""

    def __init__(self, manifest: TokenizerManifest, tokenizer: Tokenizer) -> None:
        self._manifest = manifest
        self._tokenizer = tokenizer

    @classmethod
    def load(cls, snapshot_dir: Path, expected_model: str) -> "TokenCounter":
        snapshot_dir = Path(snapshot_dir)
        manifest_path = snapshot_dir / "manifest.json"
        raw = _read_json(manifest_path, "tokenizer manifest")
        if not isinstance(raw, dict):
            raise TokenizerIntegrityError("tokenizer manifest must be a JSON object")

        snapshot_id = _required_string(raw, "snapshot_id")
        if snapshot_id != expected_model:
            raise TokenizerIntegrityError(
                f"snapshot id mismatch: expected {expected_model!r}, got {snapshot_id!r}"
            )
        if raw.get("schema_version") != 1:
            raise TokenizerIntegrityError("unsupported tokenizer manifest schema")

        revision = _required_string(raw, "upstream_revision")
        if not _REVISION_RE.fullmatch(revision):
            raise TokenizerIntegrityError("upstream_revision must be a 40-character commit SHA")

        hard_limit = raw.get("model_hard_limit")
        if isinstance(hard_limit, bool) or not isinstance(hard_limit, int) or hard_limit <= 0:
            raise TokenizerIntegrityError("model_hard_limit must be a positive integer")

        license_record = raw.get("license")
        if not isinstance(license_record, dict):
            raise TokenizerIntegrityError("license evidence is missing")
        if license_record.get("redistribution_allowed") is not True:
            raise TokenizerIntegrityError("tokenizer snapshot is not approved for redistribution")
        license_url = license_record.get("url")
        if not isinstance(license_url, str) or not license_url.startswith("https://"):
            raise TokenizerIntegrityError("license URL must be an HTTPS URL")

        file_hashes = raw.get("files")
        if not isinstance(file_hashes, dict) or not file_hashes:
            raise TokenizerIntegrityError("tokenizer manifest has no file hashes")
        normalized_hashes: list[tuple[str, str]] = []
        for name, expected_hash in sorted(file_hashes.items()):
            if not isinstance(name, str) or Path(name).name != name:
                raise TokenizerIntegrityError(f"invalid snapshot filename: {name!r}")
            if not isinstance(expected_hash, str) or not re.fullmatch(
                r"[0-9a-f]{64}", expected_hash
            ):
                raise TokenizerIntegrityError(f"invalid SHA-256 for {name!r}")
            path = snapshot_dir / name
            if not path.is_file():
                raise TokenizerIntegrityError(f"snapshot file is missing: {name}")
            actual_hash = _sha256(path)
            if actual_hash != expected_hash:
                raise TokenizerIntegrityError(
                    f"SHA-256 mismatch for {name}: expected {expected_hash}, got {actual_hash}"
                )
            normalized_hashes.append((name, expected_hash))

        actual_names = {path.name for path in snapshot_dir.iterdir() if path.is_file()}
        expected_names = set(file_hashes) | {"manifest.json"}
        if actual_names != expected_names:
            unexpected = sorted(actual_names - expected_names)
            missing = sorted(expected_names - actual_names)
            raise TokenizerIntegrityError(
                f"snapshot file set mismatch: unexpected={unexpected}, missing={missing}"
            )

        config = _read_json(snapshot_dir / "tokenizer_config.json", "tokenizer config")
        tokenizer_class = _required_string(raw, "tokenizer_class")
        if not isinstance(config, dict) or config.get("tokenizer_class") != tokenizer_class:
            raise TokenizerIntegrityError("tokenizer class does not match tokenizer_config.json")
        if "chat_template.json" in file_hashes:
            template = _read_json(snapshot_dir / "chat_template.json", "chat template")
            if not isinstance(template, dict) or template.get("chat_template") != config.get(
                "chat_template"
            ):
                raise TokenizerIntegrityError(
                    "chat_template.json does not match tokenizer_config.json"
                )

        tokenizer_hash = dict(normalized_hashes).get("tokenizer.json")
        if tokenizer_hash is None:
            raise TokenizerIntegrityError("tokenizer.json is missing from the manifest")
        tokenizer = _load_native_tokenizer(
            str((snapshot_dir / "tokenizer.json").resolve()),
            tokenizer_hash,
        )

        manifest = TokenizerManifest(
            snapshot_id=snapshot_id,
            model_id=_required_string(raw, "model_id"),
            upstream_repository=_required_https_url(raw, "upstream_repository"),
            upstream_revision=revision,
            tokenizer_class=tokenizer_class,
            model_hard_limit=hard_limit,
            file_hashes=tuple(normalized_hashes),
        )
        return cls(manifest, tokenizer)

    @property
    def verified(self) -> bool:
        return True

    @property
    def snapshot_id(self) -> str:
        return self._manifest.snapshot_id

    @property
    def model_hard_limit(self) -> int:
        return self._manifest.model_hard_limit

    @property
    def manifest(self) -> TokenizerManifest:
        return self._manifest

    def encode(self, text: str) -> tuple[int, ...]:
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        return tuple(self._tokenizer.encode(text, add_special_tokens=False).ids)

    def count(self, text: str) -> int:
        return len(self.encode(text))

    def count_many(self, parts: Sequence[str]) -> int:
        if any(not isinstance(part, str) for part in parts):
            raise TypeError("every text part must be a string")
        return self.count("".join(parts))


def count_h3_text_context(
    counter: TokenCounter,
    text: str,
    *,
    reference_count: int = 0,
) -> int:
    """Count the exact H3 user-message framing used for prompt conditioning."""

    if counter.snapshot_id != "h3-qwen3-vl":
        raise ValueError("H3 context counting requires the h3-qwen3-vl snapshot")
    if isinstance(reference_count, bool) or not isinstance(reference_count, int):
        raise TypeError("reference_count must be an integer")
    if reference_count < 0:
        raise ValueError("reference_count must be non-negative")

    references = "".join(
        f"Picture {index}: <|vision_start|><|image_pad|><|vision_end|>\n"
        for index in range(1, reference_count + 1)
    )
    rendered = f"<|im_start|>user\n{references}{text}<|im_end|>\n"
    return counter.count(rendered)


def _read_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise TokenizerIntegrityError(f"{label} is missing or invalid: {path}") from exc


def _required_string(raw: dict[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise TokenizerIntegrityError(f"{key} must be a non-empty string")
    return value


def _required_https_url(raw: dict[str, Any], key: str) -> str:
    value = _required_string(raw, key)
    if not value.startswith("https://"):
        raise TokenizerIntegrityError(f"{key} must be an HTTPS URL")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@lru_cache(maxsize=2)
def _load_native_tokenizer(path: str, verified_sha256: str) -> Tokenizer:
    """Reuse only a backend whose exact file hash was verified by the caller."""
    del verified_sha256
    try:
        return Tokenizer.from_file(path)
    except Exception as exc:  # tokenizers exposes several backend exception types
        raise TokenizerIntegrityError("tokenizer.json could not be loaded") from exc

