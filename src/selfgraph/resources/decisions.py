from __future__ import annotations

from collections.abc import AsyncIterator, Iterable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from .. import _ops
from ..models import DecisionTrace, DeleteResult, Page, Status
from ._common import make_page, page_offset, paginate

if TYPE_CHECKING:
    from ..client import SelfGraph

__all__ = ["Decisions"]


class Decisions:
    def __init__(self, client: SelfGraph) -> None:
        self._c = client

    async def create(
        self,
        title: str,
        *,
        steps: Iterable[str],
        id: str | None = None,
        actor_entity: str | None = None,
        summary: str | None = None,
        rationale: str | None = None,
        outcome_entity: str | None = None,
        alternative_entities: Iterable[str] = (),
        status: Status = "completed",
        event_time: datetime | None = None,
    ) -> DecisionTrace:
        """Record a decision trace over existing relations.

        @param title (str): the decision title.
        @param steps (Iterable[str]): ids of relations that already exist, in order; they are not checked to connect.
        @param id (str | None): explicit id, else derived.
        @param actor_entity (str | None): the deciding entity id.
        @param summary (str | None): a short summary.
        @param rationale (str | None): why the decision was made.
        @param outcome_entity (str | None): the resulting entity id.
        @param alternative_entities (Iterable[str]): entity ids that were considered and not chosen.
        @param status (Status): the decision status.
        @param event_time (datetime | None): the decision's valid time.
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
        return await _ops.get_trace(await self._c._reader(), self._c.namespace, id)

    async def list(
        self,
        *,
        actor_entity: str | None = None,
        status: Status | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Page[DecisionTrace]:
        offset = page_offset(cursor, limit)
        rows = await _ops.list_traces(
            await self._c._reader(),
            self._c.namespace,
            actor_entity=actor_entity,
            status=status,
            skip=offset,
            limit=limit + 1,
        )
        return make_page(rows, offset, limit)

    def iterate(
        self,
        *,
        actor_entity: str | None = None,
        status: Status | None = None,
        limit: int = 50,
    ) -> AsyncIterator[DecisionTrace]:
        """Yield every decision trace across pages, following the list cursor.

        @param actor_entity (str | None): filter by actor entity.
        @param status (Status | None): filter by status.
        @param limit (int): page size per fetch.
        @return (AsyncIterator[DecisionTrace]): every matching decision trace.
        """
        return paginate(self.list, actor_entity=actor_entity, status=status, limit=limit)

    async def update(self, id: str, **fields: Any) -> DecisionTrace:
        return await self._c._write(_ops.update_trace, id, **fields)

    async def delete(self, id: str) -> DeleteResult:
        counts = await self._c._write(_ops.delete_trace, id)
        return DeleteResult(**counts)
