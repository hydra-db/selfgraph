from __future__ import annotations

from collections.abc import AsyncIterator, Iterable
from datetime import datetime
from typing import Any

from .. import _ops
from ..models import DecisionTrace, DeleteResult, Page, Status
from ._common import DEFAULT_PAGE_LIMIT, Resource, paginate

__all__ = ["Decisions"]


class Decisions(Resource):
    async def create(
        self,
        title: str,
        *,
        steps: Iterable[str] = (),
        id: str | None = None,
        actor_entity: str | None = None,
        summary: str | None = None,
        rationale: str | None = None,
        outcome_entity: str | None = None,
        alternative_entities: Iterable[str] = (),
        status: Status = "completed",
        event_time: datetime | str | None = None,
    ) -> DecisionTrace:
        """Record a decision trace over existing relations.

        @param title (str): the decision title.
        @param steps (Iterable[str]): ids of relations that already exist, in order, default none; they are not checked
            to connect.
        @param id (str | None): explicit id, else derived.
        @param actor_entity (str | None): the deciding entity id.
        @param summary (str | None): a short summary.
        @param rationale (str | None): why the decision was made.
        @param outcome_entity (str | None): the resulting entity id.
        @param alternative_entities (Iterable[str]): entity ids that were considered and not chosen.
        @param status (Status): the decision status.
        @param event_time (datetime | str | None): the decision's valid time.
        @return (DecisionTrace): the recorded trace.
        """
        return await self._c._write(
            _ops.create_trace,
            title=title,
            steps=steps,
            id=id,
            actor_entity=actor_entity,
            summary=summary,
            rationale=rationale,
            outcome_entity=outcome_entity,
            alternative_entities=alternative_entities,
            status=status,
            event_time=event_time,
        )

    async def get(self, id: str) -> DecisionTrace | None:
        _ops._validate_own_id("decision", id)
        return await _ops.get_trace(await self._c._reader(), self._c.namespace, id)

    async def list(
        self,
        *,
        actor_entity: str | None = None,
        status: Status | None = None,
        cursor: str | None = None,
        limit: int = DEFAULT_PAGE_LIMIT,
    ) -> Page[DecisionTrace]:
        return await self._page(
            _ops.list_traces, actor_entity=actor_entity, status=status, cursor=cursor, limit=limit, by_id="decision"
        )

    def iterate(
        self,
        *,
        actor_entity: str | None = None,
        status: Status | None = None,
        limit: int = DEFAULT_PAGE_LIMIT,
    ) -> AsyncIterator[DecisionTrace]:
        """Yield every decision trace across pages, following the list cursor.

        @param actor_entity (str | None): filter by actor entity.
        @param status (Status | None): filter by status.
        @param limit (int): the page size per fetch, not a cap; iteration yields every match.
        @return (AsyncIterator[DecisionTrace]): every matching decision trace.
        """
        return paginate(self.list, actor_entity=actor_entity, status=status, limit=limit)

    async def update(self, id: str, *, clear: Iterable[str] = (), **fields: Any) -> DecisionTrace:
        _ops._validate_own_id("decision", id)
        return await self._c._write(_ops.update_trace, id, clear=clear, **fields)

    async def delete(self, id: str) -> DeleteResult:
        _ops._validate_own_id("decision", id)
        return DeleteResult(**await self._c._write(_ops.delete_trace, id))
