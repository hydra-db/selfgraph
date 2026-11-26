from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timedelta, timezone
from functools import partial
from typing import Any, NamedTuple

from . import _ops
from ._serde import (
    L_ENTITY,
    L_EVIDENCE,
    L_MERGE,
    L_SOURCE,
    aware,
    decode_entity,
    decode_evidence,
    encode_entity_props,
    relevance_props,
    to_iso,
)
from .errors import ValidationError
from .ids import normalize_rel_type, number_text
from .models import DecisionTrace, DedupeGroup, Entity, LintIssue, Preference, Relation
from .schema import Schema, _relation_index, canonical_entity_type, canonical_relation_type

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_MS = timedelta(milliseconds=1)
_DAY_MS = 86_400_000
_SCALE = 1_000_000
_LINT_SAMPLE = 5


def epoch_ms(dt: datetime) -> int:
    """Whole milliseconds since the Unix epoch, floored, so Python and TypeScript see the same instant.

    @param dt (datetime): the datetime.
    @return (int): milliseconds since 1970-01-01T00:00:00Z.
    """
    return (aware(dt) - _EPOCH) // _MS


def latest(timestamps: Iterable[datetime | None]) -> datetime:
    """The most recent of the given timestamps, ignoring missing ones.

    @param timestamps (Iterable[datetime | None]): created_at, updated_at, or event_time values.
    @return (datetime): the latest one, compared as UTC.
    """
    return max((aware(t) for t in timestamps if t is not None), key=epoch_ms)


def relevance_score(timestamps: Iterable[datetime | None], now: datetime, half_life_days: float, signal: int) -> float:
    """Score how relevant a memory is from its recency and how often it was seen.

    recency = 0.5 ** (age_days / half_life_days), where age_days counts whole milliseconds from the latest
    timestamp to now and is never negative; frequency = signal / (signal + 1); the score is
    recency * (1 + frequency) / 2, rounded half up to six decimals, so it lies in [0, 1).

    @param timestamps (Iterable[datetime | None]): the item's timestamps; the latest one dates it.
    @param now (datetime): the reference time.
    @param half_life_days (float): the days after which recency halves.
    @param signal (int): source_count, plus degree for an entity.
    @return (float): the relevance score.
    """
    age_ms = max(0, epoch_ms(now) - epoch_ms(latest(timestamps)))
    recency = 0.5 ** (age_ms / _DAY_MS / half_life_days)
    frequency = signal / (signal + 1)
    return min(math.floor(recency * (1 + frequency) / 2 * _SCALE + 0.5) / _SCALE, 0.999999)


def require_number(field: str, value: Any, *, positive: bool = False, upper: float | None = None) -> None:
    """Validate a value is a finite real number, optionally strictly positive or within [0, upper].

    @param field (str): the field name for the error message.
    @param value (Any): the value to check.
    @param positive (bool): also require the value to be greater than zero.
    @param upper (float | None): also require the value to be between 0 and this, inclusive.
    @return (None): nothing; raises ValidationError otherwise.
    """
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise ValidationError(f"{field} must be a finite number, got {value!r}")
    if positive and value <= 0:
        raise ValidationError(f"{field} must be greater than 0, got {number_text(value)}")
    if upper is not None and not 0 <= value <= upper:
        raise ValidationError(f"{field} must be between 0 and {upper}, got {number_text(value)}")


async def scan_entities(runner: Any, ns: str) -> list[Entity]:
    """Read every entity in the namespace, a page at a time.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @return (list[Entity]): the entities in id order.
    """
    return await _ops._paged(partial(_ops.list_entities, runner, ns, type=None, name=None))


async def scan_live_merges(runner: Any, ns: str) -> list[dict]:
    """Read every merge record in the namespace that has not been reverted, a page at a time.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @return (list[dict]): the stored merge records, in id order.
    """
    rows = await _ops._paged(partial(runner.match_nodes, ns, L_MERGE, order_by="id"))
    return [row for row in rows if row.get("reverted_at") is None]


