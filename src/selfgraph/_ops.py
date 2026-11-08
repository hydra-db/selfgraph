from __future__ import annotations

import math
from collections.abc import Awaitable, Callable, Iterable, Mapping
from datetime import datetime
from functools import partial
from typing import Any, get_args

from . import ids as _ids
from ._serde import (
    EDGE_TYPES,
    L_ENTITY,
    L_EVIDENCE,
    L_PROFILE,
    L_STEP,
    L_TRACE,
    LABELS,
    PREFERENCE_EDGE_TYPES,
    R_CONSIDERED,
    R_FROM,
    R_HAS_PROFILE,
    R_HAS_STEP,
    R_MADE_DECISION,
    R_RESULTED_IN,
    R_TO,
    _dumps,
    _loads,
    child_edge_id,
    decode_entity,
    decode_evidence,
    decode_preference,
    decode_relation,
    decode_trace,
    encode_entity_props,
    encode_evidence_props,
    encode_preference_props,
    encode_relation_props,
    encode_trace_props,
    now,
    preference_edge_type,
    preference_kind_of,
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

_RESERVED_LABELS = frozenset(t.lower() for t in LABELS)
_NO_DELETES = {
    "deleted_entities": 0,
    "deleted_relation_versions": 0,
    "deleted_decisions": 0,
    "deleted_preference_versions": 0,
}
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
_PAGE = 500
_BATCH = 1000

SchemaCheck = Callable[[Any, Ontology], Awaitable[None]]


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
    if type.strip().lower() in _RESERVED_LABELS:
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
    if prefix_part.lower() in _ids.RESERVED_ID_PREFIXES:
        raise ValidationError(f"entity id prefix {prefix_part!r} is reserved for internal use")
    if len(eid.encode("utf-8")) > _MAX_ID_BYTES:
        raise ValidationError(
            f"entity id is too long ({len(eid.encode('utf-8'))} bytes); keep ids under {_MAX_ID_BYTES} bytes"
        )


def _reject_reserved_rel_type(rtype: str, given: str) -> None:
    """Reject a relation type that names one of SelfGraph's internal edge types.

    @param rtype (str): the normalized relation type.
    @param given (str): the type as the caller wrote it, for the message.
    @return (None): nothing; raises ValidationError on a reserved type.
    """
    if rtype in EDGE_TYPES:
        raise ValidationError(f"relation type {given!r} is reserved for internal use; choose another type")


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


def _validate_own_id(kind: str, oid: str | None) -> None:
    """Validate a caller-chosen relation, preference, or decision id, which must carry its own kind as prefix.

    @param kind (str): the object kind and required id prefix.
    @param oid (str | None): the id, or None to skip the check.
    @return (None): nothing; raises ValidationError on a bad id.
    """
    if oid is None:
        return
    if not isinstance(oid, str) or not oid:
        raise ValidationError(f"{kind} id must be a non-empty string, got {type(oid).__name__}")
    if _has_control(oid):
        raise ValidationError(f"{kind} id cannot contain control or surrogate characters")
    if len(oid.encode("utf-8")) > _MAX_ID_BYTES:
        raise ValidationError(
            f"{kind} id is too long ({len(oid.encode('utf-8'))} bytes); keep ids under {_MAX_ID_BYTES} bytes"
        )
    prefix = oid.split(":", 1)[0].lower() if ":" in oid else ""
    if prefix != kind:
        raise ValidationError(f"{kind} id must start with '{kind}:', got {oid!r}")
    if not oid.split(":", 1)[1].strip():
        raise ValidationError(f"{kind} id must have a non-empty name after '{kind}:', got {oid!r}")


_KINDS = frozenset(get_args(Kind))
_STATUSES = frozenset(get_args(Status))


def _require_choice(field: str, value: Any, choices: frozenset[str]) -> None:
    """Validate a value is one of the allowed strings.

    @param field (str): the field name for the error message.
    @param value (Any): the value to check.
    @param choices (frozenset[str]): the allowed values.
    @return (None): nothing; raises ValidationError on any other value.
    """
    if not isinstance(value, str) or value not in choices:
        raise ValidationError(f"{field} must be one of {sorted(choices)}, got {value!r}")


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
    source_id: str | None = None,
    source_version: str | None = None,
) -> list[Evidence]:
    """Turn caller-supplied EvidenceInput into stored Evidence.

    @param inputs (list[EvidenceInput] | tuple[EvidenceInput, ...]): evidence to convert.
    @param source_id (str | None): the source being inserted; only evidence citing it takes source_version.
    @param source_version (str | None): the inserted source's version; other evidence gets "<source_id>:manual".
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
        sv = source_version if source_version and ev.source_id == source_id else f"{ev.source_id}:manual"
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


def _clean_text(value: Any) -> Any:
    return _ids.normalize_text(value).strip() if isinstance(value, str) else value


def _dedup_list(items: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(items))


def _dedup_text_list(items: list[str]) -> list[str]:
    """Dedup a list of display-text values after NFC-normalizing each, so surface forms collapse.

    @param items (list[str]): the display-text values to normalize and dedup.
    @return (list[str]): the NFC-normalized values with duplicates removed, order preserved.
    """
    return _dedup_list([_ids.normalize_text(item) if isinstance(item, str) else item for item in items])


async def _paged(fetch: Callable[..., Any], cap: int | None = None, page: int = _PAGE) -> list:
    """Call a skip/limit list function page by page until it runs dry or reaches the cap.

    @param fetch (Callable[..., Awaitable[list]]): the list call, given skip and limit as keywords.
    @param cap (int | None): the most rows to read, or None for all.
    @param page (int): the rows to read per call.
    @return (list): every row read, in store order.
    """
    out: list = []
    while cap is None or len(out) < cap:
        batch = await fetch(skip=len(out), limit=page)
        out.extend(batch)
        if len(batch) < page:
            break
    return out


def _batches(items: list) -> list[list]:
    """Split a list into consecutive batches of at most _BATCH items.

    @param items (list): the items to split.
    @return (list[list]): the batches, in order.
    """
    return [items[i : i + _BATCH] for i in range(0, len(items), _BATCH)]


async def _nodes_by_id(runner: Any, ns: str, label: str, ids: list[str]) -> dict[str, dict]:
    """Fetch the stored properties of many nodes of one label by id, a batch per query.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param label (str): node label.
    @param ids (list[str]): the node ids.
    @return (dict[str, dict]): each found node's properties by id.
    """
    found: dict[str, dict] = {}
    for batch in _batches(ids):
        for props in await runner.match_nodes(ns, label, any_of={"id": batch}, limit=len(batch)):
            found[props["id"]] = props
    return found


async def _plan_evidence(
    runner: Any, ns: str, items: list[tuple[str, Evidence]], *, new_targets: set[str]
) -> tuple[list[tuple[str, dict]], dict[str, int]]:
    """Find which evidence records are not stored yet and how many distinct sources each target gains.

    Records are looked up by id first; only a target missing a record is then checked for any record from that
    source. A target with no stored version has no stored evidence, so targets in new_targets skip both lookups.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param items (list[tuple[str, Evidence]]): (target id, evidence) pairs to record.
    @param new_targets (set[str]): targets known to have no stored evidence.
    @return (tuple[list[tuple[str, dict]], dict[str, int]]): the records to write, and the sources gained per target.
    """
    pending: dict[str, tuple[str, Evidence]] = {}
    for target, ev in items:
        evid = _ids.evidence_id(
            target, ev.source_id, ev.source_version, ev.chunk_id, ev.quote, ev.start_offset, ev.end_offset
        )
        pending.setdefault(evid, (target, ev))
    known = [evid for evid, (target, _) in pending.items() if target not in new_targets]
    stored_ids = set(await _nodes_by_id(runner, ns, L_EVIDENCE, known))
    by_source: dict[str, dict[str, None]] = {}
    for evid in known:
        if evid not in stored_ids:
            target, ev = pending[evid]
            by_source.setdefault(ev.source_id, {})[target] = None
    seen: set[tuple[str, str]] = set()
    for source_id, targets in by_source.items():
        for batch in _batches(list(targets)):
            fetch = partial(
                runner.match_nodes, ns, L_EVIDENCE, equals={"source_id": source_id}, any_of={"target_id": batch}
            )
            for props in await _paged(fetch, page=_BATCH):
                seen.add((props["target_id"], source_id))
    records: list[tuple[str, dict]] = []
    gained: dict[str, int] = {}
    for evid, (target, ev) in pending.items():
        if evid in stored_ids:
            continue
        records.append((evid, encode_evidence_props(ns=ns, id=evid, target_id=target, evidence=ev)))
        if (target, ev.source_id) not in seen:
            seen.add((target, ev.source_id))
            gained[target] = gained.get(target, 0) + 1
    return records, gained


async def _write_evidence(runner: Any, ns: str, records: list[tuple[str, dict]]) -> None:
    if records:
        await runner.upsert_nodes(ns, L_EVIDENCE, records)


async def list_evidence(runner: Any, ns: str, target_id: str, *, kind: str, skip: int, limit: int) -> list[Evidence]:
    """List the evidence records supporting one entity or relation, ordered by evidence id.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param target_id (str): the entity or relation id.
    @param kind (str): "entity" or "relation", for validation and the not-found error.
    @param skip (int): rows to skip.
    @param limit (int): maximum rows.
    @return (list[Evidence]): the evidence; raises NotFoundError when the first page is empty and the target is unknown.
    """
    _ids._require_str(f"{kind} id", target_id)
    rows = await runner.match_nodes(
        ns, L_EVIDENCE, equals={"target_id": target_id}, order_by="id", skip=skip, limit=limit
    )
    if not rows and skip == 0:
        if kind == "entity":
            exists = await runner.node_exists(ns, L_ENTITY, target_id)
        else:
            exists = await relation_exists(runner, ns, target_id)
        if not exists:
            raise NotFoundError("Entity" if kind == "entity" else "Relation", target_id)
    return [decode_evidence(r) for r in rows]


async def _delete_evidence(runner: Any, ns: str, target_id: str) -> None:
    await runner.delete_nodes_by(ns, L_EVIDENCE, equals={"target_id": target_id})


async def _entity_known(runner: Any, ns: str, eid: str, known: set[str] | frozenset[str]) -> bool:
    if not isinstance(eid, str):
        raise ValidationError(f"entity reference must be a string id, got {type(eid).__name__}")
    if _has_control(eid):
        raise ValidationError("entity reference cannot contain control or surrogate characters")
    return eid in known or await runner.node_exists(ns, L_ENTITY, eid)


async def _require_entity(
    runner: Any, ns: str, eid: str | None, context: str, known: set[str] | frozenset[str] = frozenset()
) -> None:
    if eid is not None and not await _entity_known(runner, ns, eid, known):
        raise ValidationError(f"{context} references unknown entity {eid!r}")


async def _require_preference_refs(
    runner: Any, ns: str, value_entity: str, about_entity: str | None, known: set[str] | frozenset[str] = frozenset()
) -> None:
    await _require_entity(runner, ns, value_entity, "preference", known)
    await _require_entity(runner, ns, about_entity, "preference about_entity", known)


async def _require_trace_refs(
    runner: Any,
    ns: str,
    actor_entity: str | None,
    outcome_entity: str | None,
    alternative_entities: Iterable[str],
    known: set[str] | frozenset[str] = frozenset(),
) -> None:
    await _require_entity(runner, ns, actor_entity, "decision actor_entity", known)
    await _require_entity(runner, ns, outcome_entity, "decision outcome_entity", known)
    for alt in alternative_entities:
        await _require_entity(runner, ns, alt, "decision alternative_entity", known)


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

    entity_ids = [ent.id or _ids.entity_id(ent.type, ent.name) for ent in ontology.entities]
    entities = set(entity_ids)
    relations = {rel.id or _ids.relation_id(rel.from_entity, rel.type, rel.to_entity) for rel in ontology.relations}

    for eid, ent in zip(entity_ids, ontology.entities, strict=True):
        _validate_entity_identity(eid, ent.type, ent.name)

    for item in (*ontology.entities, *ontology.relations, *ontology.preferences):
        if item.properties is None:
            raise ValidationError("properties must be a mapping, got NoneType")
        _require_json_mapping("properties", item.properties)
    for ent in ontology.entities:
        _require_str_mapping("external_ids", ent.external_ids)
        _require_list("entity aliases", ent.aliases)

    for rel in ontology.relations:
        _validate_own_id("relation", rel.id)
        _require_datetime("relation event_time", rel.event_time)
        _reject_reserved_rel_type(_ids.normalize_rel_type(rel.type), rel.type)
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
        _validate_own_id("preference", pref.id)
        _require_datetime("preference event_time", pref.event_time)
        _require_choice("preference kind", pref.kind, _KINDS)
        _require_text("preference key", pref.key)
        _validate_strength(pref.strength)
        if not await _entity_known(runner, ns, pref.subject_entity, entities):
            raise ValidationError(f"preference references unknown subject entity {pref.subject_entity!r}")
        await _require_preference_refs(runner, ns, pref.value_entity, pref.about_entity, entities)

    for dec in ontology.decisions:
        _validate_own_id("decision", dec.id)
        _require_datetime("decision event_time", dec.event_time)
        _require_choice("decision status", dec.status, _STATUSES)
        _require_text("decision title", dec.title)
        _require_optional_text("decision summary", dec.summary)
        _require_optional_text("decision rationale", dec.rationale)
        _require_list("decision steps", dec.steps)
        _require_list("decision alternative_entities", dec.alternative_entities)
        for rel_id in dec.steps:
            if rel_id not in relations and await get_relation_current(runner, ns, rel_id) is None:
                raise ValidationError(f"decision step references unknown relation {rel_id!r}")
        await _require_trace_refs(runner, ns, dec.actor_entity, dec.outcome_entity, dec.alternative_entities, entities)


async def get_entity(runner: Any, ns: str, eid: str) -> Entity | None:
    """Fetch one entity by id, or None.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): entity id.
    @return (Entity | None): the entity, or None.
    """
    _ids._require_str("entity id", eid)
    props = await runner.get_node(ns, L_ENTITY, eid)
    return decode_entity(props) if props else None


async def upsert_entities(
    runner: Any,
    ns: str,
    ents: list[EntityInput],
    *,
    evidence: list[Evidence],
    created_at: datetime,
) -> list[Entity]:
    """Insert-semantics upsert of many entities: keep stored names, record new surface forms as aliases, merge the rest.

    Entities are read and written in batches; a repeated id merges into the earlier input, as sequential upserts would.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param ents (list[EntityInput]): entities to upsert, in order.
    @param evidence (list[Evidence]): evidence recorded for every entity.
    @param created_at (datetime): timestamp for created and updated fields.
    @return (list[Entity]): each input's stored entity, in input order.
    """
    keyed = []
    for ent in ents:
        etype = _clean_text(ent.type)
        ename = _clean_text(ent.name)
        eid = ent.id or _ids.entity_id(etype, ename)
        _validate_entity_identity(eid, etype, ename)
        keyed.append((eid, etype, ename, ent))
    eids = list(dict.fromkeys(eid for eid, *_ in keyed))
    for eid in eids:
        await runner.lock_node(ns, L_ENTITY, eid)
    stored = {eid: decode_entity(p) for eid, p in (await _nodes_by_id(runner, ns, L_ENTITY, eids)).items()}
    records, gained = await _plan_evidence(
        runner, ns, [(eid, ev) for eid in eids for ev in evidence], new_targets=set(eids) - set(stored)
    )

    current: dict[str, Entity] = dict(stored)
    writes: dict[str, dict] = {}
    out: list[Entity] = []
    for eid, etype, ename, ent in keyed:
        prev = current.get(eid)
        sources = (prev.source_count if prev is not None else 0) + gained.pop(eid, 0)
        if prev is None:
            props = encode_entity_props(
                ns=ns,
                id=eid,
                type=etype,
                name=ename,
                aliases=_dedup_text_list(ent.aliases),
                external_ids=dict(ent.external_ids),
                properties=dict(ent.properties),
                source_count=sources,
                created_at=created_at,
                updated_at=created_at,
            )
        else:
            renamed = [ename] if ename != prev.name else []
            merged_aliases = _dedup_text_list([*prev.aliases, *ent.aliases, *renamed])
            merged_external = {**prev.external_ids, **ent.external_ids}
            merged_properties = {**prev.properties, **_canon_props(ent.properties)}
            if (
                etype == prev.type
                and merged_aliases == prev.aliases
                and merged_external == prev.external_ids
                and merged_properties == prev.properties
                and sources == prev.source_count
            ):
                out.append(prev)
                continue
            props = encode_entity_props(
                ns=ns,
                id=eid,
                type=etype,
                name=prev.name,
                aliases=merged_aliases,
                external_ids=merged_external,
                properties=merged_properties,
                source_count=sources,
                created_at=prev.created_at,
                updated_at=created_at,
            )
        writes[eid] = props
        current[eid] = decode_entity(props)
        out.append(current[eid])

    for props in writes.values():
        await _precheck_write(runner, props)
    for eid, props in writes.items():
        if eid in stored and props["type"] != stored[eid].type:
            await runner.remove_node_label(ns, L_ENTITY, eid, stored[eid].type)
    by_type: dict[str, list[tuple[str, dict]]] = {}
    for eid, props in writes.items():
        by_type.setdefault(props["type"], []).append((eid, props))
    for etype, rows in by_type.items():
        await runner.upsert_nodes(ns, L_ENTITY, rows, extra_label=etype)
    await _write_evidence(runner, ns, records)
    return out


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
    schema_check: SchemaCheck | None = None,
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
    @param schema_check (SchemaCheck | None): checks the entity against the schema before the write.
    @return (Entity): the created entity.
    """
    _require_text("entity type", type)
    _require_text("entity name", name)
    type = _clean_text(type)
    name = _clean_text(name)
    eid = id or _ids.entity_id(type, name)
    _validate_entity_identity(eid, type, name)
    if aliases is not None:
        _require_list("aliases", aliases)
    if external_ids is not None:
        _require_str_mapping("external_ids", external_ids)
    _require_json_mapping("properties", properties)
    await runner.lock_node(ns, L_ENTITY, eid)
    if await runner.node_exists(ns, L_ENTITY, eid):
        raise ConflictError("Entity", eid)
    if schema_check is not None:
        subject = EntityInput(id=id, type=type, name=name, properties=properties or {})
        await schema_check(runner, Ontology(entities=[subject]))
    ts = now()
    props = encode_entity_props(
        ns=ns,
        id=eid,
        type=type,
        name=name,
        aliases=_dedup_text_list(aliases or []),
        external_ids=dict(external_ids or {}),
        properties=dict(properties or {}),
        source_count=0,
        created_at=ts,
        updated_at=ts,
    )
    await runner.upsert_node(ns, L_ENTITY, eid, props, extra_label=type)
    return decode_entity(props)


