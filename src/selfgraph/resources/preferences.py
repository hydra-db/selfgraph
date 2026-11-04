from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
from datetime import datetime
from typing import TYPE_CHECKING

from .. import _ops
from ..models import DeleteResult, JsonValue, Kind, Page, Preference
from ._common import decode_cursor, make_page, paginate

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
            properties=dict(properties) if properties else None,
            event_time=event_time,
        )

    async def get(self, id: str) -> Preference | None:
        return await _ops.get_preference(self._c.store, self._c.namespace, id)

    async def list(
        self,
        subject_entity: str,
        *,
        key: str | None = None,
        kind: Kind | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Page[Preference]:
        offset = decode_cursor(cursor)
        rows = await _ops.list_preferences(
            self._c.store,
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
        subject_entity: str,
        *,
        key: str | None = None,
        kind: Kind | None = None,
        limit: int = 50,
    ) -> AsyncIterator[Preference]:
        """Yield every preference of a subject across pages, following the list cursor.

        @param subject_entity (str): the subject entity id.
        @param key (str | None): filter by dimension key.
        @param kind (Kind | None): filter by preference or disinterest.
        @param limit (int): page size per fetch.
        @return (AsyncIterator[Preference]): every matching preference.
        """
        return paginate(self.list, subject_entity=subject_entity, key=key, kind=kind, limit=limit)

    async def update(
        self,
        id: str,
        *,
        strength: float | None = None,
        properties: Mapping[str, JsonValue] | None = None,
        event_time: datetime | None = None,
    ) -> Preference:
        return await self._c._write(
            _ops.update_preference,
            id,
            strength=strength,
            properties=dict(properties) if properties else None,
            event_time=event_time,
        )

    async def delete(self, id: str) -> DeleteResult:
        counts = await self._c._write(_ops.delete_preference, id)
        return DeleteResult(**counts)
