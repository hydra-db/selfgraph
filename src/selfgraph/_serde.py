from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache, wraps
from typing import Any

from .errors import ValidationError, stored_data_error
from .models import (
    DecisionStep,
    DecisionTrace,
    Entity,
    Evidence,
    Preference,
    Relation,
    SourceVersion,
)

_ISO_TIME = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})"
    r"(?:[Tt ]([0-9]{2})(?::([0-9]{2})(?::([0-9]{2})(?:[.,]([0-9]{1,9}))?)?)?)?"
    r"(?:[ \t\n\r\f\v]*(Z|z|[+-][0-9]{2}(?::?[0-9]{2}(?::?[0-9]{2})?)?))?"
)
L_ENTITY = "Entity"
L_PROFILE = "Profile"
L_TRACE = "DecisionTrace"
L_STEP = "DecisionStep"
L_SOURCE = "Source"
L_SOURCE_VERSION = "SourceVersion"
L_CHUNK = "Chunk"
L_EVIDENCE = "Evidence"
L_MERGE = "EntityMerge"
L_MERGE_ENTRY = "EntityMergeEntry"
ABOUT_DROPPED = "about_dropped"

R_HAS_PROFILE = "HAS_PROFILE"
R_PREFERS = "PREFERS"
R_AVOIDS = "AVOIDS"
R_MADE_DECISION = "MADE_DECISION"
R_HAS_STEP = "HAS_STEP"
R_FROM = "FROM"
R_TO = "TO"
R_RESULTED_IN = "RESULTED_IN"
R_CONSIDERED = "CONSIDERED"
R_HAS_VERSION = "HAS_VERSION"
R_HAS_CHUNK = "HAS_CHUNK"

LABELS = (L_ENTITY, L_PROFILE, L_TRACE, L_STEP, L_SOURCE, L_SOURCE_VERSION, L_CHUNK, L_EVIDENCE, L_MERGE, L_MERGE_ENTRY)
EDGE_TYPES = frozenset(
    {
        R_HAS_PROFILE,
        R_PREFERS,
        R_AVOIDS,
        R_MADE_DECISION,
        R_HAS_STEP,
        R_FROM,
        R_TO,
        R_RESULTED_IN,
        R_CONSIDERED,
        R_HAS_VERSION,
        R_HAS_CHUNK,
    }
)
_PREFERENCE_EDGES = {"preference": R_PREFERS, "disinterest": R_AVOIDS}
PREFERENCE_EDGE_TYPES = tuple(_PREFERENCE_EDGES.values())
_STANCE_OF_EDGE = {etype: stance for stance, etype in _PREFERENCE_EDGES.items()}


def preference_edge_type(stance: str) -> str:
    """The edge type that stores a preference of the given stance.

    @param stance (str): the preference stance.
    @return (str): R_PREFERS or R_AVOIDS.
    """
    return _PREFERENCE_EDGES[stance]


def preference_stance_of(etype: str) -> str | None:
    """The preference stance an edge type stores, or None when the edge is not a preference.

    @param etype (str): the edge type.
    @return (str | None): the stance.
    """
    return _STANCE_OF_EDGE.get(etype)


def child_edge_id(edge_type: str, child_id: str) -> str:
    """The id of the internal edge that links a parent node to its profile, version, or chunk child.

    @param edge_type (str): R_HAS_PROFILE, R_HAS_VERSION, or R_HAS_CHUNK; its lowercased letters prefix the id.
    @param child_id (str): the child node id.
    @return (str): the edge id, e.g. "hasversion:<child_id>".
    """
    return f"{edge_type.replace('_', '').lower()}:{child_id}"


def now() -> datetime:
    return datetime.now(timezone.utc)


def aware(dt: datetime) -> datetime:
    """Read a naive datetime as UTC, as storage does, so it compares with aware ones.

    @param dt (datetime): the datetime.
    @return (datetime): the timezone-aware datetime.
    """
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def to_iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return aware(dt).astimezone(timezone.utc).isoformat()


def json_iso(dt: datetime | None) -> str | None:
    """Format a datetime for a user-facing message the way JSON output does: UTC, "T", and a "Z" suffix.

    @param dt (datetime | None): the datetime, or None.
    @return (str | None): the ISO text, or None.
    """
    iso = to_iso(dt)
    return None if iso is None else f"{iso.removesuffix('+00:00')}Z"


def _parse_iso(text: str) -> datetime:
    """Parse the ISO 8601 forms both SDKs accept, with one grammar on every Python version.

    @param text (str): the ISO text.
    @return (datetime): the timezone-aware datetime; raises ValueError when the text does not match or a field is
        out of range.
    """
    m = _ISO_TIME.fullmatch(text)
    if m is None:
        raise ValueError(f"not an ISO 8601 date or time: {text!r}")
    year, month, day, hour, minute, second, fraction, tz = m.groups()
    offset = timezone.utc
    if tz and tz not in ("Z", "z"):
        digits = tz[1:].replace(":", "")
        hours, minutes, seconds = int(digits[:2]), int(digits[2:4] or 0), int(digits[4:6] or 0)
        if hours > 23 or minutes > 59 or seconds > 59:
            raise ValueError(f"UTC offset out of range: {tz!r}")
        sign = -1 if tz[0] == "-" else 1
        offset = timezone(sign * timedelta(hours=hours, minutes=minutes, seconds=seconds))
    micro = int(fraction[:6].ljust(6, "0")) if fraction else 0
    return datetime(
        int(year), int(month), int(day), int(hour or 0), int(minute or 0), int(second or 0), micro, tzinfo=offset
    )