async def update_entity(
    runner: Any, ns: str, eid: str, *, schema_check: SchemaCheck | None = None, **fields: Any
) -> Entity:
    """Update an entity's fields, replacing scalars and merging collections.

    Scalar fields (name, type) replace the stored value; collection fields
    (aliases, external_ids, properties) merge into what is already stored, so a
    partial update never silently drops keys. This matches insert, which merges.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): entity id.
    @param schema_check (SchemaCheck | None): checks the resulting entity against the schema before the write.
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
    new_type = _clean_text(fields["type"]) if "type" in fields else existing.type
    new_name = _clean_text(fields["name"]) if "name" in fields else existing.name
    _validate_entity_identity(eid, new_type, new_name)
    removed = set(_dedup_text_list(fields.get("remove_aliases", [])))
    aliases = [a for a in _dedup_text_list([*existing.aliases, *fields.get("aliases", ())]) if a not in removed]
    properties = {**existing.properties, **_canon_props(fields.get("properties"))}
    for key in fields.get("remove_properties", ()):
        properties.pop(key, None)
    external_ids = {**existing.external_ids, **fields.get("external_ids", {})}
    if schema_check is not None:
        subject = EntityInput(id=eid, type=new_type, name=new_name, properties=properties)
        await schema_check(runner, Ontology(entities=[subject]))
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
        source_count=existing.source_count,
        created_at=existing.created_at,
        updated_at=now(),
    )
    await _precheck_write(runner, props)
    if new_type != existing.type:
        await runner.remove_node_label(ns, L_ENTITY, eid, existing.type)
    await runner.upsert_node(ns, L_ENTITY, eid, props, extra_label=new_type)
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
        equals["type"] = _clean_text(type)
    if name is not None:
        equals["name"] = _clean_text(name)
    rows = await runner.match_nodes(ns, L_ENTITY, equals=equals, order_by="id", skip=skip, limit=limit)
    return [decode_entity(r) for r in rows]


async def _delete_steps(runner: Any, ns: str, tid: str) -> None:
    for step in await runner.child_nodes(ns, L_TRACE, tid, R_HAS_STEP, L_STEP):
        await runner.delete_node(ns, L_STEP, step["id"])


async def _delete_trace_quietly(runner: Any, ns: str, tid: str) -> bool:
    """Delete a decision trace and its steps when it still exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tid (str): trace id.
    @return (bool): True when a trace was removed.
    """
    if not await runner.node_exists(ns, L_TRACE, tid):
        return False
    await _delete_steps(runner, ns, tid)
    await runner.delete_node(ns, L_TRACE, tid)
    return True


async def _delete_traces(runner: Any, ns: str, tids: Iterable[str]) -> int:
    """Delete each decision trace that still exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tids (Iterable[str]): trace ids.
    @return (int): how many traces were removed.
    """
    return sum([await _delete_trace_quietly(runner, ns, tid) for tid in tids])


async def _traces_touching_relation(runner: Any, ns: str, rid: str) -> set[str]:
    """Find decision traces that use a relation as one of their steps.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @return (set[str]): owning trace ids.
    """
    steps = await runner.match_nodes(ns, L_STEP, equals={"relation_id": rid})
    return {_ids.trace_of_step(s["id"]) for s in steps}


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
            tids.add(_ids.trace_of_step(step["id"]))
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
    _ids._require_str("entity id", eid)
    if not await runner.node_exists(ns, L_ENTITY, eid):
        raise NotFoundError("Entity", eid)
    counts = dict(_NO_DELETES)
    trace_ids = await _traces_touching_entity(runner, ns, eid)

    for rid in await runner.versioned_relation_ids(
        ns, L_ENTITY, eid, exclude_types=[*PREFERENCE_EDGE_TYPES, R_HAS_PROFILE]
    ):
        counts["deleted_relation_versions"] += await runner.delete_edges(ns, rid)
        await _delete_evidence(runner, ns, rid)
        trace_ids |= await _traces_touching_relation(runner, ns, rid)

    counts["deleted_decisions"] = await _delete_traces(runner, ns, trace_ids)

    for tid in await _traces_with_alternative(runner, ns, eid):
        if tid not in trace_ids:
            await _prune_trace_alternative(runner, ns, tid, eid)

    for profile in await runner.child_nodes(ns, L_ENTITY, eid, R_HAS_PROFILE, L_PROFILE):
        counts["deleted_preference_versions"] += await runner.count_out_edges(ns, L_PROFILE, profile["id"])
        await runner.delete_node(ns, L_PROFILE, profile["id"])

    for pref in await runner.match_edges(ns, from_label=L_PROFILE, current_only=True, equals={"about_entity": eid}):
        if pref["to_id"] != eid:
            await update_preference(
                runner,
                ns,
                pref["props"]["id"],
                strength=None,
                properties=None,
                remove_properties=[],
                event_time=None,
                clear_about=True,
            )

    counts["deleted_preference_versions"] += await runner.count_in_edges_typed(
        ns, L_ENTITY, eid, list(PREFERENCE_EDGE_TYPES)
    )
    await runner.delete_node(ns, L_ENTITY, eid)
    await _delete_evidence(runner, ns, eid)
    counts["deleted_entities"] = 1
    return counts


def _is_relation_type(rtype: str) -> bool:
    """Report whether an edge type is a user relation rather than a reserved internal edge.

    @param rtype (str): the edge type.
    @return (bool): True when the edge is a user relation.
    """
    return rtype not in EDGE_TYPES


def _is_preference_type(rtype: str) -> bool:
    """Report whether an edge type is a preference edge.

    @param rtype (str): the edge type.
    @return (bool): True when the edge is a preference.
    """
    return rtype in PREFERENCE_EDGE_TYPES


def _relation_of(edge: dict) -> Relation:
    return decode_relation(edge["props"], from_entity=edge["from_id"], to_entity=edge["to_id"], type=edge["type"])


def _preference_of(edge: dict) -> Preference:
    kind = preference_kind_of(edge["type"]) or "preference"
    return decode_preference(edge["props"], value_entity=edge["to_id"], profile_id=edge["from_id"], kind=kind)


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
    _ids._require_str("relation id", rid)
    edge = await runner.get_current_edge(ns, rid)
    if edge is None or not _is_relation_type(edge["type"]):
        return None
    return _relation_of(edge)


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
    _ids._require_str("relation id", rid)
    edges = await _typed_edge_versions(runner, ns, rid, _is_relation_type)
    rels = [_relation_of(e) for e in edges]
    if newest_first:
        rels.reverse()
    return rels


async def _write_relation_version(
    runner: Any, ns: str, from_id: str, rtype: str, to_id: str, props: dict, *, retire: bool
) -> Relation:
    """Write a relation version as the current one, retiring the previous current version when there is one.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param from_id (str): source entity id.
    @param rtype (str): relation type.
    @param to_id (str): destination entity id.
    @param props (dict): the encoded version.
    @param retire (bool): True when an existing current version must be flipped first.
    @return (Relation): the written version.
    """
    if retire:
        await _precheck_write(runner, props)
        await runner.update_current_edge(ns, props["id"], {"is_current": False})
    _reject_reserved_rel_type(rtype, rtype)
    if not await runner.create_edge(ns, rtype, L_ENTITY, from_id, L_ENTITY, to_id, props):
        raise ValidationError(
            f"relation endpoints not found (from={from_id!r}, to={to_id!r}); create both entities first, "
            "then reference them by id ('type:name')"
        )
    return decode_relation(props, from_entity=from_id, to_entity=to_id, type=rtype)


async def _lock_current(
    runner: Any, ns: str, oid: str, kind: str, get: Callable[..., Any], exists: Callable[..., Any], lock_on: Callable
) -> Any:
    """Return the current version of a relation or preference, read again under its lock so no writer slips in.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param oid (str): the relation or preference id.
    @param kind (str): "relation" or "preference", for the errors.
    @param get (Callable[..., Any]): reads the current version, or None.
    @param exists (Callable[..., Any]): reports whether any version exists.
    @param lock_on (Callable): maps the current version to the (label, id) node to lock.
    @return (Any): the current version, under the lock.
    """
    before = await get(runner, ns, oid)
    if before is None:
        if await exists(runner, ns, oid):
            raise TransientError(f"{kind} {oid!r} has no current version right now (concurrent write); retry")
        raise NotFoundError(kind.capitalize(), oid)
    await runner.lock_node(ns, *lock_on(before))
    current = await get(runner, ns, oid)
    if current is None:
        raise TransientError(f"{kind} {oid!r} was changed concurrently; retry")
    return current


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


async def _current_relations(runner: Any, ns: str, keyed: list[tuple[str, RelationInput]]) -> dict[str, dict]:
    """Fetch the current version of many relations, reading each batch of source entities' outgoing relations.

    A derived relation id fixes its endpoints, so its stored version is among its source entity's relations; an
    explicit id may name a relation between other entities, so one not found that way is looked up by id.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param keyed (list[tuple[str, RelationInput]]): (relation id, input) pairs.
    @return (dict[str, dict]): each found relation's current edge row by id.
    """
    wanted = {rid for rid, _ in keyed}
    found: dict[str, dict] = {}
    for batch in _batches(list(dict.fromkeys(rel.from_entity for _, rel in keyed))):
        fetch = partial(
            runner.match_edges, ns, from_label=L_ENTITY, to_label=L_ENTITY, from_in=batch, current_only=True
        )
        for edge in await _paged(fetch, page=_BATCH):
            if edge["props"]["id"] in wanted and _is_relation_type(edge["type"]):
                found[edge["props"]["id"]] = edge
    for rid, rel in keyed:
        if rel.id is not None and rid not in found:
            edge = await runner.get_current_edge(ns, rid)
            if edge is not None and _is_relation_type(edge["type"]):
                found[rid] = edge
    return found


async def upsert_relations(
    runner: Any,
    ns: str,
    items: list[tuple[RelationInput, list[Evidence]]],
    *,
    default_event_time: datetime | None,
    created_at: datetime,
) -> list[Relation]:
    """Insert-semantics upsert of many relations: merge properties, versioning on change, recording evidence.

    Relations are read and written in batches; a repeated id applies after the earlier input, as sequential
    upserts would.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param items (list[tuple[RelationInput, list[Evidence]]]): relations to upsert with their evidence, in order.
    @param default_event_time (datetime | None): fallback event time.
    @param created_at (datetime): timestamp.
    @return (list[Relation]): each input's stored current version, in input order.
    """
    keyed = []
    for rel, evidence in items:
        _validate_own_id("relation", rel.id)
        rtype = _ids.normalize_rel_type(rel.type)
        _reject_reserved_rel_type(rtype, rtype)
        keyed.append((rel.id or _ids.relation_id(rel.from_entity, rtype, rel.to_entity), rtype, rel, evidence))
    for from_entity in dict.fromkeys(rel.from_entity for _, _, rel, _ in keyed):
        await runner.lock_node(ns, L_ENTITY, from_entity)
    rids = list(dict.fromkeys(rid for rid, *_ in keyed))
    stored = await _current_relations(runner, ns, [(rid, rel) for rid, _, rel, _ in keyed])
    records, gained = await _plan_evidence(
        runner,
        ns,
        [(rid, ev) for rid, _, _, evidence in keyed for ev in evidence],
        new_targets=set(rids) - set(stored),
    )

    current: dict[str, dict] = dict(stored)
    writes: dict[tuple[str, int], dict] = {}
    out: list[Relation] = []
    for rid, rtype, rel, _ in keyed:
        event_time = rel.event_time or default_event_time
        edge = current.get(rid)
        if edge is None:
            props = encode_relation_props(
                ns=ns,
                id=rid,
                revision=1,
                properties=dict(rel.properties),
                event_time=event_time,
                created_at=created_at,
                is_current=True,
                source_count=gained.pop(rid, 0),
            )
            edge = {"props": props, "from_id": rel.from_entity, "to_id": rel.to_entity, "type": rtype}
        else:
            if rel.from_entity != edge["from_id"] or rtype != edge["type"] or rel.to_entity != edge["to_id"]:
                raise ValidationError(
                    f"relation {rid!r} already exists with different endpoints/type; "
                    "endpoints and type are immutable; create a new relation to change them"
                )
            prev = _relation_of(edge)
            sources = prev.source_count + gained.pop(rid, 0)
            merged_properties = {**prev.properties, **_canon_props(rel.properties)}
            if prev.properties == merged_properties and to_iso(prev.event_time) == to_iso(event_time):
                if sources == prev.source_count:
                    out.append(prev)
                    continue
                props = {**edge["props"], "source_count": sources}
            else:
                writes[(rid, prev.revision)] = {**edge["props"], "is_current": False}
                props = encode_relation_props(
                    ns=ns,
                    id=rid,
                    revision=prev.revision + 1,
                    properties=merged_properties,
                    event_time=event_time,
                    created_at=created_at,
                    is_current=True,
                    source_count=sources,
                )
            edge = {**edge, "props": props}
        writes[(rid, props["revision"])] = props
        current[rid] = edge
        out.append(_relation_of(edge))

    for props in writes.values():
        await _precheck_write(runner, props)
    rows = []
    for (rid, _), props in writes.items():
        edge = current[rid]
        rows.append((edge["type"], edge["from_id"], edge["to_id"], props))
    await runner.create_edges(ns, L_ENTITY, L_ENTITY, rows)
    await _write_evidence(runner, ns, records)
    return out


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
    schema_check: SchemaCheck | None = None,
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
    @param schema_check (SchemaCheck | None): checks the relation against the schema before the write.
    @return (Relation): the created relation.
    """
    _require_text("relation from_entity", from_entity)
    _require_text("relation type", type)
    _require_text("relation to_entity", to_entity)
    _require_json_mapping("properties", properties)
    _require_datetime("event_time", event_time)
    rtype = _ids.normalize_rel_type(type)
    _validate_own_id("relation", id)
    rid = id or _ids.relation_id(from_entity, rtype, to_entity)
    await runner.lock_node(ns, L_ENTITY, from_entity)
    if await relation_exists(runner, ns, rid):
        raise ConflictError("Relation", rid)
    if schema_check is not None:
        subject = RelationInput(
            id=id, from_entity=from_entity, type=rtype, to_entity=to_entity, properties=properties or {}
        )
        await schema_check(runner, Ontology(relations=[subject]))
    records, gained = await _plan_evidence(runner, ns, [(rid, ev) for ev in evidence], new_targets={rid})
    props = encode_relation_props(
        ns=ns,
        id=rid,
        revision=1,
        properties=dict(properties or {}),
        event_time=event_time,
        created_at=now(),
        is_current=True,
        source_count=gained.get(rid, 0),
    )
    rel = await _write_relation_version(runner, ns, from_entity, rtype, to_entity, props, retire=False)
    await _write_evidence(runner, ns, records)
    return rel


