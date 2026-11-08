from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from .. import _ops
from ..models import DeleteResult, Entity, Evidence, JsonValue, Page
from ._common import DEFAULT_PAGE_LIMIT, Resource, paginate

__all__ = ["Entities"]


class Entities(Resource):
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
            schema_check=self._c._schema_check,
        )

    async def get(self, id: str) -> Entity | None:
        return await _ops.get_entity(await self._c._reader(), self._c.namespace, id)

    async def list(
        self,
        *,
        type: str | None = None,
        name: str | None = None,
        cursor: str | None = None,
        limit: int = DEFAULT_PAGE_LIMIT,
    ) -> Page[Entity]:
        return await self._page(_ops.list_entities, type=type, name=name, cursor=cursor, limit=limit)

    async def evidence(self, id: str, *, cursor: str | None = None, limit: int = DEFAULT_PAGE_LIMIT) -> Page[Evidence]:
        """List the evidence records supporting an entity, one per source, version, chunk, and quote.

        @param id (str): the entity id.
        @param cursor (str | None): the cursor from a previous page, or None to start.
        @param limit (int): page size.
        @return (Page[Evidence]): evidence ordered by evidence id; raises NotFoundError for an unknown entity.
        """
        return await self._page(_ops.list_evidence, id, kind="entity", cursor=cursor, limit=limit)

    def iterate(
        self, *, type: str | None = None, name: str | None = None, limit: int = DEFAULT_PAGE_LIMIT
    ) -> AsyncIterator[Entity]:
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
        return await self._c._write(_ops.update_entity, id, schema_check=self._c._schema_check, **fields)

    async def delete(self, id: str) -> DeleteResult:
        """Delete an entity, its relations, and any decision trace that references it.

        @param id (str): the entity id.
        @return (DeleteResult): counts of entities, relation versions, and decisions removed.
        """
        return DeleteResult(**await self._c._write(_ops.delete_entity, id))