_cached_iso = lru_cache(maxsize=1024)(_parse_iso)


def from_iso(value: Any) -> datetime | None:
    """Parse an ISO 8601 datetime, honoring a trailing Z/z as UTC.

    @param value (Any): the value to parse.
    @return (datetime | None): the parsed datetime, or None.
    """
    if value is None or isinstance(value, datetime):
        return value
    return _cached_iso(value) if isinstance(value, str) and len(value) <= 40 else _parse_iso(value)


def _dumps(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, allow_nan=False)
    except ValueError as exc:
        raise ValidationError(f"value is not JSON-serializable: {str(exc).partition(': ')[0]}") from exc
    except (TypeError, RecursionError) as exc:
        raise ValidationError(f"value is not JSON-serializable: {exc}") from exc


def _loads(value: Any, fallback: Any) -> Any:
    if value is None:
        return fallback
    if isinstance(value, dict | list):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback


def encode_evidence_props(*, ns: str, id: str, target_id: str, evidence: Evidence) -> dict[str, Any]:
    return {"id": id, "ns": ns, "target_id": target_id, **evidence.model_dump()}


def _stored_decode(fn):
    """Translate malformed stored fields at every typed decoder."""

    @wraps(fn)
    def decode(props, *args, **kwargs):
        """Decode one stored record."""
        try:
            return fn(props, *args, **kwargs)
        except (KeyError, ValueError, TypeError, AttributeError, OverflowError):
            raise stored_data_error(props) from None

    return decode


@_stored_decode
def decode_evidence(props: dict[str, Any]) -> Evidence:
    return Evidence.model_validate({k: props.get(k) for k in Evidence.model_fields})


def encode_entity_props(
    *,
    ns: str,
    id: str,
    type: str,
    name: str,
    aliases: list[str],
    external_ids: dict[str, str],
    properties: dict[str, Any],
    source_count: int,
    created_at: datetime,
    updated_at: datetime,
    relevance: float | None = None,
    relevance_at: datetime | None = None,
) -> dict[str, Any]:
    return {
        "id": id,
        "ns": ns,
        "type": type,
        "name": name,
        "aliases": list(aliases),
        "external_ids_json": _dumps(external_ids),
        "properties_json": _dumps(properties),
        "source_count": source_count,
        "created_at": to_iso(created_at),
        "updated_at": to_iso(updated_at),
        **relevance_props(relevance, relevance_at),
    }


def relevance_props(relevance: float | None, relevance_at: datetime | None) -> dict[str, Any]:
    """The stored relevance fields of a node or edge, empty when it was never scored.

    @param relevance (float | None): the relevance score, or None.
    @param relevance_at (datetime | None): when the score was computed.
    @return (dict[str, Any]): relevance and relevance_at, or nothing.
    """
    if relevance is None:
        return {}
    return {"relevance": relevance, "relevance_at": to_iso(relevance_at)}


def _relevance_of(props: dict[str, Any]) -> float | None:
    value = props.get("relevance")
    return None if value is None else float(value)


@_stored_decode
def decode_entity(props: dict[str, Any]) -> Entity:
    return Entity(
        id=props["id"],
        type=props["type"],
        name=props["name"],
        aliases=list(props.get("aliases") or []),
        external_ids=_loads(props.get("external_ids_json"), {}),
        properties=_loads(props.get("properties_json"), {}),
        source_count=int(props.get("source_count") or 0),
        created_at=from_iso(props["created_at"]),
        updated_at=from_iso(props["updated_at"]),
        relevance=_relevance_of(props),
        relevance_at=from_iso(props.get("relevance_at")),
    )


def encode_relation_props(
    *,
    ns: str,
    id: str,
    revision: int,
    properties: dict[str, Any],
    event_time: datetime | None,
    created_at: datetime,
    is_current: bool,
    source_count: int,
    invalidated_at: datetime | None = None,
    invalidated_by: str | None = None,
    invalidated_known_at: datetime | None = None,
) -> dict[str, Any]:
    return {
        "id": id,
        "ns": ns,
        "revision": revision,
        "is_current": is_current,
        "created_at": to_iso(created_at),
        "event_time": to_iso(event_time),
        "properties_json": _dumps(properties),
        "source_count": source_count,
        "invalidated_at": to_iso(invalidated_at),
        "invalidated_by": invalidated_by,
        "invalidated_known_at": to_iso(invalidated_known_at),
    }