async def update_relation(
    runner: Any,
    ns: str,
    rid: str,
    *,
    set_properties: dict[str, Any] | None,
    remove_properties: list[str],
    event_time: datetime | None,
    evidence: list[Evidence] | None,
    schema_check: SchemaCheck | None = None,
) -> Relation:
    """Create a new version of a relation with changed properties.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @param set_properties (dict[str, Any] | None): properties to set.
    @param remove_properties (list[str]): property keys to drop.
    @param event_time (datetime | None): new valid time.
    @param evidence (list[Evidence] | None): evidence to merge.
    @param schema_check (SchemaCheck | None): checks the resulting relation against the schema before the write.
    @return (Relation): the new current version.
    """
    _require_json_mapping("set_properties", set_properties)
    _require_list("remove_properties", remove_properties)
    _require_datetime("event_time", event_time)
    current = await _lock_current(
        runner, ns, rid, "relation", get_relation_current, relation_exists, lambda rel: (L_ENTITY, rel.from_entity)
    )
    new_props = {**current.properties, **_canon_props(set_properties)}
    for key in remove_properties:
        new_props.pop(key, None)
    if schema_check is not None:
        subject = RelationInput(
            id=rid,
            from_entity=current.from_entity,
            type=current.type,
            to_entity=current.to_entity,
            properties=new_props,
        )
        await schema_check(runner, Ontology(relations=[subject]))
    new_event_time = event_time if event_time is not None else current.event_time
    records, gained = await _plan_evidence(runner, ns, [(rid, ev) for ev in evidence or []], new_targets=set())
    sources = current.source_count + gained.get(rid, 0)

    if new_props == current.properties and to_iso(new_event_time) == to_iso(current.event_time):
        if sources != current.source_count:
            await runner.update_current_edge(ns, rid, {"source_count": sources})
            current.source_count = sources
        await _write_evidence(runner, ns, records)
        return current

    props = encode_relation_props(
        ns=ns,
        id=rid,
        revision=current.revision + 1,
        properties=new_props,
        event_time=new_event_time,
        created_at=now(),
        is_current=True,
        source_count=sources,
    )
    rel = await _write_relation_version(
        runner, ns, current.from_entity, current.type, current.to_entity, props, retire=True
    )
    await _write_evidence(runner, ns, records)
    return rel


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
    return [_relation_of(r) for r in rows]


