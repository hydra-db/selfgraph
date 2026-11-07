from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Mapping
from datetime import datetime
from typing import Any, get_args

from . import ids as _ids
from ._serde import (
    L_CHUNK,
    L_ENTITY,
    L_PROFILE,
    L_SOURCE,
    L_SOURCE_VERSION,
    L_STEP,
    L_TRACE,
    R_AVOIDS,
    R_CONSIDERED,
    R_FROM,
    R_HAS_CHUNK,
    R_HAS_PROFILE,
    R_HAS_STEP,
    R_HAS_VERSION,
    R_MADE_DECISION,
    R_PREFERS,
    R_RESULTED_IN,
    R_TO,
    _dumps,
    _loads,
    decode_entity,
    decode_preference,
    decode_relation,
    decode_trace,
    encode_entity_props,
    encode_evidence,
    encode_preference_props,
    encode_relation_props,
    encode_trace_props,
    now,
    to_iso,
)
from .errors import ConflictError, NotFoundError, TransientError, ValidationError
from .ids import _has_control, _has_surrogate
from .models import (
    DecisionStep,
    DecisionTrace,
    Entity,
    EntityInput,
    Evidence,
    EvidenceInput,
    Kind,
    Ontology,
    Preference,
    PreferenceInput,
    Relation,
    RelationInput,
    Status,
)

