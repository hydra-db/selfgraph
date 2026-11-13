from __future__ import annotations

from collections.abc import AsyncIterator, Iterable, Mapping
from datetime import datetime

from .. import _ops
from ..errors import NotFoundError
from ..models import DeleteResult, JsonValue, Page, Preference, Stance, check_options
from ._common import DEFAULT_PAGE_LIMIT, Resource, paginate

__all__ = ["Preferences"]


class Preferences(Resource):
    async def create(
        self,
        subject_entity: str,
        key: str,
        value_entity: str,
        *,
        id: str | None = None,
        stance: Stance = "preference",
        about_entity: str | None = None,
        strength: float | None = None,
        properties: Mapping[str, JsonValue] | None = None,
        event_time: datetime | str | None = None,
    ) -> Preference:
        return await self._c._write(
            _ops.create_preference,
            subject_entity=subject_entity,
            key=key,
            value_entity=value_entity,
            id=id,
            stance=stance,
            about_entity=about_entity,
            strength=strength,
            properties=properties,
            event_time=event_time,
        )

    async def get(self, id: str) -> Preference | None:
        _ops._validate_own_id("preference", id)
        return await _ops.get_preference(await self._c._reader(), self._c.namespace, id)

    async def list(
        self,
        subject_entity: str | None = None,
        *,
        key: str | None = None,
        stance: Stance | None = None,
        cursor: str | None = None,
        limit: int = DEFAULT_PAGE_LIMIT,
    ) -> Page[Preference]:
        return await self._page(
            _ops.list_preferences,
            subject_entity=subject_entity,
            key=key,
            stance=stance,
            cursor=cursor,
            limit=limit,
            by_id="preference",
        )

    def iterate(
        self,
        subject_entity: str | None = None,
        *,
        key: str | None = None,
        stance: Stance | None = None,
        limit: int = DEFAULT_PAGE_LIMIT,
    ) -> AsyncIterator[Preference]:
        """Yield preferences across pages, following the list cursor.

        @param subject_entity (str | None): the subject entity id, or None for every subject.
        @param key (str | None): filter by dimension key.
        @param stance (Stance | None): filter by preference or disinterest.
        @param limit (int): the page size per fetch, not a cap; iteration yields every match.
        @return (AsyncIterator[Preference]): every matching preference.
        """
        return paginate(self.list, subject_entity=subject_entity, key=key, stance=stance, limit=limit)

    async def versions(self, id: str, *, newest_first: bool = True) -> list[Preference]:
        """List every version of a preference, retired ones included.

        @param id (str): the preference id.
        @param newest_first (bool): order newest first when True.
        @return (list[Preference]): the versions; raises NotFoundError when the id has none.
        """
        _ops._validate_own_id("preference", id)
        reader = await self._c._reader()
        versions = await _ops.list_preference_versions(reader, self._c.namespace, id, newest_first=newest_first)
        if not versions:
            raise NotFoundError("Preference", id)
        return versions

    async def update(
        self,
        id: str,
        *,
        strength: float | None = None,
        properties: Mapping[str, JsonValue] | None = None,
        remove_properties: Iterable[str] = (),
        event_time: datetime | str | None = None,
        clear: Iterable[str] = (),
        **extra: object,
    ) -> Preference:
        """Create a new version of a preference with changed strength or properties.

        None keeps a field; name it in clear to remove its value instead.

        This is a read-modify-write, serialized per preference on the transactional
        backends (Neo4j, Memgraph). The auto-commit backends (HydraDB, Kuzu, FalkorDB) run one
        write at a time per graph object, so concurrent updates in one process all apply;
        writers in separate processes are not serialized there and can lose updates.

        @param id (str): the preference id.
        @param strength (float | None): the new strength.
        @param properties (Mapping[str, JsonValue] | None): properties to merge.
        @param remove_properties (Iterable[str]): property keys to drop.
        @param event_time (datetime | str | None): the new valid time.
        @param clear (Iterable[str]): fields to clear: strength, about_entity, or event_time.
        @return (Preference): the new current version.
        """
        check_options(
            "preferences.update", extra, ("strength", "properties", "remove_properties", "event_time", "clear")
        )
        _ops._validate_own_id("preference", id)
        return await self._c._write(
            _ops.update_preference,
            id,
            strength=strength,
            properties=properties,
            remove_properties=remove_properties,
            event_time=event_time,
            clear=clear,
        )

    async def delete(self, id: str) -> DeleteResult:
        _ops._validate_own_id("preference", id)
        return DeleteResult(**await self._c._write(_ops.delete_preference, id))