async def delete_relation(runner: Any, ns: str, rid: str) -> dict[str, int]:
    """Delete a relation and all of its versions.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @return (dict[str, int]): counts of what was removed.
    """
    _ids._require_str("relation id", rid)
    if not await relation_exists(runner, ns, rid):
        raise NotFoundError("Relation", rid)
    trace_ids = await _traces_touching_relation(runner, ns, rid)
    n = await runner.delete_edges(ns, rid)
    await _delete_evidence(runner, ns, rid)
    deleted_decisions = await _delete_traces(runner, ns, trace_ids)
    return {**_NO_DELETES, "deleted_relation_versions": n, "deleted_decisions": deleted_decisions}


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
        ns,
        R_HAS_PROFILE,
        L_ENTITY,
        subject_id,
        L_PROFILE,
        pid,
        {"ns": ns, "id": child_edge_id(R_HAS_PROFILE, pid), "revision": 1},
    )
    return pid


async def _write_preference_version(
    runner: Any, ns: str, profile_id: str, value_entity: str, kind: str, props: dict, *, retire: bool
) -> Preference:
    """Write a preference version as the current one, retiring the previous current version when there is one.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param profile_id (str): the subject's profile id.
    @param value_entity (str): value entity id.
    @param kind (str): preference or disinterest.
    @param props (dict): the encoded version.
    @param retire (bool): True when an existing current version must be flipped first.
    @return (Preference): the written version.
    """
    if retire:
        await _precheck_write(runner, props)
        await runner.update_current_edge(ns, props["id"], {"is_current": False})
    await runner.create_edge(ns, preference_edge_type(kind), L_PROFILE, profile_id, L_ENTITY, value_entity, props)
    return decode_preference(props, value_entity=value_entity, profile_id=profile_id, kind=kind)


