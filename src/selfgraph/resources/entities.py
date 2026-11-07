from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from .. import _ops
from ..models import DeleteResult, Entity, JsonValue, Page
from ._common import make_page, page_offset, paginate

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
        """Create one entity. The positional order is (name, type), e.g. create("Jane Doe", "Person").

        @param name (str): the entity name.
        @param type (str): the entity type.
        @param id (str | None): explicit id, else derived as type:name.
        @param aliases (list[str] | None): alternate names.
        @param external_ids (dict[str, str] | None): external system ids.
        @param properties (dict[str, JsonValue] | None): extra properties.
        @return (Entity): the created entity.
        """
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
        return await _ops.get_entity(await self._c._reader(), self._c.namespace, id)

    async def list(
        self,
        *,
        type: str | None = None,
        name: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Page[Entity]:
        offset = page_offset(cursor, limit)
        rows = await _ops.list_entities(
            await self._c._reader(),
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
        """Update an entity's fields; scalars replace, collections merge.

        The id is immutable, so changing type leaves the id's original type prefix in
        place; it no longer matches entity_id(new_type, name). Delete and recreate to
        change an entity's derived id.

        This is a read-modify-write, serialized per entity on the transactional backends
        (Neo4j, Memgraph). The auto-commit backends (HydraDB, Kuzu, FalkorDB) run one
        write at a time per graph object, so concurrent updates in one process all apply;
        writers in separate processes are not serialized there and can lose updates.

        @param id (str): the entity id.
        @param fields (Any): name, type, aliases, external_ids, properties, remove_aliases, remove_properties.
        @return (Entity): the updated entity.
        """
        return await self._c._write(_ops.update_entity, id, **fields)

    async def delete(self, id: str) -> DeleteResult:
        """Delete an entity, its relations, and any decision trace that references it.

        @param id (str): the entity id.
        @return (DeleteResult): counts of entities, relation versions, and decisions removed.
        """
        counts = await self._c._write(_ops.delete_entity, id)
        return DeleteResult(**counts)
