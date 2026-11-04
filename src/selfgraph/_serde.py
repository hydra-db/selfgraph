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


def now() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def from_iso(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value)


def _dumps(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"value is not JSON-serializable: {exc}") from exc


def _loads(value: Any, fallback: Any) -> Any:
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback


def encode_evidence(evidence: list[Evidence]) -> str:
    return _dumps([e.model_dump() for e in evidence])


def decode_evidence(value: Any) -> list[Evidence]:
    raw = _loads(value, [])
    return [Evidence.model_validate(item) for item in raw]


def encode_entity_props(
    *,
    ns: str,
    id: str,
    type: str,
    name: str,
    aliases: list[str],
    external_ids: dict[str, str],
    properties: dict[str, Any],
    evidence: list[Evidence],
    created_at: datetime,
    updated_at: datetime,
) -> dict[str, Any]:
    return {
        "id": id,
        "ns": ns,
        "type": type,
        "name": name,
        "aliases": list(aliases),
        "external_ids_json": _dumps(external_ids),
        "properties_json": _dumps(properties),
        "evidence_json": encode_evidence(evidence),
        "created_at": to_iso(created_at),
        "updated_at": to_iso(updated_at),
    }


def decode_entity(props: dict[str, Any]) -> Entity:
    return Entity(
        id=props["id"],
        type=props["type"],
        name=props["name"],
        aliases=list(props.get("aliases") or []),
        external_ids=_loads(props.get("external_ids_json"), {}),
        properties=_loads(props.get("properties_json"), {}),
        evidence=decode_evidence(props.get("evidence_json")),
        created_at=from_iso(props["created_at"]),
        updated_at=from_iso(props["updated_at"]),
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
    evidence: list[Evidence],
) -> dict[str, Any]:
    return {
        "id": id,
        "ns": ns,
        "revision": revision,
        "is_current": is_current,
        "created_at": to_iso(created_at),
        "event_time": to_iso(event_time),
        "properties_json": _dumps(properties),
        "evidence_json": encode_evidence(evidence),
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
        evidence=decode_evidence(props.get("evidence_json")),
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
