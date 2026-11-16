from __future__ import annotations

from datetime import datetime
from functools import partial
from typing import Any

from . import _ops
from ._serde import L_ENTITY, L_MERGE, L_PROFILE, L_SOURCE_VERSION, aware, from_iso
from .models import Change, DiffResult, MergeRecord
from .resolution import _decode_merge

__all__ = ["build_diff", "change_events"]

_KINDS = ("entity", "relation", "preference", "decision", "merge", "source")


def _in_window(at: datetime, since: datetime | None, until: datetime | None) -> bool:
    """Report whether a change time falls in the (since, until] window.

    @param at (datetime): the change time.
    @param since (datetime | None): changes at or before this time are left out, or None for no lower bound.
    @param until (datetime | None): changes after this time are left out, or None for no upper bound.
    @return (bool): true when the change is inside the window.
    """
    return (since is None or at > since) and (until is None or at <= until)


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
        summary = f"{e.type} {e.name}"
        events.append(Change(kind="entity", action="created", id=e.id, at=e.created_at, summary=summary))
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
        summary = d.title
        events.append(Change(kind="decision", action="created", id=d.id, at=d.created_at, summary=summary))
        if d.updated_at > d.created_at:
            events.append(Change(kind="decision", action="updated", id=d.id, at=d.updated_at, summary=summary))
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


async def build_diff(
    runner: Any,
    ns: str,
    *,
    since: datetime | None,
    until: datetime | None,
    kinds: tuple[str, ...] | None,
    limit: int | None,
) -> DiffResult:
    """Read the change log of a namespace between two times.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param since (datetime | None): changes at or before this time are left out (naive means UTC), or None.
    @param until (datetime | None): changes after this time are left out (naive means UTC), or None for now.
    @param kinds (tuple[str, ...] | None): the kinds to include, or None for all of them.
    @param limit (int | None): the most changes to return, keeping the newest, or None for all.
    @return (DiffResult): the window, the total, the counts per kind, and the changes oldest first.
    """
    entities = await _ops._paged(partial(_ops.list_entities, runner, ns, type=None, name=None))
    relations = await _ops._paged(
        partial(runner.match_edges, ns, from_label=L_ENTITY, to_label=L_ENTITY, current_only=False, order_by="id")
    )
    preferences = await _ops._paged(
        partial(runner.match_edges, ns, from_label=L_PROFILE, to_label=L_ENTITY, current_only=False, order_by="id")
    )
    decisions = await _ops._paged(partial(_ops.list_traces, runner, ns, actor_entity=None, status=None))
    merges = [_decode_merge(r) for r in await _ops._paged(partial(runner.match_nodes, ns, L_MERGE, order_by="id"))]
    versions = await _ops._paged(partial(runner.match_nodes, ns, L_SOURCE_VERSION, order_by="id"))
    events = [
        c
        for c in change_events(
            entities,
            [_ops._relation_of(e) for e in relations],
            [_ops._preference_of(e) for e in preferences],
            decisions,
            merges,
            versions,
        )
        if _in_window(aware(c.at), since, until) and (kinds is None or c.kind in kinds)
    ]
    events.sort(key=lambda c: (c.at, c.kind, c.action, c.id))
    counts: dict[str, int] = {}
    for c in events:
        counts[c.kind] = counts.get(c.kind, 0) + 1
    kept = events[-limit:] if limit is not None and len(events) > limit else events
    return DiffResult(since=since, until=until, total=len(events), counts=counts, changes=kept)
