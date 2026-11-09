from __future__ import annotations

from collections.abc import AsyncIterator, Iterable, Mapping
from datetime import datetime

from .. import _ops
from ..errors import NotFoundError
from ..models import DeleteResult, Evidence, EvidenceInput, JsonValue, Page, Relation, check_options
from ..schema import ContradictionMode, canonical_relation_type
from ._common import DEFAULT_PAGE_LIMIT, Resource, paginate

__all__ = ["Relations"]


class Relations(Resource):
    async def create(
        self,
        from_entity: str,
        type: str,
        to_entity: str,
        *,
        id: str | None = None,
        properties: Mapping[str, JsonValue] | None = None,
        event_time: datetime | str | None = None,
        evidence: Iterable[EvidenceInput] = (),
        contradiction: ContradictionMode | None = None,
    ) -> Relation:
        """Create a relation, or reassert one a contradiction invalidated, as a new current version.

        A reassertion carries exactly the given properties and logs a "relation_reasserted" warning naming the
        retired revision.

        @param from_entity (str): the source entity id.
        @param type (str): the relation type, normalized to UPPER_SNAKE; a schema alias becomes the schema's type.
        @param to_entity (str): the destination entity id.
        @param id (str | None): an explicit id, else derived from the endpoints and type.
        @param properties (Mapping[str, JsonValue] | None): relation properties.
        @param event_time (datetime | str | None): when the fact became true.
        @param evidence (Iterable[EvidenceInput]): evidence records supporting the relation.
        @param contradiction (ContradictionMode | None): how to handle a schema max_count conflict, or None for the
            graph's mode; warnings go to the selfgraph logger.
        @return (Relation): the created relation; raises ConflictError when the id already exists.
        """
        return await self._c._create_relation(
            contradiction,
            from_entity=from_entity,
            type=canonical_relation_type(type, self._c.schema) if isinstance(type, str) and type.strip() else type,
            to_entity=to_entity,
            id=id,
            properties=properties,
            event_time=event_time,
            evidence=_ops.evidence_from_inputs(evidence),
        )

    async def get(self, id: str) -> Relation | None:
        """Fetch the current version of a relation.

        @param id (str): the relation id.
        @return (Relation | None): the current version, or None when the id is unknown or a contradiction retired
            it; versions and list(include_invalidated=True) still return a retired relation.
        """
        _ops._validate_own_id("relation", id)
        return await _ops.get_relation_current(await self._c._reader(), self._c.namespace, id)

    async def list(
        self,
        *,
        from_entity: str | None = None,
        type: str | None = None,
        to_entity: str | None = None,
        cursor: str | None = None,
        limit: int = DEFAULT_PAGE_LIMIT,
        include_invalidated: bool = False,
    ) -> Page[Relation]:
        return await self._page(
            _ops.list_relations,
            from_entity=from_entity,
            type=type,
            to_entity=to_entity,
            cursor=cursor,
            limit=limit,
            by_id="relation",
            include_invalidated=include_invalidated,
        )

    def iterate(
        self,
        *,
        from_entity: str | None = None,
        type: str | None = None,
        to_entity: str | None = None,
        limit: int = DEFAULT_PAGE_LIMIT,
        include_invalidated: bool = False,
    ) -> AsyncIterator[Relation]:
        """Yield every relation across pages, following the list cursor.

        @param from_entity (str | None): filter by source entity.
        @param type (str | None): filter by relation type.
        @param to_entity (str | None): filter by target entity.
        @param limit (int): the page size per fetch, not a cap; iteration yields every match.
        @param include_invalidated (bool): also yield relations a contradiction invalidated.
        @return (AsyncIterator[Relation]): every matching relation.
        """
        return paginate(
            self.list,
            from_entity=from_entity,
            type=type,
            to_entity=to_entity,
            limit=limit,
            include_invalidated=include_invalidated,
        )

    async def update(
        self,
        id: str,
        *,
        set_properties: Mapping[str, JsonValue] | None = None,
        remove_properties: Iterable[str] = (),
        event_time: datetime | str | None = None,
        evidence: Iterable[EvidenceInput] | None = None,
        **extra: object,
    ) -> Relation:
        """Create a new version of a relation with changed properties.

        Versioning is a read-modify-write, serialized per relation on the transactional
        backends (Neo4j, Memgraph): concurrent updates each keep their own version, and
        under heavy contention a losing writer raises TransientError to retry rather than
        losing data silently. The auto-commit backends (HydraDB, Kuzu, FalkorDB) run one
        write at a time per graph object, so concurrent updates in one process all apply;
        writers in separate processes are not serialized there and can lose updates.

        @param id (str): the relation id.
        @param set_properties (Mapping[str, JsonValue] | None): properties to set.
        @param remove_properties (Iterable[str]): property keys to drop.
        @param event_time (datetime | str | None): the new valid time.
        @param evidence (Iterable[EvidenceInput] | None): evidence records to add; existing evidence is kept.
        @return (Relation): the new current version.
        """
        check_options("relations.update", extra, ("set_properties", "remove_properties", "event_time", "evidence"))
        _ops._validate_own_id("relation", id)
        return await self._c._write(
            _ops.update_relation,
            id,
            set_properties=set_properties,
            remove_properties=remove_properties,
            event_time=event_time,
            evidence=None if evidence is None else _ops.evidence_from_inputs(evidence),
            schema_check=self._c._schema_check,
        )

    async def evidence(self, id: str, *, cursor: str | None = None, limit: int = DEFAULT_PAGE_LIMIT) -> Page[Evidence]:
        """List the evidence records supporting a relation across all its versions.

        @param id (str): the relation id.
        @param cursor (str | None): the cursor from a previous page, or None to start.
        @param limit (int): page size.
        @return (Page[Evidence]): evidence ordered by evidence id; raises NotFoundError for an unknown relation.
        """
        _ops._validate_own_id("relation", id)
        return await self._page(_ops.list_evidence, id, kind="relation", cursor=cursor, limit=limit)

    async def versions(self, id: str, *, newest_first: bool = True) -> list[Relation]:
        """List every version of a relation, retired ones included.

        @param id (str): the relation id.
        @param newest_first (bool): order newest first when True.
        @return (list[Relation]): the versions; raises NotFoundError when the id has none.
        """
        _ops._validate_own_id("relation", id)
        reader = await self._c._reader()
        versions = await _ops.list_relation_versions(reader, self._c.namespace, id, newest_first=newest_first)
        if not versions:
            raise NotFoundError("Relation", id)
        return versions

    async def delete(self, id: str) -> DeleteResult:
        """Delete a relation, all its versions, and any decision trace that uses it as a step.

        @param id (str): the relation id.
        @return (DeleteResult): counts of relation versions and decisions removed.
        """
        _ops._validate_own_id("relation", id)
        return DeleteResult(**await self._c._write(_ops.delete_relation, id))
