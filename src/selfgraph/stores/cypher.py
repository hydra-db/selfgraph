from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping
from contextlib import asynccontextmanager, suppress
from typing import Any

from .._serde import (
    L_CHUNK,
    L_ENTITY,
    L_PROFILE,
    L_SOURCE,
    L_SOURCE_VERSION,
    L_STEP,
    L_TRACE,
)
from ..errors import SelfGraphError, StoreError, TransientError
from ..models import CypherResult
from ._cypher import CypherPrimitives, records_to_result

__all__ = ["CypherStore", "Neo4jStore"]

_CONSTRAINT_LABELS = [
    L_ENTITY,
    L_PROFILE,
    L_TRACE,
    L_STEP,
    L_SOURCE,
    L_SOURCE_VERSION,
    L_CHUNK,
]

_INIT_RETRIES = 5
_INIT_BASE_DELAY = 0.05

# Memgraph ignores the server-side notifications_min_severity=OFF filter and emits a
# warning per CREATE CONSTRAINT, which the driver logs to stderr. Honor OFF client-side.
logging.getLogger("neo4j.notifications").setLevel(logging.ERROR)


def _translate_cypher_error(exc: BaseException) -> SelfGraphError:
    """Map a Bolt driver error to a library error, TransientError for retryable races.

    A uniqueness violation surfaces only after a managed write has already passed its
    pre-existence check, so it is always a lost race the retry loop resolves: either the
    retry's check reports the real conflict, or the race has cleared.

    @param exc (BaseException): the driver exception.
    @return (SelfGraphError): the library error to raise.
    """
    lowered = f"{getattr(exc, 'code', '') or ''} {exc}".lower()
    is_conflict = "constraintvalidationfailed" in lowered or (
        "constraint" in lowered and ("unique" in lowered or "already exists" in lowered)
    )
    transient = any(k in lowered for k in ("transient", "serializ", "conflicting transactions", "cannot get"))
    if is_conflict or transient:
        return TransientError(f"Cypher transaction conflict: {exc}")
    return StoreError(f"Cypher query failed: {exc}")


class _CypherWriter(CypherPrimitives):
    def __init__(self, tx) -> None:
        self._tx = tx

    async def _run(self, query: str, params: Mapping[str, Any] | None = None) -> CypherResult:
        try:
            result = await self._tx.run(query, dict(params or {}))
            return await records_to_result(result)
        except Exception as exc:  # noqa: BLE001
            raise _translate_cypher_error(exc) from exc


class CypherStore(CypherPrimitives):
    def __init__(
        self,
        uri: str,
        *,
        auth: tuple[str, str] | None = None,
        database: str | None = None,
        **driver_kwargs: Any,
    ) -> None:
        try:
            from neo4j import AsyncGraphDatabase
        except ImportError as exc:  # pragma: no cover
            raise StoreError("the 'neo4j' Bolt driver is required for CypherStore") from exc
        kwargs = dict(driver_kwargs)
        kwargs.setdefault("notifications_min_severity", "OFF")
        try:
            self._driver = AsyncGraphDatabase.driver(uri, auth=auth, **kwargs)
        except Exception:  # noqa: BLE001 - older drivers reject the notification config kwarg
            kwargs.pop("notifications_min_severity", None)
            self._driver = AsyncGraphDatabase.driver(uri, auth=auth, **kwargs)
        self._database = database

    def _session(self):
        if self._database:
            return self._driver.session(database=self._database)
        return self._driver.session()

    async def _run(self, query: str, params: Mapping[str, Any] | None = None) -> CypherResult:
        try:
            async with self._session() as session:
                result = await session.run(query, dict(params or {}))
                return await records_to_result(result)
        except Exception as exc:  # noqa: BLE001
            raise _translate_cypher_error(exc) from exc

    async def initialize(self) -> None:
        """Create the id and namespace uniqueness constraints on the versioned node labels."""
        for label in _CONSTRAINT_LABELS:
            query = (
                f"CREATE CONSTRAINT selfgraph_{label.lower()}_id IF NOT EXISTS "
                f"FOR (n:{label}) REQUIRE (n.id, n.ns) IS UNIQUE"
            )
            for attempt in range(_INIT_RETRIES):
                try:
                    async with self._session() as session:
                        await session.run(query)
                    break
                except Exception as exc:  # noqa: BLE001
                    err = _translate_cypher_error(exc)
                    if isinstance(err, TransientError) and attempt < _INIT_RETRIES - 1:
                        await asyncio.sleep(_INIT_BASE_DELAY * 2**attempt)
                        continue
                    if isinstance(err, TransientError):
                        raise err from exc
                    raise StoreError(f"failed creating constraint on {label}: {exc}") from exc

    @asynccontextmanager
    async def transaction(self):
        async with self._session() as session:
            try:
                tx = await session.begin_transaction()
            except Exception as exc:  # noqa: BLE001
                raise _translate_cypher_error(exc) from exc
            try:
                yield _CypherWriter(tx)
            except BaseException:
                with suppress(Exception):
                    await tx.rollback()
                raise
            else:
                try:
                    await tx.commit()
                except Exception as exc:  # noqa: BLE001
                    raise _translate_cypher_error(exc) from exc

    async def close(self) -> None:
        """Close the driver and its connection pool."""
        await self._driver.close()


class Neo4jStore(CypherStore):
    pass
