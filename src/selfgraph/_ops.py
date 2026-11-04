from __future__ import annotations

from datetime import datetime
from typing import Any

from . import ids as _ids
from ._serde import (
    L_ENTITY,
    L_PROFILE,
    L_STEP,
    L_TRACE,
    R_AVOIDS,
    R_CONSIDERED,
    R_FROM,
    R_HAS_PROFILE,
    R_HAS_STEP,
    R_MADE_DECISION,
    R_PREFERS,
    R_RESULTED_IN,
    R_TO,
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
from .errors import ConflictError, NotFoundError, ValidationError
from .models import (
    DecisionStep,
    DecisionTrace,
    Entity,
    EntityInput,
    Evidence,
    EvidenceInput,
    Ontology,
    Preference,
    PreferenceInput,
    Relation,
    RelationInput,
)


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
    out: list[Evidence] = []
    for ev in inputs:
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
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


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
    entities = {ent.id or _ids.entity_id(ent.type, ent.name) for ent in ontology.entities}
    relations = {rel.id or _ids.relation_id(rel.from_entity, rel.type, rel.to_entity) for rel in ontology.relations}

    for rel in ontology.relations:
        if not await _entity_known(runner, ns, rel.from_entity, entities) or not await _entity_known(
            runner, ns, rel.to_entity, entities
        ):
            raise ValidationError(f"relation endpoints not found (from={rel.from_entity!r}, to={rel.to_entity!r})")

    for pref in ontology.preferences:
        if not await _entity_known(runner, ns, pref.subject_entity, entities):
            raise ValidationError(f"preference references unknown subject entity {pref.subject_entity!r}")
        await _require_entity(runner, ns, pref.value_entity, context="preference", known=entities)
        if pref.about_entity is not None:
            await _require_entity(runner, ns, pref.about_entity, context="preference about_entity", known=entities)

    for dec in ontology.decisions:
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
    """Insert-semantics upsert: merge aliases, external_ids, properties, and evidence.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param ent (EntityInput): entity to upsert.
    @param evidence (list[Evidence]): evidence to merge.
    @param created_at (datetime): timestamp for created and updated fields.
    @return (Entity): the stored entity.
    """
    eid = ent.id or _ids.entity_id(ent.type, ent.name)
    existing = await get_entity(runner, ns, eid)
    if existing is None:
        props = encode_entity_props(
            ns=ns,
            id=eid,
            type=ent.type,
            name=ent.name,
            aliases=_dedup_list(ent.aliases),
            external_ids=dict(ent.external_ids),
            properties=dict(ent.properties),
            evidence=evidence,
            created_at=created_at,
            updated_at=created_at,
        )
        await _write_entity(runner, ns, eid, ent.type, props)
        return decode_entity(props)

    merged_aliases = _dedup_list([*existing.aliases, *ent.aliases])
    merged_external = {**existing.external_ids, **ent.external_ids}
    merged_properties = {**existing.properties, **ent.properties}
    merged_evidence = _merge_evidence(existing.evidence, evidence)

    if (
        merged_aliases == existing.aliases
        and merged_external == existing.external_ids
        and merged_properties == existing.properties
        and merged_evidence == existing.evidence
    ):
        return existing

    props = encode_entity_props(
        ns=ns,
        id=eid,
        type=existing.type,
        name=existing.name,
        aliases=merged_aliases,
        external_ids=merged_external,
        properties=merged_properties,
        evidence=merged_evidence,
        created_at=existing.created_at,
        updated_at=created_at,
    )
    await _write_entity(runner, ns, eid, existing.type, props)
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
    eid = id or _ids.entity_id(type, name)
    if await entity_exists(runner, ns, eid):
        raise ConflictError("Entity", eid)
    ts = now()
    props = encode_entity_props(
        ns=ns,
        id=eid,
        type=type,
        name=name,
        aliases=_dedup_list(aliases or []),
        external_ids=dict(external_ids or {}),
        properties=dict(properties or {}),
        evidence=[],
        created_at=ts,
        updated_at=ts,
    )
    await _write_entity(runner, ns, eid, type, props)
    return decode_entity(props)


async def update_entity(runner: Any, ns: str, eid: str, **fields: Any) -> Entity:
    """Update an entity's fields in place.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): entity id.
    @param fields (Any): fields to change (name, type, aliases, external_ids, properties).
    @return (Entity): the updated entity.
    """
    existing = await get_entity(runner, ns, eid)
    if existing is None:
        raise NotFoundError("Entity", eid)
    new_type = fields.get("type", existing.type)
    props = encode_entity_props(
        ns=ns,
        id=eid,
        type=new_type,
        name=fields.get("name", existing.name),
        aliases=_dedup_list(fields["aliases"]) if "aliases" in fields else existing.aliases,
        external_ids=fields.get("external_ids", existing.external_ids),
        properties=fields.get("properties", existing.properties),
        evidence=existing.evidence,
        created_at=existing.created_at,
        updated_at=now(),
    )
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
    equals: dict[str, Any] = {}
    if type is not None:
        equals["type"] = type
    if name is not None:
        equals["name"] = name
    rows = await runner.match_nodes(ns, L_ENTITY, equals=equals, order_by="id", skip=skip, limit=limit)
    return [decode_entity(r) for r in rows]


async def delete_entity(runner: Any, ns: str, eid: str) -> dict[str, int]:
    """Delete an entity and everything attached to it.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): entity id.
    @return (dict[str, int]): counts of what was removed.
    """
    if not await entity_exists(runner, ns, eid):
        raise NotFoundError("Entity", eid)
    counts = {"deleted_entities": 0, "deleted_relation_versions": 0, "deleted_decisions": 0}

    for rid in await runner.versioned_relation_ids(ns, L_ENTITY, eid, exclude_types=[R_PREFERS, R_AVOIDS]):
        counts["deleted_relation_versions"] += await runner.delete_edges(ns, rid)
        await runner.delete_nodes_by(ns, L_STEP, equals={"relation_id": rid})

    for profile in await runner.child_nodes(ns, L_ENTITY, eid, R_HAS_PROFILE, L_PROFILE):
        counts["deleted_relation_versions"] += await runner.count_out_edges(ns, L_PROFILE, profile["id"])
        await runner.delete_node(ns, L_PROFILE, profile["id"])

    counts["deleted_relation_versions"] += await runner.count_in_edges_typed(ns, L_ENTITY, eid, [R_PREFERS, R_AVOIDS])
    await runner.delete_node(ns, L_ENTITY, eid)
    counts["deleted_entities"] = 1
    return counts


async def get_relation_current(runner: Any, ns: str, rid: str) -> Relation | None:
    """Fetch the current version of a relation by id.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @return (Relation | None): the current version, or None.
    """
    edge = await runner.get_current_edge(ns, rid)
    if edge is None:
        return None
    return decode_relation(edge["props"], from_entity=edge["from_id"], to_entity=edge["to_id"], type=edge["type"])


async def relation_exists(runner: Any, ns: str, rid: str) -> bool:
    """Report whether any version of a relation exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @return (bool): True when it exists.
    """
    return await runner.edge_exists(ns, rid)


async def list_relation_versions(runner: Any, ns: str, rid: str, *, newest_first: bool) -> list[Relation]:
    """Return every version of a relation.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @param newest_first (bool): order newest first when True.
    @return (list[Relation]): the versions.
    """
    edges = await runner.list_edge_versions(ns, rid)
    rels = [decode_relation(e["props"], from_entity=e["from_id"], to_entity=e["to_id"], type=e["type"]) for e in edges]
    if newest_first:
        rels.reverse()
    return rels


async def _create_relation_edge(runner: Any, ns: str, from_id: str, rtype: str, to_id: str, props: dict) -> None:
    ok = await runner.create_edge(ns, rtype, L_ENTITY, from_id, L_ENTITY, to_id, props)
    if not ok:
        raise ValidationError(f"relation endpoints not found (from={from_id!r}, to={to_id!r})")


async def _flip_current(runner: Any, ns: str, rid: str) -> None:
    await runner.update_current_edge(ns, rid, {"is_current": False})


async def upsert_relation(
    runner: Any,
    ns: str,
    rel: RelationInput,
    *,
    evidence: list[Evidence],
    default_event_time: datetime | None,
    created_at: datetime,
) -> Relation:
    """Insert-semantics upsert of a relation, versioning on property change.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rel (RelationInput): relation to upsert.
    @param evidence (list[Evidence]): evidence to attach.
    @param default_event_time (datetime | None): fallback event time.
    @param created_at (datetime): timestamp.
    @return (Relation): the stored current version.
    """
    rid = rel.id or _ids.relation_id(rel.from_entity, rel.type, rel.to_entity)
    event_time = rel.event_time or default_event_time
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
        await _create_relation_edge(runner, ns, rel.from_entity, rel.type, rel.to_entity, props)
        return decode_relation(props, from_entity=rel.from_entity, to_entity=rel.to_entity, type=rel.type)

    if rel.from_entity != current.from_entity or rel.type != current.type or rel.to_entity != current.to_entity:
        raise ValidationError(
            f"relation {rid!r} already exists with different endpoints/type; "
            "endpoints and type are immutable; create a new relation to change them"
        )

    unchanged = current.properties == dict(rel.properties) and to_iso(current.event_time) == to_iso(event_time)
    if unchanged:
        merged = _merge_evidence(current.evidence, evidence)
        await runner.update_current_edge(ns, rid, {"evidence_json": encode_evidence(merged)})
        current.evidence = merged
        return current

    await _flip_current(runner, ns, rid)
    props = encode_relation_props(
        ns=ns,
        id=rid,
        revision=current.revision + 1,
        properties=dict(rel.properties),
        event_time=event_time,
        created_at=created_at,
        is_current=True,
        evidence=evidence,
    )
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
    rid = id or _ids.relation_id(from_entity, type, to_entity)
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
    await _create_relation_edge(runner, ns, from_entity, type, to_entity, props)
    return decode_relation(props, from_entity=from_entity, to_entity=to_entity, type=type)


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
    current = await get_relation_current(runner, ns, rid)
    if current is None:
        raise NotFoundError("Relation", rid)
    new_props = dict(current.properties)
    if set_properties:
        new_props.update(set_properties)
    for key in remove_properties:
        new_props.pop(key, None)
    new_event_time = event_time if event_time is not None else current.event_time
    new_evidence = current.evidence if evidence is None else _merge_evidence(current.evidence, evidence)

    await _flip_current(runner, ns, rid)
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
) -> list[Relation]:
    """List current relations, optionally filtered by endpoints and type.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param from_entity (str | None): source filter.
    @param type (str | None): type filter.
    @param to_entity (str | None): destination filter.
    @param skip (int): rows to skip.
    @param limit (int): maximum rows.
    @return (list[Relation]): the current relations.
    """
    rows = await runner.match_edges(
        ns,
        from_label=L_ENTITY,
        to_label=L_ENTITY,
        type=type,
        from_id=from_entity,
        to_id=to_entity,
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
    if not await relation_exists(runner, ns, rid):
        raise NotFoundError("Relation", rid)
    n = await runner.delete_edges(ns, rid)
    await runner.delete_nodes_by(ns, L_STEP, equals={"relation_id": rid})
    return {"deleted_entities": 0, "deleted_relation_versions": n, "deleted_decisions": 0}


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
    await runner.create_edge(ns, R_HAS_PROFILE, L_ENTITY, subject_id, L_PROFILE, pid, {"ns": ns})
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
    edge = await runner.get_current_edge(ns, pid)
    if edge is None:
        return None
    return decode_preference(
        edge["props"],
        value_entity=edge["to_id"],
        profile_id=edge["from_id"],
        kind=_kind_from_type(edge["type"]),
    )


async def preference_exists(runner: Any, ns: str, pid: str) -> bool:
    """Report whether any version of a preference exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @return (bool): True when it exists.
    """
    return await runner.edge_exists(ns, pid)


async def upsert_preference(
    runner: Any,
    ns: str,
    pref: PreferenceInput,
    *,
    default_event_time: datetime | None,
    created_at: datetime,
) -> Preference:
    """Insert-semantics upsert of a preference, versioning on change.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pref (PreferenceInput): preference to upsert.
    @param default_event_time (datetime | None): fallback event time.
    @param created_at (datetime): timestamp.
    @return (Preference): the stored current version.
    """
    pid = pref.id or _ids.preference_id(pref.subject_entity, pref.kind, pref.key, pref.value_entity)
    event_time = pref.event_time or default_event_time
    profile_id = await _ensure_profile(runner, ns, pref.subject_entity, created_at)
    await _require_entity(runner, ns, pref.value_entity, context="preference")
    if pref.about_entity is not None:
        await _require_entity(runner, ns, pref.about_entity, context="preference about_entity")

    current = await get_preference(runner, ns, pid)
    props = encode_preference_props(
        ns=ns,
        id=pid,
        revision=1 if current is None else current.revision + 1,
        subject_entity=pref.subject_entity,
        key=pref.key,
        about_entity=pref.about_entity,
        strength=pref.strength,
        properties=dict(pref.properties),
        event_time=event_time,
        created_at=created_at,
        is_current=True,
    )

    if current is not None:
        unchanged = (
            current.strength == pref.strength
            and current.about_entity == pref.about_entity
            and current.properties == dict(pref.properties)
            and to_iso(current.event_time) == to_iso(event_time)
        )
        if unchanged:
            return current
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
    pid = id or _ids.preference_id(subject_entity, kind, key, value_entity)
    if await preference_exists(runner, ns, pid):
        raise ConflictError("Preference", pid)
    profile_id = await _ensure_profile(runner, ns, subject_entity, now())
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
    await runner.create_edge(ns, _pref_edge_type(kind), L_PROFILE, profile_id, L_ENTITY, value_entity, props)
    return decode_preference(props, value_entity=value_entity, profile_id=profile_id, kind=kind)


async def update_preference(
    runner: Any,
    ns: str,
    pid: str,
    *,
    strength: float | None,
    properties: dict[str, Any] | None,
    event_time: datetime | None,
) -> Preference:
    """Create a new version of a preference with changed fields.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @param strength (float | None): new strength.
    @param properties (dict[str, Any] | None): new properties.
    @param event_time (datetime | None): new valid time.
    @return (Preference): the new current version.
    """
    current = await get_preference(runner, ns, pid)
    if current is None:
        raise NotFoundError("Preference", pid)
    await _flip_current(runner, ns, pid)
    props = encode_preference_props(
        ns=ns,
        id=pid,
        revision=current.revision + 1,
        subject_entity=current.subject_entity,
        key=current.key,
        about_entity=current.about_entity,
        strength=strength if strength is not None else current.strength,
        properties=properties if properties is not None else current.properties,
        event_time=event_time if event_time is not None else current.event_time,
        created_at=now(),
        is_current=True,
    )
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


async def list_preferences(
    runner: Any,
    ns: str,
    *,
    subject_entity: str,
    key: str | None,
    kind: str | None,
    skip: int,
    limit: int,
) -> list[Preference]:
    """List an entity's current preferences.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param subject_entity (str): subject entity id.
    @param key (str | None): key filter.
    @param kind (str | None): preference or disinterest filter.
    @param skip (int): rows to skip.
    @param limit (int): maximum rows.
    @return (list[Preference]): the current preferences.
    """
    equals: dict[str, Any] = {"subject_entity": subject_entity}
    if key is not None:
        equals["key"] = key
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
    if not await preference_exists(runner, ns, pid):
        raise NotFoundError("Preference", pid)
    n = await runner.delete_edges(ns, pid)
    return {"deleted_entities": 0, "deleted_relation_versions": n, "deleted_decisions": 0}


async def _read_steps(runner: Any, ns: str, tid: str) -> list[DecisionStep]:
    rows = await runner.child_nodes(ns, L_TRACE, tid, R_HAS_STEP, L_STEP, order_by="order")
    return [
        DecisionStep(
            order=int(r["order"]),
            relation_id=r["relation_id"],
            from_entity=r["from_entity"],
            to_entity=r["to_entity"],
        )
        for r in rows
    ]


async def get_trace(runner: Any, ns: str, tid: str) -> DecisionTrace | None:
    """Fetch one decision trace by id.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tid (str): trace id.
    @return (DecisionTrace | None): the trace, or None.
    """
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
    tid = tid or _ids.decision_id(actor_entity, title)
    await _validate_trace_refs(
        runner,
        ns,
        actor_entity=actor_entity,
        outcome_entity=outcome_entity,
        alternative_entities=alternative_entities,
    )
    steps = await _resolve_steps(runner, ns, step_rel_ids)
    existing = await get_trace(runner, ns, tid)
    made_at = existing.created_at if existing is not None else created_at
    if existing is not None:
        await _clear_trace_structure(runner, ns, tid)
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
    tid = id or _ids.decision_id(actor_entity, title)
    if await trace_exists(runner, ns, tid):
        raise ConflictError("DecisionTrace", tid)
    return await upsert_trace(
        runner,
        ns,
        tid=tid,
        title=title,
        step_rel_ids=list(steps),
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
    existing = await get_trace(runner, ns, tid)
    if existing is None:
        raise NotFoundError("DecisionTrace", tid)
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
    step_rel_ids = list(fields["steps"]) if "steps" in fields else [s.relation_id for s in existing.steps]
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
        alternative_entities=list(merged["alternative_entities"]),
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
    if not await trace_exists(runner, ns, tid):
        raise NotFoundError("DecisionTrace", tid)
    for step in await runner.child_nodes(ns, L_TRACE, tid, R_HAS_STEP, L_STEP):
        await runner.delete_node(ns, L_STEP, step["id"])
    await runner.delete_node(ns, L_TRACE, tid)
    return {"deleted_entities": 0, "deleted_relation_versions": 0, "deleted_decisions": 1}
