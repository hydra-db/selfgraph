from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping
from contextlib import asynccontextmanager, suppress
from functools import partial
from typing import Any

from .._serde import LABELS
from ..errors import StoreError, TransientError
from ..models import CypherResult
from ._cypher import CypherPrimitives, bolt_driver, bolt_error, query_error, records_to_result, syntax_detail

__all__ = ["CypherStore", "Neo4jStore"]


_INIT_RETRIES = 5
_INIT_BASE_DELAY = 0.05
_SHOW_CONSTRAINTS = ("SHOW CONSTRAINTS", "SHOW CONSTRAINT INFO")
_KEY = ["id", "ns"]

_log = logging.getLogger("selfgraph")


_SYNTAX_MARKERS = ("syntaxerror", "parsing error")
_HYDRADB_HINT = "; if this is a HydraDB server use store 'hydradb'"
_CONFLICT_MARKERS = ("constraintvalidationfailed", "unique constraint violation")


def _cypher_transient(lowered: str) -> bool:
    """Report whether a lowercased Cypher error is a retryable race.

    A uniqueness violation surfaces only after a managed write has already passed its
    pre-existence check, so it is always a lost race the retry loop resolves: either the
    retry's check reports the real conflict, or the race has cleared. A syntax error is
    never retried, even when Memgraph's message lists CONSTRAINT and UNIQUE among the keywords it expected.

    @param lowered (str): the lowercased error code and message.
    @return (bool): True when the error is a lost race or a transient conflict.
    """
    if any(k in lowered for k in _SYNTAX_MARKERS):
        return False
    return (
        any(k in lowered for k in _CONFLICT_MARKERS)
        or ("constraint" in lowered and "already exists" in lowered)
        or any(k in lowered for k in ("transient", "serializ", "conflicting transactions", "cannot get"))
    )


_translate_cypher_error = partial(query_error, engine="Cypher", transient=_cypher_transient)


def _unique_labels(rows: list[dict]) -> set[str]:
    """The labels carrying an (id, ns) uniqueness constraint, from Neo4j or Memgraph constraint listing rows.

    @param rows (list[dict]): the constraint rows.
    @return (set[str]): the constrained labels.
    """
    out: set[str] = set()
    for row in rows:
        kind = str(row.get("type") or row.get("constraint type") or "").lower()
        if "unique" not in kind or sorted(row.get("properties") or []) != _KEY:
            continue
        labels = row.get("labelsOrTypes") or [row.get("label")]
        out.update(label for label in labels if isinstance(label, str))
    return out


class _CypherWriter(CypherPrimitives):
    def __init__(self, tx, uri: str, database: str | None) -> None:
        self._tx = tx
        self._uri = uri
        self._database = database

    async def _run(self, query: str, params: Mapping[str, Any] | None = None) -> CypherResult:
        try:
            result = await self._tx.run(query, dict(params or {}))
            return await records_to_result(result)
        except Exception as exc:  # noqa: BLE001
            raise _translate_cypher_error(exc, self._uri, self._database) from exc


class CypherStore(CypherPrimitives):
    def __init__(
        self,
        uri: str,
        *,
        auth: str | tuple[str, str] | None = None,
        database: str | None = None,
        **driver_kwargs: Any,
    ) -> None:
        """Open a Bolt driver with server notifications off.

        Memgraph ignores the server-side notifications_min_severity=OFF filter and sends a warning per
        CREATE CONSTRAINT, which the driver logs to stderr, so the driver's notification logger is also
        raised to ERROR.

        @param uri (str): the Bolt URI.
        @param auth (str | tuple[str, str] | None): the auth, as bolt_auth takes it.
        @param database (str | None): the database name, or None for the server default.
        @param driver_kwargs (Any): extra keyword arguments for the neo4j driver.
        """
        logging.getLogger("neo4j.notifications").setLevel(logging.ERROR)
        kwargs = dict(driver_kwargs)
        kwargs.setdefault("notifications_min_severity", "OFF")
        try:
            self._driver = bolt_driver(uri, auth, **kwargs)
        except StoreError:
            kwargs.pop("notifications_min_severity", None)
            self._driver = bolt_driver(uri, auth, **kwargs)
        self._uri = uri
        self._database = database

    def _session(self):
        if self._database:
            return self._driver.session(database=self._database)
        return self._driver.session()

    async def _run(self, query: str, params: Mapping[str, Any] | None = None) -> CypherResult:
        self._require_open()
        try:
            async with self._session() as session:
                result = await session.run(query, dict(params or {}))
                return await records_to_result(result)
        except Exception as exc:  # noqa: BLE001
            raise _translate_cypher_error(exc, self._uri, self._database) from exc

    async def _list_constraints(self) -> list[dict]:
        """List the existing constraints in the engine's own dialect, trying each SHOW form the engines accept.

        @return (list[dict]): the constraint rows, or [] when the engine cannot list them.
        """
        for query in _SHOW_CONSTRAINTS:
            try:
                return (await self._run(query)).rows
            except TransientError:
                raise
            except StoreError as exc:
                cause = exc.__cause__ or exc
                if bolt_error(cause, self._uri, self._database) is not None:
                    raise
                if syntax_detail(cause) is None:
                    return []
        return []

    async def _constraints_exist(self) -> bool:
        """Report whether the uniqueness constraints are already in place, so initialize can skip the DDL.

        Constraint DDL needs exclusive access on Memgraph, so a check that keeps conflicting with another
        client's work means the store is in use and is treated as set up.

        @return (bool): True when every label has its constraint or the check kept conflicting.
        """
        for attempt in range(_INIT_RETRIES):
            try:
                return set(LABELS) <= _unique_labels(await self._list_constraints())
            except TransientError:
                if attempt < _INIT_RETRIES - 1:
                    await asyncio.sleep(_INIT_BASE_DELAY * 2**attempt)
        _log.debug("skipping constraint setup: the store is busy with another client")
        return True

    async def initialize(self) -> None:
        """Create the id and namespace uniqueness constraints on the versioned node labels unless they exist."""
        self._require_open()
        if await self._constraints_exist():
            return
        for label in LABELS:
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
                    err = _translate_cypher_error(exc, self._uri, self._database)
                    if isinstance(err, TransientError) and attempt < _INIT_RETRIES - 1:
                        await asyncio.sleep(_INIT_BASE_DELAY * 2**attempt)
                        continue
                    if isinstance(err, TransientError) or bolt_error(exc, self._uri, self._database):
                        raise err from exc
                    lowered = f"{getattr(exc, 'code', '') or ''} {exc}".lower()
                    hint = _HYDRADB_HINT if "syntax" in lowered or "parse error" in lowered else ""
                    detail = getattr(exc, "message", None) or exc
                    raise StoreError(f"failed creating constraint on {label}: {detail}{hint}") from exc

    @asynccontextmanager
    async def transaction(self):
        self._require_open()
        async with self._session() as session:
            try:
                tx = await session.begin_transaction()
            except Exception as exc:  # noqa: BLE001
                raise _translate_cypher_error(exc, self._uri, self._database) from exc
            try:
                yield _CypherWriter(tx, self._uri, self._database)
            except BaseException:
                with suppress(Exception):
                    await tx.rollback()
                raise
            else:
                try:
                    await tx.commit()
                except Exception as exc:  # noqa: BLE001
                    raise _translate_cypher_error(exc, self._uri, self._database) from exc

    async def close(self) -> None:
        """Close the driver and its connection pool; later calls fail with StoreError."""
        self._closed = True
        await self._driver.close()


class Neo4jStore(CypherStore):
    pass
