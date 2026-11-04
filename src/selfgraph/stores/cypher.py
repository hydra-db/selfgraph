from __future__ import annotations

from collections.abc import Mapping
from contextlib import asynccontextmanager
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
from ..errors import StoreError
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


class _CypherWriter(CypherPrimitives):
    def __init__(self, tx) -> None:
        self._tx = tx

    async def _run(self, query: str, params: Mapping[str, Any] | None = None) -> CypherResult:
        try:
            result = await self._tx.run(query, dict(params or {}))
            return await records_to_result(result)
        except Exception as exc:  # noqa: BLE001
            raise StoreError(f"Cypher query failed: {exc}") from exc


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
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth, **driver_kwargs)
        self._database = database

    def _session(self):
        if self._database:
            return self._driver.session(database=self._database)
        return self._driver.session()

    async def _run(self, query: str, params: Mapping[str, Any] | None = None) -> CypherResult:
        async with self._session() as session:
            try:
                result = await session.run(query, dict(params or {}))
                return await records_to_result(result)
            except Exception as exc:  # noqa: BLE001
                raise StoreError(f"Cypher query failed: {exc}") from exc

    async def initialize(self) -> None:
        """Ready the store; the generic backend needs no setup since ids are deterministic and upserts idempotent."""
        return None

    @asynccontextmanager
    async def transaction(self):
        async with self._session() as session:
            tx = await session.begin_transaction()
            try:
                yield _CypherWriter(tx)
            except BaseException:
                await tx.rollback()
                raise
            else:
                await tx.commit()

    async def close(self) -> None:
        """Close the driver and its connection pool."""
        await self._driver.close()


class Neo4jStore(CypherStore):
    async def initialize(self) -> None:
        """Create the Neo4j id and namespace uniqueness constraints."""
        for label in _CONSTRAINT_LABELS:
            query = (
                f"CREATE CONSTRAINT selfgraph_{label.lower()}_id IF NOT EXISTS "
                f"FOR (n:{label}) REQUIRE (n.id, n.ns) IS UNIQUE"
            )
            async with self._session() as session:
                try:
                    await session.run(query)
                except Exception as exc:  # noqa: BLE001
                    raise StoreError(f"failed creating constraint on {label}: {exc}") from exc
