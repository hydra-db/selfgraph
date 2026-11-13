from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from collections.abc import Mapping
from datetime import date
from typing import Any

from .errors import ValidationError

__all__ = [
    "slug",
    "entity_id",
    "canonical_entity_id",
    "relation_id",
    "normalize_rel_type",
    "preference_id",
    "decision_id",
    "profile_id",
    "source_node_id",
    "source_version_id",
    "chunk_id",
    "evidence_id",
    "quote_label",
    "quote_reltype",
]


def _has_surrogate(text: str) -> bool:
    """Report whether text contains a lone surrogate code point, which cannot be UTF-8 encoded.

    @param text (str): the text to inspect.
    @return (bool): True when a surrogate character is present.
    """
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in text)


def _unstorable(text: str) -> bool:
    """Report whether text holds a NUL or a lone surrogate, which some backends cannot store or encode.

    @param text (str): the text to inspect.
    @return (bool): True when a NUL or surrogate character is present.
    """
    return "\x00" in text or _has_surrogate(text)


def _has_control(text: str) -> bool:
    """Report whether text contains a C0/C1 control character, DEL, or a lone surrogate.

    @param text (str): the text to inspect.
    @return (bool): True when a control or surrogate character is present.
    """
    return any(ord(ch) < 0x20 or 0x7F <= ord(ch) <= 0x9F or 0xD800 <= ord(ch) <= 0xDFFF for ch in text)


_MAX_JSON_DEPTH = 64
MAX_SAFE_INTEGER = 2**53 - 1


def _require_clean_json(name: str, value: object, depth: int = 0, *, safe_ints: bool = True) -> None:
    """Validate a stored JSON value: bounded nesting, clean string keys, and UTF-8-emittable string values.

    The depth guard keeps a pathological nested value from exhausting the Python stack (a raw RecursionError
    out of the typed API); the key check mirrors the identifier hygiene applied elsewhere; the value check
    rejects a lone surrogate that would store but then break any later UTF-8 encode of the retrieved object.

    @param name (str): the field name for error messages.
    @param value (object): the JSON-shaped value to validate.
    @param depth (int): the current nesting depth, for the recursion guard.
    @param safe_ints (bool): reject integers outside +/-(2**53 - 1), which JSON readers in other languages round.
    @return (None): nothing; raises ValidationError on excess depth, a control/surrogate key, a surrogate value, an
        unsafe integer, or a date or datetime.
    """
    if depth > _MAX_JSON_DEPTH:
        raise ValidationError(f"{name} is nested too deeply; keep it under {_MAX_JSON_DEPTH} levels")
    if isinstance(value, str):
        if _unstorable(value):
            raise ValidationError(f"{name} values cannot contain NUL or unpaired surrogate characters")
    elif isinstance(value, int) and not isinstance(value, bool):
        if safe_ints and abs(value) > MAX_SAFE_INTEGER:
            raise ValidationError(f"{name} integer {value} is outside the safe range; store it as a string")
    elif isinstance(value, date):
        raise ValidationError(f"{name} cannot hold {type(value).__name__} values; use an ISO 8601 string")
    elif isinstance(value, Mapping):
        for key, item in value.items():
            if isinstance(key, str) and _has_control(key):
                raise ValidationError(f"{name} keys cannot contain control or surrogate characters")
            _require_clean_json(name, item, depth + 1, safe_ints=safe_ints)
    elif isinstance(value, list | tuple):
        for item in value:
            _require_clean_json(name, item, depth + 1, safe_ints=safe_ints)


def _require_str(label: str, value: object) -> None:
    """Validate a value is a non-empty string with no control or surrogate characters.

    @param label (str): the field name for the error message.
    @param value (object): the value to check.
    @return (None): nothing; raises ValidationError when not a clean, non-empty string.
    """
    if not isinstance(value, str):
        raise ValidationError(f"{label} must be a string, got {type(value).__name__}")
    if not value.strip():
        raise ValidationError(f"{label} cannot be empty")
    _require_no_control(label, value)


