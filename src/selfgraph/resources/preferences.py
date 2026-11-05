from __future__ import annotations

from collections.abc import AsyncIterator, Iterable, Mapping
from datetime import datetime
from typing import TYPE_CHECKING

from .. import _ops
from ..errors import ValidationError
from ..models import DeleteResult, JsonValue, Kind, Page, Preference
from ._common import make_page, page_offset, paginate

if TYPE_CHECKING:
    from ..client import SelfGraph

__all__ = ["Preferences"]


class Preferences:
    def __init__(self, client: SelfGraph) -> None:
        self._c = client

    async def create(
        self,
        subject_entity: str,
        key: str,
        value_entity: str,
        *,
        id: str | None = None,
        kind: Kind = "preference",
        about_entity: str | None = None,
        strength: float | None = None,
        properties: Mapping[str, JsonValue] | None = None,
        event_time: datetime | None = None,
    ) -> Preference:
        return await self._c._write(
            _ops.create_preference,
            subject_entity=subject_entity,
            key=key,
            value_entity=value_entity,
            id=id,
            kind=kind,
            about_entity=about_entity,
            strength=strength,
            properties=properties,
            event_time=event_time,
        )

    async def get(self, id: str) -> Preference | None:
        return await _ops.get_preference(await self._c._reader(), self._c.namespace, id)

    async def list(
        self,
        subject_entity: str | None = None,
        *,
        key: str | None = None,
        kind: Kind | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Page[Preference]:
        offset = page_offset(cursor, limit)
        rows = await _ops.list_preferences(
            await self._c._reader(),
            self._c.namespace,
            subject_entity=subject_entity,
            key=key,
            kind=kind,
            skip=offset,
            limit=limit + 1,
        )
        return make_page(rows, offset, limit)

    def iterate(
        self,
        subject_entity: str | None = None,
        *,
        key: str | None = None,
        kind: Kind | None = None,
        limit: int = 50,
    ) -> AsyncIterator[Preference]:
        """Yield preferences across pages, following the list cursor.

        @param subject_entity (str | None): the subject entity id, or None for every subject.
        @param key (str | None): filter by dimension key.
        @param kind (Kind | None): filter by preference or disinterest.
        @param limit (int): page size per fetch.
        @return (AsyncIterator[Preference]): every matching preference.
        """
        return paginate(self.list, subject_entity=subject_entity, key=key, kind=kind, limit=limit)

    async def versions(self, id: str, *, newest_first: bool = True) -> list[Preference]:
        reader = await self._c._reader()
        return await _ops.list_preference_versions(reader, self._c.namespace, id, newest_first=newest_first)

    async def update(
        self,
        id: str,
        *,
        strength: float | None = None,
        properties: Mapping[str, JsonValue] | None = None,
        remove_properties: Iterable[str] = (),
        event_time: datetime | None = None,
        **extra: object,
    ) -> Preference:
        """Create a new version of a preference with changed strength or properties.

        This is a read-modify-write, serialized per preference on the transactional
        backends (Neo4j, Memgraph). The auto-commit backends (HydraDB, Kuzu, FalkorDB)
        cannot serialize, so concurrent updates to one preference collapse to a single
        last-writer-wins version and the other updates' data is lost; serialize writes
        yourself there.

        @param id (str): the preference id.
        @param strength (float | None): the new strength.
        @param properties (Mapping[str, JsonValue] | None): properties to merge.
        @param remove_properties (Iterable[str]): property keys to drop.
        @param event_time (datetime | None): the new valid time.
        @return (Preference): the new current version.
        """
        if extra:
            raise ValidationError(f"unknown preference update field(s): {sorted(extra)}")
        return await self._c._write(
            _ops.update_preference,
            id,
            strength=strength,
            properties=properties,
            remove_properties=remove_properties,
            event_time=event_time,
        )

    async def delete(self, id: str) -> DeleteResult:
        counts = await self._c._write(_ops.delete_preference, id)
        return DeleteResult(**counts)
