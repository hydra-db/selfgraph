from __future__ import annotations

from collections.abc import AsyncIterator, Iterable, Mapping
from datetime import datetime
from typing import TYPE_CHECKING

from .. import _ops
from ..models import DeleteResult, EvidenceInput, JsonValue, Page, Relation
from ._common import decode_cursor, make_page, paginate

if TYPE_CHECKING:
    from ..client import SelfGraph

__all__ = ["Relations"]


class Relations:
    def __init__(self, client: SelfGraph) -> None:
        self._c = client

    async def create(
        self,
        from_entity: str,
        type: str,
        to_entity: str,
        *,
        id: str | None = None,
        properties: Mapping[str, JsonValue] | None = None,
        event_time: datetime | None = None,
        evidence: Iterable[EvidenceInput] = (),
    ) -> Relation:
        return await self._c._write(
            _ops.create_relation,
            from_entity=from_entity,
            type=type,
            to_entity=to_entity,
            id=id,
            properties=dict(properties) if properties else None,
            event_time=event_time,
            evidence=_ops.evidence_from_inputs(list(evidence)),
        )

    async def get(self, id: str) -> Relation | None:
        return await _ops.get_relation_current(self._c.store, self._c.namespace, id)

    async def list(
        self,
        *,
        from_entity: str | None = None,
        type: str | None = None,
        to_entity: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Page[Relation]:
        offset = decode_cursor(cursor)
        rows = await _ops.list_relations(
            self._c.store,
            self._c.namespace,
            from_entity=from_entity,
            type=type,
            to_entity=to_entity,
            skip=offset,
            limit=limit + 1,
        )
        return make_page(rows, offset, limit)

    def iterate(
        self,
        *,
        from_entity: str | None = None,
        type: str | None = None,
        to_entity: str | None = None,
        limit: int = 50,
    ) -> AsyncIterator[Relation]:
        """Yield every relation across pages, following the list cursor.

        @param from_entity (str | None): filter by source entity.
        @param type (str | None): filter by relation type.
        @param to_entity (str | None): filter by target entity.
        @param limit (int): page size per fetch.
        @return (AsyncIterator[Relation]): every matching relation.
        """
        return paginate(self.list, from_entity=from_entity, type=type, to_entity=to_entity, limit=limit)

    async def update(
        self,
        id: str,
        *,
        set_properties: Mapping[str, JsonValue] | None = None,
        remove_properties: Iterable[str] = (),
        event_time: datetime | None = None,
        evidence: Iterable[EvidenceInput] | None = None,
    ) -> Relation:
        return await self._c._write(
            _ops.update_relation,
            id,
            set_properties=dict(set_properties) if set_properties else None,
            remove_properties=list(remove_properties),
            event_time=event_time,
            evidence=None if evidence is None else _ops.evidence_from_inputs(list(evidence)),
        )

    async def versions(self, id: str, *, newest_first: bool = True) -> list[Relation]:
        return await _ops.list_relation_versions(self._c.store, self._c.namespace, id, newest_first=newest_first)

    async def delete(self, id: str) -> DeleteResult:
        counts = await self._c._write(_ops.delete_relation, id)
        return DeleteResult(**counts)