_RESERVED_TYPES = frozenset({L_ENTITY, L_PROFILE, L_TRACE, L_STEP, L_SOURCE, L_SOURCE_VERSION, L_CHUNK})
_RESERVED_TYPES_LOWER = frozenset(t.lower() for t in _RESERVED_TYPES)
_RESERVED_RELTYPES = frozenset(
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
_RESERVED_ID_PREFIXES = frozenset({"profile", "decision", "relation", "preference", "sv", "source"})
_ENTITY_UPDATE_FIELDS = frozenset(
    {"type", "name", "aliases", "external_ids", "properties", "remove_aliases", "remove_properties"}
)
_DECISION_UPDATE_FIELDS = frozenset(
    {
        "title",
        "steps",
        "actor_entity",
        "summary",
        "rationale",
        "outcome_entity",
        "alternative_entities",
        "status",
        "event_time",
    }
)
_MAX_ID_BYTES = 1024


def _validate_entity_identity(eid: str, type: str, name: str) -> None:
    """Validate an entity's type, name, and resolved id before writing.

    @param eid (str): the resolved entity id.
    @param type (str): the entity type, used as a backend label.
    @param name (str): the entity name.
    @return (None): nothing; raises ValidationError on an empty, reserved, or oversized identity.
    """
    if not isinstance(eid, str):
        raise ValidationError(f"entity id must be a string, got {eid.__class__.__name__}")
    if not isinstance(type, str) or not isinstance(name, str) or not type.strip() or not name.strip():
        raise ValidationError(
            "entity type and name cannot be empty; an entity needs both, e.g. type='Person', name='Jane Doe'"
        )
    if type.strip().lower() in _RESERVED_TYPES_LOWER:
        raise ValidationError(f"entity type {type!r} is reserved for internal use; choose another type")
    if "`" in type:
        raise ValidationError("entity type cannot contain a backtick")
    if _has_control(name) or _has_control(type):
        raise ValidationError("entity type and name cannot contain control or surrogate characters")
    if _has_control(eid):
        raise ValidationError("entity id cannot contain control or surrogate characters")
    if ":" not in eid:
        raise ValidationError(f"entity id must be 'type:name', e.g. 'person:jane', got {eid!r}")
    prefix_part, name_part = eid.split(":", 1)
    if not prefix_part.strip() or not name_part.strip():
        raise ValidationError(f"entity id must be 'type:name' with a non-empty prefix and name, got {eid!r}")
    if eid.split(":", 1)[0].lower() in _RESERVED_ID_PREFIXES:
        raise ValidationError(f"entity id prefix {eid.split(':', 1)[0]!r} is reserved for internal use")
    if len(eid.encode("utf-8")) > _MAX_ID_BYTES:
        raise ValidationError(
            f"entity id is too long ({len(eid.encode('utf-8'))} bytes); keep ids under {_MAX_ID_BYTES} bytes"
        )


def _validate_strength(strength: float | None) -> None:
    """Validate a preference strength is a real number in the unit interval.

    @param strength (float | None): the strength to check, or None.
    @return (None): nothing; raises ValidationError when non-numeric or out of range.
    """
    if strength is None:
        return
    if isinstance(strength, bool) or not isinstance(strength, int | float):
        raise ValidationError(f"preference strength must be a number, got {type(strength).__name__}")
    if not 0.0 <= strength <= 1.0:
        raise ValidationError(f"preference strength must be between 0 and 1, got {strength}")


def _require_text(field: str, value: Any) -> None:
    """Validate a value is a non-empty string.

    @param field (str): the field name for the error message.
    @param value (Any): the value to check.
    @return (None): nothing; raises ValidationError when not a non-empty string.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{field} must be a non-empty string, got {type(value).__name__}")
    if _has_control(value):
        raise ValidationError(f"{field} cannot contain control or surrogate characters")


def _require_int(field: str, value: Any) -> None:
    """Validate a value is an integer, excluding bool.

    @param field (str): the field name for the error message.
    @param value (Any): the value to check.
    @return (None): nothing; raises ValidationError when not a non-bool integer.
    """
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValidationError(f"{field} must be an integer, got {type(value).__name__}")


def _require_id(kind: str, oid: Any) -> None:
    """Validate a lookup id is a clean string, so a bad id gives a typed error not a backend fault.

    @param kind (str): the object kind for the error message.
    @param oid (Any): the id to check.
    @return (None): nothing; raises ValidationError when the id is not a clean string.
    """
    _ids._require_str(f"{kind} id", oid)


def _require_optional_text(field: str, value: Any) -> None:
    """Validate a value is a string or None.

    @param field (str): the field name for the error message.
    @param value (Any): the value to check.
    @return (None): nothing; raises ValidationError when not a string or None.
    """
    if value is not None and not isinstance(value, str):
        raise ValidationError(f"{field} must be a string or None, got {type(value).__name__}")
    if value is not None and _has_control(value):
        raise ValidationError(f"{field} cannot contain control or surrogate characters")


def _require_datetime(field: str, value: Any) -> None:
    """Validate a value is a datetime or None.

    @param field (str): the field name for the error message.
    @param value (Any): the value to check.
    @return (None): nothing; raises ValidationError when not a datetime.
    """
    if value is None:
        return
    if not isinstance(value, datetime):
        raise ValidationError(f"{field} must be a datetime, got {type(value).__name__}")
    try:
        to_iso(value)
    except (OverflowError, ValueError, OSError) as exc:
        raise ValidationError(f"{field} is outside the representable datetime range") from exc


def _validate_object_id(kind: str, oid: str, own_prefix: str, *, require_own: bool = False) -> None:
    """Validate a caller-supplied id for a relation, preference, or decision.

    @param kind (str): the object kind for messages.
    @param oid (str): the caller-supplied id.
    @param own_prefix (str): this object's own namespace prefix.
    @param require_own (bool): require the id to carry own_prefix (for node-backed decisions).
    @return (None): nothing; raises ValidationError on a bad or colliding id.
    """
    if not isinstance(oid, str) or not oid:
        raise ValidationError(f"{kind} id must be a non-empty string, got {type(oid).__name__}")
    if _has_control(oid):
        raise ValidationError(f"{kind} id cannot contain control or surrogate characters")
    if len(oid.encode("utf-8")) > _MAX_ID_BYTES:
        raise ValidationError(
            f"{kind} id is too long ({len(oid.encode('utf-8'))} bytes); keep ids under {_MAX_ID_BYTES} bytes"
        )
    prefix = oid.split(":", 1)[0].lower() if ":" in oid else ""
    if require_own and prefix != own_prefix:
        raise ValidationError(f"{kind} id must start with '{own_prefix}:', got {oid!r}")
    if require_own and not oid.split(":", 1)[1].strip():
        raise ValidationError(f"{kind} id must have a non-empty name after '{own_prefix}:', got {oid!r}")
    if not require_own and prefix in _RESERVED_ID_PREFIXES and prefix != own_prefix:
        raise ValidationError(f"{kind} id prefix {prefix!r} is reserved for internal use")


_KINDS = frozenset(get_args(Kind))
_STATUSES = frozenset(get_args(Status))


def _validate_kind(kind: str) -> None:
    """Validate a preference kind is one of the allowed values.

    @param kind (str): the kind to check.
    @return (None): nothing; raises ValidationError on an unknown kind.
    """
    if not isinstance(kind, str) or kind not in _KINDS:
        raise ValidationError(f"preference kind must be one of {sorted(_KINDS)}, got {kind!r}")


def _validate_status(status: str) -> None:
    """Validate a decision status is one of the allowed values.

    @param status (str): the status to check.
    @return (None): nothing; raises ValidationError on an unknown status.
    """
    if not isinstance(status, str) or status not in _STATUSES:
        raise ValidationError(f"decision status must be one of {sorted(_STATUSES)}, got {status!r}")


def _require_list(name: str, value: Any) -> None:
    """Validate a value is a list of strings, not a bare string or a list with non-strings.

    @param name (str): the field name for the error message.
    @param value (Any): the value to check.
    @return (None): nothing; raises ValidationError when not a list of strings.
    """
    if isinstance(value, str) or not isinstance(value, list | tuple):
        raise ValidationError(f"{name} must be a list of strings, got {type(value).__name__}")
    for item in value:
        if not isinstance(item, str):
            raise ValidationError(f"{name} must be a list of strings, got a {type(item).__name__} element")
        if _has_control(item):
            raise ValidationError(f"{name} elements cannot contain control or surrogate characters")


def _require_mapping(name: str, value: Any) -> None:
    """Validate a value is a mapping.

    @param name (str): the field name for the error message.
    @param value (Any): the value to check.
    @return (None): nothing; raises ValidationError when not a mapping.
    """
    if not isinstance(value, Mapping):
        raise ValidationError(f"{name} must be a mapping, got {type(value).__name__}")
    for key in value:
        if not isinstance(key, str):
            raise ValidationError(f"{name} keys must be strings, got a {type(key).__name__} key")
    _ids._require_clean_json(name, value)


def _require_json_mapping(name: str, value: Any) -> None:
    """Validate an optional mapping has string keys and JSON-serializable values, up front.

    Callers that supersede a version before encoding must reject a non-serializable value here,
    before the supersede write, or a mid-write encode failure leaves no current version.

    @param name (str): the field name for the error message.
    @param value (Any): the value to check, or None.
    @return (None): nothing; raises ValidationError when not a JSON string-keyed mapping.
    """
    if value is None:
        return
    _require_mapping(name, value)
    _dumps(dict(value))


def _canon_props(props: Mapping[str, Any] | None) -> dict[str, Any]:
    """Canonicalize a caller property mapping to the JSON-native form that storage round-trips to.

    A tuple the caller passes is stored and read back as a list, so comparing the raw caller value
    against the decoded current value spuriously reports a change; round-tripping both sides through
    the JSON codec makes the idempotency check see equal values.

    @param props (Mapping[str, Any] | None): caller-supplied properties, possibly holding tuples.
    @return (dict[str, Any]): the mapping with values coerced to their stored JSON-native form.
    """
    if not props:
        return {}
    return _loads(_dumps(dict(props)), {})


def _require_str_mapping(name: str, value: Any) -> None:
    """Validate a value is a mapping of strings to strings.

    @param name (str): the field name for the error message.
    @param value (Any): the value to check.
    @return (None): nothing; raises ValidationError when not a string-to-string mapping.
    """
    _require_mapping(name, value)
    for item in value.values():
        if not isinstance(item, str):
            raise ValidationError(f"{name} must map strings to strings")


def _require_clean_evidence(ev: EvidenceInput) -> None:
    """Validate one evidence input at the ops tier, since the pydantic model tier is bypassable by mutation.

    @param ev (EvidenceInput): the evidence to validate.
    @return (None): nothing; raises ValidationError on a bad source id, surrogate quote, or non-finite confidence.
    """
    if not isinstance(ev, EvidenceInput):
        raise ValidationError(f"evidence must be EvidenceInput objects, got a {type(ev).__name__}")
    _require_text("evidence source_id", ev.source_id)
    if ev.quote is not None:
        if not isinstance(ev.quote, str):
            raise ValidationError(f"evidence quote must be a string, got {type(ev.quote).__name__}")
        if _has_surrogate(ev.quote):
            raise ValidationError("evidence quote cannot contain unpaired surrogate characters")
    if ev.confidence is not None:
        if isinstance(ev.confidence, bool) or not isinstance(ev.confidence, int | float):
            raise ValidationError(f"evidence confidence must be a number, got {type(ev.confidence).__name__}")
        if not math.isfinite(ev.confidence):
            raise ValidationError("evidence confidence must be a finite number")
    for name, offset in (("evidence start_offset", ev.start_offset), ("evidence end_offset", ev.end_offset)):
        if offset is not None and (isinstance(offset, bool) or not isinstance(offset, int)):
            raise ValidationError(f"{name} must be an integer, got {type(offset).__name__}")


def evidence_from_inputs(
    inputs: list[EvidenceInput] | tuple[EvidenceInput, ...],
    *,
    source_version: str | None = None,
) -> list[Evidence]:
    """Turn caller-supplied EvidenceInput into stored Evidence.

    @param inputs (list[EvidenceInput] | tuple[EvidenceInput, ...]): evidence to convert.
    @param source_version (str | None): when absent, synthesised as "<source_id>:manual" to populate the required field.
    @return (list[Evidence]): the stored evidence.
    """
    if isinstance(inputs, str | bytes) or not isinstance(inputs, Iterable):
        raise ValidationError(f"evidence must be a list of Evidence objects, got {type(inputs).__name__}")
    out: list[Evidence] = []
    for ev in inputs:
        if not isinstance(ev, EvidenceInput):
            raise ValidationError(
                f"evidence must be EvidenceInput objects (selfgraph.EvidenceInput(...)), got a {type(ev).__name__}"
            )
        _require_clean_evidence(ev)
        sv = source_version or f"{ev.source_id}:manual"
        out.append(
            Evidence(
                source_id=ev.source_id,
                source_version=sv,
                quote=ev.quote,
                start_offset=ev.start_offset,
                end_offset=ev.end_offset,
                confidence=ev.confidence,
            )
        )
    return out


def _dedup_list(items: list[str]) -> list[str]:
    if isinstance(items, str):
        raise ValidationError(f"expected a list of strings, got a single string {items!r}")
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _dedup_text_list(items: list[str]) -> list[str]:
    """Dedup a list of display-text values after NFC-normalizing each, so surface forms collapse.

    @param items (list[str]): the display-text values to normalize and dedup.
    @return (list[str]): the NFC-normalized values with duplicates removed, order preserved.
    """
    return _dedup_list([_ids.normalize_text(item) if isinstance(item, str) else item for item in items])


def _ev_key(e: Evidence) -> tuple:
    return (e.source_id, e.source_version, e.chunk_id, e.quote, e.start_offset, e.end_offset)


def _merge_evidence(existing: list[Evidence], new: list[Evidence]) -> list[Evidence]:
    out = list(existing)
    keys = {_ev_key(e) for e in existing}
    for e in new:
        k = _ev_key(e)
        if k not in keys:
            keys.add(k)
            out.append(e)
    return out


async def entity_exists(runner: Any, ns: str, eid: str) -> bool:
    """Report whether an entity exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): entity id.
    @return (bool): True when it exists.
    """
    return await runner.node_exists(ns, L_ENTITY, eid)


async def _entity_known(runner: Any, ns: str, eid: str, known: set[str] | frozenset[str]) -> bool:
    if not isinstance(eid, str):
        raise ValidationError(f"entity reference must be a string id, got {type(eid).__name__}")
    if _has_control(eid):
        raise ValidationError("entity reference cannot contain control or surrogate characters")
    return eid in known or await entity_exists(runner, ns, eid)


async def _require_entity(
    runner: Any, ns: str, eid: str, *, context: str, known: set[str] | frozenset[str] = frozenset()
) -> None:
    if not await _entity_known(runner, ns, eid, known):
        raise ValidationError(f"{context} references unknown entity {eid!r}")


async def validate_ontology(runner: Any, ns: str, ontology: Ontology) -> None:
    """Check every reference in an ontology before any write so a bad reference fails atomically.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param ontology (Ontology): the ontology whose references are checked.
    @return (None): nothing; raises ValidationError on the first unresolved reference.
    """
    for name, collection in (
        ("entities", ontology.entities),
        ("relations", ontology.relations),
        ("preferences", ontology.preferences),
        ("decisions", ontology.decisions),
    ):
        if not isinstance(collection, list | tuple):
            raise ValidationError(f"ontology {name} must be a list, got {type(collection).__name__}")

    entities = {ent.id or _ids.entity_id(ent.type, ent.name) for ent in ontology.entities}
    relations = {rel.id or _ids.relation_id(rel.from_entity, rel.type, rel.to_entity) for rel in ontology.relations}

    for ent in ontology.entities:
        _validate_entity_identity(ent.id or _ids.entity_id(ent.type, ent.name), ent.type, ent.name)

    for item in (*ontology.entities, *ontology.relations, *ontology.preferences):
        if item.properties is None:
            raise ValidationError("properties must be a mapping, got NoneType")
        _require_json_mapping("properties", item.properties)
    for ent in ontology.entities:
        _require_str_mapping("external_ids", ent.external_ids)
        _require_list("entity aliases", ent.aliases)

    for rel in ontology.relations:
        if rel.id is not None:
            _validate_object_id("relation", rel.id, "relation", require_own=True)
        _require_datetime("relation event_time", rel.event_time)
        if _ids.normalize_rel_type(rel.type) in _RESERVED_RELTYPES:
            raise ValidationError(f"relation type {rel.type!r} is reserved for internal use; choose another type")
        if not isinstance(rel.evidence, list | tuple):
            raise ValidationError(f"relation evidence must be a list, got {type(rel.evidence).__name__}")
        for ev in rel.evidence:
            _require_clean_evidence(ev)
        if not await _entity_known(runner, ns, rel.from_entity, entities) or not await _entity_known(
            runner, ns, rel.to_entity, entities
        ):
            raise ValidationError(
                f"relation endpoints not found (from={rel.from_entity!r}, to={rel.to_entity!r}); both must be "
                "entity ids ('type:name') listed in this ontology's entities or already in the graph. "
                "Ids are canonicalized; compute one with selfgraph.entity_id(type, name)"
            )

    for pref in ontology.preferences:
        if pref.id is not None:
            _validate_object_id("preference", pref.id, "preference", require_own=True)
        _require_datetime("preference event_time", pref.event_time)
        _validate_kind(pref.kind)
        _require_text("preference key", pref.key)
        _validate_strength(pref.strength)
        if not await _entity_known(runner, ns, pref.subject_entity, entities):
            raise ValidationError(f"preference references unknown subject entity {pref.subject_entity!r}")
        await _require_entity(runner, ns, pref.value_entity, context="preference", known=entities)
        if pref.about_entity is not None:
            await _require_entity(runner, ns, pref.about_entity, context="preference about_entity", known=entities)

    for dec in ontology.decisions:
        if dec.id is not None:
            _validate_object_id("decision", dec.id, "decision", require_own=True)
        _require_datetime("decision event_time", dec.event_time)
        _validate_status(dec.status)
        _require_text("decision title", dec.title)
        _require_optional_text("decision summary", dec.summary)
        _require_optional_text("decision rationale", dec.rationale)
        _require_list("decision steps", dec.steps)
        _require_list("decision alternative_entities", dec.alternative_entities)
        for rel_id in dec.steps:
            if rel_id not in relations and await get_relation_current(runner, ns, rel_id) is None:
                raise ValidationError(f"decision step references unknown relation {rel_id!r}")
        if dec.actor_entity is not None:
            await _require_entity(runner, ns, dec.actor_entity, context="decision actor_entity", known=entities)
        if dec.outcome_entity is not None:
            await _require_entity(runner, ns, dec.outcome_entity, context="decision outcome_entity", known=entities)
        for alt in dec.alternative_entities:
            await _require_entity(runner, ns, alt, context="decision alternative_entity", known=entities)


async def get_entity(runner: Any, ns: str, eid: str) -> Entity | None:
    """Fetch one entity by id, or None.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): entity id.
    @return (Entity | None): the entity, or None.
    """
    _require_id("entity", eid)
    props = await runner.get_node(ns, L_ENTITY, eid)
    return decode_entity(props) if props else None


async def _write_entity(runner: Any, ns: str, eid: str, type: str, props: dict) -> None:
    await runner.upsert_node(ns, L_ENTITY, eid, props, extra_label=type)


async def upsert_entity(
    runner: Any,
    ns: str,
    ent: EntityInput,
    *,
    evidence: list[Evidence],
    created_at: datetime,
) -> Entity:
    """Insert-semantics upsert: keep the stored name, record a new surface form as an alias, and merge the rest.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param ent (EntityInput): entity to upsert.
    @param evidence (list[Evidence]): evidence to merge.
    @param created_at (datetime): timestamp for created and updated fields.
    @return (Entity): the stored entity.
    """
    etype = _ids.normalize_text(ent.type).strip() if isinstance(ent.type, str) else ent.type
    ename = _ids.normalize_text(ent.name).strip() if isinstance(ent.name, str) else ent.name
    eid = ent.id or _ids.entity_id(etype, ename)
    _validate_entity_identity(eid, etype, ename)
    await runner.lock_node(ns, L_ENTITY, eid)
    existing = await get_entity(runner, ns, eid)
    if existing is None:
        props = encode_entity_props(
            ns=ns,
            id=eid,
            type=etype,
            name=ename,
            aliases=_dedup_text_list(ent.aliases),
            external_ids=dict(ent.external_ids),
            properties=dict(ent.properties),
            evidence=evidence,
            created_at=created_at,
            updated_at=created_at,
        )
        await _write_entity(runner, ns, eid, etype, props)
        return decode_entity(props)

    renamed = [ename] if ename != existing.name else []
    merged_aliases = _dedup_text_list([*existing.aliases, *ent.aliases, *renamed])
    merged_external = {**existing.external_ids, **ent.external_ids}
    merged_properties = {**existing.properties, **_canon_props(ent.properties)}
    merged_evidence = _merge_evidence(existing.evidence, evidence)

    if (
        etype == existing.type
        and merged_aliases == existing.aliases
        and merged_external == existing.external_ids
        and merged_properties == existing.properties
        and merged_evidence == existing.evidence
    ):
        return existing

    props = encode_entity_props(
        ns=ns,
        id=eid,
        type=etype,
        name=existing.name,
        aliases=merged_aliases,
        external_ids=merged_external,
        properties=merged_properties,
        evidence=merged_evidence,
        created_at=existing.created_at,
        updated_at=created_at,
    )
    await _precheck_write(runner, props)
    if etype != existing.type:
        await runner.remove_node_label(ns, L_ENTITY, eid, existing.type)
    await _write_entity(runner, ns, eid, etype, props)
    return decode_entity(props)


async def create_entity(
    runner: Any,
    ns: str,
    *,
    name: str,
    type: str,
    id: str | None = None,
    aliases: list[str] | None = None,
    external_ids: dict[str, str] | None = None,
    properties: dict[str, Any] | None = None,
) -> Entity:
    """Create one entity, failing if its id already exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param name (str): entity name.
    @param type (str): entity type.
    @param id (str | None): explicit id, else derived.
    @param aliases (list[str] | None): aliases.
    @param external_ids (dict[str, str] | None): external ids.
    @param properties (dict[str, Any] | None): properties.
    @return (Entity): the created entity.
    """
    _require_text("entity type", type)
    _require_text("entity name", name)
    type = _ids.normalize_text(type).strip()
    name = _ids.normalize_text(name).strip()
    eid = id or _ids.entity_id(type, name)
    _validate_entity_identity(eid, type, name)
    if aliases is not None:
        _require_list("aliases", aliases)
    if external_ids is not None:
        _require_str_mapping("external_ids", external_ids)
    if properties is not None:
        _require_json_mapping("properties", properties)
    await runner.lock_node(ns, L_ENTITY, eid)
    if await entity_exists(runner, ns, eid):
        raise ConflictError("Entity", eid)
    ts = now()
    props = encode_entity_props(
        ns=ns,
        id=eid,
        type=type,
        name=name,
        aliases=_dedup_text_list(aliases or []),
        external_ids=dict(external_ids or {}),
        properties=dict(properties or {}),
        evidence=[],
        created_at=ts,
        updated_at=ts,
    )
    await _write_entity(runner, ns, eid, type, props)
    return decode_entity(props)


async def update_entity(runner: Any, ns: str, eid: str, **fields: Any) -> Entity:
    """Update an entity's fields, replacing scalars and merging collections.

    Scalar fields (name, type) replace the stored value; collection fields
    (aliases, external_ids, properties) merge into what is already stored, so a
    partial update never silently drops keys. This matches insert, which merges.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): entity id.
    @param fields (Any): fields to change (name, type, aliases, external_ids, properties).
    @return (Entity): the updated entity.
    """
    existing = await get_entity(runner, ns, eid)
    if existing is None:
        raise NotFoundError("Entity", eid)
    unknown = set(fields) - _ENTITY_UPDATE_FIELDS
    if unknown:
        raise ValidationError(f"unknown entity update field(s): {sorted(unknown)}")
    for key in ("aliases", "remove_aliases", "remove_properties"):
        if key in fields:
            _require_list(key, fields[key])
    if "properties" in fields:
        _require_json_mapping("properties", fields["properties"])
    if "external_ids" in fields:
        _require_str_mapping("external_ids", fields["external_ids"])
    if "type" in fields:
        _require_text("entity type", fields["type"])
    if "name" in fields:
        _require_text("entity name", fields["name"])
    await runner.lock_node(ns, L_ENTITY, eid)
    existing = await get_entity(runner, ns, eid)
    if existing is None:
        raise TransientError(f"entity {eid!r} was changed concurrently; retry")
    new_type = _ids.normalize_text(fields["type"]).strip() if "type" in fields else existing.type
    new_name = _ids.normalize_text(fields["name"]).strip() if "name" in fields else existing.name
    _validate_entity_identity(eid, new_type, new_name)
    aliases = (
        _dedup_text_list(existing.aliases + list(fields["aliases"]))
        if "aliases" in fields
        else _dedup_text_list(existing.aliases)
    )
    removed = {_ids.normalize_text(a) if isinstance(a, str) else a for a in fields.get("remove_aliases", ())}
    aliases = [a for a in aliases if a not in removed]
    properties = (
        {**existing.properties, **_canon_props(fields["properties"])}
        if "properties" in fields
        else dict(existing.properties)
    )
    for key in fields.get("remove_properties", ()):
        properties.pop(key, None)
    external_ids = (
        {**existing.external_ids, **fields["external_ids"]} if "external_ids" in fields else existing.external_ids
    )
    if (
        new_type == existing.type
        and new_name == existing.name
        and aliases == existing.aliases
        and external_ids == existing.external_ids
        and properties == existing.properties
    ):
        return existing
    props = encode_entity_props(
        ns=ns,
        id=eid,
        type=new_type,
        name=new_name,
        aliases=aliases,
        external_ids=external_ids,
        properties=properties,
        evidence=existing.evidence,
        created_at=existing.created_at,
        updated_at=now(),
    )
    await _precheck_write(runner, props)
    if new_type != existing.type:
        await runner.remove_node_label(ns, L_ENTITY, eid, existing.type)
    await _write_entity(runner, ns, eid, new_type, props)
    return decode_entity(props)


async def list_entities(
    runner: Any,
    ns: str,
    *,
    type: str | None,
    name: str | None,
    skip: int,
    limit: int,
) -> list[Entity]:
    """List entities, optionally filtered by type and name.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param type (str | None): type filter.
    @param name (str | None): name filter.
    @param skip (int): rows to skip.
    @param limit (int): maximum rows.
    @return (list[Entity]): the entities.
    """
    _require_optional_text("type filter", type)
    _require_optional_text("name filter", name)
    equals: dict[str, Any] = {}
    if type is not None:
        equals["type"] = _ids.normalize_text(type).strip()
    if name is not None:
        equals["name"] = _ids.normalize_text(name).strip()
    rows = await runner.match_nodes(ns, L_ENTITY, equals=equals, order_by="id", skip=skip, limit=limit)
    return [decode_entity(r) for r in rows]


def _trace_of_step(sid: str) -> str:
    """Derive the owning trace id from a decision step node id.

    @param sid (str): the step node id, shaped ``<trace>:step:<order>``.
    @return (str): the owning trace id.
    """
    return sid.rsplit(":step:", 1)[0]


async def _delete_trace_quietly(runner: Any, ns: str, tid: str) -> bool:
    """Delete a decision trace and its steps when it still exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tid (str): trace id.
    @return (bool): True when a trace was removed.
    """
    if not await trace_exists(runner, ns, tid):
        return False
    for step in await runner.child_nodes(ns, L_TRACE, tid, R_HAS_STEP, L_STEP):
        await runner.delete_node(ns, L_STEP, step["id"])
    await runner.delete_node(ns, L_TRACE, tid)
    return True


async def _traces_touching_relation(runner: Any, ns: str, rid: str) -> set[str]:
    """Find decision traces that use a relation as one of their steps.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @return (set[str]): owning trace ids.
    """
    steps = await runner.match_nodes(ns, L_STEP, equals={"relation_id": rid})
    return {_trace_of_step(s["id"]) for s in steps}


async def _traces_touching_entity(runner: Any, ns: str, eid: str) -> set[str]:
    """Find decision traces that reference an entity as actor, outcome, or step endpoint.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): entity id.
    @return (set[str]): referencing trace ids.
    """
    tids: set[str] = set()
    for key in ("actor_entity", "outcome_entity"):
        for trace in await runner.match_nodes(ns, L_TRACE, equals={key: eid}):
            tids.add(trace["id"])
    for key in ("from_entity", "to_entity"):
        for step in await runner.match_nodes(ns, L_STEP, equals={key: eid}):
            tids.add(_trace_of_step(step["id"]))
    return tids


async def _traces_with_alternative(runner: Any, ns: str, eid: str) -> set[str]:
    """Find decision traces that list an entity as a considered alternative.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): entity id.
    @return (set[str]): trace ids that considered the entity.
    """
    edges = await runner.match_edges(ns, from_label=L_TRACE, to_label=L_ENTITY, type=R_CONSIDERED, to_id=eid)
    return {edge["from_id"] for edge in edges}


async def _prune_trace_alternative(runner: Any, ns: str, tid: str, eid: str) -> None:
    """Drop a considered alternative from a decision trace without deleting the trace.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tid (str): trace id.
    @param eid (str): the alternative entity id to remove.
    @return (None): nothing.
    """
    trace = await get_trace(runner, ns, tid)
    if trace is None:
        return
    remaining = [a for a in trace.alternative_entities if a != eid]
    if remaining != list(trace.alternative_entities):
        await update_trace(runner, ns, tid, alternative_entities=remaining)


async def delete_entity(runner: Any, ns: str, eid: str) -> dict[str, int]:
    """Delete an entity and everything attached to it.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): entity id.
    @return (dict[str, int]): counts of what was removed.
    """
    _require_id("entity", eid)
    if not await entity_exists(runner, ns, eid):
        raise NotFoundError("Entity", eid)
    counts = {
        "deleted_entities": 0,
        "deleted_relation_versions": 0,
        "deleted_decisions": 0,
        "deleted_preference_versions": 0,
    }
    trace_ids = await _traces_touching_entity(runner, ns, eid)

    for rid in await runner.versioned_relation_ids(
        ns, L_ENTITY, eid, exclude_types=[R_PREFERS, R_AVOIDS, R_HAS_PROFILE]
    ):
        counts["deleted_relation_versions"] += await runner.delete_edges(ns, rid)
        trace_ids |= await _traces_touching_relation(runner, ns, rid)

    for tid in trace_ids:
        if await _delete_trace_quietly(runner, ns, tid):
            counts["deleted_decisions"] += 1

    for tid in await _traces_with_alternative(runner, ns, eid):
        if tid not in trace_ids:
            await _prune_trace_alternative(runner, ns, tid, eid)

    for profile in await runner.child_nodes(ns, L_ENTITY, eid, R_HAS_PROFILE, L_PROFILE):
        counts["deleted_preference_versions"] += await runner.count_out_edges(ns, L_PROFILE, profile["id"])
        await runner.delete_node(ns, L_PROFILE, profile["id"])

    counts["deleted_preference_versions"] += await runner.count_in_edges_typed(ns, L_ENTITY, eid, [R_PREFERS, R_AVOIDS])
    await runner.delete_node(ns, L_ENTITY, eid)
    counts["deleted_entities"] = 1
    return counts


def _is_relation_type(rtype: str) -> bool:
    """Report whether an edge type is a user relation rather than a reserved internal edge.

    @param rtype (str): the edge type.
    @return (bool): True when the edge is a user relation.
    """
    return rtype not in _RESERVED_RELTYPES


def _is_preference_type(rtype: str) -> bool:
    """Report whether an edge type is a preference edge.

    @param rtype (str): the edge type.
    @return (bool): True when the edge is a preference.
    """
    return rtype in (R_PREFERS, R_AVOIDS)


async def _typed_edge_versions(runner: Any, ns: str, eid: str, keep: Callable[[str], bool]) -> list[dict]:
    """Return the stored versions of an edge whose type is kept, so a lookup never crosses edge types.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): edge id.
    @param keep (Callable[[str], bool]): predicate selecting the edge type for this object kind.
    @return (list[dict]): the matching edge versions, empty when the id names a different edge type.
    """
    return [e for e in await runner.list_edge_versions(ns, eid) if keep(e["type"])]


async def get_relation_current(runner: Any, ns: str, rid: str) -> Relation | None:
    """Fetch the current version of a relation by id.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @return (Relation | None): the current version, or None.
    """
    _require_id("relation", rid)
    edge = await runner.get_current_edge(ns, rid)
    if edge is None or not _is_relation_type(edge["type"]):
        return None
    return decode_relation(edge["props"], from_entity=edge["from_id"], to_entity=edge["to_id"], type=edge["type"])


async def relation_exists(runner: Any, ns: str, rid: str) -> bool:
    """Report whether any version of a relation (not another edge type) exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @return (bool): True when a relation with this id exists.
    """
    return bool(await _typed_edge_versions(runner, ns, rid, _is_relation_type))


async def list_relation_versions(runner: Any, ns: str, rid: str, *, newest_first: bool) -> list[Relation]:
    """Return every version of a relation.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @param newest_first (bool): order newest first when True.
    @return (list[Relation]): the versions.
    """
    _require_id("relation", rid)
    edges = await _typed_edge_versions(runner, ns, rid, _is_relation_type)
    rels = [decode_relation(e["props"], from_entity=e["from_id"], to_entity=e["to_id"], type=e["type"]) for e in edges]
    if newest_first:
        rels.reverse()
    return rels


async def _create_relation_edge(runner: Any, ns: str, from_id: str, rtype: str, to_id: str, props: dict) -> None:
    if rtype in _RESERVED_RELTYPES:
        raise ValidationError(f"relation type {rtype!r} is reserved for internal use; choose another type")
    ok = await runner.create_edge(ns, rtype, L_ENTITY, from_id, L_ENTITY, to_id, props)
    if not ok:
        raise ValidationError(
            f"relation endpoints not found (from={from_id!r}, to={to_id!r}); create both entities first, "
            "then reference them by id ('type:name')"
        )


async def _flip_current(runner: Any, ns: str, rid: str) -> None:
    await runner.update_current_edge(ns, rid, {"is_current": False})


async def _precheck_write(runner: Any, props: Mapping[str, Any]) -> None:
    """Ask the store whether an encoded write fits its limits before any prior state is mutated.

    This keeps a multi-step write (retire-then-add a version, or ensure-profile-then-add an edge) atomic on
    auto-commit backends: a store size limit is checked up front, so the first write never commits ahead of a
    second write that would fail.

    @param runner (Any): graph runner.
    @param props (Mapping[str, Any]): the encoded properties about to be written.
    @return (None): nothing; raises when the store would reject the write.
    """
    check = getattr(runner, "check_doc_size", None)
    if check is not None:
        check(props)


async def upsert_relation(
    runner: Any,
    ns: str,
    rel: RelationInput,
    *,
    evidence: list[Evidence],
    default_event_time: datetime | None,
    created_at: datetime,
) -> Relation:
    """Insert-semantics upsert of a relation: merge properties, versioning on change.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rel (RelationInput): relation to upsert.
    @param evidence (list[Evidence]): evidence to attach.
    @param default_event_time (datetime | None): fallback event time.
    @param created_at (datetime): timestamp.
    @return (Relation): the stored current version.
    """
    if rel.id is not None:
        _validate_object_id("relation", rel.id, "relation", require_own=True)
    rtype = _ids.normalize_rel_type(rel.type)
    rid = rel.id or _ids.relation_id(rel.from_entity, rtype, rel.to_entity)
    event_time = rel.event_time or default_event_time
    await runner.lock_node(ns, L_ENTITY, rel.from_entity)
    current = await get_relation_current(runner, ns, rid)

    if current is None:
        props = encode_relation_props(
            ns=ns,
            id=rid,
            revision=1,
            properties=dict(rel.properties),
            event_time=event_time,
            created_at=created_at,
            is_current=True,
            evidence=evidence,
        )
        await _create_relation_edge(runner, ns, rel.from_entity, rtype, rel.to_entity, props)
        return decode_relation(props, from_entity=rel.from_entity, to_entity=rel.to_entity, type=rtype)

    if rel.from_entity != current.from_entity or rtype != current.type or rel.to_entity != current.to_entity:
        raise ValidationError(
            f"relation {rid!r} already exists with different endpoints/type; "
            "endpoints and type are immutable; create a new relation to change them"
        )

    merged_properties = {**current.properties, **_canon_props(rel.properties)}
    unchanged = current.properties == merged_properties and to_iso(current.event_time) == to_iso(event_time)
    if unchanged:
        merged = _merge_evidence(current.evidence, evidence)
        await runner.update_current_edge(ns, rid, {"evidence_json": encode_evidence(merged)})
        current.evidence = merged
        return current

    props = encode_relation_props(
        ns=ns,
        id=rid,
        revision=current.revision + 1,
        properties=merged_properties,
        event_time=event_time,
        created_at=created_at,
        is_current=True,
        evidence=evidence,
    )
    await _precheck_write(runner, props)
    await _flip_current(runner, ns, rid)
    await _create_relation_edge(runner, ns, current.from_entity, current.type, current.to_entity, props)
    return decode_relation(props, from_entity=current.from_entity, to_entity=current.to_entity, type=current.type)


async def create_relation(
    runner: Any,
    ns: str,
    *,
    from_entity: str,
    type: str,
    to_entity: str,
    id: str | None,
    properties: dict[str, Any] | None,
    event_time: datetime | None,
    evidence: list[Evidence],
) -> Relation:
    """Create one relation version, failing if the id already exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param from_entity (str): source entity id.
    @param type (str): relation type.
    @param to_entity (str): destination entity id.
    @param id (str | None): explicit id, else derived.
    @param properties (dict[str, Any] | None): relation properties.
    @param event_time (datetime | None): valid time.
    @param evidence (list[Evidence]): evidence.
    @return (Relation): the created relation.
    """
    _require_text("relation from_entity", from_entity)
    _require_text("relation type", type)
    _require_text("relation to_entity", to_entity)
    if properties is not None:
        _require_json_mapping("properties", properties)
    _require_datetime("event_time", event_time)
    rtype = _ids.normalize_rel_type(type)
    rid = id or _ids.relation_id(from_entity, rtype, to_entity)
    if id is not None:
        _validate_object_id("relation", id, "relation", require_own=True)
    await runner.lock_node(ns, L_ENTITY, from_entity)
    if await relation_exists(runner, ns, rid):
        raise ConflictError("Relation", rid)
    props = encode_relation_props(
        ns=ns,
        id=rid,
        revision=1,
        properties=dict(properties or {}),
        event_time=event_time,
        created_at=now(),
        is_current=True,
        evidence=evidence,
    )
    await _create_relation_edge(runner, ns, from_entity, rtype, to_entity, props)
    return decode_relation(props, from_entity=from_entity, to_entity=to_entity, type=rtype)


async def update_relation(
    runner: Any,
    ns: str,
    rid: str,
    *,
    set_properties: dict[str, Any] | None,
    remove_properties: list[str],
    event_time: datetime | None,
    evidence: list[Evidence] | None,
) -> Relation:
    """Create a new version of a relation with changed properties.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @param set_properties (dict[str, Any] | None): properties to set.
    @param remove_properties (list[str]): property keys to drop.
    @param event_time (datetime | None): new valid time.
    @param evidence (list[Evidence] | None): evidence to merge.
    @return (Relation): the new current version.
    """
    _require_json_mapping("set_properties", set_properties)
    _require_list("remove_properties", remove_properties)
    _require_datetime("event_time", event_time)
    current = await get_relation_current(runner, ns, rid)
    if current is None:
        if await relation_exists(runner, ns, rid):
            raise TransientError(f"relation {rid!r} has no current version right now (concurrent write); retry")
        raise NotFoundError("Relation", rid)
    await runner.lock_node(ns, L_ENTITY, current.from_entity)
    current = await get_relation_current(runner, ns, rid)
    if current is None:
        raise TransientError(f"relation {rid!r} was changed concurrently; retry")
    new_props = dict(current.properties)
    new_props.update(_canon_props(set_properties))
    for key in remove_properties:
        new_props.pop(key, None)
    new_event_time = event_time if event_time is not None else current.event_time
    new_evidence = current.evidence if evidence is None else _merge_evidence(current.evidence, evidence)

    if new_props == current.properties and to_iso(new_event_time) == to_iso(current.event_time):
        if new_evidence != current.evidence:
            await runner.update_current_edge(ns, rid, {"evidence_json": encode_evidence(new_evidence)})
            current.evidence = new_evidence
        return current

    props = encode_relation_props(
        ns=ns,
        id=rid,
        revision=current.revision + 1,
        properties=new_props,
        event_time=new_event_time,
        created_at=now(),
        is_current=True,
        evidence=new_evidence,
    )
    await _precheck_write(runner, props)
    await _flip_current(runner, ns, rid)
    await _create_relation_edge(runner, ns, current.from_entity, current.type, current.to_entity, props)
    return decode_relation(props, from_entity=current.from_entity, to_entity=current.to_entity, type=current.type)


async def list_relations(
    runner: Any,
    ns: str,
    *,
    from_entity: str | None,
    type: str | None,
    to_entity: str | None,
    skip: int,
    limit: int,
    from_in: list[str] | None = None,
    to_in: list[str] | None = None,
) -> list[Relation]:
    """List current relations, optionally filtered by endpoints and type.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param from_entity (str | None): source filter.
    @param type (str | None): type filter.
    @param to_entity (str | None): destination filter.
    @param skip (int): rows to skip.
    @param limit (int): maximum rows.
    @param from_in (list[str] | None): keep only relations whose source is in this list.
    @param to_in (list[str] | None): keep only relations whose destination is in this list.
    @return (list[Relation]): the current relations.
    """
    _require_optional_text("from_entity filter", from_entity)
    _require_optional_text("type filter", type)
    _require_optional_text("to_entity filter", to_entity)
    for name, ids in (("from_in filter", from_in), ("to_in filter", to_in)):
        if ids is not None:
            _require_list(name, ids)
    rows = await runner.match_edges(
        ns,
        from_label=L_ENTITY,
        to_label=L_ENTITY,
        type=_ids.normalize_rel_type(type) if type else None,
        from_id=from_entity,
        to_id=to_entity,
        from_in=from_in,
        to_in=to_in,
        current_only=True,
        order_by="id",
        skip=skip,
        limit=limit,
    )
    return [decode_relation(r["props"], from_entity=r["from_id"], to_entity=r["to_id"], type=r["type"]) for r in rows]


async def delete_relation(runner: Any, ns: str, rid: str) -> dict[str, int]:
    """Delete a relation and all of its versions.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @return (dict[str, int]): counts of what was removed.
    """
    _require_id("relation", rid)
    if not await relation_exists(runner, ns, rid):
        raise NotFoundError("Relation", rid)
    trace_ids = await _traces_touching_relation(runner, ns, rid)
    n = await runner.delete_edges(ns, rid)
    deleted_decisions = 0
    for tid in trace_ids:
        if await _delete_trace_quietly(runner, ns, tid):
            deleted_decisions += 1
    return {"deleted_entities": 0, "deleted_relation_versions": n, "deleted_decisions": deleted_decisions}


async def _ensure_profile(runner: Any, ns: str, subject_id: str, created_at: datetime) -> str:
    pid = _ids.profile_id(subject_id)
    if await runner.node_exists(ns, L_PROFILE, pid):
        return pid
    if not await runner.node_exists(ns, L_ENTITY, subject_id):
        raise ValidationError(f"preference references unknown subject entity {subject_id!r}")
    await runner.upsert_node(
        ns,
        L_PROFILE,
        pid,
        {"id": pid, "ns": ns, "subject_entity": subject_id, "created_at": to_iso(created_at)},
    )
    await runner.create_edge(
        ns, R_HAS_PROFILE, L_ENTITY, subject_id, L_PROFILE, pid, {"ns": ns, "id": f"hasprofile:{pid}", "revision": 1}
    )
    return pid


def _pref_edge_type(kind: str) -> str:
    return R_AVOIDS if kind == "disinterest" else R_PREFERS


def _kind_from_type(rtype: str) -> str:
    return "disinterest" if rtype == R_AVOIDS else "preference"


async def get_preference(runner: Any, ns: str, pid: str) -> Preference | None:
    """Fetch the current version of a preference by id.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @return (Preference | None): the current version, or None.
    """
    _require_id("preference", pid)
    edge = await runner.get_current_edge(ns, pid)
    if edge is None or not _is_preference_type(edge["type"]):
        return None
    return decode_preference(
        edge["props"],
        value_entity=edge["to_id"],
        profile_id=edge["from_id"],
        kind=_kind_from_type(edge["type"]),
    )


async def preference_exists(runner: Any, ns: str, pid: str) -> bool:
    """Report whether any version of a preference (not another edge type) exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @return (bool): True when a preference with this id exists.
    """
    return bool(await _typed_edge_versions(runner, ns, pid, _is_preference_type))


async def upsert_preference(
    runner: Any,
    ns: str,
    pref: PreferenceInput,
    *,
    default_event_time: datetime | None,
    created_at: datetime,
) -> Preference:
    """Insert-semantics upsert of a preference: merge properties, versioning on change.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pref (PreferenceInput): preference to upsert.
    @param default_event_time (datetime | None): fallback event time.
    @param created_at (datetime): timestamp.
    @return (Preference): the stored current version.
    """
    _validate_strength(pref.strength)
    if pref.id is not None:
        _validate_object_id("preference", pref.id, "preference", require_own=True)
    pid = pref.id or _ids.preference_id(pref.subject_entity, pref.kind, pref.key, pref.value_entity)
    event_time = pref.event_time or default_event_time
    await _require_entity(runner, ns, pref.value_entity, context="preference")
    if pref.about_entity is not None:
        await _require_entity(runner, ns, pref.about_entity, context="preference about_entity")
    profile_id = await _ensure_profile(runner, ns, pref.subject_entity, created_at)

    await runner.lock_node(ns, L_PROFILE, profile_id)
    current = await get_preference(runner, ns, pid)
    if current is not None and (
        current.subject_entity != pref.subject_entity
        or current.kind != pref.kind
        or current.key != _ids.normalize_text(pref.key)
        or current.value_entity != pref.value_entity
    ):
        raise ValidationError(
            f"preference {pid!r} already exists with different subject/kind/key/value; "
            "these identify the preference and are immutable; create a new preference to change them"
        )
    merged_props = {**(current.properties if current is not None else {}), **_canon_props(pref.properties)}
    props = encode_preference_props(
        ns=ns,
        id=pid,
        revision=1 if current is None else current.revision + 1,
        subject_entity=pref.subject_entity,
        key=_ids.normalize_text(pref.key),
        about_entity=pref.about_entity,
        strength=pref.strength,
        properties=merged_props,
        event_time=event_time,
        created_at=created_at,
        is_current=True,
    )

    if current is not None:
        unchanged = (
            current.strength == pref.strength
            and current.about_entity == pref.about_entity
            and current.properties == merged_props
            and to_iso(current.event_time) == to_iso(event_time)
        )
        if unchanged:
            return current
        await _precheck_write(runner, props)
        await _flip_current(runner, ns, pid)

    await runner.create_edge(ns, _pref_edge_type(pref.kind), L_PROFILE, profile_id, L_ENTITY, pref.value_entity, props)
    return decode_preference(props, value_entity=pref.value_entity, profile_id=profile_id, kind=pref.kind)


async def create_preference(
    runner: Any,
    ns: str,
    *,
    subject_entity: str,
    key: str,
    value_entity: str,
    id: str | None,
    kind: str,
    about_entity: str | None,
    strength: float | None,
    properties: dict[str, Any] | None,
    event_time: datetime | None,
) -> Preference:
    """Create one preference, failing if its id already exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param subject_entity (str): subject entity id.
    @param key (str): preference key.
    @param value_entity (str): value entity id.
    @param id (str | None): explicit id, else derived.
    @param kind (str): preference or disinterest.
    @param about_entity (str | None): entity the preference is about.
    @param strength (float | None): strength.
    @param properties (dict[str, Any] | None): properties.
    @param event_time (datetime | None): valid time.
    @return (Preference): the created preference.
    """
    _validate_kind(kind)
    _validate_strength(strength)
    _require_text("preference subject_entity", subject_entity)
    _require_text("preference key", key)
    _require_text("preference value_entity", value_entity)
    key = _ids.normalize_text(key)
    if properties is not None:
        _require_json_mapping("properties", properties)
    _require_datetime("event_time", event_time)
    if id is not None:
        _validate_object_id("preference", id, "preference", require_own=True)
    pid = id or _ids.preference_id(subject_entity, kind, key, value_entity)
    await _require_entity(runner, ns, value_entity, context="preference")
    if about_entity is not None:
        await _require_entity(runner, ns, about_entity, context="preference about_entity")
    props = encode_preference_props(
        ns=ns,
        id=pid,
        revision=1,
        subject_entity=subject_entity,
        key=key,
        about_entity=about_entity,
        strength=strength,
        properties=dict(properties or {}),
        event_time=event_time,
        created_at=now(),
        is_current=True,
    )
    await _precheck_write(runner, props)
    profile_id = await _ensure_profile(runner, ns, subject_entity, now())
    await runner.lock_node(ns, L_PROFILE, profile_id)
    if await preference_exists(runner, ns, pid):
        raise ConflictError("Preference", pid)
    await runner.create_edge(ns, _pref_edge_type(kind), L_PROFILE, profile_id, L_ENTITY, value_entity, props)
    return decode_preference(props, value_entity=value_entity, profile_id=profile_id, kind=kind)


async def update_preference(
    runner: Any,
    ns: str,
    pid: str,
    *,
    strength: float | None,
    properties: dict[str, Any] | None,
    remove_properties: list[str],
    event_time: datetime | None,
) -> Preference:
    """Create a new version of a preference, merging properties like entities and relations.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @param strength (float | None): new strength.
    @param properties (dict[str, Any] | None): properties to merge in.
    @param remove_properties (list[str]): property keys to drop.
    @param event_time (datetime | None): new valid time.
    @return (Preference): the new current version.
    """
    _validate_strength(strength)
    _require_json_mapping("properties", properties)
    _require_list("remove_properties", remove_properties)
    _require_datetime("event_time", event_time)
    current = await get_preference(runner, ns, pid)
    if current is None:
        if await preference_exists(runner, ns, pid):
            raise TransientError(f"preference {pid!r} has no current version right now (concurrent write); retry")
        raise NotFoundError("Preference", pid)
    await runner.lock_node(ns, L_PROFILE, current.profile_id)
    current = await get_preference(runner, ns, pid)
    if current is None:
        raise TransientError(f"preference {pid!r} was changed concurrently; retry")
    new_strength = strength if strength is not None else current.strength
    new_props = {**current.properties, **_canon_props(properties)}
    for prop_key in remove_properties:
        new_props.pop(prop_key, None)
    new_event_time = event_time if event_time is not None else current.event_time
    if (
        new_strength == current.strength
        and new_props == current.properties
        and to_iso(new_event_time) == to_iso(current.event_time)
    ):
        return current
    props = encode_preference_props(
        ns=ns,
        id=pid,
        revision=current.revision + 1,
        subject_entity=current.subject_entity,
        key=current.key,
        about_entity=current.about_entity,
        strength=new_strength,
        properties=new_props,
        event_time=new_event_time,
        created_at=now(),
        is_current=True,
    )
    await _precheck_write(runner, props)
    await _flip_current(runner, ns, pid)
    await runner.create_edge(
        ns,
        _pref_edge_type(current.kind),
        L_PROFILE,
        current.profile_id,
        L_ENTITY,
        current.value_entity,
        props,
    )
    return decode_preference(props, value_entity=current.value_entity, profile_id=current.profile_id, kind=current.kind)


async def list_preference_versions(runner: Any, ns: str, pid: str, *, newest_first: bool) -> list[Preference]:
    """Return every version of a preference.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @param newest_first (bool): order newest first when True.
    @return (list[Preference]): the versions.
    """
    _require_id("preference", pid)
    edges = await _typed_edge_versions(runner, ns, pid, _is_preference_type)
    prefs = [
        decode_preference(e["props"], value_entity=e["to_id"], profile_id=e["from_id"], kind=_kind_from_type(e["type"]))
        for e in edges
    ]
    if newest_first:
        prefs.reverse()
    return prefs


async def list_preferences(
    runner: Any,
    ns: str,
    *,
    subject_entity: str | None,
    key: str | None,
    kind: str | None,
    skip: int,
    limit: int,
) -> list[Preference]:
    """List current preferences, optionally scoped to one subject.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param subject_entity (str | None): subject entity id, or None for every subject.
    @param key (str | None): key filter.
    @param kind (str | None): preference or disinterest filter.
    @param skip (int): rows to skip.
    @param limit (int): maximum rows.
    @return (list[Preference]): the current preferences.
    """
    _require_optional_text("subject_entity filter", subject_entity)
    _require_optional_text("key filter", key)
    if kind is not None:
        _validate_kind(kind)
    equals: dict[str, Any] = {}
    if subject_entity is not None:
        equals["subject_entity"] = subject_entity
    if key is not None:
        equals["key"] = _ids.normalize_text(key)
    etype = _pref_edge_type(kind) if kind is not None else None
    rows = await runner.match_edges(
        ns,
        from_label=L_PROFILE,
        to_label=None,
        type=etype,
        current_only=True,
        equals=equals,
        order_by="id",
        skip=skip,
        limit=limit,
    )
    return [
        decode_preference(r["props"], value_entity=r["to_id"], profile_id=r["from_id"], kind=_kind_from_type(r["type"]))
        for r in rows
    ]


async def delete_preference(runner: Any, ns: str, pid: str) -> dict[str, int]:
    """Delete a preference and all of its versions.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @return (dict[str, int]): counts of what was removed.
    """
    _require_id("preference", pid)
    if not await preference_exists(runner, ns, pid):
        raise NotFoundError("Preference", pid)
    n = await runner.delete_edges(ns, pid)
    return {
        "deleted_entities": 0,
        "deleted_relation_versions": 0,
        "deleted_decisions": 0,
        "deleted_preference_versions": n,
    }


async def _read_steps(runner: Any, ns: str, tid: str) -> list[DecisionStep]:
    rows = await runner.child_nodes(ns, L_TRACE, tid, R_HAS_STEP, L_STEP, order_by="order")
    return [
        DecisionStep(
            order=int(r["order"]),
            relation_id=r["relation_id"],
            from_entity=r["from_entity"],
            to_entity=r["to_entity"],
        )
        for r in sorted(rows, key=lambda r: int(r["order"]))
    ]


async def get_trace(runner: Any, ns: str, tid: str) -> DecisionTrace | None:
    """Fetch one decision trace by id.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tid (str): trace id.
    @return (DecisionTrace | None): the trace, or None.
    """
    _require_id("decision", tid)
    props = await runner.get_node(ns, L_TRACE, tid)
    if props is None:
        return None
    steps = await _read_steps(runner, ns, tid)
    return decode_trace(props, steps)


async def trace_exists(runner: Any, ns: str, tid: str) -> bool:
    """Report whether a decision trace exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tid (str): trace id.
    @return (bool): True when it exists.
    """
    return await runner.node_exists(ns, L_TRACE, tid)


async def _resolve_steps(runner: Any, ns: str, step_rel_ids: list[str]) -> list[DecisionStep]:
    steps: list[DecisionStep] = []
    for order, rel_id in enumerate(step_rel_ids):
        rel = await get_relation_current(runner, ns, rel_id)
        if rel is None:
            raise ValidationError(f"decision step references unknown relation {rel_id!r}")
        steps.append(
            DecisionStep(order=order, relation_id=rel_id, from_entity=rel.from_entity, to_entity=rel.to_entity)
        )
    return steps


async def _write_trace_structure(
    runner: Any,
    ns: str,
    *,
    tid: str,
    actor_entity: str | None,
    outcome_entity: str | None,
    alternative_entities: list[str],
    steps: list[DecisionStep],
) -> None:
    if actor_entity is not None:
        await runner.create_edge(ns, R_MADE_DECISION, L_ENTITY, actor_entity, L_TRACE, tid, {"ns": ns})
    if outcome_entity is not None:
        await runner.create_edge(ns, R_RESULTED_IN, L_TRACE, tid, L_ENTITY, outcome_entity, {"ns": ns})
    for alt in alternative_entities:
        await runner.create_edge(ns, R_CONSIDERED, L_TRACE, tid, L_ENTITY, alt, {"ns": ns})
    for step in steps:
        sid = f"{tid}:step:{step.order}"
        await runner.upsert_node(
            ns,
            L_STEP,
            sid,
            {
                "id": sid,
                "ns": ns,
                "relation_id": step.relation_id,
                "order": step.order,
                "from_entity": step.from_entity,
                "to_entity": step.to_entity,
            },
        )
        await runner.create_edge(ns, R_HAS_STEP, L_TRACE, tid, L_STEP, sid, {"ns": ns, "order": step.order})
        await runner.create_edge(ns, R_FROM, L_STEP, sid, L_ENTITY, step.from_entity, {"ns": ns})
        await runner.create_edge(ns, R_TO, L_STEP, sid, L_ENTITY, step.to_entity, {"ns": ns})


async def _clear_trace_structure(runner: Any, ns: str, tid: str) -> None:
    for step in await runner.child_nodes(ns, L_TRACE, tid, R_HAS_STEP, L_STEP):
        await runner.delete_node(ns, L_STEP, step["id"])
    for rtype in (R_MADE_DECISION, R_RESULTED_IN, R_CONSIDERED):
        await runner.delete_edges_touching_by_type(ns, L_TRACE, tid, rtype)


async def _validate_trace_refs(
    runner: Any,
    ns: str,
    *,
    actor_entity: str | None,
    outcome_entity: str | None,
    alternative_entities: list[str],
) -> None:
    if actor_entity is not None:
        await _require_entity(runner, ns, actor_entity, context="decision actor_entity")
    if outcome_entity is not None:
        await _require_entity(runner, ns, outcome_entity, context="decision outcome_entity")
    for alt in alternative_entities:
        await _require_entity(runner, ns, alt, context="decision alternative_entity")


async def upsert_trace(
    runner: Any,
    ns: str,
    *,
    tid: str | None,
    title: str,
    step_rel_ids: list[str],
    actor_entity: str | None,
    summary: str | None,
    rationale: str | None,
    outcome_entity: str | None,
    alternative_entities: list[str],
    status: str,
    event_time: datetime | None,
    created_at: datetime,
) -> DecisionTrace:
    """Insert-semantics upsert of a decision trace and its structure.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tid (str | None): explicit id, else derived.
    @param title (str): trace title.
    @param step_rel_ids (list[str]): ordered relation ids for the steps.
    @param actor_entity (str | None): actor entity id.
    @param summary (str | None): summary.
    @param rationale (str | None): rationale.
    @param outcome_entity (str | None): outcome entity id.
    @param alternative_entities (list[str]): alternative entity ids.
    @param status (str): status.
    @param event_time (datetime | None): valid time.
    @param created_at (datetime): timestamp.
    @return (DecisionTrace): the stored trace.
    """
    _validate_status(status)
    _require_text("decision title", title)
    title = _ids.normalize_text(title)
    if actor_entity is not None:
        _require_text("decision actor_entity", actor_entity)
    _require_optional_text("decision summary", summary)
    _require_optional_text("decision rationale", rationale)
    _require_list("decision steps", step_rel_ids)
    _require_list("alternative_entities", alternative_entities)
    _require_datetime("event_time", event_time)
    if tid is not None:
        _validate_object_id("decision", tid, "decision", require_own=True)
    alternative_entities = _dedup_list(list(alternative_entities))
    tid = tid or _ids.decision_id(actor_entity, title)
    await _validate_trace_refs(
        runner,
        ns,
        actor_entity=actor_entity,
        outcome_entity=outcome_entity,
        alternative_entities=alternative_entities,
    )
    steps = await _resolve_steps(runner, ns, step_rel_ids)
    await runner.lock_node(ns, L_TRACE, tid)
    existing = await get_trace(runner, ns, tid)
    if existing is not None and (
        existing.title == title
        and existing.actor_entity == actor_entity
        and existing.summary == summary
        and existing.rationale == rationale
        and existing.status == status
        and existing.outcome_entity == outcome_entity
        and list(existing.alternative_entities) == alternative_entities
        and to_iso(existing.event_time) == to_iso(event_time)
        and [s.relation_id for s in existing.steps] == [s.relation_id for s in steps]
    ):
        return existing
    made_at = existing.created_at if existing is not None else created_at
    props = encode_trace_props(
        ns=ns,
        id=tid,
        title=title,
        actor_entity=actor_entity,
        summary=summary,
        rationale=rationale,
        status=status,
        outcome_entity=outcome_entity,
        alternative_entities=alternative_entities,
        event_time=event_time,
        created_at=made_at,
        updated_at=created_at,
    )
    await _precheck_write(runner, props)
    if existing is not None:
        await _clear_trace_structure(runner, ns, tid)
    await runner.upsert_node(ns, L_TRACE, tid, props)
    await _write_trace_structure(
        runner,
        ns,
        tid=tid,
        actor_entity=actor_entity,
        outcome_entity=outcome_entity,
        alternative_entities=alternative_entities,
        steps=steps,
    )
    return decode_trace(props, steps)


async def create_trace(
    runner: Any,
    ns: str,
    *,
    title: str,
    steps: list[str],
    id: str | None,
    actor_entity: str | None,
    summary: str | None,
    rationale: str | None,
    outcome_entity: str | None,
    alternative_entities: list[str],
    status: str,
    event_time: datetime | None,
) -> DecisionTrace:
    """Create one decision trace, failing if its id already exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param title (str): trace title.
    @param steps (list[str]): ordered relation ids.
    @param id (str | None): explicit id, else derived.
    @param actor_entity (str | None): actor entity id.
    @param summary (str | None): summary.
    @param rationale (str | None): rationale.
    @param outcome_entity (str | None): outcome entity id.
    @param alternative_entities (list[str]): alternative entity ids.
    @param status (str): status.
    @param event_time (datetime | None): valid time.
    @return (DecisionTrace): the created trace.
    """
    _require_text("decision title", title)
    title = _ids.normalize_text(title)
    if actor_entity is not None:
        _require_text("decision actor_entity", actor_entity)
    if id is not None:
        _validate_object_id("decision", id, "decision", require_own=True)
    tid = id or _ids.decision_id(actor_entity, title)
    await runner.lock_node(ns, L_TRACE, tid)
    if await trace_exists(runner, ns, tid):
        raise ConflictError("DecisionTrace", tid)
    return await upsert_trace(
        runner,
        ns,
        tid=tid,
        title=title,
        step_rel_ids=steps,
        actor_entity=actor_entity,
        summary=summary,
        rationale=rationale,
        outcome_entity=outcome_entity,
        alternative_entities=alternative_entities,
        status=status,
        event_time=event_time,
        created_at=now(),
    )


async def update_trace(runner: Any, ns: str, tid: str, **fields: Any) -> DecisionTrace:
    """Update a decision trace, rewriting its structure.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tid (str): trace id.
    @param fields (Any): fields to change.
    @return (DecisionTrace): the updated trace.
    """
    await runner.lock_node(ns, L_TRACE, tid)
    existing = await get_trace(runner, ns, tid)
    if existing is None:
        raise NotFoundError("DecisionTrace", tid)
    unknown = set(fields) - _DECISION_UPDATE_FIELDS
    if unknown:
        raise ValidationError(f"unknown decision update field(s): {sorted(unknown)}")
    merged = {
        "title": fields.get("title", existing.title),
        "actor_entity": fields.get("actor_entity", existing.actor_entity),
        "summary": fields.get("summary", existing.summary),
        "rationale": fields.get("rationale", existing.rationale),
        "outcome_entity": fields.get("outcome_entity", existing.outcome_entity),
        "alternative_entities": fields.get("alternative_entities", existing.alternative_entities),
        "status": fields.get("status", existing.status),
        "event_time": fields.get("event_time", existing.event_time),
    }
    step_rel_ids = fields["steps"] if "steps" in fields else [s.relation_id for s in existing.steps]
    return await upsert_trace(
        runner,
        ns,
        tid=tid,
        title=merged["title"],
        step_rel_ids=step_rel_ids,
        actor_entity=merged["actor_entity"],
        summary=merged["summary"],
        rationale=merged["rationale"],
        outcome_entity=merged["outcome_entity"],
        alternative_entities=merged["alternative_entities"],
        status=merged["status"],
        event_time=merged["event_time"],
        created_at=now(),
    )


async def list_traces(
    runner: Any,
    ns: str,
    *,
    actor_entity: str | None,
    status: str | None,
    skip: int,
    limit: int,
) -> list[DecisionTrace]:
    """List decision traces, optionally filtered by actor and status.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param actor_entity (str | None): actor filter.
    @param status (str | None): status filter.
    @param skip (int): rows to skip.
    @param limit (int): maximum rows.
    @return (list[DecisionTrace]): the traces.
    """
    _require_optional_text("actor_entity filter", actor_entity)
    _require_optional_text("status filter", status)
    equals: dict[str, Any] = {}
    if actor_entity is not None:
        equals["actor_entity"] = actor_entity
    if status is not None:
        equals["status"] = status
    rows = await runner.match_nodes(ns, L_TRACE, equals=equals, order_by="id", skip=skip, limit=limit)
    traces = []
    for props in rows:
        steps = await _read_steps(runner, ns, props["id"])
        traces.append(decode_trace(props, steps))
    return traces


async def delete_trace(runner: Any, ns: str, tid: str) -> dict[str, int]:
    """Delete a decision trace and its steps.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tid (str): trace id.
    @return (dict[str, int]): counts of what was removed.
    """
    _require_id("decision", tid)
    if not await _delete_trace_quietly(runner, ns, tid):
        raise NotFoundError("DecisionTrace", tid)
    return {"deleted_entities": 0, "deleted_relation_versions": 0, "deleted_decisions": 1}
