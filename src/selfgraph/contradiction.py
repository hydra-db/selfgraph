from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, StrictInt
from pydantic import ValidationError as PydanticValidationError

from . import _ops
from ._payload import context_payload
from ._serde import L_ENTITY, decode_entity
from .errors import ExtractionError
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
    retired: list[StrictInt] = Field(default_factory=list)


def _line(edge_type: str, source: str, target: str, properties: Mapping[str, Any]) -> str:
    """Render one fact for the judge.

    @param edge_type (str): the relation type.
    @param source (str): the source entity's name.
    @param target (str): the destination entity's name.
    @param properties (Mapping[str, Any]): the relation's properties.
    @return (str): the fact as one line, with line breaks and control characters escaped.
    """
    props = " {" + ", ".join(f"{k}={v}" for k, v in sorted(properties.items())) + "}" if properties else ""
    return context_payload(f"{source} -[{edge_type}]-> {target}{props}")


async def judge_contradictions(
    runner: Any,
    ns: str,
    llm: LLMClient,
    written: list[Relation],
    caps: Mapping[str, _ops.RelationCap] | None,
    known: datetime,
    names: Mapping[str, str] | None = None,
) -> Callable[[datetime], Awaitable[list[InsertWarning]]]:
    """Validate contradiction verdicts before writing and return their retirement operation.

    Only relations the cardinality rules left alone are judged: one call per written relation that has a rival
    (see _ops.rival_relations). A retired relation is invalidated by the written one at its effective time. A
    certified relation is never retired, as with the cardinality rules.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param llm (LLMClient): the LLM to ask.
    @param written (list[Relation]): the planned relation versions.
    @param caps (Mapping[str, RelationCap] | None): the schema's max_count limits by relation type.
    @param known (datetime): the timestamp of the write, stamped on each retirement.
    @param names (Mapping[str, str] | None): names of entities in the planned write.
    @return (Callable): apply the validated retirements at the write timestamp and return their warnings.
    """
    by_id = {r.id: r for r in written if r.created_at == known}
    rivals = await _ops.rival_relations(runner, ns, written, caps, _MAX_RIVALS)
    rivals = {rid: edges for rid, edges in rivals.items() if rid in by_id}
    refs = {x for rid in rivals for x in (by_id[rid].from_entity, by_id[rid].to_entity)}
    refs |= {e["to_id"] for edges in rivals.values() for e in edges}
    nodes = await _ops._nodes_by_id(runner, ns, L_ENTITY, sorted(refs))
    names = {**{eid: decode_entity(props).name for eid, props in nodes.items()}, **(names or {})}

    def name(eid: str) -> str:
        return names.get(eid, eid)

    retirements: list[tuple[dict, str, datetime | None]] = []
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
        try:
            verdict = await llm.generate(system=_SYSTEM, user=user, output=_Verdict)
            verdict = _Verdict.model_validate(verdict)
        except PydanticValidationError as exc:
            raise ExtractionError(
                "LLM client returned an invalid contradiction verdict",
                code="invalid_llm_output",
                field="retired",
            ) from exc
        for number in dict.fromkeys(verdict.retired):
            if 1 <= number <= len(open_edges):
                edge = open_edges[number - 1]
                taken.add(edge["props"]["id"])
                if edge["props"].get("certified_at") is None:
                    retirements.append((edge, new.id, new.event_time))
                    continue
                message = (
                    f"relation {edge['props']['id']} is certified, so it stays current though the LLM judged "
                    f"{rid} to contradict it"
                )
                kept.append(InsertWarning(code="certified_kept", message=message))

    async def apply(at: datetime) -> list[InsertWarning]:
        retired = await _ops.retire_relations(
            runner, ns, [(edge, by, when or at) for edge, by, when in retirements], at
        )
        return kept + [
            InsertWarning(
                code="relation_superseded",
                message=(
                    f"relation {rel.id} was superseded by {rel.invalidated_by}, which the LLM judged to contradict it"
                ),
            )
            for rel in retired
        ]

    return apply