async def scan_relations(runner: Any, ns: str) -> list[Relation]:
    """Read the current version of every relation in the namespace, a page at a time.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @return (list[Relation]): the current relations in id order.
    """
    return await _ops._paged(partial(_ops.list_relations, runner, ns, from_entity=None, type=None, to_entity=None))


async def write_entity_relevance(runner: Any, ns: str, scores: dict[str, float], at: datetime) -> int:
    """Store relevance on entities in place, rereading each under its lock so a concurrent edit is kept.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param scores (dict[str, float]): the relevance per entity id.
    @param at (datetime): when the scores were computed.
    @return (int): how many entities were written; deleted ones are skipped.
    """
    for eid in scores:
        await runner.lock_node(ns, L_ENTITY, eid)
    by_type: dict[str, list[tuple[str, dict]]] = {}
    for eid, props in (await _ops._nodes_by_id(runner, ns, L_ENTITY, list(scores))).items():
        e = decode_entity(props)
        fields = e.model_dump(exclude={"relevance", "relevance_at"})
        encoded = encode_entity_props(ns=ns, **fields, relevance=scores[eid], relevance_at=at)
        by_type.setdefault(e.type, []).append((eid, encoded))
    await _ops._precheck_nodes(runner, ns, L_ENTITY, [row for rows in by_type.values() for row in rows])
    for etype, rows in by_type.items():
        await runner.upsert_nodes(ns, L_ENTITY, rows, extra_label=etype)
    return sum(len(rows) for rows in by_type.values())


async def write_relation_relevance(
    runner: Any, ns: str, relations: list[Relation], scores: dict[str, float], at: datetime
) -> int:
    """Store relevance on the current version of relations in place, without a new version, in batched writes.

    Each current version is read again in a batch and rewritten with its revision, so a relation retired or deleted
    since the scan is skipped.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param relations (list[Relation]): the scanned relations to score.
    @param scores (dict[str, float]): the relevance per relation id.
    @param at (datetime): when the scores were computed.
    @return (int): how many relations were written.
    """
    found = await _ops._current_relations(runner, ns, [(rel.id, rel) for rel in relations])
    rows = [
        (edge["type"], edge["from_id"], edge["to_id"], {**edge["props"], **relevance_props(scores[rid], at)})
        for rid, edge in found.items()
        if edge["props"]["is_current"]
    ]
    await _ops._precheck_edges(runner, ns, L_ENTITY, L_ENTITY, rows)
    if rows:
        await runner.create_edges(ns, L_ENTITY, L_ENTITY, rows)
    return len(rows)


class PruneBatch(NamedTuple):
    counts: dict[str, int]
    entity_ids: list[str]
    relation_ids: list[str]
    certified: list[str]
    merge_ids: list[str]


async def _current_touching(runner: Any, ns: str, eids: list[str]) -> dict[str, Relation]:
    """Read the current relations that start or end at some entities.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eids (list[str]): the entity ids.
    @return (dict[str, Relation]): the current relations by id.
    """
    found: dict[str, Relation] = {}
    for side in ("from_in", "to_in"):
        for edge in await _ops._edges_into(runner, ns, L_ENTITY, L_ENTITY, side, eids, current_only=True):
            if _ops._is_relation_type(edge["type"]):
                found[edge["props"]["id"]] = _ops._relation_of(edge)
    return found