def _require_unit(label: str, value: object, *, finite: bool = False) -> None:
    """Validate a value is a real number in the unit interval.

    @param label (str): the field name for the error message.
    @param value (object): the value to check.
    @param finite (bool): reject NaN and infinity with their own message before the range check.
    @return (None): nothing; raises ValidationError when non-numeric or out of range.
    """
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValidationError(f"{label} must be a number, got {type(value).__name__}")
    if finite and not math.isfinite(value):
        raise ValidationError(f"{label} must be a finite number")
    if not 0.0 <= value <= 1.0:
        raise ValidationError(f"{label} must be between 0 and 1, got {value}")


def _require_namespace(value: object) -> None:
    """Validate a namespace: a non-empty string with no control characters and no leading or trailing whitespace.

    @param value (object): the namespace.
    @return (None): nothing; raises ValidationError on a bad namespace.
    """
    _require_str("namespace", value)
    if value != value.strip():  # type: ignore[union-attr]
        raise ValidationError("namespace cannot start or end with whitespace")


def _require_no_control(label: str, value: str) -> None:
    """Reject text holding a control or surrogate character.

    @param label (str): the field name for the error message.
    @param value (str): the text to check.
    @return (None): nothing; raises ValidationError when a control or surrogate character is present.
    """
    if _has_control(value):
        raise ValidationError(f"{label} cannot contain control or surrogate characters")


_WS = re.compile(r"\s+")
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_PUNCT = re.compile(r"[^\w\s]+")
_NON_IDENT = re.compile(r"[^\w]+")
_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
_ENTITY_SUFFIXES = frozenset(
    {
        "inc",
        "incorporated",
        "corp",
        "corporation",
        "co",
        "company",
        "ltd",
        "limited",
        "llc",
        "llp",
        "lp",
        "plc",
        "group",
        "holdings",
        "gmbh",
        "ag",
        "sa",
        "nv",
        "the",
    }
)
_ORG_TYPES = frozenset(
    {
        "company",
        "organization",
        "organisation",
        "org",
        "corporation",
        "corp",
        "business",
        "firm",
        "institution",
        "agency",
        "employer",
        "vendor",
        "bank",
    }
)


