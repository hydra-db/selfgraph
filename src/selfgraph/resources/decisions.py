from __future__ import annotations

from collections.abc import AsyncIterator, Iterable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from .. import _ops
from ..models import DecisionTrace, DeleteResult, Page, Status
from ._common import decode_cursor, make_page, paginate

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
        return await self._c._write(
            _ops.create_trace,
            title=title,
            steps=list(steps),
            id=id,
            actor_entity=actor_entity,
            summary=summary,
            rationale=rationale,
            outcome_entity=outcome_entity,
            alternative_entities=list(alternative_entities),
            status=status,
            event_time=event_time,
        )

    async def get(self, id: str) -> DecisionTrace | None:
        return await _ops.get_trace(self._c.store, self._c.namespace, id)

    async def list(
        self,
        *,
        actor_entity: str | None = None,
        status: Status | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Page[DecisionTrace]:
        offset = decode_cursor(cursor)
        rows = await _ops.list_traces(
            self._c.store,
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
        if "alternative_entities" in fields:
            fields["alternative_entities"] = list(fields["alternative_entities"])
        if "steps" in fields:
            fields["steps"] = list(fields["steps"])
        return await self._c._write(_ops.update_trace, id, **fields)

    async def delete(self, id: str) -> DeleteResult:
        counts = await self._c._write(_ops.delete_trace, id)
        return DeleteResult(**counts)
