from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from .. import _ops
from ..models import DeleteResult, Entity, JsonValue, Page
from ._common import decode_cursor, make_page, paginate

if TYPE_CHECKING:
    from ..client import SelfGraph

__all__ = ["Entities"]


class Entities:
    def __init__(self, client: SelfGraph) -> None:
        self._c = client

    async def create(
        self,
        name: str,
        type: str,
        *,
        id: str | None = None,
        aliases: list[str] | None = None,
        external_ids: dict[str, str] | None = None,
        properties: dict[str, JsonValue] | None = None,
    ) -> Entity:
        return await self._c._write(
            _ops.create_entity,
            name=name,
            type=type,
            id=id,
            aliases=aliases,
            external_ids=external_ids,
            properties=properties,
        )

    async def get(self, id: str) -> Entity | None:
        return await _ops.get_entity(self._c.store, self._c.namespace, id)

    async def list(
        self,
        *,
        type: str | None = None,
        name: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Page[Entity]:
        offset = decode_cursor(cursor)
        rows = await _ops.list_entities(
            self._c.store,
            self._c.namespace,
            type=type,
            name=name,
            skip=offset,
            limit=limit + 1,
        )
        return make_page(rows, offset, limit)

    def iterate(self, *, type: str | None = None, name: str | None = None, limit: int = 50) -> AsyncIterator[Entity]:
        """Yield every entity across pages, following the list cursor.

        @param type (str | None): filter by type.
        @param name (str | None): filter by exact name.
        @param limit (int): page size per fetch.
        @return (AsyncIterator[Entity]): every matching entity.
        """
        return paginate(self.list, type=type, name=name, limit=limit)

    async def update(self, id: str, **fields: Any) -> Entity:
        return await self._c._write(_ops.update_entity, id, **fields)

    async def delete(self, id: str) -> DeleteResult:
        counts = await self._c._write(_ops.delete_entity, id)
        return DeleteResult(**counts)
