from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from . import _ops
from ._serde import L_ENTITY, decode_entity
from .models import InsertWarning, Relation
from .protocols import LLMClient

__all__ = ["ask_judge", "apply_verdicts", "judged_rivals"]

_MAX_RIVALS = 20
_SYSTEM = (
    "You decide whether a new fact makes older facts about the same subject no longer true. List an older fact "
    "only when it and the new fact cannot both hold at once, such as a previous employer after a job change or "
    "a liking that became a dislike. Facts that can hold together, such as knowing several people, are not "
    "contradicted. When unsure, list nothing."
)


class _Verdict(BaseModel):
    retired: list[int] = Field(default_factory=list)


def _line(edge_type: str, source: str, target: str, properties: Mapping[str, Any]) -> str:
    """Render one fact for the judge.

    @param edge_type (str): the relation type.
    @param source (str): the source entity's name.
    @param target (str): the destination entity's name.
    @param properties (Mapping[str, Any]): the relation's properties.
    @return (str): the fact as one line.
    """
    props = " {" + ", ".join(f"{k}={v}" for k, v in properties.items()) + "}" if properties else ""
    return f"{source} -[{edge_type}]-> {target}{props}"


async def judged_rivals(
    runner: Any,
    ns: str,
    written: list[Relation],
    caps: Mapping[str, _ops.RelationCap] | None,
    written_at: datetime,
) -> set[str]:
    """Name the older relations ask_judge would show the LLM for some written relations, without asking it.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param written (list[Relation]): the relations a write stored.
    @param caps (Mapping[str, RelationCap] | None): the schema's max_count limits by relation type.
    @param written_at (datetime): the write's timestamp; only relations it created or revised are judged.
    @return (set[str]): the rival relation ids.
    """
    fresh = {r.id for r in written if r.created_at == written_at}
    if not fresh:
        return set()
    rivals = await _ops.rival_relations(runner, ns, written, caps, _MAX_RIVALS)
    return {e["props"]["id"] for rid, edges in rivals.items() if rid in fresh for e in edges}


async def ask_judge(
    runner: Any,
    ns: str,
    llm: LLMClient,
    written: list[Relation],
    caps: Mapping[str, _ops.RelationCap] | None,
    written_at: datetime,
) -> list[tuple[Relation, dict]]:
    """Ask the LLM which older relations each written relation makes untrue, without writing anything.

    Only relations the cardinality rules left alone are judged: one call per written relation that has a rival
    (see _ops.rival_relations). It runs after the write commits and outside any transaction, so no lock is held
    while the LLM answers and a retried write never asks again; apply_verdicts then retires what it chose.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param llm (LLMClient): the LLM to ask.
    @param written (list[Relation]): the relations a write just stored.
    @param caps (Mapping[str, RelationCap] | None): the schema's max_count limits by relation type.
    @param written_at (datetime): the write's timestamp; only relations it created or revised are judged.
    @return (list[tuple[Relation, dict]]): each written relation, as judged, with a rival edge row the LLM judged it
        contradicts.
    """
    by_id = {r.id: r for r in written if r.created_at == written_at}
    if not by_id:
        return []
    rivals = await _ops.rival_relations(runner, ns, written, caps, _MAX_RIVALS)
    rivals = {rid: edges for rid, edges in rivals.items() if rid in by_id}
    if not rivals:
        return []
    refs = {x for rid in rivals for x in (by_id[rid].from_entity, by_id[rid].to_entity)}
    refs |= {e["to_id"] for edges in rivals.values() for e in edges}
    nodes = await _ops._nodes_by_id(runner, ns, L_ENTITY, sorted(refs))
    names = {eid: decode_entity(props).name for eid, props in nodes.items()}

    def name(eid: str) -> str:
        return names.get(eid, eid)

    chosen: list[tuple[Relation, dict]] = []
    taken: set[str] = set()
    for rid, edges in rivals.items():
        new = by_id[rid]
        open_edges = [e for e in edges if e["props"]["id"] not in taken]
        if not open_edges:
            continue
        older = "\n".join(
            f"{i}. {_line(e['type'], name(e['from_id']), name(e['to_id']), _ops._relation_of(e).properties)}"
            for i, e in enumerate(open_edges, 1)
        )
        user = (
            f"New fact: {_line(new.type, name(new.from_entity), name(new.to_entity), new.properties)}\n"
            f"Older facts:\n{older}\n"
            "Which older facts, by number, are no longer true now that the new fact holds?"
        )
        verdict = await llm.generate(system=_SYSTEM, user=user, output=_Verdict)
        verdict = verdict if isinstance(verdict, _Verdict) else _Verdict.model_validate(verdict)
        for number in dict.fromkeys(verdict.retired):
            if 1 <= number <= len(open_edges):
                edge = open_edges[number - 1]
                taken.add(edge["props"]["id"])
                chosen.append((new, edge))
    return chosen


def _version(edge: dict) -> tuple[int, str | None]:
    """Identify the stored version of an edge row, so a relation deleted and created again does not match it.

    @param edge (dict): the edge row.
    @return (tuple[int, str | None]): its revision and creation time.
    """
    return _ops._revision(edge), edge["props"].get("created_at")


async def apply_verdicts(
    runner: Any, ns: str, chosen: list[tuple[Relation, dict]], known: datetime
) -> list[InsertWarning]:
    """Retire the older relations the judge chose, each read again with its written relation under their source locks.

    A verdict is stale, and left alone, when the rival or the written relation is gone, no longer current, or is
    another version than the one judged: another revision, or the same revision created again after a delete. A
    retired relation is invalidated by the written relation at its effective time. A certified relation is never
    retired, as with the cardinality rules.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param chosen (list[tuple[Relation, dict]]): each written relation with a rival edge row, as ask_judge returns.
    @param known (datetime): the timestamp of this write, stamped on each retirement.
    @return (list[InsertWarning]): one relation_superseded warning per retired relation, and one certified_kept warning
        per certified relation the LLM judged contradicted, which stays current.
    """
    sources = (eid for asked, edge in chosen for eid in (asked.from_entity, edge["from_id"]))
    for source in sorted(_ops._dedup_list(sources)):
        await runner.lock_node(ns, L_ENTITY, source)
    retirements: list[tuple[dict, str, datetime]] = []
    kept: list[InsertWarning] = []
    for asked, judged in chosen:
        rid = asked.id
        new = await _ops.get_relation_current(runner, ns, rid)
        edge = await runner.get_current_edge(ns, judged["props"]["id"])
        if new is None or (new.revision, new.created_at) != (asked.revision, asked.created_at):
            continue
        if edge is None or _version(edge) != _version(judged):
            continue
        if edge["props"].get("certified_at") is None:
            retirements.append((edge, rid, _ops.effective_time(new)))
            continue
        message = (
            f"relation {edge['props']['id']} is certified, so it stays current though the LLM judged "
            f"{rid} to contradict it"
        )
        kept.append(InsertWarning(code="certified_kept", message=message))
    retired = await _ops.retire_relations(runner, ns, retirements, known)
    return kept + [
        InsertWarning(
            code="relation_superseded",
            message=f"relation {rel.id} was superseded by {rel.invalidated_by}, which the LLM judged to contradict it",
        )
        for rel in retired
    ]
