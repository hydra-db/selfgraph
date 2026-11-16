from __future__ import annotations

from datetime import datetime
from functools import partial
from typing import Any

from . import _ops
from ._serde import L_ENTITY, L_MERGE, L_PROFILE, L_SOURCE_VERSION, aware, decode_entity, from_iso
from .models import Change, GraphDiff, MergeRecord, Relation
from .resolution import _decode_merge

__all__ = ["_KINDS", "change_events", "graph_diff"]

_KINDS = ("entity", "relation", "preference", "decision", "merge", "source")


def _in_window(at: datetime, since: datetime, until: datetime) -> bool:
    """Report whether a change time falls in the (since, until] window.

    @param at (datetime): the change time.
    @param since (datetime): exclusive lower bound.
    @param until (datetime): inclusive upper bound.
    @return (bool): true when the change is inside the window.
    """
    return since < aware(at) <= until


def change_events(
    entities: list[Any],
    relations: list[Any],
    preferences: list[Any],
    decisions: list[Any],
    merges: list[MergeRecord],
    versions: list[dict[str, Any]],
) -> list[Change]:
    """Derive the change log from decoded graph objects, oldest to newest writes in no particular order.

    @param entities (list[Any]): the entities.
    @param relations (list[Any]): every stored relation version, current or not.
    @param preferences (list[Any]): every stored preference version, current or not.
    @param decisions (list[Any]): the decision traces.
    @param merges (list[MergeRecord]): the merge records, reverted ones included.
    @param versions (list[dict[str, Any]]): the source version nodes.
    @return (list[Change]): the changes, unsorted.
    """
    events: list[Change] = []
    for e in entities:
        events.append(Change(kind="entity", action="created", id=e.id, at=e.created_at, summary=f"{e.type} {e.name}"))
    for r in relations:
        summary = f"{r.type} {r.from_entity} -> {r.to_entity}"
        action = "created" if r.revision == 1 else "updated"
        events.append(Change(kind="relation", action=action, id=r.id, at=r.created_at, summary=summary))
        if r.invalidated_at is not None:
            events.append(
                Change(
                    kind="relation",
                    action="retired",
                    id=r.id,
                    at=r.invalidated_known_at or r.invalidated_at,
                    summary=f"{summary} (by {r.invalidated_by})",
                )
            )
        for c in r.certifications:
            marked = f"{summary} (by {c.by})"
            events.append(Change(kind="relation", action="certified", id=r.id, at=c.at, summary=marked))
            if c.until is not None:
                events.append(Change(kind="relation", action="uncertified", id=r.id, at=c.until, summary=marked))
    for p in preferences:
        summary = f"{p.stance} {p.key}: {p.subject_entity} -> {p.value_entity}"
        action = "created" if p.revision == 1 else "updated"
        events.append(Change(kind="preference", action=action, id=p.id, at=p.created_at, summary=summary))
    for d in decisions:
        events.append(Change(kind="decision", action="created", id=d.id, at=d.created_at, summary=d.title))
        if d.updated_at > d.created_at:
            events.append(Change(kind="decision", action="updated", id=d.id, at=d.updated_at, summary=d.title))
    for m in merges:
        summary = f"{m.absorbed_id} into {m.survivor_id}: {m.reason}"
        events.append(Change(kind="merge", action="merged", id=m.id, at=m.created_at, summary=summary))
        if m.reverted_at is not None:
            events.append(
                Change(
                    kind="merge",
                    action="unmerged",
                    id=m.id,
                    at=m.reverted_at,
                    summary=f"{m.absorbed_id} back out of {m.survivor_id}",
                )
            )
    for v in versions:
        events.append(
            Change(
                kind="source",
                action="created",
                id=v["source_id"],
                at=from_iso(v["created_at"]),
                summary=f"version {v['id']}",
            )
        )
    return events


async def graph_diff(
    runner: Any,
    ns: str,
    since: datetime,
    until: datetime,
    kinds: list[str] | None = None,
    limit: int | None = None,
) -> GraphDiff:
    """Read stored creations, revisions, and retirements in the known-time window (since, until].

    Beside the four change lists, the change log lists every write in the window oldest first, with counts per kind
    over the whole window; kinds selects which kinds changes includes, and limit keeps the newest changes.

    @param runner (Any): the graph runner.
    @param ns (str): the namespace.
    @param since (datetime): exclusive lower bound.
    @param until (datetime): inclusive upper bound.
    @param kinds (list[str] | None): the kinds to include in changes, or None for all of them.
    @param limit (int | None): the most changes to return, keeping the newest, or None for all.
    @return (GraphDiff): changes in deterministic id and revision order.
    """
    result = GraphDiff(since=since, until=until)
    retired: dict[tuple[str, datetime], Relation] = {}
    relations: list[Relation] = []
    skip = 0
    while True:
        rows = await runner.match_edges(
            ns,
            from_label=L_ENTITY,
            to_label=L_ENTITY,
            current_only=False,
            order_by="id",
            skip=skip,
            limit=_ops._PAGE,
        )
        for row in rows:
            relation = _ops._relation_of(row)
            relations.append(relation)
            if since < aware(relation.created_at) <= until:
                target = result.relations_added if relation.revision == 1 else result.relations_revised
                target.append(relation)
            ended = relation.invalidated_known_at
            if ended is not None and since < aware(ended) <= until and aware(relation.created_at) <= aware(ended):
                key = (relation.id, ended)
                previous = retired.get(key)
                if previous is None or previous.revision < relation.revision:
                    retired[key] = relation
        if len(rows) < _ops._PAGE:
            break
        skip += len(rows)
    result.relations_added.sort(key=lambda r: (r.id, r.revision))
    result.relations_revised.sort(key=lambda r: (r.id, r.revision))
    result.relations_retired = sorted(retired.values(), key=lambda r: (r.id, aware(r.invalidated_known_at)))
    entities = []
    skip = 0
    while True:
        rows = await runner.match_nodes(ns, L_ENTITY, order_by="id", skip=skip, limit=_ops._PAGE)
        for row in rows:
            entity = decode_entity(row)
            entities.append(entity)
            if since < aware(entity.created_at) <= until:
                result.entities_created.append(entity)
        if len(rows) < _ops._PAGE:
            break
        skip += len(rows)
    result.entities_created.sort(key=lambda e: e.id)
    preferences = await _ops._paged(
        partial(runner.match_edges, ns, from_label=L_PROFILE, to_label=L_ENTITY, current_only=False, order_by="id")
    )
    decisions = await _ops._paged(partial(_ops.list_traces, runner, ns, actor_entity=None, status=None))
    merges = [_decode_merge(r) for r in await _ops._paged(partial(runner.match_nodes, ns, L_MERGE, order_by="id"))]
    versions = await _ops._paged(partial(runner.match_nodes, ns, L_SOURCE_VERSION, order_by="id"))
    events = change_events(
        entities, relations, [_ops._preference_of(e) for e in preferences], decisions, merges, versions
    )
    events = [c for c in events if _in_window(c.at, since, until)]
    events.sort(key=lambda c: (aware(c.at), c.kind, c.action, c.id))
    result.total = len(events)
    counts: dict[str, int] = {}
    for c in events:
        counts[c.kind] = counts.get(c.kind, 0) + 1
    result.counts = counts
    if kinds is not None:
        events = [c for c in events if c.kind in kinds]
    if limit is not None and len(events) > limit:
        events = events[-limit:]
    result.changes = events
    return result