def _hash(*parts: str | None) -> str:
    """A stable 24-hex-char digest of the given parts, order-sensitive.

    Uses a tagged, length-prefixed, NUL-separated encoding so ("a", "bc") and
    ("ab", "c") never collide, and None is distinct from the empty string.

    @param parts (str | None): the parts to hash, in order.
    @return (str): a 24-hex-char digest.
    """
    h = hashlib.blake2b(digest_size=12)
    for part in parts:
        if part is None:
            h.update(b"N\x00")
            continue
        h.update(b"S")
        h.update(str(len(part)).encode("utf-8"))
        h.update(b"\x00")
        h.update(part.encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


def normalize_text(value: str) -> str:
    """NFC-normalize text so an id, its stored field, and a filter argument share one byte form.

    @param value (str): the text to normalize.
    @return (str): the NFC-normalized text.
    """
    return unicodedata.normalize("NFC", value)


def slug(text: str) -> str:
    """Lowercase ``text`` and turn runs of whitespace into single hyphens.

    @param text (str): the text to slugify.
    @return (str): the slugified text.
    """
    return _WS.sub("-", text.strip().lower())


def _canonical_name(type: str, name: str) -> str:
    """Canonicalise an entity name so cross-document surface variants collapse.

    Drops punctuation for every type; for organisation-like types it also drops a
    leading article and trailing corporate suffixes, so "Acme", "Acme, Inc." and
    "The Acme Corporation" resolve to one id while a Work "The Trial" stays distinct
    from "Trial".

    @param type (str): the entity type, which scopes suffix and article stripping.
    @param name (str): the raw entity name.
    @return (str): the canonical hyphenated form.
    """
    name = normalize_text(name)
    words = _PUNCT.sub(" ", name.strip().lower()).split()
    if slug(type) in _ORG_TYPES:
        if words and words[0] == "the":
            words = words[1:]
        while len(words) > 1 and words[-1] in _ENTITY_SUFFIXES:
            words = words[:-1]
    return "-".join(words) if words else slug(name)


def entity_id(type: str, name: str) -> str:
    """``<type>:<canonical-name>``, so surface variants of one entity share an id.

    @param type (str): the entity type.
    @param name (str): the entity name.
    @return (str): the derived entity id.
    """
    _require_str("entity type", type)
    _require_str("entity name", name)
    type = normalize_text(type)
    return f"{slug(type)}:{_canonical_name(type, name)}"


def _canonical_id(eid: Any) -> Any:
    """Canonicalise an entity id without validating it; text without a colon, or a non-string, is returned as is.

    @param eid (Any): the entity id as given.
    @return (Any): the canonical entity id, or eid unchanged when it has no colon or is not a string.
    """
    if not isinstance(eid, str) or ":" not in eid:
        return eid
    prefix, name = eid.split(":", 1)
    return f"{slug(normalize_text(prefix))}:{slug(normalize_text(name))}"


def _require_entity_shape(eid: str) -> None:
    """Reject an entity id that is not 'type:name' with a non-empty type and name.

    @param eid (str): the entity id.
    @return (None): nothing; raises ValidationError on a malformed id.
    """
    if ":" not in eid:
        raise ValidationError(f"entity id must be 'type:name', e.g. 'person:jane', got {eid!r}")
    prefix_part, name_part = eid.split(":", 1)
    if not prefix_part.strip() or not name_part.strip():
        raise ValidationError(f"entity id must be 'type:name' with a non-empty prefix and name, got {eid!r}")


def canonical_entity_id(eid: str) -> str:
    """Canonicalise an explicit entity id the way entity_id shapes a derived one, so case and spacing variants match.

    The type prefix and the name part, split at the first colon, are each NFC-normalized, lowercased, stripped,
    and have whitespace runs turned into single hyphens.

    @param eid (str): the entity id as given.
    @return (str): the canonical entity id; raises ValidationError when it is not a 'type:name' string with a
        non-empty type and name.
    """
    _require_str("entity id", eid)
    eid = _canonical_id(eid)
    _require_entity_shape(eid)
    return eid


def normalize_rel_type(type: str) -> str:
    """Canonicalise a relation type to UPPER_SNAKE so case, spacing, and camelCase variants collapse.

    @param type (str): the raw relation type.
    @return (str): the canonical relation type.
    """
    _require_str("relation type", type)
    normalized = _NON_IDENT.sub("_", _CAMEL.sub("_", normalize_text(type).strip()).lower()).strip("_").upper()
    if not normalized:
        raise ValidationError("relation type cannot be empty; use a verb phrase, e.g. 'works at' or 'WORKS_AT'")
    return normalized


def relation_id(from_entity: str, type: str, to_entity: str) -> str:
    """A hash of ``from_entity``, the normalized ``type``, and ``to_entity``.

    @param from_entity (str): the source entity id.
    @param type (str): the relationship type.
    @param to_entity (str): the target entity id.
    @return (str): the derived relation id.
    """
    _require_str("from_entity", from_entity)
    _require_str("to_entity", to_entity)
    return f"relation:{_hash(from_entity, normalize_rel_type(type), to_entity)}"


def preference_id(subject_entity: str, stance: str, key: str, value_entity: str) -> str:
    """A hash of ``subject_entity``, ``stance``, ``key``, and ``value_entity``.

    @param subject_entity (str): the subject entity id.
    @param stance (str): the preference stance.
    @param key (str): the preference dimension key.
    @param value_entity (str): the value entity id.
    @return (str): the derived preference id.
    """
    _require_str("subject_entity", subject_entity)
    _require_str("preference stance", stance)
    _require_str("preference key", key)
    _require_str("value_entity", value_entity)
    return f"preference:{_hash(subject_entity, stance, normalize_text(key), value_entity)}"


def decision_id(actor_entity: str | None, title: str) -> str:
    """A hash of ``actor_entity`` and ``title``.

    @param actor_entity (str | None): the actor entity id, if any.
    @param title (str): the decision title.
    @return (str): the derived decision id.
    """
    if actor_entity is not None:
        _require_str("actor_entity", actor_entity)
    _require_str("decision title", title)
    return f"decision:{_hash(actor_entity, normalize_text(title))}"


def profile_id(subject_entity: str) -> str:
    """The profile node ID for a subject. One profile per entity.

    @param subject_entity (str): the subject entity id.
    @return (str): the profile node id.
    """
    _require_str("subject_entity", subject_entity)
    return f"profile:{subject_entity}"


def source_node_id(source_id: str) -> str:
    """The internal source node ID, namespaced so it never collides with an entity id.

    @param source_id (str): the caller's source id.
    @return (str): the derived source node id.
    """
    _require_str("source_id", source_id)
    return f"source:{source_id}"


def source_version_id(source_id: str, content_hash: str) -> str:
    """A content-addressed ID for a version of a source.

    The ID is derived from the source id and a content digest, so re-inserting the
    same content reuses one version rather than minting a new one on every retry.

    @param source_id (str): the source id.
    @param content_hash (str): a digest of the source content.
    @return (str): the derived source version id.
    """
    _require_str("source_id", source_id)
    return f"sv:{_hash(source_id, content_hash)}"


def content_hash(content: bytes) -> str:
    """A stable digest of raw source content.

    @param content (bytes): the raw source content.
    @return (str): a stable digest.
    """
    return hashlib.blake2b(content, digest_size=12).hexdigest()


def chunk_id(source_version: str, index: int) -> str:
    """The ID of chunk ``index`` within a source version.

    @param source_version (str): the source version id.
    @param index (int): the chunk index.
    @return (str): the derived chunk id.
    """
    return f"{source_version}:chunk:{index}"


def evidence_id(
    target_id: str,
    source_id: str,
    source_version: str,
    chunk_id: str | None,
    quote: str | None,
    start_offset: int | None,
    end_offset: int | None,
) -> str:
    """The ID of one evidence record: a hash of the fact it supports and where in which source it was seen.

    @param target_id (str): the id of the entity or relation the evidence supports.
    @param source_id (str): the source id.
    @param source_version (str): the source version id.
    @param chunk_id (str | None): the chunk id, or None for source-level evidence.
    @param quote (str | None): the quoted text, or None.
    @param start_offset (int | None): the quote's start offset, or None.
    @param end_offset (int | None): the quote's end offset, or None.
    @return (str): the derived evidence id.
    """
    offsets = [None if o is None else str(o) for o in (start_offset, end_offset)]
    return f"evidence:{_hash(target_id, source_id, source_version, chunk_id, quote, *offsets)}"


def entity_merge_id(survivor_id: str, absorbed_id: str) -> str:
    """The id of the record of one entity merge: a hash of the surviving and the absorbed entity ids.

    @param survivor_id (str): the id of the entity that absorbed the other.
    @param absorbed_id (str): the id the absorbed entity would have had.
    @return (str): the derived merge record id.
    """
    _require_str("survivor_id", survivor_id)
    _require_str("absorbed_id", absorbed_id)
    return f"entitymerge:{_hash(survivor_id, absorbed_id)}"


RESERVED_ID_PREFIXES = frozenset(
    {"relation", "preference", "decision", "profile", "source", "sv", "evidence", "entitymerge"}
)


def step_id(trace_id: str, order: int) -> str:
    """The id of a decision step node: the trace id, then ":step:" and the step's order.

    @param trace_id (str): the decision trace id.
    @param order (int): the step's position in the trace.
    @return (str): the step node id.
    """
    return f"{trace_id}:step:{order}"


def trace_of_step(sid: str) -> str:
    """The decision trace id a step node id belongs to.

    @param sid (str): the step node id.
    @return (str): the trace id.
    """
    return sid.rsplit(":step:", 1)[0]


def quote_label(name: str) -> str:
    """Render ``name`` as a Cypher label, backtick-quoting when it is not a plain identifier.

    Internal backticks are doubled, as Cypher requires.

    @param name (str): the label or type name to render.
    @return (str): the rendered Cypher label.
    """
    if not name or not name.strip():
        raise ValidationError("label / type names cannot be empty")
    if _IDENT.match(name):
        return name
    escaped = name.replace("`", "``")
    return f"`{escaped}`"


quote_reltype = quote_label