async def get_preference(runner: Any, ns: str, pid: str) -> Preference | None:
    """Fetch the current version of a preference by id.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @return (Preference | None): the current version, or None.
    """
    _ids._require_str("preference id", pid)
    edge = await runner.get_current_edge(ns, pid)
    if edge is None or not _is_preference_type(edge["type"]):
        return None
    return _preference_of(edge)


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
    _validate_own_id("preference", pref.id)
    pid = pref.id or _ids.preference_id(pref.subject_entity, pref.kind, pref.key, pref.value_entity)
    event_time = pref.event_time or default_event_time
    await _require_preference_refs(runner, ns, pref.value_entity, pref.about_entity)
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

    if (
        current is not None
        and current.strength == pref.strength
        and current.about_entity == pref.about_entity
        and current.properties == merged_props
        and to_iso(current.event_time) == to_iso(event_time)
    ):
        return current
    return await _write_preference_version(
        runner, ns, profile_id, pref.value_entity, pref.kind, props, retire=current is not None
    )


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
    _require_choice("preference kind", kind, _KINDS)
    _validate_strength(strength)
    _require_text("preference subject_entity", subject_entity)
    _require_text("preference key", key)
    _require_text("preference value_entity", value_entity)
    key = _ids.normalize_text(key)
    _require_json_mapping("properties", properties)
    _require_datetime("event_time", event_time)
    _validate_own_id("preference", id)
    pid = id or _ids.preference_id(subject_entity, kind, key, value_entity)
    await _require_preference_refs(runner, ns, value_entity, about_entity)
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
    return await _write_preference_version(runner, ns, profile_id, value_entity, kind, props, retire=False)