async def prune_entities(
    runner: Any,
    ns: str,
    eids: list[str],
    still_matches: Callable[[Entity], bool],
    include_certified: bool,
    caps: Mapping[str, _ops.RelationCap],
) -> PruneBatch:
    """Delete the entities a prune planned, after checking the plan again under their locks.

    Each entity is read again with the current relations that touch it, and those relations' source entities are
    locked too, so a concurrent certify or edit either lands before the check or waits for the delete. An entity
    that no longer matches, or that a certified relation now connects (unless include_certified), is kept. The
    relations listed are the current ones the deleted entities took with them, including any created since the scan,
    and the merges listed are the live merge records they took with them, including any made since the scan.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eids (list[str]): the planned entity ids.
    @param still_matches (Callable[[Entity], bool]): the prune criteria, applied to the entity as stored now.
    @param include_certified (bool): also delete entities a certified relation connects.
    @param caps (Mapping[str, RelationCap]): the schema's max_count limits, to settle endpoints after deletes.
    @return (PruneBatch): the delete counts, the entities, relations, and live merge records deleted, and the
        certified relations kept.
    """
    for eid in eids:
        await runner.lock_node(ns, L_ENTITY, eid)
    touching = await _current_touching(runner, ns, eids)
    for source in sorted({r.from_entity for r in touching.values()} - set(eids)):
        await runner.lock_node(ns, L_ENTITY, source)
    stored = await _ops._nodes_by_id(runner, ns, L_ENTITY, list(eids))
    live = [eid for eid, props in stored.items() if still_matches(decode_entity(props))]
    touching = await _current_touching(runner, ns, live)
    certified = [] if include_certified else [r for r in touching.values() if r.certified_at is not None]
    held = {eid for r in certified for eid in (r.from_entity, r.to_entity)}
    doomed = sorted(eid for eid in live if eid not in held)
    gone = set(doomed)
    taken = sorted(rid for rid, r in touching.items() if r.from_entity in gone or r.to_entity in gone)
    merges = {
        row["id"]
        for side in ("survivor_id", "absorbed_id")
        for row in await _ops._nodes_where(runner, ns, L_MERGE, side, doomed)
        if row.get("reverted_at") is None
    }
    counts = await _ops.delete_entities(runner, ns, doomed, caps)
    return PruneBatch(counts, doomed, taken, sorted(r.id for r in certified), sorted(merges))


async def prune_relations(
    runner: Any,
    ns: str,
    rids: list[str],
    still_matches: Callable[[Relation], bool],
    include_certified: bool,
    caps: Mapping[str, _ops.RelationCap],
) -> PruneBatch:
    """Delete the relations a prune planned, after reading each again under its source entity's lock.

    A relation that is gone, no longer current, no longer matches, or is now certified (unless include_certified)
    is kept.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rids (list[str]): the planned relation ids.
    @param still_matches (Callable[[Relation], bool]): the prune criteria, applied to the relation as stored now.
    @param include_certified (bool): also delete certified relations.
    @param caps (Mapping[str, RelationCap]): the schema's max_count limits, to settle endpoints after deletes.
    @return (PruneBatch): the delete counts, the relations deleted, and the certified relations kept.
    """
    doomed: list[str] = []
    certified: list[str] = []
    for rid in rids:
        rel = await _ops.get_relation_current(runner, ns, rid)
        if rel is None:
            continue
        await runner.lock_node(ns, L_ENTITY, rel.from_entity)
        rel = await _ops.get_relation_current(runner, ns, rid)
        if rel is None or not still_matches(rel):
            continue
        if rel.certified_at is not None and not include_certified:
            certified.append(rid)
            continue
        doomed.append(rid)
    counts = await _ops.delete_relations(runner, ns, doomed, caps)
    return PruneBatch(counts, [], doomed, certified, [])


def add_counts(total: dict[str, int], counts: dict[str, int]) -> None:
    """Add one delete's counts into a running total.

    @param total (dict[str, int]): the running DeleteResult counts.
    @param counts (dict[str, int]): one delete's counts.
    @return (None): nothing; total is updated in place.
    """
    for key, value in counts.items():
        total[key] = total.get(key, 0) + value