@_stored_decode
def decode_relation(props: dict[str, Any], *, from_entity: str, to_entity: str, type: str) -> Relation:
    return Relation(
        id=props["id"],
        revision=int(props["revision"]),
        from_entity=from_entity,
        type=type,
        to_entity=to_entity,
        properties=_loads(props.get("properties_json"), {}),
        event_time=from_iso(props.get("event_time")),
        created_at=from_iso(props["created_at"]),
        is_current=bool(props["is_current"]),
        source_count=int(props.get("source_count") or 0),
        invalidated_at=from_iso(props.get("invalidated_at")),
        invalidated_by=props.get("invalidated_by"),
        invalidated_known_at=from_iso(props.get("invalidated_known_at")),
        relevance=_relevance_of(props),
        relevance_at=from_iso(props.get("relevance_at")),
        certified_at=from_iso(props.get("certified_at")),
        certified_by=props.get("certified_by"),
        certifications=_loads(props.get("certifications_json"), []),
    )


def encode_preference_props(
    *,
    ns: str,
    id: str,
    revision: int,
    subject_entity: str,
    key: str,
    about_entity: str | None,
    strength: float | None,
    properties: dict[str, Any],
    event_time: datetime | None,
    created_at: datetime,
    is_current: bool,
    about_dropped: bool = False,
) -> dict[str, Any]:
    """Encode one preference version as stored edge properties, flagging a version only written to drop about_entity.

    @param ns (str): namespace.
    @param id (str): preference id.
    @param revision (int): version number.
    @param subject_entity (str): the entity that holds the preference.
    @param key (str): the preference key.
    @param about_entity (str | None): the entity the preference is about.
    @param strength (float | None): preference strength.
    @param properties (dict[str, Any]): free-form properties.
    @param event_time (datetime | None): valid time.
    @param created_at (datetime): when this version was written.
    @param is_current (bool): whether this is the current version.
    @param about_dropped (bool): True when an entity delete wrote the version to drop a deleted about_entity.
    @return (dict[str, Any]): the stored property map.
    """
    props = {
        "id": id,
        "ns": ns,
        "revision": revision,
        "is_current": is_current,
        "subject_entity": subject_entity,
        "key": key,
        "about_entity": about_entity,
        "strength": strength,
        "properties_json": _dumps(properties),
        "event_time": to_iso(event_time),
        "created_at": to_iso(created_at),
    }
    if about_dropped:
        props[ABOUT_DROPPED] = True
    return props


@_stored_decode
def decode_preference(props: dict[str, Any], *, value_entity: str, profile_id: str, stance: str) -> Preference:
    return Preference(
        id=props["id"],
        revision=int(props["revision"]),
        profile_id=profile_id,
        subject_entity=props["subject_entity"],
        stance=stance,
        key=props["key"],
        value_entity=value_entity,
        about_entity=props.get("about_entity"),
        strength=props.get("strength"),
        properties=_loads(props.get("properties_json"), {}),
        event_time=from_iso(props.get("event_time")),
        created_at=from_iso(props["created_at"]),
        is_current=bool(props["is_current"]),
    )


def encode_trace_props(
    *,
    ns: str,
    id: str,
    title: str,
    actor_entity: str | None,
    summary: str | None,
    rationale: str | None,
    status: str,
    outcome_entity: str | None,
    alternative_entities: list[str],
    event_time: datetime | None,
    created_at: datetime,
    updated_at: datetime,
) -> dict[str, Any]:
    return {
        "id": id,
        "ns": ns,
        "title": title,
        "actor_entity": actor_entity,
        "summary": summary,
        "rationale": rationale,
        "status": status,
        "outcome_entity": outcome_entity,
        "alternative_entities_json": _dumps(list(alternative_entities)),
        "event_time": to_iso(event_time),
        "created_at": to_iso(created_at),
        "updated_at": to_iso(updated_at),
    }


@_stored_decode
def decode_trace(props: dict[str, Any], steps: list[DecisionStep]) -> DecisionTrace:
    return DecisionTrace(
        id=props["id"],
        actor_entity=props.get("actor_entity"),
        title=props["title"],
        summary=props.get("summary"),
        rationale=props.get("rationale"),
        status=props["status"],
        outcome_entity=props.get("outcome_entity"),
        alternative_entities=_loads(props.get("alternative_entities_json"), []),
        steps=steps,
        event_time=from_iso(props.get("event_time")),
        created_at=from_iso(props["created_at"]),
        updated_at=from_iso(props["updated_at"]),
    )


@_stored_decode
def decode_source_version(props: dict[str, Any]) -> SourceVersion:
    """Rebuild a source version from its stored node.

    @param props (dict[str, Any]): the source version node.
    @return (SourceVersion): the version.
    """
    return SourceVersion(
        id=props["id"],
        source_id=props["source_id"],
        media_type=props["media_type"],
        metadata=_loads(props.get("metadata_json"), {}),
        event_time=from_iso(props.get("event_time")),
        created_at=from_iso(props["created_at"]),
    )
