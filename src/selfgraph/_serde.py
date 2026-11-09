from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from .errors import ValidationError
from .models import (
    DecisionStep,
    DecisionTrace,
    Entity,
    Evidence,
    Preference,
    Relation,
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

LABELS = (L_ENTITY, L_PROFILE, L_TRACE, L_STEP, L_SOURCE, L_SOURCE_VERSION, L_CHUNK, L_EVIDENCE, L_MERGE)
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
_KIND_OF_EDGE = {etype: kind for kind, etype in _PREFERENCE_EDGES.items()}


def preference_edge_type(kind: str) -> str:
    """The edge type that stores a preference of the given kind.

    @param kind (str): the preference kind.
    @return (str): R_PREFERS or R_AVOIDS.
    """
    return _PREFERENCE_EDGES[kind]


def preference_kind_of(etype: str) -> str | None:
    """The preference kind an edge type stores, or None when the edge is not a preference.

    @param etype (str): the edge type.
    @return (str | None): the kind.
    """
    return _KIND_OF_EDGE.get(etype)


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


def from_iso(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value)


def _dumps(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, allow_nan=False)
    except (TypeError, ValueError, RecursionError) as exc:
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
    }


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
        relevance=_relevance_of(props),
        relevance_at=from_iso(props.get("relevance_at")),
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
) -> dict[str, Any]:
    return {
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


def decode_preference(props: dict[str, Any], *, value_entity: str, profile_id: str, kind: str) -> Preference:
    return Preference(
        id=props["id"],
        revision=int(props["revision"]),
        profile_id=profile_id,
        subject_entity=props["subject_entity"],
        kind=kind,
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