def fold_properties(survivor: Relation, duplicates: list[Relation]) -> tuple[dict[str, Any], dict[str, list[str]]]:
    """Union the properties of parallel relations, the survivor winning a conflict, then each duplicate in order.

    @param survivor (Relation): the relation that is kept.
    @param duplicates (list[Relation]): the relations folded into it, in id order.
    @return (tuple[dict[str, Any], dict[str, list[str]]]): the merged properties, and per duplicate id the sorted
        keys whose value lost to an earlier one (duplicates without a conflict are left out).
    """
    merged = dict(survivor.properties)
    conflicts: dict[str, list[str]] = {}
    for rel in duplicates:
        for key, value in rel.properties.items():
            if key not in merged:
                merged[key] = value
            elif not _ops._json_equal(merged[key], value):
                conflicts.setdefault(rel.id, []).append(key)
    return merged, {rid: sorted(keys) for rid, keys in conflicts.items()}


async def merge_relations(
    runner: Any, ns: str, survivor: str, duplicates: list[str], ends: tuple[str, str, str]
) -> tuple[dict[str, int], bool, DedupeGroup | None]:
    """Fold duplicate parallel relations into a survivor: merge properties, event time, and evidence, then delete.

    Properties are unioned with the survivor winning a conflict, then each duplicate in id order (see
    fold_properties). The survivor takes the earliest event_time of the group. Evidence is rewritten onto the
    survivor, which recounts its distinct sources. Every decision step that used any duplicate moves to the
    survivor before a duplicate is deleted, and deleting a duplicate never deletes a decision, so none is lost.
    The group is read again under its source entity's lock, and left alone when any of it is now certified. Only
    relations that still have the planned endpoints and type are folded, and none when the survivor lost them.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param survivor (str): the relation id that is kept.
    @param duplicates (list[str]): the relation ids folded into it.
    @param ends (tuple[str, str, str]): the planned (from_entity, type, to_entity), checked again.
    @return (tuple[dict[str, int], bool, DedupeGroup | None]): the DeleteResult counts of the removed duplicates,
        whether the group was left alone because a relation in it is certified, and the group as merged (the
        duplicates folded, the keys each lost, and the versions deleted per duplicate), or None when none was.
    """
    counts = dict(_ops._NO_DELETES)

    def planned(rel: Relation | None) -> bool:
        return rel is not None and (rel.from_entity, rel.type, rel.to_entity) == ends

    current = await _ops.get_relation_current(runner, ns, survivor)
    if current is None:
        return counts, False, None
    await runner.lock_node(ns, L_ENTITY, current.from_entity)
    current = await _ops.get_relation_current(runner, ns, survivor)
    if not planned(current):
        return counts, False, None
    found = [rel for rid in duplicates if planned(rel := await _ops.get_relation_current(runner, ns, rid))]
    if any(rel.certified_at is not None for rel in (current, *found)):
        return counts, True, None
    if not found:
        return counts, False, None
    evidence = []
    for rel in found:
        rows = await _ops._paged(partial(runner.match_nodes, ns, L_EVIDENCE, equals={"target_id": rel.id}))
        evidence.extend(decode_evidence(row) for row in rows)
    merged, conflicts = fold_properties(current, found)
    first = min((aware(r.event_time) for r in (current, *found) if r.event_time is not None), default=None)
    same_time = to_iso(first) == to_iso(current.event_time)
    await _ops.update_relation(
        runner,
        ns,
        survivor,
        set_properties={k: v for k, v in merged.items() if k not in current.properties},
        remove_properties=[],
        event_time=None if same_time else first,
        evidence=evidence,
    )
    gone = [
        {"props": {"id": rel.id}, "type": rel.type, "from_id": rel.from_entity, "to_id": rel.to_entity} for rel in found
    ]
    found = [rel.id for rel in found]
    tids = await _ops._traces_touching_relations(runner, ns, found)
    await _ops._repoint_steps(runner, ns, tids, dict.fromkeys(found, survivor))
    versions_lost: dict[str, int] = {}
    for rid in found:
        versions_lost[rid] = await runner.delete_edges(ns, rid)
        counts["deleted_relation_versions"] += versions_lost[rid]
        await _ops._delete_evidence(runner, ns, rid)
    await _ops.repoint_retired(runner, ns, gone, survivor)
    group = DedupeGroup(
        from_entity=ends[0],
        type=ends[1],
        to_entity=ends[2],
        survivor=survivor,
        duplicates=found,
        conflicts=conflicts,
        versions_lost=versions_lost,
    )
    return counts, False, group


