from __future__ import annotations

from collections.abc import AsyncIterator, Iterable, Mapping
from datetime import datetime

from .. import _ops
from ..errors import ValidationError
from ..models import DeleteResult, Evidence, EvidenceInput, JsonValue, Page, Relation
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
        event_time: datetime | None = None,
        evidence: Iterable[EvidenceInput] = (),
    ) -> Relation:
        return await self._c._write(
            _ops.create_relation,
            from_entity=from_entity,
            type=type,
            to_entity=to_entity,
            id=id,
            properties=properties,
            event_time=event_time,
            evidence=_ops.evidence_from_inputs(evidence),
            schema_check=self._c._schema_check,
        )

    async def get(self, id: str) -> Relation | None:
        return await _ops.get_relation_current(await self._c._reader(), self._c.namespace, id)

    async def list(
        self,
        *,
        from_entity: str | None = None,
        type: str | None = None,
        to_entity: str | None = None,
        cursor: str | None = None,
        limit: int = DEFAULT_PAGE_LIMIT,
    ) -> Page[Relation]:
        return await self._page(
            _ops.list_relations, from_entity=from_entity, type=type, to_entity=to_entity, cursor=cursor, limit=limit
        )

    def iterate(
        self,
        *,
        from_entity: str | None = None,
        type: str | None = None,
        to_entity: str | None = None,
        limit: int = DEFAULT_PAGE_LIMIT,
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
        @param event_time (datetime | None): the new valid time.
        @param evidence (Iterable[EvidenceInput] | None): evidence records to add; existing evidence is kept.
        @return (Relation): the new current version.
        """
        if extra:
            raise ValidationError(f"unknown relation update field(s): {sorted(extra)}")
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
        return await self._page(_ops.list_evidence, id, kind="relation", cursor=cursor, limit=limit)

    async def versions(self, id: str, *, newest_first: bool = True) -> list[Relation]:
        reader = await self._c._reader()
        return await _ops.list_relation_versions(reader, self._c.namespace, id, newest_first=newest_first)

    async def delete(self, id: str) -> DeleteResult:
        """Delete a relation, all its versions, and any decision trace that uses it as a step.

        @param id (str): the relation id.
        @return (DeleteResult): counts of relation versions and decisions removed.
        """
        return DeleteResult(**await self._c._write(_ops.delete_relation, id))
