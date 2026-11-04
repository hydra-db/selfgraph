from __future__ import annotations

import hashlib
import re

from .errors import ValidationError

__all__ = [
    "slug",
    "entity_id",
    "relation_id",
    "normalize_rel_type",
    "preference_id",
    "decision_id",
    "profile_id",
    "source_version_id",
    "chunk_id",
    "quote_label",
    "quote_reltype",
]

_WS = re.compile(r"\s+")
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_PUNCT = re.compile(r"[^a-z0-9\s]+")
_NON_IDENT = re.compile(r"[^a-z0-9]+")
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


def slug(text: str) -> str:
    """Lowercase ``text`` and turn runs of whitespace into single hyphens.

    @param text (str): the text to slugify.
    @return (str): the slugified text.
    """
    return _WS.sub("-", text.strip().lower())


def _canonical_name(name: str) -> str:
    """Canonicalise an entity name so cross-document surface variants collapse.

    Drops punctuation, a leading article, and trailing corporate suffixes so
    "Acme", "Acme, Inc." and "The Acme Corporation" resolve to the same id.

    @param name (str): the raw entity name.
    @return (str): the canonical hyphenated form.
    """
    words = _PUNCT.sub(" ", name.strip().lower()).split()
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
    return f"{slug(type)}:{_canonical_name(name)}"


def normalize_rel_type(type: str) -> str:
    """Canonicalise a relation type to UPPER_SNAKE so case and spacing variants collapse.

    @param type (str): the raw relation type.
    @return (str): the canonical relation type.
    """
    return _NON_IDENT.sub("_", type.strip().lower()).strip("_").upper()


def relation_id(from_entity: str, type: str, to_entity: str) -> str:
    """A hash of ``from_entity``, the normalized ``type``, and ``to_entity``.

    @param from_entity (str): the source entity id.
    @param type (str): the relationship type.
    @param to_entity (str): the target entity id.
    @return (str): the derived relation id.
    """
    return f"relation:{_hash(from_entity, normalize_rel_type(type), to_entity)}"


def preference_id(subject_entity: str, kind: str, key: str, value_entity: str) -> str:
    """A hash of ``subject_entity``, ``kind``, ``key``, and ``value_entity``.

    @param subject_entity (str): the subject entity id.
    @param kind (str): the preference kind.
    @param key (str): the preference dimension key.
    @param value_entity (str): the value entity id.
    @return (str): the derived preference id.
    """
    return f"preference:{_hash(subject_entity, kind, key, value_entity)}"


def decision_id(actor_entity: str | None, title: str) -> str:
    """A hash of ``actor_entity`` and ``title``.

    @param actor_entity (str | None): the actor entity id, if any.
    @param title (str): the decision title.
    @return (str): the derived decision id.
    """
    return f"decision:{_hash(actor_entity, title)}"


def profile_id(subject_entity: str) -> str:
    """The profile node ID for a subject. One profile per entity.

    @param subject_entity (str): the subject entity id.
    @return (str): the profile node id.
    """
    return f"profile:{subject_entity}"


def source_version_id(source_id: str, created_at_iso: str, content_hash: str) -> str:
    """A unique ID for one insert of a source.

    Every insert of a source creates a new source version, even with identical
    content, so the created-at timestamp is part of the ID.

    @param source_id (str): the source id.
    @param created_at_iso (str): the insert timestamp as ISO text.
    @param content_hash (str): a digest of the source content.
    @return (str): the derived source version id.
    """
    return f"sv:{_hash(source_id, created_at_iso, content_hash)}"


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