def lint(
    entities: list[Entity],
    relations: list[Relation],
    preferences: list[Preference],
    decisions: list[DecisionTrace],
    supported: set[str],
    schema: Schema | None,
    merged: Iterable[str] = (),
) -> list[LintIssue]:
    """Find what makes a graph a weak source of answers, without changing it.

    orphan_entity: an entity no current relation, preference, decision, or live merge record references; a merge
    survivor is kept off it, since deleting it would delete the merge and lose its unmerge. unsupported_fact: a current
    relation with no evidence record. stale_decision_step: a decision with a step whose relation is no longer
    current. type_off_schema: with a schema, an entity or relation whose type it does not declare.

    @param entities (list[Entity]): every entity.
    @param relations (list[Relation]): every current relation.
    @param preferences (list[Preference]): every current preference.
    @param decisions (list[DecisionTrace]): every decision.
    @param supported (set[str]): the ids that have at least one evidence record.
    @param schema (Schema | None): the schema, or None to skip the type check.
    @param merged (Iterable[str]): the entity ids a live merge record references.
    @return (list[LintIssue]): each problem found, with its count and the first ids in id order.
    """
    used = {*merged, *(eid for r in relations for eid in (r.from_entity, r.to_entity))}
    used.update(eid for p in preferences for eid in (p.subject_entity, p.value_entity, p.about_entity) if eid)
    for d in decisions:
        used.update(eid for eid in (d.actor_entity, d.outcome_entity, *d.alternative_entities) if eid)
        used.update(eid for step in d.steps for eid in (step.from_entity, step.to_entity))
    current = {r.id for r in relations}
    found = {
        "orphan_entity": [e.id for e in entities if e.id not in used],
        "unsupported_fact": [r.id for r in relations if r.id not in supported],
        "stale_decision_step": [d.id for d in decisions if any(s.relation_id not in current for s in d.steps)],
        "type_off_schema": [],
    }
    if schema is not None:
        names = {t.name for t in schema.entities}
        declared = _relation_index(schema)
        found["type_off_schema"] = [
            *(e.id for e in entities if canonical_entity_type(e.type, schema) not in names),
            *(r.id for r in relations if normalize_rel_type(canonical_relation_type(r.type, schema)) not in declared),
        ]
    return [
        LintIssue(code=code, count=len(ids), sample=sorted(ids)[:_LINT_SAMPLE]) for code, ids in found.items() if ids
    ]


async def inspect(runner: Any, ns: str, schema: Schema | None) -> tuple[dict[str, int], list[LintIssue]]:
    """Count what a namespace holds and lint it, reading every item a page at a time.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param schema (Schema | None): the schema to check types against, or None.
    @return (tuple[dict[str, int], list[LintIssue]]): the counts of entities, current relations, current
        preferences, decisions, and sources, and the lint issues.
    """
    entities = await scan_entities(runner, ns)
    relations = await scan_relations(runner, ns)
    preferences = await _ops._paged(
        partial(_ops.list_preferences, runner, ns, subject_entity=None, key=None, stance=None)
    )
    decisions = await _ops._paged(partial(_ops.list_traces, runner, ns, actor_entity=None, status=None))
    sources = await _ops._paged(partial(runner.match_nodes, ns, L_SOURCE, order_by="id"))
    evidence = await _ops._paged(partial(runner.match_nodes, ns, L_EVIDENCE, order_by="id"))
    counts = {
        "entities": len(entities),
        "relations": len(relations),
        "preferences": len(preferences),
        "decisions": len(decisions),
        "sources": len(sources),
    }
    supported = {row["target_id"] for row in evidence}
    merged = {m[side] for m in await scan_live_merges(runner, ns) for side in ("survivor_id", "absorbed_id")}
    return counts, lint(entities, relations, preferences, decisions, supported, schema, merged)