async def update_preference(
    runner: Any,
    ns: str,
    pid: str,
    *,
    strength: float | None,
    properties: dict[str, Any] | None,
    remove_properties: list[str],
    event_time: datetime | None,
    clear_about: bool = False,
) -> Preference:
    """Create a new version of a preference, merging properties like entities and relations.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @param strength (float | None): new strength.
    @param properties (dict[str, Any] | None): properties to merge in.
    @param remove_properties (list[str]): property keys to drop.
    @param event_time (datetime | None): new valid time.
    @param clear_about (bool): drop the about entity, used when that entity is deleted.
    @return (Preference): the new current version.
    """
    _validate_strength(strength)
    _require_json_mapping("properties", properties)
    _require_list("remove_properties", remove_properties)
    _require_datetime("event_time", event_time)
    current = await _lock_current(
        runner, ns, pid, "preference", get_preference, preference_exists, lambda pref: (L_PROFILE, pref.profile_id)
    )
    new_strength = strength if strength is not None else current.strength
    new_props = {**current.properties, **_canon_props(properties)}
    for prop_key in remove_properties:
        new_props.pop(prop_key, None)
    new_event_time = event_time if event_time is not None else current.event_time
    new_about = None if clear_about else current.about_entity
    if (
        new_strength == current.strength
        and new_about == current.about_entity
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
        about_entity=new_about,
        strength=new_strength,
        properties=new_props,
        event_time=new_event_time,
        created_at=now(),
        is_current=True,
    )
    return await _write_preference_version(
        runner, ns, current.profile_id, current.value_entity, current.kind, props, retire=True
    )


