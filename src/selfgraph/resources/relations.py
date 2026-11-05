from __future__ import annotations

from collections.abc import AsyncIterator, Iterable, Mapping
from datetime import datetime
from typing import TYPE_CHECKING

from .. import _ops
from ..errors import ValidationError
from ..models import DeleteResult, EvidenceInput, JsonValue, Page, Relation
from ._common import make_page, page_offset, paginate

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
            properties=properties,
            event_time=event_time,
            evidence=_ops.evidence_from_inputs(evidence),
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
        limit: int = 50,
    ) -> Page[Relation]:
        offset = page_offset(cursor, limit)
        rows = await _ops.list_relations(
            await self._c._reader(),
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
        **extra: object,
    ) -> Relation:
        """Create a new version of a relation with changed properties.

        Versioning is a read-modify-write, serialized per relation on the transactional
        backends (Neo4j, Memgraph): concurrent updates each keep their own version, and
        under heavy contention a losing writer raises TransientError to retry rather than
        losing data silently. The auto-commit backends (HydraDB, Kuzu, FalkorDB) cannot
        serialize, so concurrent updates to one relation collapse to a single
        last-writer-wins version and the other updates' data is lost; serialize writes
        yourself there.

        @param id (str): the relation id.
        @param set_properties (Mapping[str, JsonValue] | None): properties to set.
        @param remove_properties (Iterable[str]): property keys to drop.
        @param event_time (datetime | None): the new valid time.
        @param evidence (Iterable[EvidenceInput] | None): evidence to attach.
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
        )

    async def versions(self, id: str, *, newest_first: bool = True) -> list[Relation]:
        reader = await self._c._reader()
        return await _ops.list_relation_versions(reader, self._c.namespace, id, newest_first=newest_first)

    async def delete(self, id: str) -> DeleteResult:
        """Delete a relation, all its versions, and any decision trace that uses it as a step.

        @param id (str): the relation id.
        @return (DeleteResult): counts of relation versions and decisions removed.
        """
        counts = await self._c._write(_ops.delete_relation, id)
        return DeleteResult(**counts)
