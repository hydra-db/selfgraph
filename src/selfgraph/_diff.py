from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from datetime import datetime
from typing import Any

from . import _ops
from ._serde import (
    L_ENTITY,
    L_MERGE,
    L_PROFILE,
    L_SOURCE_VERSION,
    L_TRACE,
    aware,
    decode_entity,
    decode_source_version,
    from_iso,
)
from .models import GraphDiff, Relation
from .resolution import decode_merges


def _nodes(runner: Any, ns: str, label: str) -> AsyncIterator[list[dict[str, Any]]]:
    """Page through every node of one label in id order.

    @param runner (Any): the graph runner.
    @param ns (str): the namespace.
    @param label (str): the node label.
    @return (AsyncIterator[list[dict[str, Any]]]): each non-empty page of node properties.
    """
    return _ops._keyset(lambda after, limit: runner.match_nodes(ns, label, order_by="id", id_gt=after, limit=limit))


async def _relations(runner: Any, ns: str, within: Callable[[datetime | None], bool], result: GraphDiff) -> None:
    """Add the entities created and the relation versions written, retired, certified, or uncertified in the window.

    @param runner (Any): the graph runner.
    @param ns (str): the namespace.
    @param within (Callable[[datetime | None], bool]): whether a known time falls in the window.
    @param result (GraphDiff): the diff to fill.
    @return (None): nothing.
    """
    retired: dict[tuple[str, datetime], Relation] = {}
    async for page in _nodes(runner, ns, L_ENTITY):
        for row in page:
            entity = decode_entity(row)
            if within(entity.created_at):
                result.entities_created.append(entity)
        for row in await _ops._edges_into(runner, ns, L_ENTITY, L_ENTITY, "from_in", [row["id"] for row in page]):
            relation = _ops._relation_of(row)
            if within(relation.created_at):
                target = result.relations_added if relation.revision == 1 else result.relations_revised
                target.append(relation)
            ended = relation.invalidated_known_at
            if within(ended) and aware(relation.created_at) <= aware(ended):
                key = (relation.id, ended)
                previous = retired.get(key)
                if previous is None or previous.revision < relation.revision:
                    retired[key] = relation
            own = [c for c in relation.certifications if aware(relation.created_at) <= aware(c.at)]
            if any(within(c.at) for c in own):
                result.relations_certified.append(relation)
            if any(within(c.until) for c in own):
                result.relations_uncertified.append(relation)
    result.relations_retired = sorted(retired.values(), key=lambda r: (r.id, aware(r.invalidated_known_at)))


async def graph_diff(runner: Any, ns: str, since: datetime, until: datetime) -> GraphDiff:
    """Read the history stored in the known-time window (since, until], one list per kind and change.

    @param runner (Any): the graph runner.
    @param ns (str): the namespace.
    @param since (datetime): exclusive lower bound.
    @param until (datetime): inclusive upper bound.
    @return (GraphDiff): changes in deterministic id and revision order.
    """
    result = GraphDiff(since=since, until=until)

    def within(stamp: datetime | None) -> bool:
        return stamp is not None and since < aware(stamp) <= until

    await _relations(runner, ns, within, result)
    async for page in _nodes(runner, ns, L_PROFILE):
        for row in await _ops._edges_into(runner, ns, L_PROFILE, L_ENTITY, "from_in", [row["id"] for row in page]):
            preference = _ops._preference_of(row)
            if within(preference.created_at):
                target = result.preferences_added if preference.revision == 1 else result.preferences_revised
                target.append(preference)
    async for page in _nodes(runner, ns, L_TRACE):
        rows = [row for row in page if within(from_iso(row["created_at"])) or within(from_iso(row["updated_at"]))]
        for trace in await _ops.decode_traces(runner, ns, rows):
            if within(trace.created_at):
                result.decisions_created.append(trace)
            if trace.updated_at > trace.created_at and within(trace.updated_at):
                result.decisions_updated.append(trace)
    async for page in _nodes(runner, ns, L_MERGE):
        rows = [row for row in page if within(from_iso(row["created_at"])) or within(from_iso(row.get("reverted_at")))]
        for record in await decode_merges(runner, ns, rows):
            if within(record.created_at):
                result.entities_merged.append(record)
            if within(record.reverted_at):
                result.entities_unmerged.append(record)
    async for page in _nodes(runner, ns, L_SOURCE_VERSION):
        result.source_versions_added += [v for v in map(decode_source_version, page) if within(v.created_at)]
    for versions in (
        result.relations_added,
        result.relations_revised,
        result.relations_certified,
        result.relations_uncertified,
        result.preferences_added,
        result.preferences_revised,
    ):
        versions.sort(key=lambda v: (v.id, v.revision))
    result.entities_created.sort(key=lambda e: e.id)
    return result