async def list_preference_versions(runner: Any, ns: str, pid: str, *, newest_first: bool) -> list[Preference]:
    """Return every version of a preference.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @param newest_first (bool): order newest first when True.
    @return (list[Preference]): the versions.
    """
    _ids._require_str("preference id", pid)
    edges = await _typed_edge_versions(runner, ns, pid, _is_preference_type)
    prefs = [_preference_of(e) for e in edges]
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
        _require_choice("preference kind", kind, _KINDS)
    equals: dict[str, Any] = {}
    if subject_entity is not None:
        equals["subject_entity"] = subject_entity
    if key is not None:
        equals["key"] = _ids.normalize_text(key)
    etype = preference_edge_type(kind) if kind is not None else None
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
    return [_preference_of(r) for r in rows]


async def delete_preference(runner: Any, ns: str, pid: str) -> dict[str, int]:
    """Delete a preference and all of its versions.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @return (dict[str, int]): counts of what was removed.
    """
    _ids._require_str("preference id", pid)
    if not await preference_exists(runner, ns, pid):
        raise NotFoundError("Preference", pid)
    return {**_NO_DELETES, "deleted_preference_versions": await runner.delete_edges(ns, pid)}


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
    _ids._require_str("decision id", tid)
    props = await runner.get_node(ns, L_TRACE, tid)
    if props is None:
        return None
    steps = await _read_steps(runner, ns, tid)
    return decode_trace(props, steps)


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
        sid = _ids.step_id(tid, step.order)
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
    await _delete_steps(runner, ns, tid)
    for rtype in (R_MADE_DECISION, R_RESULTED_IN, R_CONSIDERED):
        await runner.delete_edges_touching_by_type(ns, L_TRACE, tid, rtype)


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
    _require_choice("decision status", status, _STATUSES)
    _require_text("decision title", title)
    title = _ids.normalize_text(title)
    if actor_entity is not None:
        _require_text("decision actor_entity", actor_entity)
    _require_optional_text("decision summary", summary)
    _require_optional_text("decision rationale", rationale)
    _require_list("decision steps", step_rel_ids)
    _require_list("alternative_entities", alternative_entities)
    _require_datetime("event_time", event_time)
    _validate_own_id("decision", tid)
    alternative_entities = _dedup_list(alternative_entities)
    tid = tid or _ids.decision_id(actor_entity, title)
    await _require_trace_refs(runner, ns, actor_entity, outcome_entity, alternative_entities)
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
    _validate_own_id("decision", id)
    tid = id or _ids.decision_id(actor_entity, title)
    await runner.lock_node(ns, L_TRACE, tid)
    if await runner.node_exists(ns, L_TRACE, tid):
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
    return await upsert_trace(
        runner,
        ns,
        tid=tid,
        title=fields.get("title", existing.title),
        step_rel_ids=fields["steps"] if "steps" in fields else [s.relation_id for s in existing.steps],
        actor_entity=fields.get("actor_entity", existing.actor_entity),
        summary=fields.get("summary", existing.summary),
        rationale=fields.get("rationale", existing.rationale),
        outcome_entity=fields.get("outcome_entity", existing.outcome_entity),
        alternative_entities=fields.get("alternative_entities", existing.alternative_entities),
        status=fields.get("status", existing.status),
        event_time=fields.get("event_time", existing.event_time),
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
    _ids._require_str("decision id", tid)
    if not await _delete_trace_quietly(runner, ns, tid):
        raise NotFoundError("DecisionTrace", tid)
    return {**_NO_DELETES, "deleted_decisions": 1}
