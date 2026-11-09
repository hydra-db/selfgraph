from __future__ import annotations

from collections.abc import AsyncIterator
from functools import partial
from typing import Any

from .. import _ops, resolution
from ..models import DeleteResult, Entity, Evidence, JsonValue, MergeRecord, Page, UnmergeResult
from ..schema import canonical_entity_ref, canonical_entity_type
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
        @param type (str): the entity type; a schema alias becomes the schema's type name before the id is derived.
        @param id (str | None): explicit id, else derived as type:name; a prefix naming the type's schema alias
            becomes the schema type's id form.
        @param aliases (list[str] | None): alternate names.
        @param external_ids (dict[str, str] | None): external system ids.
        @param properties (dict[str, JsonValue] | None): extra properties.
        @return (Entity): the created entity.
        """
        schema = self._c.schema
        if isinstance(type, str):
            type = _ops._clean_text(type)
            id = canonical_entity_ref(id, type, schema)
            type = canonical_entity_type(type, schema)
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
        """List entities, optionally filtered by type and exact name.

        @param type (str | None): filter by type, ignoring letter case; with a schema, an alias matches its type.
        @param name (str | None): filter by exact name.
        @param cursor (str | None): the cursor from a previous page, or None to start.
        @param limit (int): page size.
        @return (Page[Entity]): entities ordered by id.
        """
        canonical = partial(canonical_entity_type, schema=self._c.schema)
        return await self._page(
            _ops.list_entities, type=type, name=name, cursor=cursor, limit=limit, by_id="entity", canonical=canonical
        )

    async def evidence(self, id: str, *, cursor: str | None = None, limit: int = DEFAULT_PAGE_LIMIT) -> Page[Evidence]:
        """List the evidence records supporting an entity, one per source, version, chunk, and quote.

        @param id (str): the entity id.
        @param cursor (str | None): the cursor from a previous page, or None to start.
        @param limit (int): page size.
        @return (Page[Evidence]): evidence ordered by evidence id; raises NotFoundError for an unknown entity.
        """
        return await self._page(_ops.list_evidence, id, kind="entity", cursor=cursor, limit=limit)

    async def merges(self, id: str, *, cursor: str | None = None, limit: int = DEFAULT_PAGE_LIMIT) -> Page[MergeRecord]:
        """List the merge records of entities that entity resolution folded into this one.

        @param id (str): the surviving entity id.
        @param cursor (str | None): the cursor from a previous page, or None to start.
        @param limit (int): page size.
        @return (Page[MergeRecord]): records ordered by merge id; raises NotFoundError for an unknown entity.
        """
        return await self._page(resolution.list_merges, id, cursor=cursor, limit=limit)

    async def unmerge(self, merge_id: str) -> UnmergeResult:
        """Reverse one merge: recreate the absorbed entity, drop the aliases it added, and move its references back.

        @param merge_id (str): the merge record id, from entities.merges or InsertResult.merges.
        @return (UnmergeResult): the reverted record, the recreated entity, the survivor, and what moved back.
        """
        return await self._c._write(resolution.unmerge, merge_id)

    def iterate(
        self, *, type: str | None = None, name: str | None = None, limit: int = DEFAULT_PAGE_LIMIT
    ) -> AsyncIterator[Entity]:
        """Yield every entity across pages, following the list cursor.

        @param type (str | None): filter by type, ignoring letter case; with a schema, an alias matches its type.
        @param name (str | None): filter by exact name.
        @param limit (int): the page size per fetch, not a cap; iteration yields every match.
        @return (AsyncIterator[Entity]): every matching entity.
        """
        return paginate(self.list, type=type, name=name, limit=limit)

    async def update(self, id: str, **fields: Any) -> Entity:
        """Update an entity's fields; scalars replace, collections merge.

        The type is part of the id, so a type change is limited to case or spacing that
        keeps the id's type prefix; anything else raises ValidationError. Create a new
        entity to change its type.

        This is a read-modify-write, serialized per entity on the transactional backends
        (Neo4j, Memgraph). The auto-commit backends (HydraDB, Kuzu, FalkorDB) run one
        write at a time per graph object, so concurrent updates in one process all apply;
        writers in separate processes are not serialized there and can lose updates.

        A type that differs only in case or spacing keeps the stored type; with a schema, a
        type naming a schema type or alias stores the schema's type name.

        @param id (str): the entity id.
        @param fields (Any): name, type, aliases, external_ids, properties, remove_aliases, remove_properties.
        @return (Entity): the updated entity.
        """
        schema = self._c.schema
        if schema is not None and isinstance(fields.get("type"), str):
            fields["type"] = canonical_entity_type(_ops._clean_text(fields["type"]), schema)
        return await self._c._write(
            _ops.update_entity,
            id,
            schema_check=self._c._schema_check,
            schema_types=frozenset(t.name for t in schema.entities) if schema is not None else (),
            **fields,
        )

    async def delete(self, id: str) -> DeleteResult:
        """Delete an entity, its relations, and any decision trace that references it.

        @param id (str): the entity id.
        @return (DeleteResult): counts of entities, relation versions, and decisions removed.
        """
        return DeleteResult(**await self._c._write(_ops.delete_entity, id))
