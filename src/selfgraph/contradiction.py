from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from . import _ops
from ._serde import L_ENTITY, decode_entity
from .models import InsertWarning, Relation
from .protocols import LLMClient

__all__ = ["judge_contradictions"]

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


async def judge_contradictions(
    runner: Any,
    ns: str,
    llm: LLMClient,
    written: list[Relation],
    caps: Mapping[str, _ops.RelationCap] | None,
) -> list[InsertWarning]:
    """Ask the LLM which older relations each written relation makes untrue, and retire those.

    Only relations the cardinality rules left alone are judged: one call per written relation that has a rival
    (see _ops.rival_relations). A retired relation is invalidated by the written one at its effective time. A
    certified relation is never retired, as with the cardinality rules.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param llm (LLMClient): the LLM to ask.
    @param written (list[Relation]): the relations a write just stored.
    @param caps (Mapping[str, RelationCap] | None): the schema's max_count limits by relation type.
    @return (list[InsertWarning]): one relation_superseded warning per retired relation, and one certified_kept warning
        per certified relation the LLM judged contradicted, which stays current.
    """
    rivals = await _ops.rival_relations(runner, ns, written, caps, _MAX_RIVALS)
    if not rivals:
        return []
    by_id = {r.id: r for r in written}
    refs = {x for rid in rivals for x in (by_id[rid].from_entity, by_id[rid].to_entity)}
    refs |= {e["to_id"] for edges in rivals.values() for e in edges}
    nodes = await _ops._nodes_by_id(runner, ns, L_ENTITY, sorted(refs))
    names = {eid: decode_entity(props).name for eid, props in nodes.items()}

    def name(eid: str) -> str:
        return names.get(eid, eid)

    retirements: list[tuple[dict, str, datetime]] = []
    kept: list[InsertWarning] = []
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
                if edge["props"].get("certified_at") is None:
                    retirements.append((edge, new.id, _ops.effective_time(new)))
                    continue
                message = (
                    f"relation {edge['props']['id']} is certified, so it stays current though the LLM judged "
                    f"{rid} to contradict it"
                )
                kept.append(InsertWarning(code="certified_kept", message=message))
    retired = await _ops.retire_relations(runner, ns, retirements)
    return kept + [
        InsertWarning(
            code="relation_superseded",
            message=f"relation {rel.id} was superseded by {rel.invalidated_by}, which the LLM judged to contradict it",
        )
        for rel in retired
    ]
